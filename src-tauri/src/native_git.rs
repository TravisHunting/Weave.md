//! Fixed Git vocabulary, argument arrays only, scoped to an opened repository.
use crate::native_files::{self as files, err, Result};
use fs2::FileExt;
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
pub struct Git {
    pub root: PathBuf,
    pub preferences: Value,
    pub pulls: Value,
    pub stopping: Arc<AtomicBool>,
    /// Private directory holding SSH material for every workspace
    /// (`<data>/git-keys`): one folder per workspace plus `known_hosts`.
    pub keys: Option<PathBuf>,
    /// Workspace identifier naming its deploy-key folder.
    pub key_id: String,
    /// Set for each request arriving over HTTP: hooks are disabled, only
    /// network transports are allowed and the repository's own SSH command
    /// is ignored.
    pub hardened: bool,
    /// Remote hosts the server permits (empty: any host).
    pub hosts: Vec<String>,
    /// Automatic snapshot settings (`snapshot_settings`), kept with the
    /// workspace's other Git preferences.
    pub snapshots: Value,
    /// The latest snapshot and why the last attempt did not commit.
    pub snapshot_state: Value,
    /// Automatic fetch settings (`fetch_settings`).
    pub auto_fetch: Value,
    /// The latest automatic fetch: when, and its error.
    pub fetch_state: Value,
}
/// Validated automatic fetch settings: `enabled` and every `minutes`.
pub fn fetch_settings(v: &Value) -> Result<Value> {
    let mut out = json!({"enabled":false,"minutes":10});
    if let Some(map) = v.as_object() {
        for (key, value) in map {
            match key.as_str() {
                "enabled" => {
                    out[key] = json!(value.as_bool().ok_or("Choose whether to fetch automatically.")?)
                }
                "minutes" => {
                    out[key] = json!(value
                        .as_u64()
                        .filter(|m| (1..=1440).contains(m))
                        .ok_or("Fetch intervals are between 1 and 1440 minutes.")?)
                }
                _ => return Err("Unknown fetch setting.".into()),
            }
        }
    }
    Ok(out)
}
/// Seconds after which another Weave process may take over a repository's
/// snapshot lease that was not renewed.
const LEASE_SECONDS: u64 = 180;
/// Validated automatic snapshot settings: `enabled`, `trigger` (`idle`: after
/// `minutes` without changes; `interval`: every `minutes`), `push` and `onClose`.
pub fn snapshot_settings(v: &Value) -> Result<Value> {
    let mut out = json!({"enabled":false,"trigger":"idle","minutes":15,"push":false,"onClose":true});
    if let Some(map) = v.as_object() {
        for (key, value) in map {
            match key.as_str() {
                "enabled" | "push" | "onClose" => {
                    out[key] = json!(value
                        .as_bool()
                        .ok_or("Choose on or off for each snapshot setting.")?)
                }
                "trigger" => {
                    let trigger = value.as_str().unwrap_or("");
                    if !["idle", "interval"].contains(&trigger) {
                        return Err("Choose when snapshots are taken.".into());
                    }
                    out[key] = json!(trigger);
                }
                "minutes" => {
                    out[key] = json!(value
                        .as_u64()
                        .filter(|m| (1..=1440).contains(m))
                        .ok_or("Snapshot times are between 1 and 1440 minutes.")?)
                }
                _ => return Err("Unknown snapshot setting.".into()),
            }
        }
    }
    Ok(out)
}
/// A full commit ID from the history.
fn commit_id(id: &str) -> Result<&str> {
    if !(40..=64).contains(&id.len()) || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Choose a commit from the history.".into());
    }
    Ok(id)
}
fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
/// Host keys GitHub and GitLab.com publish, so the first connection to
/// them is verified rather than trusted. Other hosts are recorded on first use.
const KNOWN_HOSTS: &str = "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=
github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=
gitlab.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf
gitlab.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBFSMqzJeV9rUzU4kWitGjeR4PWSa29SPqJ1fVkhtj3Hw9xjLVXVYrU9QlYWrOLXBpQ6KWjbjTDTdDkoohFzgbEY=
gitlab.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCsj2bNKTBSpIYDEGk9KxsGh3mySTRgMtXL583qmBpzeQ+jqCMRgBqB98u3z++J1sKlXHWfM9dyhSevkMwSbhoR8XIq/U0tCNyokEi/ueaBMCvbcTHhO7FcwzY92WK4Yt0aGROY5qX2UKSeOvuP4D6TPqKF1onrSzH9bx9XUf2lEdWT/ia1NEKjunUqu1xOB/StKDHMoX4/OKyIzuS0q/T1zOATthvasJFoPrAjkohTyaDUz2LN5JoH839hViyEG82yB+MjcFV5MU3N1l1QL3cVUCh93xSaua1N85qivl+siMkPGbO5xR/En4iEY6K2XPASUEMaieWVNTRCtJ4S8H+9
";
fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
/// A path quoted for the POSIX shell Git runs `GIT_SSH_COMMAND` through.
fn quoted(p: &Path) -> String {
    format!(
        "'{}'",
        p.to_string_lossy().replace('\\', "/").replace('\'', "'\\''")
    )
}
/// Validates a remote URL: HTTP(S), SSH or scp-like `user@host:path`, never
/// carrying credentials, queries or local paths.
fn remote_url(u: &str) -> Result<()> {
    if u.is_empty()
        || u.len() > 2000
        || u.chars()
            .any(|c| c.is_whitespace() || c.is_control() || "?#".contains(c))
    {
        return Err("Use an HTTP(S) or SSH URL without credentials or query parameters.".into());
    }
    if let Ok(url) = url::Url::parse(u) {
        if !["http", "https", "ssh"].contains(&url.scheme())
            || url.host_str().is_none()
            || url.password().is_some()
            || (url.scheme() != "ssh" && !url.username().is_empty())
        {
            return Err("Use your system Git credentials.".into());
        }
    } else if !regex::Regex::new(r"^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[\w./-]+$")
        .unwrap()
        .is_match(u)
    {
        return Err("Use an HTTP(S) or SSH Git URL.".into());
    }
    Ok(())
}
/// The host a remote URL connects to, lower-cased.
pub fn remote_host(u: &str) -> Option<String> {
    if let Ok(url) = url::Url::parse(u) {
        if ["http", "https", "ssh"].contains(&url.scheme()) {
            return url.host_str().map(|h| h.to_ascii_lowercase());
        }
        return None;
    }
    let (_, rest) = u.split_once('@')?;
    let (host, _) = rest.split_once(':')?;
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}
/// A commit author's name or email: one short line.
fn identity_field(v: &str, what: &str) -> Result<String> {
    let v = v.trim();
    if v.is_empty() || v.len() > 200 || v.chars().any(|c| c.is_control() || "<>".contains(c)) {
        return Err(format!("Enter a {what} of at most 200 characters."));
    }
    Ok(v.into())
}
fn private(p: &str) -> bool {
    p.split('/').any(|c| {
        let c = c.to_lowercase();
        c == ".git" || c == ".weave" || c.starts_with(".weave-")
    })
}
fn redact(text: &str) -> String {
    let mut s = text.to_string();
    for (p, r) in [
        (r"(?i)(https?://)[^/\s@]+@", "${1}[redacted]@"),
        (
            r"(?i)([?&](?:access_token|token|key|sig|signature|password)=)[^&\s]+",
            "${1}[redacted]",
        ),
        (
            r"(?i)(authorization:\s*(?:bearer|basic)\s+)\S+",
            "${1}[redacted]",
        ),
    ] {
        s = regex::Regex::new(p)
            .unwrap()
            .replace_all(&s, r)
            .into_owned();
    }
    s
}
fn reference(v: &str) -> Result<&str> {
    if v.is_empty()
        || v.len() > 200
        || v.starts_with('-')
        || v.contains("..")
        || v.contains("@{")
        || v.ends_with(['.', '/'])
        || v.ends_with(".lock")
        || v.chars().any(|c| c <= ' ' || "~^:?*[\\".contains(c))
    {
        return Err("Use a valid Git branch name.".into());
    }
    Ok(v)
}
fn markers(text: &str) -> bool {
    text.lines()
        .any(|s| s.starts_with("<<<<<<<") || s.starts_with(">>>>>>>"))
}
impl Git {
    pub fn new(root: &Path, saved: Value, stopping: Arc<AtomicBool>) -> Self {
        Self {
            root: root.into(),
            preferences: saved["preferences"].clone(),
            pulls: saved["pulls"]
                .as_array()
                .map(|a| json!(a))
                .unwrap_or(json!([])),
            stopping,
            keys: None,
            key_id: String::new(),
            hardened: false,
            hosts: vec![],
            snapshots: snapshot_settings(&saved["snapshots"])
                .unwrap_or_else(|_| snapshot_settings(&Value::Null).unwrap()),
            snapshot_state: if saved["snapshotState"].is_object() {
                saved["snapshotState"].clone()
            } else {
                json!({})
            },
            auto_fetch: fetch_settings(&saved["autoFetch"])
                .unwrap_or_else(|_| fetch_settings(&Value::Null).unwrap()),
            fetch_state: if saved["fetchState"].is_object() {
                saved["fetchState"].clone()
            } else {
                json!({})
            },
        }
    }
    /// Keeps this workspace's deploy key under `keys/<id>`.
    pub fn with_keys(mut self, keys: PathBuf, id: &str) -> Self {
        self.keys = Some(keys);
        self.key_id = id.into();
        self
    }
    fn key_dir(&self) -> Option<PathBuf> {
        let id = &self.key_id;
        (!id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || "-_".contains(c)))
            .then(|| self.keys.as_ref().map(|k| k.join(id)))
            .flatten()
    }
    fn key_file(&self) -> Option<PathBuf> {
        self.key_dir()
            .map(|d| d.join("id_ed25519"))
            .filter(|p| p.is_file())
    }
    fn known_hosts(&self) -> Result<PathBuf> {
        let keys = self.keys.as_ref().ok_or("Deploy keys are unavailable on this host.")?;
        fs::create_dir_all(keys).map_err(err)?;
        let file = keys.join("known_hosts");
        if !file.exists() {
            fs::write(&file, KNOWN_HOSTS).map_err(err)?;
        }
        Ok(file)
    }
    /// The public half of this workspace's deploy key, for the setup guide.
    pub fn deploy_key(&self) -> Value {
        let Some(dir) = self.key_dir() else {
            return Value::Null;
        };
        let Ok(public) = fs::read_to_string(dir.join("id_ed25519.pub")) else {
            return Value::Null;
        };
        if !dir.join("id_ed25519").is_file() {
            return Value::Null;
        }
        let about: Value = fs::read(dir.join("key.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or(json!({}));
        json!({"publicKey":public.trim(),"fingerprint":about["fingerprint"],"created":about["created"]})
    }
    fn ssh_keygen() -> PathBuf {
        if cfg!(windows) {
            // Git for Windows ships OpenSSH beside git.exe; Windows has its own.
            if let Some(base) = Self::executable().parent().and_then(Path::parent) {
                let p = base.join("usr/bin/ssh-keygen.exe");
                if p.is_file() {
                    return p;
                }
            }
            let system = PathBuf::from(
                std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()),
            )
            .join("System32/OpenSSH/ssh-keygen.exe");
            if system.is_file() {
                return system;
            }
        } else if !std::env::var_os("PATH").is_some_and(|paths| {
            std::env::split_paths(&paths).any(|dir| dir.join("ssh-keygen").is_file())
        }) {
            for p in ["/usr/bin/ssh-keygen", "/usr/local/bin/ssh-keygen"] {
                if Path::new(p).is_file() {
                    return p.into();
                }
            }
        }
        PathBuf::from("ssh-keygen")
    }
    /// Creates (or with `replace`, replaces) this workspace's ed25519 deploy
    /// key. The private key never leaves the private data directory.
    fn create_deploy_key(&self, replace: bool, comment: &str) -> Result<Value> {
        let dir = self.key_dir().ok_or("Deploy keys are unavailable on this host.")?;
        if self.key_file().is_some() && !replace {
            return Err("This workspace already has a deploy key.".into());
        }
        self.known_hosts()?;
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).map_err(err)?;
        let key = dir.join("id_ed25519");
        let path = key.to_string_lossy().replace('\\', "/");
        let mut cmd = Command::new(Self::ssh_keygen());
        cmd.args(["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", &path]);
        self.execute(cmd, false, None).map_err(|e| {
            if e.starts_with("Could not start") {
                "SSH key tools are unavailable. Install OpenSSH (ssh-keygen), then retry.".into()
            } else {
                e
            }
        })?;
        let mut cmd = Command::new(Self::ssh_keygen());
        cmd.args(["-l", "-f", &format!("{path}.pub")]);
        let listed = self.execute(cmd, true, None)?;
        let fingerprint = String::from_utf8_lossy(&listed.1)
            .split_whitespace()
            .nth(1)
            .unwrap_or("")
            .to_string();
        fs::write(
            dir.join("key.json"),
            json!({"fingerprint":fingerprint,"created":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs,true)}).to_string(),
        )
        .map_err(err)?;
        Ok(self.deploy_key())
    }
    pub fn saved(&self) -> Value {
        json!({"preferences":self.preferences,"pulls":self.pulls,"snapshots":self.snapshots,"snapshotState":self.snapshot_state,"autoFetch":self.auto_fetch,"fetchState":self.fetch_state})
    }
    fn executable() -> PathBuf {
        if cfg!(windows) {
            for base in [
                std::env::var_os("ProgramFiles").map(PathBuf::from),
                std::env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("Programs")),
            ]
            .into_iter()
            .flatten()
            {
                let p = base.join("Git/cmd/git.exe");
                if p.is_file() {
                    return p;
                }
            }
        } else {
            // Launchers can start Weave with a minimal PATH; Git's usual homes still count.
            let on_path = std::env::var_os("PATH").is_some_and(|paths| {
                std::env::split_paths(&paths).any(|dir| dir.join("git").is_file())
            });
            if !on_path {
                for p in [
                    "/usr/bin/git",
                    "/usr/local/bin/git",
                    "/opt/homebrew/bin/git",
                ] {
                    if std::path::Path::new(p).is_file() {
                        return PathBuf::from(p);
                    }
                }
            }
        }
        PathBuf::from("git")
    }
    fn run(
        &self,
        args: &[&str],
        allow: bool,
        input: Option<&[u8]>,
    ) -> Result<(i32, String, String)> {
        let (code, out, error) = self.run_bytes(args, allow, input)?;
        Ok((code, String::from_utf8_lossy(&out).into(), error))
    }
    fn run_bytes(
        &self,
        args: &[&str],
        allow: bool,
        input: Option<&[u8]>,
    ) -> Result<(i32, Vec<u8>, String)> {
        if self.stopping.load(Ordering::Relaxed) {
            return Err("This workspace is closing.".into());
        }
        let mut cmd = Command::new(Self::executable());
        cmd.args([
            "--no-pager",
            "--literal-pathspecs",
            "-c",
            "core.quotePath=false",
            "-c",
            "core.fsmonitor=false",
        ]);
        if self.hardened {
            // Requests from browsers run no hooks and reach only network
            // remotes; containers own folders under another user ID.
            let hooks = self
                .keys
                .as_ref()
                .map(|k| k.join("no-hooks"))
                .ok_or("Git is unavailable on this host.")?;
            fs::create_dir_all(&hooks).map_err(err)?;
            cmd.arg("-c")
                .arg(format!("core.hooksPath={}", hooks.to_string_lossy().replace('\\', "/")))
                .args([
                    "-c",
                    "protocol.allow=never",
                    "-c",
                    "protocol.https.allow=always",
                    "-c",
                    "protocol.http.allow=always",
                    "-c",
                    "protocol.ssh.allow=always",
                    "-c",
                    "submodule.recurse=false",
                ])
                .arg("-c")
                .arg(format!(
                    "safe.directory={}",
                    self.root.to_string_lossy().replace('\\', "/")
                ));
        }
        // A workspace's deploy key authenticates its SSH remotes; requests
        // from browsers ignore any SSH command configured in the repository.
        if let Some(key) = self.key_file() {
            cmd.env(
                "GIT_SSH_COMMAND",
                format!(
                    "ssh -i {} -o IdentitiesOnly=yes -o UserKnownHostsFile={} -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=20",
                    quoted(&key),
                    quoted(&self.known_hosts()?)
                ),
            );
        } else if self.hardened {
            cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes -o ConnectTimeout=20");
        }
        cmd.args(args).current_dir(&self.root);
        for (key, _) in std::env::vars_os() {
            let k = key.to_string_lossy();
            if [
                "GIT_DIR",
                "GIT_WORK_TREE",
                "GIT_INDEX_FILE",
                "GIT_COMMON_DIR",
                "GIT_OBJECT_DIRECTORY",
                "GIT_ALTERNATE_OBJECT_DIRECTORIES",
                "GIT_CONFIG_COUNT",
            ]
            .contains(&k.as_ref())
                || k.starts_with("GIT_CONFIG_KEY_")
                || k.starts_with("GIT_CONFIG_VALUE_")
            {
                cmd.env_remove(key);
            }
        }
        self.execute(cmd, allow, input).map_err(|e| {
            if let Some(reason) = e.strip_prefix("Could not start: ") {
                format!("Git is unavailable. Install Git and reopen Weave: {reason}")
            } else {
                e
            }
        })
    }
    /// Runs a fixed command with bounded output, a 90 second limit and
    /// redacted errors.
    fn execute(
        &self,
        mut cmd: Command,
        allow: bool,
        input: Option<&[u8]>,
    ) -> Result<(i32, Vec<u8>, String)> {
        cmd.env("GIT_TERMINAL_PROMPT", "0")
            .env("GCM_INTERACTIVE", "Never")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_PAGER", "cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        let mut child = cmd.spawn().map_err(|e| format!("Could not start: {e}"))?;
        let mut stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let overflow = Arc::new(AtomicBool::new(false));
        let flag = overflow.clone();
        let out = std::thread::spawn(move || {
            let mut b = Vec::new();
            let _ = Read::by_ref(&mut stdout)
                .take(4 * 1024 * 1024 + 1)
                .read_to_end(&mut b);
            if b.len() > 4 * 1024 * 1024 {
                flag.store(true, Ordering::Relaxed);
            }
            b
        });
        let flag = overflow.clone();
        let error = std::thread::spawn(move || {
            let mut b = Vec::new();
            let _ = Read::by_ref(&mut stderr)
                .take(4 * 1024 * 1024 + 1)
                .read_to_end(&mut b);
            if b.len() > 4 * 1024 * 1024 {
                flag.store(true, Ordering::Relaxed);
            }
            b
        });
        let mut stdin = child.stdin.take().unwrap();
        let payload = input.unwrap_or(&[]).to_vec();
        let writer = std::thread::spawn(move || {
            let _ = stdin.write_all(&payload);
        });
        let at = Instant::now();
        let mut failure = None;
        let status = loop {
            if self.stopping.load(Ordering::Relaxed)
                || overflow.load(Ordering::Relaxed)
                || at.elapsed() > Duration::from_secs(90)
            {
                failure=Some("Git stopped: shutdown, output limit, or 90 second timeout. Check Git authentication and retry.");
                let _ = child.kill();
                break child.wait().map_err(err)?;
            }
            if let Some(status) = child.try_wait().map_err(err)? {
                break status;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let output = out.join().map_err(|_| "Git output reader failed")?;
        let error = redact(&String::from_utf8_lossy(
            &error.join().map_err(|_| "Git error reader failed")?,
        ));
        let _ = writer.join();
        if overflow.load(Ordering::Relaxed) {
            return Err("Git output exceeded the 4 MB limit.".into());
        }
        if let Some(e) = failure {
            return Err(e.into());
        }
        if !status.success() && !allow {
            return Err(redact(&if error.trim().is_empty() {
                String::from_utf8_lossy(&output).into_owned()
            } else {
                error
            })
            .chars()
            .take(10000)
            .collect());
        }
        Ok((status.code().unwrap_or(-1), output, error))
    }
    fn output(&self, args: &[&str]) -> Result<String> {
        Ok(self.run(args, false, None)?.1)
    }
    fn safe(&self, p: &str, missing: bool) -> Result<String> {
        files::checked_options(&self.root, p, missing, true)
            .map_err(|e| format!("Choose a file inside this repository. {e}"))?;
        Ok(p.into())
    }
    pub(crate) fn repository(&self) -> Result<Value> {
        let (code, out, error) = self.run(&["rev-parse", "--show-toplevel"], true, None)?;
        if code != 0 {
            if error.contains("not a git repository") {
                return Ok(
                    json!({"available":true,"repository":false,"root":crate::backend::display(&self.root)}),
                );
            }
            return Err(error);
        }
        let actual = fs::canonicalize(out.trim()).map_err(err)?;
        let root = fs::canonicalize(&self.root).map_err(err)?;
        Ok(if same_file::is_same_file(&actual, &root).map_err(err)? {
            json!({"available":true,"repository":true,"root":crate::backend::display(&self.root)})
        } else {
            json!({"available":true,"repository":false,"root":crate::backend::display(&self.root),"parentRepository":crate::backend::display(&actual)})
        })
    }
    fn require(&self) -> Result<()> {
        let r = self.repository()?;
        if r["repository"] != true {
            return Err(format!(
                "Open the Git repository root to use Source control: {}",
                r["parentRepository"]
            ));
        }
        Ok(())
    }
    pub fn status(&self) -> Result<Value> {
        let mut info = match self.repository() {
            Ok(v) => v,
            Err(e) => {
                return Ok(
                    json!({"available":false,"repository":false,"error":e,"deployKey":self.deploy_key()}),
                )
            }
        };
        info["deployKey"] = self.deploy_key();
        if info["repository"] != true {
            return Ok(info);
        }
        let (_, configured, _) =
            self.run(&["config", "--get-regexp", r"^user\.(name|email)$"], true, None)?;
        let mut identity = json!({"name":"","email":""});
        for line in configured.lines() {
            if let Some((key, value)) = line.split_once(' ') {
                identity[key.trim_start_matches("user.")] = json!(value);
            }
        }
        info["identity"] = identity;
        let mut state = parse_status(&self.output(&[
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
        ])?);
        let branches:Vec<_>=self.output(&["for-each-ref","--format=%(refname:short)%00%(HEAD)%00%(upstream:short)","refs/heads/"])?.lines().filter(|l|!l.is_empty()).map(|l|{let p:Vec<_>=l.split('\0').collect();json!({"name":p[0],"current":p.get(1)==Some(&"*"),"upstream":p.get(2).unwrap_or(&"")})}).collect();
        let mut remotes = std::collections::BTreeMap::<String, Value>::new();
        for row in self.output(&["remote", "-v"])?.lines() {
            let parts: Vec<_> = row.split_whitespace().collect();
            if parts.len() >= 3 {
                let r = remotes
                    .entry(parts[0].into())
                    .or_insert(json!({"name":parts[0]}));
                r[parts[2].trim_matches(['(', ')'])] = json!(redact(parts[1]));
            }
        }
        let remote_list: Vec<Value> = remotes.into_values().collect();
        let saved = s(&self.preferences, "syncRemote");
        let remote = remote_list
            .iter()
            .find(|r| s(r, "name") == saved)
            .or_else(|| remote_list.iter().find(|r| s(r, "name") == "origin"))
            .or(remote_list.first())
            .map(|r| s(r, "name"))
            .unwrap_or("");
        let pushes = self.preferences["pushRemotes"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter(|n| remote_list.iter().any(|r| r["name"] == **n))
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| {
                if remote.is_empty() {
                    vec![]
                } else {
                    vec![json!(remote)]
                }
            });
        let stashes: Vec<_> = self
            .output(&["stash", "list", "--format=%gd%x00%gs"])?
            .lines()
            .filter_map(|l| {
                l.split_once('\0')
                    .map(|(r, m)| json!({"ref":r,"message":m}))
            })
            .collect();
        let merging = self
            .run(&["rev-parse", "--verify", "-q", "MERGE_HEAD"], true, None)?
            .0
            == 0;
        let mut pending: std::collections::HashSet<String> = state["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| s(f, "path").into())
            .collect();
        if state["ahead"].as_i64().unwrap_or(0) > 0 {
            for p in self
                .output(&["diff", "--name-only", "-z", "HEAD@{upstream}...HEAD", "--"])?
                .split('\0')
                .filter(|p| !p.is_empty() && !private(p))
            {
                pending.insert(p.into());
            }
        }
        info.as_object_mut()
            .unwrap()
            .append(state.as_object_mut().unwrap());
        info["branches"] = json!(branches);
        info["syncRemote"] = json!(remote);
        info["pushRemotes"] = json!(pushes);
        info["remotes"] = json!(remote_list);
        info["stashes"] = json!(stashes);
        info["merging"] = json!(merging);
        info["pendingFileCount"] = json!(pending.len());
        info["recentPulls"] = self.pulls.clone();
        let mut snapshots = self.snapshots.clone();
        if let (Some(map), Some(state)) = (snapshots.as_object_mut(), self.snapshot_state.as_object()) {
            map.extend(state.clone());
        }
        info["snapshots"] = snapshots;
        // Incoming changes already fetched but not merged: the files the
        // upstream changed since the common ancestor, so the reader can warn
        // before they are edited here.
        let mut incoming = vec![];
        let mut incoming_total = 0;
        if info["behind"].as_i64().unwrap_or(0) > 0 {
            for p in self
                .output(&["diff", "--name-only", "--no-renames", "-z", "HEAD...HEAD@{upstream}", "--"])?
                .split('\0')
                .filter(|p| !p.is_empty() && !private(p))
            {
                incoming_total += 1;
                if incoming.len() < 500 {
                    incoming.push(json!(p));
                }
            }
        }
        info["incomingFiles"] = json!(incoming);
        info["incomingFileCount"] = json!(incoming_total);
        let mut fetching = self.auto_fetch.clone();
        if let (Some(map), Some(state)) = (fetching.as_object_mut(), self.fetch_state.as_object()) {
            map.extend(state.clone());
        }
        // The last fetch of any kind (manual, automatic or another Git client).
        let fetch_head = self.output(&["rev-parse", "--git-path", "FETCH_HEAD"])?;
        if let Ok(modified) = fs::metadata(self.root.join(fetch_head.trim())).and_then(|m| m.modified()) {
            fetching["fetchedAt"] = json!(chrono::DateTime::<chrono::Utc>::from(modified)
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
        }
        info["autoFetch"] = fetching;
        info["busy"] = Value::Null;
        Ok(info)
    }
    pub fn ignore(&self) -> Result<Value> {
        self.require()?;
        let p = files::checked_options(&self.root, ".gitignore", true, true)?;
        if !p.exists() {
            return Ok(json!({"text":"","revision":null,"format":{}}));
        }
        let m = fs::metadata(&p).map_err(err)?;
        if !m.is_file() || m.len() > 1024 * 1024 {
            return Err(".gitignore must be an ordinary text file of at most 1 MB.".into());
        }
        let b = fs::read(p).map_err(err)?;
        let (text, u, bom) = files::decode(&b)?;
        Ok(
            json!({"text":text,"revision":files::hash(b),"format":{"encoding":if u{"utf16le"}else{"utf8"},"bom":bom}}),
        )
    }
    fn conflict_snapshot(&self, p: &str) -> Result<Value> {
        self.safe(p, true)?;
        let raw = self.output(&["ls-files", "--unmerged", "-z", "--", p])?;
        let mut stages = json!({});
        for r in raw.split('\0').filter(|r| !r.is_empty()) {
            let parts: Vec<_> = r.split([' ', '\t']).collect();
            if parts.len() >= 4 {
                stages[parts[2]] = json!({"mode":parts[0],"id":parts[1]});
            }
        }
        if stages.as_object().unwrap().is_empty() {
            return Err("This file no longer has a conflict. Refresh Source control.".into());
        }
        for stage in stages.as_object().unwrap().values() {
            if !["100644", "100755"].contains(&s(stage, "mode")) {
                return Err("Linked files and submodules require an external Git client.".into());
            }
            let size = self
                .output(&["cat-file", "-s", s(stage, "id")])?
                .trim()
                .parse::<u64>()
                .map_err(err)?;
            if size > 1024 * 1024 {
                return Err("Conflict files larger than 1 MB need an external Git client.".into());
            }
        }
        let full = self.root.join(p);
        let b = if full.exists() {
            let m = fs::metadata(&full).map_err(err)?;
            if !m.is_file() || m.len() > 1024 * 1024 {
                return Err("Conflict files must be ordinary files of at most 1 MB.".into());
            }
            Some(fs::read(full).map_err(err)?)
        } else {
            None
        };
        let revision = files::hash(format!("{raw}\0{:?}", b.as_ref().map(files::hash)));
        Ok(json!({"path":p,"stages":stages,"revision":revision,"bytes":b}))
    }
    fn stage_bytes(&self, stage: &Value) -> Result<Option<Vec<u8>>> {
        if stage.is_null() {
            Ok(None)
        } else {
            Ok(Some(
                self.run_bytes(&["cat-file", "blob", s(stage, "id")], false, None)?
                    .1,
            ))
        }
    }
    fn conflict(&self, p: &str) -> Result<Value> {
        let snap = self.conflict_snapshot(p)?;
        let mut value = json!({"path":p,"revision":snap["revision"]});
        let mut binary = false;
        for (label, n) in [("ours", "2"), ("theirs", "3"), ("base", "1")] {
            let b = self.stage_bytes(&snap["stages"][n])?;
            let bin = b
                .as_ref()
                .is_some_and(|b| b.contains(&0) || std::str::from_utf8(b).is_err());
            binary |= bin;
            value[label] = json!({"deleted":b.is_none(),"binary":bin,"text":if bin{String::new()}else{String::from_utf8_lossy(b.as_deref().unwrap_or(&[])).into_owned()}});
        }
        let bytes: Option<Vec<u8>> = serde_json::from_value(snap["bytes"].clone()).map_err(err)?;
        binary |= bytes
            .as_ref()
            .is_some_and(|b| b.contains(&0) || std::str::from_utf8(b).is_err());
        value["binary"] = json!(binary);
        value["deleted"] = json!(bytes.is_none());
        value["text"] = json!(if binary {
            String::new()
        } else {
            String::from_utf8_lossy(bytes.as_deref().unwrap_or(&[])).into_owned()
        });
        Ok(value)
    }
    pub fn diff(&self, args: &Value) -> Result<Value> {
        self.require()?;
        let p = self.safe(s(args, "path"), true)?;
        if args["conflict"] == true {
            return self.conflict(&p);
        }
        if !s(args, "pullId").is_empty() {
            let item = self
                .pulls
                .as_array()
                .unwrap()
                .iter()
                .find(|v| v["to"] == args["pullId"])
                .ok_or("Choose a recently pulled change.")?;
            let changed = item["files"]
                .as_array()
                .unwrap()
                .iter()
                .find(|v| v["path"] == p)
                .ok_or("Choose a file from recently pulled changes.")?;
            let mut cmd = vec![
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--unified=5",
                s(item, "from"),
                s(item, "to"),
                "--",
                &p,
            ];
            if let Some(previous) = changed["previousPath"].as_str() {
                self.safe(previous, true)?;
                cmd.push(previous);
            }
            let text = self.output(&cmd)?;
            return Ok(
                json!({"path":p,"text":text,"pulled":true,"deleted":changed["status"]=="D","from":item["from"],"to":item["to"],"binary":text.contains("\nBinary files ")}),
            );
        }
        let state = self.status()?;
        let entry = state["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["path"] == p);
        if entry.is_none() {
            return Ok(json!({"path":p,"staged":args["staged"]==true,"text":"","empty":true}));
        }
        let entry = entry.unwrap();
        if entry["untracked"] == true {
            let full = self.root.join(&p);
            if fs::metadata(&full).map_err(err)?.len() > 1024 * 1024 {
                return Ok(
                    json!({"path":p,"binary":true,"text":"New file is too large to preview (maximum 1 MB)."}),
                );
            }
            let b = fs::read(full).map_err(err)?;
            let binary = b.contains(&0) || std::str::from_utf8(&b).is_err();
            let text = if binary {
                "Binary file — preview unavailable.".into()
            } else {
                let content = String::from_utf8_lossy(&b).replace("\r\n", "\n");
                let lines: Vec<_> = content.lines().collect();
                format!("diff --git a/{p} b/{p}\nnew file\n--- /dev/null\n+++ b/{p}\n@@ -0,0 +1,{} @@\n{}",lines.len(),lines.iter().map(|s|format!("+{s}")).collect::<Vec<_>>().join("\n"))
            };
            return Ok(json!({"path":p,"staged":false,"text":text,"binary":binary}));
        }
        let mut command = vec![
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--unified=5",
        ];
        if args["staged"] == true {
            command.push("--cached");
        }
        command.extend(["--", &p]);
        if let Some(previous) = entry["previousPath"].as_str() {
            self.safe(previous, true)?;
            command.push(previous);
        }
        let text = self.output(&command)?;
        Ok(
            json!({"path":p,"staged":args["staged"]==true,"binary":text.contains("\nBinary files "),"text":text}),
        )
    }
    /// Recent commits, newest first: `limit` (1–200, default 40) after
    /// `skip`, optionally only those that changed `path`. Snapshots that Weave
    /// made are marked `snapshot` with their kind.
    pub fn history(&self, args: &Value) -> Result<Value> {
        self.require()?;
        let limit = format!("-{}", args["limit"].as_u64().unwrap_or(40).clamp(1, 200));
        let skip = format!("--skip={}", args["skip"].as_u64().unwrap_or(0).min(1_000_000));
        let path = match s(args, "path") {
            "" => None,
            p if private(p) => return Err("Choose a file inside this repository.".into()),
            p => Some(self.safe(p, true)?),
        };
        let mut command = vec![
            "log",
            &limit,
            &skip,
            "--date=iso-strict",
            "--format=%H%x00%h%x00%an%x00%ad%x00%s%x00%D%x00%(trailers:key=Weave-Snapshot,valueonly,separator=%x2C)%x1e",
        ];
        if let Some(p) = &path {
            command.extend(["--", p.as_str()]);
        }
        let (code, out, e) = self.run(&command, true, None)?;
        if code != 0 {
            if e.contains("does not have any commits") {
                return Ok(json!([]));
            }
            return Err(e);
        }
        Ok(json!(out.split('\u{1e}').filter_map(|r|{let p:Vec<_>=r.trim().split('\0').collect();(p.len()>=6).then(||{let kind=p.get(6).map(|k|k.trim()).unwrap_or("");json!({"id":p[0],"short":p[1],"author":p[2],"date":p[3],"subject":redact(p[4]),"refs":p[5],"snapshot":if kind.is_empty(){Value::Null}else{json!(kind)}})})}).collect::<Vec<_>>()))
    }
    /// One commit's changes, with the files it changed (`files`: path and
    /// status letter). With `path`, only that file's changes are shown.
    pub fn commit_diff(&self, args: &Value) -> Result<Value> {
        self.require()?;
        let id = commit_id(s(args, "id"))?;
        let names = self.output(&[
            "diff-tree",
            "--no-commit-id",
            "--name-status",
            "--no-renames",
            "-r",
            "-z",
            "--root",
            id,
        ])?;
        let mut files = vec![];
        let mut it = names.split('\0').filter(|p| !p.is_empty());
        while let (Some(status), Some(p)) = (it.next(), it.next()) {
            if !private(p) {
                self.safe(p, true)?;
                files.push(json!({"path":p,"status":&status[..1]}));
            }
        }
        let wanted = s(args, "path");
        let paths: Vec<&str> = files
            .iter()
            .map(|f| s(f, "path"))
            .filter(|p| wanted.is_empty() || *p == wanted)
            .collect();
        let title = if wanted.is_empty() { &id[..8] } else { wanted };
        if paths.is_empty() {
            return Ok(json!({"path":title,"files":files,"text":"This commit has no viewable file changes."}));
        }
        let mut cmd = vec![
            "show",
            "--format=fuller",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--stat",
            "--patch",
            "--unified=3",
            id,
            "--",
        ];
        cmd.extend(paths);
        let text = self.output(&cmd)?;
        Ok(json!({"path":title,"files":files,"text":text}))
    }
    fn record_pull(&mut self, from: &str, remote: &str, branch: &str) -> Result<()> {
        let to = self.output(&["rev-parse", "HEAD"])?.trim().to_string();
        if from == to {
            return Ok(());
        }
        let raw = self.output(&[
            "diff",
            "--name-status",
            "-z",
            "--find-renames",
            from,
            &to,
            "--",
        ])?;
        let mut it = raw.split('\0');
        let mut files = vec![];
        while let Some(status) = it.next() {
            if status.is_empty() {
                continue;
            }
            let Some(mut p) = it.next() else {
                break;
            };
            let mut previous = None;
            if status.starts_with(['R', 'C']) {
                previous = Some(p);
                p = it.next().unwrap_or("");
            }
            if !private(p) && !previous.is_some_and(private) {
                let mut file = json!({"path":p,"status":&status[..1]});
                if let Some(previous) = previous {
                    file["previousPath"] = json!(previous);
                }
                files.push(file);
            }
        }
        let total = files.len();
        files.truncate(200);
        let a = self.pulls.as_array_mut().unwrap();
        a.insert(0,json!({"from":from,"to":to,"remote":remote,"branch":branch,"at":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"totalFiles":total,"files":files}));
        a.truncate(5);
        Ok(())
    }
    fn push(&self, args: &Value, state: &Value, remote: &str, branch: &str) -> Result<String> {
        let fallback = if args["remote"].is_string() {
            json!([remote])
        } else {
            state["pushRemotes"].clone()
        };
        let names = args
            .get("pushRemotes")
            .unwrap_or(&fallback)
            .as_array()
            .ok_or("Choose push remotes.")?;
        if names.is_empty() || names.len() > 100 {
            return Err("Select at least one existing remote for pushes.".into());
        }
        for n in names {
            if !state["remotes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["name"] == *n)
            {
                return Err("Choose existing push remotes.".into());
            }
        }
        let mut errors = vec![];
        let mut done = vec![];
        for n in names {
            let name = n.as_str().ok_or("Invalid remote")?;
            let target = format!(
                "{}:refs/heads/{}",
                reference(s(state, "branch"))?,
                reference(if name == remote {
                    branch
                } else {
                    s(state, "branch")
                })?
            );
            let mut cmd = vec!["push"];
            if name == remote {
                cmd.push("--set-upstream");
            }
            cmd.extend(["--", name, &target]);
            match self.output(&cmd) {
                Ok(_) => done.push(name),
                Err(e) => errors.push(format!("{name}: {e}")),
            }
        }
        if !errors.is_empty() {
            return Err(format!(
                "Pushed to {}. Push failed for {}. Successful pushes are retained.",
                done.join(", "),
                errors.join("; ")
            ));
        }
        Ok(format!("Pushed to {}.", done.join(", ")))
    }
    /// Why Git cannot take a snapshot now, or `None`: never during a merge,
    /// rebase or cherry-pick, on a detached HEAD, while another Git process
    /// holds the index, or while changes are staged for a manual commit.
    fn snapshot_blocked(&self, state: &Value) -> Result<Option<&'static str>> {
        let entries = state["files"].as_array().unwrap();
        let paths = self.output(&[
            "rev-parse",
            "--git-path",
            "index.lock",
            "--git-path",
            "rebase-merge",
            "--git-path",
            "rebase-apply",
            "--git-path",
            "CHERRY_PICK_HEAD",
            "--git-path",
            "REVERT_HEAD",
        ])?;
        let mut paths = paths.lines().map(|p| self.root.join(p.trim()).exists());
        Ok(if paths.next() == Some(true) {
            Some("Another Git program is using this repository. Snapshots resume when it finishes.")
        } else if state["detached"] == true {
            Some("Snapshots wait while no branch is checked out.")
        } else if state["merging"] == true || paths.any(|p| p) {
            Some("Snapshots wait until the merge, rebase or cherry-pick is finished.")
        } else if entries.iter().any(|f| f["conflict"] == true) {
            Some("Snapshots wait until merge conflicts are resolved.")
        } else if state["privateStaged"] == true
            || entries.iter().any(|f| f["untracked"] != true && f["index"] != ".")
        {
            Some("Snapshots wait while changes are staged for a manual commit.")
        } else {
            None
        })
    }
    /// The file in the repository's Git directory naming the Weave process
    /// that takes this repository's automatic snapshots.
    fn lease_file(&self) -> Result<fs::File> {
        let common = self.output(&["rev-parse", "--git-common-dir"])?;
        let path = self.root.join(common.trim()).join("weave-snapshots.lease");
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .map_err(err)?;
        file.lock_exclusive().map_err(err)?;
        Ok(file)
    }
    /// Takes or renews the snapshot lease for `owner`. False while another
    /// Weave process holds an unexpired lease, so one scheduler commits per
    /// repository even when several Weave hosts open it.
    pub fn lease(&self, owner: &str) -> Result<bool> {
        let mut file = self.lease_file()?;
        let mut text = String::new();
        let _ = file.read_to_string(&mut text);
        let held: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        let now = unix_now();
        let mine = held["owner"].as_str().is_none_or(|o| o == owner)
            || held["at"].as_u64().is_none_or(|at| now.saturating_sub(at) > LEASE_SECONDS);
        if mine {
            file.set_len(0).map_err(err)?;
            std::io::Seek::rewind(&mut file).map_err(err)?;
            file.write_all(json!({"owner":owner,"at":now}).to_string().as_bytes())
                .map_err(err)?;
        }
        let _ = FileExt::unlock(&file);
        Ok(mine)
    }
    /// Gives up `owner`'s lease so another Weave process can take over at once.
    pub fn release_lease(&self, owner: &str) {
        if self.repository().is_ok_and(|r| r["repository"] == true) {
            if let Ok(mut file) = self.lease_file() {
                let mut text = String::new();
                let _ = file.read_to_string(&mut text);
                let held: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                if held["owner"] == owner {
                    let _ = file.set_len(0);
                }
                let _ = FileExt::unlock(&file);
            }
        }
    }
    /// Commits every change (respecting `.gitignore`, never private Weave
    /// data) as a snapshot of `kind`: `automatic`, `close`, `manual`,
    /// `restore` (before a restore) or `restored`. Returns `committed: false`
    /// with `skipped` when it must not commit now, and leaves a manual
    /// commit's staged changes alone. With `owner`, only the lease holder
    /// commits. Snapshots run no hooks and are never signed, so they cannot
    /// wait for input; without a configured author they are signed as Weave.
    pub fn snapshot(&mut self, kind: &str, subject: Option<String>, push: bool, owner: Option<&str>) -> Result<Value> {
        self.require()?;
        if let Some(owner) = owner {
            if !self.lease(owner)? {
                return Ok(json!({"committed":false,"skipped":"Another Weave app or server takes this repository's snapshots."}));
            }
        }
        let state = self.status()?;
        if let Some(reason) = self.snapshot_blocked(&state)? {
            self.snapshot_state["skipped"] = json!(reason);
            // Blocked by work in progress: the scheduler retries soon.
            return Ok(json!({"committed":false,"skipped":reason,"waiting":true}));
        }
        self.snapshot_state["skipped"] = Value::Null;
        let entries = state["files"].as_array().unwrap();
        if entries.is_empty() {
            return Ok(json!({"committed":false,"message":"No changes since the last snapshot."}));
        }
        let mut paths = vec![];
        for f in entries {
            paths.push(self.safe(s(f, "path"), true)?);
        }
        let staged = (|| -> Result<()> {
            for batch in paths.chunks(100) {
                let mut cmd = vec!["add", "--all", "--"];
                cmd.extend(batch.iter().map(String::as_str));
                self.output(&cmd)?;
            }
            Ok(())
        })();
        let count = paths.len();
        let subject = subject.unwrap_or_else(|| {
            format!(
                "{} · {count} {}",
                match kind {
                    "close" => "Snapshot when Weave closed",
                    "manual" => "Snapshot",
                    "restore" => "Snapshot before restoring",
                    _ => "Automatic snapshot",
                },
                if count == 1 { "file" } else { "files" }
            )
        });
        let mut message = format!("{subject}\n\n");
        for p in paths.iter().take(20) {
            message.push_str(&format!("- {p}\n"));
        }
        if count > 20 {
            message.push_str(&format!("- and {} more\n", count - 20));
        }
        message.push_str(&format!("\nWeave-Snapshot: {kind}\n"));
        let unnamed = s(&state["identity"], "name").is_empty() || s(&state["identity"], "email").is_empty();
        let mut cmd = vec![];
        if unnamed {
            cmd.extend(["-c", "user.name=Weave", "-c", "user.email=snapshots@weave.invalid"]);
        }
        cmd.extend(["-c", "commit.gpgsign=false", "commit", "--no-verify", "--quiet", "--file=-"]);
        if let Err(e) = staged.and_then(|_| self.run(&cmd, false, Some(message.as_bytes())).map(|_| ())) {
            // Leave the index as it was: nothing was staged before.
            for batch in paths.chunks(100) {
                let mut cmd = if state["unborn"] == true {
                    vec!["rm", "--cached", "--force", "--ignore-unmatch", "--quiet", "--"]
                } else {
                    vec!["restore", "--staged", "--"]
                };
                cmd.extend(batch.iter().map(String::as_str));
                let _ = self.run(&cmd, true, None);
            }
            self.snapshot_state["error"] = json!(e);
            return Err(e);
        }
        let id = self.output(&["rev-parse", "HEAD"])?.trim().to_string();
        let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        self.snapshot_state["last"] = json!({"id":id,"at":at,"files":count,"kind":kind});
        self.snapshot_state["error"] = Value::Null;
        self.snapshot_state["pushError"] = Value::Null;
        let mut result = json!({"committed":true,"id":id,"files":count,"message":format!("{subject}.")});
        if push {
            let state = self.status()?;
            let remote = s(&state, "syncRemote").to_string();
            if !remote.is_empty() && state["pushRemotes"].as_array().is_some_and(|r| !r.is_empty()) {
                let branch = s(&state, "upstream")
                    .strip_prefix(&format!("{remote}/"))
                    .unwrap_or(s(&state, "branch"))
                    .to_string();
                let pushed = if self.hosts.is_empty() {
                    Ok(())
                } else {
                    state["remotes"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter(|r| state["pushRemotes"].as_array().unwrap().contains(&r["name"]))
                        .flat_map(|r| [s(r, "fetch"), s(r, "push")])
                        .filter(|u| !u.is_empty())
                        .try_for_each(|u| self.allowed_host(u))
                }
                .and_then(|_| self.push(&json!({}), &state, &remote, &branch));
                match pushed {
                    Ok(text) => {
                        self.snapshot_state["last"]["pushed"] = json!(true);
                        result["message"] = json!(format!("{subject}. {text}"));
                    }
                    Err(e) => {
                        self.snapshot_state["pushError"] = json!(e);
                        result["pushError"] = json!(e);
                    }
                }
            }
        }
        Ok(result)
    }
    /// Fetches the sync remote in the background, recording the outcome in
    /// `fetch_state`. Never merges: incoming changes wait for Pull or Sync.
    pub fn auto_fetch_now(&mut self) -> Result<Value> {
        self.require()?;
        let state = self.status()?;
        let remote = s(&state, "syncRemote").to_string();
        if remote.is_empty() {
            self.fetch_state["error"] = Value::Null;
            return Ok(json!({"fetched":false}));
        }
        let result = (|| -> Result<()> {
            for r in state["remotes"].as_array().unwrap().iter().filter(|r| s(r, "name") == remote) {
                for url in [s(r, "fetch"), s(r, "push")] {
                    if !url.is_empty() {
                        self.allowed_host(url)?;
                    }
                }
            }
            self.output(&["fetch", "--prune", "--", &remote]).map(|_| ())
        })();
        let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        self.fetch_state = json!({"lastAutoFetch":at,"error":result.as_ref().err()});
        result?;
        Ok(json!({"fetched":true}))
    }
    /// A restore source: the commit itself, or with `before` its parent.
    fn restore_source(&self, args: &Value) -> Result<String> {
        let id = commit_id(s(args, "id"))?;
        if args["before"] != true {
            return Ok(id.into());
        }
        let parent = format!("{id}^");
        if self.run(&["rev-parse", "--verify", "-q", &parent], true, None)?.0 != 0 {
            return Err("This file was added in that commit; there is no earlier version.".into());
        }
        Ok(parent)
    }
    /// Before a restore overwrites files, records current changes as a
    /// snapshot when snapshots are on (their history keeps both versions).
    fn snapshot_before_restore(&mut self) -> Result<()> {
        if self.snapshots["enabled"] == true {
            self.snapshot("restore", None, false, None)?;
        }
        Ok(())
    }
    pub fn action(&mut self, args: &Value) -> Result<Value> {
        let action = s(args, "action");
        if action == "init" {
            let r = self.repository()?;
            if r["repository"] == true || r["parentRepository"].is_string() {
                return Err("This folder already belongs to a Git repository.".into());
            }
            self.output(&["init", "--initial-branch=main"])?;
            return Ok(json!({"message":"Initialized Git repository.","status":self.status()?}));
        }
        if action == "createDeployKey" {
            let name: String = self
                .root
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || "-_.".contains(*c))
                .take(60)
                .collect();
            let key = self.create_deploy_key(args["replace"] == true, &format!("weave-{name}"))?;
            return Ok(json!({"message":"Deploy key created. Add it to your repository's deploy keys.","deployKey":key,"status":self.status()?}));
        }
        if action == "removeDeployKey" {
            if args["confirmed"] != true {
                return Err("Confirm removing the deploy key.".into());
            }
            if let Some(dir) = self.key_dir() {
                if dir.exists() {
                    fs::remove_dir_all(dir).map_err(err)?;
                }
            }
            return Ok(json!({"message":"Deploy key removed. Also delete it from your repository's deploy keys.","status":self.status()?}));
        }
        self.require()?;
        let state = self.status()?;
        let entries = state["files"].as_array().unwrap();
        let mut message = "Git operation completed.".to_string();
        let mut extra = json!({});
        // The server may limit which hosts its remotes reach.
        if !self.hosts.is_empty()
            && [
                "fetch",
                "pull",
                "push",
                "sync",
                "testRemote",
                "useRemoteBranch",
            ]
            .contains(&action)
        {
            let mut names = vec![json!(if s(args, "remote").is_empty() {
                s(&state, "syncRemote")
            } else {
                s(args, "remote")
            })];
            if ["push", "sync"].contains(&action) {
                names.extend(
                    args.get("pushRemotes")
                        .unwrap_or(&state["pushRemotes"])
                        .as_array()
                        .cloned()
                        .unwrap_or_default(),
                );
            }
            for name in names {
                for remote in state["remotes"].as_array().unwrap() {
                    if remote["name"] == name {
                        for url in [s(remote, "fetch"), s(remote, "push")] {
                            if !url.is_empty() {
                                self.allowed_host(url)?;
                            }
                        }
                    }
                }
            }
        }
        match action {
            "configureAutoFetch" => {
                let mut next = self.auto_fetch.clone();
                for key in ["enabled", "minutes"] {
                    if let Some(v) = args.get(key) {
                        next[key] = v.clone();
                    }
                }
                self.auto_fetch = fetch_settings(&next)?;
                if self.auto_fetch["enabled"] != true {
                    self.fetch_state["error"] = Value::Null;
                }
                message = if self.auto_fetch["enabled"] == true {
                    format!("Weave fetches every {} minutes.", self.auto_fetch["minutes"])
                } else {
                    "Automatic fetching is off.".into()
                };
            }
            "configureSnapshots" => {
                let mut next = self.snapshots.clone();
                for key in ["enabled", "trigger", "minutes", "push", "onClose"] {
                    if let Some(v) = args.get(key) {
                        next[key] = v.clone();
                    }
                }
                self.snapshots = snapshot_settings(&next)?;
                if self.snapshots["enabled"] != true {
                    self.snapshot_state["skipped"] = Value::Null;
                }
                message = if self.snapshots["enabled"] == true {
                    "Automatic snapshots are on."
                } else {
                    "Automatic snapshots are off."
                }
                .into();
            }
            "snapshot" => {
                let push = self.snapshots["push"] == true;
                let result = self.snapshot("manual", None, push, None)?;
                message = if let Some(reason) = result["skipped"].as_str() {
                    return Err(reason.into());
                } else {
                    s(&result, "message").into()
                };
                if let Some(e) = result["pushError"].as_str() {
                    message = format!("{message} Push failed: {e}");
                }
            }
            "restoreFile" => {
                if args["confirmed"] != true {
                    return Err("Confirm before restoring an earlier version.".into());
                }
                let p = s(args, "path");
                if private(p) {
                    return Err("Choose a file inside this repository.".into());
                }
                let p = self.safe(p, true)?;
                let source = self.restore_source(args)?;
                if self.run(&["cat-file", "-e", &format!("{source}:{p}")], true, None)?.0 != 0 {
                    return Err("This file does not exist in that version.".into());
                }
                if entries.iter().any(|f| f["conflict"] == true && f["path"] == p) {
                    return Err("Resolve this file's merge conflict first.".into());
                }
                self.snapshot_before_restore()?;
                self.output(&["restore", "--worktree", &format!("--source={source}"), "--", &p])?;
                message = format!("Restored {p}.");
                extra = json!({"restoredPaths":[p]});
            }
            "restoreSnapshot" => {
                if args["confirmed"] != true {
                    return Err("Confirm before restoring a snapshot.".into());
                }
                if state["merging"] == true || entries.iter().any(|f| f["conflict"] == true) {
                    return Err("Finish the merge before restoring a snapshot.".into());
                }
                let source = self.restore_source(args)?;
                self.snapshot_before_restore()?;
                let names = self.output(&["diff", "--name-only", "--no-renames", "-z", &source, "--"])?;
                let mut paths = vec![];
                for p in names.split('\0').filter(|p| !p.is_empty() && !private(p)) {
                    paths.push(self.safe(p, true)?);
                }
                for batch in paths.chunks(100) {
                    let mut cmd = vec!["restore", "--worktree", "--source", &source, "--"];
                    cmd.extend(batch.iter().map(String::as_str));
                    self.output(&cmd)?;
                }
                let date = self.output(&["show", "-s", "--format=%cd", "--date=format:%Y-%m-%d %H:%M", &source])?;
                message = if paths.is_empty() {
                    "The workspace already matches this snapshot.".into()
                } else {
                    format!("Restored {} {} from {}.", paths.len(), if paths.len() == 1 { "file" } else { "files" }, date.trim())
                };
                if !paths.is_empty() && self.snapshots["enabled"] == true {
                    let subject = format!("Restored snapshot of {} ({})", date.trim(), &source[..8.min(source.len())]);
                    let result = self.snapshot("restored", Some(subject), false, None)?;
                    if let Some(reason) = result["skipped"].as_str() {
                        message = format!("{message} {reason}");
                    }
                }
                extra = json!({"restoredPaths":paths});
            }
            "configureIdentity" => {
                let name = identity_field(s(args, "name"), "name")?;
                let email = identity_field(s(args, "email"), "email address")?;
                if !email.contains('@') || email.contains(char::is_whitespace) {
                    return Err("Enter an email address such as you@example.com.".into());
                }
                self.output(&["config", "user.name", &name])?;
                self.output(&["config", "user.email", &email])?;
                message = "Commit author saved for this repository.".into();
            }
            "testRemote" => {
                let remote = s(args, "remote");
                if !state["remotes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| s(r, "name") == remote)
                {
                    return Err("Add the remote first.".into());
                }
                let listed = self.output(&["ls-remote", "--symref", remote]).map_err(|e| {
                    let lower = e.to_lowercase();
                    if lower.contains("permission denied") || lower.contains("publickey") {
                        format!("The remote refused this deploy key. Check that it was added to the repository's deploy keys (with write access), then retry. {e}")
                    } else if lower.contains("host key verification failed")
                        || lower.contains("remote host identification has changed")
                    {
                        format!("The server's SSH host key did not match the one recorded earlier. {e}")
                    } else if lower.contains("could not read from remote")
                        || lower.contains("not found")
                    {
                        format!("The repository was not found, or this key cannot reach it. Check the URL and the deploy key. {e}")
                    } else {
                        e
                    }
                })?;
                let mut branches = vec![];
                let mut default = Value::Null;
                for line in listed.lines() {
                    if let Some(rest) = line.strip_prefix("ref: refs/heads/") {
                        if let Some((branch, head)) = rest.split_once('\t') {
                            if head == "HEAD" {
                                default = json!(branch);
                            }
                        }
                    } else if let Some((_, name)) = line.split_once('\t') {
                        if let Some(branch) = name.strip_prefix("refs/heads/") {
                            branches.push(json!(branch));
                        }
                    }
                }
                if default.is_null() {
                    default = branches
                        .iter()
                        .find(|b| *b == "main" || *b == "master")
                        .or(branches.first())
                        .cloned()
                        .unwrap_or(Value::Null);
                }
                message = if branches.is_empty() {
                    "Connected. The remote repository is empty.".into()
                } else {
                    format!(
                        "Connected. The remote has {} {}.",
                        branches.len(),
                        if branches.len() == 1 { "branch" } else { "branches" }
                    )
                };
                extra = json!({"connected":true,"remoteBranches":branches,"defaultBranch":default});
            }
            "useRemoteBranch" => {
                // A new repository adopts the remote's history, keeping any
                // files here that the remote does not have.
                if state["unborn"] != true {
                    return Err("This repository already has commits. Use Sync to combine them with the remote.".into());
                }
                if entries.iter().any(|f| f["untracked"] != true) {
                    return Err("Unstage changes before using the remote branch.".into());
                }
                let remote = s(args, "remote");
                if !state["remotes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| s(r, "name") == remote)
                {
                    return Err("Add the remote first.".into());
                }
                let branch = reference(s(args, "branch"))?;
                self.output(&["fetch", "--prune", "--", remote])?;
                let tracking = format!("{remote}/{branch}");
                self.output(&["checkout", "--track", "-b", branch, &tracking])
                    .map_err(|e| {
                        if e.contains("would be overwritten") {
                            format!("Files here have the same names as files in the remote repository. Move or rename them, then retry. {e}")
                        } else {
                            e
                        }
                    })?;
                message = format!("Downloaded {tracking}. This workspace now follows it.");
                self.preferences = json!({"syncRemote":remote,"pushRemotes":[remote]});
            }
            "configureRemotes" => {
                let remote = s(args, "remote");
                let names = args["pushRemotes"]
                    .as_array()
                    .ok_or("Choose existing remotes for pushes.")?;
                let valid = |name: &Value| {
                    state["remotes"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|r| r["name"] == *name)
                };
                if !valid(&json!(remote)) || names.len() > 100 || names.iter().any(|n| !valid(n)) {
                    return Err("Choose existing remotes.".into());
                }
                self.preferences = json!({"syncRemote":remote,"pushRemotes":names});
            }
            "saveIgnore" => {
                let old = self.ignore()?;
                if args["revision"] != old["revision"] {
                    return Err(".gitignore changed outside Weave. Your draft is retained.".into());
                }
                let text = s(args, "text");
                if !args["text"].is_string() || text.len() > 1024 * 1024 || text.contains('\0') {
                    return Err("Use text of at most 1 MB.".into());
                }
                let text = if s(&old, "text").contains("\r\n") {
                    text.replace("\r\n", "\n").replace('\n', "\r\n")
                } else {
                    text.into()
                };
                let bytes = files::encode(
                    &text,
                    old["format"]["encoding"] == "utf16le",
                    old["format"]["bom"] == true,
                );
                let full = files::checked_options(&self.root, ".gitignore", true, true)?;
                files::replace(&full, &bytes, old["revision"].as_str())?;
            }
            "stage" | "stageAll" | "unstage" | "unstageAll" => {
                let staging = action.starts_with("stage");
                let selected: Vec<_> = entries
                    .iter()
                    .filter(|f| {
                        if action.ends_with("All") {
                            if staging {
                                f["untracked"] == true
                                    || f["worktree"] != "."
                                    || f["conflict"] == true
                            } else {
                                f["untracked"] != true && f["index"] != "."
                            }
                        } else {
                            f["path"] == args["path"]
                        }
                    })
                    .collect();
                if selected.is_empty() {
                    return Err("There are no matching changes. Refresh Source control.".into());
                }
                let mut paths = vec![];
                for f in selected {
                    if staging && f["conflict"] == true {
                        let c = self.conflict(s(f, "path"))?;
                        if c["binary"] == true
                            || c["ours"]["deleted"] == true
                            || c["theirs"]["deleted"] == true
                            || markers(s(&c, "text"))
                        {
                            return Err("Resolve conflict markers before staging. Choose a version in the conflict resolver for binary or deleted files.".into());
                        }
                    }
                    paths.push(self.safe(s(f, "path"), true)?);
                    if let Some(p) = f["previousPath"].as_str() {
                        paths.push(self.safe(p, true)?);
                    }
                }
                for batch in paths.chunks(100) {
                    let mut cmd = if staging {
                        vec!["add", "--all", "--"]
                    } else if state["unborn"] == true {
                        vec!["rm", "--cached", "--force", "--ignore-unmatch", "--"]
                    } else {
                        vec!["restore", "--staged", "--"]
                    };
                    cmd.extend(batch.iter().map(String::as_str));
                    message = self.output(&cmd)?;
                }
            }
            "commit" => {
                if state["privateStaged"] == true {
                    return Err(
                        "Private Weave data is staged. Unstage it before committing.".into(),
                    );
                }
                if entries.iter().any(|f| f["conflict"] == true) {
                    return Err("Resolve and stage all conflicted files before committing.".into());
                }
                let input = if s(args, "message").trim().is_empty() {
                    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                } else {
                    s(args, "message").trim().into()
                };
                if input.len() > 10000 || input.contains('\0') {
                    return Err("Use a commit message of at most 10,000 characters.".into());
                }
                message = self
                    .run(&["commit", "--file=-"], false, Some(input.as_bytes()))
                    .map_err(|e| {
                        if e.contains("tell me who you are") || e.contains("empty ident") {
                            "Set the commit author name and email in Git setup, then retry.".into()
                        } else {
                            e
                        }
                    })?
                    .1;
            }
            "fetch" | "pull" | "push" | "sync" => {
                let remote = if s(args, "remote").is_empty() {
                    s(&state, "syncRemote")
                } else {
                    s(args, "remote")
                };
                if !state["remotes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| s(r, "name") == remote)
                {
                    return Err("Choose or add a Git remote first.".into());
                }
                let branch = s(&state, "upstream")
                    .strip_prefix(&format!("{remote}/"))
                    .unwrap_or(s(&state, "branch"));
                if action == "sync" || action == "push" {
                    let fallback = if args["remote"].is_string() {
                        json!([remote])
                    } else {
                        state["pushRemotes"].clone()
                    };
                    let names = args
                        .get("pushRemotes")
                        .unwrap_or(&fallback)
                        .as_array()
                        .ok_or("Choose existing remotes for pushes.")?;
                    if names.is_empty() {
                        return Err("Select at least one existing remote for pushes.".into());
                    }
                    if names.len() > 100
                        || names.iter().any(|n| {
                            !state["remotes"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .any(|r| r["name"] == *n)
                        })
                    {
                        return Err("Choose existing remotes for pushes.".into());
                    }
                    if action == "sync" {
                        let text = s(args, "message");
                        if text.len() > 10000
                            || text.contains('\0')
                            || args
                                .get("message")
                                .is_some_and(|v| !v.is_null() && !v.is_string())
                        {
                            return Err("Use a commit message of at most 10,000 characters.".into());
                        }
                    }
                }
                if action == "fetch" {
                    message = self.output(&["fetch", "--prune", "--", remote])?;
                } else {
                    if state["detached"] == true || (action != "sync" && state["unborn"] == true) {
                        return Err(
                            "Create a commit on a named branch before pulling or pushing.".into(),
                        );
                    }
                    reference(branch)?;
                    if action == "push" {
                        message = self.push(args, &state, remote, branch)?;
                    } else if action == "pull" {
                        if !entries.is_empty() {
                            return Err("Commit or stash your changes before pulling.".into());
                        }
                        if s(&state, "upstream").is_empty() {
                            return Err(
                                "Push this branch to set its upstream before pulling.".into()
                            );
                        }
                        message = self.output(&[
                            "pull",
                            "--ff-only",
                            "--no-rebase",
                            "--",
                            remote,
                            branch,
                        ])?;
                        self.record_pull(s(&state, "oid"), remote, branch)?;
                    } else {
                        if state["privateStaged"] == true
                            || entries.iter().any(|f| f["conflict"] == true)
                        {
                            return Err("Resolve and stage conflicts and unstage private data before syncing.".into());
                        }
                        let mut committed = false;
                        let mut phase = "commit";
                        let result = (|| -> Result<String> {
                            if !entries.is_empty() || state["merging"] == true {
                                if entries
                                    .iter()
                                    .any(|f| f["untracked"] == true || f["worktree"] != ".")
                                {
                                    self.action(&json!({"action":"stageAll"}))?;
                                }
                                self.action(&json!({"action":"commit","message":args["message"]}))?;
                                committed = true;
                            }
                            let before = self.output(&["rev-parse", "HEAD"])?.trim().to_string();
                            phase = "fetch";
                            self.output(&["fetch", "--prune", "--", remote])?;
                            let remote_ref = format!("refs/remotes/{remote}/{branch}");
                            if self
                                .run(
                                    &["show-ref", "--verify", "--quiet", &remote_ref],
                                    true,
                                    None,
                                )?
                                .0
                                == 0
                            {
                                phase = "merge";
                                self.output(&[
                                    "merge",
                                    "--ff",
                                    "--no-edit",
                                    "--no-autostash",
                                    &remote_ref,
                                ])?;
                                self.record_pull(&before, remote, branch)?;
                            }
                            phase = "push";
                            self.push(args, &state, remote, branch)
                        })();
                        message=result.map_err(|e|format!("{}Sync stopped during {phase}. Resolve merge conflicts before retrying. {e}",if committed{"Changes were committed locally. "}else{""}))?;
                    }
                }
            }
            "switch" | "createBranch" => {
                if !entries.is_empty() {
                    return Err("Commit or stash your changes before switching branches.".into());
                }
                let name = reference(s(args, "branch"))?;
                if action == "switch"
                    && !state["branches"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|b| s(b, "name") == name)
                {
                    return Err("Choose an existing local branch.".into());
                }
                message =
                    self.output(&["switch", if action == "switch" { "--" } else { "-c" }, name])?;
            }
            "addRemote" => {
                let name = s(args, "name");
                if name.is_empty()
                    || name.len() > 100
                    || !name.as_bytes()[0].is_ascii_alphanumeric()
                    || !name
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
                {
                    return Err("Use a valid remote name.".into());
                }
                let u = s(args, "url");
                remote_url(u)?;
                self.allowed_host(u)?;
                let exists = state["remotes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| s(r, "name") == name);
                // Setup replaces an existing remote's address when asked.
                message = if exists && args["replace"] == true {
                    self.output(&["remote", "set-url", name, u])?;
                    format!("Remote {name} now uses {u}.")
                } else {
                    self.output(&["remote", "add", name, u])?;
                    format!("Remote {name} added.")
                };
            }
            "stash" => {
                if state["unborn"] == true || entries.iter().any(|f| f["conflict"] == true) {
                    return Err("Stashing needs a commit and no unresolved conflicts.".into());
                }
                let mut paths = vec![];
                for f in entries.iter().filter(|f| f["untracked"] != true) {
                    paths.push(self.safe(s(f, "path"), true)?);
                    if let Some(p) = f["previousPath"].as_str() {
                        paths.push(self.safe(p, true)?);
                    }
                }
                if paths.is_empty() {
                    return Err("Stage new files first to include them in a stash.".into());
                }
                let mut cmd = vec!["stash", "push", "-m", "Weave workspace changes", "--"];
                cmd.extend(paths.iter().map(String::as_str));
                message = self.output(&cmd)?;
            }
            "applyStash" => {
                if !entries.is_empty() {
                    return Err("Commit or stash current changes before applying a stash.".into());
                }
                let r = s(args, "ref");
                if !state["stashes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|v| s(v, "ref") == r)
                {
                    return Err("Choose an existing stash.".into());
                }
                message = self.output(&["stash", "apply", r])?;
            }
            "discard" => {
                if args["confirmed"] != true {
                    return Err("Confirm before discarding working changes.".into());
                }
                let p = self.safe(s(args, "path"), true)?;
                let entry = entries
                    .iter()
                    .find(|f| f["path"] == p)
                    .ok_or("Refresh Source control before discarding.")?;
                if args["untracked"] == true {
                    if entry["untracked"] != true {
                        return Err("This file is no longer untracked.".into());
                    }
                    let full = self.root.join(&p);
                    if !fs::metadata(&full).map_err(err)?.is_file() {
                        return Err("Only ordinary untracked files can be deleted.".into());
                    }
                    let before = files::manifest(&full)?;
                    let index = self.output(&["rev-parse", "--git-path", "index"])?;
                    let lock = self.root.join(format!("{}.lock", index.trim()));
                    let handle = fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&lock)
                        .map_err(|_| "Git is updating its index. Wait, then retry.")?;
                    let result = (|| {
                        let current = parse_status(&self.output(&[
                            "status",
                            "--porcelain=v2",
                            "-z",
                            "--untracked-files=all",
                            "--",
                            &p,
                        ])?);
                        if !current["files"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|f| f["path"] == p && f["untracked"] == true)
                            || files::manifest(&full)? != before
                        {
                            return Err(
                                "This file changed before deletion. Refresh and review it.".into(),
                            );
                        }
                        self.safe(&p, false)?;
                        fs::remove_file(&full).map_err(err)
                    })();
                    drop(handle);
                    let _ = fs::remove_file(lock);
                    result?;
                } else {
                    if entry["untracked"] == true
                        || entry["conflict"] == true
                        || entry["worktree"] == "."
                    {
                        return Err("Only tracked, unstaged changes can be restored. Confirm deletion separately for an untracked file.".into());
                    }
                    message = self.output(&["restore", "--worktree", "--", &p])?;
                }
            }
            "resolveConflict" => {
                let p = self.safe(s(args, "path"), true)?;
                let snap = self.conflict_snapshot(&p)?;
                if args["revision"] != snap["revision"] {
                    return Err(
                        "This conflict changed on disk or in Git. Reopen it before saving.".into(),
                    );
                }
                let bytes = match s(args, "choice") {
                    "ours" => self.stage_bytes(&snap["stages"]["2"])?,
                    "theirs" => self.stage_bytes(&snap["stages"]["3"])?,
                    "manual" => {
                        let text = s(args, "text");
                        if !args["text"].is_string()
                            || text.len() > 1024 * 1024
                            || text.contains('\0')
                        {
                            return Err("Enter a text resolution of at most 1 MB.".into());
                        }
                        Some(text.as_bytes().to_vec())
                    }
                    _ => return Err("Choose current, incoming, or edited text.".into()),
                };
                if args["stage"] != false
                    && bytes
                        .as_ref()
                        .is_some_and(|b| markers(&String::from_utf8_lossy(b)))
                {
                    return Err("Resolve all conflict markers before staging.".into());
                }
                let old: Option<Vec<u8>> =
                    serde_json::from_value(snap["bytes"].clone()).map_err(err)?;
                let full = self.root.join(&p);
                if self.conflict_snapshot(&p)?["revision"] != snap["revision"] {
                    return Err("The conflict changed while saving.".into());
                }
                if let Some(ref b) = bytes {
                    files::replace(&full, b, old.as_ref().map(files::hash).as_deref())?;
                } else if old.is_some() {
                    fs::remove_file(&full).map_err(err)?;
                }
                if args["stage"] != false {
                    let after = self.conflict_snapshot(&p)?;
                    if after["stages"] != snap["stages"] || after["bytes"] != json!(bytes) {
                        return Err("Resolution saved but Git or the file changed before staging. Review it.".into());
                    }
                    self.output(&["add", "--all", "--", &p])?;
                }
                message = if args["stage"] == false {
                    "Resolution draft saved."
                } else {
                    "Conflict resolved and staged."
                }
                .into();
            }
            _ => return Err("Unknown Git action.".into()),
        }
        let mut result = if action == "sync" {
            json!({"committed":!entries.is_empty()||state["merging"]==true,"message":"All changes committed and synced.","status":self.status()?})
        } else {
            json!({"message":redact(message.trim()).chars().take(6000).collect::<String>(),"status":self.status()?})
        };
        if let (Some(map), Some(more)) = (result.as_object_mut(), extra.as_object()) {
            map.extend(more.clone());
        }
        Ok(result)
    }
    /// Refuses remotes outside the server's permitted hosts.
    fn allowed_host(&self, url: &str) -> Result<()> {
        if self.hosts.is_empty() {
            return Ok(());
        }
        match remote_host(url) {
            Some(host) if self.hosts.iter().any(|h| h.eq_ignore_ascii_case(&host)) => Ok(()),
            _ => Err(format!(
                "This server allows Git remotes only on {}.",
                self.hosts.join(", ")
            )),
        }
    }
}
fn parse_status(raw: &str) -> Value {
    let mut v = json!({"branch":"","oid":"","upstream":"","ahead":0,"behind":0,"files":[],"privateStaged":false});
    let mut rows = raw.split('\0');
    while let Some(row) = rows.next() {
        if row.starts_with("# branch.") {
            let parts: Vec<_> = row.splitn(3, ' ').collect();
            if parts.len() != 3 {
                continue;
            }
            match parts[1] {
                "branch.head" => v["branch"] = json!(parts[2]),
                "branch.oid" => v["oid"] = json!(parts[2]),
                "branch.upstream" => v["upstream"] = json!(parts[2]),
                "branch.ab" => {
                    let p: Vec<_> = parts[2].split(' ').collect();
                    v["ahead"] = json!(p[0].trim_start_matches('+').parse::<u64>().unwrap_or(0));
                    v["behind"] = json!(p
                        .get(1)
                        .unwrap_or(&"")
                        .trim_start_matches('-')
                        .parse::<u64>()
                        .unwrap_or(0));
                }
                _ => (),
            }
            continue;
        }
        if row.is_empty() {
            continue;
        }
        let mut f = if let Some(p) = row.strip_prefix("? ") {
            json!({"path":p,"index":"?","worktree":"?","untracked":true})
        } else if [b'1', b'2', b'u'].contains(&row.as_bytes()[0]) {
            let offset = match row.as_bytes()[0] {
                b'u' => 10,
                b'2' => 9,
                _ => 8,
            };
            let p: Vec<_> = row.splitn(offset + 1, ' ').collect();
            if p.len() <= offset {
                continue;
            }
            json!({"path":p[offset],"index":&p[1][..1],"worktree":&p[1][1..2],"conflict":row.starts_with('u'),"submodule":p[2]!="N..."})
        } else {
            continue;
        };
        if row.starts_with('2') {
            f["previousPath"] = json!(rows.next().unwrap_or(""));
        }
        if private(s(&f, "path")) || private(s(&f, "previousPath")) {
            if f["untracked"] != true && f["index"] != "." {
                v["privateStaged"] = json!(true);
            }
            continue;
        }
        v["files"].as_array_mut().unwrap().push(f);
    }
    v["unborn"] = json!(v["oid"] == "(initial)");
    v["detached"] = json!(v["branch"] == "(detached)");
    v
}
