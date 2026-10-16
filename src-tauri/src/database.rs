//! One application database. Markdown is authoritative; only derived rows are rebuilt.
//! One writer connection applies short index transactions; a pool of WAL readers
//! serves requests, so reading and searching never wait for indexing.
use crate::{
    index::{name_key, LinkRow, Prepared},
    kanban,
    markdown::Resolver,
    native_files::{err, Entry, Kind, Result},
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};
pub const SCHEMA: i64 = 3;
pub struct Database {
    writer: Mutex<Connection>,
    readers: Mutex<Vec<Connection>>,
    /// Copies committed WAL frames into the database beside the writer.
    checkpointer: Mutex<Option<Connection>>,
    path: PathBuf,
    /// The running search of each channel, interrupted when a newer one starts.
    searches: Mutex<HashMap<String, (u64, rusqlite::InterruptHandle)>>,
    serial: AtomicU64,
}
#[derive(Debug)]
pub struct Chunk {
    pub start: usize,
    pub end: usize,
    pub line: usize,
    pub end_line: usize,
    pub text: String,
}
// Bounded, overlapping UTF-8 chunks retain source positions for future vector rows.
pub fn chunks(text: &str) -> Vec<Chunk> {
    let mut out = vec![];
    let mut start = 0;
    let mut line = 1;
    while start < text.len() {
        let mut end = (start + 1800).min(text.len());
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        if end < text.len() {
            let mut middle = start + 900.min(end - start);
            while !text.is_char_boundary(middle) {
                middle += 1;
            }
            if let Some(n) = text[middle..end].rfind('\n') {
                end = middle + n + 1;
            }
        }
        let body = &text[start..end];
        if !body.trim().is_empty() {
            out.push(Chunk {
                start,
                end,
                line,
                end_line: line + body.bytes().filter(|b| *b == b'\n').count(),
                text: body.into(),
            });
        }
        if end == text.len() {
            break;
        }
        let mut next = end.saturating_sub(200).max(start + 1);
        while !text.is_char_boundary(next) {
            next += 1;
        }
        line += text[start..next].bytes().filter(|b| *b == b'\n').count();
        start = next;
    }
    if out.is_empty() {
        out.push(Chunk {
            start: 0,
            end: 0,
            line: 1,
            end_line: 1,
            text: String::new(),
        });
    }
    out
}
const TABLES: &str = "
  CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,root TEXT NOT NULL UNIQUE,name TEXT NOT NULL,session TEXT NOT NULL DEFAULT '{}',git TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE IF NOT EXISTS documents(workspace TEXT NOT NULL REFERENCES workspaces(id),path TEXT NOT NULL,hash TEXT NOT NULL,mtime REAL NOT NULL,metadata TEXT NOT NULL,title TEXT NOT NULL DEFAULT '',PRIMARY KEY(workspace,path));
  CREATE TABLE IF NOT EXISTS relationships(workspace TEXT NOT NULL,source TEXT NOT NULL,start INTEGER NOT NULL,target TEXT,record TEXT NOT NULL,target_key TEXT NOT NULL DEFAULT '',PRIMARY KEY(workspace,source,start),FOREIGN KEY(workspace,source) REFERENCES documents(workspace,path) ON DELETE CASCADE);
  CREATE INDEX IF NOT EXISTS incoming ON relationships(workspace,target);
  CREATE INDEX IF NOT EXISTS relationship_keys ON relationships(workspace,target_key);
  CREATE TABLE IF NOT EXISTS chunks(rowid INTEGER PRIMARY KEY,id TEXT NOT NULL,workspace TEXT NOT NULL,path TEXT NOT NULL,ordinal INTEGER NOT NULL,start_byte INTEGER NOT NULL,end_byte INTEGER NOT NULL,start_line INTEGER NOT NULL,end_line INTEGER NOT NULL,source_hash TEXT NOT NULL,content_hash TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,FOREIGN KEY(workspace,path) REFERENCES documents(workspace,path) ON DELETE CASCADE);
  CREATE INDEX IF NOT EXISTS chunks_document ON chunks(workspace,path,ordinal);
  CREATE TABLE IF NOT EXISTS kanban_boards(workspace TEXT NOT NULL,path TEXT NOT NULL,name_key TEXT NOT NULL,path_key TEXT NOT NULL,warnings TEXT NOT NULL,PRIMARY KEY(workspace,path),FOREIGN KEY(workspace,path) REFERENCES documents(workspace,path) ON DELETE CASCADE);
  CREATE INDEX IF NOT EXISTS kanban_board_names ON kanban_boards(workspace,name_key);
  CREATE INDEX IF NOT EXISTS kanban_board_paths ON kanban_boards(workspace,path_key);
  CREATE TABLE IF NOT EXISTS kanban_columns(workspace TEXT NOT NULL,board TEXT NOT NULL,ordinal INTEGER NOT NULL,id TEXT NOT NULL,title TEXT NOT NULL,PRIMARY KEY(workspace,board,ordinal),FOREIGN KEY(workspace,board) REFERENCES kanban_boards(workspace,path) ON DELETE CASCADE);
  CREATE TABLE IF NOT EXISTS kanban_cards(workspace TEXT NOT NULL,path TEXT NOT NULL,board_ref TEXT NOT NULL,by_path INTEGER NOT NULL,board_key TEXT,column_id TEXT,rank REAL,PRIMARY KEY(workspace,path),FOREIGN KEY(workspace,path) REFERENCES documents(workspace,path) ON DELETE CASCADE);
  CREATE INDEX IF NOT EXISTS kanban_card_boards ON kanban_cards(workspace,board_key,column_id,rank);
  CREATE TABLE IF NOT EXISTS entries(workspace TEXT NOT NULL,path TEXT NOT NULL,kind INTEGER NOT NULL,mtime REAL NOT NULL,size INTEGER NOT NULL,name_key TEXT NOT NULL,PRIMARY KEY(workspace,path)) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS entry_names ON entries(workspace,name_key);
  CREATE TABLE IF NOT EXISTS stats(workspace TEXT PRIMARY KEY,documents INTEGER NOT NULL DEFAULT 0,relationships INTEGER NOT NULL DEFAULT 0,unresolved INTEGER NOT NULL DEFAULT 0,chunks INTEGER NOT NULL DEFAULT 0);";
