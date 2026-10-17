# Weave Server

Weave Server provides single-user HTTP access to Weave's existing Rust backend and browser interface, either inside the desktop app or as a dedicated headless process. Markdown remains authoritative. One SQLite database stores registrations, labels, monitoring preferences, deletion settings and derived indexes. The dedicated headless binary requires no Tauri, WebView, Node.js or database service at runtime; Git and OpenSSH are needed only for Source control ([Git and GitHub](#git-and-github)), and the Docker image includes both.

## Run locally

Prepare dependencies with Node.js 24+, npm and Rust:

```sh
npm ci
cargo fetch --locked --manifest-path src-tauri/Cargo.toml
npm run build:server:native
```

Run `src-tauri/target/debug/weave-server` (`weave-server.exe` on Windows):

```sh
weave-server --host 127.0.0.1 --port 8765 --workspaces ./workspaces --data ./.weave-server
```

Open [localhost:8765](http://localhost:8765). The default listener is loopback only. `--port 0` chooses an available port and prints it. `--host` accepts an IPv4 or IPv6 address. `--origin` is optional: when set, it is the only browser origin accepted, and remote origins require HTTPS. Without it, the server answers any host name by default (`--allowed-hosts any`), so reverse proxies, tunnels, LAN names and remapped ports work unconfigured; API calls must still come from a page on the host they are sent to (Origin matches Host), carry Weave's custom header and JSON type, and be signed in. A browser that reached the server over HTTPS (through a proxy) gets a `Secure` session cookie. `--allowed-hosts local` (`WEAVE_ALLOWED_HOSTS=local`) opts into the stricter model, which also blocks DNS-rebinding pages from reaching the login and first-run setup forms: a loopback listener then accepts its own address and `localhost`, a listener on one non-loopback address accepts `http://` that address, and a listener on every interface (`0.0.0.0`, or `::` with IPv6) accepts loopback plus `http://` each address of this computer, read when the server starts. The start-up log lists these addresses in either mode. Desktop-hosted servers always use the local mode. Plain-HTTP network access sends passwords and session cookies unencrypted; use it only on a trusted network, and otherwise use an HTTPS `--origin` behind a reverse proxy or tunnel. Built-in administrator authentication protects content independently of origin validation. Terminate TLS at a reverse proxy or tunnel; the backend listener itself speaks HTTP.

The workspace and data directories are created if absent and must not overlap. Use dedicated server data, separate from desktop data. An exclusive process lock prevents two servers from sharing one database.

Each direct child folder of `--workspaces` can be a workspace. Use **Open workspace folder…** to register an existing folder or **Create workspace** to create one. For example, `/workspaces/Personal` and `/workspaces/Team` are independent. Nested workspace roots, absolute paths, symlinks and junctions cannot be registered. Files inside workspaces can have nested folders as usual. Administrators can mount existing libraries at separate direct child directories.

Up to 12 registered workspaces run concurrently, each with its existing `kb-…` identifier, scope, indexes and watcher. IDs derive from canonical roots as on desktop: retain mount paths and folder names when moving a deployment. Change display names in Settings without renaming folders.

**Deactivate** hides a workspace only in the current browser tab. Other tabs keep working and server monitoring continues. **Remove from server**, in the folder picker, unregisters access for all browser tabs and stops monitoring, but keeps Markdown, cached rows and settings. Opening its folder again restores registration. Unavailable folders can also be removed. Startup logs missing/invalid folders and continues with the others.

## Hosting from the desktop

The primary Windows and Linux desktop executable includes the HTTP server. Open **Settings › Web server**, select the workspaces to serve, whether to listen on **This computer only** (`127.0.0.1`) or **All network interfaces** (`0.0.0.0`) (**Advanced** accepts any address), the port and an optional browser origin, then select **Start server**. While it runs, the status card links every address the server accepts. Starting without an administrator password scrolls to the password field and explains what is missing. **Save settings** persists configuration without starting it. Set an administrator password before the first desktop-hosted start. **Save authentication** changes the username, replaces the password or configures Turnstile even while running; empty password/secret fields preserve existing values. **Restart server** stops and restarts the listener. **Stop server** drains admitted requests and releases the port. Stop before changing configuration. The server does not start automatically when opening the desktop.

The workspace list defaults to the desktop’s active workspaces. Select any combination of known workspaces, even from different locations, or use **Open another workspace…** to add one through the desktop picker. **Use active workspaces** restores the current active selection. Saved selections persist. Only selected workspace identities are browser grants; other desktop workspaces remain private. Fresh browser tabs automatically load every selected workspace, while reloading the same tab preserves its deactivations until the controller selection changes. Use **W › Open workspace folder…** or **Settings › Workspaces › Open workspace folder…** in the browser to reopen a selected workspace. Browser users cannot add or remove controller grants, so the browser start page offers Open but not Create workspace. Browser Source control uses this computer's Git with the hardening described in [Git and GitHub](#git-and-github). Deploy keys are stored in the desktop's data folder and shared by the desktop and its browsers. A workspace without a deploy key pushes over SSH with this account's own keys or agent. Desktop and HTTP access use the **same Backend, SQLite database, workspace scope, watcher and write lock**. HTTP registration cannot grant arbitrary desktop paths. Browser navigation stays per browser tab. Deactivating a desktop workspace keeps browser access alive; stopping the server keeps desktop access alive. The combined limit is 12 loaded workspaces. Stopping HTTP releases server-only workspaces and leaves desktop workspaces usable.

Enable **Leave server running in background when Weave closes** before starting. Closing the window while the server runs hides it and preserves its state and unsaved drafts. The tray offers **Open Weave**, **Stop web server**, and **Quit Weave and stop server**. Launching Weave again restores the existing window. Quit still checks unsaved changes. Background mode requires a system tray; it lasts until Quit, logout or shutdown and is not a Windows service or Linux system service. Linux desktops need an AppIndicator-compatible tray (or reopen by launching Weave).

The desktop stores hosting settings in its existing database and authentication in its instance-level `auth/auth.sqlite` store. Its hosted listener intentionally shares that data; the separate CLI/server process uses the dedicated `--data` directory described above. Do not start a separate server over the same data directory while desktop Weave owns it.

### One command implementation

These run the same server CLI, **without creating a window or initialising Tauri/WebView**:

```powershell
.\Weave.exe server --host 127.0.0.1 --port 8765 --workspaces C:\WeaveLibraries --data C:\WeaveServerData
.\weave-server.exe --host 127.0.0.1 --port 8765 --workspaces C:\WeaveLibraries --data C:\WeaveServerData
```

```sh
./weave server --workspaces /srv/weave/workspaces --data /srv/weave/data
./weave-server --workspaces /srv/weave/workspaces --data /srv/weave/data
```

Use `server --help` on the desktop binary or `--help` on the dedicated server. `--server` is an alias for `server`; the dedicated binary accepts both prefixes too. CLI mode starts only HTTP; simultaneous GUI and HTTP use the desktop controls. CLI options, validation, defaults and shutdown live together in `server.rs`.

The **dedicated** `weave-server` builds have zero Tauri, WebView2, GTK, tray or interactive-session dependency. The Windows primary executable's server path does not need a WebView2 runtime or a desktop session. The Linux primary executable still links its desktop libraries, which the OS must load even in CLI mode; use the dedicated binary/container on a machine without those libraries. All HTTP/core code compiles independently with `--no-default-features --features server`.

## Docker Compose

From the repository root:

```sh
docker compose up -d --build
```

Open [localhost:8765](http://localhost:8765), or this computer's network address, and create the administrator account. The port is published on every interface (`WEAVE_PORT` changes the host port), like other self-hosted services; put a reverse proxy or tunnel in front for HTTPS, with no further Weave configuration. To lock the server down, set `WEAVE_ORIGIN` to its public HTTPS origin (then the only one accepted) or `WEAVE_ALLOWED_HOSTS=local` (see host names below), in `.env` or the shell. To keep it on this computer only, publish `127.0.0.1:8765:8765` in an override. Named volumes persist `/workspaces` and `/data`. `docker compose down` retains them; **`down -v` deletes them**.

The Dockerfile builds the frontend with Node and the core with `--no-default-features --features server`. It fetches crates only for the container's own Linux target and leaves the Tauri CLI out of `npm ci`, so no desktop or Windows build tooling is downloaded. The Debian slim runtime contains the server, its system C runtime and dictionary licences. It runs as UID/GID `10001` with dropped capabilities, a read-only root filesystem, temporary `/tmp` and no privilege escalation. Scripts, styles, dictionaries and the export template are embedded. Source articles and repository secrets are excluded from the build context.

To keep workspaces and data in folders you choose rather than named volumes, run the helper once before starting. It creates the folders, gives them to the container's user (UID/GID `10001`, using `sudo` when needed) on Linux and writes `compose.override.yaml`:

```sh
sh scripts/server/prepare-folders.sh                                   # ./weave/workspaces and ./weave/data
sh scripts/server/prepare-folders.sh --workspaces ~/Notes --data ~/.local/share/weave-server
```

On Windows with Docker Desktop, use `.\scripts\server\prepare-folders.ps1 [-Workspaces D:\Notes] [-Data D:\WeaveData]`; Docker Desktop maps ownership itself. Each direct child folder of the workspaces folder is a workspace, and the data folder holds accounts, indexes and Git deploy keys, so keep it private and back it up. Run the helper again with `--force` (`-Force`) to replace the override.

To write the override by hand instead, replace the workspace volume:

```yaml
services:
  weave:
    volumes:
      - ./my-libraries:/workspaces
```

Keep libraries under that directory, or mount each separately at `/workspaces/Name`. On Linux, grant UID/GID `10001` read/write access before starting. Never mount the Docker socket, a home directory or application data into `/workspaces`. SQLite data belongs on local persistent storage, not a network filesystem.

Build arguments `NODE_VERSION` and `RUST_VERSION` pin the toolchain. `WEAVE_IMAGE` selects the image name. Once a trusted prebuilt image is available, select its tag/digest and use `docker compose up -d --no-build`. This change does not publish an image.

Stop the server before copying both persistent volumes for a consistent backup. SIGTERM/Control+C stops accepting requests, drains admitted operations, stops the monitor and checkpoints SQLite. Each browser tab keeps navigation in session storage; the most recent saved session in local storage supplies article positions and layouts for a new tab or browser session. Desktop-hosted browser tabs always initially open the controller’s selected workspaces. New installations and restored appearance defaults use Aurora Flow and Light grey; saved explicit appearance choices remain unchanged. Clearing browser storage removes those preferences. Browser navigation and appearance are not server backups. Authentication sessions are managed separately by the server; include its private authentication store and initialization marker in backups. Unsaved drafts are not recovery backups; save before closing a tab.

## Git and GitHub

Browser users have the same **Source control** panel as the desktop: commit, stage, diff, branches, stashes, conflicts, pull, push and **Commit all & sync**. Weave authenticates to GitHub (or GitLab, or any SSH Git host) with a **deploy key**: an SSH key created by Weave for one workspace, whose public half you add to one repository. The private half stays in the server's data folder (`<data>/git-keys/<workspace id>/`) and is never sent to the browser.

**Requirements.** The Docker image includes Git and OpenSSH. A server run directly needs `git` and `ssh`/`ssh-keygen` on its `PATH` (`sudo apt install git openssh-client` on Debian/Ubuntu; Git for Windows supplies both on Windows).

### Set up Git for a workspace

Open the workspace, then choose **Set up Git** on its start page (an empty tab), **W › Set up Git…**, or **Set up Git…** in Source control. The guide marks each step as it is done and can be closed and reopened at any point:

1. **Create a Git repository.** Weave runs `git init` in the workspace folder. Your files are not changed.
2. **Name your commits.** Enter the name and email shown on GitHub beside your changes. They are saved in this repository's Git configuration. To keep your address private, use the `…@users.noreply.github.com` address from GitHub › **Settings** › **Emails**.
3. **Choose the GitHub repository.** On GitHub, select **New repository**. Leave the README, `.gitignore` and licence options off so it starts empty, or use an existing repository. Paste its address: the page URL (`https://github.com/you/notes`), the SSH address (`git@github.com:you/notes.git`) or `you/notes`. Weave stores the SSH form as the `origin` remote, because deploy keys authenticate over SSH.
4. **Give Weave access with a deploy key.** Select **Create deploy key**, then **Copy public key**, then **Open GitHub deploy keys** (it opens *repository › Settings › Deploy keys › Add deploy key*; you need to be the repository's owner or an admin). On GitHub:
   - **Title:** something recognisable, for example `Weave – Notes` (the guide offers one to copy).
   - **Key:** paste the public key (it starts with `ssh-ed25519`).
   - Tick **Allow write access**. Without it Weave can download but not push.
   - Select **Add key**.

   Back in Weave, select **Test connection**. The guide explains a refused key, a missing repository or a changed host key.
5. **Connect and sync.** If the GitHub repository is empty, **Upload and sync** commits the workspace and pushes it as the first version. If it already has articles and this workspace has no commits yet, **Download from origin** checks out its default branch, keeping files here that the remote does not have. If a local file has the same name as one in the repository, the download stops so nothing is overwritten. Rename or move that file and retry.

Afterwards, use **Commit all & sync** in Source control as usual. GitHub accepts a deploy key in one repository only, so each workspace gets its own key. **Create a new key** replaces it (add the new key on GitHub and delete the old one), and **Remove key** deletes it from the server. Removing a workspace from the server keeps its key; restore it by opening the folder again.

GitHub's and GitLab.com's published SSH host keys are built in, so first connections to them are verified. For other hosts, the key presented on first contact is recorded in `<data>/git-keys/known_hosts`, and a later mismatch stops the connection.

### Safety of server-side Git

Browser requests run Git with repository hooks disabled, only `https`, `http` and `ssh` transports allowed, no submodule recursion, and Weave's SSH command in place of any `core.sshCommand` in the repository. Remotes must be HTTP(S) or SSH addresses without embedded credentials, and browsers can never write inside `.git`. Each workspace's Git lock keeps one Git operation per workspace at a time. Other workspaces, reading, searching and editing continue while it fetches or pushes, and a Git command stops after 90 seconds.

To limit which hosts remotes may reach, set `--git-hosts github.com` (`WEAVE_GIT_HOSTS=github.com,gitlab.example.org` in `.env` for Compose). Remotes on other hosts, and existing remotes pointing elsewhere, are then refused. Anyone signed in to Weave can use a workspace's deploy key, so give a key write access only to repositories this Weave instance should change.

Back up the data folder (or volume) with the workspaces: it holds the deploy keys. A lost key is simply replaced. Create a new key and add it on GitHub.

## Protected remote access

Weave provides built-in single-administrator authentication. HTTPS termination still belongs to a reverse proxy or tunnel; MFA can be added through an external gateway. Turnstile is optional bot mitigation and does not supply MFA or TLS. The Cloudflare example removes the local published port entirely and puts Weave on an internal container network. Only the tunnel container connects that network to the outside. Use Docker Compose 2.24.4+ for override tags. `ports: !reset []` removes the inherited publication; an ordinary empty list would not. See [Docker's merge rules](https://docs.docker.com/reference/compose-file/merge/).

1. Create a Cloudflare Access self-hosted application for the **entire** intended hostname, such as `notes.example.com`, including every API path. Restrict it to your identity and require MFA through the chosen provider. Do not add bypass policies or unauthenticated alternate hostnames.
2. Create a remotely managed Tunnel. Route that hostname to `http://weave:8765`. Preserve the browser's Host header, or set the origin HTTP Host header to `notes.example.com`. Enable **Protect with Access**, supplying your Access team name and application audience, so the connector validates the Access JWT before forwarding. A Tunnel alone does not authenticate users. See [Cloudflare's origin Access settings](https://developers.cloudflare.com/tunnel/reference/origin-parameters/) and [Tunnel setup](https://developers.cloudflare.com/tunnel/get-started/).
3. Put the tunnel token in a private file outside the repository. Set `CLOUDFLARE_TOKEN_FILE` to it and `WEAVE_ORIGIN=https://notes.example.com`. Select a tested version/digest with `CLOUDFLARED_IMAGE` for repeatability; the example defaults to Cloudflare's current image.
4. Inspect the merged configuration and launch:

```sh
docker compose -f compose.yaml -f compose.cloudflare.yaml config
docker compose -f compose.yaml -f compose.cloudflare.yaml up -d --build
```

Verify `weave` has no published ports. Confirm an unauthenticated private browser cannot reach `/` or `/api/request`, and that successful Access login permits editing. Repository tests do not provision an account or tunnel: validate the real Access policy before use.

Other authenticated proxies work with the same design: only the proxy can connect to the backend, it preserves Host and Origin, and `--origin` names the external origin. Serve at the hostname root. Do not publish the backend port or leave an unauthenticated alternate route. Weave does not trust forwarded identity headers or implement workspace-level user permissions. The gateway is an additional check; users still sign into Weave. The administrator has access to all controller-granted workspaces.

## Built-in authentication and provisioning

Authentication belongs to the server instance, in `DATA/auth/auth.sqlite`, independently of workspace/index data. Keep `DATA/auth.initialized` with it: this durable marker prevents a missing store being mistaken for a new installation. The private directory contains SQLite journals and an initialization lock. Unix permissions are 0700 on the directory and 0600 on secret files; Windows uses a private owner ACL. Passwords use salted Argon2id (19 MiB, two iterations, one lane); session tokens use 256 bits of OS randomness. The administrator's stable internal ID survives credential changes. Back up this store as durable configuration.

A new headless installation has no administrator. The start-up log says so, and the first browser visit shows **Create the administrator account** (username, default `admin`, and a password of 12–1024 UTF-8 bytes); creating it signs that browser in. The setup form closes as soon as an account exists, and concurrent attempts create one identity. Complete setup before exposing the server: until then, whoever reaches it first creates the account. No password is generated or printed. Interrupted initialization, corrupt databases and missing administrator records fail closed; restore a consistent backup. Restarting/upgrading preserves credentials.

To create the account at start instead (automation, or to skip the setup window), set `WEAVE_ADMIN_USERNAME` (default `admin`) and `WEAVE_ADMIN_PASSWORD`, or `WEAVE_ADMIN_PASSWORD_FILE` pointing at a file such as a Compose secret under `/run/secrets/` (the file wins). They are read only on a new installation and ignored once an account exists; change the password afterwards in the browser or with `admin reset-password`. `compose.yaml` passes these variables through from `.env` or the shell. Prefer the file form where environment values are visible to other users of the Docker host. Compose persists authentication in `/data`.

`weave server admin ...` and `weave-server admin ...` share local administration code, work while serving and never initialise Tauri:

```sh
weave-server admin status --data /srv/weave/data
weave-server admin set-username --data /srv/weave/data --username owner
weave-server admin reset-password --data /srv/weave/data
weave-server admin reset-password --data /srv/weave/data --password-file /run/secrets/replacement
```

Interactive resets prompt twice with echo disabled. Noninteractive resets require a password file; plaintext password arguments are rejected. `admin bootstrap` requires terminal output to prevent accidental logging. Desktop starts require an explicitly configured password. Empty password/secret fields preserve existing values. **Save authentication** works while running; credential and Turnstile changes revoke sessions.

Phones and tablets can use the browser interface: narrow screens get the phone layout described in the [user guide](USER_GUIDE.md#phones-and-narrow-windows) (Files open at start, drawers, a tab bar that slides away while reading, pinch zoom in the graph, full-screen Settings, Back closes drawers and menus before leaving a page). Plain-HTTP LAN addresses are not secure contexts, so the page avoids APIs browsers reserve for HTTPS (such as `crypto.randomUUID`), and the editor menu's Copy and Paste, which need the HTTPS-only clipboard API, ask you to use the system's own copy and paste instead. Browser **W › Server account…** opens password/logout controls separately, preserving reader drafts. Sessions expire after 12 hours absolutely or 30 idle minutes; only token digests are stored. HTTPS origins receive Secure, HttpOnly, SameSite=Strict `__Host-` cookies; plain-HTTP origins (loopback, or this computer's own addresses when no origin is configured) use HttpOnly, SameSite=Strict cookies without Secure. Content POSTs require the session CSRF token plus exact Origin/Host, JSON, custom-header, scope and instance checks. Login/password attempts are persistently limited to 10 per actual peer IP and 60 globally per five minutes, with two concurrent authentication operations. Forwarded client/identity headers are ignored; proxy clients share its peer budget. Local administration remains available during throttling.

## Optional Turnstile

Configure **Settings › Web server › Cloudflare Turnstile**, or:

```sh
weave-server admin turnstile --data /srv/weave/data --enabled true \
  --site-key YOUR_SITE_KEY --hostname notes.example.com --secret-file /run/secrets/turnstile
weave-server admin turnstile --data /srv/weave/data --enabled false
```

The public site key goes to the login flow. The secret stays in private SQLite and is omitted from status JSON, browser APIs and settings responses. Empty desktop secret fields retain it. The official widget supplies a token; the backend calls the fixed HTTPS Siteverify endpoint with a 10-second deadline and bounded response. It requires success, configured hostname and action `login`. Missing, expired, reused or rejected tokens and network failures deny login. The reader CSP and standalone/export no-request contract remain unchanged.

Use [Cloudflare's official test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/) only in development. Configure hostname `localhost` for documented dummy responses; known test secrets use action `test`. Production secrets require `login`. Offline tests use local fixtures and never contact Cloudflare. Verify the actual widget/TLS/proxy configuration before public exposure. Turnstile supplies bot mitigation; optional MFA gateways remain compatible.

The module returns a stable `Principal`; user/session tables and explicit workspace grants leave a boundary for later providers and authorization. OIDC, trusted forwarded identities and multiple users are not implemented. No WebSocket/SSE route exists; unknown upgrades cannot bypass authentication.

## Transport and security boundary

The default `desktop` Cargo feature keeps Tauri. `server` adds the Hyper/Tokio transport and `weave-server` entry point. The pooled WAL database, file safety checks, parsing, indexing, search and Kanban are shared. There is no parallel Markdown or indexing implementation.

`POST /api/request` accepts `{op, args}` JSON. First sign in at `/api/auth` and fetch `/auth/status` for the session CSRF token, then call `health` and retain its `instance` identifier. Subsequent calls send `X-Weave-Instance`, `X-Weave-CSRF`, `X-Weave-Request: 1`, `Content-Type: application/json` and the exact `Origin`. Host must match an allowed origin. Cross-site Fetch Metadata, arbitrary Host headers, missing Origin and non-JSON API requests are refused; no CORS grants are issued. GET exposes the authenticated embedded reader, the login/account page, its fixed assets, `/auth/status` and minimal `/healthz`, never arbitrary files. Content bodies are limited to 8 MiB and authentication bodies to 16 KiB, with a 15-second read deadline; connections and concurrent work are bounded. Responses are uncached, the reader uses CSP hashes, the login page permits only its fixed assets and Cloudflare widget, and neither page can be framed.

Every content request requires an explicit positive `args.scope`. Logical resources also carry a checked `workspaceId`. Instance identifiers invalidate old process-local scopes after restart. Content requests never use the desktop's implicit current-workspace fallback. Search cancellation channels are unique to each browser page.

The allowlist exposes existing CRUD, monitoring, catalog delta/paging, search/evidence and Kanban requests. `serverFolders`, `serverOpen`, `reopen`, `serverRemove`, `controlPanel`, `configureWorkspace` and `configureDeletion` manage permitted roots/settings. Browser layouts/sessions never call the desktop session writer. Transport metadata omits private OS paths and database locations.

Graph neighbourhoods return the existing bounded depth chunks in one HTTP response, using the same frontend adapter as Tauri Channels. Changes use status/catalog-delta polling, approximately every 1.4 seconds for visible tabs. WebSocket/SSE protocols are deferred. Core requests run on Tokio's blocking pool without a global backend lock. Workspace registration leaves initial indexing to the monitor.

`POST /api/export` accepts `{op:"export", args:{scope, folder, graph, otherFiles}}` and returns a downloadable read-only HTML file. The server chooses its staging path and template. Caller-supplied OS paths/templates cannot redirect writes. Native dialogs, reveal commands, data relocation, arbitrary external-file writes, shutdown and metrics are absent from the HTTP allowlist. Git requests (`gitStatus`, `gitDiff`, `gitHistory`, `gitCommitDiff`, `gitIgnore`, `gitAction`) are allowed for scoped workspaces and always run hardened (see [Git and GitHub](#git-and-github)); the server sets that mode itself, so a caller cannot relax it or widen `--git-hosts`.

Saves and Kanban writes require the current hash. Stale changes return HTTP 409 and leave the draft intact. Rename previews keep their existing expiring tokens and snapshots. There is no simultaneous editing merge, user model, CRDT or collaborative Git protocol. Evidence APIs remain available to programmatic callers; the existing core has no model/agent execution provider to expose. Normal browser clipboard permissions apply, and clipboard APIs require a secure context.

## Validation

```sh
npm run build:server:native
cargo test --offline --locked --manifest-path src-tauri/Cargo.toml --no-default-features --features server --lib
npm run test:server
npm run build:desktop
npm run prepare:runtime
cargo build --offline --locked --manifest-path src-tauri/Cargo.toml --features custom-protocol --bin weave
npm run test:server:primary
node app/weave/verify-native.mjs src-tauri/target/debug/weave.exe
docker compose build
npm run test:server:container
```

Browser checks use the repository's pinned Playwright (`WEAVE_PLAYWRIGHT` can override it). `WEAVE_SERVER` can select a binary; otherwise tests use the debug server under `src-tauri/target` or `CARGO_TARGET_DIR`. Tests create disposable workspaces and check origin/Host restrictions, traversal/junction rejection, privileged-operation denial, cross-workspace isolation, stale saves, CRUD, watcher/search/graph/Kanban/export, real browser editing, independent tabs and restart persistence. Screenshots go to `test-results/server-*.png`. Existing desktop regressions and the 100,000-document benchmarks remain required; see [PERFORMANCE.md](PERFORMANCE.md).

The container test uses disposable named volumes, recreates the container to check persistence and removes only its own test resources. It verifies UID 10001, a read-only root, dropped capabilities, absent build helpers and clean SIGTERM. Select another image with `-- --image <image>`; the script also accepts `--engine podman` and `--no-cgroups` for WSL environments without delegated cgroups.

Phase 1 validation on 11 October 2026 passed 151 JavaScript/integration tests, 36 headless Rust tests, browser/server tests, desktop workspace/graph/Kanban/editor/table/layout suites and the isolated native runtime check. The production Dockerfile built and its container recreation test passed under Podman in WSL. Docker Compose configurations were validated, including removal of the remote origin port; Docker Desktop's engine was unavailable, so an actual Docker Compose launch and a live Cloudflare Access policy were not exercised. WSL image preparation used the build machine's trusted CA bundle and disabled cgroups for that test runtime; these are local tooling adjustments, not production configuration changes.

All 100,000-document UI budgets and backend interactive/memory budgets passed. Cold indexing still exceeded its acceptance budget (191 seconds versus 120 seconds); the full backend scale check therefore failed. [PERFORMANCE.md](PERFORMANCE.md) records both runs without relaxing budgets.

Desktop-hosting validation on 11 October 2026 passed 151 JavaScript/integration tests, 37 headless Rust tests, all desktop/browser/workspace/graph/Kanban/editor/table/layout regressions, and native lifecycle tests on Windows and Linux amd64. Native tests cover shared desktop/HTTP scopes and files, background close, second-launch reopening, stop/restart and storage relocation; Windows also exercises the Settings Start/Stop buttons. Both primary executables passed the full HTTP/browser suite in server-only mode with no display and an unavailable WebView runtime path. The dedicated Linux server passed the same suite; its `ldd` output contains only libc, libm, libgcc_s and the ELF loader. The no-default-features Cargo graph excludes Tauri, GTK, WebKit, tray and WebView dependencies. Linux arm64 package sources were updated but were not rebuilt in this follow-up. The current 100,000-document UI benchmark passed all budgets; cold-indexing results are recorded in [PERFORMANCE.md](PERFORMANCE.md).

The multi-workspace/default-appearance follow-up passed 153 JavaScript/integration tests and 38 headless Rust tests, plus browser, dynamic, desktop, workspace, graph, Kanban and layout checks. Windows and Linux amd64 native acceptance verifies two controller-selected workspaces with identical folder names in different locations, browser auto-loading despite an old empty session, the managed workspace picker, saved checkbox changes narrowing browser access while both desktop workspaces remain active, and background/stop/reopen/storage relocation. Both Windows binaries and the dedicated Linux binary passed the HTTP/browser suite. The Linux native WebKitWebDriver screenshot endpoint timed out on Xvfb, including with software compositing; functional and geometry acceptance passed with explicit `--skip-screenshots`, and browser screenshots were captured and inspected. The 100,000-article UI budgets passed; the existing cold-index time/status budgets still fail as recorded in [PERFORMANCE.md](PERFORMANCE.md). No packages or Linux arm64 binaries were rebuilt in this follow-up.

Authentication validation on 11 October 2026 passed 153 JavaScript/integration tests, 44 Windows Rust tests with both desktop and headless features, and 41 Linux headless Rust tests. HTTP/browser tests exercise first-visit setup (and that it closes), cookie flags, CSRF, credential reset and revocation (including a request whose body arrives after reset), Turnstile secret redaction, throttling and restart persistence. Rust tests cover concurrent setup, environment provisioning, missing/damaged stores, idle/absolute expiry, stable identity, settings changes during login and local Siteverify transport fixtures. Windows native acceptance covers masked/unchanged credentials, live password replacement, secret redaction and revocation, plus background/reopen/stop/restart/data relocation. Login and Settings screenshots were inspected. Browser, dynamic, desktop and multi-workspace regressions passed.

The Linux container passed non-root/read-only/capability checks, initial password change, authenticated access and persistent sessions after recreation. Docker Desktop was unavailable; Podman used the production build stages with cached crates supplied read-only and only dependency fetching switched to offline because the build environment's registry TLS failed. No production Dockerfile security settings were relaxed. Linux native acceptance was attempted twice but WebKitWebDriver timed out creating its second session, before the server phase; the amd64 desktop compiled, while this native follow-up remains unverified. Live Cloudflare widget/Siteverify, public TLS/proxy deployment, Docker Compose launch, arm64 and release packages were not exercised. All UI scale budgets passed; the existing cold-index/backend-status failures remain recorded in [PERFORMANCE.md](PERFORMANCE.md).
