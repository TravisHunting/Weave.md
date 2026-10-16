# Weave performance architecture

The headless server preserves the same backend locks, pooled readers, catalog deltas and partial-tree loading. Registration uses `open_background` so even a first small workspace is indexed by the monitor. HTTP bodies/connections/work admission are bounded; core calls run on the blocking pool without a global request lock. Browser status polling uses catalog deltas, and graph responses contain only bounded neighbourhood chunks. Existing scale budgets remain unchanged; HTTP/browser correctness has a separate `npm run test:server` suite.

Desktop-hosting follow-up, 11 October 2026, Windows / 100,000-document tier: `bench:scale --check` **failed** two unchanged budgets. Cold indexing took 245,560 ms against 120,000 ms, and status latency during cold indexing was 118.7 ms p95 against 50 ms. This run overlapped Linux build/native validation. All other measured budgets passed: document reads during reindexing were 26.1 ms p95, saves 59.9 ms, search 88.7 ms, graph 55.7 ms and warm restore 53 ms; peak memory was 258 MB. Results: `test-results/scale-benchmark-100000-desktop-hosting.json` (also the current `scale-benchmark-100000.json`). No budgets were relaxed. The current cold-status failure is also a material limitation, not a full scale acceptance pass.

The desktop-hosting follow-up UI run passed all budgets: first article 889 ms, largest startup task 399 ms, typing 7.4 ms per key, broad search 854 ms, selective search 165 ms, folder expansion 116 ms, opening another article 112 ms and watched changes visible after 266 ms. Full results: `test-results/ui-benchmark-100000.json`.

Weave is a Rust knowledge engine with a light, reactive reader. Markdown files are authoritative. `weave.sqlite` is an incrementally maintained read model (tree, metadata, links, chunks, full-text indexes, Kanban rows and counts), plus durable sessions and preferences. The design goal is that responsiveness does not depend on workspace size: interactive work is proportional to what changed or what is shown, background work is bounded and interruptible, and nothing the user does waits for indexing, scanning or Git.

This document records the design, the budgets that enforce it and measured results. [WEAVE_ARCHITECTURE.md](WEAVE_ARCHITECTURE.md) is the reference for module boundaries and data formats.

## Design

### Concurrency: no global lock

Tauri runs each `weave_request` on its own blocking thread against one shared `Backend`. Each open workspace has four short locks:

- `write` serializes its file writes and index transactions. It is held for one write plus its index update, or for one index batch, never across a walk, parsing or a Git command.
- `scanning` serializes full scans.
- `git` serializes its Git commands. Fetch, pull and push hold only this lock.
- `plan` holds the pending rename preview.

Reads (documents, search, catalog, catalog changes, status, graph, Kanban, relationships) take none of these locks. They use a pool of WAL read connections and see the last committed index, so a save waits at most for one index batch, and nothing waits for a scan or Git. A per-workspace monitor thread performs background reconciliation; one large workspace never delays another.

### SQLite as an incremental read model

| Table | Role |
| --- | --- |
| `entries` | The tree: every folder and file with kind, modification time, size and lower-cased filename key |
| `documents` | Indexed articles: source hash, title and OKF metadata |
| `relationships` | Links with resolved target, `target_key` (target filename) and the authored record |
| `chunks`, `fts_<workspace>` | Passages and one contentless FTS5 index per workspace |
| `kanban_*` | Boards, columns and cards from frontmatter |
| `stats` | Counts kept by every index transaction, so status never counts rows |

One writer connection applies short transactions. Index transactions skip the per-commit fsync (`synchronous=NORMAL`: WAL cannot corrupt, and a power cut can lose only the newest derived rows, which the next scan restores). Durable settings and sessions keep `FULL`. Hot queries are checked with `EXPLAIN QUERY PLAN` and pinned with `INDEXED BY` where SQLite would otherwise prefer a primary key that scans the workspace.

### Reconciliation: only what changed

