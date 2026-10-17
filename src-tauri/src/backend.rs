//! Native application state. Requests run concurrently: each workspace has its
//! own short locks for file writes, scans, Git and rename plans, and the index
//! is read through pooled connections, so no request waits for indexing or Git.
use crate::{
    database::Database,
    index::{self, name_key},
    kanban,
    markdown::{self, Resolver},
    native_files::{self as files, err, Budget, Entry, Kind, Result},
    native_git::Git,
};
use fs2::FileExt;
use notify::{RecursiveMode, Watcher};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, RwLock,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
pub fn display(path: &Path) -> String {
    let s = path.to_string_lossy();
    s.strip_prefix(r"\\?\UNC\")
        .map(|s| format!(r"\\{s}"))
        .unwrap_or_else(|| s.strip_prefix(r"\\?\").unwrap_or(&s).to_string())
}
pub fn workspace_id(root: &str) -> String {
    format!(
        "kb-{}",
        &files::hash(if cfg!(windows) {
            root.to_lowercase()
        } else {
            root.into()
        })[..20]
    )
}
fn lock(directory: &Path) -> Result<fs::File> {
    fs::create_dir_all(directory).map_err(err)?;
    let f = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join("native.lock"))
        .map_err(err)?;
    f.try_lock_exclusive().map_err(|_| {
        "Another Weave instance is using this data folder. Close it before opening this copy."
            .to_string()
    })?;
    Ok(f)
}
/// The workspace's Git, set up for the request's host: the HTTP server marks
/// its requests (`_host`) so Git runs hardened and within permitted hosts.
fn git_for<'a>(m: &'a Mutex<Git>, args: &Value) -> std::sync::MutexGuard<'a, Git> {
    let mut git = guard(m);
    git.hardened = args["_host"]["hardened"] == true;
    git.hosts = args["_host"]["gitHosts"]
        .as_array()
        .map(|a| a.iter().filter_map(|h| h.as_str().map(String::from)).collect())
        .unwrap_or_default();
    git
}
fn guard<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}
struct Rename {
    token: String,
    from: String,
    to: String,
    manifest: Value,
    /// Every article the rename rewrites or moves, with its hash at preview.
    snapshot: BTreeMap<String, String>,
    changes: Vec<Value>,
    created: Instant,
}
/// Most workspaces a window keeps open at once. Each open workspace is watched,
/// scanned and searchable; closed ones keep their cached rows and sessions.
pub const MAX_OPEN_WORKSPACES: usize = 12;
/// Articles read and parsed per index transaction. Interactive writes wait at
/// most one batch.
const BATCH: usize = 384;
/// Catalog paths remembered for incremental catalog updates.
const LOG_CAP: usize = 20_000;
/// Watcher paths queued before a full scan is cheaper.
const MAX_PENDING: usize = 10_000;
/// A first-opened workspace this small is indexed before `open` returns.
const SMALL_WORKSPACE: usize = 2_000;
/// Restoring the window leaves out trees of workspaces with more articles.
const LARGE_TREE: usize = 20_000;
/// Distinct defaults for workspace colours; a new workspace takes a random unused one.
const WORKSPACE_COLOURS: &[&str] = &[
    "#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316",
    "#6366f1", "#84cc16", "#06b6d4", "#e11d48",
];
#[derive(Default)]
struct Pending {
    paths: BTreeSet<String>,
    rescan: bool,
}
struct ChangeLog {
    entries: VecDeque<(u64, String)>,
    /// Changes before this revision are no longer listed: older clients reload.
    floor: u64,
}
/// When a workspace's automatic snapshots are next due. The monitor checks
/// this every tick without touching Git; Git runs only when a snapshot (or a
/// lease renewal) is due, on the monitor's job threads.
pub(crate) struct SnapshotClock {
    pub(crate) settings: Value,
    /// The last content change (any new revision).
    pub(crate) changed: Instant,
    /// The revision when Git was last checked for changes; 0 before the first check.
    pub(crate) checked: u64,
    pub(crate) attempted: Instant,
    /// Set when Git was busy: try again then.
    pub(crate) retry: Option<Instant>,
    pub(crate) leased: Option<Instant>,
}
impl SnapshotClock {
    fn new(settings: Value) -> Self {
        Self {
            settings,
            changed: Instant::now(),
            checked: 0,
            attempted: Instant::now(),
            retry: None,
            leased: None,
        }
    }
    /// True when a snapshot should be attempted now.
    fn snapshot_due(&self, revision: u64) -> bool {
        let wait = Duration::from_secs(self.settings["minutes"].as_u64().unwrap_or(15) * 60);
        if self.retry.is_some() {
            return self.retry.is_some_and(|at| Instant::now() >= at);
        }
        if self.settings["trigger"] == "interval" {
            self.attempted.elapsed() >= wait
        } else {
            revision != self.checked && self.changed.elapsed() >= wait
        }
    }
    fn due(&self, revision: u64) -> bool {
        self.settings["enabled"] == true
            && (self.snapshot_due(revision)
                || self
                    .leased
                    .is_none_or(|at| at.elapsed() >= Duration::from_secs(60)))
    }
}
struct State {
    monitoring: Value,
    ready: bool,
    error: Option<String>,
    watcher: Option<notify::RecommendedWatcher>,
    last_scan: Instant,
    progress: Value,
}
/// Durations of one kind of work, in milliseconds.
#[derive(Default, Clone)]
struct Timing {
    count: u64,
    total: f64,
    max: f64,
}
impl Timing {
    fn add(&mut self, ms: f64) {
        self.count += 1;
        self.total += ms;
        self.max = self.max.max(ms);
    }
    fn json(&self) -> Value {
        json!({"count":self.count,"meanMs":if self.count > 0 { (self.total / self.count as f64 * 10.0).round() / 10.0 } else { 0.0 },"maxMs":(self.max * 10.0).round() / 10.0,"totalMs":self.total.round()})
    }
}
/// Request and indexing timings since start-up, for diagnostics and benchmarks.
#[derive(Default)]
struct Metrics {
    requests: BTreeMap<String, Timing>,
    work: BTreeMap<&'static str, Timing>,
    articles: u64,
}
fn elapsed(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}
#[derive(Default)]
struct Plan {
    entries: Vec<Entry>,
    removed: Vec<String>,
    /// Markdown paths to read, with the document hash seen when planning.
    index: Vec<(String, Option<String>)>,
}
/// One open workspace. Its scope is unique for this process and identifies it in
/// every request; reopening a closed workspace issues a new scope.
pub struct Workspace {
    pub id: String,
    pub root: PathBuf,
    pub scope: u64,
    pub sensitive: bool,
    name: String,
    revision: AtomicU64,
    state: Mutex<State>,
    /// Serializes this workspace's file mutations and index transactions.
    write: Mutex<()>,
    /// Serializes full scans.
    scanning: Mutex<()>,
    plan: Mutex<Option<Rename>>,
    git: Mutex<Git>,
    pub(crate) snapshots: Mutex<SnapshotClock>,
    pending: Arc<Mutex<Pending>>,
    log: Mutex<ChangeLog>,
    closed: AtomicBool,
    desktop_active: AtomicBool,
    server_active: AtomicBool,
}
impl Workspace {
    pub fn revision(&self) -> u64 {
        self.revision.load(Ordering::Acquire)
    }
    pub fn ready(&self) -> bool {
        guard(&self.state).ready
    }
    fn watch(&self) {
        let mut state = guard(&self.state);
        state.watcher = None;
        if state.monitoring["watchChanges"] != true {
            return;
        }
        let pending = self.pending.clone();
        let root = self.root.clone();
        // Native notifications name the changed paths; reconciliation then
        // reads only those. Overflow or lost events fall back to a full scan.
        let result = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            let mut queue = guard(&pending);
            let Ok(event) = event else {
                queue.rescan = true;
                return;
            };
            if event.need_rescan() {
                queue.rescan = true;
                return;
            }
            for path in &event.paths {
                let Ok(relative) = path.strip_prefix(&root) else {
                    continue;
                };
                let relative = relative.to_string_lossy().replace('\\', "/");
                if relative.is_empty() || files::ignored(&relative) {
                    continue;
                }
                if queue.paths.len() >= MAX_PENDING {
                    queue.rescan = true;
                } else {
                    queue.paths.insert(relative);
                }
            }
        });
        match result {
            Ok(mut w) => match w.watch(&self.root, RecursiveMode::Recursive) {
                Ok(()) => state.watcher = Some(w),
                Err(e) => {
                    state.error = Some(format!(
                        "File watcher unavailable; periodic refresh remains active: {e}"
                    ))
                }
            },
            Err(e) => {
                state.error = Some(format!(
                    "File watcher unavailable; periodic refresh remains active: {e}"
                ))
            }
        }
    }
    /// True when queued changes or a scheduled scan await reconciliation.
    fn due(&self) -> bool {
        let queued = {
            let p = guard(&self.pending);
            p.rescan || !p.paths.is_empty()
        };
        queued || {
            let state = guard(&self.state);
            state.monitoring["autoRefresh"] == true
                && state.last_scan.elapsed()
                    > Duration::from_secs(
                        state.monitoring["refreshSeconds"].as_u64().unwrap_or(300),
                    )
        }
    }
}
pub struct Backend {
    pub runtime: PathBuf,
    pub database: Database,
    pub database_file: PathBuf,
    default_runtime: PathBuf,
    /// Open workspaces in the user's display order.
    opened: RwLock<Vec<Arc<Workspace>>>,
    next_scope: AtomicU64,
    /// Scope of the most recently opened workspace, used by callers that address
    /// a single workspace without naming it (tests and legacy single-workspace hosts).
    last_opened: AtomicU64,
    /// Serializes opening, closing, restoring and layout changes.
    lifecycle: Mutex<()>,
    metrics: Mutex<Metrics>,
    _runtime_lock: fs::File,
    _database_lock: Option<fs::File>,
    pub stopping: Arc<AtomicBool>,
    /// Identifies this process in repositories' snapshot leases.
    instance: String,
    /// How background Git (automatic snapshots) runs: the standalone server
    /// sets the same hardening (`hardened`, `gitHosts`) as its requests.
    pub background_git: Mutex<Value>,
}
impl Backend {
    pub fn new(runtime: PathBuf, stopping: Arc<AtomicBool>) -> Result<Self> {
        Self::with_default(runtime.clone(), runtime, stopping)
    }
    pub fn with_default(
        runtime: PathBuf,
        default_runtime: PathBuf,
        stopping: Arc<AtomicBool>,
    ) -> Result<Self> {
        let runtime_lock = lock(&runtime)?;
        for p in ["operations"] {
            fs::create_dir_all(runtime.join(p)).map_err(err)?;
        }
        let config = read_json(&runtime.join("storage.json"))?;
        let directory = config["databaseDirectory"]
            .as_str()
            .map(PathBuf::from)
            .unwrap_or(runtime.clone());
        fs::create_dir_all(&directory).map_err(err)?;
        let database_lock = if fs::canonicalize(&directory).map_err(err)?
            != fs::canonicalize(&runtime).map_err(err)?
        {
            Some(lock(&directory)?)
        } else {
            None
        };
        let database_file = directory.join("weave.sqlite");
        let database = Database::open(&database_file)?;
        // One-time import of durable preferences; old derived indexes are left intact.
        if database.setting("legacyImported")?.is_null() {
            let sessions = read_json(&runtime.join("session.json"))?;
            let import_workspace = |root: &str,
                                    name: &str,
                                    old_id: Option<&str>,
                                    preferences: Option<&Value>|
             -> Result<String> {
                let shown = fs::canonicalize(root)
                    .map(|p| display(&p))
                    .unwrap_or_else(|_| root.to_string());
                let id = workspace_id(&shown);
                database.register(&id, &shown, name)?;
                let legacy_id = old_id
                    .map(String::from)
                    .unwrap_or_else(|| workspace_id(root));
                if let Some(session) = sessions["workspaces"]
                    .get(&legacy_id)
                    .or_else(|| sessions["workspaces"].get(&id))
                {
                    database.save_workspace_value(&id, false, session)?;
                }
                if let Some(preferences) = preferences {
                    database.set(
                        &format!("monitor:{id}"),
                        &monitoring(preferences).unwrap_or(monitoring(&json!({})).unwrap()),
                    )?;
                }
                database.set(&format!("legacyGitRoot:{id}"), &json!(root))?;
                Ok(shown)
            };
            if let Some(list) = config["collections"].as_array() {
                for w in list {
                    if let Some(root) = w["root"].as_str() {
                        import_workspace(
                            root,
                            s(w, "name"),
                            w["id"].as_str(),
                            Some(&w["indexing"]),
                        )?;
                    }
                }
            }
            if let Some(root) = sessions["lastWorkspace"].as_str() {
                let shown = import_workspace(
                    root,
                    Path::new(root)
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .as_ref(),
                    None,
                    None,
                )?;
                database.set("lastWorkspace", &json!(shown))?;
            }
            database.set("legacyImported", &json!(true))?;
        }
        Ok(Self {
            runtime,
            default_runtime,
            database,
            database_file,
            opened: RwLock::new(vec![]),
            next_scope: AtomicU64::new(0),
            last_opened: AtomicU64::new(0),
            lifecycle: Mutex::new(()),
            metrics: Mutex::new(Metrics::default()),
            _runtime_lock: runtime_lock,
            _database_lock: database_lock,
            stopping,
            instance: files::id(),
            background_git: Mutex::new(json!({})),
        })
    }
    pub fn health(&self) -> Value {
        json!({"ok":true,"runtime":display(&self.runtime),"protocol":3,"backend":"rust","pid":std::process::id(),"capabilities":{"write":true,"git":true,"storage":true,"session":true,"nativeWindow":true,"graphStream":true,"resources":true,"fts":true,"workspaces":true,"export":true,"catalogChanges":true}})
    }
    /// Open workspaces in display order.
    pub fn workspaces(&self) -> Vec<Arc<Workspace>> {
        self.opened
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }
    /// The most recently opened workspace that is still open.
    pub fn current(&self) -> Option<Arc<Workspace>> {
        let open = self.workspaces();
        let last = self.last_opened.load(Ordering::Acquire);
        open.iter()
            .find(|w| w.scope == last)
            .or(open.last())
            .cloned()
    }
    /// Scope of the most recently opened workspace, or 0 when none is open.
    pub fn scope(&self) -> u64 {
        self.current().map_or(0, |w| w.scope)
    }
    pub fn workspace_by_scope(&self, scope: u64) -> Option<Arc<Workspace>> {
        self.workspaces().into_iter().find(|w| w.scope == scope)
    }
    /// `(scope, revision)` of every open workspace.
    pub fn revisions(&self) -> Vec<(u64, u64)> {
        self.workspaces()
            .iter()
            .map(|w| (w.scope, w.revision()))
            .collect()
    }
    fn workspace(&self, scope: Option<u64>) -> Result<Arc<Workspace>> {
        let open = self.workspaces();
        if open.is_empty() {
            return Err("Open a Markdown workspace first.".into());
        }
        scope
            .and_then(|scope| open.into_iter().find(|w| w.scope == scope))
            .ok_or_else(|| "The workspace changed. Reopen this note before continuing.".into())
    }
    /// `{open:[roots in order], tabOrder:[tab ids], activeTab}` for restoring the window.
    fn layout(&self) -> Result<Value> {
        let mut layout = self.database.setting("workspaceLayout")?;
        if !layout.is_object() {
            layout = json!({});
        }
        Ok(layout)
    }
    fn save_open_roots(&self) -> Result<()> {
        let mut layout = self.layout()?;
        layout["open"] = json!(self
            .workspaces()
            .iter()
            .filter(|w| w.desktop_active.load(Ordering::Acquire))
            .map(|w| display(&w.root))
            .collect::<Vec<_>>());
        self.database.set("workspaceLayout", &layout)
    }
    /// Display name and colour. Unnamed workspaces use their root folder's name.
    fn label(&self, id: &str, folder: &str) -> Result<Value> {
        let saved = self.database.setting(&format!("workspaceLabel:{id}"))?;
        let name = saved["name"]
            .as_str()
            .filter(|n| !n.trim().is_empty())
            .unwrap_or(folder);
        Ok(
            json!({"name":name,"customName":saved["name"].as_str().filter(|n|!n.trim().is_empty()).is_some(),"color":saved["color"]}),
        )
    }
    fn unused_colour(&self, id: &str) -> Result<String> {
        let mut used = HashSet::new();
        let mut open_used = HashSet::new();
        let open = self.workspaces();
        for w in self.database.workspaces()? {
            let other = s(&w, "id");
            if other == id {
                continue;
            }
            if let Some(c) =
                self.database.setting(&format!("workspaceLabel:{other}"))?["color"].as_str()
            {
                used.insert(c.to_lowercase());
                if open.iter().any(|o| o.id == other) {
                    open_used.insert(c.to_lowercase());
                }
            }
        }
        let seed = files::hash(format!(
            "{id}{:?}{}",
            std::time::SystemTime::now(),
            std::process::id()
        ));
        let random = u64::from_str_radix(&seed[..12], 16).unwrap_or(0);
        for taken in [&used, &open_used] {
            let free: Vec<_> = WORKSPACE_COLOURS
                .iter()
                .filter(|c| !taken.contains(**c))
                .collect();
            if !free.is_empty() {
                return Ok(free[(random % free.len() as u64) as usize].to_string());
            }
        }
        // Every preset is in use: derive a mid-tone colour from a random hue.
        let hue = (random % 360) as f64;
        let (r, g, b) = hsl(hue, 0.62, 0.52);
        Ok(format!("#{r:02x}{g:02x}{b:02x}"))
    }
    /// Opens a workspace without scanning it: its tree and index come from the
    /// database and are reconciled in the background. A small workspace opened
    /// for the first time is indexed at once.
    pub fn open(&self, root: &str) -> Result<Value> {
        self.open_with(root, false)
    }
    /// Acquires server ownership independently of desktop activation.
    /// Server registration returns cached metadata immediately. The monitor
    /// performs first indexing, including for small workspaces.
    pub fn open_background(&self, root: &str) -> Result<Value> {
        self.open_options(root, false, false)
    }
    /// `full`: include the whole tree even for a large workspace. Otherwise a
    /// large tree is left out (`tree.partial`), so opening or restoring waits
    /// for no workspace's file list; the reader loads it with `catalogPage`.
    fn open_with(&self, root: &str, full: bool) -> Result<Value> {
        self.open_options(root, full, true)
    }
    fn open_options(&self, root: &str, full: bool, eager: bool) -> Result<Value> {
        let _lifecycle = guard(&self.lifecycle);
        let root = fs::canonicalize(root).map_err(err)?;
        if !root.is_dir() {
            return Err("Choose a Markdown workspace folder.".into());
        }
        let shown = display(&root);
        let id = workspace_id(&shown);
        if let Some(existing) = self.workspaces().into_iter().find(|w| w.id == id) {
            if eager {
                existing.desktop_active.store(true, Ordering::Release);
                self.last_opened.store(existing.scope, Ordering::Release);
                self.save_open_roots()?;
            } else {
                existing.server_active.store(true, Ordering::Release);
            }
            return self.catalog_of(&existing, full);
        }
        if self.workspaces().len() >= MAX_OPEN_WORKSPACES {
            return Err(format!(
                "Close a workspace first. Weave keeps up to {MAX_OPEN_WORKSPACES} workspaces open."
            ));
        }
        let name = root
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        self.database.register(&id, &shown, &name)?;
        if eager {
            self.database.set("lastWorkspace", &json!(shown))?;
        }
        let label_key = format!("workspaceLabel:{id}");
        let mut label = self.database.setting(&label_key)?;
        if !label["color"].is_string() {
            if !label.is_object() {
                label = json!({});
            }
            label["color"] = json!(self.unused_colour(&id)?);
            self.database.set(&label_key, &label)?;
        }
        let monitoring = monitoring(&self.database.setting(&format!("monitor:{}", id))?)?;
        let mut git_state = self.database.workspace_value(&id, true)?;
        if git_state.as_object().is_some_and(|m| m.is_empty()) {
            let old_root = self.database.setting(&format!("legacyGitRoot:{id}"))?;
            let key = &files::hash(old_root.as_str().unwrap_or(&shown))[..24];
            let file = self.runtime.join("git").join(format!("{key}.json"));
            if file.exists() || file.with_extension("json.remotes").exists() {
                git_state = json!({"pulls":read_json(&file)?,"preferences":read_json(&file.with_extension("json.remotes"))?});
                self.database.save_workspace_value(&id, true, &git_state)?;
            }
        }
        let known = self.database.has_entries(&id)?;
        let scope = self.next_scope.fetch_add(1, Ordering::AcqRel) + 1;
        let git = Git::new(&root, git_state, self.stopping.clone())
            .with_keys(self.runtime.join("git-keys"), &id);
        let workspace = Arc::new(Workspace {
            snapshots: Mutex::new(SnapshotClock::new(git.snapshots.clone())),
            git: Mutex::new(git),
            sensitive: detect_case(&root),
            id,
            name,
            root,
            scope,
            revision: AtomicU64::new(1),
            state: Mutex::new(State {
                monitoring,
                ready: false,
                error: None,
                watcher: None,
                last_scan: Instant::now(),
                progress: Value::Null,
            }),
            write: Mutex::new(()),
            scanning: Mutex::new(()),
            plan: Mutex::new(None),
            pending: Arc::new(Mutex::new(Pending {
                paths: BTreeSet::new(),
                rescan: true,
            })),
            log: Mutex::new(ChangeLog {
                entries: VecDeque::new(),
                floor: 0,
            }),
            closed: AtomicBool::new(false),
            desktop_active: AtomicBool::new(eager),
            server_active: AtomicBool::new(!eager),
        });
        workspace.watch();
        self.last_opened.store(scope, Ordering::Release);
        self.opened
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .push(workspace.clone());
        if eager {
            self.save_open_roots()?;
        }
        if !known && eager {
            let mut budget = Budget {
                cap: SMALL_WORKSPACE,
                ..Budget::default()
            };
            if files::walk(&workspace.root, "", &mut budget).is_ok() && !budget.capped {
                if let Err(e) = self.reconcile_full(&workspace, false) {
                    guard(&workspace.state).error = Some(e);
                }
            }
        }
        self.catalog_of(&workspace, full)
    }
    /// Deactivates desktop ownership; keeps watching while HTTP still uses it.
    pub fn close(&self, scope: u64) -> Result<Value> {
        self.release_workspace(scope, false)
    }
    /// Delivery hosts hold workspaces independently, including their watcher.
    pub fn close_server(&self, scope: u64) -> Result<Value> {
        self.release_workspace(scope, true)
    }
    fn release_workspace(&self, scope: u64, server: bool) -> Result<Value> {
        let _lifecycle = guard(&self.lifecycle);
        let w = self.workspace(Some(scope))?;
        if server {
            w.server_active.store(false, Ordering::Release);
        } else {
            w.desktop_active.store(false, Ordering::Release);
        }
        if !w.server_active.load(Ordering::Acquire) && !w.desktop_active.load(Ordering::Acquire) {
            self.opened
                .write()
                .unwrap_or_else(|p| p.into_inner())
                .retain(|o| o.scope != scope);
            w.closed.store(true, Ordering::Release);
            guard(&w.state).watcher = None;
        }
        if !server {
            self.save_open_roots()?;
        }
        Ok(json!({"closed":true}))
    }
    pub fn release_server_workspaces(&self) {
        for w in self.workspaces() {
            if w.server_active.load(Ordering::Acquire) {
                let _ = self.close_server(w.scope);
            }
        }
    }
    /// Reconciles every open workspace that has queued or scheduled work, in
    /// turn. Returns the scopes whose content changed and any errors.
    pub fn poll_all(&self) -> Vec<(u64, Result<bool>)> {
        self.workspaces()
            .iter()
            .filter(|w| w.due())
            .map(|w| (w.scope, self.poll_workspace(w)))
            .collect()
    }
    /// True when any open workspace changed. Errors from any workspace are returned.
    pub fn poll(&self) -> Result<bool> {
        let mut changed = false;
        for (_, result) in self.poll_all() {
            changed |= result?;
        }
        Ok(changed)
    }
    /// Applies a workspace's watcher notifications, or a full scan when one is
    /// due (start-up, lost notifications or the periodic safety scan).
    pub fn poll_workspace(&self, w: &Workspace) -> Result<bool> {
        let (scheduled, content) = {
            let state = guard(&w.state);
            let due = state.monitoring["autoRefresh"] == true
                && state.last_scan.elapsed()
                    > Duration::from_secs(
                        state.monitoring["refreshSeconds"].as_u64().unwrap_or(300),
                    );
            (due, due && state.monitoring["scanMode"] == "content")
        };
        let (paths, rescan) = {
            let mut p = guard(&w.pending);
            (std::mem::take(&mut p.paths), std::mem::take(&mut p.rescan))
        };
        let result = if rescan || scheduled {
            self.reconcile_full(w, content)
        } else if !paths.is_empty() {
            self.reconcile_paths(w, paths)
        } else {
            Ok(false)
        };
        if let Err(e) = &result {
            let mut state = guard(&w.state);
            state.error = Some(e.clone());
            // A failed scan waits for the next change or scheduled scan.
            state.last_scan = Instant::now();
        }
        result
    }
    /// Reconciles the most recently opened workspace with a full scan.
    pub fn reconcile(&self, force: bool) -> Result<bool> {
        let w = self.current().ok_or("Open a Markdown workspace first.")?;
        self.reconcile_full(&w, force)
    }
    /// Applies queued watcher notifications now (before planning a rename).
    fn drain(&self, w: &Workspace) -> Result<()> {
        let (paths, rescan) = {
            let mut p = guard(&w.pending);
            (std::mem::take(&mut p.paths), std::mem::take(&mut p.rescan))
        };
        if rescan || !w.ready() {
            self.reconcile_full(w, false)?;
        } else if !paths.is_empty() {
            self.reconcile_paths(w, paths)?;
        }
        Ok(())
    }
    /// Records a committed change: a new revision and the catalog paths it touched.
    fn record(&self, w: &Workspace, touched: Vec<String>) {
        guard(&w.snapshots).changed = Instant::now();
        let mut log = guard(&w.log);
        let revision = w.revision.fetch_add(1, Ordering::AcqRel) + 1;
        if touched.len() > LOG_CAP {
            log.entries.clear();
            log.floor = revision;
            return;
        }
        for path in touched {
            log.entries.push_back((revision, path));
        }
        while log.entries.len() > LOG_CAP {
            if let Some((r, _)) = log.entries.pop_front() {
                log.floor = log.floor.max(r);
            }
        }
    }
    /// A full scan: walks the tree, compares it with the index in path order
    /// and reindexes only new or changed articles (every article when `force`).
    pub fn reconcile_full(&self, w: &Workspace, force: bool) -> Result<bool> {
        let _scan = guard(&w.scanning);
        {
            // Notifications so far are covered by this walk.
            let mut p = guard(&w.pending);
            p.paths.clear();
            p.rescan = false;
        }
        let started = Instant::now();
        let walked = files::walk(&w.root, "", &mut Budget::default())?;
        self.timed("scan.walk", started);
        let started = Instant::now();
        // The walk and the stored tree are merged in path order; walked entries
        // move into the plan rather than being copied.
        let mut plan = Plan::default();
        let mut walk = walked.into_iter().peekable();
        let fresh = |plan: &mut Plan, e: Entry| {
            if e.kind == Kind::Markdown {
                plan.index.push((e.path.clone(), None));
            }
            plan.entries.push(e);
        };
        self.database
            .each_entry(&w.id, |path, kind, mtime, size, hash| {
                while walk.peek().is_some_and(|e| e.path.as_str() < path) {
                    fresh(&mut plan, walk.next().unwrap());
                }
                if walk.peek().is_some_and(|e| e.path == path) {
                    let e = walk.next().unwrap();
                    let same = e.kind == kind && e.mtime == mtime && e.size == size;
                    if e.kind == Kind::Markdown && (force || !same || hash.is_none()) {
                        plan.index.push((e.path.clone(), hash.map(String::from)));
                    }
                    if !same {
                        plan.entries.push(e);
                    }
                } else {
                    plan.removed.push(path.to_string());
                }
            })?;
        for e in walk {
            fresh(&mut plan, e);
        }
        self.timed("scan.compare", started);
        // Each batch resolves its links against just the articles sharing their
        // filenames (read from the tree), so no whole-workspace resolver is held.
        let started = Instant::now();
        let (changed, warnings) = self.apply(w, plan, None)?;
        self.timed("scan.apply", started);
        let mut state = guard(&w.state);
        state.ready = true;
        state.last_scan = Instant::now();
        state.error = (!warnings.is_empty()).then(|| warnings.join("\n"));
        Ok(changed)
    }
    /// Reconciles only the paths a watcher reported: changed files are read
    /// again, removed files and folders leave the index and new folders are walked.
    fn reconcile_paths(&self, w: &Workspace, paths: BTreeSet<String>) -> Result<bool> {
        let mut plan = Plan::default();
        let mut walked: Vec<String> = vec![];
        let mut planned: HashSet<String> = HashSet::new();
        for p in paths {
            if files::relative(&p).is_err()
                || walked.iter().any(|d| p.starts_with(&format!("{d}/")))
            {
                continue;
            }
            if !present(&w.root, &p) {
                plan.removed.push(p);
                continue;
            }
            let known = self.database.entry(&w.id, &p)?;
            match fs::symlink_metadata(w.root.join(&p)) {
                Ok(m) if files::linked(&m) => plan.removed.push(p),
                Ok(m) if m.is_dir() => {
                    if known.is_none() {
                        for e in std::iter::once(Entry {
                            path: p.clone(),
                            kind: Kind::Folder,
                            mtime: 0.0,
                            size: 0,
                        })
                        .chain(files::walk(
                            &w.root,
                            &p,
                            &mut Budget::default(),
                        )?) {
                            if e.kind == Kind::Markdown {
                                let hash = self.database.entry(&w.id, &e.path)?.and_then(|k| k.3);
                                plan.index.push((e.path.clone(), hash));
                            }
                            planned.insert(e.path.clone());
                            plan.entries.push(e);
                        }
                        self.ancestors(w, &p, &mut plan, &mut planned)?;
                        walked.push(p);
                    }
                }
                Ok(m) if m.is_file() => {
                    let kind = if files::is_markdown(&p) {
                        Kind::Markdown
                    } else {
                        Kind::Other
                    };
                    let e = Entry {
                        path: p.clone(),
                        kind,
                        mtime: files::mtime(&m),
                        size: m.len(),
                    };
                    match known {
                        None => {
                            if kind == Kind::Markdown {
                                plan.index.push((p.clone(), None));
                            }
                            planned.insert(p.clone());
                            plan.entries.push(e);
                            self.ancestors(w, &p, &mut plan, &mut planned)?;
                        }
                        Some((old, mtime, size, hash)) => {
                            let same = old == kind && mtime == e.mtime && size == e.size;
                            if kind == Kind::Markdown && (!same || hash.is_none()) {
                                plan.index.push((p.clone(), hash));
                            }
                            if !same {
                                plan.entries.push(e);
                            }
                        }
                    }
                }
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => plan.removed.push(p),
                Err(_) => {}
            }
        }
        let (changed, warnings) = self.apply(w, plan, None)?;
        if !warnings.is_empty() {
            guard(&w.state).error = Some(warnings.join("\n"));
        }
        Ok(changed)
    }
    /// Adds folder entries for the missing ancestors of a new path.
    fn ancestors(
        &self,
        w: &Workspace,
        path: &str,
        plan: &mut Plan,
        planned: &mut HashSet<String>,
    ) -> Result<()> {
        let mut parent = path;
        while let Some((up, _)) = parent.rsplit_once('/') {
            if planned.contains(up) || self.database.entry(&w.id, up)?.is_some() {
                break;
            }
            planned.insert(up.to_string());
            plan.entries.push(Entry {
                path: up.to_string(),
                kind: Kind::Folder,
                mtime: 0.0,
                size: 0,
            });
            parent = up;
        }
        Ok(())
    }
    /// Applies a plan in short transactions: the tree first, then articles in
    /// batches, then links whose targets appeared or disappeared. One thread
    /// parses the next batch while this one writes the last, through a
    /// one-batch channel, so memory stays bounded. Each write checks the index
    /// still holds what was planned, so a concurrent save is never overwritten
    /// by an older read. A changed article's tree row is written with its
    /// rows, so an interrupted run never leaves a current row for stale text.
    fn apply(
        &self,
        w: &Workspace,
        plan: Plan,
        full: Option<&Resolver>,
    ) -> Result<(bool, Vec<String>)> {
        let mut changed = false;
        let mut warnings = vec![];
        let mut gone: Vec<String> = vec![];
        let Plan {
            entries,
            removed,
            index,
        } = plan;
        let changing: HashSet<&str> = index
            .iter()
            .filter(|(_, hash)| hash.is_some())
            .map(|(p, _)| p.as_str())
            .collect();
        let (deferred, entries): (Vec<Entry>, Vec<Entry>) = entries
            .into_iter()
            .partition(|e| e.kind == Kind::Markdown && changing.contains(e.path.as_str()));
        let deferred: HashMap<String, Entry> =
            deferred.into_iter().map(|e| (e.path.clone(), e)).collect();
        // Removals first, so a path whose case changed is replaced, not duplicated.
        let steps = removed
            .chunks(5000)
            .map(|r| (r, &[][..]))
            .chain(entries.chunks(5000).map(|e| (&[][..], e)));
        for (removed, entries) in steps {
            let _write = guard(&w.write);
            let (_, touched) = self.database.write(&w.id, |tx| {
                for p in removed {
                    // Removed only if it is still absent: Weave may have recreated it.
                    if !present(&w.root, p) {
                        gone.extend(tx.remove_entry(p)?);
                    }
                }
                for e in entries {
                    if e.kind != Kind::Markdown && tx.delete_document(&e.path)? {
                        gone.push(e.path.clone());
                    }
                    tx.put_entry(e)?;
                }
                Ok(())
            })?;
            if !touched.is_empty() {
                self.record(w, touched);
                changed = true;
            }
        }
        let mut reindexed: HashSet<String> = HashSet::new();
        let total = index.len();
        let batches: Vec<&[(String, Option<String>)]> = index.chunks(BATCH).collect();
        let stop = || self.stopping.load(Ordering::Relaxed) || w.closed.load(Ordering::Acquire);
        std::thread::scope(|scope| -> Result<()> {
            let (send, receive) =
                std::sync::mpsc::sync_channel::<(usize, Vec<(String, Result<index::Prepared>)>)>(1);
            let batches = &batches;
            let producer = scope.spawn(move || -> Result<()> {
                for (n, batch) in batches.iter().enumerate() {
                    if stop() {
                        break;
                    }
                    let started = Instant::now();
                    let mut prepared = index::prepare_all(&w.root, &w.id, &w.name, batch, full);
                    if full.is_none() {
                        let keys: HashSet<String> = prepared
                            .iter()
                            .filter_map(|(_, r)| r.as_ref().ok())
                            .flat_map(|p| p.links.iter().map(|l| name_key(&l.target)))
                            .collect();
                        let resolver = self.database.resolver(&w.id, &keys, w.sensitive)?;
                        for (_, r) in &mut prepared {
                            if let Ok(p) = r {
                                index::resolve(p, &resolver);
                            }
                        }
                    }
                    self.timed("index.prepare", started);
                    if send.send((n, prepared)).is_err() {
                        break;
                    }
                }
                Ok(())
            });
            for (n, prepared) in receive.iter() {
                if stop() {
                    return Err("Workspace is closing.".into());
                }
                if total > BATCH {
                    guard(&w.state).progress = json!({"indexed":n * BATCH,"total":total});
                }
                let waited = Instant::now();
                let _write = guard(&w.write);
                self.timed("index.lockWait", waited);
                let started = Instant::now();
                let planned: HashMap<&str, &Option<String>> = batches[n]
                    .iter()
                    .map(|(p, hash)| (p.as_str(), hash))
                    .collect();
                let (_, touched) = self.database.write(&w.id, |tx| {
                    for (path, result) in &prepared {
                        let Some(&expected) = planned.get(path.as_str()) else {
                            continue;
                        };
                        let current = tx.hash(path)?;
                        if current != *expected {
                            continue;
                        }
                        if let Some(e) = deferred.get(path) {
                            tx.put_entry(e)?;
                        }
                        match result {
                            Ok(p) if current.as_deref() == Some(p.hash.as_str()) => {
                                tx.touch_document(path, p.mtime)?
                            }
                            Ok(p) => {
                                tx.put_document(p, w.sensitive, current.is_some())?;
                                reindexed.insert(path.clone());
                            }
                            Err(e) => {
                                warnings.push(format!("{path}: {e}"));
                                if current.is_some() {
                                    tx.delete_document(path)?;
                                }
                            }
                        }
                    }
                    Ok(())
                })?;
                self.timed("index.write", started);
                guard(&self.metrics).articles += prepared.len() as u64;
                if !touched.is_empty() {
                    self.record(w, touched);
                    changed = true;
                }
            }
            producer
                .join()
                .map_err(|_| "Indexing stopped unexpectedly.".to_string())?
        })
        .inspect_err(|_| guard(&w.state).progress = Value::Null)?;
        guard(&w.state).progress = Value::Null;
        // Articles that appeared (planned without a stored hash) or disappeared
        // change how links with their filenames resolve. Nothing needs it when
        // every article was just indexed with the final tree.
        let started = Instant::now();
        let documents = self.database.counts(&w.id)?["documents"]
            .as_u64()
            .unwrap_or(0) as usize;
        let keys: HashSet<String> = if reindexed.len() < documents {
            index
                .iter()
                .filter(|(_, hash)| hash.is_none())
                .map(|(p, _)| name_key(p))
                .chain(gone.iter().map(|p| name_key(p)))
                .collect()
        } else {
            HashSet::new()
        };
        if !keys.is_empty() {
            {
                let _write = guard(&w.write);
                if self.reresolve(w, &keys, &reindexed, full)? > 0 {
                    self.record(w, vec![]);
                    changed = true;
                }
                self.timed("index.reresolve", started);
            }
        }
        Ok((changed, warnings))
    }
    /// Resolves again the links whose filenames are `keys`, skipping `skip`
    /// sources. Callers hold the workspace's write lock.
    fn reresolve(
        &self,
        w: &Workspace,
        keys: &HashSet<String>,
        skip: &HashSet<String>,
        full: Option<&Resolver>,
    ) -> Result<usize> {
        if keys.len() > 20_000 {
            let built;
            let resolver = match full {
                Some(r) => r,
                None => {
                    built = Resolver::new(
                        self.database.markdown_paths(&w.id)?.into_iter(),
                        w.sensitive,
                    );
                    &built
                }
            };
            return Ok(self
                .database
                .write(&w.id, |tx| tx.reresolve_all(skip, resolver))?
                .0);
        }
        let resolver = self.database.resolver(&w.id, keys, w.sensitive)?;
        Ok(self
            .database
            .write(&w.id, |tx| tx.reresolve(keys, skip, &resolver))?
            .0)
    }
    /// Indexes an article Weave just wrote. Callers hold the workspace's write lock.
    fn index_written(&self, w: &Workspace, path: &str, doc: &Value, created: bool) -> Result<()> {
        let mut p = index::prepare(&w.id, &w.name, path, doc);
        let keys: HashSet<String> = p.links.iter().map(|l| name_key(&l.target)).collect();
        let resolver = self.database.resolver(&w.id, &keys, w.sensitive)?;
        index::resolve(&mut p, &resolver);
        let entry = Entry {
            path: path.to_string(),
            kind: Kind::Markdown,
            mtime: p.mtime,
            size: p.size,
        };
        let (_, touched) = self.database.write(&w.id, |tx| {
            tx.put_entry(&entry)?;
            let existed = tx.hash(&p.path)?.is_some();
            tx.put_document(&p, w.sensitive, existed)
        })?;
        if created {
            let started = Instant::now();
            self.reresolve(
                w,
                &HashSet::from([name_key(path)]),
                &HashSet::from([path.to_string()]),
                None,
            )?;
            self.timed("links.reresolve", started);
        }
        self.record(w, touched);
        Ok(())
    }
    fn ensure_ready(&self, w: &Workspace) -> Result<()> {
        if !w.ready() {
            self.reconcile_full(w, false)?;
        }
        Ok(())
    }
    /// Status of the most recently opened workspace.
    pub fn status(&self) -> Result<Value> {
        self.status_of(self.scope())
    }
    pub fn status_of(&self, scope: u64) -> Result<Value> {
        self.status_at(&*self.workspace(Some(scope))?)
    }
    fn status_at(&self, w: &Workspace) -> Result<Value> {
        let revision = w.revision();
        let mut status = self.database.counts(&w.id)?;
        let state = guard(&w.state);
        let map = status.as_object_mut().unwrap();
        map.insert("root".into(), json!(display(&w.root)));
        map.insert("runtime".into(), json!(display(&self.runtime)));
        map.insert("revision".into(), json!(revision));
        map.insert("scope".into(), json!(w.scope));
        map.insert("monitoring".into(), state.monitoring.clone());
        map.insert(
            "graph".into(),
            json!(if state.ready { "ready" } else { "reconciling" }),
        );
        map.insert(
            "search".into(),
            json!(if state.ready { "ready" } else { "indexing" }),
        );
        map.insert("progress".into(), state.progress.clone());
        map.insert("collection".into(), json!(w.id));
        map.insert("database".into(), json!(display(&self.database_file)));
        map.insert("lastError".into(), json!(state.error));
        Ok(status)
    }
    fn catalog_of(&self, w: &Workspace, full: bool) -> Result<Value> {
        // The revision is read first: a client may see newer rows, never miss them.
        let revision = w.revision();
        let large = self.database.counts(&w.id)?["documents"]
            .as_u64()
            .unwrap_or(0)
            > LARGE_TREE as u64;
        let tree = if full || !large {
            self.database.tree(&w.id)?
        } else {
            json!({"files":[],"otherFiles":[],"folders":[],"warnings":[],"partial":true})
        };
        let label = self.label(&w.id, &w.name)?;
        Ok(
            json!({"workspace":{"id":w.id,"name":w.name,"label":label["name"],"customName":label["customName"],"color":label["color"],"displayPath":display(&w.root),"directory":resource(&w.id,"","directory")},"root":display(&w.root),"caseSensitive":w.sensitive,"tree":tree,"revision":revision,"scope":w.scope,"status":self.status_at(w)?,"session":self.database.workspace_value(&w.id,false)?}),
        )
    }
    /// Catalog rows changed since `since`, or `reset` when the client must reload.
    fn catalog_changes(&self, w: &Workspace, since: Option<u64>) -> Result<Value> {
        let (revision, paths) = {
            let log = guard(&w.log);
            let revision = w.revision();
            match since {
                Some(since) if since >= log.floor && since <= revision => {
                    let paths: BTreeSet<String> = log
                        .entries
                        .iter()
                        .filter(|(r, _)| *r > since)
                        .map(|(_, p)| p.clone())
                        .collect();
                    (revision, Some(paths))
                }
                _ => (revision, None),
            }
        };
        let Some(paths) = paths else {
            return Ok(
                json!({"revision":revision,"scope":w.scope,"reset":true,"status":self.status_at(w)?}),
            );
        };
        let mut changes = self
            .database
            .tree_changes(&w.id, &paths.into_iter().collect::<Vec<_>>())?;
        changes["revision"] = json!(revision);
        changes["scope"] = json!(w.scope);
        changes["reset"] = json!(false);
        changes["status"] = self.status_at(w)?;
        Ok(changes)
    }
    pub fn graph_of(&self, scope: u64) -> Result<Value> {
        self.graph_at(&*self.workspace(Some(scope))?, false)
    }
    fn graph_at(&self, w: &Workspace, summary: bool) -> Result<Value> {
        let revision = w.revision();
        // The desktop streams neighbourhoods; it needs only the revision here.
        let mut v = if summary {
            json!({"entities":[],"relationships":[],"summary":true})
        } else {
            self.database.snapshot(&w.id)?
        };
        v["revision"] = json!(revision);
        v["scope"] = json!(w.scope);
        Ok(v)
    }
    /// Streams a graph neighbourhood by depth, read from one index snapshot.
    pub fn graph_stream(
        &self,
        args: &Value,
        send: impl FnMut(Value) -> Result<()>,
    ) -> Result<Value> {
        let scope = args["scope"].as_u64().unwrap_or(0);
        let w = self
            .workspace_by_scope(scope)
            .ok_or("The workspace changed.")?;
        let revision = w.revision();
        self.database.read(|db| {
            db.execute_batch("BEGIN").map_err(err)?;
            let result = crate::graph::stream(
                &mut crate::graph::Index::new(db, &w.id),
                scope,
                revision,
                args,
                send,
            );
            let _ = db.execute_batch("COMMIT");
            result
        })
    }
    /// A document with metadata, resolved links and diagnostics. `doc` is a
    /// `native_files::read` result.
    fn document_json(&self, w: &Workspace, p: &str, mut doc: Value) -> Result<Value> {
        let text = s(&doc, "text").to_string();
        let meta = markdown::metadata(&text, p, &w.name);
        doc.as_object_mut()
            .unwrap()
            .extend(meta.as_object().unwrap().clone());
        let links = markdown::links(&text);
        let keys: HashSet<String> = links.iter().map(|l| name_key(&l.target)).collect();
        let resolver = self.database.resolver(&w.id, &keys, w.sensitive)?;
        doc["links"] = json!(markdown::links_json(&links, &text, p)
            .into_iter()
            .zip(&links)
            .map(|(mut v, l)| {
                v.as_object_mut()
                    .unwrap()
                    .extend(resolver.resolve(&l.target, p).as_object().unwrap().clone());
                v
            })
            .collect::<Vec<_>>());
        doc["diagnostics"] = json!(markdown::diagnostics(&text, p));
        doc["resource"] = resource(&w.id, p, "file");
        Ok(doc)
    }
    fn document(&self, w: &Workspace, p: &str) -> Result<Value> {
        let doc = files::read(&w.root, p)?;
        self.document_json(w, p, doc)
    }
    fn decode(&self, w: &Workspace, op: &str, mut args: Value) -> Result<Value> {
        let workspace = &w.id;
        for (key, dest) in [
            ("resource", "path"),
            ("source", "from"),
            ("destination", "to"),
        ] {
            if key != "resource" && op != "renamePreview" {
                continue;
            }
            if let Some(r) = args.get(key) {
                if s(r, "workspaceId") != workspace {
                    return Err("The resource belongs to a different workspace.".into());
                }
                let kind = s(r, "kind");
                let expected = if op == "create" {
                    if args["folder"] == true {
                        "directory"
                    } else {
                        "file"
                    }
                } else if [
                    "getDocument",
                    "kanbanBoard",
                    "save",
                    "getOutgoingRelationships",
                    "getIncomingRelationships",
                    "getNeighbors",
                ]
                .contains(&op)
                {
                    "file"
                } else {
                    ""
                };
                if !["file", "directory", "entry"].contains(&kind)
                    || (!expected.is_empty() && kind != expected)
                {
                    return Err("Wrong workspace resource kind.".into());
                }
                let logical = s(r, "logicalPath");
                if !logical.starts_with('/') || logical.contains('\\') {
                    return Err("Invalid logical workspace path.".into());
                }
                let path = files::relative(&logical[1..])
                    .map_err(|_| "Invalid logical workspace path.".to_string())?;
                args[dest] = json!(path);
            }
        }
        Ok(args)
    }
    fn restore(&self) -> Result<Value> {
        let layout = self.layout()?;
        let mut roots: Vec<String> = layout["open"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|r| r.as_str().map(String::from))
            .collect();
        if !layout["open"].is_array() {
            if let Some(root) = self.database.setting("lastWorkspace")?.as_str() {
                roots.push(root.into());
            }
        }
        let mut errors = vec![];
        let mut catalogs = vec![];
        for root in &roots {
            match self.open_with(root, false) {
                Ok(catalog) => catalogs.push(catalog),
                Err(e) => errors.push(format!("Could not reopen {root}: {e}")),
            }
        }
        // Keep failed folders listed so they can reopen once they are available again.
        if roots.len() > catalogs.len() && !errors.is_empty() {
            let mut kept = layout.clone();
            kept["open"] = json!(roots);
            self.database.set("workspaceLayout", &kept)?;
        }
        let open: Vec<_> = self
            .workspaces()
            .into_iter()
            .filter(|w| w.desktop_active.load(Ordering::Acquire))
            .collect();
        if open.is_empty() {
            return Ok(if errors.is_empty() {
                Value::Null
            } else {
                json!({"restoreError":errors.join("\n")})
            });
        }
        let catalogs = open
            .iter()
            .map(|w| {
                catalogs
                    .iter()
                    .find(|c| c["scope"] == w.scope)
                    .cloned()
                    .map(Ok)
                    .unwrap_or_else(|| self.catalog_of(w, false))
            })
            .collect::<Result<Vec<_>>>()?;
        self.last_opened.store(open[0].scope, Ordering::Release);
        let mut first = catalogs[0].clone();
        // The first workspace's tree is in `workspaces`; it is not sent twice.
        first.as_object_mut().unwrap().remove("tree");
        first["workspaces"] = json!(catalogs);
        first["layout"] = json!({"tabOrder":layout["tabOrder"],"activeTab":layout["activeTab"],"tabs":layout["tabs"],"rightActiveTab":layout["rightActiveTab"],"focus":layout["focus"]});
        first["restoreErrors"] = json!(errors);
        Ok(first)
    }
    /// Saves the window's workspace order, tab order, the split view's sides and active tabs.
    fn save_layout(&self, args: &Value) -> Result<Value> {
        let _lifecycle = guard(&self.lifecycle);
        if let Some(order) = args["order"].as_array() {
            let ids: Vec<&str> = order.iter().filter_map(Value::as_str).collect();
            self.opened
                .write()
                .unwrap_or_else(|p| p.into_inner())
                .sort_by_key(|w| ids.iter().position(|id| *id == w.id).unwrap_or(usize::MAX));
        }
        let mut layout = self.layout()?;
        let valid = |id: &str| {
            !id.is_empty()
                && id.len() <= 80
                && id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        };
        if let Some(tabs) = args["tabOrder"].as_array() {
            let tabs: Vec<&str> = tabs
                .iter()
                .take(MAX_OPEN_WORKSPACES * 100)
                .filter_map(Value::as_str)
                .collect();
            if tabs.iter().any(|t| !valid(t)) {
                return Err("Invalid tab identity.".into());
            }
            layout["tabOrder"] = json!(tabs);
        }
        // Window-wide tabs: each history entry names its workspace, so one tab can
        // move between workspaces. Entries of inactive workspaces are kept.
        if let Some(list) = args["tabs"].as_array() {
            let mut saved = vec![];
            for tab in list.iter().take(MAX_OPEN_WORKSPACES * 100) {
                let id = s(tab, "id");
                if !valid(id) {
                    return Err("Invalid tab identity.".into());
                }
                let mut history = vec![];
                for entry in tab["history"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .rev()
                    .take(200)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                {
                    let workspace = s(entry, "workspace");
                    let path = files::relative(s(entry, "path"))?;
                    if !valid(workspace) || !path.to_lowercase().ends_with(".md") {
                        return Err("Tabs must contain Markdown paths in a workspace.".into());
                    }
                    history.push(json!({"workspace":workspace,"path":path}));
                }
                let workspace = tab["workspace"].as_str().filter(|w| valid(w));
                if history.is_empty() && workspace.is_none() {
                    continue;
                }
                let last = history.len() as i64 - 1;
                // Split view: tabs of the right side are marked; the others are on the left.
                let side = (tab["side"].as_str() == Some("right")).then_some("right");
                saved.push(json!({"id":id,"history":history,"at":tab["at"].as_i64().unwrap_or(last).clamp(-1,last.max(-1)),"workspace":workspace,"side":side}));
            }
            layout["tabs"] = json!(saved);
        }
        // Each side of a split view has its own active tab.
        for key in ["activeTab", "rightActiveTab"] {
            if args.get(key).is_some() {
                layout[key] = match args[key].as_str() {
                    Some(t) if valid(t) => json!(t),
                    _ => Value::Null,
                };
            }
        }
        if let Some(focus) = args["focus"].as_str() {
            layout["focus"] = json!(if focus == "right" { "right" } else { "left" });
        }
        self.database.set("workspaceLayout", &layout)?;
        self.save_open_roots()?;
        Ok(json!({"order":self.workspaces().iter().map(|w|w.id.clone()).collect::<Vec<_>>()}))
    }
    /// Renames or recolours a workspace. An empty name restores the folder name.
    fn configure_workspace(&self, args: &Value) -> Result<Value> {
        let _lifecycle = guard(&self.lifecycle);
        let id = s(args, "id");
        let registered = self.database.workspaces()?;
        let entry = registered
            .iter()
            .find(|w| s(w, "id") == id)
            .ok_or("Unknown workspace.")?;
        let key = format!("workspaceLabel:{id}");
        let mut label = self.database.setting(&key)?;
        if !label.is_object() {
            label = json!({});
        }
        if let Some(name) = args.get("name") {
            let name = name.as_str().ok_or("Enter a workspace name.")?.trim();
            if name.chars().count() > 80 || name.chars().any(char::is_control) {
                return Err("Workspace names are limited to 80 printable characters.".into());
            }
            label["name"] = if name.is_empty() {
                Value::Null
            } else {
                json!(name)
            };
        }
        if let Some(colour) = args.get("color") {
            let colour = colour.as_str().unwrap_or("").to_lowercase();
            if colour.len() != 7
                || !colour.starts_with('#')
                || !colour[1..].chars().all(|c| c.is_ascii_hexdigit())
            {
                return Err("Choose a colour such as #3b82f6.".into());
            }
            label["color"] = json!(colour);
        }
        self.database.set(&key, &label)?;
        self.label(id, s(entry, "name"))
    }
    pub fn request(&self, op: &str, args: Value) -> Result<Value> {
        let start = Instant::now();
        let result = self.dispatch(op, args);
        guard(&self.metrics)
            .requests
            .entry(op.to_string())
            .or_default()
            .add(elapsed(start));
        result
    }
    fn timed(&self, work: &'static str, start: Instant) {
        guard(&self.metrics)
            .work
            .entry(work)
            .or_default()
            .add(elapsed(start));
    }
    /// Request latencies and background work since start-up.
    pub fn metrics(&self) -> Value {
        let m = guard(&self.metrics);
        json!({"requests":m.requests.iter().map(|(k, t)| (k.clone(), t.json())).collect::<serde_json::Map<_, _>>(),"work":m.work.iter().map(|(k, t)| (k.to_string(), t.json())).collect::<serde_json::Map<_, _>>(),"articlesIndexed":m.articles})
    }
    fn dispatch(&self, op: &str, args: Value) -> Result<Value> {
        let scope = args["scope"].as_u64();
        match op {
            "health" => return Ok(self.health()),
            "metrics" => return Ok(self.metrics()),
            "open" => return self.open(s(&args, "root")),
            "restore" => return self.restore(),
            "close" => return self.close(scope.ok_or("Choose a workspace to close.")?),
            // Reopens a folder previously granted through the picker; never an arbitrary path.
            "reopen" => {
                let root = self
                    .database
                    .workspaces()?
                    .into_iter()
                    .find(|w| s(w, "id") == s(&args, "id"))
                    .map(|w| s(&w, "root").to_string())
                    .ok_or("Unknown workspace. Open its folder again.")?;
                return self.open(&root);
            }
            "workspaceLayout" => return self.save_layout(&args),
            "configureWorkspace" => return self.configure_workspace(&args),
            "controlPanel" => return self.control(scope),
            "configureStorage" => return self.relocate(&args, scope),
            "configureDeletion" => {
                let keep = args["backups"]
                    .as_bool()
                    .ok_or("Choose whether to keep backups of deleted files.")?;
                self.database.set("deleteBackups", &json!(keep))?;
                return self.control(scope);
            }
            "shutdown" => {
                let _lifecycle = guard(&self.lifecycle);
                for w in self
                    .opened
                    .write()
                    .unwrap_or_else(|p| p.into_inner())
                    .drain(..)
                {
                    w.closed.store(true, Ordering::Release);
                    guard(&w.state).watcher = None;
                }
                self.database.checkpoint()?;
                return Ok(json!({"closed":true}));
            }
            _ => (),
        }
        let w = self.workspace(scope)?;
        let w = &*w;
        let root = w.root.clone();
        let args = self.decode(w, op, args)?;
        match op {
            "configureMonitoring" => {
                let mut next = guard(&w.state).monitoring.clone();
                for (k, v) in args.as_object().ok_or("Expected monitoring settings")? {
                    if k == "scope" {
                        continue;
                    }
                    if !["watchChanges", "autoRefresh", "refreshSeconds", "scanMode"]
                        .contains(&k.as_str())
                    {
                        return Err("Unknown workspace monitoring setting.".into());
                    }
                    next[k] = v.clone();
                }
                let next = monitoring(&next)?;
                self.database.set(&format!("monitor:{}", w.id), &next)?;
                let resumed = {
                    let mut state = guard(&w.state);
                    let resumed =
                        state.monitoring["watchChanges"] != true && next["watchChanges"] == true;
                    state.monitoring = next;
                    state.error = None;
                    resumed
                };
                w.watch();
                if resumed {
                    // A background scan picks up what changed while not watching.
                    guard(&w.pending).rescan = true;
                }
                self.catalog_of(w, true)
            }
            "workspaceSession" => {
                let session = validate_session(&args)?;
                self.database.save_workspace_value(&w.id, false, &session)?;
                Ok(session)
            }
            "catalog" => self.catalog_of(w, true),
            "catalogChanges" => self.catalog_changes(w, args["since"].as_u64()),
            "catalogPage" => {
                // The revision is read first: later pages may be newer, never older.
                let revision = w.revision();
                let (tree, next) = self.database.tree_page(
                    &w.id,
                    s(&args, "after"),
                    args["limit"].as_u64().unwrap_or(20_000).clamp(1, 50_000) as usize,
                )?;
                Ok(json!({"revision":revision,"scope":w.scope,"tree":tree,"next":next}))
            }
            "status" => self.status_at(w),
            "graph" => self.graph_at(w, args["summaryOnly"] == true),
            "getDocument" => self.document(w, s(&args, "path")),
            "refresh" => {
                self.reconcile_full(w, true)?;
                self.database.recount(&w.id)?;
                self.catalog_of(w, false)
            }
            "save" => {
                if !args["text"].is_string() || !args["hash"].is_string() {
                    return Err("A document and its current hash are required.".into());
                }
                let p = files::relative(s(&args, "path"))?;
                let doc = {
                    let _write = guard(&w.write);
                    let started = Instant::now();
                    let doc = files::write(&root, &p, s(&args, "text"), args["hash"].as_str())?;
                    self.timed("save.file", started);
                    let started = Instant::now();
                    self.index_written(w, &p, &doc, false)?;
                    self.timed("save.index", started);
                    doc
                };
                let started = Instant::now();
                let doc = self.document_json(w, &p, doc);
                self.timed("save.response", started);
                doc
            }
            "create" => {
                let p = files::relative(s(&args, "path"))?;
                let _write = guard(&w.write);
                if args["folder"] == true {
                    fs::create_dir(files::checked(&root, &p, true)?).map_err(err)?;
                    let entry = Entry {
                        path: p.clone(),
                        kind: Kind::Folder,
                        mtime: 0.0,
                        size: 0,
                    };
                    let (_, touched) = self.database.write(&w.id, |tx| tx.put_entry(&entry))?;
                    self.record(w, touched);
                } else {
                    let heading = p
                        .rsplit('/')
                        .next()
                        .unwrap()
                        .trim_end_matches(".md")
                        .chars()
                        .map(|c| {
                            if "\\`*_[]<>".contains(c) {
                                format!("\\{c}")
                            } else {
                                c.to_string()
                            }
                        })
                        .collect::<String>();
                    let text = args["text"]
                        .as_str()
                        .map(String::from)
                        .unwrap_or(format!("# {heading}\n\n"));
                    let started = Instant::now();
                    let doc = files::write(&root, &p, &text, None)?;
                    self.timed("create.file", started);
                    let started = Instant::now();
                    self.index_written(w, &p, &doc, true)?;
                    self.timed("create.index", started);
                }
                Ok(json!({"path":p}))
            }
            // Pastes a copy of a file or folder at a new path in the same workspace.
            // The copy is made without the write lock (its path is new) and only
            // the copied paths are reindexed.
            "copy" => {
                let from = files::relative(s(&args, "from"))?;
                let to = files::relative(s(&args, "to"))?;
                if to == from || to.starts_with(&format!("{from}/")) {
                    return Err("A folder cannot be pasted inside itself.".into());
                }
                let source = files::checked(&root, &from, false)?;
                let dest = files::checked(&root, &to, true)?;
                if fs::symlink_metadata(&dest).is_ok() {
                    return Err(format!("{to} already exists."));
                }
                if source.is_file() && files::is_markdown(&from) != files::is_markdown(&to) {
                    return Err("A pasted copy keeps its file type.".into());
                }
                files::manifest(&source)?;
                let started = Instant::now();
                if let Err(e) = files::copy_tree(&source, &dest) {
                    // A partial copy is removed rather than left half-written.
                    if fs::symlink_metadata(&dest).is_ok() {
                        let _ = files::remove(&dest);
                    }
                    return Err(e);
                }
                self.timed("copy.file", started);
                let started = Instant::now();
                self.reconcile_paths(w, BTreeSet::from([to.clone()]))?;
                self.timed("copy.index", started);
                Ok(json!({"path":to}))
            }
            "delete" => {
                if args["confirmed"] != true {
                    return Err("Deletion requires confirmation.".into());
                }
                let p = s(&args, "path").to_string();
                let _write = guard(&w.write);
                let started = Instant::now();
                // Backup copies are opt-in (Settings > Storage location).
                let result = if self.database.setting("deleteBackups")? == true {
                    files::delete(&root, &p, &self.runtime)?
                } else {
                    files::delete_permanently(&root, &p)?
                };
                self.timed("delete.file", started);
                let p = files::relative_options(&p, true)?;
                let started = Instant::now();
                let (gone, touched) = self.database.write(&w.id, |tx| tx.remove_entry(&p))?;
                self.timed("delete.index", started);
                if !gone.is_empty() {
                    let started = Instant::now();
                    let keys: HashSet<String> = gone.iter().map(|g| name_key(g)).collect();
                    self.reresolve(w, &keys, &HashSet::new(), None)?;
                    self.timed("links.reresolve", started);
                }
                self.record(w, touched);
                Ok(result)
            }
            "renamePreview" => self.preview(w, s(&args, "from"), s(&args, "to")),
            "rename" => self.rename(w, s(&args, "token"), args["updateLinks"] == true),
            "revealPath" => {
                let mut target = files::checked_options(&root, s(&args, "path"), true, true)?;
                while !target.exists() && target != root {
                    target.pop();
                }
                Ok(json!({"path":display(&target)}))
            }
            "getOutgoingRelationships" => {
                let p = files::relative(s(&args, "path"))?;
                Ok(json!(self.database.edges(&w.id, Some(&p), false)?))
            }
            "getIncomingRelationships" => {
                let p = files::relative(s(&args, "path"))?;
                Ok(json!(self.database.edges(&w.id, Some(&p), true)?))
            }
            "getNeighbors" => self.database.neighbors(
                &w.id,
                &files::relative(s(&args, "path"))?,
                args["depth"].as_u64().unwrap_or(1) as usize,
                args["limit"].as_u64().unwrap_or(40) as usize,
            ),
            // Searches never wait for indexing: while a workspace is first
            // indexed, results cover the articles indexed so far.
            "searchKnowledge" => {
                let mut found = self.database.search_on(
                    &w.id,
                    s(&args, "query"),
                    args["limit"].as_u64().unwrap_or(30) as usize,
                    args["searchChannel"].as_str(),
                )?;
                if !w.ready() {
                    found["notices"] =
                        json!(["Indexing this workspace; results may be incomplete."]);
                    found["partial"] = json!(true);
                }
                Ok(found)
            }
            "kanban" => {
                let mut v = self.database.kanban_summary(&w.id)?;
                if !w.ready() {
                    v["indexing"] = json!(true);
                }
                Ok(v)
            }
            "kanbanBoard" => self
                .database
                .kanban_board(&w.id, &files::relative(s(&args, "path"))?),
            "kanbanSave" => self.kanban_save(w, &args),
            "buildEvidenceBundle" => self.evidence(w, &args),
            "exportWorkspace" => self.export(w, &args),
            "gitStatus" => git_for(&w.git, &args).status(),
            "gitIgnore" => git_for(&w.git, &args).ignore(),
            "gitDiff" => git_for(&w.git, &args).diff(&args),
            "gitHistory" => git_for(&w.git, &args).history(&args),
            "gitCommitDiff" => git_for(&w.git, &args).commit_diff(&args),
            "gitAction" => {
                // Git runs under this workspace's Git lock only: reading,
                // searching and editing continue while it fetches or pushes.
                let (result, saved) = {
                    let mut git = git_for(&w.git, &args);
                    let result = git.action(&args);
                    let mut clock = guard(&w.snapshots);
                    if clock.settings["enabled"] != true && git.snapshots["enabled"] == true {
                        // Newly enabled: start timing from now.
                        *clock = SnapshotClock::new(Value::Null);
                    }
                    clock.settings = git.snapshots.clone();
                    (result, git.saved())
                };
                self.database.save_workspace_value(&w.id, true, &saved)?;
                // Actions that rewrite the working tree are reconciled before
                // returning; the watcher covers the rest.
                let index_only = [
                    "init",
                    "configureIdentity",
                    "createDeployKey",
                    "removeDeployKey",
                    "testRemote",
                    "configureRemotes",
                    "addRemote",
                    "saveIgnore",
                    "stage",
                    "stageAll",
                    "unstage",
                    "unstageAll",
                    "commit",
                    "fetch",
                    "push",
                    "createBranch",
                    "configureSnapshots",
                    "snapshot",
                ];
                // Restores name the files they rewrote: only those are reindexed.
                let restored = result.as_ref().ok().and_then(|v| {
                    v["restoredPaths"].as_array().filter(|p| p.len() <= 1000).map(|p| {
                        p.iter()
                            .filter_map(|p| p.as_str().map(String::from))
                            .collect::<BTreeSet<_>>()
                    })
                });
                let refresh = if index_only.contains(&s(&args, "action")) {
                    Ok(false)
                } else if let Some(paths) = restored {
                    self.reconcile_paths(w, paths)
                } else {
                    self.reconcile_full(w, false)
                };
                match result {
                    Ok(mut v) => {
                        refresh?;
                        if let Some(map) = v.as_object_mut() {
                            map.remove("restoredPaths");
                        }
                        Ok(v)
                    }
                    Err(e) => Err(e),
                }
            }
            _ => Err(format!("Unknown Weave operation: {op}")),
        }
    }
    /// Articles a rename of `from` rewrites or moves: those linking into it,
    /// the moved articles themselves and Kanban cards whose board moves.
    fn affected(
        &self,
        w: &Workspace,
        from: &str,
        folder: bool,
        mapping: &BTreeMap<String, String>,
    ) -> Result<(BTreeSet<String>, BTreeMap<String, (String, String)>)> {
        let (exact, prefixes) = if folder {
            (vec![], vec![from.to_string()])
        } else {
            (vec![from.to_string()], vec![])
        };
        let mut affected: BTreeSet<String> = self
            .database
            .linking_into(&w.id, &exact, &prefixes)?
            .into_iter()
            .collect();
        affected.extend(mapping.keys().cloned());
        // Cards stay on their boards: a `weave.kanban.board` value that would no
        // longer find its moved board (or is relative to a moved card) is rewritten.
        let cards: BTreeMap<String, (String, String)> = self.database.kanban_summary(&w.id)?
            ["cards"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|c| {
                Some((
                    s(c, "path").to_string(),
                    (
                        s(c, "board").to_string(),
                        c["boardPath"].as_str()?.to_string(),
                    ),
                ))
            })
            .collect();
        for (card, (_, board)) in &cards {
            if mapping.contains_key(board) || mapping.contains_key(card) {
                affected.insert(card.clone());
            }
        }
        Ok((affected, cards))
    }
    fn preview(&self, w: &Workspace, from: &str, to: &str) -> Result<Value> {
        self.drain(w)?;
        self.ensure_ready(w)?;
        if self.database.unreadable(&w.id)? > 0 {
            return Err(
                "Some notes could not be read. Resolve workspace diagnostics before renaming."
                    .into(),
            );
        }
        let root = &w.root;
        let from = files::relative(from)?;
        let to = files::relative(to)?;
        if from == to || to.starts_with(&(from.clone() + "/")) {
            return Err("Choose a different destination outside this folder.".into());
        }
        let source = files::checked(root, &from, false)?;
        let dest = files::checked(root, &to, true)?;
        if source.is_file()
            && from.to_lowercase().ends_with(".md")
            && !to.to_lowercase().ends_with(".md")
        {
            return Err("Keep the .md extension when renaming a note.".into());
        }
        if dest.exists()
            && (w.sensitive
                || from.to_lowercase() != to.to_lowercase()
                || !same_file::is_same_file(&source, &dest).map_err(err)?)
        {
            return Err("The destination already exists.".into());
        }
        if !dest.parent().is_some_and(Path::is_dir) {
            return Err("The destination parent must already exist.".into());
        }
        let mapping: BTreeMap<String, String> = self
            .database
            .markdown_under(&w.id, &from)?
            .into_iter()
            .map(|p| {
                let next = format!("{to}{}", &p[from.len()..]);
                (p, next)
            })
            .collect();
        let (affected, cards) = self.affected(w, &from, source.is_dir(), &mapping)?;
        let mut texts = vec![];
        for p in &affected {
            texts.push((p.clone(), files::read(root, p)?));
        }
        let keys: HashSet<String> = texts
            .iter()
            .flat_map(|(_, d)| {
                markdown::links(s(d, "text"))
                    .into_iter()
                    .map(|l| name_key(&l.target))
            })
            .collect();
        let resolver = self.database.resolver(&w.id, &keys, w.sensitive)?;
        let mut changes = vec![];
        let mut links = 0;
        let mut card_count = 0;
        // Articles whose links are rewritten record the change in `updated_at`.
        let stamp = chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false);
        for (p, d) in &texts {
            let next = mapping.get(p).unwrap_or(p);
            let (mut text, count) = markdown::rewrite(s(d, "text"), p, next, &mapping, &resolver);
            let mut card = 0;
            if let Some((authored, board)) = cards.get(p) {
                let next_board = mapping.get(board).unwrap_or(board);
                if let Some(updated) =
                    kanban::moved_reference(authored, next, next_board, w.sensitive)
                        .and_then(|value| kanban::replace_board_reference(&text, &value))
                {
                    text = updated;
                    card = 1;
                }
            }
            if count + card > 0 {
                let text = markdown::touch_updated(&text, &stamp);
                changes.push(json!({"path":p,"nextPath":next,"text":text,"original":d}));
                links += count;
                card_count += card;
            }
        }
        let token = files::id();
        let result = json!({"token":token,"from":from,"to":to,"links":links,"cards":card_count,"notes":changes.len(),"paths":changes.iter().map(|c|c["path"].clone()).collect::<Vec<_>>()});
        let plan = Rename {
            token,
            from,
            to,
            manifest: files::manifest(&source)?,
            snapshot: texts
                .iter()
                .map(|(p, d)| (p.clone(), s(d, "hash").to_string()))
                .collect(),
            changes,
            created: Instant::now(),
        };
        *guard(&w.plan) = Some(plan);
        Ok(result)
    }
    fn rename(&self, w: &Workspace, token: &str, update: bool) -> Result<Value> {
        let plan = guard(&w.plan)
            .take()
            .filter(|p| p.token == token && p.created.elapsed() < Duration::from_secs(300))
            .ok_or("Rename preview expired. Preview it again.")?;
        self.drain(w)?;
        let root = w.root.clone();
        let source = files::checked(&root, &plan.from, false)?;
        let dest = files::checked(&root, &plan.to, true)?;
        let outcome = {
            let _write = guard(&w.write);
            // The same articles still need rewriting, and none changed since the preview.
            let mapping: BTreeMap<String, String> = self
                .database
                .markdown_under(&w.id, &plan.from)?
                .into_iter()
                .map(|p| (p, String::new()))
                .collect();
            let (affected, _) = self.affected(w, &plan.from, source.is_dir(), &mapping)?;
            let unchanged = affected.len() == plan.snapshot.len()
                && plan.snapshot.iter().all(|(p, hash)| {
                    affected.contains(p)
                        && files::read(&root, p).is_ok_and(|d| s(&d, "hash") == hash)
                });
            if !unchanged {
                return Err(
                    "The workspace changed since the rename preview. Preview it again.".into(),
                );
            }
            if files::manifest(&source)? != plan.manifest {
                return Err(
                    "The resource changed since the rename preview. Preview it again.".into(),
                );
            }
            let outcome = self.apply_rename(&plan, &root, &source, &dest, update);
            if outcome.is_ok() {
                // The old location leaves the index even when only its case changed.
                let (gone, touched) = self
                    .database
                    .write(&w.id, |tx| tx.remove_entry(&plan.from))?;
                if !gone.is_empty() {
                    self.reresolve(
                        w,
                        &gone.iter().map(|g| name_key(g)).collect(),
                        &HashSet::new(),
                        None,
                    )?;
                }
                self.record(w, touched);
            }
            outcome
        };
        // The index follows the move, or its rollback: both locations and every rewritten article.
        let mut paths: BTreeSet<String> = plan
            .changes
            .iter()
            .flat_map(|c| [s(c, "path").to_string(), s(c, "nextPath").to_string()])
            .collect();
        paths.insert(plan.from.clone());
        paths.insert(plan.to.clone());
        let indexed = self.reconcile_paths(w, paths);
        let recovery = outcome?;
        indexed?;
        Ok(
            json!({"path":plan.to,"linksUpdated":if update{plan.changes.len()}else{0},"recovery":display(&recovery)}),
        )
    }
    /// Moves the resource and rewrites links, journaled and rolled back on failure.
    /// Returns the recovery folder.
    fn apply_rename(
        &self,
        plan: &Rename,
        root: &Path,
        source: &Path,
        dest: &Path,
        update: bool,
    ) -> Result<PathBuf> {
        let recovery = self.runtime.join("operations").join(files::id());
        fs::create_dir_all(&recovery).map_err(err)?;
        let hop = source
            .parent()
            .unwrap()
            .join(format!(".weave-move-{}", files::id()));
        let mut journal = json!({"state":"prepared","root":display(root),"from":plan.from,"to":plan.to,"intermediate":display(&hop),"updateLinks":update,"changes":plan.changes});
        let journal_file = recovery.join("journal.json");
        files::json_write(&journal_file, &journal)?;
        let mut applied: Vec<(Value, String)> = vec![];
        let mut moved = false;
        let result = (|| -> Result<()> {
            fs::rename(source, &hop).map_err(err)?;
            let move_result = (|| {
                files::checked(root, &plan.to, true)?;
                if dest.exists() {
                    return Err("Destination appeared during rename.".into());
                }
                fs::rename(&hop, dest).map_err(err)
            })();
            if let Err(e) = move_result {
                fs::rename(&hop, source)
                    .map_err(|rollback| format!("{e}; rollback failed: {rollback}"))?;
                return Err(e);
            }
            moved = true;
            if update {
                for change in &plan.changes {
                    let doc = files::write(
                        root,
                        s(change, "nextPath"),
                        s(change, "text"),
                        change["original"]["hash"].as_str(),
                    )?;
                    applied.push((change.clone(), s(&doc, "hash").into()));
                }
            }
            journal["state"] = json!("complete");
            files::json_write(&journal_file, &journal)
        })();
        if let Err(e) = result {
            let mut failures = vec![];
            for (change, hash) in applied.iter().rev() {
                if let Err(e) = files::write(
                    root,
                    s(change, "nextPath"),
                    s(&change["original"], "text"),
                    Some(hash),
                ) {
                    failures.push(e);
                }
            }
            if moved && failures.is_empty() {
                if source.exists() {
                    failures.push("Original path appeared; move rollback stopped.".into());
                } else if let Err(e) = fs::rename(dest, source) {
                    failures.push(err(e));
                }
            }
            journal["state"] = json!(if failures.is_empty() {
                "rolled-back"
            } else {
                "recovery-needed"
            });
            journal["error"] = json!(e);
            journal["failures"] = json!(failures);
            let _ = files::json_write(&journal_file, &journal);
            return Err(format!(
                "{e} Recovery journal: {}. {}",
                display(&journal_file),
                if failures.is_empty() {
                    "Changes rolled back.".into()
                } else {
                    failures.join("; ")
                }
            ));
        }
        Ok(recovery)
    }
    /// Saves the articles a Kanban move changes (usually one card; a whole
    /// column when its ranks are renumbered) and reindexes them. Every article's
    /// hash is checked before any is written.
    fn kanban_save(&self, w: &Workspace, args: &Value) -> Result<Value> {
        let writes = args["writes"]
            .as_array()
            .filter(|w| !w.is_empty() && w.len() <= 1000)
            .ok_or("Choose the Kanban cards to save.")?;
        let root = w.root.clone();
        let _write = guard(&w.write);
        let mut planned = vec![];
        for write in writes {
            let path = match write.get("resource") {
                Some(r) => {
                    if s(r, "workspaceId") != w.id {
                        return Err("The resource belongs to a different workspace.".into());
                    }
                    let logical = s(r, "logicalPath");
                    if s(r, "kind") != "file" || !logical.starts_with('/') || logical.contains('\\')
                    {
                        return Err("Invalid logical workspace path.".into());
                    }
                    files::relative(&logical[1..])?
                }
                None => files::relative(s(write, "path"))?,
            };
            let (Some(text), Some(hash)) = (write["text"].as_str(), write["hash"].as_str()) else {
                return Err(
                    "Each Kanban change needs the article text and its current hash.".into(),
                );
            };
            if !path.to_lowercase().ends_with(".md") {
                return Err("Kanban cards are Markdown articles.".into());
            }
            if s(&files::read(&root, &path)?, "hash") != hash {
                return Err(format!(
                    "{path} changed on disk. The board was refreshed; try again."
                ));
            }
            planned.push((path, text, hash));
        }
        let mut saved = vec![];
        let mut result = Ok(());
        for (path, text, hash) in &planned {
            match files::write(&root, path, text, Some(hash)) {
                Ok(doc) => {
                    saved.push(json!({"path":path,"hash":doc["hash"]}));
                    self.index_written(w, path, &doc, false)?;
                }
                Err(e) => {
                    result = Err(e);
                    break;
                }
            }
        }
        result?;
        Ok(json!({"saved":saved}))
    }
    fn evidence(&self, w: &Workspace, args: &Value) -> Result<Value> {
        let workspace = w.id.clone();
        let question = s(args, "question").chars().take(1000).collect::<String>();
        let max = (args["maxDocuments"].as_u64().unwrap_or(20) as usize).clamp(1, 20);
        let found = self.database.search(
            &workspace,
            &question,
            (args["seedLimit"].as_u64().unwrap_or(5) as usize).clamp(1, max),
        )?;
        let mut selected = vec![];
        let mut seen = HashSet::new();
        for seed in found["results"].as_array().unwrap() {
            seen.insert(s(seed, "path").to_string());
            selected.push(json!({"path":seed["path"],"kind":"seed","score":seed["score"],"method":"bm25","reason":"Matched the question","passage":seed["excerpt"],"chunkId":seed["chunkId"]}));
        }
        let mut truncated = false;
        if args["connections"] != false {
            for seed in found["results"].as_array().unwrap() {
                let neighbors = self
                    .database
                    .neighbors(&workspace, s(seed, "path"), 1, max)?;
                truncated |= neighbors["truncated"] == true;
                for item in neighbors["documents"].as_array().unwrap() {
                    if seen.contains(s(item, "path")) {
                        continue;
                    }
                    if selected.len() >= max {
                        truncated = true;
                        break;
                    }
                    seen.insert(s(item, "path").into());
                    selected.push(json!({"path":item["path"],"kind":"related","reason":"Connected by an explicit Markdown link","via":item["via"]}));
                }
            }
        }
        for item in &mut selected {
            let path = s(item, "path").to_string();
            match files::read(&w.root, &path) {
                Ok(doc) => {
                    item["title"] =
                        markdown::metadata(s(&doc, "text"), &path, &w.name)["title"].clone();
                    item["contentHash"] = doc["hash"].clone();
                    if item["passage"].is_null() {
                        item["passage"] = json!({"text":s(&doc,"text").lines().take(8).collect::<Vec<_>>().join("\n"),"line":1});
                    } else if let Some(seed) = found["results"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|v| v["path"] == path)
                    {
                        if seed["contentHash"] != doc["hash"] {
                            item["passage"] = json!({"text":s(&doc,"text").chars().take(1800).collect::<String>(),"line":1});
                            item["chunkId"] = Value::Null;
                        }
                    }
                    item["relationships"] =
                        json!(self.database.edges(&workspace, Some(&path), false)?);
                }
                Err(e) => item["error"] = json!(e),
            }
        }
        let notices = if w.ready() {
            json!([])
        } else {
            json!(["Indexing this workspace; results may be incomplete."])
        };
        Ok(
            json!({"version":1,"question":question,"generated":false,"retrieval":"bm25","notices":notices,"truncated":truncated,"documents":selected}),
        )
    }
    /// Writes a read-only, single-file reader for one workspace: its articles,
    /// optional relationship graph and the standalone web interface. Only the
    /// desktop shell calls this, with a path the user chose in a save dialog.
    fn export(&self, w: &Workspace, args: &Value) -> Result<Value> {
        self.ensure_ready(w)?;
        let folder = w.name.clone();
        let graph = args["graph"] != false;
        let tree = self.database.tree(&w.id)?;
        // Optionally only one folder (and its subfolders). Paths stay
        // workspace-relative so links inside the folder resolve unchanged.
        let within = match s(args, "folder") {
            "" => None,
            f => {
                let f = files::relative(f)?;
                if !tree["folders"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|p| p == &json!(f))
                {
                    return Err("That folder is not in the workspace.".into());
                }
                Some(f)
            }
        };
        let inside = |p: &str| {
            within
                .as_ref()
                .is_none_or(|f| p.starts_with(&format!("{f}/")))
        };
        let name = match &within {
            Some(f) => f.rsplit('/').next().unwrap_or(f).to_string(),
            None => self.label(&w.id, &folder)?["name"]
                .as_str()
                .unwrap_or(&folder)
                .to_string(),
        };
        let mut documents = vec![];
        for path in self
            .database
            .document_paths(&w.id)?
            .iter()
            .filter(|p| inside(p))
        {
            let Ok(mut entry) = files::read_listed(&w.root, path) else {
                continue;
            };
            let meta = markdown::metadata(s(&entry, "text"), path, &folder);
            entry
                .as_object_mut()
                .unwrap()
                .extend(meta.as_object().unwrap().clone());
            documents.push(entry);
        }
        let mut snapshot = self.database.snapshot(&w.id)?;
        if within.is_some() {
            // Keep this folder's articles; links that leave it become unavailable targets.
            let kept: Vec<Value> = snapshot["entities"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|e| e["broken"] != true && inside(s(e, "id")))
                .cloned()
                .collect();
            let mut outside = std::collections::BTreeMap::new();
            let mut edges = vec![];
            for edge in snapshot["relationships"].as_array().unwrap() {
                if !inside(s(edge, "from")) {
                    continue;
                }
                let mut edge = edge.clone();
                let to = s(&edge, "to").to_string();
                if !inside(&to) {
                    let id = format!("broken:outside:{to}");
                    outside.entry(id.clone()).or_insert_with(|| json!({"id":id,"name":edge["authored_target"],"type":"unresolved","tags":["outside export"],"broken":true}));
                    edge["to"] = json!(id);
                    edge["resolved"] = json!(0);
                    edge["target_document_id"] = Value::Null;
                }
                edges.push(edge);
            }
            snapshot = json!({"entities":kept.into_iter().chain(outside.into_values()).collect::<Vec<_>>(),"relationships":edges});
        }
        if !graph {
            // Titles still come from the node list; relationships are omitted.
            snapshot["relationships"] = json!([]);
            snapshot["entities"] = json!(snapshot["entities"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|e| e["broken"] != true)
                .cloned()
                .collect::<Vec<_>>());
        }
        // A folder export keeps that folder's ancestors so the tree can show it.
        let folders: Vec<Value> = tree["folders"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|p| {
                within.as_ref().is_none_or(|f| {
                    let p = p.as_str().unwrap_or("");
                    p == f || inside(p) || f.starts_with(&format!("{p}/"))
                })
            })
            .cloned()
            .collect();
        let other: Vec<Value> = if args["otherFiles"] == false {
            vec![]
        } else {
            tree["otherFiles"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|o| inside(s(o, "path")))
                .cloned()
                .collect()
        };
        // The Mermaid runtime (about 3.4 MB) is kept only when diagrams are wanted
        // and an exported article has a Mermaid fence.
        let diagrams = args["diagrams"] != false
            && documents
                .iter()
                .any(|d| markdown::has_mermaid_fence(s(d, "text")));
        let data = json!({"root":name,"portable":true,"features":{"graph":graph,"diagrams":diagrams},"documents":documents,"folders":folders,"otherFiles":other,"graph":snapshot});
        let template = args["template"].as_str().unwrap_or(EXPORT_TEMPLATE);
        let html = portable_html(template, &data, &name, diagrams)?;
        let target = PathBuf::from(s(args, "path"));
        if target.as_os_str().is_empty()
            || target
                .extension()
                .is_none_or(|e| !e.eq_ignore_ascii_case("html") && !e.eq_ignore_ascii_case("htm"))
        {
            return Err("Choose an .html file to export to.".into());
        }
        let parent = target
            .parent()
            .filter(|p| p.is_dir())
            .ok_or("Choose an existing folder to export to.")?;
        let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(err)?;
        use std::io::Write;
        staged.write_all(html.as_bytes()).map_err(err)?;
        staged.as_file().sync_all().map_err(err)?;
        staged.persist(&target).map_err(|e| err(e.error))?;
        Ok(
            json!({"path":display(&target),"bytes":html.len(),"documents":documents.len(),"diagrams":diagrams,"relationships":data["graph"]["relationships"].as_array().map_or(0,|r|r.len()),"name":name}),
        )
    }
    /// Starts a workspace Weave just created as a Git repository with
    /// automatic snapshots on. `host` hardens Git as for the requesting host.
    pub fn start_history(&self, scope: u64, host: &Value) -> Result<Value> {
        let w = self.workspace(Some(scope))?;
        let mut git = guard(&w.git);
        git.hardened = host["hardened"] == true;
        let result = git.action(&json!({"action":"init"})).and_then(|_| {
            git.action(&json!({"action":"configureSnapshots","enabled":true}))
        });
        *guard(&w.snapshots) = SnapshotClock::new(git.snapshots.clone());
        self.database.save_workspace_value(&w.id, true, &git.saved())?;
        result
    }
    /// True when this workspace's automatic snapshot or lease renewal is due.
    pub(crate) fn snapshot_due(&self, w: &Workspace) -> bool {
        guard(&w.snapshots).due(w.revision())
    }
    /// The monitor's snapshot work for one workspace: renews this process's
    /// lease on the repository and, when due, commits its changes. Never
    /// waits for Git: a manual Git operation in progress postpones it.
    pub(crate) fn snapshot_tick(&self, w: &Workspace) {
        let (wanted, push) = {
            let clock = guard(&w.snapshots);
            (
                clock.snapshot_due(w.revision()),
                clock.settings["push"] == true,
            )
        };
        let mut git = match w.git.try_lock() {
            Ok(git) => git,
            Err(std::sync::TryLockError::Poisoned(p)) => p.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => {
                guard(&w.snapshots).retry = Some(Instant::now() + Duration::from_secs(30));
                return;
            }
        };
        let host = guard(&self.background_git).clone();
        git.hardened = host["hardened"] == true;
        git.hosts = host["gitHosts"]
            .as_array()
            .map(|a| a.iter().filter_map(|h| h.as_str().map(String::from)).collect())
            .unwrap_or_default();
        let revision = w.revision();
        let repository = git.repository().is_ok_and(|s| s["repository"] == true);
        let mut waiting = false;
        if wanted {
            if repository {
                match git.snapshot("automatic", None, push, Some(&self.instance)) {
                    Ok(result) => waiting = result["waiting"] == true,
                    Err(e) => git.snapshot_state["error"] = json!(e),
                }
            } else {
                git.snapshot_state["skipped"] =
                    json!("Initialise a Git repository to take snapshots.");
            }
            let _ = self
                .database
                .save_workspace_value(&w.id, true, &git.saved());
        } else if repository {
            let _ = git.lease(&self.instance);
        }
        drop(git);
        let mut clock = guard(&w.snapshots);
        clock.leased = Some(Instant::now());
        if waiting {
            // Staged changes, a merge or another Git program: check again
            // shortly rather than only after the next edit.
            clock.retry = Some(Instant::now() + Duration::from_secs(60));
        } else if wanted {
            clock.checked = revision;
            clock.attempted = Instant::now();
            clock.retry = None;
        }
    }
    /// Before Weave exits: takes the snapshots of workspaces set to snapshot
    /// on close (without pushing, so exiting never waits for the network)
    /// and releases this process's leases. Call before `stopping` is set.
    pub fn snapshot_on_exit(&self) {
        for w in self.workspaces() {
            let settings = guard(&w.snapshots).settings.clone();
            if settings["enabled"] != true {
                continue;
            }
            let started = Instant::now();
            let mut git = loop {
                match w.git.try_lock() {
                    Ok(git) => break Some(git),
                    Err(std::sync::TryLockError::Poisoned(p)) => break Some(p.into_inner()),
                    Err(_) if started.elapsed() > Duration::from_secs(10) => break None,
                    Err(_) => std::thread::sleep(Duration::from_millis(50)),
                }
            };
            let Some(git) = git.as_mut() else {
                continue;
            };
            if settings["onClose"] == true && git.repository().is_ok_and(|s| s["repository"] == true) {
                if let Err(e) = git.snapshot("close", None, false, Some(&self.instance)) {
                    git.snapshot_state["error"] = json!(e);
                }
                let _ = self.database.save_workspace_value(&w.id, true, &git.saved());
            }
            git.release_lease(&self.instance);
        }
    }
    fn control(&self, scope: Option<u64>) -> Result<Value> {
        let open = self.workspaces();
        let mut workspaces = self.database.workspaces()?;
        for w in &mut workspaces {
            let id = s(w, "id").to_string();
            let folder = s(w, "name").to_string();
            let label = self.label(&id, &folder)?;
            let position = open.iter().position(|o| o.id == id);
            w["folderName"] = json!(folder);
            w["name"] = label["name"].clone();
            w["customName"] = label["customName"].clone();
            w["color"] = label["color"].clone();
            w["open"] =
                json!(position.is_some_and(|i| open[i].desktop_active.load(Ordering::Acquire)));
            w["order"] = json!(position);
            w["scope"] = json!(position.map(|i| open[i].scope));
        }
        let status_index = scope
            .and_then(|scope| open.iter().position(|w| w.scope == scope))
            .or(if open.is_empty() { None } else { Some(0) });
        Ok(
            json!({"deleteBackups":self.database.setting("deleteBackups")? == true,"trashDirectory":display(&self.runtime.join("trash")),"dataDirectory":display(&self.runtime),"pendingDataDirectory":crate::storage_location::pending(&self.default_runtime)?.map(|p|display(&p)),"database":display(&self.database_file),"workspaces":workspaces,"open":open.iter().map(|w|w.id.clone()).collect::<Vec<_>>(),"maxOpen":MAX_OPEN_WORKSPACES,"active":status_index.map(|i|open[i].id.clone()),"status":match status_index{Some(i)=>self.status_at(&open[i])?,None=>Value::Null}}),
        )
    }
    fn relocate(&self, args: &Value, scope: Option<u64>) -> Result<Value> {
        let chosen = args["dataDirectory"]
            .as_str()
            .ok_or("Choose a data folder.")?;
        let target = crate::storage_location::schedule(
            &self.default_runtime,
            &self.runtime,
            Path::new(chosen),
            &self.database.workspaces()?,
        )?;
        let mut panel = self.control(scope)?;
        if target != self.runtime {
            panel["pendingDataDirectory"] = json!(display(&target));
        }
        panel["restartRequired"] = json!(target != self.runtime);
        Ok(panel)
    }
}
/// Background reconciliation for every open workspace. Each workspace's
/// work runs on its own thread, so a large scan of one never delays another,
/// and a revision change is reported at most once per interval.
pub struct Monitor {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}
impl Monitor {
    pub fn start(
        backend: Arc<Backend>,
        interval: Duration,
        notify: impl Fn(u64, Value) + Send + 'static,
    ) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let thread = std::thread::spawn(move || {
            let mut jobs: HashMap<u64, JoinHandle<()>> = HashMap::new();
            // Automatic snapshots: one job per workspace at a time, apart
            // from indexing so neither delays the other.
            let mut snapshots: HashMap<u64, JoinHandle<()>> = HashMap::new();
            let mut reported: HashMap<u64, u64> = HashMap::new();
            let mut checkpointed = Instant::now();
            while !flag.load(Ordering::Relaxed) && !backend.stopping.load(Ordering::Relaxed) {
                std::thread::sleep(interval);
                if checkpointed.elapsed() >= Duration::from_secs(1) {
                    let started = Instant::now();
                    let _ = backend.database.checkpoint_passive();
                    backend.timed("checkpoint", started);
                    checkpointed = Instant::now();
                }
                jobs.retain(|_, job| !job.is_finished());
                snapshots.retain(|_, job| !job.is_finished());
                let open = backend.workspaces();
                for w in &open {
                    if !snapshots.contains_key(&w.scope) && backend.snapshot_due(w) {
                        let (b, w) = (backend.clone(), w.clone());
                        snapshots.insert(
                            w.scope,
                            std::thread::spawn(move || b.snapshot_tick(&w)),
                        );
                    }
                    if !jobs.contains_key(&w.scope) && w.due() {
                        let (b, w) = (backend.clone(), w.clone());
                        jobs.insert(
                            w.scope,
                            std::thread::spawn(move || {
                                let _ = b.poll_workspace(&w);
                            }),
                        );
                    }
                    let revision = w.revision();
                    if let Some(previous) = reported.insert(w.scope, revision) {
                        if previous != revision {
                            notify(w.scope, backend.status_at(w).unwrap_or(Value::Null));
                        }
                    }
                }
                reported.retain(|scope, _| open.iter().any(|w| w.scope == *scope));
            }
            for (_, job) in jobs.into_iter().chain(snapshots) {
                let _ = job.join();
            }
        });
        Self {
            stop,
            thread: Some(thread),
        }
    }
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
/// True when `path` exists with exactly this name. On case-insensitive file
/// systems a path whose case changed still opens, but is no longer present.
fn present(root: &Path, path: &str) -> bool {
    let full = root.join(path);
    if fs::symlink_metadata(&full).is_err() {
        return false;
    }
    let name = path.rsplit('/').next().unwrap_or(path);
    fs::canonicalize(&full)
        .ok()
        .and_then(|c| c.file_name().map(|n| n.to_string_lossy() == name))
        .unwrap_or(true)
}
fn hsl(hue: f64, saturation: f64, lightness: f64) -> (u8, u8, u8) {
    let c = (1.0 - (2.0 * lightness - 1.0).abs()) * saturation;
    let x = c * (1.0 - ((hue / 60.0) % 2.0 - 1.0).abs());
    let m = lightness - c / 2.0;
    let (r, g, b) = match hue as u32 {
        0..=59 => (c, x, 0.0),
        60..=119 => (x, c, 0.0),
        120..=179 => (0.0, c, x),
        180..=239 => (0.0, x, c),
        240..=299 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let to = |v: f64| ((v + m) * 255.0).round() as u8;
    (to(r), to(g), to(b))
}
/// The standalone reader page (the same page as weave_lite.html) with a
/// placeholder for workspace data, embedded at build time.
pub const EXPORT_TEMPLATE: &str = include_str!(concat!(env!("OUT_DIR"), "/export-template.html"));
const EXPORT_TOKEN: &str = "\"__WEAVE_EXPORT_DATA__\"";
/// The start of the inert element that carries the Mermaid runtime (build.mjs).
const MERMAID_RUNTIME: &str = r#"<script id="weave-mermaid-runtime" type="text/plain">"#;
/// Fills the reader template with a workspace. The JSON sits in a non-executed
/// `application/json` script, so `<`, `>` and `&` are escaped to keep article
/// text from closing that element; the page's script hash is unchanged.
/// Without `diagrams`, the inert Mermaid runtime element is removed (the reader
/// then shows Mermaid fences as code); its script-src hash is left, unused.
pub fn portable_html(template: &str, data: &Value, title: &str, diagrams: bool) -> Result<String> {
    if !template.contains(EXPORT_TOKEN) {
        return Err(
            "This build has no portable reader. Run npm run build:desktop, then rebuild Weave."
                .into(),
        );
    }
    let json = serde_json::to_string(data)
        .map_err(err)?
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026");
    let escaped: String = title
        .chars()
        .map(|c| match c {
            '<' => "&lt;".to_string(),
            '>' => "&gt;".to_string(),
            '&' => "&amp;".to_string(),
            '"' => "&quot;".to_string(),
            c => c.to_string(),
        })
        .collect();
    let mut template = template.to_string();
    if !diagrams {
        if let Some(start) = template.find(MERMAID_RUNTIME) {
            if let Some(end) = template[start..].find("</script>") {
                template.replace_range(start..start + end + "</script>".len(), "");
            }
        }
    }
    Ok(template.replacen(EXPORT_TOKEN, &json, 1).replacen(
        "<title>Weave</title>",
        &format!("<title>{escaped} · Weave</title>"),
        1,
    ))
}
pub fn resource(w: &str, path: &str, kind: &str) -> Value {
    json!({"workspaceId":w,"kind":kind,"logicalPath":format!("/{path}")})
}
fn read_json(path: &Path) -> Result<Value> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(err),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(err(e)),
    }
}
fn validate_session(args: &Value) -> Result<Value> {
    let mut tabs = vec![];
    for p in args["tabs"].as_array().into_iter().flatten().take(100) {
        let p = files::relative(p.as_str().ok_or("Invalid tab path")?)?;
        if !p.to_lowercase().ends_with(".md") {
            return Err("Tabs must contain Markdown paths.".into());
        }
        if !tabs.contains(&p) {
            tabs.push(p);
        }
    }
    let mut v = json!({"tabs":tabs,"active":if tabs.iter().any(|p|p==s(args,"active")){Some(s(args,"active").to_string())}else{tabs.last().cloned()},"source":args["source"]==true});
    if let Some(states) = args["tabState"].as_array() {
        let mut ids = HashSet::new();
        let mut records = vec![];
        for t in states.iter().take(100) {
            let id = s(t, "id");
            if id.is_empty()
                || id.len() > 80
                || !id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
                || !ids.insert(id.to_string())
            {
                return Err("Invalid tab identity.".into());
            }
            let path = if t["path"].is_null() {
                None
            } else {
                Some(files::relative(s(t, "path"))?)
            };
            let history: Vec<String> = t["history"]
                .as_array()
                .into_iter()
                .flatten()
                .rev()
                .take(200)
                .map(|p| files::relative(p.as_str().unwrap_or("")))
                .collect::<Result<Vec<_>>>()?
                .into_iter()
                .rev()
                .collect();
            if path
                .iter()
                .chain(history.iter())
                .any(|p| !p.to_lowercase().ends_with(".md"))
            {
                return Err("Tabs must contain Markdown paths.".into());
            }
            let last = history.len() as i64 - 1;
            records.push(json!({"id":id,"path":path,"history":history,"at":t["at"].as_i64().unwrap_or(last).clamp(-1,last.max(-1))}));
        }
        v["activeTab"] = if ids.contains(s(args, "activeTab")) {
            args["activeTab"].clone()
        } else {
            records
                .last()
                .map(|r| r["id"].clone())
                .unwrap_or(Value::Null)
        };
        v["tabState"] = json!(records);
    }
    Ok(v)
}

