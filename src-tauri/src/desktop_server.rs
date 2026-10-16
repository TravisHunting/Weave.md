//! Desktop lifecycle only. The HTTP implementation lives in the Tauri-free library.
use ::weave::{
    server::{Config, Running},
    server_auth::{Auth, Turnstile},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{AppHandle, Manager};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    host: String,
    port: u16,
    #[serde(default)]
    workspaces: Option<Vec<String>>,
    origin: String,
    background: bool,
    #[serde(default, skip_serializing)]
    username: Option<String>,
    #[serde(default, skip_serializing)]
    password: Option<String>,
    #[serde(default, skip_serializing)]
    turnstile: Option<Turnstile>,
}
#[derive(Default)]
pub struct Controller {
    state: Mutex<Option<(Settings, Option<Running>)>>,
    pub tray: AtomicBool,
    pub quitting: AtomicBool,
}
impl Controller {
    pub fn background(&self) -> bool {
        !self.quitting.load(Ordering::Acquire)
            && self.tray.load(Ordering::Acquire)
            && self.state.lock().ok().is_some_and(|state| {
                state
                    .as_ref()
                    .is_some_and(|(s, r)| s.background && r.as_ref().is_some_and(|r| !r.finished()))
            })
    }
    pub fn request(
        &self,
        app: &AppHandle,
        action: &str,
        settings: Option<Settings>,
    ) -> Result<Value, String> {
        let backend = app.state::<crate::weave::Service>().backend(app)?;
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        if state.is_none() {
            let mut saved = backend.database.setting("desktopServer")?;
            // Previous versions selected a parent directory. Start with active workspaces instead.
            if saved["workspaces"].is_string() {
                saved["workspaces"] = Value::Null;
            }
            let settings = if saved.is_null() {
                Settings {
                    host: "127.0.0.1".into(),
                    port: 8765,
                    workspaces: None,
                    origin: String::new(),
                    background: false,
                    username: None,
                    password: None,
                    turnstile: None,
                }
            } else {
                serde_json::from_value(saved)
                    .map_err(|e| format!("Invalid saved server settings: {e}"))?
            };
            *state = Some((settings, None));
        }
        let mut choices = backend.request("controlPanel", json!({}))?["workspaces"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for workspace in &mut choices {
            workspace["available"] =
                json!(std::path::Path::new(workspace["root"].as_str().unwrap_or("")).is_dir());
        }
        let (current, running) = state.as_mut().unwrap();
        let mut last_error = None;
        if running.as_ref().is_some_and(Running::finished) {
            if let Some(mut server) = running.take() {
                last_error = server.stop().err();
            }
        }
        match action {
            "status" => {}
            "configure" => {
                if running.is_some() {
                    return Err("Stop the server before changing its settings.".into());
                }
                let mut next = settings.ok_or("Missing server settings")?;
                Self::config(&next, &backend.runtime)?;
                if let Some(ids) = &next.workspaces {
                    if ids.len() > 12
                        || ids.iter().enumerate().any(|(i, id)| {
                            ids[..i].contains(id) || !choices.iter().any(|w| w["id"] == *id)
                        })
                    {
                        return Err("Select up to 12 known workspaces.".into());
                    }
                }
                if next.background && !self.tray.load(Ordering::Acquire) {
                    return Err(
                        "A system tray is required to keep Weave running in the background.".into(),
                    );
                }
                Self::authentication(&backend.runtime, &mut next)?;
                backend.database.set(
                    "desktopServer",
                    &serde_json::to_value(&next).map_err(|e| e.to_string())?,
                )?;
                *current = next;
            }
            "credentials" => {
                let mut next = settings.ok_or("Missing authentication settings")?;
                Self::authentication(&backend.runtime, &mut next)?;
            }
            "start" => {
                if running.is_none() {
                    if Auth::open(&backend.runtime)?.status()?["configured"] != true {
                        return Err(
                            "Set an administrator password in Server Settings before starting."
                                .into(),
                        );
                    }
                    let ids = current.workspaces.clone().unwrap_or_else(|| {
                        choices
                            .iter()
                            .filter(|w| w["open"] == true)
                            .filter_map(|w| w["id"].as_str().map(String::from))
                            .collect()
                    });
                    *running = Some(Running::start_selected(
                        Self::config(current, &backend.runtime)?,
                        backend.clone(),
                        ids,
                    )?);
                }
            }
            "stop" => {
                if let Some(mut server) = running.take() {
                    server.stop()?;
                }
            }
            _ => return Err("Unknown server control".into()),
        }
        let address = running.as_ref().map(|r| format!("http://{}", r.address));
        // Every origin the running server accepts is a working link; the first
        // is the configured origin or this machine's loopback address.
        let urls = running
            .as_ref()
            .map(|r| r.origins.clone())
            .unwrap_or_default();
        Ok(
            json!({"running":running.is_some(), "address":address, "url":urls.first(), "urls":urls, "settings":current, "authentication":Auth::open(&backend.runtime)?.status()?, "workspaceChoices":choices, "backgroundAvailable":self.tray.load(Ordering::Acquire), "error":last_error}),
        )
    }
    fn authentication(data: &std::path::Path, settings: &mut Settings) -> Result<(), String> {
        let auth = Auth::open(data)?;
        if let Some(name) = settings.username.take() {
            let password = settings
                .password
                .take()
                .filter(|p| !p.is_empty())
                .map(zeroize::Zeroizing::new);
            auth.configure(
                &name,
                password.as_deref().map(String::as_str),
                settings.turnstile.take(),
            )?;
        }
        Ok(())
    }
    fn config(settings: &Settings, data: &std::path::Path) -> Result<Config, String> {
        let mut args = vec![
            "--host".into(),
            settings.host.clone(),
            "--port".into(),
            settings.port.to_string(),
            "--workspaces".into(),
            data.parent()
                .ok_or("Invalid data directory")?
                .join("workspaces")
                .to_string_lossy()
                .into_owned(),
            "--data".into(),
            data.to_string_lossy().into_owned(),
            // Desktop hosting lists exact addresses in Settings › Web server.
            "--allowed-hosts".into(),
            "local".into(),
        ];
        if !settings.origin.trim().is_empty() {
            args.extend(["--origin".into(), settings.origin.trim().into()]);
        }
        Config::parse(args)
    }
    pub fn stop(&self) {
        if let Ok(mut state) = self.state.lock() {
            if let Some((_, running)) = state.as_mut() {
                if let Some(mut server) = running.take() {
                    let _ = server.stop();
                }
            }
        }
    }
}
pub fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
pub fn tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::TrayIconBuilder,
    };
    let open = MenuItem::with_id(app, "show", "Open Weave", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop-server", "Stop web server", true, None::<&str>)?;
    let quit = MenuItem::with_id(
        app,
        "quit",
        "Quit Weave and stop server",
        true,
        None::<&str>,
    )?;
    let menu = Menu::with_items(app, &[&open, &stop, &quit])?;
    let mut tray = TrayIconBuilder::with_id("weave-server")
        .tooltip("Weave")
        .menu(&menu);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.on_menu_event(|app, event| match event.id.as_ref() {
        "show" => show(app),
        "stop-server" => {
            show(app);
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let _ = app.state::<Controller>().request(&app, "stop", None);
            });
        }
        "quit" => {
            app.state::<Controller>()
                .quitting
                .store(true, Ordering::Release);
            show(app);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.close();
            }
        }
        _ => {}
    })
    .build(app)?;
    app.state::<Controller>()
        .tray
        .store(true, Ordering::Release);
    Ok(())
}
