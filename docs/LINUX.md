# Linux builds

The headless `weave-server` target builds separately without Tauri, GTK or WebKit: use `--no-default-features --features server --bin weave-server` after `npm run build:server`. The root Dockerfile provides its Linux container build; [SERVER.md](SERVER.md) documents deployment. The headed desktop also supports Settings › Web server and background hosting, plus `weave server` without opening a display. It still links GTK/WebKit; use the dedicated binary for machines without desktop libraries. Desktop packages now depend explicitly on `libayatana-appindicator3-1` (loaded dynamically for the tray); build environments and the arm64 cross image include its development package. A visible tray needs an AppIndicator-compatible desktop extension/panel. Launching Weave again also restores a hidden background window.

Weave for Linux is the same Tauri application as on Windows: one executable that embeds the frontend, the Rust backend and SQLite. On Linux the interface runs in the system's **WebKitGTK 4.1** instead of WebView2. This document records how the Linux build machine is set up, how packages are produced and checked, and what they run on. Everything here is reproducible from the scripts in `scripts/linux/`.

## What gets released

| File | For | Notes |
| --- | --- | --- |
| `weave_<version>_amd64.deb` | Ubuntu 22.04+, Debian 12+, **Linux on ChromeOS**, Mint, Pop!_OS and other Debian-based distros | Installs `/usr/bin/weave`, a menu entry and icon, and Weave Lite under `/usr/share/doc/weave/`. apt installs WebKitGTK, GTK and Ayatana AppIndicator automatically. `Recommends: git`. |
| `Weave-<version>-linux-x64.tar.gz` | Any x86-64 distro with GTK 3 and WebKitGTK 4.1 (Fedora 38+, Arch, openSUSE Tumbleweed, …) | Portable folder: run `./weave`. `./install-desktop-entry.sh` adds a per-user menu entry (`--remove` takes it out). Install the distro’s WebKitGTK 4.1, GTK 3 and Ayatana AppIndicator runtime packages before launching the GUI. |
| `weave_<version>_arm64.deb`, `Weave-<version>-linux-arm64.tar.gz` | The same, on 64-bit ARM (ARM Chromebooks, ARM laptops, Raspberry Pi 4/5 with a desktop) | Built with `--arch arm64`; see [ARM builds](#arm-builds-arm64). |
| `SHA256SUMS` | Everyone | Checksums of every package in the folder. |

Upload the packages and `SHA256SUMS` to the GitHub release. They are written to `dist/linux/<version>-<tree>/`, where `<tree>` is the first 12 characters of the Git tree hash of the sources that were built. The release workflow ([scripts/README.md](../scripts/README.md#releases-github-actions)) builds the same packages, plus `Weave-Server-<version>-linux-<x64|arm64>.tar.gz`, on GitHub's Ubuntu 22.04 runners from a pushed `v*` tag.

Application data lives in `$XDG_DATA_HOME/Weave/.weave` (normally `~/.local/share/Weave/.weave`) and moves with the Settings data-location option as on Windows.

### ChromeOS

Chromebooks run Linux apps in a Debian container (Settings › About ChromeOS › Developers › Linux development environment). Current containers are Debian 12 (bookworm); recently created ones may be Debian 13. To install, download the `.deb` in ChromeOS, open it from the Files app and choose **Install**, or run `sudo apt install ./weave_<version>_amd64.deb` in the Linux terminal. Weave then appears in the launcher's Linux apps folder. Only workspaces in the Linux files area, or folders shared with Linux from the Files app, are visible to Weave.

The package checks install and start the `.deb` in clean Debian 12 and Debian 13 containers to cover this. Intel and AMD Chromebooks use the amd64 `.deb`; ARM Chromebooks (MediaTek, Qualcomm) use the arm64 `.deb`. To tell which one a Chromebook needs, run `dpkg --print-architecture` in its Linux terminal.

ChromeOS's container has limited GPU access, where WebKitGTK's DMA-BUF renderer can leave windows blank, so Weave sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` for itself when it finds `/opt/google/cros-containers` (an explicit setting wins). On other systems, if the window stays blank (some virtual machines and graphics drivers), start Weave with `WEBKIT_DISABLE_DMABUF_RENDERER=1 weave`.

## Build machine

Release builds are made on **Ubuntu 22.04** (glibc 2.35, WebKitGTK 4.1), currently the WSL2 distro `Ubuntu-22.04` on the Windows development machine. Building on the oldest supported distro is what lets the binary run on newer ones; a binary built on Ubuntu 24.04 or 26.04 would not start on Debian 12 or Ubuntu 22.04.

The pinned toolchain is in [`scripts/linux/toolchain.env`](../scripts/linux/toolchain.env):

| Tool | Version | Source |
| --- | --- | --- |
| Rust | 1.98.1 (same as Windows) | rustup, minimal profile, `~/.rustup` and `~/.cargo` |
| Node.js | 24.19.0 (same as Windows) | nodejs.org tarball, SHA-256 checked, in `~/.local/share/weave-build/` |
| Playwright | 1.62.1, tests only | the repository's pinned devDependency (`npm ci`); its Chromium and WebKit test browsers in `~/.local/share/weave-build/ms-playwright`. `package-linux.sh` stops if `toolchain.env` and `package.json` disagree |

### Setting up a build machine from scratch

1. Install the distro: `wsl --install -d Ubuntu-22.04` (or use any Ubuntu 22.04 machine). The WSL distro used here has `systemd=true` in `/etc/wsl.conf`, the default for new installs.
2. **Only on networks that inspect TLS** (for example Zscaler): export the corporate root certificate on Windows and add it to the distro's trust store, otherwise every download fails with `curl: (60) SSL certificate problem`. The commands are in the header of [`scripts/linux/import-windows-root-ca.sh`](../scripts/linux/import-windows-root-ca.sh). It installs the certificate to `/usr/local/share/ca-certificates/` and runs `update-ca-certificates`. The build scripts point Node at the system store (`NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt`), so npm and Playwright also trust it.
3. Run the setup script once (safe to repeat):

   ```bash
   sudo bash scripts/linux/setup-build-env.sh
   ```

   From Windows: `wsl -d Ubuntu-22.04 -u root -- bash /mnt/c/<repo>/scripts/linux/setup-build-env.sh --user <linux-user>`. Add `--arm64` to prepare ARM builds as well.

What the setup script changes:

- **apt packages** (system-wide): compilers and `pkg-config`; WebKitGTK 4.1, GTK 3, librsvg, libsoup 3 and JavaScriptCore and Ayatana AppIndicator development headers; `dpkg-dev`, `fakeroot`, `lintian`, `desktop-file-utils` and `appstream` for packaging; `xvfb`, `xauth`, `openbox`, `webkit2gtk-driver`, `dbus-x11` and `x11-utils` for headless native tests; `podman`, `uidmap`, `slirp4netns` and `fuse-overlayfs` for clean-container install tests; `fonts-noto-core` and `fonts-dejavu-core`; and the libraries Playwright's test browsers need (`playwright install-deps chromium webkit`). With `--arm64`, also `qemu-user-static` and `binfmt-support`.
- **Per user** (no root): rustup with only the pinned Rust toolchain; Node in `~/.local/share/weave-build/node-v<version>-linux-x64`; Playwright's test browsers in `~/.local/share/weave-build/ms-playwright` (installed with a copy of the pinned Playwright there). With `--arm64`, also the Rust `aarch64-unknown-linux-gnu` target and the podman image `localhost/weave-arm64-cross:jammy`. Nothing is added to shell profiles or `PATH`; the build scripts set their own `PATH`.
- The build distro keeps only the amd64 architecture. Do not add arm64 to it with `dpkg --add-architecture`: apt then replaces the amd64 WebKitGTK headers with the arm64 ones and native builds break.

Build state (source snapshot, Cargo target directories, npm cache, staging) is kept under `~/.local/share/weave-build/` and can be deleted at any time.

## Building packages

From Windows, in the repository:

```powershell
npm run package:linux                                   # working tree, all checks
npm run package:linux -- -Commit v1.0.0                 # one commit or tag
npm run package:linux -- -Arm64                         # the arm64 packages
npm run package:linux -- -VerifyReproducible            # also prove reproducibility
```

`npm run package:all` (`scripts/Package-All.ps1`) builds the Windows package first and then runs this script for amd64 and arm64 in turn (`-SkipArm64` leaves out arm64, `-SkipChecks` skips every stage's tests).

From Linux: `bash scripts/linux/package-linux.sh [--commit REF] [--arch arm64] [--skip-checks] [--verify-reproducible]`. For a release, build amd64 and then arm64 from the same commit; both land in the same folder and `SHA256SUMS` covers all four packages.

[`package-linux.sh`](../scripts/linux/package-linux.sh) does the following:

1. Refuses to run unless the pinned Rust and Node are the ones on `PATH`.
2. Takes a **clean snapshot** of the sources (so it builds exactly what a fresh clone would; files that exist only in your working tree because `.gitignore` hides them are left out) into `~/.local/share/weave-build/src`: either the named commit, or the working tree (tracked, modified and untracked files that are not ignored) written as a Git tree through a temporary index, so the real index is never touched. Git normalises line endings as a Linux checkout would, so a Windows working tree and a Linux clone give the same snapshot. Ignored files such as `knowledge/`, `dist/` and `node_modules/` never reach the build.
3. Runs `npm ci`, `cargo fetch --locked`, `npm run build`, `npm run build:desktop` and `npm run prepare:runtime`.
4. Runs `npm test`, `cargo test`, `npm run test:desktop` and `npm run test:workspaces` (unless `--skip-checks`; arm64 builds rely on the amd64 run).
5. Builds `cargo build --release --locked --offline --features custom-protocol`, with symbols stripped.
6. Runs the native acceptance test against the release binary on a virtual display (below).
7. Assembles the `.deb` and `.tar.gz` ([`make-packages.sh`](../scripts/linux/make-packages.sh)); the `.deb`'s `Depends` line comes from `dpkg-shlibdeps`, which reads the libraries and minimum versions the binary actually links against.
8. Checks the packages ([`check-packages.sh`](../scripts/linux/check-packages.sh)).

### ARM builds (arm64)

arm64 packages are cross-compiled on the same x86-64 build machine. Ubuntu 22.04 cannot install the arm64 WebKitGTK development packages beside the amd64 ones (they conflict, and apt removes the amd64 set), so the arm64 libraries and the `aarch64-linux-gnu` cross compiler live in a podman image, [`packaging/linux/arm64-cross.Containerfile`](../packaging/linux/arm64-cross.Containerfile): Ubuntu 22.04 pinned by digest, with arm64 packages from `ports.ubuntu.com`. `setup-build-env.sh --arm64` adds the Rust `aarch64-unknown-linux-gnu` target, installs `qemu-user-static` and `binfmt-support`, and builds the image as `localhost/weave-arm64-cross:jammy`.

`package-linux.sh --arch arm64` runs itself inside that image with the build user's home and the repository mounted at the same paths, so it uses the same pinned Rust and Node and the same remapped paths as amd64 builds. Unit and Rust tests are architecture-independent and run in the amd64 build; the native acceptance test needs an arm64 machine and is not run. The package checks run on the host, and the clean-container install tests run the arm64 Debian and Ubuntu images under QEMU emulation, which is slow but starts the real arm64 binary.

The apt packages inside the image are whatever `jammy-updates` held when the image was built. arm64 builds are reproducible against one image; rebuilding the image later can pick up newer arm64 library headers. Record the image ID (`podman image inspect localhost/weave-arm64-cross:jammy --format '{{.Id}}'`) with a release if you need to reproduce its arm64 packages exactly.

### Reproducibility

Two builds of the same sources with the same toolchain produce byte-identical packages:

- toolchain versions are pinned and checked; dependencies come from `package-lock.json` and `Cargo.lock` (`npm ci`, `--locked`);
- the source snapshot always sits at the same path, and `--remap-path-prefix` removes it and the home folder from the binary;
- `SOURCE_DATE_EPOCH` is the commit time (of `HEAD` for working-tree builds) and is used for every file time in the archive and `.deb`, the Debian changelog date and the `ar` member times;
- `TZ=UTC`, `LC_ALL=C.UTF-8` and `umask 022`; archives are written with sorted names, numeric root ownership, normalised modes and `gzip -n`; `dpkg-deb --root-owner-group`;
- incremental compilation is off.

`--verify-reproducible` rebuilds the binary from nothing in a second Cargo target directory, repackages it and fails unless both sets of packages have the same SHA-256. To check a published release independently, run `package-linux.sh --commit <tag>` on a machine set up from this document and compare `SHA256SUMS`.

## Tests on Linux

| Check | What it covers |
| --- | --- |
| `npm test` | Node unit tests (Linux paths, case-sensitive file system). |
| `cargo test` | Rust unit and native tests, including the Linux data-folder rules. |
| `app/weave/tests/runtime-smoke.mjs` (native acceptance) | Starts the **release binary** in WebKitGTK through WebKit's WebDriver (`WebKitWebDriver`, enabled only by `TAURI_WEBVIEW_AUTOMATION=true` in the test), with an empty `PATH` and a private `XDG_DATA_HOME`. Checks the frontend starts, IPC runs in the copied binary, custom window controls (maximise, minimise, restore, close), saved window placement, Rust graph streaming, create/save/search/rename/delete with FTS5, stale-write rejection and moving the data folder. Runs on a private Xvfb display with the Openbox window manager ([`with-display.sh`](../scripts/linux/with-display.sh)), which forces GTK's X11 backend: under WSLg, GTK would otherwise find WSLg's default `wayland-0` socket and open test windows on the Windows desktop. amd64 only. |
| `check-packages.sh` | lintian, `desktop-file-validate`, `appstreamcli validate`, package contents and modes, the portable menu-entry installer, and **installing the `.deb` with apt and starting Weave in clean Debian 12, Debian 13 and Ubuntu 24.04 containers** (podman). Set `WEAVE_CONTAINER_IMAGES` to change the distros. |
| `test:desktop`, `test:workspaces` | Run by `package-linux.sh` in Playwright's Chromium against the Linux test host: desktop editing, rename/move, multiple workspaces, the packaged-CSP emulation. |
| Other browser suites, and WebKit | Every suite runs on Linux with the repository's Playwright after `npm ci`, and `PLAYWRIGHT_BROWSERS_PATH` and `CARGO_TARGET_DIR` set as in `package-linux.sh` (the desktop suites start the debug `weave-test-host` from `CARGO_TARGET_DIR`, and `npm test` rebuilds it, so it needs `cargo` on `PATH` and the same `RUSTFLAGS` to reuse the cached build). `WEAVE_BROWSER` picks the engine ([`app/weave/test-browser.mjs`](../app/weave/test-browser.mjs)): `chromium`, or `webkit` for Playwright's WebKit, the closest stand-in for the app's WebKitGTK. Last WebKit run (October 2026): `test:browser`, `test:dynamic`, `test:desktop`, `test:editor`, `test:workspaces`, `test:tables`, `test:layout`, `test:graph`, `test:git`, `test:kanban` and the appearance suite all pass. Two engine differences the suites now allow for: clicking a toolbar button leaves focus on the button in both engines, but Chromium's Ctrl+A still selects the editor's text (it acts on the selection left inside the editor) while WebKit's selects the page, so a test focuses the editor before keyboard editing; and hidden inline-code backticks take no width, so revealing them can re-wrap a full row where the engine's font metrics put it at a wrap point, so `test:editor` picks an article width that leaves the wrapped sample room for them. |

What these do not cover: real GPUs and graphics drivers, Wayland compositors (GNOME, KDE, ChromeOS's Sommelier), the desktop file manager for **Show in folder** (it uses the `org.freedesktop.FileManager1` D-Bus service and falls back to opening the folder), and drag-and-drop from a desktop file manager. Try a new release once on a real Linux desktop and a Chromebook before announcing it.

## Platform differences

- **Interface engine.** WebKitGTK renders the same frontend. The CSP, IPC and Weave's own spell checker and find bar behave the same. Fonts fall back from Segoe UI to the desktop's `system-ui` font; Settings › Appearance labels the default font **System**.
- **Show in folder** replaces **Show in Explorer**.
- **Window placement.** On Wayland, applications cannot place their own windows, so Weave restores the window size and maximised state but the compositor chooses the position. X11 sessions restore the position too.
- **File watching** uses inotify, which needs one watch per folder. Very large workspaces can exceed `fs.inotify.max_user_watches` (often 8192 on older distros); Weave then reports that the file watcher is unavailable and keeps refreshing periodically. Raise the limit with `echo fs.inotify.max_user_watches=524288 | sudo tee /etc/sysctl.d/90-weave.conf && sudo sysctl --system`.
- **Case-sensitive file names.** Linux file systems usually distinguish `Notes.md` from `notes.md`, so links written on Windows with different capitalisation than the file show as unresolved on Linux. Weave detects each workspace's case sensitivity.
- **Git** is found on `PATH`, or in `/usr/bin`, `/usr/local/bin` or `/opt/homebrew/bin` when a launcher starts Weave with a minimal `PATH` (`sudo apt install git`).
- **Tests that need PowerShell** (the knowledge validator test) are skipped where `pwsh` is not installed.

The 11 October 2026 workspace-selection follow-up rebuilt the amd64 desktop and dedicated server offline. Native functional/geometry acceptance passed with two selected workspaces in separate locations, browser auto-load, saved selection changes, shared writes and background lifecycle. The dedicated server passed its HTTP/browser suite without a display; `ldd` lists only libc, libm, libgcc_s and the ELF loader. WebKitWebDriver's native screenshot endpoint timed out under the private Xvfb display (software rendering/compositing did not resolve it). Use `--skip-screenshots` only for diagnostics in this environment; it explicitly logs skipped native captures and retains all geometry and functional assertions. Browser captures remain enabled. arm64 and release packages were not rebuilt for this follow-up.

The 11 October 2026 authentication follow-up compiled the amd64 desktop and passed 41 offline headless Rust tests, the Linux HTTP/browser suite and the non-root container recreation test with persistent authentication. Container preparation used cached crates read-only because registry TLS failed in this build environment; production runtime stages were unchanged. Two native attempts under private Xvfb with `--skip-screenshots` timed out creating the second WebKitWebDriver session, before the authentication/server checks. Native Linux authentication acceptance therefore remains unverified; Windows native acceptance passed. Live Turnstile/TLS/proxy deployment, arm64 and release packages were not exercised. See [SERVER.md](SERVER.md) for provisioning, CLI administration and the shared security boundary.
