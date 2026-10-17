use ::weave::backend::{Backend, Monitor};
use serde_json::{json, Value};
use std::{
    io::Write,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter};
pub fn prepare_portable_directory(
    executable: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let default = crate::platform::application_data()?.join(".weave");
    let legacy = executable.parent().map(|p| p.join(".weave"));
    let root = ::weave::storage_location::resolve(&default, legacy.as_deref())?;
    let check = || -> std::io::Result<()> {
        std::fs::create_dir_all(&root)?;
        let mut probe = tempfile::NamedTempFile::new_in(&root)?;
        probe.write_all(b"Weave data")?;
        probe.as_file().sync_all()?;
        Ok(())
    };
    check().map_err(|e| {
        format!(
            "Cannot write Weave data at {}: {e}. Choose a writable folder in Settings.",
            root.display()
        )
    })?;
    Ok(root)
}

/// The native service. Requests share one backend without a global lock:
/// each runs on its own blocking thread, while the monitor reconciles open
/// workspaces in the background and reports their changes.
#[derive(Default)]
pub struct Service {
    backend: Mutex<Option<Arc<Backend>>>,
    pub editing: Mutex<bool>,
    stopping: Arc<AtomicBool>,
    monitor: Mutex<Option<Monitor>>,
    /// The last file written by Export workspace, for Show in Explorer.
    pub last_export: Mutex<Option<std::path::PathBuf>>,
}
fn changed(app: &AppHandle, scope: u64, status: Value) {
    let _ = app.emit(
        "weave-changed",
        json!({"event":"workspace-changed","scope":scope,"status":status}),
    );
}
impl Service {
    pub fn backend(&self, app: &AppHandle) -> Result<Arc<Backend>, String> {
        let mut state = self.backend.lock().map_err(|e| e.to_string())?;
        if let Some(backend) = state.as_ref() {
            return Ok(backend.clone());
        }
        let runtime =
            prepare_portable_directory(&std::env::current_exe().map_err(|e| e.to_string())?)?;
        let default = crate::platform::application_data()?.join(".weave");
        let backend = Arc::new(Backend::with_default(
            runtime,
            default,
            self.stopping.clone(),
        )?);
        let app = app.clone();
        *self.monitor.lock().map_err(|e| e.to_string())? = Some(Monitor::start(
            backend.clone(),
            Duration::from_millis(250),
            move |scope, status| changed(&app, scope, status),
        ));
        *state = Some(backend.clone());
        Ok(backend)
    }
    pub fn request(&self, app: &AppHandle, op: &str, args: Value) -> Result<Value, String> {
        let backend = self.backend(app)?;
        let before = backend.revisions();
        let mut value = backend.request(op, args)?;
        if op == "health" {
            value["serverControl"] = json!(true);
        }
        for (scope, revision) in backend.revisions() {
            if !before.contains(&(scope, revision)) {
                changed(app, scope, backend.status_of(scope).unwrap_or(Value::Null));
            }
        }
        Ok(value)
    }
    pub fn graph_neighborhood(
        &self,
        args: Value,
        channel: tauri::ipc::Channel<Value>,
    ) -> Result<Value, String> {
        let backend = self
            .backend
            .lock()
            .map_err(|e| e.to_string())?
            .clone()
            .ok_or("The graph is not ready.")?;
        backend.graph_stream(&args, |chunk| {
            channel.send(chunk).map_err(|e| e.to_string())
        })
    }
    pub fn stop(&self, _app: &AppHandle) {
        self.shutdown();
    }
    fn shutdown(&self) {
        // Snapshots on close need Git, which stops once `stopping` is set.
        if !self.stopping.load(Ordering::Relaxed) {
            if let Some(backend) = self.backend.lock().ok().and_then(|b| b.clone()) {
                backend.snapshot_on_exit();
            }
        }
        self.stopping.store(true, Ordering::Relaxed);
        if let Ok(mut monitor) = self.monitor.lock() {
            if let Some(monitor) = monitor.take() {
                monitor.stop();
            }
        }
        if let Ok(mut state) = self.backend.lock() {
            if let Some(backend) = state.take() {
                let _ = backend.request("shutdown", json!({}));
            }
        }
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.shutdown();
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn application_data_uses_local_profile_instead_of_executable_folder() {
        let temporary = tempfile::tempdir().unwrap();
        let portable = temporary.path().join("package/.weave");
        std::fs::create_dir_all(&portable).unwrap();
        std::fs::write(portable.join("session.json"), b"{}").unwrap();
        let default = temporary.path().join("LocalAppData/Weave/.weave");
        let resolved = ::weave::storage_location::resolve(&default, Some(&portable)).unwrap();
        assert_eq!(resolved, default);
        assert!(resolved.join("session.json").exists());
        assert!(portable.join("session.json").exists());
    }
}
