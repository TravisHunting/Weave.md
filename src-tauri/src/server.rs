//! Headless delivery of the shared backend. Only this boundary accepts HTTP;
//! neither the core nor the desktop host knows about browser sessions.
use crate::{
    backend::{display, Backend, Monitor},
    native_files as files,
};
use http_body_util::{BodyExt, Full, Limited};
use hyper::{
    body::{Bytes, Incoming},
    header, Request, Response, StatusCode,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    convert::Infallible,
    fs,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{net::TcpListener, sync::Semaphore};

const PAGE: &str = include_str!(concat!(env!("OUT_DIR"), "/server.html"));
const BODY_LIMIT: usize = 8 * 1024 * 1024;
const AUTH_EXPIRED: &str = "Session expired. Sign in to Weave Server again.";
type Body = Full<Bytes>;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub host: IpAddr,
    pub port: u16,
    pub workspaces: PathBuf,
    pub data: PathBuf,
    pub origin: Option<String>,
    /// Without an origin, serve any Host name (the usual self-hosting
    /// behaviour) instead of only this computer's own addresses.
    #[serde(default)]
    pub any_host: bool,
}
impl Config {
    pub fn parse(args: impl IntoIterator<Item = String>) -> Result<Self, String> {
        let mut config = Self {
            host: "127.0.0.1".parse().unwrap(),
            port: 8765,
            workspaces: "workspaces".into(),
            data: ".weave-server".into(),
            origin: None,
            any_host: true,
        };
        let mut args = args.into_iter();
        while let Some(arg) = args.next() {
            let value = args
                .next()
                .ok_or_else(|| format!("Missing value for {arg}"))?;
            match arg.as_str() {
                "--host" => {
                    config.host = value.parse().map_err(|_| "Host must be an IP address.")?
                }
                "--port" => {
                    config.port = value
                        .parse()
                        .map_err(|_| "Port must be between 0 and 65535.")?
                }
                "--workspaces" => config.workspaces = value.into(),
                "--data" => config.data = value.into(),
                "--origin" => config.origin = Some(normalize_origin(&value)?),
                "--allowed-hosts" => {
                    config.any_host = match value.as_str() {
                        "any" => true,
                        "local" => false,
                        _ => return Err("Use --allowed-hosts any or local.".into()),
                    }
                }
                _ => return Err(format!("Unknown option: {arg}")),
            }
        }
        if let Some(origin) = &config.origin {
            let url = url::Url::parse(origin).map_err(files::err)?;
            let local = url.host_str().is_some_and(|h| {
                h == "localhost"
                    || h.trim_matches(['[', ']'])
                        .parse::<IpAddr>()
                        .is_ok_and(|ip| ip.is_loopback())
            });
            if url.scheme() != "https" && !local {
                return Err("Remote browser origins require HTTPS. Terminate TLS at a reverse proxy or tunnel.".into());
            }
        }
        Ok(config)
    }
    /// Browser origins accepted for this listener. A configured origin is the
    /// only one. Otherwise a loopback listener accepts its own address and
    /// localhost, and a non-loopback listener accepts this machine's own
    /// addresses (every interface's when listening on all), read at start.
    pub fn origins(&self, port: u16) -> Vec<String> {
        if let Some(origin) = &self.origin {
            return vec![origin.clone()];
        }
        let url = |ip: IpAddr| format!("http://{}", SocketAddr::new(ip, port));
        let mut origins = vec![];
        if self.host.is_loopback() {
            origins.push(url(self.host));
        } else if !self.host.is_unspecified() {
            return vec![url(self.host)];
        }
        for local in [
            url(Ipv4Addr::LOCALHOST.into()),
            format!("http://localhost:{port}"),
        ] {
            if !origins.contains(&local) {
                origins.push(local);
            }
        }
        if self.host.is_unspecified() {
            if self.host.is_ipv6() {
                origins.push(url(Ipv6Addr::LOCALHOST.into()));
            }
            origins.extend(
                crate::interfaces::addresses()
                    .into_iter()
                    .filter(|ip| self.host.is_ipv6() || ip.is_ipv4())
                    .map(url),
            );
        }
        origins
    }
}
fn normalize_origin(value: &str) -> Result<String, String> {
    let url = url::Url::parse(value).map_err(|_| "Invalid browser origin.")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Use an HTTP(S) origin without credentials, a path, query or fragment.".into());
    }
    Ok(url.origin().ascii_serialization())
}

