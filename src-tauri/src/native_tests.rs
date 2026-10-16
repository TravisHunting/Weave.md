use crate::{
    backend::Backend,
    database::{chunks, fts_query},
    markdown, native_files as files,
};
use serde_json::{json, Value};
use std::{
    fs,
    sync::{atomic::AtomicBool, Arc},
};
struct Fixture {
    temp: tempfile::TempDir,
    backend: Backend,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Notes");
        fs::create_dir(&root).unwrap();
        fs::write(
            root.join("Start.md"),
            "# Start\n\nPolicy ABC-901 moves. [Store](./Store.md \"writes-to\")\n",
        )
        .unwrap();
        fs::write(
            root.join("Store.md"),
            "# Warehouse\n\nPolicy data lives here.\n",
        )
        .unwrap();
        let backend =
            Backend::new(temp.path().join(".weave"), Arc::new(AtomicBool::new(false))).unwrap();
        backend.open(root.to_str().unwrap()).unwrap();
        backend.reconcile(true).unwrap();
        Self { temp, backend }
    }
    fn call(&mut self, op: &str, mut args: Value) -> Result<Value, String> {
        args["scope"] = json!(self.backend.scope());
        self.backend.request(op, args)
    }
    fn root(&self) -> std::path::PathBuf {
        self.temp.path().join("Notes")
    }
}
#[test]
fn fts_chunks_rank_scope_update_delete() {
    let mut f = Fixture::new();
    let found = f
        .call("searchKnowledge", json!({"query":"ABC-901"}))
        .unwrap();
    assert_eq!(found["results"][0]["path"], "Start.md");
    assert_eq!(found["method"], "bm25");
    assert!(found["results"][0]["chunkId"].is_string());
    assert_eq!(
        f.call("searchKnowledge", json!({"query":"\"data lives\""}))
            .unwrap()["results"][0]["path"],
        "Store.md"
    );
    assert!(f
        .call("searchKnowledge", json!({"query":"\"lives data\""}))
        .unwrap()["results"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        f.call("searchKnowledge", json!({"query":"policy -moves"}))
            .unwrap()["results"][0]["path"],
        "Store.md"
    );
    let d = f.call("getDocument", json!({"path":"Start.md"})).unwrap();
    f.call(
        "save",
        json!({"path":"Start.md","text":"# New\nuniqueterm","hash":d["hash"]}),
    )
    .unwrap();
    assert!(f
        .call("searchKnowledge", json!({"query":"ABC-901"}))
        .unwrap()["results"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        f.call("searchKnowledge", json!({"query":"uniqueterm"}))
            .unwrap()["results"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    f.call("delete", json!({"path":"Start.md","confirmed":true}))
        .unwrap();
    assert!(f
        .call("searchKnowledge", json!({"query":"uniqueterm"}))
        .unwrap()["results"]
        .as_array()
        .unwrap()
        .is_empty());
    let other = f.temp.path().join("Other");
    fs::create_dir(&other).unwrap();
    fs::write(other.join("Private.md"), "# Hidden\nothersecret").unwrap();
    f.backend.open(other.to_str().unwrap()).unwrap();
    f.backend.reconcile(true).unwrap();
    assert!(f
        .call("searchKnowledge", json!({"query":"policy"}))
        .unwrap()["results"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(f.backend.database.workspaces().unwrap().len(), 2);
}
#[test]
fn search_long_unicode_chunks_and_best_article() {
    let mut f = Fixture::new();
    let text = format!(
        "# Long\n{}\nneedlelast 漢字 café\n",
        "ordinary prose words\n".repeat(500)
    );
    fs::write(f.root().join("Long.md"), &text).unwrap();
    f.backend.reconcile(true).unwrap();
    let found = f
        .call("searchKnowledge", json!({"query":"needlelast"}))
        .unwrap();
    let r = &found["results"][0];
    assert_eq!(r["path"], "Long.md");
    assert!(r["excerpt"]["line"].as_u64().unwrap() > 400);
    assert!(r["excerpt"]["text"]
        .as_str()
        .unwrap()
        .contains("needlelast"));
    let c = chunks(&text);
    assert!(c.len() > 5);
    for c in c {
        assert_eq!(&text[c.start..c.end], c.text);
        assert!(c.end - c.start <= 1800);
    }
    let found = f
        .call("searchKnowledge", json!({"query":"ordinary","limit":30}))
        .unwrap();
    assert_eq!(found["results"].as_array().unwrap().len(), 1);
    assert!(
        !f.call("searchKnowledge", json!({"query":"cafe"})).unwrap()["results"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
#[test]
fn fts_literals_cannot_inject_operators() {
    for text in ["a😀é漢\n".repeat(1000), " ".repeat(5000)] {
        for chunk in chunks(&text) {
            assert!(chunk.end - chunk.start <= 1800);
            assert_eq!(&text[chunk.start..chunk.end], chunk.text);
        }
    }
    for query in [
        "\"",
        "-",
        "*",
        "NOT",
        "near(a)",
        "a OR b",
        "x\" OR 1=1",
        "a : b",
        "😀",
        "foo*",
        "-foo",
    ] {
        let expr = fts_query(query);
        let mut f = Fixture::new();
        f.call("searchKnowledge", json!({"query":query}))
            .unwrap_or_else(|e| panic!("{query} -> {expr}: {e}"));
    }
}
#[test]
fn hashes_encoding_conflicts_and_resources() {
    let mut f = Fixture::new();
    let bytes = files::encode("# UTF16\r\n漢字\r\n", true, true);
    fs::write(f.root().join("Unicode.md"), &bytes).unwrap();
    f.backend.reconcile(true).unwrap();
    let d = f.call("getDocument", json!({"path":"Unicode.md"})).unwrap();
    assert_eq!(d["hash"], files::hash(bytes));
    let resource = d["resource"].clone();
    f.call(
        "save",
        json!({"resource":resource,"text":"# UTF16\r\nChanged\r\n","hash":d["hash"]}),
    )
    .unwrap();
    assert!(fs::read(f.root().join("Unicode.md"))
        .unwrap()
        .starts_with(&[255, 254]));
    assert!(f
        .call(
            "save",
            json!({"path":"Unicode.md","text":"oops","hash":d["hash"]})
        )
        .unwrap_err()
        .contains("changed outside"));
    assert!(f
        .call(
            "getDocument",
            json!({"resource":{"workspaceId":"wrong","kind":"file","logicalPath":"/Start.md"}})
        )
        .unwrap_err()
        .contains("different workspace"));
    assert!(f
        .backend
        .request("getDocument", json!({"scope":0,"path":"Start.md"}))
        .unwrap_err()
        .contains("workspace changed"));
    for p in [
        "../outside.md",
        ".weave/a.md",
        "/Start.md",
        "CON.md",
        "a/../b.md",
        "a/b:stream.md",
    ] {
        assert!(f.call("getDocument", json!({"path":p})).is_err());
    }
}
#[test]
#[cfg(windows)]
fn journal_update_waits_for_a_short_windows_file_lock() {
    use std::os::windows::fs::OpenOptionsExt;
    let temp = tempfile::tempdir().unwrap();
    let journal = temp.path().join("journal.json");
    files::json_write(&journal, &json!({"state":"prepared"})).unwrap();
    // FILE_SHARE_READ permits the hash recheck but blocks replacing the file.
    let lock = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&journal)
        .unwrap();
    let unlock = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(220));
        drop(lock);
    });
    files::json_write(&journal, &json!({"state":"complete"})).unwrap();
    unlock.join().unwrap();
    let saved: Value = serde_json::from_slice(&fs::read(journal).unwrap()).unwrap();
    assert_eq!(saved["state"], "complete");
}
#[test]
#[cfg(windows)]
fn journal_retry_rejects_content_changed_while_locked() {
    use std::io::{Seek, SeekFrom, Write};
    use std::os::windows::fs::OpenOptionsExt;
    let temp = tempfile::tempdir().unwrap();
    let journal = temp.path().join("journal.json");
    files::json_write(&journal, &json!({"state":"prepared"})).unwrap();
    let mut lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(1)
        .open(&journal)
        .unwrap();
    let change = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(120));
        lock.set_len(0).unwrap();
        lock.seek(SeekFrom::Start(0)).unwrap();
        lock.write_all(b"external change").unwrap();
        lock.sync_all().unwrap();
    });
    let error = files::json_write(&journal, &json!({"state":"complete"})).unwrap_err();
    change.join().unwrap();
    assert!(error.contains("changed outside Weave"));
    assert_eq!(fs::read(journal).unwrap(), b"external change");
}
#[test]
fn rename_folder_rewrites_only_destinations_and_retains_recovery() {
    let mut f = Fixture::new();
    fs::create_dir(f.root().join("Folder")).unwrap();
    fs::write(
        f.root().join("Folder/Child.md"),
        "# Child\r\n😀 [warehouse](../Store.md \"reads-from\")\r\n",
    )
    .unwrap();
    let start = "# Start\n[child](./Folder/Child.md \"depends-on\")\n`[skip](./Folder/Child.md)`\n";
    fs::write(f.root().join("Start.md"), start).unwrap();
    f.backend.reconcile(true).unwrap();
    let p = f
        .call("renamePreview", json!({"from":"Folder","to":"New folder"}))
        .unwrap();
    assert_eq!(p["links"], 1);
    let r = f
        .call("rename", json!({"token":p["token"],"updateLinks":true}))
        .unwrap();
    assert!(std::path::Path::new(r["recovery"].as_str().unwrap())
        .join("journal.json")
        .exists());
    assert_eq!(
        fs::read_to_string(f.root().join("Start.md")).unwrap(),
        start.replacen("./Folder/Child.md", "<./New folder/Child.md>", 1)
    );
    assert!(fs::read_to_string(f.root().join("New folder/Child.md"))
        .unwrap()
        .contains("\r\n"));
    let graph = f.call("graph", json!({})).unwrap();
    assert_eq!(graph["relationships"].as_array().unwrap().len(), 2);
}
#[test]
fn stale_rename_and_destination_races_preserve_files() {
    let mut f = Fixture::new();
    let p = f
        .call("renamePreview", json!({"from":"Store.md","to":"New.md"}))
        .unwrap();
    fs::write(f.root().join("Start.md"), "# External edit").unwrap();
    assert!(f
        .call("rename", json!({"token":p["token"],"updateLinks":true}))
        .unwrap_err()
        .contains("workspace changed"));
    let p = f
        .call("renamePreview", json!({"from":"Store.md","to":"New.md"}))
        .unwrap();
    fs::write(f.root().join("New.md"), "# Do not overwrite").unwrap();
    assert!(f
        .call("rename", json!({"token":p["token"],"updateLinks":true}))
        .is_err());
    assert!(f.root().join("Store.md").exists());
    assert_eq!(
        fs::read_to_string(f.root().join("New.md")).unwrap(),
        "# Do not overwrite"
    );
}
#[test]
fn move_outgoing_rewrites_and_decline_preserves_source() {
    let mut f = Fixture::new();
    fs::create_dir(f.root().join("Folder")).unwrap();
    let p = f
        .call(
            "renamePreview",
            json!({"from":"Start.md","to":"Folder/Start.md"}),
        )
        .unwrap();
    assert_eq!(p["links"], 1);
    f.call("rename", json!({"token":p["token"],"updateLinks":true}))
        .unwrap();
    assert!(fs::read_to_string(f.root().join("Folder/Start.md"))
        .unwrap()
        .contains("../Store.md"));
    let p = f
        .call("renamePreview", json!({"from":"Store.md","to":"Other.md"}))
        .unwrap();
    f.call("rename", json!({"token":p["token"],"updateLinks":false}))
        .unwrap();
    assert!(fs::read_to_string(f.root().join("Folder/Start.md"))
        .unwrap()
        .contains("../Store.md"));
}
#[test]
fn delete_confirmation_and_copy() {
    let mut f = Fixture::new();
    assert!(f.call("delete", json!({"path":"Start.md"})).is_err());
    // Deleting is permanent unless backups are switched on.
    let panel = f.call("controlPanel", json!({})).unwrap();
    assert_eq!(panel["deleteBackups"], false);
    assert!(f
        .call("delete", json!({"path":"Store.md","confirmed":true}))
        .unwrap()["recovery"]
        .is_null());
    assert!(!f.root().join("Store.md").exists());
    assert!(
        !f.backend.runtime.join("trash").exists()
            || fs::read_dir(f.backend.runtime.join("trash"))
                .unwrap()
                .next()
                .is_none()
    );
    assert_eq!(
        f.call("configureDeletion", json!({"backups":true}))
            .unwrap()["deleteBackups"],
        true
    );
    let before = fs::read(f.root().join("Start.md")).unwrap();
    let r = f
        .call("delete", json!({"path":"Start.md","confirmed":true}))
        .unwrap();
    assert_eq!(
        fs::read(std::path::Path::new(r["recovery"].as_str().unwrap()).join("Start.md")).unwrap(),
        before
    );
    assert!(!f.root().join("Start.md").exists());
}
#[test]
fn session_and_data_relocation_survive_restart() {
    let mut f = Fixture::new();
    let session = json!({"tabs":["Start.md"],"active":"Start.md","source":true,"tabState":[{"id":"tab-1","path":null,"history":[],"at":-1}],"activeTab":"tab-1"});
    f.call("workspaceSession", session.clone()).unwrap();
    let dest = f.temp.path().join("Storage");
    fs::create_dir(&dest).unwrap();
    let result = f
        .call("configureStorage", json!({"dataDirectory":dest}))
        .unwrap();
    assert_eq!(result["restartRequired"], true);
    assert_eq!(
        result["pendingDataDirectory"],
        json!(crate::backend::display(
            &fs::canonicalize(&dest).unwrap().join(".weave")
        ))
    );
    assert!(!dest.join(".weave").exists());
    let default = f.backend.runtime.clone();
    fs::write(default.join("window-state.json"), b"window state").unwrap();
    drop(f.backend);
    let runtime = crate::storage_location::resolve(&default, None).unwrap();
    assert_eq!(runtime, fs::canonicalize(&dest).unwrap().join(".weave"));
    assert!(runtime.join("weave.sqlite").exists());
    assert_eq!(
        fs::read(runtime.join("window-state.json")).unwrap(),
        b"window state"
    );
    assert!(default.join("weave.sqlite").exists());
    let b = Backend::with_default(runtime, default, Arc::new(AtomicBool::new(false))).unwrap();
    let restored = b.request("restore", json!({})).unwrap();
    assert_eq!(restored["session"], session);
    b.reconcile(true).unwrap();
    assert_eq!(
        b.database
            .search(&b.current().unwrap().id, "ABC-901", 30)
            .unwrap()["results"][0]["path"],
        "Start.md"
    );
}
#[test]
fn runtime_lock_and_relocation_conflicts() {
    let mut f = Fixture::new();
    assert!(Backend::new(f.backend.runtime.clone(), Arc::new(AtomicBool::new(false))).is_err());
    let dest = f.temp.path().join("Taken");
    fs::create_dir(&dest).unwrap();
    fs::create_dir(dest.join(".weave")).unwrap();
    fs::write(dest.join(".weave/weave.sqlite"), b"do not overwrite").unwrap();
    assert!(f
        .call("configureStorage", json!({"dataDirectory":dest}))
        .is_err());
    assert_eq!(
        fs::read(dest.join(".weave/weave.sqlite")).unwrap(),
        b"do not overwrite"
    );
    assert!(f
        .call("configureStorage", json!({"dataDirectory":f.root()}))
        .is_err());
}
#[test]
fn watcher_reconciles_external_changes() {
    let f = Fixture::new();
    fs::write(f.root().join("New.md"), "# Watched\nexternalterm").unwrap();
    for _ in 0..30 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        f.backend.poll().unwrap();
        if f.backend
            .database
            .counts(&f.backend.current().unwrap().id)
            .unwrap()["documents"]
            == 3
        {
            break;
        }
    }
    assert_eq!(
        f.backend
            .database
            .search(&f.backend.current().unwrap().id, "externalterm", 30)
            .unwrap()["results"][0]["path"],
        "New.md"
    );
}
#[test]
fn parser_exclusions_unicode_metadata_and_resolution() {
    let legacy = "😀 [[Old]]\n[Old](./Old.md)@@reads-from\n`[[Code]]`\n```\n\n[[Fenced]]\n```\n<!-- [[Hidden]] -->";
    let diagnostics = markdown::diagnostics(legacy, "Start.md");
    assert_eq!(diagnostics.len(), 2);
    assert_eq!(diagnostics[0]["start"], 3);
    assert_eq!(diagnostics[1]["line"], 2);
    let text="---\ntype: System\ntitle: 'Preferred'\ntags: [SQL, ETL]\n---\n# Heading\n😀 [目标](<./A B.md> \"reads_from\")\n`[no](./n.md)`\n<!-- [no](./n.md) -->\n```\n[no](./n.md)\n```\n    [no](./n.md)\n![image](./n.md)\n[web](https://site/n.md)\n\\[escape](./n.md)\nTags: API, SQL.\n";
    let links = markdown::links(text);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].relationship, "reads-from");
    let v = markdown::link_json(&links[0], text, "Start.md");
    assert_eq!(
        v["start"].as_u64().unwrap() as usize,
        text[..links[0].start].encode_utf16().count()
    );
    let m = markdown::metadata(text, "Systems/Start.md", "Notes");
    assert_eq!(m["title"], "Preferred");
    assert_eq!(m["type"], "Systems");
    assert_eq!(m["tags"], json!(["SQL", "ETL", "API"]));
    let r = markdown::Resolver::new(
        ["A B.md".into(), "One/A.md".into(), "Two/A.md".into()].into_iter(),
        true,
    );
    assert_eq!(r.resolve("./A B.md", "Start.md")["resolvedPath"], "A B.md");
    assert_eq!(r.resolve("A.md", "Start.md")["reason"], "ambiguous");
    assert_eq!(
        r.resolve("../outside.md", "Start.md")["reason"],
        "invalid-path"
    );
}
#[test]
#[cfg(windows)]
fn failed_link_write_rolls_back_move_and_prior_writes() {
    let mut f = Fixture::new();
    let original = "# A\n[Store](./Store.md)\n";
    fs::write(f.root().join("A.md"), original).unwrap();
    let start = fs::read(f.root().join("Start.md")).unwrap();
    let plan = f
        .call("renamePreview", json!({"from":"Store.md","to":"Moved.md"}))
        .unwrap();
    let file = f.root().join("Start.md");
    let old = fs::metadata(&file).unwrap().permissions();
    let mut readonly = old.clone();
    readonly.set_readonly(true);
    fs::set_permissions(&file, readonly).unwrap();
    let result = f.call("rename", json!({"token":plan["token"],"updateLinks":true}));
    fs::set_permissions(&file, old).unwrap();
    assert!(result.unwrap_err().contains("Changes rolled back"));
    assert_eq!(fs::read_to_string(f.root().join("A.md")).unwrap(), original);
    assert_eq!(fs::read(&file).unwrap(), start);
    assert!(f.root().join("Store.md").exists());
    assert!(!f.root().join("Moved.md").exists());
    let operations = f.temp.path().join(".weave/operations");
    let journal = fs::read_dir(operations)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path()
        .join("journal.json");
    let journal: Value = serde_json::from_slice(&fs::read(journal).unwrap()).unwrap();
    assert_eq!(journal["state"], "rolled-back");
}
#[test]
fn git_init_stage_commit_private_filter_diff_history() {
    let mut f = Fixture::new();
    let status = f.call("gitStatus", json!({})).unwrap();
    if status["available"] != true {
        panic!("Git required for native acceptance: {status}");
    }
    f.call("gitAction", json!({"action":"init"})).unwrap();
    let git = if cfg!(windows) {
        "C:/Program Files/Git/cmd/git.exe"
    } else {
        "git"
    };
    for (key, value) in [
        ("user.name", "Weave Test"),
        ("user.email", "weave-test@example.invalid"),
    ] {
        assert!(std::process::Command::new(git)
            .args(["config", key, value])
            .current_dir(f.root())
            .status()
            .unwrap()
            .success());
    }
    fs::create_dir(f.root().join(".weave")).unwrap();
    fs::write(f.root().join(".weave/secret"), "private").unwrap();
    let status = f.call("gitStatus", json!({})).unwrap();
    assert_eq!(status["files"].as_array().unwrap().len(), 2);
    f.call("gitAction", json!({"action":"stageAll"})).unwrap();
    f.call("gitAction", json!({"action":"commit","message":"Initial"}))
        .unwrap();
    assert_eq!(
        f.call("gitHistory", json!({})).unwrap()[0]["subject"],
        "Initial"
    );
    fs::write(f.root().join("Start.md"), "# Changed").unwrap();
    assert!(
        f.call("gitDiff", json!({"path":"Start.md"})).unwrap()["text"]
            .as_str()
            .unwrap()
            .contains("+# Changed")
    );
    assert!(f
        .call("gitAction", json!({"action":"discard","path":"Start.md"}))
        .is_err());
    f.call(
        "gitAction",
        json!({"action":"discard","path":"Start.md","confirmed":true}),
    )
    .unwrap();
    assert!(fs::read_to_string(f.root().join("Start.md"))
        .unwrap()
        .contains("ABC-901"));
}
#[test]
fn portable_export_keeps_the_mermaid_runtime_only_for_wanted_diagrams() {
    let mut f = Fixture::new();
    f.backend.reconcile(true).unwrap();
    let template = "<html><head><title>Weave</title></head><body><script id=\"weave-mermaid-runtime\" type=\"text/plain\">MERMAID</script><script type=\"application/json\">\"__WEAVE_EXPORT_DATA__\"</script><script>app()</script></body></html>";
    let target = f.temp.path().join("Diagrams.html");
    let export = |f: &mut Fixture, diagrams: bool| {
        let result = f
            .call(
                "exportWorkspace",
                json!({"path":target,"template":template,"diagrams":diagrams}),
            )
            .unwrap();
        (
            result["diagrams"].clone(),
            fs::read_to_string(&target).unwrap(),
        )
    };
    let (flag, html) = export(&mut f, true);
    assert_eq!(flag, false);
    assert!(
        !html.contains("MERMAID") && !html.contains("weave-mermaid-runtime"),
        "a workspace without diagrams gets no Mermaid runtime"
    );
    assert!(html.contains("<script>app()</script>") && html.contains("\"diagrams\":false"));
    fs::write(
        f.root().join("Flow.md"),
        "# Flow\n\n- Steps:\n\n    ~~~ Mermaid\n    flowchart LR\n      A --> B\n    ~~~\n",
    )
    .unwrap();
    f.backend.reconcile(true).unwrap();
    let (flag, html) = export(&mut f, true);
    assert_eq!(flag, true);
    assert!(
        html.contains("type=\"text/plain\">MERMAID</script>") && html.contains("\"diagrams\":true")
    );
    let (flag, html) = export(&mut f, false);
    assert_eq!(flag, false, "diagrams can be left out of an export");
    assert!(!html.contains("MERMAID") && html.contains("<script>app()</script>"));
}
#[test]
fn mermaid_fences_are_recognised() {
    use crate::markdown::has_mermaid_fence;
    for text in [
        "```mermaid\nA\n```",
        "  ~~~Mermaid title\n",
        "> ```` mermaid\n",
        "\t```mermaid",
    ] {
        assert!(has_mermaid_fence(text), "{text}");
    }
    for text in [
        "```js\nmermaid\n```",
        "mermaid",
        "``` mermaidjs\n",
        "Use ```mermaid``` inline",
    ] {
        assert!(!has_mermaid_fence(text), "{text}");
    }
}
#[test]
fn portable_export_embeds_articles_graph_and_escapes_markup() {
    let mut f = Fixture::new();
    fs::write(
        f.root().join("Script.md"),
        "# Tricky\n\n</script><script>alert(1)</script> & more\n",
    )
    .unwrap();
    f.backend.reconcile(true).unwrap();
    let template = "<html><head><title>Weave</title></head><body><script type=\"application/json\">\"__WEAVE_EXPORT_DATA__\"</script></body></html>";
    let target = f.temp.path().join("Notes export.html");
    let result = f
        .call(
            "exportWorkspace",
            json!({"path":target,"template":template}),
        )
        .unwrap();
    assert_eq!(result["documents"], 3);
    assert_eq!(result["relationships"], 1);
    let html = fs::read_to_string(&target).unwrap();
    assert!(html.contains("<title>Notes · Weave</title>"));
    assert!(
        !html.contains("</script><script>alert"),
        "article text cannot close the data element"
    );
    let json = html
        .split("application/json\">")
        .nth(1)
        .unwrap()
        .split("</script>")
        .next()
        .unwrap();
    let data: Value = serde_json::from_str(json).unwrap();
    assert_eq!(data["portable"], true);
    assert_eq!(data["root"], "Notes");
    assert!(data["documents"]
        .as_array()
        .unwrap()
        .iter()
        .any(|d| d["title"] == "Tricky" && d["text"].as_str().unwrap().contains("</script>")));
    assert_eq!(data["graph"]["relationships"][0]["from"], "Start.md");
    fs::create_dir(f.root().join("Team")).unwrap();
    fs::write(
        f.root().join("Team/Member.md"),
        "# Member\n\n[Start](../Start.md \"reports-to\")\n",
    )
    .unwrap();
    f.backend.reconcile(true).unwrap();
    let folder = f
        .call(
            "exportWorkspace",
            json!({"path":target,"template":template,"folder":"Team"}),
        )
        .unwrap();
    assert_eq!(
        folder["documents"], 1,
        "a folder export contains only that folder"
    );
    assert_eq!(folder["name"], "Team");
    let html = fs::read_to_string(&target).unwrap();
    let data: Value = serde_json::from_str(
        html.split("application/json\">")
            .nth(1)
            .unwrap()
            .split("</script>")
            .next()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        data["graph"]["relationships"][0]["resolved"], 0,
        "links leaving the folder become unavailable"
    );
    assert!(f
        .call(
            "exportWorkspace",
            json!({"path":target,"template":template,"folder":"Missing"})
        )
        .is_err());
    let bare = f
        .call(
            "exportWorkspace",
            json!({"path":target,"template":template,"graph":false,"otherFiles":false}),
        )
        .unwrap();
    assert_eq!(bare["relationships"], 0);
    assert!(f
        .call(
            "exportWorkspace",
            json!({"path":f.temp.path().join("export.txt"),"template":template})
        )
        .is_err());
    assert!(
        f.call(
            "exportWorkspace",
            json!({"path":target,"template":"<html></html>"})
        )
        .is_err(),
        "a build without the template explains how to fix it"
    );
}
#[test]
fn multiple_workspaces_stay_open_with_labels_order_and_restore() {
    let mut f = Fixture::new();
    let first = f.backend.scope();
    let other = f.temp.path().join("Other");
    fs::create_dir(&other).unwrap();
    fs::write(other.join("Private.md"), "# Hidden\nothersecret").unwrap();
    let opened = f.backend.request("open", json!({"root":other})).unwrap();
    let second = opened["scope"].as_u64().unwrap();
    assert_ne!(first, second);
    assert_eq!(opened["workspace"]["label"], "Other");
    let first_colour = f
        .backend
        .request("catalog", json!({"scope":first}))
        .unwrap()["workspace"]["color"]
        .clone();
    assert!(first_colour.as_str().unwrap().starts_with('#'));
    assert_ne!(
        first_colour, opened["workspace"]["color"],
        "new workspaces take an unused colour"
    );
    // Both workspaces answer requests addressed to their own scope only.
    f.backend
        .request("refresh", json!({"scope":second}))
        .unwrap();
    let search = |b: &mut Backend, scope: u64, q: &str| {
        b.request("searchKnowledge", json!({"scope":scope,"query":q}))
            .unwrap()["results"]
            .as_array()
            .unwrap()
            .len()
    };
    assert_eq!(search(&mut f.backend, first, "ABC-901"), 1);
    assert_eq!(search(&mut f.backend, first, "othersecret"), 0);
    assert_eq!(search(&mut f.backend, second, "othersecret"), 1);
    // Reopening an open folder returns it unchanged.
    assert_eq!(
        f.backend.request("open", json!({"root":other})).unwrap()["scope"],
        second
    );
    let id = opened["workspace"]["id"].as_str().unwrap().to_string();
    let label = f
        .backend
        .request(
            "configureWorkspace",
            json!({"id":id,"name":"Team notes","color":"#123ABC"}),
        )
        .unwrap();
    assert_eq!(label["name"], "Team notes");
    assert!(f
        .backend
        .request("configureWorkspace", json!({"id":id,"color":"blue"}))
        .is_err());
    let first_id = f
        .backend
        .current()
        .map(|_| f.backend.workspaces()[0].id.clone())
        .unwrap();
    f.backend.request("workspaceLayout", json!({"order":[id,first_id],"tabOrder":["tab-b","tab-a"],"activeTab":"tab-a","rightActiveTab":"tab-b","focus":"right","tabs":[{"id":"tab-a","at":1,"history":[{"workspace":first_id,"path":"Start.md"},{"workspace":id,"path":"Private.md"}]},{"id":"tab-b","side":"right","history":[{"workspace":first_id,"path":"Start.md"}]}]})).unwrap();
    assert!(f
        .backend
        .request(
            "workspaceLayout",
            json!({"tabs":[{"id":"tab-x","history":[{"workspace":id,"path":"../escape.md"}]}]})
        )
        .is_err());
    assert_eq!(f.backend.workspaces()[0].scope, second);
    let panel = f.backend.request("controlPanel", json!({})).unwrap();
    assert_eq!(panel["open"].as_array().unwrap().len(), 2);
    let runtime = f.backend.runtime.clone();
    drop(f.backend);
    let b = Backend::new(runtime.clone(), Arc::new(AtomicBool::new(false))).unwrap();
    let restored = b.request("restore", json!({})).unwrap();
    let workspaces = restored["workspaces"].as_array().unwrap();
    assert_eq!(workspaces.len(), 2);
    assert_eq!(workspaces[0]["workspace"]["label"], "Team notes");
    assert_eq!(workspaces[0]["workspace"]["color"], "#123abc");
    assert_eq!(restored["layout"]["activeTab"], "tab-a");
    assert_eq!(
        restored["layout"]["tabs"][0]["history"][1]["path"], "Private.md",
        "a tab's history spans workspaces"
    );
    // Split view: the right side keeps its tabs, active tab and focus.
    assert_eq!(restored["layout"]["tabs"][1]["side"], "right");
    assert!(restored["layout"]["tabs"][0]["side"].is_null());
    assert_eq!(restored["layout"]["rightActiveTab"], "tab-b");
    assert_eq!(restored["layout"]["focus"], "right");
    let scope = workspaces[0]["scope"].as_u64().unwrap();
    b.request("close", json!({"scope":scope})).unwrap();
    assert!(b.request("status", json!({"scope":scope})).is_err());
    let reopened = b.request("reopen", json!({"id":id})).unwrap();
    assert_eq!(reopened["workspace"]["label"], "Team notes");
    assert!(b.request("reopen", json!({"id":"kb-unknown"})).is_err());
    b.request("close", json!({"scope":reopened["scope"]}))
        .unwrap();
    drop(b);
    let b = Backend::new(runtime, Arc::new(AtomicBool::new(false))).unwrap();
    assert_eq!(
        b.request("restore", json!({})).unwrap()["workspaces"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn link_rewrites_touch_updated_at_and_documents_report_creation_time() {
    assert_eq!(
        markdown::touch_updated(
            "---\r\ntype: Note\r\nupdated_at: old\r\n---\r\n# A\r\n",
            "NOW"
        ),
        "---\r\ntype: Note\r\nupdated_at: NOW\r\n---\r\n# A\r\n"
    );
    assert_eq!(
        markdown::touch_updated(
            "---\ntype: Note\nnested:\n  updated_at: keep\n---\nBody",
            "NOW"
        ),
        "---\ntype: Note\nnested:\n  updated_at: keep\nupdated_at: NOW\n---\nBody"
    );
    for text in ["# No frontmatter\n", "---\ntype: Unclosed\n", ""] {
        assert_eq!(markdown::touch_updated(text, "NOW"), text);
    }
    let mut f = Fixture::new();
    let start = "---\ntype: Note\ncreated_at: 2020-01-01T00:00:00+00:00\nupdated_at: 2020-01-01T00:00:00+00:00\n---\n# Start\n[Store](./Store.md)\n";
    fs::write(f.root().join("Start.md"), start).unwrap();
    f.backend.reconcile(true).unwrap();
    let doc = f.call("getDocument", json!({"path":"Start.md"})).unwrap();
    assert!(doc["created"].as_f64().unwrap() > 0.0);
    let p = f
        .call(
            "renamePreview",
            json!({"from":"Store.md","to":"Archive.md"}),
        )
        .unwrap();
    f.call("rename", json!({"token":p["token"],"updateLinks":true}))
        .unwrap();
    let text = fs::read_to_string(f.root().join("Start.md")).unwrap();
    assert!(text.contains("[Store](./Archive.md)"));
    assert!(text.contains("created_at: 2020-01-01T00:00:00+00:00"));
    assert!(!text.contains("updated_at: 2020"));
    assert!(fs::read_to_string(f.root().join("Archive.md"))
        .unwrap()
        .starts_with("# Warehouse"));
}
#[test]
fn kanban_rows_follow_markdown_and_rebuild_from_it() {
    let mut f = Fixture::new();
    let root = f.root();
    fs::create_dir(root.join("Boards")).unwrap();
    fs::create_dir(root.join("Work")).unwrap();
    let board = |columns: &str| {
        format!("---\ntype: Kanban Board\ntitle: Development\nweave:\n  kanban:\n    columns:\n{columns}---\n# Development\n")
    };
    fs::write(
        root.join("Boards/Dev.md"),
        board("      - id: todo\n        title: Todo\n      - id: doing\n        title: Doing\n"),
    )
    .unwrap();
    let card = |column: &str, rank: &str| {
        format!("---\ntype: Note\nweave:\n  kanban:\n    board: Dev.md # the team board\n    column: {column}\n    rank: {rank}\n---\n# Card\n")
    };
    fs::write(root.join("Work/A.md"), card("todo", "2000")).unwrap();
    fs::write(root.join("Work/B.md"), card("in-progres", "1000")).unwrap();
    fs::write(
        root.join("Work/C.md"),
        "---\nweave:\n  kanban:\n    board: Missing.md\n---\n",
    )
    .unwrap();
    f.call("refresh", json!({})).unwrap();
    let status = |v: &Value, p: &str| {
        v["cards"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["path"] == p)
            .map(|c| c["status"].as_str().unwrap().to_string())
    };
    let shown = f
        .call("kanbanBoard", json!({"path":"Boards/Dev.md"}))
        .unwrap();
    assert_eq!(
        shown["board"]["columns"],
        json!([{"id":"todo","title":"Todo"},{"id":"doing","title":"Doing"}])
    );
    assert_eq!(shown["cards"].as_array().unwrap().len(), 2);
    assert_eq!(status(&shown, "Work/A.md").as_deref(), Some("ok"));
    assert_eq!(
        status(&shown, "Work/B.md").as_deref(),
        Some("unknown-column"),
        "an unknown column is kept and reported"
    );
    let summary = f.call("kanban", json!({})).unwrap();
    assert_eq!(summary["boards"][0]["cards"], 2);
    assert_eq!(summary["boards"][0]["attention"], 1);
    assert_eq!(
        status(&summary, "Work/C.md").as_deref(),
        Some("missing-board")
    );
    assert!(
        fs::read_to_string(root.join("Boards/Dev.md"))
            .unwrap()
            .contains("doing"),
        "boards are never changed by card data"
    );
    // Changes outside Weave: a new column places the card; ranks and columns follow the files.
    fs::write(root.join("Boards/Dev.md"), board("      - id: in-progres\n        title: In progress\n      - id: todo\n        title: Todo\n")).unwrap();
    fs::write(root.join("Work/A.md"), card("todo", "500")).unwrap();
    f.call("refresh", json!({})).unwrap();
    let shown = f
        .call("kanbanBoard", json!({"path":"Boards/Dev.md"}))
        .unwrap();
    assert_eq!(shown["board"]["columns"][0]["id"], "in-progres");
    assert_eq!(status(&shown, "Work/B.md").as_deref(), Some("ok"));
    assert_eq!(
        shown["cards"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["path"] == "Work/A.md")
            .unwrap()["rank"],
        500.0
    );
    // A second board with the same filename makes filename references ambiguous.
    fs::write(root.join("Work/Dev.md"), "---\ntype: kanban board\n---\n").unwrap();
    f.call("refresh", json!({})).unwrap();
    let summary = f.call("kanban", json!({})).unwrap();
    assert_eq!(summary["boards"][0]["duplicates"], json!(["Work/Dev.md"]));
    assert_eq!(
        status(&summary, "Work/A.md").as_deref(),
        Some("ambiguous-board")
    );
    fs::remove_file(root.join("Work/Dev.md")).unwrap();
    f.call("refresh", json!({})).unwrap();
    // An ordinary article may share a board's filename: only boards are matched.
    fs::write(
        root.join("Work/Dev.md"),
        "---\ntype: Note\n---\n# Notes about the board\n",
    )
    .unwrap();
    f.call("refresh", json!({})).unwrap();
    let summary = f.call("kanban", json!({})).unwrap();
    assert_eq!(summary["boards"].as_array().unwrap().len(), 1);
    assert_eq!(summary["boards"][0]["duplicates"], json!([]));
    assert_eq!(
        status(&summary, "Work/A.md").as_deref(),
        Some("ok"),
        "a non-board with a board's filename is not a board"
    );
    fs::remove_file(root.join("Work/Dev.md")).unwrap();
    f.call("refresh", json!({})).unwrap();
    // Copying pastes files and folders at new paths and indexes only the copies.
    f.call("copy", json!({"from":"Work/A.md","to":"Work/A copy.md"}))
        .unwrap();
    assert_eq!(
        fs::read(root.join("Work/A copy.md")).unwrap(),
        fs::read(root.join("Work/A.md")).unwrap()
    );
    assert!(
        f.call("copy", json!({"from":"Work/A.md","to":"Work/B.md"}))
            .is_err(),
        "a copy never replaces a file"
    );
    assert!(
        f.call("copy", json!({"from":"Work","to":"Work/Inner"}))
            .is_err(),
        "a folder is not copied into itself"
    );
    assert!(
        f.call("copy", json!({"from":"Work/A.md","to":"Work/A.txt"}))
            .is_err(),
        "a copy keeps its file type"
    );
    f.call("copy", json!({"from":"Work","to":"Copied/Work"}))
        .unwrap_err();
    fs::create_dir(root.join("Copied")).unwrap();
    f.call("refresh", json!({})).unwrap();
    f.call("copy", json!({"from":"Work","to":"Copied/Work"}))
        .unwrap();
    let catalog = f.call("catalog", json!({})).unwrap();
    let listed = |p: &str| {
        catalog["tree"]["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["path"] == p)
    };
    assert!(
        listed("Copied/Work/A.md") && listed("Work/A copy.md"),
        "copies are indexed at once"
    );
    let shown = f
        .call("kanbanBoard", json!({"path":"Boards/Dev.md"}))
        .unwrap();
    assert_eq!(
        status(&shown, "Copied/Work/A.md").as_deref(),
        Some("ok"),
        "copied cards keep their board"
    );
    for p in ["Work/A copy.md"] {
        fs::remove_file(root.join(p)).unwrap();
    }
    fs::remove_dir_all(root.join("Copied")).unwrap();
    f.call("refresh", json!({})).unwrap();
    // Renaming a board rewrites the cards' references, keeping comments.
    let plan = f
        .call(
            "renamePreview",
            json!({"from":"Boards/Dev.md","to":"Boards/Team.md"}),
        )
        .unwrap();
    assert_eq!(plan["cards"], 2);
    f.call("rename", json!({"token":plan["token"],"updateLinks":true}))
        .unwrap();
    let a = fs::read_to_string(root.join("Work/A.md")).unwrap();
    assert!(
        a.contains("    board: Team.md # the team board\n") && a.contains("updated_at:"),
        "{a}"
    );
    let shown = f
        .call("kanbanBoard", json!({"path":"Boards/Team.md"}))
        .unwrap();
    assert_eq!(status(&shown, "Work/A.md").as_deref(), Some("ok"));
    // Moving a board within the workspace keeps filename references as they are.
    let plan = f
        .call(
            "renamePreview",
            json!({"from":"Boards/Team.md","to":"Team.md"}),
        )
        .unwrap();
    assert_eq!(plan["cards"], 0);
    f.call("rename", json!({"token":plan["token"],"updateLinks":true}))
        .unwrap();
    // Kanban saves check every hash before writing, then reindex.
    let doc = f.call("getDocument", json!({"path":"Work/A.md"})).unwrap();
    let text = s_text(&doc).replace("column: todo", "column: in-progres");
    assert!(f
        .call(
            "kanbanSave",
            json!({"writes":[{"path":"Work/A.md","text":text,"hash":"stale"}]})
        )
        .is_err());
    assert!(f
        .call(
            "kanbanSave",
            json!({"writes":[{"path":"../A.md","text":text,"hash":doc["hash"]}]})
        )
        .is_err());
    f.call(
        "kanbanSave",
        json!({"writes":[{"path":"Work/A.md","text":text,"hash":doc["hash"]}]}),
    )
    .unwrap();
    let shown = f.call("kanbanBoard", json!({"path":"Team.md"})).unwrap();
    assert_eq!(
        shown["cards"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["path"] == "Work/A.md")
            .unwrap()["column"],
        "in-progres"
    );
    // Deleting the database loses nothing: Kanban rows are rebuilt from Markdown.
    let before = f.call("kanban", json!({})).unwrap();
    let Fixture { temp, backend } = f;
    let runtime = backend.runtime.clone();
    drop(backend);
    for name in ["weave.sqlite", "weave.sqlite-wal", "weave.sqlite-shm"] {
        let _ = fs::remove_file(runtime.join(name));
    }
    let reopen = || {
        let b = Backend::new(runtime.clone(), Arc::new(AtomicBool::new(false))).unwrap();
        b.open(temp.path().join("Notes").to_str().unwrap()).unwrap();
        b.reconcile(false).unwrap();
        let summary = b.request("kanban", json!({"scope":b.scope()})).unwrap();
        (b, summary)
    };
    let (b, after) = reopen();
    assert_eq!(before, after);
    drop(b);
    // Version 1 databases have no Kanban rows; upgrading rebuilds them.
    let db = rusqlite::Connection::open(runtime.join("weave.sqlite")).unwrap();
    db.execute_batch("DELETE FROM kanban_cards; DELETE FROM kanban_columns; DELETE FROM kanban_boards; PRAGMA user_version=1;").unwrap();
    drop(db);
    let (_b, upgraded) = reopen();
    assert_eq!(before, upgraded);
}
fn s_text(v: &Value) -> String {
    v["text"].as_str().unwrap_or("").to_string()
}
/// Counts kept by each index transaction equal the rows they describe.
fn assert_counts(b: &Backend) {
    let id = b.current().unwrap().id.clone();
    let counts = b.database.counts(&id).unwrap();
    let db = rusqlite::Connection::open(&b.database_file).unwrap();
    let count = |sql: &str| db.query_row(sql, [&id], |r| r.get::<_, i64>(0)).unwrap();
    assert_eq!(
        counts["documents"],
        count("SELECT count(*) FROM documents WHERE workspace=?"),
        "documents"
    );
    assert_eq!(
        counts["relationships"],
        count("SELECT count(*) FROM relationships WHERE workspace=?"),
        "relationships"
    );
    assert_eq!(
        counts["unresolved"],
        count("SELECT count(*) FROM relationships WHERE workspace=? AND target IS NULL"),
        "unresolved"
    );
    assert_eq!(
        counts["chunks"],
        count("SELECT count(*) FROM chunks WHERE workspace=?"),
        "chunks"
    );
    assert_eq!(count("SELECT count(*) FROM documents d WHERE d.workspace=?1 AND NOT EXISTS(SELECT 1 FROM entries e WHERE e.workspace=?1 AND e.path=d.path)"), 0, "every document is in the tree");
}
fn edge_target(f: &mut Fixture, source: &str) -> Value {
    f.call("getOutgoingRelationships", json!({"path":source}))
        .unwrap()[0]["target_document_id"]
        .clone()
}
#[test]
fn links_follow_targets_that_appear_and_disappear_with_exact_counts() {
    let mut f = Fixture::new();
    f.call("create", json!({"path":"Links.md","text":"# Links\n[Later](./Later.md \"depends-on\")\n[Bare](Shared.md)\n"})).unwrap();
    assert_eq!(
        edge_target(&mut f, "Links.md"),
        Value::Null,
        "missing targets stay unresolved"
    );
    assert_counts(&f.backend);
    f.call("create", json!({"path":"Later.md","text":"# Later\n"}))
        .unwrap();
    assert_eq!(
        edge_target(&mut f, "Links.md"),
        "Later.md",
        "a new article resolves links that named it"
    );
    fs::create_dir(f.root().join("One")).unwrap();
    f.call(
        "create",
        json!({"path":"One/Shared.md","text":"# Shared one\n"}),
    )
    .unwrap();
    let bare = |f: &mut Fixture| {
        f.call("getOutgoingRelationships", json!({"path":"Links.md"}))
            .unwrap()[1]
            .clone()
    };
    assert_eq!(
        bare(&mut f)["target_document_id"],
        "One/Shared.md",
        "a unique filename resolves a bare link"
    );
    fs::create_dir(f.root().join("Two")).unwrap();
    f.call(
        "create",
        json!({"path":"Two/Shared.md","text":"# Shared two\n"}),
    )
    .unwrap();
    assert_eq!(
        bare(&mut f)["reason"],
        "ambiguous",
        "a second article with that filename makes it ambiguous"
    );
    assert_counts(&f.backend);
    f.call("delete", json!({"path":"Two","confirmed":true}))
        .unwrap();
    assert_eq!(bare(&mut f)["target_document_id"], "One/Shared.md");
    f.call("delete", json!({"path":"Later.md","confirmed":true}))
        .unwrap();
    assert_eq!(
        edge_target(&mut f, "Links.md"),
        Value::Null,
        "deleting a target unresolves its links"
    );
    assert_counts(&f.backend);
    let d = f.call("getDocument", json!({"path":"Links.md"})).unwrap();
    f.call(
        "save",
        json!({"path":"Links.md","text":"# Links\nNo links now.\n","hash":d["hash"]}),
    )
    .unwrap();
    let p = f
        .call("renamePreview", json!({"from":"One","to":"Moved"}))
        .unwrap();
    f.call("rename", json!({"token":p["token"],"updateLinks":true}))
        .unwrap();
    fs::write(
        f.root().join("External.md"),
        "# External\n[Start](./Start.md)\n",
    )
    .unwrap();
    f.backend.reconcile(false).unwrap();
    assert_counts(&f.backend);
    f.call("refresh", json!({})).unwrap();
    assert_counts(&f.backend);
    let catalog = f.call("catalog", json!({})).unwrap();
    let files: Vec<&str> = catalog["tree"]["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["path"].as_str().unwrap())
        .collect();
    assert_eq!(
        files,
        [
            "External.md",
            "Links.md",
            "Moved/Shared.md",
            "Start.md",
            "Store.md"
        ]
    );
    assert_eq!(catalog["tree"]["folders"], json!(["Moved"]));
}
#[test]
fn catalog_changes_list_only_what_changed_since_a_revision() {
    let mut f = Fixture::new();
    let catalog = f.call("catalog", json!({})).unwrap();
    let since = catalog["revision"].as_u64().unwrap();
    assert_eq!(
        catalog["tree"]["files"][1],
        json!({"path":"Store.md","title":"Warehouse"}),
        "titles differing from the filename are listed"
    );
    assert_eq!(
        catalog["tree"]["files"][0],
        json!({"path":"Start.md"}),
        "a title equal to the filename is implied"
    );
    f.call(
        "create",
        json!({"path":"Added.md","text":"# Added title\n"}),
    )
    .unwrap();
    f.call("delete", json!({"path":"Store.md","confirmed":true}))
        .unwrap();
    let changes = f.call("catalogChanges", json!({"since":since})).unwrap();
    assert_eq!(changes["reset"], false);
    assert_eq!(
        changes["files"],
        json!([{"path":"Added.md","title":"Added title"}])
    );
    assert_eq!(changes["removed"], json!(["Store.md"]));
    assert!(changes["revision"].as_u64().unwrap() > since);
    let none = f
        .call("catalogChanges", json!({"since":changes["revision"]}))
        .unwrap();
    assert_eq!(none["files"], json!([]));
    assert_eq!(
        f.call(
            "catalogChanges",
            json!({"since":changes["revision"].as_u64().unwrap() + 5})
        )
        .unwrap()["reset"],
        true,
        "an unknown revision reloads"
    );
}
#[test]
fn external_folder_moves_are_reconciled_from_watched_paths() {
    let mut f = Fixture::new();
    fs::create_dir(f.root().join("Team")).unwrap();
    fs::write(
        f.root().join("Team/Member.md"),
        "# Member\nmemberterm [Start](../Start.md)\n",
    )
    .unwrap();
    f.backend.reconcile(false).unwrap();
    fs::rename(f.root().join("Team"), f.root().join("Crew")).unwrap();
    let id = f.backend.current().unwrap().id.clone();
    let mut moved = false;
    for _ in 0..50 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        f.backend.poll().unwrap();
        let found = f.backend.database.search(&id, "memberterm", 30).unwrap();
        if found["results"][0]["path"] == "Crew/Member.md" {
            moved = true;
            break;
        }
    }
    assert!(
        moved,
        "the moved folder's articles are found at their new paths"
    );
    let catalog = f.call("catalog", json!({})).unwrap();
    assert_eq!(catalog["tree"]["folders"], json!(["Crew"]));
    assert_eq!(
        f.call("getIncomingRelationships", json!({"path":"Start.md"}))
            .unwrap()[0]["source_document_id"],
        "Crew/Member.md"
    );
    assert_counts(&f.backend);
}
#[test]
fn indexed_graph_neighbourhoods_match_the_snapshot_traversal() {
    let mut f = Fixture::new();
    for (path, text) in [
        (
            "A.md",
            "# A\n[B](./B.md \"depends-on\") [Missing](./Missing.md) [Self](./A.md)\n",
        ),
        ("B.md", "# B\n[C](./C.md) [A](./A.md \"reads-from\")\n"),
        ("C.md", "# C\n[Missing](./Missing.md) [Start](./Start.md)\n"),
    ] {
        fs::write(f.root().join(path), text).unwrap();
    }
    f.backend.reconcile(false).unwrap();
    let scope = f.backend.scope();
    let snapshot = f.call("graph", json!({})).unwrap();
    for (start, direction, depth) in [
        ("A.md", "both", 3),
        ("B.md", "downstream", 2),
        ("Start.md", "upstream", 3),
        ("C.md", "both", 1),
    ] {
        let args =
            json!({"scope":scope,"path":start,"depth":depth,"direction":direction,"requestId":"r"});
        let (mut indexed, mut memory) = (vec![], vec![]);
        let a = f
            .backend
            .graph_stream(&args, |chunk| {
                indexed.push(chunk);
                Ok(())
            })
            .unwrap();
        let b = crate::graph::stream(
            &mut crate::graph::Snapshot::new(&snapshot),
            scope,
            snapshot["revision"].as_u64().unwrap(),
            &args,
            |chunk| {
                memory.push(chunk);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(a, b, "{start} {direction}");
        assert_eq!(indexed.len(), memory.len());
        for (x, y) in indexed.iter().zip(&memory) {
            let ids = |v: &Value, key: &str| {
                v[key]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|n| n["id"].clone())
                    .collect::<Vec<_>>()
            };
            assert_eq!(ids(x, "nodes"), ids(y, "nodes"), "{start} nodes");
            assert_eq!(ids(x, "edges"), ids(y, "edges"), "{start} edges");
            assert_eq!(x["distances"], y["distances"]);
        }
    }
}
#[test]
fn searches_are_scoped_in_the_index_and_bounded() {
    let mut f = Fixture::new();
    for i in 0..60 {
        fs::write(
            f.root().join(format!("Many {i}.md")),
            format!(
                "# Many {i}\n{}\n",
                "common words repeated ".repeat(1 + i % 7)
            ),
        )
        .unwrap();
    }
    f.backend.reconcile(false).unwrap();
    let found = f
        .call("searchKnowledge", json!({"query":"common","limit":25}))
        .unwrap();
    assert_eq!(found["results"].as_array().unwrap().len(), 25);
    let scores: Vec<f64> = found["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["score"].as_f64().unwrap())
        .collect();
    assert!(scores.windows(2).all(|w| w[0] >= w[1]), "best first");
    // A query naming the workspace column cannot reach another workspace's rows.
    let id = f.backend.current().unwrap().id.clone();
    assert!(
        f.call("searchKnowledge", json!({"query":id})).unwrap()["results"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        f.call("searchKnowledge", json!({"query":"kb"})).unwrap()["results"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let channel = f
        .call(
            "searchKnowledge",
            json!({"query":"common","searchChannel":"live"}),
        )
        .unwrap();
    assert_eq!(channel["results"].as_array().unwrap().len(), 30);
}
#[test]
fn link_records_match_per_link_offsets() {
    let text = "---\ntitle: T\n---\n# 😀 Title\n[A](./A.md \"reads-from\") é [B](<./B c.md>)\n漢字 [C](C.md) [D](../D.md)\n";
    let links = markdown::links(text);
    assert_eq!(links.len(), 4);
    let all = markdown::links_json(&links, text, "X/S.md");
    for (l, v) in links.iter().zip(&all) {
        assert_eq!(*v, markdown::link_json(l, text, "X/S.md"));
    }
}
#[test]
fn catalog_pages_cover_the_tree_in_order() {
    let mut f = Fixture::new();
    fs::create_dir(f.root().join("Folder")).unwrap();
    for name in ["Folder/A.md", "Folder/B.md", "C.md", "Folder/image.png"] {
        fs::write(f.root().join(name), "# Page\n").unwrap();
    }
    f.backend.reconcile(false).unwrap();
    let full = f.call("catalog", json!({})).unwrap()["tree"].clone();
    let (mut files, mut other, mut folders, mut after) = (vec![], vec![], vec![], String::new());
    loop {
        let page = f
            .call("catalogPage", json!({"after":after,"limit":2}))
            .unwrap();
        files.extend(page["tree"]["files"].as_array().unwrap().clone());
        other.extend(page["tree"]["otherFiles"].as_array().unwrap().clone());
        folders.extend(page["tree"]["folders"].as_array().unwrap().clone());
        match page["next"].as_str() {
            Some(next) => after = next.to_string(),
            None => break,
        }
    }
    assert_eq!(json!(files), full["files"]);
    assert_eq!(json!(other), full["otherFiles"]);
    assert_eq!(json!(folders), full["folders"]);
}
