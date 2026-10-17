# Developing Weave

Building, testing, packaging and benchmarking Weave. [AGENTS.md](../AGENTS.md) lists which checks each kind of change needs; [docs/WEAVE_ARCHITECTURE.md](../docs/WEAVE_ARCHITECTURE.md) explains the code.

## Requirements

Installing dependencies may use the network; builds and tests then run offline. The exact Node.js and Rust versions are pinned in [`scripts/linux/toolchain.env`](linux/toolchain.env) and used by every build machine and by the release workflow.

| Output | Build on | Tools |
| --- | --- | --- |
| All outputs | any | Node.js 24 (pinned version) with npm, Rust via [rustup](https://rustup.rs) (pinned version, `rustup default <version>`), Git |
| Windows desktop (`Weave.exe`) | Windows 10/11 x64 | Rust's `x86_64-pc-windows-msvc` toolchain; [Visual Studio 2022 Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (or Visual Studio 2022) with the **Desktop development with C++** workload, which supplies MSVC v143 and a Windows 10/11 SDK; Windows PowerShell 5.1+; the Microsoft Edge WebView2 Runtime (built into Windows 11) to run it |
| Windows server (`weave-server.exe`) | Windows 10/11 x64 | The same MSVC toolchain; no WebView2 needed |
| Linux desktop (`.deb`, `.tar.gz`) | Ubuntu 22.04 (WSL `Ubuntu-22.04` locally) | `scripts/linux/setup-build-env.sh` installs everything: compilers, GTK 3 / WebKitGTK 4.1 headers, packaging and test tools, the pinned toolchains and podman for arm64 cross-builds. [docs/LINUX.md](../docs/LINUX.md) has the details |
| Linux server (`weave-server`) | Linux, or Docker | A C compiler and `pkg-config` only (no GTK or WebKitGTK); the [Dockerfile](../Dockerfile) needs nothing but Docker or Podman |
| Browser suites | any | The repository's pinned Playwright (a devDependency) with installed Edge; `WEAVE_BROWSER=chromium` or `webkit` picks another engine (`npx playwright install chromium webkit`) |

On Windows, check the C++ tools with `rustup show` (the active toolchain must end in `-msvc`) and run builds from a normal PowerShell: Rust finds Visual Studio itself, so no developer prompt is needed.

```powershell
npm ci
```

## Everyday development

```powershell
npm run build:quick                 # Build-Debug.ps1 -Quick: debug build plus ~15-25 s of checks
.\src-tauri\target\debug\weave.exe
```

`Build-Debug.ps1` builds the desktop shell, validates embedded assets and runs an offline debug build, printing the executable path. `-Quick` adds `npm run test:quick` (unit tests minus the slow ones named in `test-quick.mjs`) and `verify-native.mjs --quick` (two launches of the new executable). Quick checks are not a release gate.

The steps it runs, if you want them individually:

```powershell
npm run build              # weave_lite.html
npm run build:desktop      # desktop page and dist/export-template.html
npm run prepare:runtime
cargo build --offline --manifest-path src-tauri/Cargo.toml --features custom-protocol
```

A read-only browser preview of any folder, bound to loopback:

```powershell
npm start -- --workspace C:\Notes
```

## Tests

```powershell
npm test                                                  # unit tests, Rust parity and Git regressions
cargo test --offline --manifest-path src-tauri/Cargo.toml
npm run test:runtime
```

Browser and integration suites (screenshots go to `test-results/`):

| Script | Covers |
|---|---|
| `test:browser`, `test:dynamic`, `test:desktop` | the reader in each mode, appearance and every skin |
| `test:workspaces` | several workspaces, tabs, split view, autosave, the packaged CSP |
| `test:editor`, `test:tables`, `test:layout` | editing, tables, line numbers and zoom |
| `test:graph`, `test:mermaid`, `test:kanban` | the graph, diagrams, boards |
| `test:git` | Git workflows against disposable repositories |
| `test:mobile` | the phone layout on a plain-HTTP origin |
| `test:server` | the HTTP server and authentication |
| `test:native -- <exe>` | a built executable, launched for real |

On Linux, run `test:native` under `bash scripts/linux/with-display.sh`.

## Packaging

Reserve packaging for distribution; it builds a portable executable, verifies it with an empty PATH and puts a fresh `weave_lite.html` beside it.

```powershell
npm run package:windows          # add -NoZip, -PrepareDependencies or -SkipChecks via the script
npm run package:windows:quick    # trial build with the quick checks, not for distribution
npm run package:linux            # .deb and .tar.gz in WSL Ubuntu-22.04 (add -- -Arm64)
npm run package:all              # Windows, then Linux amd64 and arm64
```

### Releases (GitHub Actions)

[`.github/workflows/release.yml`](../.github/workflows/release.yml) builds every package on GitHub's runners: the Windows x64 desktop and server zips, and for Linux amd64 and arm64 the desktop `.deb` and `.tar.gz` plus a server `.tar.gz`. Pushing a tag `v<version>` (matching `package.json`) runs the unit and Rust tests on Windows and Linux, builds everything and creates a **draft** release with the files and a `SHA256SUMS`; publish it after reviewing. Running the workflow by hand (Actions › Release › Run workflow) builds the same packages as workflow artifacts without a release. Linux packages use `scripts/linux/make-packages.sh` like local builds, but arm64 builds natively on `ubuntu-22.04-arm` rather than in the cross-build container, and CI skips the browser suites, native launches and clean-distro install tests, so run the full local checks before distributing.

```bash
git tag v1.0.0 && git push origin v1.0.0
```

[docs/LINUX.md](../docs/LINUX.md) records the Linux build machine and toolchain. The headless server builds with `npm run build:server:native`; see [docs/SERVER.md](../docs/SERVER.md).

## Benchmarks

Weave must stay responsive with hundreds of thousands of articles. Two benchmarks generate realistic vaults under `%TEMP%\weave-scale` (reused between runs) and check the budgets in `performance-budgets.json`:

```powershell
npm run bench:scale -- --docs 100000 --check   # backend: start-up, reads, search, writes, reindexing, memory
npm run bench:ui -- --docs 100000 --check      # the desktop page: restore, typing, search, Files, heap
```

Results land in `test-results/`. A 500,000-article vault takes about 25 minutes to generate once. [docs/PERFORMANCE.md](../docs/PERFORMANCE.md) explains the design and records measurements. For a quick search micro-benchmark, run `npm run build:test-host` then `node scripts/benchmark-native-search.mjs`.