- **Watched changes.** The watcher records the paths notifications name. Reconciliation then reads changed files, removes deleted files and folders with everything under them, walks new folders and adds missing ancestors. Overflow (more than 10,000 queued paths) or lost events fall back to a full scan.
- **Full scans** (start-up, the periodic safety scan, Refresh). The scan walks the tree from directory listings, with no per-file system calls on Windows: 190 ms for 100,000 files. It merges the walk with `entries` in path order and reads only files whose size or modification time changed, or every file for a content Refresh.
- **Indexing.** Articles are indexed in batches of 384. A parser thread reads and prepares the next batch (decoding, OKF metadata, chunk hashes, links and their resolution) on one reader per core (four to eight), while the previous batch is written. A one-batch channel bounds memory. An article whose content still has its stored hash is not parsed, so a content Refresh is a read and a hash per article. Readers keep normal priority: on hybrid CPUs Windows runs lower-priority threads on efficiency cores, which made indexing four times slower, while the interface (a separate WebView process) stayed responsive either way. Each write checks that the stored hash is still the one planned, so an older read never overwrites a newer save. New tree rows are written before parsing, so the Files tree appears early. A changed article's tree row is written with its index rows, so an interrupted run never pairs a current row with stale text.
- **Link resolution by filename.** Every candidate target of a link shares the link's lower-cased filename. A resolver built from just the articles with those filenames (`Database::resolver`) therefore answers exactly as a whole-workspace resolver would. Weave uses one for every save, batch and document read. When articles appear or disappear, only links whose `target_key` matches their filenames are resolved again.
- **Weave's own operations.** Saves, creations, deletions, Kanban saves, renames and working-tree Git actions index exactly the paths they changed. A rename preview finds the articles to rewrite from the index (links into the moved paths, the moved articles and affected Kanban cards) and reads only those.

### Search and graph

Each workspace has its own contentless FTS5 table. A search reads only that workspace's postings and ranks chunks with a bounded top-k. It widens the bound only when too few distinct articles were found, so the best articles stay exact without sorting every match. The live search box passes a `searchChannel`: a newer query interrupts the older one on the same channel, so typing never queues stale searches.

Graph neighbourhoods run a bounded breadth-first traversal over the index inside one read transaction, streaming each depth over a Tauri Channel. Their cost follows the neighbourhood shown, never the workspace.

### Catalog, startup and the reader

- **Catalog deltas.** `catalog` lists the tree with titles only where they differ from the filename. Every commit records its paths in a bounded log, so `catalogChanges {since}` returns only what changed (or `reset`). Native `weave-changed` events trigger synchronization at once; status polling is a 5-second fallback, or 1.4 s without events.
- **Startup.** `open` returns the stored tree without scanning and reconciles in the background. Opening, restoring and refreshing leave out trees of workspaces with more than 20,000 articles (`tree.partial`). The reader shows the restored article first, resolving its links from the backend's resolved links. It then loads the tree with `catalogPage` in pages of 20,000 rows, yielding between pages, builds a new index and swaps it in. A large tree never arrives as one payload, which at 100,000 articles would be a single 815 ms main-thread task.
- **Catalog index.** Each workspace in the reader has one `CatalogIndex`: paths, titles, folders, sorted children per folder and the link-resolution maps. Deltas update it in place. Editors, previews, search passages and autocomplete share it, and resolvers of plain path lists are cached by list identity. Typing therefore never revisits every path. Open articles redraw their links when paths change.
- **Graph view.** It needs only the focused article's id; the backend streams its neighbours.
- **Git status.** Background refreshes are spaced by the duration of the previous one, so `git status` of a very large repository never runs back to back.

### Caching layers

| Layer | Contents | Bound and invalidation |
| --- | --- | --- |
| Reader | `CatalogIndex` per workspace; resolver and entity-alias caches keyed by path-list identity; sorted children per folder | Updated in place by deltas; children re-sorted only for the folders that changed |
| Rust memory | Change log (20,000 paths per workspace), queued watcher paths (10,000), prepared-statement caches, one parse batch in flight | Fixed bounds; overflow falls back to `reset` or a full scan |
| SQLite | Writer cache 32 MB, up to six readers with 8 MB each; titles, keys and counts precomputed in rows | Rows replaced per article by compare-and-swap transactions |

