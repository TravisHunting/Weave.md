#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod desktop_server;
mod explorer;
mod external;
mod platform;
mod weave;
mod window_state;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
async fn weave_request(app: AppHandle, op: String, args: Value) -> Result<Value, String> {
    const ALLOWED: &[&str] = &[
        "health",
        "restore",
        "workspaceSession",
        "configureMonitoring",
        "catalog",
        "status",
        "catalogChanges",
        "catalogPage",
        "metrics",
        "getDocument",
        "save",
        "create",
        "renamePreview",
        "rename",
        "delete",
        "copy",
        "refresh",
        "graph",
        "getOutgoingRelationships",
        "getIncomingRelationships",
        "getNeighbors",
        "searchKnowledge",
        "kanban",
        "kanbanBoard",
        "kanbanSave",
        "buildEvidenceBundle",
        "gitStatus",
        "gitIgnore",
        "revealPath",
        "gitDiff",
        "gitAction",
        "gitHistory",
        "gitCommitDiff",
        "controlPanel",
        "configureStorage",
        "close",
        "reopen",
        "configureWorkspace",
        "workspaceLayout",
        "configureDeletion",
    ];
    if !ALLOWED.contains(&op.as_str()) {
        return Err("Unknown Weave operation".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let result = app.state::<weave::Service>().request(&app, &op, args)?;
        if op == "revealPath" {
            let path = result["path"].as_str().ok_or("Missing workspace path")?;
            explorer::reveal(&app, path)?;
            return Ok(json!({"revealed": true}));
        }
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn server_control(
    app: AppHandle,
    action: String,
    settings: Option<desktop_server::Settings>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<desktop_server::Controller>()
            .request(&app, &action, settings)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn weave_graph_neighborhood(
    app: AppHandle,
    args: Value,
    on_chunk: tauri::ipc::Channel<Value>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<weave::Service>()
            .graph_neighborhood(args, on_chunk)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn choose_storage_directory(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let window = app
            .get_webview_window("main")
            .ok_or("Weave window unavailable")?;
        app.dialog()
            .file()
            .set_parent(&window)
            .set_title("Choose a parent folder for Weave data")
            .blocking_pick_folder()
            .map(|folder| {
                folder
                    .into_path()
                    .map(|p| p.to_string_lossy().into_owned())
                    .map_err(|e| e.to_string())
            })
            .transpose()
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn choose_workspace(app: AppHandle) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let window = app
            .get_webview_window("main")
            .ok_or("Weave window unavailable")?;
        let selected = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("Open Markdown workspace")
            .blocking_pick_folder();
        selected
            .map(|folder| {
                let root = folder.into_path().map_err(|e| e.to_string())?;
                app.state::<weave::Service>()
                    .request(&app, "open", json!({"root": root}))
            })
            .transpose()
    })
    .await
    .map_err(|e| e.to_string())?
}
/// Exports a workspace as a portable read-only HTML reader. The destination
/// comes only from the native save dialog, never from the page.
#[tauri::command]
async fn export_workspace(
    app: AppHandle,
    scope: u64,
    name: String,
    graph: bool,
    other_files: bool,
    folder: Option<String>,
    diagrams: Option<bool>,
) -> Result<Option<Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let window = app.get_webview_window("main").ok_or("Weave window unavailable")?;
        let base: String = name.trim().chars().map(|c| if c.is_whitespace() { '_' } else if r#"<>:"/\|?*"#.contains(c) || c.is_control() { '-' } else { c }).collect();
        let file = format!("{}.html", if base.is_empty() { "workspace" } else { &base });
        let Some(target) = app.dialog().file().set_parent(&window).set_title("Export as a portable HTML file")
            .set_file_name(&file).add_filter("HTML file", &["html"]).blocking_save_file() else { return Ok(None) };
        let path = target.into_path().map_err(|e| e.to_string())?;
        let service = app.state::<weave::Service>();
        let result = service.request(&app, "exportWorkspace", json!({"scope": scope, "path": path, "graph": graph, "otherFiles": other_files, "folder": folder.unwrap_or_default(), "diagrams": diagrams.unwrap_or(true)}))?;
        *service.last_export.lock().map_err(|e| e.to_string())? = Some(path);
        Ok(Some(result))
    }).await.map_err(|e| e.to_string())?
}
/// Shows the most recent export in File Explorer.
#[tauri::command]
fn reveal_export(app: AppHandle) -> Result<(), String> {
    let path = app
        .state::<weave::Service>()
        .last_export
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("Nothing has been exported yet.")?;
    explorer::reveal(&app, &path.to_string_lossy())
}
#[tauri::command]
fn editor_state(dirty: bool, service: State<'_, weave::Service>) -> Result<(), String> {
    *service.editing.lock().map_err(|e| e.to_string())? = dirty;
    Ok(())
}
#[tauri::command]
fn window_action(window: tauri::WebviewWindow, action: String) -> Result<Value, String> {
    match action.as_str() {
        "minimize" => window.minimize(),
        "maximize" => {
            if window.is_maximized().map_err(|e| e.to_string())? {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        "close" => window.close(),
        "drag" => window.start_dragging(),
        "state" => Ok(()),
        _ => return Err("Unknown window action".into()),
    }
    .map_err(|e| e.to_string())?;
    Ok(json!({
        "visible": window.is_visible().unwrap_or(false),
        "maximized": window.is_maximized().unwrap_or(false),
        "minimized": window.is_minimized().unwrap_or(false),
        "decorated": window.is_decorated().unwrap_or(false),
        "position": window.outer_position().ok(),
        "size": window.outer_size().ok(),
        "scaleFactor": window.scale_factor().ok(),
    }))
}
#[tauri::command]
fn open_resource(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Only HTTP(S) resources without credentials can be opened.".into());
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|e| e.to_string())
}
fn main() {
    let mut args: Vec<_> = std::env::args().skip(1).collect();
    if args
        .first()
        .is_some_and(|arg| arg == "server" || arg == "--server")
    {
        #[cfg(windows)]
        unsafe {
            #[link(name = "kernel32")]
            extern "system" {
                fn AttachConsole(process: u32) -> i32;
            }
            let _ = AttachConsole(u32::MAX);
        }
        args.remove(0);
        std::process::exit(::weave::server::cli(args));
    }
    if !args.is_empty() {
        println!(
            "Weave desktop: run without arguments.\n{}",
            ::weave::server::HELP
        );
        std::process::exit(if args == ["--help"] || args == ["-h"] {
            0
        } else {
            1
        });
    }
    // A second launch raises the background window, without opening another DB.
    let desktop_control = platform::application_data().expect("Weave user data directory");
    std::fs::create_dir_all(&desktop_control).expect("Weave user data directory");
    let instance = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(desktop_control.join("desktop.lock"))
        .expect("desktop lock");
    if let Err(error) = fs2::FileExt::try_lock_exclusive(&instance) {
        if error.raw_os_error() == fs2::lock_contended_error().raw_os_error() {
            let _ = std::fs::write(desktop_control.join("show-window"), b"show");
            return;
        }
        panic!("Unable to lock desktop instance: {error}");
    }
    let _ = std::fs::remove_file(desktop_control.join("show-window"));

    // ChromeOS runs Linux apps in a container with limited GPU access, where
    // WebKitGTK's DMA-BUF renderer can leave the window blank. Set before any
    // thread starts; an explicit user setting wins.
    #[cfg(target_os = "linux")]
    if std::path::Path::new("/opt/google/cros-containers").is_dir()
        && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    tauri::Builder::default()
        .manage(weave::Service::default())
        .manage(desktop_server::Controller::default())
        .manage(external::ExternalFiles::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            weave_request,
            server_control,
            weave_graph_neighborhood,
            choose_workspace,
            export_workspace,
            reveal_export,
            choose_storage_directory,
            editor_state,
            window_action,
            open_resource,
            external::choose_markdown_file,
            external::read_external,
            external::save_external
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                external::dropped(window, paths);
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                window_state::save(window);
                if window.state::<desktop_server::Controller>().background() {
                    api.prevent_close();
                    let _ = window.hide();
                    return;
                }
                let dirty = window
                    .state::<weave::Service>()
                    .editing
                    .lock()
                    .map(|v| *v)
                    .unwrap_or(true);
                if dirty {
                    api.prevent_close();
                    let app = window.app_handle().clone();
                    window
                        .dialog()
                        .message("Discard unsaved changes and close Weave?")
                        .title("Unsaved changes")
                        .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancel)
                        .show(move |discard| {
                            if discard {
                                app.exit(0);
                            } else {
                                app.state::<desktop_server::Controller>()
                                    .quitting
                                    .store(false, std::sync::atomic::Ordering::Release);
                            }
                        });
                }
            }
        })
        .setup(move |app| {
            let executable = std::env::current_exe()?;
            let runtime = match weave::prepare_portable_directory(&executable) {
                Ok(directory) => directory,
                Err(error) => {
                    eprintln!("Weave data startup failed: {error}");
                    app.dialog()
                        .message(&error)
                        .title("Weave needs a writable folder")
                        .blocking_show();
                    return Err(
                        std::io::Error::new(std::io::ErrorKind::PermissionDenied, error).into(),
                    );
                }
            };
            app.manage(window_state::WindowState::new(
                runtime.join("window-state.json"),
            ));
            let webview = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Weave")
            .decorations(false)
            .visible(false)
            .data_directory(runtime.join("webview"))
            // Lets the context menu's Paste read the clipboard without WebView2 asking
            // whether the page may; the page is Weave's own, so this is granted.
            .enable_clipboard_access()
            .inner_size(1500.0, 1000.0)
            .min_inner_size(800.0, 600.0)
            .on_navigation(|url| {
                (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                    || (matches!(url.scheme(), "http" | "https")
                        && url.host_str() == Some("tauri.localhost"))
            })
            .build()?;
            if let Err(error) = app
                .state::<window_state::WindowState>()
                .restore(&webview.as_ref().window())
            {
                eprintln!("Unable to restore window placement: {error}");
            }
            if let Err(error) = desktop_server::tray(app.handle()) {
                eprintln!("System tray unavailable: {error}");
            }
            let handle = app.handle().clone();
            let request = desktop_control.join("show-window");
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                    if request.exists() {
                        let _ = std::fs::remove_file(&request);
                        desktop_server::show(&handle);
                    }
                }
            });
            webview.show()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Unable to start Weave")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(window) = app.get_webview_window("main") {
                    window_state::save(&window.as_ref().window());
                }
            }
            if let tauri::RunEvent::Exit = event {
                app.state::<desktop_server::Controller>().stop();
                app.state::<weave::Service>().stop(app);
            }
        });
}
