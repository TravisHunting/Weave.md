//! Fixed Git vocabulary, argument arrays only, scoped to an opened repository.
use crate::native_files::{self as files, err, Result};
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
}
fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
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
        }
    }
    pub fn saved(&self) -> Value {
        json!({"preferences":self.preferences,"pulls":self.pulls})
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
        ])
        .args(args)
        .current_dir(&self.root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_PAGER", "cat")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
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
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Git is unavailable. Install Git and reopen Weave: {e}"))?;
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
    fn repository(&self) -> Result<Value> {
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
            Err(e) => return Ok(json!({"available":false,"repository":false,"error":e})),
        };
        if info["repository"] != true {
            return Ok(info);
        }
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
    pub fn history(&self) -> Result<Value> {
        self.require()?;
        let (code, out, e) = self.run(
            &[
                "log",
                "-40",
                "--date=iso-strict",
                "--format=%H%x00%h%x00%an%x00%ad%x00%s%x00%D%x1e",
            ],
            true,
            None,
        )?;
        if code != 0 {
            if e.contains("does not have any commits") {
                return Ok(json!([]));
            }
            return Err(e);
        }
        Ok(json!(out.split('\u{1e}').filter_map(|r|{let p:Vec<_>=r.trim().split('\0').collect();(p.len()>=6).then(||json!({"id":p[0],"short":p[1],"author":p[2],"date":p[3],"subject":redact(p[4]),"refs":p[5]}))}).collect::<Vec<_>>()))
    }
    pub fn commit_diff(&self, args: &Value) -> Result<Value> {
        self.require()?;
        let id = s(args, "id");
        if !(40..=64).contains(&id.len()) || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Choose a commit from the history.".into());
        }
        let names = self.output(&[
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "-r",
            "-z",
            "--root",
            id,
        ])?;
        let paths: Vec<_> = names
            .split('\0')
            .filter(|p| !p.is_empty() && !private(p))
            .collect();
        for p in &paths {
            self.safe(p, true)?;
        }
        if paths.is_empty() {
            return Ok(json!({"path":&id[..8],"text":"This commit has no viewable file changes."}));
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
        Ok(json!({"path":&id[..8],"text":self.output(&cmd)?}))
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
        self.require()?;
        let state = self.status()?;
        let entries = state["files"].as_array().unwrap();
        let mut message = "Git operation completed.".to_string();
        match action {
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
                    .run(&["commit", "--file=-"], false, Some(input.as_bytes()))?
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
                if u.len() > 2000
                    || u.chars()
                        .any(|c| c.is_whitespace() || c.is_control() || "?#".contains(c))
                {
                    return Err(
                        "Use an HTTP(S) or SSH URL without credentials or query parameters.".into(),
                    );
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
                message = self.output(&["remote", "add", name, u])?;
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
        Ok(if action == "sync" {
            json!({"committed":!entries.is_empty()||state["merging"]==true,"message":"All changes committed and synced.","status":self.status()?})
        } else {
            json!({"message":redact(message.trim()).chars().take(6000).collect::<String>(),"status":self.status()?})
        })
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