/// Workspace roots are direct children of one administrator-granted directory.
/// This makes roots disjoint and supports independent Docker bind mounts. File
/// paths inside each workspace still use the core's existing confinement checks.
pub struct Server {
    pub backend: Arc<Backend>,
    root: PathBuf,
    selected: Option<Vec<(String, PathBuf)>>,
    origins: Vec<String>,
    management: Mutex<()>,
    requests: Arc<Semaphore>,
    instance: String,
    auth: crate::server_auth::Auth,
    authentication: Arc<Semaphore>,
    secure: bool,
    /// Serve any Host; API calls must still come from a page on that Host.
    any_host: bool,
}
impl Server {
    pub fn new(config: &Config, port: u16, stop: Arc<AtomicBool>) -> Result<Self, String> {
        fs::create_dir_all(&config.workspaces).map_err(files::err)?;
        fs::create_dir_all(&config.data).map_err(files::err)?;
        let root = fs::canonicalize(&config.workspaces).map_err(files::err)?;
        let data = fs::canonicalize(&config.data).map_err(files::err)?;
        if root.starts_with(&data) || data.starts_with(&root) {
            return Err("Workspace storage and application data must be separate, non-overlapping directories.".into());
        }
        // Server data is private and separate from desktop storage.
        if data.join("storage.json").exists() || data.join("session.json").exists() {
            return Err(
                "Use a dedicated server data directory, not a desktop data directory."
                    .into(),
            );
        }
        let backend = Arc::new(Backend::new(data, stop)?);
        Self::with_backend(config, port, backend, root, None)
    }
    /// Desktop uses the same backend and monitor; no second database or writer.
    pub fn shared(config: &Config, port: u16, backend: Arc<Backend>) -> Result<Self, String> {
        fs::create_dir_all(&config.workspaces).map_err(files::err)?;
        let root = fs::canonicalize(&config.workspaces).map_err(files::err)?;
        let data = fs::canonicalize(&backend.runtime).map_err(files::err)?;
        if root.starts_with(&data) || data.starts_with(&root) {
            return Err("Workspace storage and application data must not overlap.".into());
        }
        Self::with_backend(config, port, backend, root, None)
    }
    /// The desktop grants exact workspace identities, independent of folder layout.
    pub fn selected(
        config: &Config,
        port: u16,
        backend: Arc<Backend>,
        ids: &[String],
    ) -> Result<Self, String> {
        if ids.is_empty() || ids.len() > crate::backend::MAX_OPEN_WORKSPACES {
            return Err("Select between 1 and 12 workspaces to serve.".into());
        }
        let known = backend.database.workspaces()?;
        let private = [
            fs::canonicalize(&backend.runtime).map_err(files::err)?,
            fs::canonicalize(
                backend
                    .database_file
                    .parent()
                    .ok_or("Invalid database directory")?,
            )
            .map_err(files::err)?,
        ];
        let mut grants: Vec<(String, PathBuf)> = vec![];
        for id in ids {
            let record = known
                .iter()
                .find(|w| w["id"] == *id)
                .ok_or("An unknown workspace was selected.")?;
            let root = fs::canonicalize(record["root"].as_str().ok_or("Invalid workspace root")?)
                .map_err(files::err)?;
            if !root.is_dir()
                || private
                    .iter()
                    .any(|data| root.starts_with(data) || data.starts_with(&root))
            {
                return Err(
                    "Workspace folders must be separate from private application data.".into(),
                );
            }
            if grants.iter().any(|(other, path)| {
                other == id || root.starts_with(path) || path.starts_with(&root)
            }) {
                return Err("Select distinct, non-overlapping workspace folders.".into());
            }
            grants.push((id.clone(), root));
        }
        let root = backend.runtime.clone(); // Not a folder grant in selected mode.
        Self::with_backend(config, port, backend, root, Some(grants))
    }
    fn with_backend(
        config: &Config,
        port: u16,
        backend: Arc<Backend>,
        root: PathBuf,
        selected: Option<Vec<(String, PathBuf)>>,
    ) -> Result<Self, String> {
        let origins = config.origins(port);
        let server = Self {
            auth: crate::server_auth::Auth::open(&backend.runtime)?,
            authentication: Arc::new(Semaphore::new(2)),
            secure: origins.iter().all(|o| o.starts_with("https://")),
            any_host: config.origin.is_none() && config.any_host,
            backend,
            root,
            selected,
            origins,
            management: Mutex::new(()),
            requests: Arc::new(Semaphore::new(64)),
            instance: files::id(),
        };
        // Validate persisted grants before reopening anything. Do not use the
        // desktop restore method, which intentionally accepts OS folder paths.
        for workspace in server.registered()? {
            let result = server
                .registered_root(workspace["id"].as_str().unwrap())
                .and_then(|root| server.backend.open_background(&display(&root)));
            if let Err(error) = result {
                if server.selected.is_some() {
                    server.backend.release_server_workspaces();
                    return Err(error);
                }
                eprintln!("Could not reopen workspace {}: {error}", workspace["id"]);
            }
        }
        Ok(server)
    }
    fn workspace_path(&self, name: &str, missing: bool) -> Result<PathBuf, String> {
        if self.selected.is_some() {
            return Err("Workspace selection is managed by the desktop server controller.".into());
        }
        if name.contains(['/', '\\']) || name.starts_with('.') || name.len() > 120 {
            return Err(
                "Choose a workspace folder name, without a path or leading dot (up to 120 bytes)."
                    .into(),
            );
        }
        let path = files::checked(&self.root, name, missing)?;
        if path.exists() && !path.is_dir() {
            return Err("Choose a workspace folder.".into());
        }
        Ok(path)
    }
    fn registered(&self) -> Result<Vec<Value>, String> {
        self.backend
            .database
            .workspaces()?
            .into_iter()
            .filter(|w| {
                if let Some(selected) = &self.selected {
                    selected.iter().any(|(id, _)| w["id"] == *id)
                } else {
                    Path::new(w["root"].as_str().unwrap_or("")).parent()
                        == Some(Path::new(&display(&self.root)))
                }
            })
            .filter_map(|w| {
                if self.selected.is_some() {
                    return Some(Ok(w));
                }
                match self
                    .backend
                    .database
                    .setting(&format!("serverRemoved:{}", w["id"].as_str().unwrap_or("")))
                {
                    Ok(Value::Bool(true)) => None,
                    Ok(_) => Some(Ok(w)),
                    Err(e) => Some(Err(e)),
                }
            })
            .collect()
    }
    fn registered_root(&self, id: &str) -> Result<PathBuf, String> {
        let record = self
            .registered()?
            .into_iter()
            .find(|w| w["id"] == id)
            .ok_or("Unknown workspace.")?;
        let root = PathBuf::from(record["root"].as_str().ok_or("Invalid workspace grant.")?);
        if let Some(selected) = &self.selected {
            let allowed = &selected
                .iter()
                .find(|(allowed, _)| allowed == id)
                .ok_or("Unselected workspace")?
                .1;
            if fs::canonicalize(&root).map_err(files::err)? != *allowed {
                return Err("The selected workspace folder changed. Restart the server.".into());
            }
            return Ok(allowed.clone());
        }
        let name = root
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("Invalid workspace folder.")?;
        let allowed = self.workspace_path(name, false)?;
        if fs::canonicalize(&allowed).map_err(files::err)?
            != fs::canonicalize(&root).map_err(files::err)?
        {
            return Err(
                "A registered workspace is outside the configured workspace directory.".into(),
            );
        }
        Ok(allowed)
    }
    fn scoped(&self, args: &Value) -> Result<(), String> {
        let scope = args["scope"]
            .as_u64()
            .filter(|s| *s > 0)
            .ok_or("An explicit workspace scope is required.")?;
        let workspace = self
            .backend
            .workspace_by_scope(scope)
            .ok_or("Workspace closed or server restarted. Reload this browser tab.")?;
        if self.selected.is_some() {
            if self.registered_root(&workspace.id)? != workspace.root {
                return Err("The workspace folder changed. Restart the server.".into());
            }
            return Ok(());
        }
        if self
            .backend
            .database
            .setting(&format!("serverRemoved:{}", workspace.id))?
            == true
        {
            return Err("This workspace has been removed from the server.".into());
        }
        // Recheck the root itself: core file validation starts below this root.
        let name = workspace
            .root
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("Invalid workspace folder.")?;
        let allowed = self.workspace_path(name, false)?;
        if fs::canonicalize(allowed).map_err(files::err)? != workspace.root {
            return Err("The workspace folder changed. Restart the server.".into());
        }
        Ok(())
    }
    pub fn request(&self, op: &str, mut args: Value) -> Result<Value, String> {
        if !args.is_object() {
            return Err("Expected an arguments object.".into());
        }
        let result = match op {
            "health" => Ok(
                json!({"ok":true,"protocol":3,"backend":"rust","host":"server","instance":self.instance,"capabilities":{
                "write":true,"git":false,"storage":true,"session":true,"nativeWindow":false,
                "graphStream":true,"resources":true,"fts":true,"workspaces":true,"export":true,"catalogChanges":true}}),
            ),
            "serverFolders" => {
                if self.selected.is_some() {
                    return Ok(json!({"folders":[],"managed":true}));
                }
                let mut folders = vec![];
                for entry in fs::read_dir(&self.root).map_err(files::err)?.take(1001) {
                    if folders.len() >= 1000 {
                        return Err("Too many workspace folders to list (maximum 1000).".into());
                    }
                    let entry = entry.map_err(files::err)?;
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if self.workspace_path(&name, false).is_ok() {
                        folders.push(name);
                    }
                }
                folders.sort();
                Ok(json!({"folders":folders}))
            }
            "serverOpen" | "reopen" => {
                let _management = self.management.lock().map_err(files::err)?;
                let root = if op == "reopen" || self.selected.is_some() {
                    self.registered_root(args["id"].as_str().ok_or("Choose a workspace.")?)?
                } else {
                    let root = self.workspace_path(
                        args["name"].as_str().ok_or("Enter a folder name.")?,
                        args["create"] == true,
                    )?;
                    if args["create"] == true {
                        if self.backend.workspaces().len() >= crate::backend::MAX_OPEN_WORKSPACES {
                            return Err("Remove a workspace from the server before adding another (maximum 12).".into());
                        }
                        fs::create_dir(&root).map_err(files::err)?;
                    }
                    root
                };
                let catalog = self.backend.open_background(&display(&root))?;
                self.backend.database.set(
                    &format!(
                        "serverRemoved:{}",
                        catalog["workspace"]["id"].as_str().unwrap()
                    ),
                    &json!(false),
                )?;
                Ok(catalog)
            }
            "serverRemove" => {
                if self.selected.is_some() {
                    return Err(
                        "Workspace selection is managed by the desktop server controller.".into(),
                    );
                }
                let _management = self.management.lock().map_err(files::err)?;
                if args["confirmed"] != true {
                    return Err("Confirm removing the workspace from this server.".into());
                }
                let id = args["id"].as_str().ok_or("Choose a workspace.")?;
                if !self.registered()?.iter().any(|w| w["id"] == id) {
                    return Err("Unknown workspace.".into());
                }
                if let Some(w) = self.backend.workspaces().iter().find(|w| w.id == id) {
                    self.backend.close_server(w.scope)?;
                }
                // Retain all files, index rows and preferences for re-registration.
                self.backend
                    .database
                    .set(&format!("serverRemoved:{id}"), &json!(true))?;
                Ok(json!({"removed":true}))
            }
            "controlPanel" => {
                if args.get("scope").is_some_and(|s| !s.is_null()) {
                    self.scoped(&args)?;
                }
                let scoped = args["scope"].is_u64();
                let mut panel = self.backend.request(op, args)?;
                if !scoped {
                    panel["status"] = Value::Null;
                }
                let registered = self.registered()?;
                panel["managedWorkspaces"] = json!(self.selected.is_some());
                panel["defaultWorkspaces"] = json!(if let Some(selected) = &self.selected {
                    selected
                        .iter()
                        .map(|(id, _)| id.clone())
                        .collect::<Vec<_>>()
                } else {
                    registered
                        .iter()
                        .filter_map(|w| w["id"].as_str().map(String::from))
                        .collect()
                });
                panel["workspaces"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|w| registered.iter().any(|r| r["id"] == w["id"]));
                for w in panel["workspaces"].as_array_mut().unwrap() {
                    w["open"] = json!(self.backend.workspaces().iter().any(|o| o.id == w["id"]));
                }
                panel.as_object_mut().unwrap().remove("open");
                panel["dataDirectory"] = json!("Managed by the server administrator");
                panel["trashDirectory"] = json!("Private server data / trash");
                panel
                    .as_object_mut()
                    .unwrap()
                    .remove("pendingDataDirectory");
                panel.as_object_mut().unwrap().remove("active");
                Ok(panel)
            }
            "configureWorkspace" => {
                self.registered_root(args["id"].as_str().ok_or("Choose a workspace.")?)?;
                self.backend.request(op, args)
            }
            "configureDeletion" => {
                self.backend.request(op, args)?;
                // Settings writes return the same sanitised control-panel shape.
                self.request("controlPanel", json!({}))
            }
            "graphNeighborhood" => {
                self.scoped(&args)?;
                let mut chunks = vec![];
                let summary = self.backend.graph_stream(&args, |chunk| {
                    chunks.push(chunk);
                    Ok(())
                })?;
                Ok(json!({"summary":summary,"chunks":chunks}))
            }
            "catalog"
            | "status"
            | "catalogChanges"
            | "catalogPage"
            | "getDocument"
            | "save"
            | "create"
            | "renamePreview"
            | "rename"
            | "delete"
            | "copy"
            | "refresh"
            | "graph"
            | "getOutgoingRelationships"
            | "getIncomingRelationships"
            | "getNeighbors"
            | "searchKnowledge"
            | "kanban"
            | "kanbanBoard"
            | "kanbanSave"
            | "buildEvidenceBundle"
            | "configureMonitoring" => {
                self.scoped(&args)?;
                // Never allow a caller to request an unbounded whole-workspace graph.
                if op == "graph" {
                    args["summaryOnly"] = json!(true);
                }
                self.backend.request(op, args)
            }
            _ => Err("This operation is unavailable on Weave Server.".into()),
        };
        result
            .map(|mut value| {
                self.redact_metadata(&mut value);
                value
            })
            .map_err(|e| self.safe_error(&e))
    }
    fn redact_metadata(&self, value: &mut Value) {
        // Do not recursively rewrite prose, user frontmatter, or article paths.
        // Only the transport's catalog/status/control metadata carries OS paths.
        if let Some(map) = value.as_object_mut() {
            for key in ["runtime", "database", "pid"] {
                map.remove(key);
            }
            for key in ["root", "displayPath"] {
                if let Some(path) = map.get(key).and_then(Value::as_str) {
                    let name = Path::new(path)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy();
                    map.insert(key.into(), json!(name));
                }
            }
            if let Some(error) = map.get("lastError").and_then(Value::as_str) {
                map.insert("lastError".into(), json!(self.safe_error(error)));
            }
            // Deletion recovery is a private server path, never a browser grant.
            if map.contains_key("recovery") {
                map.insert("recovery".into(), json!("private server trash"));
            }
            for key in ["workspace", "status"] {
                if let Some(v) = map.get_mut(key) {
                    self.redact_metadata(v);
                }
            }
            if let Some(list) = map.get_mut("workspaces").and_then(Value::as_array_mut) {
                for item in list {
                    self.redact_metadata(item);
                }
            }
            // Server clients own their navigation state.
            map.remove("session");
        }
    }
    fn safe_error(&self, error: &str) -> String {
        let mut error = error.to_string();
        if let Some(selected) = &self.selected {
            for (_, root) in selected {
                error = error
                    .replace(&display(root), "[workspace]")
                    .replace(&root.to_string_lossy().to_string(), "[workspace]");
            }
        }
        error
            .replace(&display(&self.backend.runtime), "[server data]")
            .replace(
                &self.backend.runtime.to_string_lossy().to_string(),
                "[server data]",
            )
            .replace(&display(&self.root), "[workspaces]")
            .replace(&self.root.to_string_lossy().to_string(), "[workspaces]")
    }
    fn export(&self, args: Value) -> Result<(Vec<u8>, Value), String> {
        self.scoped(&args)?;
        let temporary = tempfile::tempdir_in(&self.backend.runtime).map_err(files::err)?;
        let output = temporary.path().join("workspace.html");
        // Build a fresh argument object: path/template are never caller-controlled.
        let metadata = self.backend.request("exportWorkspace", json!({"scope":args["scope"],"path":output,
            "folder":args["folder"].as_str().unwrap_or(""),"graph":args["graph"] != false,"otherFiles":args["otherFiles"] != false,"diagrams":args["diagrams"] != false}))?;
        Ok((fs::read(output).map_err(files::err)?, metadata))
    }
    fn trusted(&self, req: &Request<Incoming>) -> bool {
        let host = req
            .headers()
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("");
        // In any-host mode the Host only has to be a plausible authority:
        // reverse proxies, tunnels, LAN names and remapped ports need no
        // configuration, and authentication protects the content.
        let any: Vec<String>;
        let allowed: Vec<&String> = if self.any_host {
            if host.is_empty()
                || !host
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b".-:[]_".contains(&b))
            {
                return false;
            }
            any = vec![format!("http://{host}"), format!("https://{host}")];
            any.iter().collect()
        } else {
            self.origins
                .iter()
                .filter(|origin| {
                    origin
                        .split_once("://")
                        .is_some_and(|(_, authority)| authority == host)
                })
                .collect()
        };
        if allowed.is_empty() {
            return false;
        }
        if req.method() == hyper::Method::POST {
            // Top-level GET navigation may follow an access-gateway login or
            // an external link. Only the API needs a same-origin fetch context.
            if let Some(site) = req.headers().get("sec-fetch-site") {
                if site != "same-origin" && site != "none" {
                    return false;
                }
            }
            let origin = req
                .headers()
                .get(header::ORIGIN)
                .and_then(|h| h.to_str().ok())
                .unwrap_or("");
            if !allowed.iter().any(|o| o.eq_ignore_ascii_case(origin)) {
                return false;
            }
            if req
                .headers()
                .get("x-weave-request")
                .is_none_or(|h| h != "1")
            {
                return false;
            }
            let content = req
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|h| h.to_str().ok())
                .unwrap_or("");
            if content.split(';').next().unwrap_or("").trim() != "application/json" {
                return false;
            }
        }
        true
    }
    async fn handle(
        self: Arc<Self>,
        req: Request<Incoming>,
        peer: IpAddr,
    ) -> Result<Response<Body>, Infallible> {
        if !self.trusted(&req) {
            return Ok(error(
                StatusCode::FORBIDDEN,
                "Untrusted browser origin or request headers.",
            ));
        }
        let path = req.uri().path().to_string();
        if req.uri().query().is_some() {
            return Ok(error(StatusCode::NOT_FOUND, "Unknown endpoint."));
        }
        if req.method() == hyper::Method::GET && path == "/healthz" {
            return Ok(response(
                StatusCode::OK,
                "application/json",
                Bytes::from_static(b"{\"ok\":true}"),
            ));
        }
        if req.method() == hyper::Method::GET && matches!(path.as_str(), "/auth.js" | "/auth.css") {
            return Ok(if path == "/auth.js" {
                response(
                    StatusCode::OK,
                    "text/javascript; charset=utf-8",
                    Bytes::from_static(include_bytes!("../../app/weave/server-auth.js")),
                )
            } else {
                response(
                    StatusCode::OK,
                    "text/css; charset=utf-8",
                    Bytes::from_static(include_bytes!("../../app/weave/server-auth.css")),
                )
            });
        }
        let token = req
            .headers()
            .get(header::COOKIE)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("")
            .split(';')
            .filter_map(|part| part.trim().split_once('='))
            .find(|(name, _)| *name == self.cookie_name())
            .map(|(_, v)| v)
            .unwrap_or("")
            .to_string();
        let csrf = req
            .headers()
            .get("x-weave-csrf")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("")
            .to_string();
        let auth = self.auth.clone();
        let lookup_token = token.clone();
        let principal = match tokio::task::spawn_blocking(move || auth.session(&lookup_token)).await
        {
            Ok(Ok(p)) => p,
            _ => {
                return Ok(error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Authentication unavailable.",
                ))
            }
        };
        if req.method() == hyper::Method::GET && path == "/auth/status" {
            let auth = self.auth.clone();
            let result = tokio::task::spawn_blocking(move || {
                let setup = auth.status()?["configured"] != true;
                let t = if setup {
                    Default::default()
                } else {
                    auth.turnstile()?
                };
                Ok::<_, String>((setup, t))
            })
            .await;
            return Ok(match result {Ok(Ok((setup, t)))=>response(StatusCode::OK,"application/json",Bytes::from(json!({"setup":setup,"authenticated":principal.is_some(),"mustChange":principal.as_ref().is_some_and(|p|p.must_change),"csrf":principal.as_ref().map(|p|&p.csrf),"turnstile":if t.enabled {json!({"siteKey":t.site_key,"action":t.action()})} else {Value::Null}}).to_string())),_=>error(StatusCode::SERVICE_UNAVAILABLE,"Authentication unavailable.")});
        }
        if req.method() == hyper::Method::GET
            && (path == "/login"
                || path == "/account"
                || path == "/" && principal.as_ref().is_none_or(|p| p.must_change))
        {
            let mut page = response(
                StatusCode::OK,
                "text/html; charset=utf-8",
                Bytes::from_static(include_bytes!("../../app/weave/server-auth.html")),
            );
            page.headers_mut().insert("content-security-policy", "default-src 'none'; script-src 'self' https://challenges.cloudflare.com; style-src 'self'; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'".parse().unwrap());
            return Ok(page);
        }
        if req.method() == hyper::Method::GET
            && req.uri().path() == "/"
            && req.uri().query().is_none()
        {
            return Ok(response(
                StatusCode::OK,
                "text/html; charset=utf-8",
                Bytes::from_static(PAGE.as_bytes()),
            ));
        }
        let authentication = path == "/api/auth";
        // trusted() already matched Origin to Host; an https Origin means a
        // TLS proxy or tunnel in front, so the session cookie can be Secure.
        let https = req
            .headers()
            .get(header::ORIGIN)
            .and_then(|h| h.to_str().ok())
            .is_some_and(|o| o.starts_with("https://"));
        let export = req.uri().path() == "/api/export";
        let instance = req
            .headers()
            .get("x-weave-instance")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("")
            .to_string();
        if req.method() != hyper::Method::POST
            || (!export && !authentication && req.uri().path() != "/api/request")
            || req.uri().query().is_some()
        {
            return Ok(error(StatusCode::NOT_FOUND, "Unknown endpoint."));
        }
        if !authentication {
            let Some(p) = &principal else {
                return Ok(error(StatusCode::UNAUTHORIZED, "Sign in to Weave Server."));
            };
            if p.must_change {
                return Ok(error(
                    StatusCode::FORBIDDEN,
                    "Change the initial password before opening workspaces.",
                ));
            }
            if csrf != p.csrf {
                return Ok(error(StatusCode::FORBIDDEN, "Invalid CSRF token."));
            }
        }
        let Ok(permit) = self.requests.clone().try_acquire_owned() else {
            return Ok(error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Server busy. Try again shortly.",
            ));
        };
        let body = match tokio::time::timeout(
            Duration::from_secs(15),
            Limited::new(
                req.into_body(),
                if authentication {
                    16 * 1024
                } else {
                    BODY_LIMIT
                },
            )
            .collect(),
        )
        .await
        {
            Ok(Ok(body)) => body.to_bytes(),
            Ok(Err(_)) => {
                return Ok(error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    if authentication {
                        "Authentication body exceeds 16 KB."
                    } else {
                        "Request body exceeds 8 MB."
                    },
                ))
            }
            Err(_) => {
                return Ok(error(
                    StatusCode::REQUEST_TIMEOUT,
                    "Request body timed out.",
                ))
            }
        };
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Call {
            op: String,
            args: Value,
        }
        let call: Call = match serde_json::from_slice(&body) {
            Ok(call) => call,
            Err(_) => return Ok(error(StatusCode::BAD_REQUEST, "Expected {op, args} JSON.")),
        };
        if authentication {
            let Ok(auth_permit) = self.authentication.clone().try_acquire_owned() else {
                return Ok(error(
                    StatusCode::TOO_MANY_REQUESTS,
                    "Login busy. Try again shortly.",
                ));
            };
            let server = self.clone();
            let result = tokio::task::spawn_blocking(move || {
                let _permits = (permit, auth_permit);
                server.authenticate(&call.op, call.args, principal, csrf, peer, https)
            })
            .await;
            return Ok(result.unwrap_or_else(|_| {
                error(StatusCode::INTERNAL_SERVER_ERROR, "Authentication failed.")
            }));
        }
        if (export || call.op != "health") && instance != self.instance {
            return Ok(error(
                StatusCode::CONFLICT,
                "Server restarted or client not initialised. Reload this browser tab.",
            ));
        }
        let server = self.clone();
        let result = tokio::task::spawn_blocking(move || {
            // The permit lives with the work even if the HTTP client disconnects.
            let _permit = permit;
            // A body can take 15 seconds to arrive. A local reset during that
            // time must revoke this request before it reaches the backend.
            if server
                .auth
                .session(&token)?
                .is_none_or(|p| p.must_change || p.csrf != csrf)
            {
                return Err(AUTH_EXPIRED.into());
            }
            if export {
                if call.op != "export" {
                    return Err("Unknown export operation.".into());
                }
                server
                    .export(call.args)
                    .map(|(bytes, metadata)| (Bytes::from(bytes), Some(metadata)))
            } else {
                server.request(&call.op, call.args).and_then(|v| {
                    serde_json::to_vec(&v)
                        .map(|b| (Bytes::from(b), None))
                        .map_err(files::err)
                })
            }
        })
        .await;
        Ok(match result {
            Ok(Ok((bytes, metadata))) => {
                let mut result = response(
                    StatusCode::OK,
                    if export {
                        "text/html; charset=utf-8"
                    } else {
                        "application/json"
                    },
                    bytes,
                );
                if export {
                    result.headers_mut().insert(
                        header::CONTENT_DISPOSITION,
                        "attachment; filename=workspace.html".parse().unwrap(),
                    );
                }
                if let Some(metadata) = metadata {
                    result.headers_mut().insert(
                        "x-weave-documents",
                        metadata["documents"].to_string().parse().unwrap(),
                    );
                    result.headers_mut().insert(
                        "x-weave-relationships",
                        metadata["relationships"].to_string().parse().unwrap(),
                    );
                    result.headers_mut().insert(
                        "x-weave-diagrams",
                        (metadata["diagrams"] == true).to_string().parse().unwrap(),
                    );
                }
                result
            }
            Ok(Err(message)) if message == AUTH_EXPIRED => {
                error(StatusCode::UNAUTHORIZED, AUTH_EXPIRED)
            }
            Ok(Err(message)) => error(StatusCode::CONFLICT, &self.safe_error(&message)),
            Err(_) => error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Server operation failed. See the server log.",
            ),
        })
    }
    fn cookie_name(&self) -> &'static str {
        if self.secure {
            "__Host-weave-session"
        } else {
            "weave-session"
        }
    }
    fn cookie(&self, response: &mut Response<Body>, token: &str, max_age: i64, https: bool) {
        let value = format!(
            "{}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}{}",
            self.cookie_name(),
            if self.secure || https { "; Secure" } else { "" }
        );
        response
            .headers_mut()
            .insert(header::SET_COOKIE, value.parse().unwrap());
    }
    fn authenticate(
        &self,
        op: &str,
        args: Value,
        principal: Option<crate::server_auth::Principal>,
        csrf: String,
        peer: IpAddr,
        https: bool,
    ) -> Response<Body> {
        use zeroize::Zeroizing;
        if op == "setup" {
            // First visit to a new installation creates the administrator and
            // signs in. Auth::setup refuses once any administrator exists.
            let password = Zeroizing::new(args["password"].as_str().unwrap_or("").to_string());
            let name = args["username"].as_str().unwrap_or("");
            return match self
                .auth
                .setup(name, &password)
                .and_then(|()| self.auth.login(name, &password, ""))
            {
                Ok(login) => {
                    let mut r = response(
                        StatusCode::OK,
                        "application/json",
                        Bytes::from_static(b"{\"mustChange\":false}"),
                    );
                    self.cookie(&mut r, &login.token, crate::server_auth::LIFETIME, https);
                    r
                }
                Err(message) => error(StatusCode::BAD_REQUEST, &message),
            };
        }
        if op == "login" {
            if self.auth.attempt(&peer.to_string()).is_err() {
                return error(
                    StatusCode::TOO_MANY_REQUESTS,
                    "Too many login attempts. Try again in five minutes.",
                );
            }
            let password = Zeroizing::new(args["password"].as_str().unwrap_or("").to_string());
            return match self.auth.login(
                args["username"].as_str().unwrap_or(""),
                &password,
                args["challenge"].as_str().unwrap_or(""),
            ) {
                Ok(login) => {
                    let mut r = response(
                        StatusCode::OK,
                        "application/json",
                        Bytes::from(json!({"mustChange":login.principal.must_change}).to_string()),
                    );
                    self.cookie(&mut r, &login.token, crate::server_auth::LIFETIME, https);
                    r
                }
                Err(_) => error(
                    StatusCode::UNAUTHORIZED,
                    "Login failed. Check credentials and any verification challenge.",
                ),
            };
        }
        let Some(p) = principal else {
            return error(StatusCode::UNAUTHORIZED, "Sign in to Weave Server.");
        };
        if csrf != p.csrf {
            return error(StatusCode::FORBIDDEN, "Invalid CSRF token.");
        }
        let result = match op {
            "logout" => self.auth.logout(&p),
            "password" => {
                if self.auth.attempt(&peer.to_string()).is_err() {
                    return error(
                        StatusCode::TOO_MANY_REQUESTS,
                        "Too many attempts. Try again in five minutes.",
                    );
                }
                let old = Zeroizing::new(args["current"].as_str().unwrap_or("").to_string());
                let new = Zeroizing::new(args["password"].as_str().unwrap_or("").to_string());
                self.auth.change_password(&p, &old, &new)
            }
            _ => return error(StatusCode::NOT_FOUND, "Unknown authentication operation."),
        };
        match result {
            Ok(()) => {
                let mut r = response(
                    StatusCode::OK,
                    "application/json",
                    Bytes::from_static(b"{\"ok\":true}"),
                );
                self.cookie(&mut r, "", 0, https);
                r
            }
            Err(message) => error(StatusCode::BAD_REQUEST, &message),
        }
    }
}
fn response(status: StatusCode, content: &str, bytes: Bytes) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content)
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff")
        .header("x-frame-options", "DENY")
        .header("referrer-policy", "same-origin")
        .header("content-security-policy", "frame-ancestors 'none'")
        .body(Full::new(bytes))
        .unwrap()
}
fn error(status: StatusCode, message: &str) -> Response<Body> {
    response(
        status,
        "application/json",
        Bytes::from(json!({"error":message}).to_string()),
    )
}
async fn interrupt_signal() {
    // A service/redirected process may have no console. Stay alive in that case.
    if tokio::signal::ctrl_c().await.is_err() {
        std::future::pending::<()>().await;
    }
}
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler");
        tokio::select! {_ = interrupt_signal() => {}, _ = term.recv() => {}}
    }
    #[cfg(not(unix))]
    {
        interrupt_signal().await;
    }
}
/// A stoppable listener. Dropping it drains HTTP work without shutting down
/// the desktop backend. The dedicated binary owns its own monitor and backend.
pub struct Running {
    pub address: SocketAddr,
    /// Browser origins the server accepts, preferred first.
    pub origins: Vec<String>,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<Result<(), String>>>,
}
impl Running {
    pub fn start(config: Config, backend: Arc<Backend>) -> Result<Self, String> {
        Self::start_with(config, backend, None)
    }
    pub fn start_selected(
        config: Config,
        backend: Arc<Backend>,
        ids: Vec<String>,
    ) -> Result<Self, String> {
        Self::start_with(config, backend, Some(ids))
    }
    fn start_with(
        config: Config,
        backend: Arc<Backend>,
        ids: Option<Vec<String>>,
    ) -> Result<Self, String> {
        let (stop, receiver) = tokio::sync::oneshot::channel();
        let (ready, started) = std::sync::mpsc::sync_channel(1);
        let thread = std::thread::spawn(move || {
            let runtime = tokio::runtime::Runtime::new().map_err(files::err)?;
            runtime.block_on(async move {
                let listener =
                    match TcpListener::bind(SocketAddr::new(config.host, config.port)).await {
                        Ok(listener) => listener,
                        Err(error) => {
                            let message = error.to_string();
                            let _ = ready.send(Err(message.clone()));
                            return Err(message);
                        }
                    };
                let address = listener.local_addr().map_err(files::err)?;
                let creation = match ids {
                    Some(ids) => Server::selected(&config, address.port(), backend.clone(), &ids),
                    None => Server::shared(&config, address.port(), backend.clone()),
                };
                let server = match creation {
                    Ok(server) => Arc::new(server),
                    Err(error) => {
                        let _ = ready.send(Err(error.clone()));
                        return Err(error);
                    }
                };
                let _ = ready.send(Ok((address, server.origins.clone())));
                let result = serve(listener, server, async {
                    let _ = receiver.await;
                })
                .await;
                backend.release_server_workspaces();
                result
            })
        });
        match started.recv().map_err(files::err)? {
            Ok((address, origins)) => Ok(Self {
                address,
                origins,
                stop: Some(stop),
                thread: Some(thread),
            }),
            Err(error) => {
                let _ = thread.join();
                Err(error)
            }
        }
    }
    pub fn finished(&self) -> bool {
        self.thread.as_ref().is_none_or(|t| t.is_finished())
    }
    pub fn stop(&mut self) -> Result<(), String> {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            return thread
                .join()
                .map_err(|_| "Server thread failed".to_string())?;
        }
        Ok(())
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

pub async fn run(config: Config) -> Result<(), String> {
    let listener = TcpListener::bind(SocketAddr::new(config.host, config.port))
        .await
        .map_err(files::err)?;
    let address = listener.local_addr().map_err(files::err)?;
    let stop = Arc::new(AtomicBool::new(false));
    let server = Arc::new(Server::new(&config, address.port(), stop.clone())?);
    let variable = |name| std::env::var(name).ok().filter(|v: &String| !v.is_empty());
    let password = variable("WEAVE_ADMIN_PASSWORD").map(zeroize::Zeroizing::new);
    server.auth.provision(
        variable("WEAVE_ADMIN_USERNAME").as_deref(),
        password.as_deref().map(String::as_str),
        variable("WEAVE_ADMIN_PASSWORD_FILE")
            .map(PathBuf::from)
            .as_deref(),
    )?;
    let monitor = Monitor::start(
        server.backend.clone(),
        Duration::from_millis(250),
        |_, _| {},
    );
    println!("Weave Server listening on http://{address}");
    for origin in &server.origins {
        println!("Open {origin}");
    }
    let result = serve(listener, server.clone(), shutdown_signal()).await;
    stop.store(true, Ordering::Release);
    tokio::task::spawn_blocking(move || monitor.stop())
        .await
        .map_err(files::err)?;
    server.backend.request("shutdown", json!({}))?;
    result
}
async fn serve(
    listener: TcpListener,
    server: Arc<Server>,
    shutdown: impl std::future::Future<Output = ()>,
) -> Result<(), String> {
    let connections = Arc::new(Semaphore::new(256));
    let mut tasks = tokio::task::JoinSet::new();
    tokio::pin!(shutdown);
    let result = loop {
        tokio::select! {
            _ = &mut shutdown => break Ok(()),
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
            connection = listener.accept() => {
                let (stream, peer) = match connection {Ok(value) => value, Err(error) => break Err(error.to_string())};
                let Ok(permit) = connections.clone().try_acquire_owned() else {continue;};
                let server = server.clone();
                tasks.spawn(async move {
                    let _permit = permit;
                    let service = hyper::service::service_fn(move |req| server.clone().handle(req,peer.ip()));
                    let _ = hyper::server::conn::http1::Builder::new().timer(TokioTimer::new())
                        .header_read_timeout(Duration::from_secs(10)).max_buf_size(32768)
                        .serve_connection(TokioIo::new(stream), service).await;
                });
            }
        }
    };
    drop(listener);
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    let _drained = server.requests.acquire_many(64).await.map_err(files::err)?;
    result
}

pub const HELP: &str = "Weave Server\n\nweave server [options]\nweave-server [options]\n\n--host IP           Listen address (default 127.0.0.1)\n--port PORT         Listen port (default 8765; 0 chooses a free port)\n--workspaces PATH   Parent of workspace folders (default ./workspaces)\n--data PATH         Private server data (default ./.weave-server)\n--origin URL        Exact browser origin (HTTPS for remote access); only it is accepted\n--allowed-hosts any|local  Without --origin: serve any host name (default), or only\n                    this computer's own addresses (WEAVE_ALLOWED_HOSTS)\n\nadmin status --data PATH\nadmin set-username --data PATH --username NAME\nadmin reset-password --data PATH [--password-file PATH]\nadmin turnstile --data PATH --enabled true|false [--site-key KEY --hostname HOST --secret-file PATH]\n\nOn a new installation the first browser visit creates the administrator account.\nTo create it at start instead, set WEAVE_ADMIN_USERNAME (default admin) and\nWEAVE_ADMIN_PASSWORD or WEAVE_ADMIN_PASSWORD_FILE; they are ignored once it exists.\nRuns without creating a GUI. Ctrl+C/SIGTERM stops gracefully. Remote access requires TLS at a reverse proxy or tunnel.\n";
/// Both binaries enter this code before any desktop initialisation.
pub fn cli(args: impl IntoIterator<Item = String>) -> i32 {
    let args: Vec<_> = args.into_iter().collect();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{HELP}");
        return 0;
    }
    let result = if args.first().is_some_and(|arg| arg == "admin") {
        admin(&args[1..])
    } else {
        // Containers configure through the environment; flags win.
        let mut args = args;
        for (variable, flag) in [
            ("WEAVE_ORIGIN", "--origin"),
            ("WEAVE_ALLOWED_HOSTS", "--allowed-hosts"),
        ] {
            let value = std::env::var(variable).ok().filter(|v| !v.is_empty());
            if let Some(value) = value.filter(|_| !args.iter().any(|arg| arg == flag)) {
                args.extend([flag.into(), value]);
            }
        }
        Config::parse(args).and_then(|config| {
            tokio::runtime::Runtime::new()
                .map_err(files::err)?
                .block_on(run(config))
        })
    };
    match result {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("Weave Server: {error}");
            1
        }
    }
}
fn admin(args: &[String]) -> Result<(), String> {
    use crate::server_auth::{read_password, Auth};
    let command = args.first().ok_or("Choose an admin command. See --help.")?;
    let mut options = std::collections::HashMap::new();
    let mut iter = args[1..].iter();
    while let Some(key) = iter.next() {
        if !matches!(
            key.as_str(),
            "--data"
                | "--username"
                | "--password-file"
                | "--enabled"
                | "--site-key"
                | "--hostname"
                | "--secret-file"
        ) {
            return Err(format!("Unknown admin option: {key}"));
        }
        let value = iter.next().ok_or("Missing admin option value.")?;
        if options.insert(key.as_str(), value.as_str()).is_some() {
            return Err("Duplicate admin option.".into());
        }
    }
    let data = PathBuf::from(options.get("--data").copied().unwrap_or(".weave-server"));
    let auth = Auth::open(&data)?;
    match command.as_str() {
        "status" => println!("{}", auth.status()?),
        "bootstrap" => {
            use std::io::IsTerminal;
            if !std::io::stdout().is_terminal() {
                return Err("Bootstrap credentials are shown only in an interactive terminal. Use a local password-file reset for automation.".into());
            }
            print!("{}", auth.bootstrap()?.as_str());
        }
        "set-username" => auth.configure(
            options
                .get("--username")
                .copied()
                .ok_or("Provide --username NAME.")?,
            None,
            None,
        )?,
        "reset-password" => {
            let password = if let Some(path) = options.get("--password-file") {
                read_password(Path::new(path))?
            } else {
                use std::io::IsTerminal;
                if !std::io::stdin().is_terminal() {
                    return Err(
                        "Noninteractive password resets require --password-file PATH.".into(),
                    );
                }
                let first = zeroize::Zeroizing::new(
                    rpassword::prompt_password("New administrator password: ")
                        .map_err(files::err)?,
                );
                let confirm = zeroize::Zeroizing::new(
                    rpassword::prompt_password("Confirm password: ").map_err(files::err)?,
                );
                if first != confirm {
                    return Err("Passwords do not match.".into());
                }
                first
            };
            let status = auth.status()?;
            auth.configure(
                status["username"].as_str().unwrap_or("admin"),
                Some(&password),
                None,
            )?;
        }
        "turnstile" => {
            if auth.status()?["configured"] != true {
                return Err("Provision the administrator first.".into());
            }
            let mut t = auth.turnstile()?;
            t.enabled = options
                .get("--enabled")
                .ok_or("Provide --enabled true|false.")?
                .parse()
                .map_err(|_| "Use --enabled true or false.")?;
            if let Some(key) = options.get("--site-key") {
                t.site_key = key.to_string();
            }
            if let Some(host) = options.get("--hostname") {
                t.hostname = host.to_string();
            }
            if let Some(file) = options.get("--secret-file") {
                t.secret = read_password(Path::new(file))?.to_string();
            }
            let status = auth.status()?;
            auth.configure(
                status["username"]
                    .as_str()
                    .ok_or("Missing administrator.")?,
                None,
                Some(t),
            )?;
        }
        _ => return Err("Unknown admin command. See --help.".into()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn origin_and_listener_validation() {
        // Any host name is served by default; local restricts it to the
        // suggested origins below.
        assert!(Config::parse(Vec::<String>::new()).unwrap().any_host);
        assert!(
            !Config::parse(["--allowed-hosts", "local"].map(String::from))
                .unwrap()
                .any_host
        );
        assert!(Config::parse(["--allowed-hosts", "all"].map(String::from)).is_err());
        // The suggested origins are this machine's own addresses.
        let all = Config::parse(["--host", "0.0.0.0"].map(String::from)).unwrap();
        let origins = all.origins(8765);
        assert_eq!(
            origins[..2],
            ["http://127.0.0.1:8765", "http://localhost:8765"]
        );
        assert!(origins
            .iter()
            .all(|o| o.starts_with("http://") && !o.contains("0.0.0.0") && o.ends_with(":8765")));
        let lan = Config::parse(["--host", "192.168.1.20"].map(String::from)).unwrap();
        assert_eq!(lan.origins(80), ["http://192.168.1.20:80"]);
        let local = Config::parse(["--host", "127.0.0.1"].map(String::from)).unwrap();
        assert_eq!(
            local.origins(9),
            ["http://127.0.0.1:9", "http://localhost:9"]
        );
        let public = Config::parse(
            ["--host", "0.0.0.0", "--origin", "https://notes.example.org"].map(String::from),
        )
        .unwrap();
        assert_eq!(public.origins(8765), ["https://notes.example.org"]);
        assert!(Config::parse(["--origin", "http://notes.example.org"].map(String::from)).is_err());
        assert!(normalize_origin("https://user:pass@example.org").is_err());
        assert!(normalize_origin("https://example.org/path").is_err());
        assert_eq!(
            normalize_origin("https://example.org/").unwrap(),
            "https://example.org"
        );
    }
    #[test]
    fn scoped_operations_and_grants() {
        let temporary = tempfile::tempdir().unwrap();
        let config = Config {
            host: "127.0.0.1".parse().unwrap(),
            port: 8765,
            workspaces: temporary.path().join("workspaces"),
            data: temporary.path().join("data"),
            origin: None,
            any_host: false,
        };
        let server = Server::new(&config, 8765, Arc::new(AtomicBool::new(false))).unwrap();
        assert!(server
            .request("serverOpen", json!({"name":"../escape","create":true}))
            .is_err());
        let first = server
            .request("serverOpen", json!({"name":"First","create":true}))
            .unwrap();
        let second = server
            .request("serverOpen", json!({"name":"Second","create":true}))
            .unwrap();
        assert_ne!(first["scope"], second["scope"]);
        assert!(server
            .request("create", json!({"path":"Wrong.md"}))
            .is_err());
        assert!(server.request("create", json!({"scope":first["scope"],"resource":{"workspaceId":second["workspace"]["id"],"logicalPath":"/Wrong.md","kind":"file"}})).is_err());
        for op in [
            "configureStorage",
            "open",
            "restore",
            "shutdown",
            "gitAction",
            "revealPath",
            "exportWorkspace",
            "workspaceLayout",
            "workspaceSession",
            "close",
        ] {
            assert!(
                server.request(op, json!({"scope":first["scope"]})).is_err(),
                "{op}"
            );
        }
        server
            .request(
                "create",
                json!({"scope":first["scope"],"path":"Note.md","text":"# First"}),
            )
            .unwrap();
        let doc = server
            .request(
                "getDocument",
                json!({"scope":first["scope"],"path":"Note.md"}),
            )
            .unwrap();
        server
            .request(
                "save",
                json!({"scope":first["scope"],"path":"Note.md","text":"# New","hash":doc["hash"]}),
            )
            .unwrap();
        assert!(server
            .request(
                "save",
                json!({"scope":first["scope"],"path":"Note.md","text":"# Stale","hash":doc["hash"]})
            )
            .is_err());
        assert!(!second.to_string().contains(&display(&config.data)));
        server
            .request(
                "serverRemove",
                json!({"id":first["workspace"]["id"],"confirmed":true}),
            )
            .unwrap();
        assert!(config.workspaces.join("First/Note.md").exists());
        assert!(server
            .request("status", json!({"scope":first["scope"]}))
            .is_err());
    }
    #[test]
    fn selected_workspaces_grant_only_exact_ids_in_controller_order() {
        let temp = tempfile::tempdir().unwrap();
        let config = Config {
            host: "127.0.0.1".parse().unwrap(),
            port: 0,
            workspaces: temp.path().join("unused"),
            data: temp.path().join("data"),
            origin: None,
            any_host: false,
        };
        let backend =
            Arc::new(Backend::new(config.data.clone(), Arc::new(AtomicBool::new(false))).unwrap());
        let mut catalogs = Vec::new();
        for name in ["one/Same", "two/Same", "private"] {
            let root = temp.path().join(name);
            fs::create_dir_all(&root).unwrap();
            fs::write(root.join("Note.md"), "# Note").unwrap();
            catalogs.push(backend.open(&display(&root)).unwrap());
        }
        let ids = vec![
            catalogs[1]["workspace"]["id"].as_str().unwrap().to_string(),
            catalogs[0]["workspace"]["id"].as_str().unwrap().to_string(),
        ];
        assert!(Server::selected(&config, 8765, backend.clone(), &[]).is_err());
        assert!(Server::selected(
            &config,
            8765,
            backend.clone(),
            &[ids[0].clone(), ids[0].clone()]
        )
        .is_err());
        let server = Server::selected(&config, 8765, backend.clone(), &ids).unwrap();
        let panel = server.request("controlPanel", json!({})).unwrap();
        assert_eq!(panel["defaultWorkspaces"], json!(ids));
        assert_eq!(panel["managedWorkspaces"], true);
        assert_eq!(panel["workspaces"].as_array().unwrap().len(), 2);
        assert!(!panel.to_string().contains(&display(temp.path())));
        assert!(server
            .request("reopen", json!({"id":catalogs[2]["workspace"]["id"]}))
            .is_err());
        assert!(server
            .request(
                "getDocument",
                json!({"scope":catalogs[2]["scope"],"path":"Note.md"})
            )
            .is_err());
        assert!(server
            .request("serverOpen", json!({"name":"private","create":true}))
            .is_err());
        assert!(server
            .request("serverRemove", json!({"id":ids[0],"confirmed":true}))
            .is_err());
        let opened = server.request("reopen", json!({"id":ids[0]})).unwrap();
        assert_eq!(opened["scope"], catalogs[1]["scope"]);
        backend
            .close(catalogs[1]["scope"].as_u64().unwrap())
            .unwrap();
        assert!(server
            .request(
                "getDocument",
                json!({"scope":opened["scope"],"path":"Note.md"})
            )
            .is_ok());
        backend.release_server_workspaces();
    }
    #[test]
    fn shared_backend_keeps_host_lifetimes_and_grants_separate() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("workspaces");
        fs::create_dir_all(root.join("Shared")).unwrap();
        fs::create_dir_all(temp.path().join("Private")).unwrap();
        fs::write(root.join("Shared/Note.md"), "# Original").unwrap();
        let config = Config {
            host: "127.0.0.1".parse().unwrap(),
            port: 0,
            workspaces: root.clone(),
            data: temp.path().join("data"),
            origin: None,
            any_host: false,
        };
        let backend =
            Arc::new(Backend::new(config.data.clone(), Arc::new(AtomicBool::new(false))).unwrap());
        let local = backend.open(&display(&root.join("Shared"))).unwrap();
        let private = backend
            .open(&display(&temp.path().join("Private")))
            .unwrap();
        let server = Server::shared(&config, 8765, backend.clone()).unwrap();
        let remote = server
            .request("reopen", json!({"id":local["workspace"]["id"]}))
            .unwrap();
        assert_eq!(remote["scope"], local["scope"]);
        let panel = server.request("controlPanel", json!({})).unwrap();
        assert_eq!(panel["workspaces"].as_array().unwrap().len(), 1);
        assert!(panel["status"].is_null());
        assert!(server
            .request(
                "getDocument",
                json!({"scope":private["scope"],"path":"Note.md"})
            )
            .is_err());
        let old = server
            .request(
                "getDocument",
                json!({"scope":remote["scope"],"path":"Note.md"}),
            )
            .unwrap();
        backend.request("save", json!({"scope":local["scope"],"path":"Note.md","text":"# Desktop","hash":old["hash"]})).unwrap();
        assert!(server.request("save", json!({"scope":remote["scope"],"path":"Note.md","text":"# Stale","hash":old["hash"]})).is_err());
        backend.close(local["scope"].as_u64().unwrap()).unwrap();
        assert!(server
            .request(
                "getDocument",
                json!({"scope":remote["scope"],"path":"Note.md"})
            )
            .is_ok());
        let restored = backend.request("restore", json!({})).unwrap();
        assert_eq!(restored["workspaces"].as_array().unwrap().len(), 1);
        backend.open(&display(&root.join("Shared"))).unwrap();
        server
            .request(
                "serverRemove",
                json!({"id":local["workspace"]["id"],"confirmed":true}),
            )
            .unwrap();
        assert!(server
            .request("status", json!({"scope":remote["scope"]}))
            .is_err());
        assert!(backend
            .request(
                "getDocument",
                json!({"scope":local["scope"],"path":"Note.md"})
            )
            .is_ok());
        let mut listener = Running::start(config.clone(), backend.clone()).unwrap();
        let occupied = listener.address;
        let mut collision = config.clone();
        collision.port = occupied.port();
        assert!(Running::start(collision, backend.clone()).is_err());
        listener.stop().unwrap();
        assert!(std::net::TcpListener::bind(occupied).is_ok());
        let mut restarted = Running::start(config, backend.clone()).unwrap();
        restarted.stop().unwrap();
        assert!(backend
            .request(
                "getDocument",
                json!({"scope":local["scope"],"path":"Note.md"})
            )
            .is_ok());
    }
}
