// Individual Markdown files opened outside the workspace (Ctrl+O or dropped on
// the window). They are never indexed. Only files the user picked or dropped
// are granted, and only granted files can be read or written.
use serde_json::{json, Value};
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
pub struct ExternalFiles(Mutex<HashSet<PathBuf>>);

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
        .unwrap_or(false)
}

// Canonical Windows paths carry a verbatim prefix; show ordinary drive paths.
fn display(path: &Path) -> String {
    let text = path.to_string_lossy().into_owned();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => rest.to_string(),
        _ => text,
    }
}

fn content_hash(bytes: &[u8]) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    format!("{:016x}-{}", hasher.finish(), bytes.len())
}

fn grant(app: &AppHandle, path: &Path) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    if !canonical.is_file() || !is_markdown(&canonical) {
        return Err("Only Markdown (.md) files can be opened.".into());
    }
    app.state::<ExternalFiles>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(canonical.clone());
    Ok(canonical)
}

fn granted(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    if app
        .state::<ExternalFiles>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .contains(&canonical)
    {
        Ok(canonical)
    } else {
        Err("Open this file with Ctrl+O or by dropping it on Weave first.".into())
    }
}

fn read(path: &Path) -> Result<Value, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let hash = content_hash(&bytes);
    let text =
        String::from_utf8(bytes).map_err(|_| "Weave opens UTF-8 Markdown files.".to_string())?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(json!({"path": display(path), "name": name, "text": text, "hash": hash}))
}

#[tauri::command]
pub async fn choose_markdown_file(
    app: AppHandle,
    directory: Option<String>,
) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let window = app
            .get_webview_window("main")
            .ok_or("Weave window unavailable")?;
        let mut dialog = app.dialog().file().set_parent(&window);
        // Start in the workspace in use when the UI names one.
        if let Some(folder) = directory
            .map(std::path::PathBuf::from)
            .filter(|p| p.is_dir())
        {
            dialog = dialog.set_directory(folder);
        }
        let selected = dialog
            .set_title("Open Markdown file")
            .add_filter("Markdown", &["md", "markdown"])
            .blocking_pick_file();
        selected
            .map(|file| {
                let path = file.into_path().map_err(|e| e.to_string())?;
                read(&grant(&app, &path)?)
            })
            .transpose()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn read_external(app: AppHandle, path: String) -> Result<Value, String> {
    read(&granted(&app, &path)?)
}

#[tauri::command]
pub fn save_external(
    app: AppHandle,
    path: String,
    text: String,
    hash: String,
) -> Result<Value, String> {
    let path = granted(&app, &path)?;
    let current = std::fs::read(&path).map_err(|e| e.to_string())?;
    if content_hash(&current) != hash {
        return Err(
            "This file changed on disk. Reload it before saving; your draft is still open.".into(),
        );
    }
    let parent = path.parent().ok_or("The file has no folder")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temporary
        .write_all(text.as_bytes())
        .map_err(|e| e.to_string())?;
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    temporary.persist(&path).map_err(|e| e.error.to_string())?;
    Ok(json!({"hash": content_hash(text.as_bytes())}))
}

// Grants dropped Markdown files and asks the page to open them in new tabs.
pub fn dropped(window: &tauri::Window, paths: &[PathBuf]) {
    let app = window.app_handle();
    let mut opened = Vec::new();
    let mut rejected = 0;
    for path in paths {
        match grant(app, path) {
            Ok(canonical) => opened.push(display(&canonical)),
            Err(_) => rejected += 1,
        }
    }
    let _ = window.emit(
        "weave-open-external",
        json!({"paths": opened, "rejected": rejected}),
    );
}
