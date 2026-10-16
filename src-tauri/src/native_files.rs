//! Workspace confinement and recoverable, conflict-checked writes.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
pub type Result<T> = std::result::Result<T, String>;
pub fn hash(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
pub fn now() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
pub fn id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    format!(
        "{}-{}-{}",
        std::process::id(),
        now(),
        N.fetch_add(1, Ordering::Relaxed)
    )
}
pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
pub fn ignored(path: &str) -> bool {
    path.split('/').any(|p| {
        let p = p.to_lowercase();
        [
            ".weave",
            ".git",
            ".agents",
            ".codex",
            "node_modules",
            "target",
            "dist",
            "build",
            "test-results",
            "agents.md",
        ]
        .contains(&p.as_str())
            || p.starts_with(".weave-")
    })
}
pub fn relative(value: &str) -> Result<String> {
    relative_options(value, false)
}
pub fn relative_options(value: &str, excluded: bool) -> Result<String> {
    let path = value.replace('\\', "/");
    if path.is_empty()
        || path.len() > 2048
        || path.split('/').count() > 64
        || path.split('/').any(|p| {
            let base = p.split('.').next().unwrap_or("").to_lowercase();
            p.is_empty()
                || p == "."
                || p == ".."
                || p.ends_with(['.', ' '])
                || p.chars().any(|c| c.is_control() || "<>:\"|?*".contains(c))
                || ["con", "prn", "aux", "nul"].contains(&base.as_str())
                || ((base.starts_with("com") || base.starts_with("lpt"))
                    && base.len() == 4
                    && base.as_bytes()[3].is_ascii_digit())
                || [".git", ".weave"].contains(&p.to_lowercase().as_str())
                || p.to_lowercase().starts_with(".weave-")
        })
        || (!excluded && ignored(&path))
    {
        return Err("That path is reserved or leaves the Markdown workspace.".into());
    }
    Ok(path)
}
pub fn linked(m: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if m.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    m.file_type().is_symlink()
}
pub fn checked(root: &Path, value: &str, missing: bool) -> Result<PathBuf> {
    checked_options(root, value, missing, false)
}
pub fn checked_options(root: &Path, value: &str, missing: bool, excluded: bool) -> Result<PathBuf> {
    let value = relative_options(value, excluded)?;
    let mut current = root.to_path_buf();
    for part in value.split('/') {
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(m) => {
                if linked(&m) {
                    return Err("Linked files and folders are not supported.".into());
                }
                if !fs::canonicalize(&current).map_err(err)?.starts_with(root) {
                    return Err("The path leaves the workspace.".into());
                }
            }
            Err(e) if missing && e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(err(e)),
        }
    }
    Ok(current)
}
pub fn decode(bytes: &[u8]) -> Result<(String, bool, bool)> {
    if bytes.starts_with(&[255, 254]) {
        if bytes.len() % 2 != 0 {
            return Err("Invalid UTF-16 Markdown.".into());
        }
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return Ok((String::from_utf16(&units).map_err(err)?, true, true));
    }
    let bom = bytes.starts_with(&[239, 187, 191]);
    Ok((
        String::from_utf8(bytes[if bom { 3 } else { 0 }..].to_vec()).map_err(err)?,
        false,
        bom,
    ))
}
pub fn encode(text: &str, utf16: bool, bom: bool) -> Vec<u8> {
    let mut b = Vec::new();
    if bom {
        b.extend_from_slice(if utf16 { &[255, 254] } else { &[239, 187, 191] });
    }
    if utf16 {
        for c in text.encode_utf16() {
            b.extend(c.to_le_bytes());
        }
    } else {
        b.extend(text.as_bytes());
    }
    b
}
pub fn read(root: &Path, file: &str) -> Result<Value> {
    if !file.to_lowercase().ends_with(".md") {
        return Err("Only Markdown notes can be read.".into());
    }
    let path = checked(root, file, false)?;
    let m = fs::metadata(&path).map_err(err)?;
    read_at(&path, file, &m)
}
/// The file's creation time in milliseconds, or its modification time where the
/// filesystem does not record creation. Weave uses it for a missing `created_at`.
pub fn created(m: &fs::Metadata) -> f64 {
    m.created()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or_else(|| mtime(m))
}
pub fn mtime(m: &fs::Metadata) -> f64 {
    m.modified()
        .unwrap_or(UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1000.0
}
pub fn replace(path: &Path, bytes: &[u8], expected: Option<&str>) -> Result<()> {
    let verify = || -> Result<()> {
        let current = match fs::read(path) {
            Ok(b) => Some(hash(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(err(e)),
        };
        if current.as_deref() != expected {
            return Err("This note changed outside Weave. Your draft is retained. Reload the disk version or copy your draft before resolving the conflict.".into());
        }
        Ok(())
    };
    verify()?;
    let mut temp = tempfile::Builder::new()
        .prefix(".weave-")
        .tempfile_in(path.parent().ok_or("Missing parent")?)
        .map_err(err)?;
    temp.write_all(bytes).map_err(err)?;
    temp.as_file().sync_all().map_err(err)?;
    // Windows file scanners can briefly open the destination without sharing
    // deletion. Keep the synced temporary file and retry the atomic move only
    // while the destination still has the hash we were asked to replace.
    for attempt in 0..12 {
        verify()?;
        let result = if expected.is_none() {
            temp.persist_noclobber(path)
        } else {
            temp.persist(path)
        };
        match result {
            Ok(_) => return Ok(()),
            Err(failure) => {
                if !cfg!(windows)
                    || !matches!(failure.error.raw_os_error(), Some(5 | 32 | 33))
                    || attempt == 11
                {
                    return Err(err(failure));
                }
                temp = failure.file;
                std::thread::sleep(std::time::Duration::from_millis(25 * (attempt + 1)));
            }
        }
    }
    unreachable!("the bounded persist loop returns on success or failure")
}
pub fn write(root: &Path, file: &str, text: &str, expected: Option<&str>) -> Result<Value> {
    if !file.to_lowercase().ends_with(".md") || text.len() > 4 * 1024 * 1024 {
        return Err("Choose a Markdown note of at most 4 MB.".into());
    }
    let path = checked(root, file, true)?;
    let (utf16, bom) = if expected.is_some() {
        let old = read(root, file)?;
        (old["encoding"] == "utf16le", old["bom"] == true)
    } else {
        (false, false)
    };
    let b = encode(text, utf16, bom);
    if b.len() > 4 * 1024 * 1024 {
        return Err("Note exceeds 4 MB.".into());
    }
    checked(root, file, true)?;
    replace(&path, &b, expected)?;
    read(root, file)
}
pub fn json_write(path: &Path, value: &Value) -> Result<()> {
    fs::create_dir_all(path.parent().ok_or("Missing parent")?).map_err(err)?;
    let old = fs::read(path).ok().map(hash);
    replace(
        path,
        &serde_json::to_vec_pretty(value).map_err(err)?,
        old.as_deref(),
    )
}
/// Most Markdown articles, total Markdown bytes and other files one workspace may hold.
pub const MAX_NOTES: usize = 1_000_000;
pub const MAX_MARKDOWN_BYTES: u64 = 32 << 30;
pub const MAX_OTHER_FILES: usize = 1_000_000;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Folder = 0,
    Markdown = 1,
    Other = 2,
}
impl Kind {
    pub fn from_i64(v: i64) -> Kind {
        match v {
            0 => Kind::Folder,
            1 => Kind::Markdown,
            _ => Kind::Other,
        }
    }
}
/// One file or folder found by a walk. Paths are workspace-relative with `/`.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub path: String,
    pub kind: Kind,
    pub mtime: f64,
    pub size: u64,
}
pub fn is_markdown(path: &str) -> bool {
    path.len() >= 3 && path[path.len() - 3..].eq_ignore_ascii_case(".md")
}
/// Running totals shared by the walks of one scan, so limits apply to the workspace.
#[derive(Default)]
pub struct Budget {
    pub notes: usize,
    pub bytes: u64,
    pub other: usize,
    /// Stop (with `Ok`) after this many entries; zero means no cap.
    pub cap: usize,
    pub capped: bool,
}
/// Walks `start` (a workspace-relative folder, or "" for the root) without
/// following links. Directory listings supply metadata, so a walk makes no
/// per-file system calls on Windows. Entries are returned sorted by path.
pub fn walk(root: &Path, start: &str, budget: &mut Budget) -> Result<Vec<Entry>> {
    let mut out = vec![];
    let mut stack = vec![(
        if start.is_empty() {
            root.to_path_buf()
        } else {
            root.join(start)
        },
        start.to_string(),
        start.split('/').filter(|s| !s.is_empty()).count(),
    )];
    while let Some((dir, base, depth)) = stack.pop() {
        if depth > 64 {
            return Err("Folder nesting exceeds 64.".into());
        }
        let listing = match fs::read_dir(&dir) {
            Ok(listing) => listing,
            // A folder removed during the walk is simply absent.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && depth > 0 => continue,
            Err(e) => return Err(err(e)),
        };
        for e in listing {
            let e = match e {
                Ok(e) => e,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(err(e)),
            };
            let name = e.file_name().to_string_lossy().into_owned();
            let file = if base.is_empty() {
                name
            } else {
                format!("{base}/{name}")
            };
            if ignored(&file) {
                continue;
            }
            let m = match e.metadata() {
                Ok(m) => m,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(err(e)),
            };
            if linked(&m) {
                continue;
            }
            if m.is_dir() {
                stack.push((e.path(), file.clone(), depth + 1));
                out.push(Entry {
                    path: file,
                    kind: Kind::Folder,
                    mtime: 0.0,
                    size: 0,
                });
            } else if m.is_file() {
                if is_markdown(&file) {
                    budget.notes += 1;
                    budget.bytes += m.len();
                    if budget.notes > MAX_NOTES || budget.bytes > MAX_MARKDOWN_BYTES {
                        return Err(
                            "Workspace exceeds 1,000,000 notes or 32 GB of Markdown.".into()
                        );
                    }
                    out.push(Entry {
                        path: file,
                        kind: Kind::Markdown,
                        mtime: mtime(&m),
                        size: m.len(),
                    });
                } else if budget.other < MAX_OTHER_FILES {
                    budget.other += 1;
                    out.push(Entry {
                        path: file,
                        kind: Kind::Other,
                        mtime: mtime(&m),
                        size: m.len(),
                    });
                }
            }
            if budget.cap > 0 && out.len() >= budget.cap {
                budget.capped = true;
                return Ok(out);
            }
        }
    }
    out.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}
/// The whole workspace tree in the catalog's JSON shape.
pub fn scan(root: &Path) -> Result<Value> {
    let entries = walk(root, "", &mut Budget::default())?;
    let pick = |kind: Kind| entries.iter().filter(move |e| e.kind == kind);
    Ok(json!({
        "files": pick(Kind::Markdown).map(|e| json!({"path":e.path,"mtime":e.mtime,"size":e.size})).collect::<Vec<_>>(),
        "otherFiles": pick(Kind::Other).map(|e| json!({"path":e.path})).collect::<Vec<_>>(),
        "folders": pick(Kind::Folder).map(|e| json!(e.path)).collect::<Vec<_>>(),
        "warnings": []
    }))
}
/// Reads a Markdown file found by a walk of `root`. The path came from a
/// listing that excluded links, so only the file itself is checked again.
pub fn read_listed(root: &Path, file: &str) -> Result<Value> {
    if !is_markdown(file) {
        return Err("Only Markdown notes can be read.".into());
    }
    let file = relative(file)?;
    let path = root.join(&file);
    let m = fs::symlink_metadata(&path).map_err(err)?;
    if linked(&m) {
        return Err("Linked files and folders are not supported.".into());
    }
    read_at(&path, &file, &m)
}
fn read_at(path: &Path, file: &str, m: &fs::Metadata) -> Result<Value> {
    if !m.is_file() || m.len() > 4 * 1024 * 1024 {
        return Err("Notes must be ordinary Markdown files, at most 4 MB.".into());
    }
    let b = fs::read(path).map_err(err)?;
    if b.len() > 4 * 1024 * 1024 {
        return Err("Note exceeds 4 MB.".into());
    }
    let (text, utf16, bom) = decode(&b)?;
    Ok(
        json!({"path":file,"text":text,"encoding":if utf16{"utf16le"}else{"utf8"},"bom":bom,"hash":hash(&b),"mtime":mtime(m),"created":created(m),"size":b.len()}),
    )
}
pub fn manifest(path: &Path) -> Result<Value> {
    let m = fs::symlink_metadata(path).map_err(err)?;
    if linked(&m) {
        return Err("Moving or deleting folders containing linked paths is not supported.".into());
    }
    if m.is_file() {
        return Ok(json!(hash(fs::read(path).map_err(err)?)));
    }
    if !m.is_dir() {
        return Err("Only ordinary files and folders are supported.".into());
    }
    let mut map = serde_json::Map::new();
    for e in fs::read_dir(path).map_err(err)? {
        let e = e.map_err(err)?;
        map.insert(e.file_name().to_string_lossy().into(), manifest(&e.path())?);
    }
    Ok(Value::Object(map))
}
pub fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    let m = fs::symlink_metadata(from).map_err(err)?;
    if linked(&m) {
        return Err("Storage transfers do not follow linked paths.".into());
    }
    if m.is_dir() {
        fs::create_dir(to).map_err(err)?;
        for e in fs::read_dir(from).map_err(err)? {
            let e = e.map_err(err)?;
            copy_tree(&e.path(), &to.join(e.file_name()))?;
        }
    } else {
        let mut out = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(to)
            .map_err(err)?;
        std::io::copy(&mut fs::File::open(from).map_err(err)?, &mut out).map_err(err)?;
        out.sync_all().map_err(err)?;
    }
    Ok(())
}
/// Deletes without a backup copy (the default; users keep history in Git).
pub fn delete_permanently(root: &Path, file: &str) -> Result<Value> {
    let full = checked(root, file, false)?;
    manifest(&full)?;
    remove(&full)?;
    Ok(json!({"recovery":null}))
}
pub fn remove(path: &Path) -> Result<()> {
    if fs::symlink_metadata(path).map_err(err)?.is_dir() {
        fs::remove_dir_all(path).map_err(err)
    } else {
        fs::remove_file(path).map_err(err)
    }
}
pub fn delete(root: &Path, file: &str, runtime: &Path) -> Result<Value> {
    let full = checked(root, file, false)?;
    let before = manifest(&full)?;
    let trash = runtime.join("trash").join(id());
    fs::create_dir_all(&trash).map_err(err)?;
    let copy = trash.join(full.file_name().ok_or("Missing filename")?);
    copy_tree(&full, &copy)?;
    if manifest(&full)? != before || manifest(&copy)? != before {
        return Err(
            "The resource changed while making its recovery copy. Nothing was deleted.".into(),
        );
    }
    json_write(
        &trash.join("restore.json"),
        &json!({"root":root,"path":file}),
    )?;
    checked(root, file, false)?;
    remove(&full)?;
    Ok(json!({"recovery":trash}))
}
