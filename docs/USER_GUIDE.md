# Weave user guide

A tour of what Weave does and where to find it. For the Markdown format itself, see [AUTHORING.md](AUTHORING.md).

- [Workspaces](#workspaces)
- [Tabs and split view](#tabs-and-split-view)
- [The graph](#the-graph)
- [Search and Deep search](#search-and-deep-search)
- [Reading and editing](#reading-and-editing)
- [Files](#files)
- [Kanban boards](#kanban-boards)
- [Source control](#source-control)
- [Sharing and exporting](#sharing-and-exporting)
- [Appearance and settings](#appearance-and-settings)
- [Phones and narrow windows](#phones-and-narrow-windows)
- [Your data](#your-data)
- [Limits](#limits)

## Workspaces

Each folder you open is a workspace. An empty tab shows the start page, whose buttons are the quickest way in. It offers only what you can do now:

- **Create new workspace** asks for a name and makes an empty folder (on the desktop you then choose where; on Weave Server it is created in the server's workspace folder). The new workspace is a Git repository from the start, with [automatic snapshots](#automatic-snapshots) on. **W › Create workspace…** does the same.
- **Open existing workspace** opens a folder of Markdown files (**W › Open workspace folder…**). On Weave Server the start page instead lists **Workspaces on this server**, every folder you have not opened, each with an **Open** button. A new browser opens no workspace until you choose one.
- **Activate a deactivated workspace** lists workspaces you deactivated, when there are any.
- With a workspace open: **New article**; **Random article** once it has two or more articles; and **Set up Git** while it is not a Git repository, or **Connect to GitHub** while its repository has no remote.

Up to 12 workspaces can be active at once, each watched, searched and shown in its own Files and Source control section, with its own name and colour. Weave restores open workspaces, their tabs and the window position on the next launch.

**Control panel › Workspaces** renames, recolours, reorders and deactivates workspaces. A deactivated workspace keeps its tabs and cache and can be reactivated from the same list or the opening screen. The *workspace in use* is the active tab's: new articles, new tabs and Deep search use it.

## Tabs and split view

- **Ctrl+T** or **+** opens a tab; **Ctrl+W**, middle-click or × closes one. Drag tabs to reorder them.
- Each tab keeps its own Back/Forward history (**Alt+Left/Right**) and reading positions, and can move between active workspaces.
- Right-click a link or file for **Open in new tab** or **Open to the right**.
- **Split view** (**Ctrl+\\** or a tab's **Split right**) shows two editor groups side by side, each with its own tabs. An article open on both sides stays in sync as you type. Drag a tab across to move it.
- By default tabs sit in the title bar, like a browser; turn this off under Visual styling › Tabs.

## The graph

**Graph** in the title bar shows the current article's neighbourhood above it. Nodes are coloured by folder and labelled with titles and up to three tags; typed links appear as labelled arrows.

- Choose depth and direction, **Fit**, **Reset layout** or **Shuffle nodes** from the floating controls.
- Scroll or pinch to zoom; drag to pan. Drag the bar beneath the graph to resize it, or nearly shut to hide it.
- Turn off **Show article** in the W menu to give the graph the whole pane.
- **Connections** in the right sidebar lists incoming and outgoing relationships by type.

## Search and Deep search

Search ranks passages (not whole files) with SQLite FTS5 and BM25 and shows the best-matching passage for each article. By default it covers every active workspace, interleaved by relevance.

| Query | Meaning |
|---|---|
| `warehouse refresh` | both terms in the same passage |
| `"customer relationship management"` | an exact phrase |
| `warehouse*` | a prefix |
| `policy -draft` | exclude a term |

Press **Enter** for **Deep search**: it gathers the strongest passages in the workspace in use, optionally with the articles linked to them, into an evidence view with paths and line ranges. It returns evidence, not generated answers. Search options live in Control panel.

## Reading and editing

Read and Edit are one continuous document. **Edit** in the title bar turns editing on; formatting marks appear only where the caret is, so the article keeps its reading layout while you type. **Source** shows the raw Markdown.

- **Formatting:** Ctrl+B, Ctrl+I, Ctrl+K (link), `==highlight==`, and optional underline (Settings › Editing). Right-click for Format, Paragraph and Insert menus.
- **Links:** typing `[` opens an article picker that inserts a relative link with a relationship to fill in.
- **Tables** are edited cell by cell, with resizable columns, row and column menus, sorting and optional automatic source formatting.
- **Mermaid diagrams** in ```` ```mermaid ```` blocks are drawn in place, with a live preview while you edit them. Articles keep only the source.
- **Paste** converts formatted HTML into Markdown; **Ctrl+Shift+V** pastes plain text.
- **Find** (Ctrl+F) searches the whole article.
- **Spelling** is checked as you write prose, with suggestions and an ignore list (Control panel › Spellchecking).
- **Autosave** runs 650 ms after you stop typing; adjust or turn it off in Control panel › Editing. With it off, Ctrl+S saves and Ctrl+Shift+S saves everything.
- **Ctrl+O** opens any Markdown file on the computer; files outside a workspace open in a tab marked ↗ and aren't indexed.

## Files

The Files panel shows each workspace's tree. Right-click for **New article**, **New folder**, **Rename**, **Move**, **Retitle Article** (F2), **Copy**/**Paste**, **Hide folder**, **Show in explorer**, **Export** and **Delete**.

- With Edit on, drag files and folders to move them. Weave asks whether to update the links a move or rename affects (Enter means yes).
- **Retitle** changes an article's heading and frontmatter title while keeping its filename and incoming links stable.
- Deleting is permanent by default, on the assumption that you keep history in Git. Settings › Storage location can keep a backup copy of every deletion.
- Dot-folders are hidden by default; `.weave` and `.git` are never indexed.

## Kanban boards

Boards and cards are ordinary articles with a little frontmatter ([format](AUTHORING.md#kanban-boards)). Opening a board shows its columns; drag cards between them (or use Ctrl+arrow keys), and Weave writes only that card's column and rank.

- Right-click a column to add cards, rename, add, move or delete columns.
- Drag an article from Files onto a column to make it a card.
- Clicking a card previews it in the right sidebar; **Article** and **Source** show the board's own Markdown.
- The **Kanban** sidebar lists every board and any cards that need attention. Settings › Kanban holds the options.

## Source control

Source control has one section per workspace. It needs Git installed separately (Weave Server's Docker image includes it). On the desktop it uses your system credentials or a deploy key; Weave Server uses deploy keys.

**Set up Git** (start page, **W › Set up Git…**, or Source control) is a step-by-step guide. It creates the repository, sets the commit author, connects a GitHub repository by its address and creates a **deploy key**: Weave keeps the private key and you add the public key under the repository's **Settings › Deploy keys** on GitHub, with **Allow write access** ticked. It then tests the connection and uploads the workspace, or downloads an existing repository into it. [SERVER.md › Git and GitHub](SERVER.md#git-and-github) walks through each step. On the desktop, **Use my own Git credentials** skips the deploy key.

- Stage, unstage, discard and commit (Ctrl+Enter); side-by-side or unified diffs; history; branches; stash; fetch, pull and push.
- **Commit all & sync** commits, merges incoming changes and pushes to every checked remote.
- **Resolve** opens a visual conflict editor: choose current, incoming or both for each block, then **Save & stage**.
- **Recently pulled files** keeps the last five pulls with their diffs.
- **Edit .gitignore** opens the repository's ignore file.

### Incoming changes and automatic fetching

**Fetch automatically every … min** (below the branch's sync status; off by default, 10 minutes when turned on) downloads the sync remote's new commits in the background. Fetching never changes your files: nothing is merged until you pull or sync. The note below it says when the repository was last fetched, by any means, and shows a failed automatic fetch.

When fetched commits are waiting, Weave shows it in three places:

- Source control shows **↓ N incoming commits** with the number of files they change and a **Pull** button. When the workspace has its own uncommitted changes or unpushed commits, use **Commit all & sync** instead.
- The Source control icon in the rail and the workspace's section heading show **↓N**.
- An article changed by the incoming commits shows a banner with **Pull now** and **Source control**. Once you start editing it, the banner turns into a warning (and the status bar says so once) because the two versions may conflict. Commit and sync to combine them.

### Automatic snapshots

**Automatic snapshots** (in each workspace's Source control section) commit your changes for you, so earlier versions are always available without learning Git. They are off for existing repositories and on for workspaces created in Weave.

- **Snapshot after a quiet period of** (default 15 minutes without changes) or **at intervals of** a number of minutes. A snapshot is made only when something changed, and it includes every change Git would show, following `.gitignore` and never Weave's private data.
- Snapshots never get in the way of manual Git work: they wait while changes are staged for a commit, during a merge, rebase or cherry-pick, on a detached HEAD, and while another Git program is busy. They run no Git hooks and are not signed; without a commit author they are made as *Weave*.
- **Snapshot when Weave closes** (on by default) commits outstanding changes when the app or server exits; it does not push, so closing never waits for the network.
- **Push snapshots to the remote** (off by default) pushes after each snapshot to the remotes checked under Remote management.
- **Snapshot now** makes one immediately.
- When the same repository is open in several Weave apps or servers, only one of them takes its snapshots.

**Browse snapshots…** lists the history, snapshots marked with a dot (**Only versions of** narrows it to the open article). Choose an entry to see the files it changed, then **Changes** for a diff, **Restore this version** (or **Restore deleted file**) for one file, or **Restore entire snapshot** to return every tracked file to that point: changed files are replaced and files added since are removed, while files Git does not track stay. With snapshots on, your current changes are first kept in a snapshot and the restore is recorded as a new one, so a restore can itself be undone; with them off, uncommitted changes to the restored files are lost.

## Sharing and exporting

**Export workspace** (the upload icon in the left rail) saves a workspace, or a single folder, as one read-only `.html` file containing every article, the graph, search and the full reader. It works offline in any modern browser, makes no network requests and cannot be edited. Options can leave out the graph, non-Markdown files or the diagram renderer.

**Weave Lite** (`weave_lite.html`) is the same reader with no articles inside: open it in a browser, choose a Markdown folder and read it with no install.

**Web server.** Settings › Web server lets the desktop app serve your workspaces to browsers on this computer or your network, optionally in the background from the tray. `Weave.exe server` (Linux: `weave server`) runs without a window. See [SERVER.md](SERVER.md).

## Appearance and settings

**Visual styling** (the palette icon) and the Settings window (**Ctrl+,**) hold the same controls.

- **Skins** change shape, type, spacing and depth: Classic, Studio, Studio Flow, Compact, Slate, Editorial, Folio, Aurora, Aurora Thin and Aurora Flow (the default).
- **Colour schemes** change the palette, and work with every skin. Edit individual colours and save your own themes.
- Fonts, sizes, weight, spacing, line numbers, tables, diagrams, tab colours and file labels are all adjustable. **Restore defaults** returns to Aurora Flow and Light grey.
- Interface text follows your system's English: American spelling in the United States, British elsewhere.

## Phones and narrow windows

In browsers narrower than 760 px, and on phones, Weave switches to a phone layout: it opens on the start page with large buttons (including **Browse files**), the article fills the screen, Files and the sidebars slide in as drawers, the tab bar hides while you read, the graph pinch-zooms and the browser's Back closes menus and drawers first. It works with every skin.

## Your data

Weave keeps one application folder, outside your workspaces:

```text
%LOCALAPPDATA%\Weave\.weave\        (Linux: ~/.local/share/Weave/.weave/)
  weave.sqlite        index cache, plus sessions and preferences
  window-state.json
  webview/
  operations/         rename journals for recovery
  trash/              only if delete backups are enabled
  git-keys/           deploy keys made by Set up Git (private; one folder per workspace)
```

- The graph, search and Kanban rows in `weave.sqlite` are rebuilt from your Markdown whenever needed, but keep the file: it also holds sessions, workspace names and colours, and Git preferences.
- **Choose location** in Settings moves the whole data folder; Weave copies and verifies it and keeps the old one as a backup.
- Changes made outside Weave are picked up by a file watcher, with a periodic safety-net scan (Control panel › Workspace refresh).
- Rename and move previews count affected links; failed multi-file operations roll back where safe and leave a journal for recovery.

## Limits

4 MB per article; 1,000,000 articles and 32 GB of Markdown per workspace; 64 folder levels; 100 nodes per displayed graph neighbourhood. A newly opened workspace is searchable as background indexing completes, about a minute per 100,000 articles. The database grows to roughly four times the Markdown it indexes. Symbolic links and junctions are skipped.