fn monitoring(v: &Value) -> Result<Value> {
    let mut defaults =
        json!({"watchChanges":true,"autoRefresh":true,"refreshSeconds":300,"scanMode":"metadata"});
    for key in ["watchChanges", "autoRefresh", "refreshSeconds", "scanMode"] {
        if let Some(value) = v.get(key) {
            defaults[key] = value.clone();
        }
    }
    if !defaults["watchChanges"].is_boolean()
        || !defaults["autoRefresh"].is_boolean()
        || !defaults["refreshSeconds"]
            .as_u64()
            .is_some_and(|n| (10..=86400).contains(&n))
        || !["metadata", "content"].contains(&s(&defaults, "scanMode"))
    {
        return Err("Choose valid workspace monitoring options (10–86400 seconds).".into());
    }
    Ok(defaults)
}
fn detect_case(root: &Path) -> bool {
    let Some(name) = root.file_name().and_then(|v| v.to_str()) else {
        return !cfg!(windows);
    };
    let mut changed = false;
    let toggled: String = name
        .chars()
        .map(|c| {
            if !changed && c.is_ascii_alphabetic() {
                changed = true;
                if c.is_ascii_lowercase() {
                    c.to_ascii_uppercase()
                } else {
                    c.to_ascii_lowercase()
                }
            } else {
                c
            }
        })
        .collect();
    if changed {
        if let Some(parent) = root.parent() {
            return fs::canonicalize(parent.join(toggled))
                .map(|p| p != root)
                .unwrap_or(true);
        }
    }
    !cfg!(windows)
}
