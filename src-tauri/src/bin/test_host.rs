//! Test-only transport for exercising the production Rust service from browser tests.
//! Never shipped or launched by the desktop app. Like Tauri's command handlers,
//! each request runs on its own thread against one shared backend, with the
//! same background monitor, so slow work never queues the others here.
use serde_json::{json, Value};
use std::{
    io::{BufRead, Write},
    sync::{atomic::AtomicBool, Arc},
    time::Duration,
};
fn emit(line: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}
fn main() {
    let default = std::env::args()
        .nth(1)
        .expect("isolated test runtime directory");
    let default = std::path::PathBuf::from(default);
    let runtime = weave::storage_location::resolve(&default, None).expect("test storage location");
    let stop = Arc::new(AtomicBool::new(false));
    let backend = Arc::new(
        weave::backend::Backend::with_default(runtime, default, stop.clone())
            .expect("native test backend"),
    );
    let monitor = weave::backend::Monitor::start(
        backend.clone(),
        Duration::from_millis(100),
        |scope, status| emit(json!({"event":"workspace-changed","scope":scope,"status":status})),
    );
    let mut requests = vec![];
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else {
            break;
        };
        if line.len() > 8 * 1024 * 1024 {
            break;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let op = v["op"].as_str().unwrap_or("").to_string();
        let (id, args) = (v["id"].clone(), v["args"].clone());
        let respond = move |result: Result<Value, String>| {
            emit(match result {
                Ok(value) => json!({"id":id,"ok":true,"result":value}),
                Err(e) => json!({"id":id,"ok":false,"error":{"message":e}}),
            })
        };
        if op == "shutdown" {
            for request in requests.drain(..) {
                let _ = std::thread::JoinHandle::join(request);
            }
            stop.store(true, std::sync::atomic::Ordering::Relaxed);
            monitor.stop();
            respond(backend.request("shutdown", json!({})));
            return;
        }
        let backend = backend.clone();
        requests.retain(|r: &std::thread::JoinHandle<()>| !r.is_finished());
        requests.push(std::thread::spawn(move || {
            // Graph neighbourhoods stream over a Tauri Channel in the app; here
            // the chunks are collected into one response.
            if op == "graphNeighborhood" {
                let mut chunks = vec![];
                let summary = backend.graph_stream(&args, |chunk| {
                    chunks.push(chunk);
                    Ok(())
                });
                return respond(summary.map(|summary| json!({"summary":summary,"chunks":chunks})));
            }
            respond(backend.request(&op, args))
        }));
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    monitor.stop();
}