/// Each workspace has its own full-text index of its chunks, so a search reads
/// only that workspace's postings. The table is contentless: passages are read
/// from `chunks` by rowid. Its name derives from the workspace id (hex only).
pub fn fts_table(workspace: &str) -> String {
    format!(
        "fts_{}",
        workspace
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .collect::<String>()
            .to_lowercase()
    )
}
fn create_fts(db: &Connection, workspace: &str) -> Result<()> {
    db.execute_batch(&format!("CREATE VIRTUAL TABLE IF NOT EXISTS {} USING fts5(title,path,body,content='',contentless_delete=1,tokenize='unicode61 remove_diacritics 2');", fts_table(workspace))).map_err(err)
}
fn connect(path: &Path, cache_kib: i64) -> Result<Connection> {
    let db = Connection::open(path).map_err(err)?;
    db.busy_timeout(std::time::Duration::from_secs(3))
        .map_err(err)?;
    db.execute_batch(&format!(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA cache_size=-{cache_kib};"
    ))
    .map_err(err)?;
    Ok(db)
}
fn columns(db: &Connection, table: &str) -> Result<HashSet<String>> {
    let mut stmt = db
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(err)?;
    let names = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(err)?
        .collect::<rusqlite::Result<_>>()
        .map_err(err);
    names
}
impl Database {
    pub fn open(path: &Path) -> Result<Self> {
        // The writer keeps a larger page cache: bulk indexing inserts into several large B-trees.
        let db = connect(path, 65536)?;
        let version: i64 = db
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(err)?;
        if version > SCHEMA {
            return Err("This database requires a newer Weave version.".into());
        }
        if version > 0 && version < SCHEMA {
            // Version 3 adds the file tree, title and link keys, counts and a
            // workspace-scoped search index. Derived rows are rebuilt from
            // Markdown, as deleting the database does; sessions and settings stay.
            let tx = db.unchecked_transaction().map_err(err)?;
            tx.execute_batch("DROP TRIGGER IF EXISTS chunks_ai; DROP TRIGGER IF EXISTS chunks_ad; DROP TRIGGER IF EXISTS chunks_au; DROP TABLE IF EXISTS chunks_fts;").map_err(err)?;
            let indexes: Vec<String> = tx.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'fts_*' AND sql LIKE 'CREATE VIRTUAL TABLE%'").map_err(err)?.query_map([], |r| r.get(0)).map_err(err)?.collect::<rusqlite::Result<_>>().map_err(err)?;
            for table in indexes {
                tx.execute_batch(&format!("DROP TABLE IF EXISTS {table}"))
                    .map_err(err)?;
            }
            for table in [
                "kanban_columns",
                "kanban_cards",
                "kanban_boards",
                "chunks",
                "relationships",
                "documents",
            ] {
                let exists: bool = tx
                    .query_row(
                        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?",
                        [table],
                        |r| r.get::<_, i64>(0),
                    )
                    .map_err(err)?
                    > 0;
                if exists {
                    tx.execute(&format!("DELETE FROM {table}"), [])
                        .map_err(err)?;
                }
            }
            for (table, column, definition) in [
                ("documents", "title", "TEXT NOT NULL DEFAULT ''"),
                ("relationships", "target_key", "TEXT NOT NULL DEFAULT ''"),
            ] {
                let exists: bool = tx
                    .query_row(
                        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?",
                        [table],
                        |r| r.get::<_, i64>(0),
                    )
                    .map_err(err)?
                    > 0;
                if exists && !columns(&tx, table)?.contains(column) {
                    tx.execute_batch(&format!(
                        "ALTER TABLE {table} ADD COLUMN {column} {definition}"
                    ))
                    .map_err(err)?;
                }
            }
            tx.execute_batch("DROP TABLE IF EXISTS entries; DROP TABLE IF EXISTS stats;")
                .map_err(err)?;
            tx.commit().map_err(err)?;
        }
        db.execute_batch(&format!("BEGIN IMMEDIATE; {TABLES} INSERT OR IGNORE INTO stats(workspace) SELECT id FROM workspaces; PRAGMA user_version={SCHEMA}; COMMIT;")).map_err(err)?;
        // The writer never checkpoints during a commit (that copied frames into a
        // multi-gigabyte file while saves waited); `checkpoint_passive` runs
        // beside it instead.
        db.execute_batch("PRAGMA wal_autocheckpoint=0; PRAGMA journal_size_limit=67108864;")
            .map_err(err)?;
        let registered: Vec<String> = db
            .prepare("SELECT id FROM workspaces")
            .map_err(err)?
            .query_map([], |r| r.get(0))
            .map_err(err)?
            .collect::<rusqlite::Result<_>>()
            .map_err(err)?;
        for id in registered {
            create_fts(&db, &id)?;
        }
        Ok(Self {
            writer: Mutex::new(db),
            readers: Mutex::new(vec![]),
            checkpointer: Mutex::new(None),
            path: path.to_path_buf(),
            searches: Mutex::new(HashMap::new()),
            serial: AtomicU64::new(0),
        })
    }
    /// Runs `f` on a pooled read connection. WAL readers see the last commit
    /// and never wait for the writer.
    pub fn read<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let pooled = self.readers.lock().map_err(err)?.pop();
        let conn = match pooled {
            Some(c) => c,
            None => {
                let c = connect(&self.path, 8192)?;
                c.execute_batch("PRAGMA query_only=1;").map_err(err)?;
                c
            }
        };
        let result = f(&conn);
        let mut pool = self.readers.lock().map_err(err)?;
        if pool.len() < 6 {
            pool.push(conn);
        }
        result
    }
    /// Runs `f` in one immediate write transaction for `workspace`, adding
    /// the counts it changed. Returns `f`'s value and the paths it touched.
    /// Index rows are derived and rebuilt from Markdown, so their commits skip
    /// the per-commit fsync (WAL with synchronous=NORMAL cannot corrupt the
    /// database; a power cut can only lose the newest rows, which the next scan
    /// restores). Settings and sessions keep full durability.
    pub fn write<T>(
        &self,
        workspace: &str,
        f: impl FnOnce(&mut Writer) -> Result<T>,
    ) -> Result<(T, Vec<String>)> {
        let mut conn = self.writer.lock().map_err(err)?;
        conn.execute_batch("PRAGMA synchronous=NORMAL")
            .map_err(err)?;
        let result = Self::write_on(&mut conn, workspace, f);
        conn.execute_batch("PRAGMA synchronous=FULL").map_err(err)?;
        result
    }
    fn write_on<T>(
        conn: &mut Connection,
        workspace: &str,
        f: impl FnOnce(&mut Writer) -> Result<T>,
    ) -> Result<(T, Vec<String>)> {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(err)?;
        let mut w = Writer {
            tx,
            workspace: workspace.to_string(),
            stats: [0; 4],
            touched: vec![],
        };
        let value = f(&mut w)?;
        let Writer {
            tx, stats, touched, ..
        } = w;
        if stats != [0; 4] {
            tx.execute("UPDATE stats SET documents=documents+?2,relationships=relationships+?3,unresolved=unresolved+?4,chunks=chunks+?5 WHERE workspace=?1", params![workspace, stats[0], stats[1], stats[2], stats[3]]).map_err(err)?;
        }
        tx.commit().map_err(err)?;
        Ok((value, touched))
    }
    /// Plain statements on the writer connection (settings, sessions, registration).
    fn exec(&self, sql: &str, args: impl rusqlite::Params) -> Result<()> {
        self.writer
            .lock()
            .map_err(err)?
            .execute(sql, args)
            .map_err(err)?;
        Ok(())
    }
    pub fn quick_check(&self) -> Result<String> {
        self.writer
            .lock()
            .map_err(err)?
            .query_row("PRAGMA quick_check", [], |r| r.get(0))
            .map_err(err)
    }
    /// Copies committed WAL frames into the database without blocking the
    /// writer or readers. The monitor calls it about once a second.
    pub fn checkpoint_passive(&self) -> Result<()> {
        let mut slot = self.checkpointer.lock().map_err(err)?;
        if slot.is_none() {
            *slot = Some(connect(&self.path, 1024)?);
        }
        slot.as_ref()
            .unwrap()
            .query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |_| Ok(()))
            .map_err(err)
    }
    pub fn checkpoint(&self) -> Result<()> {
        *self.checkpointer.lock().map_err(err)? = None;
        self.readers.lock().map_err(err)?.clear();
        self.writer
            .lock()
            .map_err(err)?
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .map_err(err)
    }
    pub fn setting(&self, key: &str) -> Result<Value> {
        let v: Option<String> = self.read(|db| {
            db.query_row("SELECT value FROM settings WHERE key=?", [key], |r| {
                r.get(0)
            })
            .optional()
            .map_err(err)
        })?;
        v.map(|s| serde_json::from_str(&s).map_err(err))
            .transpose()
            .map(|v| v.unwrap_or(Value::Null))
    }
    pub fn set(&self, key: &str, v: &Value) -> Result<()> {
        self.exec(
            "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, v.to_string()],
        )
    }
    pub fn register(&self, id: &str, root: &str, name: &str) -> Result<()> {
        let conn = self.writer.lock().map_err(err)?;
        conn.execute("INSERT INTO workspaces(id,root,name) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET root=excluded.root,name=excluded.name", params![id, root, name]).map_err(err)?;
        conn.execute("INSERT OR IGNORE INTO stats(workspace) VALUES(?)", [id])
            .map_err(err)?;
        create_fts(&conn, id)
    }
    pub fn workspace_value(&self, id: &str, git: bool) -> Result<Value> {
        let s: String = self.read(|db| {
            db.query_row(
                if git {
                    "SELECT git FROM workspaces WHERE id=?"
                } else {
                    "SELECT session FROM workspaces WHERE id=?"
                },
                [id],
                |r| r.get(0),
            )
            .map_err(err)
        })?;
        serde_json::from_str(&s).map_err(err)
    }
    pub fn save_workspace_value(&self, id: &str, git: bool, v: &Value) -> Result<()> {
        self.exec(
            if git {
                "UPDATE workspaces SET git=? WHERE id=?"
            } else {
                "UPDATE workspaces SET session=? WHERE id=?"
            },
            params![v.to_string(), id],
        )
    }
    pub fn workspaces(&self) -> Result<Vec<Value>> {
        self.read(|db| {
            let mut stmt = db.prepare("SELECT w.id,w.root,w.name,coalesce(s.documents,0) FROM workspaces w LEFT JOIN stats s ON s.workspace=w.id ORDER BY name").map_err(err)?;
            let rows = stmt.query_map([], |r| Ok(json!({"id":r.get::<_,String>(0)?,"root":r.get::<_,String>(1)?,"name":r.get::<_,String>(2)?,"documents":r.get::<_,i64>(3)?}))).map_err(err)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)
        })
    }
    /// Streams the indexed tree in path order: `(path, kind, mtime, size, document hash)`.
    pub fn each_entry(
        &self,
        workspace: &str,
        mut f: impl FnMut(&str, Kind, f64, u64, Option<&str>),
    ) -> Result<()> {
        self.read(|db| {
            let mut stmt = db.prepare("SELECT e.path,e.kind,e.mtime,e.size,d.hash FROM entries e LEFT JOIN documents d ON d.workspace=e.workspace AND d.path=e.path WHERE e.workspace=? ORDER BY e.path").map_err(err)?;
            let mut rows = stmt.query([workspace]).map_err(err)?;
            while let Some(r) = rows.next().map_err(err)? {
                let path: String = r.get(0).map_err(err)?;
                let hash: Option<String> = r.get(4).map_err(err)?;
                f(&path, Kind::from_i64(r.get(1).map_err(err)?), r.get(2).map_err(err)?, r.get::<_, i64>(3).map_err(err)? as u64, hash.as_deref());
            }
            Ok(())
        })
    }
    pub fn entry(
        &self,
        workspace: &str,
        path: &str,
    ) -> Result<Option<(Kind, f64, u64, Option<String>)>> {
        self.read(|db| {
            db.query_row("SELECT e.kind,e.mtime,e.size,d.hash FROM entries e LEFT JOIN documents d ON d.workspace=e.workspace AND d.path=e.path WHERE e.workspace=? AND e.path=?", params![workspace, path], |r| {
                Ok((Kind::from_i64(r.get(0)?), r.get(1)?, r.get::<_, i64>(2)? as u64, r.get(3)?))
            })
            .optional()
            .map_err(err)
        })
    }
    pub fn has_entries(&self, workspace: &str) -> Result<bool> {
        self.read(|db| {
            db.query_row(
                "SELECT EXISTS(SELECT 1 FROM entries WHERE workspace=?)",
                [workspace],
                |r| r.get(0),
            )
            .map_err(err)
        })
    }
    /// Markdown paths whose lower-cased filename is one of `keys`: every
    /// candidate a link with one of those filenames can resolve to.
    pub fn named(&self, workspace: &str, keys: &HashSet<String>) -> Result<Vec<String>> {
        self.read(|db| {
            let mut stmt = db.prepare_cached("SELECT path FROM entries INDEXED BY entry_names WHERE workspace=? AND name_key=? AND kind=1").map_err(err)?;
            let mut out = vec![];
            for key in keys {
                for p in stmt.query_map(params![workspace, key], |r| r.get::<_, String>(0)).map_err(err)? {
                    out.push(p.map_err(err)?);
                }
            }
            Ok(out)
        })
    }
    /// A resolver that answers exactly for links whose filenames are in `keys`.
    pub fn resolver(
        &self,
        workspace: &str,
        keys: &HashSet<String>,
        sensitive: bool,
    ) -> Result<Resolver> {
        Ok(Resolver::new(
            self.named(workspace, keys)?.into_iter(),
            sensitive,
        ))
    }
    pub fn markdown_paths(&self, workspace: &str) -> Result<Vec<String>> {
        self.read(|db| {
            let mut stmt = db
                .prepare("SELECT path FROM entries WHERE workspace=? AND kind=1 ORDER BY path")
                .map_err(err)?;
            let rows = stmt
                .query_map([workspace], |r| r.get::<_, String>(0))
                .map_err(err)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)
        })
    }
    /// Markdown paths equal to `path` or inside it.
    pub fn markdown_under(&self, workspace: &str, path: &str) -> Result<Vec<String>> {
        self.read(|db| {
            let mut stmt = db.prepare("SELECT path FROM entries WHERE workspace=?1 AND kind=1 AND path=?2 UNION ALL SELECT path FROM entries WHERE workspace=?1 AND kind=1 AND path>=?3 AND path<?4").map_err(err)?;
            let rows = stmt.query_map(params![workspace, path, format!("{path}/"), format!("{path}0")], |r| r.get::<_, String>(0)).map_err(err)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)
        })
    }
    /// Markdown files in the tree that have no indexed document (unreadable).
    pub fn unreadable(&self, workspace: &str) -> Result<i64> {
        self.read(|db| db.query_row("SELECT count(*) FROM entries e WHERE e.workspace=?1 AND e.kind=1 AND NOT EXISTS(SELECT 1 FROM documents d WHERE d.workspace=?1 AND d.path=e.path)", [workspace], |r| r.get(0)).map_err(err))
    }
    pub fn document_paths(&self, workspace: &str) -> Result<Vec<String>> {
        self.read(|db| {
            let mut stmt = db
                .prepare("SELECT path FROM documents WHERE workspace=? ORDER BY path")
                .map_err(err)?;
            let rows = stmt
                .query_map([workspace], |r| r.get::<_, String>(0))
                .map_err(err)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)
        })
    }
    /// The catalog tree: Markdown files with titles, other files and folders.
    /// Titles equal to the filename are omitted; readers fall back to it.
    pub fn tree(&self, workspace: &str) -> Result<Value> {
        self.read(|db| {
            let mut stmt = db.prepare("SELECT e.path,e.kind,d.title FROM entries e LEFT JOIN documents d ON d.workspace=e.workspace AND d.path=e.path WHERE e.workspace=? ORDER BY e.path").map_err(err)?;
            let mut rows = stmt.query([workspace]).map_err(err)?;
            let (mut files, mut other, mut folders) = (vec![], vec![], vec![]);
            while let Some(r) = rows.next().map_err(err)? {
                let path: String = r.get(0).map_err(err)?;
                match Kind::from_i64(r.get(1).map_err(err)?) {
                    Kind::Folder => folders.push(json!(path)),
                    Kind::Other => other.push(json!({"path":path})),
                    Kind::Markdown => {
                        let title: Option<String> = r.get(2).map_err(err)?;
                        files.push(file_json(path, title));
                    }
                }
            }
            Ok(json!({"files":files,"otherFiles":other,"folders":folders,"warnings":[]}))
        })
    }
    /// Up to `limit` tree rows after `after` in path order, and the last path
    /// returned when more may follow. Readers load a large tree in pages.
    pub fn tree_page(
        &self,
        workspace: &str,
        after: &str,
        limit: usize,
    ) -> Result<(Value, Option<String>)> {
        self.read(|db| {
            let mut stmt = db.prepare_cached("SELECT e.path,e.kind,d.title FROM entries e LEFT JOIN documents d ON d.workspace=e.workspace AND d.path=e.path WHERE e.workspace=? AND e.path>? ORDER BY e.path LIMIT ?").map_err(err)?;
            let mut rows = stmt.query(params![workspace, after, limit as i64]).map_err(err)?;
            let (mut files, mut other, mut folders, mut count, mut last) = (vec![], vec![], vec![], 0, None);
            while let Some(r) = rows.next().map_err(err)? {
                let path: String = r.get(0).map_err(err)?;
                count += 1;
                match Kind::from_i64(r.get(1).map_err(err)?) {
                    Kind::Folder => folders.push(json!(path)),
                    Kind::Other => other.push(json!({"path":path})),
                    Kind::Markdown => files.push(file_json(path.clone(), r.get(2).map_err(err)?)),
                }
                last = Some(path);
            }
            Ok((json!({"files":files,"otherFiles":other,"folders":folders}), last.filter(|_| count == limit)))
        })
    }
    /// Current catalog rows for `paths`; absent paths are reported as removed.
    pub fn tree_changes(&self, workspace: &str, paths: &[String]) -> Result<Value> {
        self.read(|db| {
            let mut stmt = db.prepare_cached("SELECT e.kind,d.title FROM entries e LEFT JOIN documents d ON d.workspace=e.workspace AND d.path=e.path WHERE e.workspace=? AND e.path=?").map_err(err)?;
            let (mut files, mut other, mut folders, mut removed) = (vec![], vec![], vec![], vec![]);
            for path in paths {
                let row: Option<(i64, Option<String>)> = stmt.query_row(params![workspace, path], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(err)?;
                match row {
                    None => removed.push(json!(path)),
                    Some((kind, title)) => match Kind::from_i64(kind) {
                        Kind::Folder => folders.push(json!(path)),
                        Kind::Other => other.push(json!({"path":path})),
                        Kind::Markdown => files.push(file_json(path.clone(), title)),
                    },
                }
            }
            Ok(json!({"files":files,"otherFiles":other,"folders":folders,"removed":removed}))
        })
    }
    pub fn edges(&self, workspace: &str, path: Option<&str>, incoming: bool) -> Result<Vec<Value>> {
        self.read(|db| edges_on(db, workspace, path, incoming))
    }
    pub fn snapshot(&self, workspace: &str) -> Result<Value> {
        self.read(|db| {
            let mut stmt = db
                .prepare("SELECT path,metadata FROM documents WHERE workspace=? ORDER BY path")
                .map_err(err)?;
            let mut rows = stmt.query([workspace]).map_err(err)?;
            let mut entities = vec![];
            while let Some(r) = rows.next().map_err(err)? {
                entities.push(entity(
                    r.get(0).map_err(err)?,
                    &r.get::<_, String>(1).map_err(err)?,
                )?);
            }
            let mut edges = edges_on(db, workspace, None, false)?;
            let mut missing = HashSet::new();
            for e in &mut edges {
                let target = edge_json(e);
                if e["resolved"] == 0 && missing.insert(target.clone()) {
                    entities.push(broken(&target, e));
                }
            }
            Ok(json!({"entities":entities,"relationships":edges}))
        })
    }
    /// The graph node of an indexed article, or `None` when it has no document.
    pub fn graph_nodes(db: &Connection, workspace: &str, id: &str) -> Result<Option<Value>> {
        let meta: Option<String> = db
            .prepare_cached("SELECT metadata FROM documents WHERE workspace=? AND path=?")
            .map_err(err)?
            .query_row(params![workspace, id], |r| r.get(0))
            .optional()
            .map_err(err)?;
        meta.map(|m| entity(id.to_string(), &m)).transpose()
    }
    pub fn counts(&self, w: &str) -> Result<Value> {
        let (documents, relationships, unresolved, chunks): (i64, i64, i64, i64) =
            self.read(|db| {
                db.query_row(
                    "SELECT documents,relationships,unresolved,chunks FROM stats WHERE workspace=?",
                    [w],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .optional()
                .map_err(err)
                .map(|v| v.unwrap_or((0, 0, 0, 0)))
            })?;
        Ok(
            json!({"documents":documents,"relationships":relationships,"unresolved":unresolved,"chunks":chunks,"schema":SCHEMA}),
        )
    }
    /// Recomputes a workspace's counts from its rows (after a full refresh).
    pub fn recount(&self, w: &str) -> Result<()> {
        let conn = self.writer.lock().map_err(err)?;
        conn.execute("INSERT INTO stats(workspace,documents,relationships,unresolved,chunks) VALUES(?1,(SELECT count(*) FROM documents WHERE workspace=?1),(SELECT count(*) FROM relationships WHERE workspace=?1),(SELECT count(*) FROM relationships WHERE workspace=?1 AND target IS NULL),(SELECT count(*) FROM chunks WHERE workspace=?1)) ON CONFLICT(workspace) DO UPDATE SET documents=excluded.documents,relationships=excluded.relationships,unresolved=excluded.unresolved,chunks=excluded.chunks", [w]).map_err(err)?;
        Ok(())
    }
    pub fn neighbors(&self, w: &str, path: &str, depth: usize, limit: usize) -> Result<Value> {
        self.read(|db| {
            let mut items = vec![json!({"path":path,"depth":0,"via":null})];
            let mut seen = HashSet::from([path.to_string()]);
            let mut queue = VecDeque::from([(path.to_string(), 0)]);
            let mut truncated = false;
            while let Some((at, d)) = queue.pop_front() {
                if d >= depth.min(3) {
                    continue;
                }
                let mut edges = edges_on(db, w, Some(&at), false)?;
                edges.extend(edges_on(db, w, Some(&at), true)?);
                for e in edges {
                    if e["resolved"] == 0 {
                        continue;
                    }
                    let next = if e["source_document_id"] == at {
                        e["target_document_id"].as_str()
                    } else {
                        e["source_document_id"].as_str()
                    }
                    .unwrap_or("");
                    if seen.contains(next) {
                        continue;
                    }
                    if items.len() >= limit.clamp(1, 100) {
                        truncated = true;
                        continue;
                    }
                    seen.insert(next.into());
                    queue.push_back((next.into(), d + 1));
                    items.push(json!({"path":next,"depth":d+1,"via":e}));
                }
            }
            Ok(json!({"documents":items,"truncated":truncated}))
        })
    }
    /// BM25 search of one workspace. The FTS index is filtered to the workspace
    /// and ranked with a bounded top-k; the best chunk per article is kept and
    /// passage bodies are loaded only for the winners. A newer search on the same
    /// `channel` interrupts this one, which then returns `cancelled`.
    pub fn search_on(
        &self,
        w: &str,
        query: &str,
        limit: usize,
        channel: Option<&str>,
    ) -> Result<Value> {
        let expression = fts_query(query);
        if expression.is_empty() {
            return Ok(json!({"method":"bm25","results":[],"notices":[]}));
        }
        let limit = limit.clamp(1, 100);
        let table = fts_table(w);
        let serial = self.serial.fetch_add(1, Ordering::Relaxed);
        let key = channel.map(|c| format!("{w}\n{c}"));
        let result = self.read(|db| {
            if let Some(key) = &key {
                let mut running = self.searches.lock().map_err(err)?;
                if let Some((_, previous)) = running.insert(key.clone(), (serial, db.get_interrupt_handle())) {
                    previous.interrupt();
                }
            }
            let run = || -> rusqlite::Result<Vec<Value>> {
                let mut cap = (limit * 8).max(200);
                let (best, hits) = loop {
                    let mut stmt = db.prepare_cached(&format!("SELECT c.rowid,c.path,top.score FROM (SELECT rowid,bm25({table},8.0,4.0,1.0) AS score FROM {table} WHERE {table} MATCH ?1 ORDER BY score LIMIT ?2) top JOIN chunks c ON c.rowid=top.rowid"))?;
                    let rows: Vec<(i64, String, f64)> = stmt.query_map(params![expression, cap as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<_>>()?;
                    let hits = rows.len();
                    let mut best: BTreeMap<String, (f64, i64)> = BTreeMap::new();
                    for (rowid, path, score) in rows {
                        let entry = best.entry(path).or_insert((score, rowid));
                        if (score, rowid) < *entry {
                            *entry = (score, rowid);
                        }
                    }
                    // Enough distinct articles, or every match seen: the top
                    // articles by best chunk are exact.
                    if best.len() >= limit || hits < cap || cap >= 20000 {
                        break (best, hits);
                    }
                    cap *= 4;
                };
                let _ = hits;
                let mut ranked: Vec<(f64, String, i64)> = best.into_iter().map(|(p, (s, r))| (s, p, r)).collect();
                ranked.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
                ranked.truncate(limit);
                let mut body = db.prepare_cached("SELECT id,path,title,body,start_line,end_line,source_hash FROM chunks WHERE rowid=?")?;
                ranked
                    .into_iter()
                    .map(|(score, _, rowid)| {
                        body.query_row([rowid], |r| {
                            Ok(json!({"chunkId":r.get::<_,String>(0)?,"path":r.get::<_,String>(1)?,"title":r.get::<_,String>(2)?,"excerpt":{"text":r.get::<_,String>(3)?,"line":r.get::<_,i64>(4)?,"endLine":r.get::<_,i64>(5)?},"contentHash":r.get::<_,String>(6)?,"score":-score,"method":"bm25"}))
                        })
                    })
                    .collect()
            };
            let outcome = run();
            if let Some(key) = &key {
                let mut running = self.searches.lock().map_err(err)?;
                if running.get(key).is_some_and(|(s, _)| *s == serial) {
                    running.remove(key);
                }
            }
            match outcome {
                Ok(results) => Ok(json!({"method":"bm25","results":results,"notices":[]})),
                Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::OperationInterrupted => Ok(json!({"method":"bm25","results":[],"notices":[],"cancelled":true})),
                Err(e) => Err(err(e)),
            }
        })?;
        Ok(result)
    }
    pub fn search(&self, w: &str, query: &str, limit: usize) -> Result<Value> {
        self.search_on(w, query, limit, None)
    }
    fn kanban_boards(db: &Connection, w: &str) -> Result<Vec<Board>> {
        let mut columns: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        let mut stmt = db.prepare_cached("SELECT board,id,title FROM kanban_columns WHERE workspace=? ORDER BY board,ordinal").map_err(err)?;
        let rows = stmt
            .query_map([w], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(err)?;
        for row in rows {
            let (board, id, title) = row.map_err(err)?;
            columns
                .entry(board)
                .or_default()
                .push(json!({"id":id,"title":title}));
        }
        let mut stmt = db.prepare_cached("SELECT b.path,d.title,b.name_key,b.path_key,b.warnings FROM kanban_boards b JOIN documents d ON d.workspace=b.workspace AND d.path=b.path WHERE b.workspace=? ORDER BY b.path").map_err(err)?;
        let rows = stmt
            .query_map([w], |r| {
                Ok(Board {
                    path: r.get(0)?,
                    title: r.get(1)?,
                    name_key: r.get(2)?,
                    path_key: r.get(3)?,
                    warnings: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or(json!([])),
                    columns: vec![],
                })
            })
            .map_err(err)?;
        let mut boards = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)?;
        for b in &mut boards {
            b.columns = columns.remove(&b.path).unwrap_or_default();
        }
        Ok(boards)
    }
    /// Cards of a workspace, or of one board (`keys`: its name and path keys).
    fn kanban_cards(
        db: &Connection,
        w: &str,
        keys: Option<(&str, &str)>,
        boards: &[Board],
    ) -> Result<Vec<Value>> {
        let sql = format!("SELECT c.path,d.title,c.board_ref,c.by_path,c.board_key,c.column_id,c.rank,CASE json_type(d.metadata,'$.metadata.description') WHEN 'text' THEN json_extract(d.metadata,'$.metadata.description') END,json_extract(d.metadata,'$.tags'),CASE json_type(d.metadata,'$.metadata.updated_at') WHEN 'text' THEN json_extract(d.metadata,'$.metadata.updated_at') END FROM kanban_cards c JOIN documents d ON d.workspace=c.workspace AND d.path=c.path WHERE c.workspace=?1 {} ORDER BY c.path", if keys.is_some() {"AND ((c.by_path=0 AND c.board_key=?2) OR (c.by_path=1 AND c.board_key=?3))"} else {""});
        let mut stmt = db.prepare_cached(&sql).map_err(err)?;
        let map = |r: &rusqlite::Row| -> rusqlite::Result<Value> {
            let by_path: bool = r.get(3)?;
            let key: Option<String> = r.get(4)?;
            let column: Option<String> = r.get(5)?;
            let candidates: Vec<&Board> = boards
                .iter()
                .filter(|b| key.as_deref() == Some(if by_path { &b.path_key } else { &b.name_key }))
                .collect();
            let status = match candidates.as_slice() {
                [] => "missing-board",
                [_, _, ..] => "ambiguous-board",
                [b] => match &column {
                    None => "no-column",
                    Some(c) if b.columns.iter().any(|k| k["id"] == *c) => "ok",
                    Some(_) => "unknown-column",
                },
            };
            let tags: Value = r
                .get::<_, Option<String>>(8)?
                .and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or(json!([]));
            Ok(
                json!({"path":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"board":r.get::<_,String>(2)?,"boardPath":if candidates.len()==1{Some(&candidates[0].path)}else{None},"candidates":candidates.iter().map(|b|&b.path).collect::<Vec<_>>(),"column":column,"rank":r.get::<_,Option<f64>>(6)?,"status":status,"description":r.get::<_,Option<String>>(7)?.map(|s|s.trim().to_string()).unwrap_or_default(),"tags":tags.as_array().map(|t|t.iter().take(3).cloned().collect::<Vec<_>>()).unwrap_or_default(),"updated":r.get::<_,Option<String>>(9)?}),
            )
        };
        let rows = match keys {
            Some((name, path)) => stmt.query_map(params![w, name, path], map),
            None => stmt.query_map(params![w], map),
        }
        .map_err(err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)
    }
    fn board_json(board: &Board, boards: &[Board]) -> Value {
        let duplicates: Vec<&String> = boards
            .iter()
            .filter(|b| b.path != board.path && b.name_key == board.name_key)
            .map(|b| &b.path)
            .collect();
        json!({"path":board.path,"title":board.title,"name":crate::kanban::filename(&board.path),"columns":board.columns,"warnings":board.warnings,"duplicates":duplicates})
    }
    /// Every board with its columns, duplicate names and card counts, and every
    /// card with its status: ok, unknown-column, no-column, missing-board or
    /// ambiguous-board (a filename that several boards share).
    pub fn kanban_summary(&self, w: &str) -> Result<Value> {
        self.read(|db| {
            let boards = Self::kanban_boards(db, w)?;
            let cards = Self::kanban_cards(db, w, None, &boards)?;
            let list: Vec<Value> = boards
                .iter()
                .map(|b| {
                    let on = |c: &&Value| {
                        c["candidates"]
                            .as_array()
                            .is_some_and(|p| p.iter().any(|p| p == &b.path))
                    };
                    let mut v = Self::board_json(b, &boards);
                    v["cards"] = json!(cards.iter().filter(on).count());
                    v["attention"] = json!(cards
                        .iter()
                        .filter(on)
                        .filter(|c| c["status"] != "ok")
                        .count());
                    v
                })
                .collect();
            let cards: Vec<Value> = cards
                .into_iter()
                .map(|mut c| {
                    let o = c.as_object_mut().unwrap();
                    for key in ["description", "tags", "updated"] {
                        o.remove(key);
                    }
                    c
                })
                .collect();
            Ok(json!({"boards":list,"cards":cards}))
        })
    }
    /// One board and the cards that name it, including cards it cannot place.
    pub fn kanban_board(&self, w: &str, path: &str) -> Result<Value> {
        self.read(|db| {
            let boards = Self::kanban_boards(db, w)?;
            let board = boards
                .iter()
                .find(|b| b.path == path)
                .ok_or("This article is not a Kanban board.")?;
            let cards: Vec<Value> =
                Self::kanban_cards(db, w, Some((&board.name_key, &board.path_key)), &boards)?
                    .into_iter()
                    .map(|mut c| {
                        let o = c.as_object_mut().unwrap();
                        o.remove("boardPath");
                        o.remove("candidates");
                        c
                    })
                    .collect();
            Ok(json!({"board":Self::board_json(board,&boards),"cards":cards}))
        })
    }
    /// Sources of resolved links into `paths` or anything under the folders in `prefixes`.
    pub fn linking_into(
        &self,
        w: &str,
        paths: &[String],
        prefixes: &[String],
    ) -> Result<HashSet<String>> {
        self.read(|db| {
            let mut out = HashSet::new();
            let mut exact = db.prepare_cached("SELECT DISTINCT source FROM relationships INDEXED BY incoming WHERE workspace=? AND target=?").map_err(err)?;
            for p in paths {
                for s in exact.query_map(params![w, p], |r| r.get::<_, String>(0)).map_err(err)? {
                    out.insert(s.map_err(err)?);
                }
            }
            let mut range = db.prepare_cached("SELECT DISTINCT source FROM relationships INDEXED BY incoming WHERE workspace=? AND target>=? AND target<?").map_err(err)?;
            for p in prefixes {
                for s in range.query_map(params![w, format!("{p}/"), format!("{p}0")], |r| r.get::<_, String>(0)).map_err(err)? {
                    out.insert(s.map_err(err)?);
                }
            }
            Ok(out)
        })
    }
}
fn file_json(path: String, title: Option<String>) -> Value {
    let stem = path
        .rsplit('/')
        .next()
        .map(|f| &f[..f.len().saturating_sub(3)])
        .unwrap_or("");
    match title {
        Some(t) if t != stem => json!({"path":path,"title":t}),
        _ => json!({"path":path}),
    }
}
fn entity(path: String, metadata: &str) -> Result<Value> {
    let mut meta: Value = serde_json::from_str(metadata).map_err(err)?;
    let o = meta.as_object_mut().unwrap();
    o.remove("body");
    o.insert("id".into(), json!(path));
    o.insert("file".into(), json!(path));
    o.insert("relative_path".into(), json!(path));
    o.insert("name".into(), o["title"].clone());
    Ok(meta)
}
/// Adds the graph fields to a stored relationship record; returns its target node id.
pub fn edge_json(e: &mut Value) -> String {
    let target = e["target_document_id"]
        .as_str()
        .map(String::from)
        .unwrap_or_else(|| {
            format!(
                "broken:{}:{}",
                e["reason"].as_str().unwrap_or("missing"),
                e["target_path"].as_str().unwrap_or("")
            )
        });
    e["from"] = e["source_document_id"].clone();
    e["to"] = json!(target);
    e["type"] = e["relationship_type"].clone();
    e["description"] = e["raw"].clone();
    e["tags"] = json!([]);
    e["category"] = json!("dependency");
    target
}
pub fn broken(id: &str, e: &Value) -> Value {
    json!({"id":id,"name":e["authored_target"],"type":"unresolved","tags":[e["reason"]],"broken":true,"candidates":serde_json::from_str::<Value>(e["candidates"].as_str().unwrap_or("[]")).unwrap_or(json!([]))})
}
pub fn edges_on(
    db: &Connection,
    workspace: &str,
    path: Option<&str>,
    incoming: bool,
) -> Result<Vec<Value>> {
    let sql = if path.is_none() {
        "SELECT record FROM relationships WHERE workspace=? ORDER BY source,start"
    } else if incoming {
        "SELECT record FROM relationships INDEXED BY incoming WHERE workspace=? AND target=? ORDER BY source,start"
    } else {
        "SELECT record FROM relationships WHERE workspace=? AND source=? ORDER BY start"
    };
    let mut stmt = db.prepare_cached(sql).map_err(err)?;
    let mut rows = match path {
        Some(p) => stmt.query(params![workspace, p]),
        None => stmt.query(params![workspace]),
    }
    .map_err(err)?;
    let mut out = vec![];
    while let Some(r) = rows.next().map_err(err)? {
        out.push(serde_json::from_str(&r.get::<_, String>(0).map_err(err)?).map_err(err)?);
    }
    Ok(out)
}
/// An open index transaction for one workspace. Counts it changes are applied
/// to `stats` on commit; `touched` lists catalog paths it changed.
pub struct Writer<'a> {
    pub tx: rusqlite::Transaction<'a>,
    workspace: String,
    /// documents, relationships, unresolved, chunks
    stats: [i64; 4],
    touched: Vec<String>,
}
impl Writer<'_> {
    pub fn hash(&self, path: &str) -> Result<Option<String>> {
        self.tx
            .prepare_cached("SELECT hash FROM documents WHERE workspace=? AND path=?")
            .map_err(err)?
            .query_row(params![self.workspace, path], |r| r.get(0))
            .optional()
            .map_err(err)
    }
    pub fn entry_kind(&self, path: &str) -> Result<Option<Kind>> {
        let kind: Option<i64> = self
            .tx
            .prepare_cached("SELECT kind FROM entries WHERE workspace=? AND path=?")
            .map_err(err)?
            .query_row(params![self.workspace, path], |r| r.get(0))
            .optional()
            .map_err(err)?;
        Ok(kind.map(Kind::from_i64))
    }
    /// Deletes a document's derived rows; true when the document existed.
    fn clear(&mut self, path: &str) -> Result<bool> {
        let w = self.workspace.clone();
        let (links, unresolved): (i64, i64) = self.tx.prepare_cached("SELECT count(*),coalesce(sum(target IS NULL),0) FROM relationships WHERE workspace=? AND source=?").map_err(err)?.query_row(params![w, path], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?;
        self.tx
            .prepare_cached("DELETE FROM relationships WHERE workspace=? AND source=?")
            .map_err(err)?
            .execute(params![w, path])
            .map_err(err)?;
        self.tx.prepare_cached(&format!("DELETE FROM {} WHERE rowid IN (SELECT rowid FROM chunks WHERE workspace=? AND path=?)", fts_table(&w))).map_err(err)?.execute(params![w, path]).map_err(err)?;
        let chunks = self
            .tx
            .prepare_cached("DELETE FROM chunks WHERE workspace=? AND path=?")
            .map_err(err)?
            .execute(params![w, path])
            .map_err(err)? as i64;
        self.tx
            .prepare_cached("DELETE FROM kanban_boards WHERE workspace=? AND path=?")
            .map_err(err)?
            .execute(params![w, path])
            .map_err(err)?;
        self.tx
            .prepare_cached("DELETE FROM kanban_cards WHERE workspace=? AND path=?")
            .map_err(err)?
            .execute(params![w, path])
            .map_err(err)?;
        self.stats[1] -= links;
        self.stats[2] -= unresolved;
        self.stats[3] -= chunks;
        Ok(self.hash(path)?.is_some())
    }
    /// Replaces a document's rows. Links must already be resolved (`p.rows`).
    /// `existed` is false only when the caller knows it has no rows yet.
    pub fn put_document(&mut self, p: &Prepared, sensitive: bool, existed: bool) -> Result<()> {
        let w = self.workspace.clone();
        let existed = existed && self.clear(&p.path)?;
        self.tx.prepare_cached("INSERT INTO documents(workspace,path,hash,mtime,metadata,title) VALUES(?,?,?,?,?,?) ON CONFLICT(workspace,path) DO UPDATE SET hash=excluded.hash,mtime=excluded.mtime,metadata=excluded.metadata,title=excluded.title").map_err(err)?
            .execute(params![w, p.path, p.hash, p.mtime, p.metadata.to_string(), p.title]).map_err(err)?;
        if !existed {
            self.stats[0] += 1;
        }
        index_kanban(&self.tx, &w, &p.path, &p.metadata["metadata"], sensitive)?;
        let mut insert = self.tx.prepare_cached("INSERT INTO chunks(id,workspace,path,ordinal,start_byte,end_byte,start_line,end_line,source_hash,content_hash,title,body) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").map_err(err)?;
        let mut search = self
            .tx
            .prepare_cached(&format!(
                "INSERT INTO {}(rowid,title,path,body) VALUES(?,?,?,?)",
                fts_table(&w)
            ))
            .map_err(err)?;
        for c in &p.chunks {
            insert
                .execute(params![
                    c.id,
                    w,
                    p.path,
                    c.ordinal as i64,
                    c.start as i64,
                    c.end as i64,
                    c.line as i64,
                    c.end_line as i64,
                    p.hash,
                    c.content_hash,
                    p.title,
                    c.body
                ])
                .map_err(err)?;
            search
                .execute(params![
                    self.tx.last_insert_rowid(),
                    p.title,
                    p.path,
                    c.body
                ])
                .map_err(err)?;
        }
        drop(insert);
        drop(search);
        self.stats[3] += p.chunks.len() as i64;
        self.put_links(&p.path, &p.rows)?;
        // Every document is in the tree; the walk's metadata may refine it later.
        self.tx.prepare_cached("INSERT INTO entries(workspace,path,kind,mtime,size,name_key) VALUES(?,?,1,?,?,?) ON CONFLICT(workspace,path) DO NOTHING").map_err(err)?
            .execute(params![w, p.path, p.mtime, p.size as i64, name_key(&p.path)]).map_err(err)?;
        self.touched.push(p.path.clone());
        Ok(())
    }
    fn put_links(&mut self, source: &str, rows: &[LinkRow]) -> Result<()> {
        let mut insert = self.tx.prepare_cached("INSERT INTO relationships(workspace,source,start,target,record,target_key) VALUES(?,?,?,?,?,?)").map_err(err)?;
        for l in rows {
            insert
                .execute(params![
                    self.workspace,
                    source,
                    l.start as i64,
                    l.target,
                    l.record,
                    l.key
                ])
                .map_err(err)?;
        }
        self.stats[1] += rows.len() as i64;
        self.stats[2] += rows.iter().filter(|l| l.target.is_none()).count() as i64;
        Ok(())
    }
    /// Updates only a document's modification time (content unchanged).
    pub fn touch_document(&mut self, path: &str, mtime: f64) -> Result<()> {
        self.tx
            .prepare_cached("UPDATE documents SET mtime=? WHERE workspace=? AND path=?")
            .map_err(err)?
            .execute(params![mtime, self.workspace, path])
            .map_err(err)?;
        Ok(())
    }
    pub fn delete_document(&mut self, path: &str) -> Result<bool> {
        let existed = self.clear(path)?;
        if existed {
            self.tx
                .prepare_cached("DELETE FROM documents WHERE workspace=? AND path=?")
                .map_err(err)?
                .execute(params![self.workspace, path])
                .map_err(err)?;
            self.stats[0] -= 1;
            self.touched.push(path.to_string());
        }
        Ok(existed)
    }
    pub fn put_entry(&mut self, e: &Entry) -> Result<()> {
        self.tx.prepare_cached("INSERT INTO entries(workspace,path,kind,mtime,size,name_key) VALUES(?,?,?,?,?,?) ON CONFLICT(workspace,path) DO UPDATE SET kind=excluded.kind,mtime=excluded.mtime,size=excluded.size").map_err(err)?
            .execute(params![self.workspace, e.path, e.kind as i64, e.mtime, e.size as i64, name_key(&e.path)]).map_err(err)?;
        self.touched.push(e.path.clone());
        Ok(())
    }
    /// Removes an entry and, for a folder, everything under it. Returns the
    /// Markdown paths removed.
    pub fn remove_entry(&mut self, path: &str) -> Result<Vec<String>> {
        let w = self.workspace.clone();
        let mut gone: Vec<(String, i64)> = self.tx.prepare_cached("SELECT path,kind FROM entries WHERE workspace=?1 AND path=?2 UNION ALL SELECT path,kind FROM entries WHERE workspace=?1 AND path>=?3 AND path<?4").map_err(err)?
            .query_map(params![w, path, format!("{path}/"), format!("{path}0")], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?
            .collect::<rusqlite::Result<_>>().map_err(err)?;
        // Documents without an entry (an interrupted earlier run) go too.
        let docs: Vec<String> = self.tx.prepare_cached("SELECT path FROM documents WHERE workspace=?1 AND path=?2 UNION ALL SELECT path FROM documents WHERE workspace=?1 AND path>=?3 AND path<?4").map_err(err)?
            .query_map(params![w, path, format!("{path}/"), format!("{path}0")], |r| r.get(0)).map_err(err)?
            .collect::<rusqlite::Result<_>>().map_err(err)?;
        for d in docs {
            if !gone.iter().any(|(p, _)| *p == d) {
                gone.push((d, 1));
            }
        }
        let mut markdown = vec![];
        for (p, kind) in &gone {
            self.delete_document(p)?;
            if Kind::from_i64(*kind) == Kind::Markdown {
                markdown.push(p.clone());
            }
            self.touched.push(p.clone());
        }
        self.tx
            .prepare_cached("DELETE FROM entries WHERE workspace=?1 AND path=?2")
            .map_err(err)?
            .execute(params![w, path])
            .map_err(err)?;
        self.tx
            .prepare_cached("DELETE FROM entries WHERE workspace=?1 AND path>=?2 AND path<?3")
            .map_err(err)?
            .execute(params![w, format!("{path}/"), format!("{path}0")])
            .map_err(err)?;
        Ok(markdown)
    }
    /// Resolves again every stored link whose filename key is in `keys` (the
    /// filenames of added or removed articles), except links of `skip`
    /// sources, which were just written with current resolution.
    pub fn reresolve(
        &mut self,
        keys: &HashSet<String>,
        skip: &HashSet<String>,
        resolver: &Resolver,
    ) -> Result<usize> {
        let w = self.workspace.clone();
        let mut changed = vec![];
        {
            let mut stmt = self.tx.prepare_cached("SELECT source,start,target,record FROM relationships INDEXED BY relationship_keys WHERE workspace=? AND target_key=?").map_err(err)?;
            for key in keys {
                let rows = stmt
                    .query_map(params![w, key], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, i64>(1)?,
                            r.get::<_, Option<String>>(2)?,
                            r.get::<_, String>(3)?,
                        ))
                    })
                    .map_err(err)?;
                for row in rows {
                    let (source, start, old, record) = row.map_err(err)?;
                    if skip.contains(&source) {
                        continue;
                    }
                    if let Some((target, record)) = crate::index::reresolve(&record, resolver) {
                        changed.push((source, start, old.is_none(), target, record));
                    }
                }
            }
        }
        let mut update = self.tx.prepare_cached("UPDATE relationships SET target=?,record=? WHERE workspace=? AND source=? AND start=?").map_err(err)?;
        for (source, start, was_unresolved, target, record) in &changed {
            update
                .execute(params![target, record, w, source, start])
                .map_err(err)?;
            self.stats[2] += target.is_none() as i64 - *was_unresolved as i64;
        }
        Ok(changed.len())
    }
    /// Resolves every stored link again with a complete resolver, except `skip`.
    pub fn reresolve_all(&mut self, skip: &HashSet<String>, resolver: &Resolver) -> Result<usize> {
        let w = self.workspace.clone();
        let mut changed = vec![];
        {
            let mut stmt = self
                .tx
                .prepare("SELECT source,start,target,record FROM relationships WHERE workspace=?")
                .map_err(err)?;
            let rows = stmt
                .query_map([&w], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                })
                .map_err(err)?;
            for row in rows {
                let (source, start, old, record) = row.map_err(err)?;
                if !skip.contains(&source) {
                    if let Some((target, record)) = crate::index::reresolve(&record, resolver) {
                        changed.push((source, start, old.is_none(), target, record));
                    }
                }
            }
        }
        let mut update = self.tx.prepare_cached("UPDATE relationships SET target=?,record=? WHERE workspace=? AND source=? AND start=?").map_err(err)?;
        for (source, start, was_unresolved, target, record) in &changed {
            update
                .execute(params![target, record, w, source, start])
                .map_err(err)?;
            self.stats[2] += target.is_none() as i64 - *was_unresolved as i64;
        }
        Ok(changed.len())
    }
}
struct Board {
    path: String,
    title: String,
    name_key: String,
    path_key: String,
    warnings: Value,
    columns: Vec<Value>,
}
/// Replaces a document's Kanban rows (board, columns and card) from its frontmatter.
fn index_kanban(
    tx: &rusqlite::Transaction,
    workspace: &str,
    path: &str,
    fields: &Value,
    sensitive: bool,
) -> Result<()> {
    if kanban::is_board(fields) {
        let (columns, warnings) = kanban::columns(fields);
        tx.prepare_cached("INSERT INTO kanban_boards VALUES(?,?,?,?,?)")
            .map_err(err)?
            .execute(params![
                workspace,
                path,
                kanban::fold(kanban::filename(path), sensitive),
                kanban::fold(path, sensitive),
                json!(warnings).to_string()
            ])
            .map_err(err)?;
        let mut insert = tx
            .prepare_cached("INSERT INTO kanban_columns VALUES(?,?,?,?,?)")
            .map_err(err)?;
        for (ordinal, (id, title)) in columns.iter().enumerate() {
            insert
                .execute(params![workspace, path, ordinal as i64, id, title])
                .map_err(err)?;
        }
    }
    if let Some(card) = kanban::card(fields) {
        let (by_path, key) = kanban::reference(&card.board, path, sensitive);
        tx.prepare_cached("INSERT INTO kanban_cards VALUES(?,?,?,?,?,?,?)")
            .map_err(err)?
            .execute(params![
                workspace,
                path,
                card.board,
                by_path,
                key,
                card.column,
                card.rank
            ])
            .map_err(err)?;
    }
    Ok(())
}
pub fn fts_query(query: &str) -> String {
    let mut positive = vec![];
    let mut negative = vec![];
    let mut chars = query.chars().take(1000).peekable();
    while chars.peek().is_some() {
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
        let neg = chars.peek() == Some(&'-');
        if neg {
            chars.next();
        }
        let quoted = chars.peek() == Some(&'"');
        if quoted {
            chars.next();
        }
        let mut term = String::new();
        while let Some(&c) = chars.peek() {
            if (quoted && c == '"') || (!quoted && c.is_whitespace()) {
                chars.next();
                break;
            }
            term.push(c);
            chars.next();
        }
        let prefix = !quoted && term.ends_with('*');
        let term = term.trim_end_matches('*');
        if !term.chars().any(char::is_alphanumeric) {
            continue;
        }
        let term = format!(
            "\"{}\"{}",
            term.replace('"', "\"\""),
            if prefix { "*" } else { "" }
        );
        if neg {
            negative.push(term);
        } else {
            positive.push(term);
        }
    }
    if positive.is_empty() {
        return String::new();
    }
    let mut result = positive.join(" AND ");
    for n in negative {
        result = format!("({result}) NOT {n}");
    }
    result
}
