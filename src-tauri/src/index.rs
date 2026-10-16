//! Article preparation for the index: decoding, OKF metadata, chunks and links
//! are computed off the database lock, in parallel for large batches, so the
//! writer only inserts rows. Markdown stays authoritative; rows are derived.
use crate::{
    database::chunks,
    markdown::{self, Resolver},
    native_files::{self as files, hash, Result},
};
use serde_json::{json, Value};

/// A parsed link before resolution. Offsets are UTF-16, as the browser parser reports.
pub struct ParsedLink {
    pub start: usize,
    pub end: usize,
    pub line: usize,
    pub target: String,
    pub relationship: String,
    pub raw: String,
}
/// A relationship row: resolved target and the stored record.
pub struct LinkRow {
    pub start: usize,
    pub target: Option<String>,
    pub key: String,
    pub record: String,
}
pub struct ChunkRow {
    pub id: String,
    pub ordinal: usize,
    pub start: usize,
    pub end: usize,
    pub line: usize,
    pub end_line: usize,
    pub content_hash: String,
    pub body: String,
}
/// One article ready to be written to the index.
pub struct Prepared {
    pub path: String,
    pub hash: String,
    pub mtime: f64,
    pub size: u64,
    pub title: String,
    /// Article metadata as stored in `documents.metadata` (without the body).
    pub metadata: Value,
    pub chunks: Vec<ChunkRow>,
    pub links: Vec<ParsedLink>,
    pub rows: Vec<LinkRow>,
}
/// Lower-cased last path segment: the key every resolution candidate shares.
pub fn name_key(path: &str) -> String {
    let path = path.trim().replace('\\', "/");
    path.rsplit('/').next().unwrap_or("").to_lowercase()
}
/// Byte offsets to UTF-16 offsets for ascending positions in one pass.
struct Utf16<'a> {
    text: &'a str,
    byte: usize,
    units: usize,
}
impl<'a> Utf16<'a> {
    fn new(text: &'a str) -> Self {
        Self {
            text,
            byte: 0,
            units: 0,
        }
    }
    fn at(&mut self, byte: usize) -> usize {
        if byte < self.byte {
            self.byte = 0;
            self.units = 0;
        }
        self.units += self.text[self.byte..byte].encode_utf16().count();
        self.byte = byte;
        self.units
    }
}
/// Parses one article (`doc` is a `native_files::read` result).
pub fn prepare(workspace: &str, root_name: &str, path: &str, doc: &Value) -> Prepared {
    let text = doc["text"].as_str().unwrap_or("");
    let mut meta = markdown::metadata(text, path, root_name);
    meta.as_object_mut().unwrap().remove("body");
    let title = meta["title"].as_str().unwrap_or(path).to_string();
    let source_hash = doc["hash"].as_str().unwrap_or("").to_string();
    let chunks = chunks(text)
        .into_iter()
        .enumerate()
        .map(|(ordinal, c)| {
            let content_hash = hash(&c.text);
            ChunkRow {
                id: hash(format!("{workspace}\0{path}\0{ordinal}\0{content_hash}")),
                ordinal,
                start: c.start,
                end: c.end,
                line: c.line,
                end_line: c.end_line,
                content_hash,
                body: c.text,
            }
        })
        .collect();
    let mut offsets = Utf16::new(text);
    let links = markdown::links(text)
        .into_iter()
        .map(|l| {
            let start = offsets.at(l.start);
            let end = offsets.at(l.end);
            ParsedLink {
                start,
                end,
                line: l.line,
                raw: text[l.start..l.end].to_string(),
                target: l.target,
                relationship: l.relationship,
            }
        })
        .collect();
    Prepared {
        path: path.to_string(),
        hash: source_hash,
        mtime: doc["mtime"].as_f64().unwrap_or(0.),
        size: doc["size"].as_u64().unwrap_or(0),
        title,
        metadata: meta,
        chunks,
        links,
        rows: vec![],
    }
}
/// The stored relationship record for a link resolved from `source`.
pub fn link_row(source: &str, l: &ParsedLink, resolver: &Resolver) -> LinkRow {
    let r = resolver.resolve(&l.target, source);
    let target = r["resolvedPath"].as_str().map(String::from);
    let record = json!({"id":format!("{source}:{}", l.start),"source_document_id":source,"target_document_id":target,"target_path":r["targetPath"],"authored_target":l.target,"relationship_type":l.relationship,"source_line":l.line,"start_offset":l.start,"end_offset":l.end,"raw":l.raw,"resolved":if target.is_some(){1}else{0},"reason":r["reason"],"candidates":r["candidates"].to_string()});
    LinkRow {
        start: l.start,
        target,
        key: name_key(&l.target),
        record: record.to_string(),
    }
}
pub fn resolve(p: &mut Prepared, resolver: &Resolver) {
    p.rows = p
        .links
        .iter()
        .map(|l| link_row(&p.path, l, resolver))
        .collect();
}
/// Re-resolves a stored record; `None` when its resolution is unchanged.
pub fn reresolve(record: &str, resolver: &Resolver) -> Option<(Option<String>, String)> {
    let mut v: Value = serde_json::from_str(record).ok()?;
    let source = v["source_document_id"].as_str()?.to_string();
    let r = resolver.resolve(v["authored_target"].as_str()?, &source);
    let target = r["resolvedPath"].as_str().map(String::from);
    let candidates = r["candidates"].to_string();
    if v["target_document_id"].as_str() == target.as_deref()
        && v["target_path"] == r["targetPath"]
        && v["reason"] == r["reason"]
        && v["candidates"].as_str() == Some(candidates.as_str())
    {
        return None;
    }
    v["target_document_id"] = json!(target);
    v["target_path"] = r["targetPath"].clone();
    v["resolved"] = json!(if target.is_some() { 1 } else { 0 });
    v["reason"] = r["reason"].clone();
    v["candidates"] = json!(candidates);
    Some((target, v.to_string()))
}
/// Worker threads for parsing: leave cores for the interface and the writer.
/// Reader threads per batch: one per core, at least four, at most eight.
/// Reading waits mostly on the file system (and, on Windows, on-access
/// scanning), while parsing an article takes a fraction of a millisecond.
/// Threads keep normal priority: Windows runs lower-priority threads on
/// efficiency cores, which made indexing several times slower, while the
/// interface (a separate WebView process) stayed responsive either way.
pub fn workers() -> usize {
    std::thread::available_parallelism()
        .map_or(4, |n| n.get())
        .clamp(4, 8)
}
/// Reads and prepares articles listed by a walk, in parallel. Each item is a
/// path and the document hash planned for it; an article whose content still
/// has that hash is not parsed (its result carries only hash and metadata, and
/// the writer only refreshes its modification time). Each result is the
/// prepared article or the read error. `resolver`, when given, resolves links.
pub fn prepare_all(
    root: &std::path::Path,
    workspace: &str,
    root_name: &str,
    items: &[(String, Option<String>)],
    resolver: Option<&Resolver>,
) -> Vec<(String, Result<Prepared>)> {
    let work = |(path, planned): &(String, Option<String>)| {
        let result = files::read_listed(root, path).map(|doc| {
            if planned.as_deref() == doc["hash"].as_str() {
                return Prepared {
                    path: path.clone(),
                    hash: planned.clone().unwrap_or_default(),
                    mtime: doc["mtime"].as_f64().unwrap_or(0.),
                    size: doc["size"].as_u64().unwrap_or(0),
                    title: String::new(),
                    metadata: Value::Null,
                    chunks: vec![],
                    links: vec![],
                    rows: vec![],
                };
            }
            let mut p = prepare(workspace, root_name, path, &doc);
            if let Some(r) = resolver {
                resolve(&mut p, r);
            }
            p
        });
        (path.clone(), result)
    };
    let threads = workers().min(items.len().div_ceil(8)).max(1);
    if threads == 1 {
        return items.iter().map(work).collect();
    }
    let size = items.len().div_ceil(threads);
    std::thread::scope(|s| {
        let handles: Vec<_> = items
            .chunks(size)
            .map(|part| {
                (
                    part,
                    s.spawn(move || part.iter().map(work).collect::<Vec<_>>()),
                )
            })
            .collect();
        // A part whose thread failed reports each of its articles as unreadable.
        handles
            .into_iter()
            .flat_map(|(part, h)| {
                h.join().unwrap_or_else(|_| {
                    part.iter()
                        .map(|(p, _)| {
                            (
                                p.clone(),
                                Err("The article could not be parsed.".to_string()),
                            )
                        })
                        .collect()
                })
            })
            .collect()
    })
}