### Instrumentation

The `metrics` request returns request latencies (count, mean, max, total) per operation, together with background work:

- `scan.walk`, `scan.compare` and `scan.apply`
- `index.prepare`, `index.write` and `index.lockWait`
- `index.reresolve`
- `save.file`, `save.index` and `save.response`

The scale benchmark saves them with its results.

## Budgets and benchmarks

`scripts/performance-budgets.json` sets upper limits per vault size: 10,000, 100,000 and 500,000 articles.

- **Interactive budgets** must hold while a full reindex runs. They cover:
  - status, document reads, relationships and neighbours
  - selective, medium and broad searches
  - save, create, delete and rename
  - change propagation
  - warm restore
- **Background budgets** bound cold indexing time, the warm reconciliation and peak memory.
- **UI budgets** cover:
  - time to the restored article
  - per-keystroke time and the longest main-thread task while typing (including autosave and catalog synchronization)
  - search, Files expansion and opening an article
  - external changes reaching the tree

```powershell
npm run bench:scale -- --docs 100000 --check
npm run bench:scale -- --docs 500000 --check
npm run bench:ui -- --docs 100000 --check
```

`scripts/scale-vault.mjs` generates deterministic vaults: about 2.5 KB per article in three folder levels, 70% with OKF frontmatter, 2–8 links each (60% local, 33% across the workspace, the rest bare filenames or missing targets, 35% typed), Zipf-distributed vocabulary with fixed broad and rare search terms, one Kanban board per area and cards on 1% of articles. The scale benchmark drives the release Rust backend through the concurrent test host; the UI benchmark drives the desktop page in Edge against it.

## Results

The 2026-10-11 multi-workspace desktop hosting/default appearance run used 100,000 generated articles and unchanged budgets. All UI budgets passed: first article 728 ms, longest startup task 337 ms, typing 3.2 ms per key, broad/selective search 856/150 ms, folder expansion/article opening 79/73 ms, and external-change appearance 193 ms.

The backend run again missed the existing cold-index budgets: readiness 226,259 ms (120,000 ms budget) and status p95 during cold indexing 111.5 ms (50 ms budget). Other checks passed, including reindex-time document/status/search/save/graph p95 of 33.8/33/131.7/89.9/83.9 ms, warm restore 69 ms, and peak memory 259 MB. These cold-index limitations predate desktop workspace selection; the budgets have not been relaxed.

Raw results: `test-results/scale-benchmark-100000.json` and `test-results/ui-benchmark-100000.json`.

The 2026-10-11 authentication run kept the budgets unchanged. All 100,000-article UI checks passed: first article 699 ms, longest startup task 305 ms, typing 4.1 ms per key, broad/selective search 839/409 ms, folder expansion/article opening 127/109 ms, and external-change appearance 204 ms. The backend again missed the documented cold-index budgets: readiness 220,543 ms and indexing-time status p95 74.1 ms. Other backend checks passed, including warm restore 69 ms and reindex-time document/status/search/save/graph p95 of 25.5/16.2/131.7/121.5/75.6 ms. Peak memory was 263 MB. Authentication does not change workspace indexing; these cold-index limitations remain outside this implementation.
## Remaining limits

- The reader holds every path and title of an open workspace in memory, about 100–200 bytes per article. Resolving links in the editor needs them. A fully lazy path service would remove this.
- Broad single-term searches compute BM25 for every matching chunk before taking the top results, so their cost grows with the number of matches (the search is interruptible and never blocks other work).
- The database is roughly four times the size of the Markdown it indexes: passages are stored for snippets and future vector rows, and relationship records are stored as JSON.
- The Files tree renders every row of the folders that are expanded. Expanding a single folder with tens of thousands of entries renders them all; the tree is not virtualized.
- Link autocomplete filters all paths of the workspace for each query.
