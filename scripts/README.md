# Developing Weave

Building, testing, packaging and benchmarking Weave. [AGENTS.md](../AGENTS.md) lists which checks each kind of change needs; [docs/WEAVE_ARCHITECTURE.md](../docs/WEAVE_ARCHITECTURE.md) explains the code.

## Requirements

Node.js 24+ (for its built-in SQLite), npm, Rust (MSVC on Windows) and the Visual Studio C++ build tools. Installing dependencies may use the network; builds and tests then run offline. Browser suites use the repository's pinned Playwright with installed Edge (`WEAVE_BROWSER=chromium` or `webkit` picks another engine).

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

[docs/LINUX.md](../docs/LINUX.md) records the Linux build machine and toolchain. The headless server builds with `npm run build:server:native`; see [docs/SERVER.md](../docs/SERVER.md).

## Benchmarks

Weave must stay responsive with hundreds of thousands of articles. Two benchmarks generate realistic vaults under `%TEMP%\weave-scale` (reused between runs) and check the budgets in `performance-budgets.json`:

```powershell
npm run bench:scale -- --docs 100000 --check   # backend: start-up, reads, search, writes, reindexing, memory
npm run bench:ui -- --docs 100000 --check      # the desktop page: restore, typing, search, Files, heap
```

Results land in `test-results/`. A 500,000-article vault takes about 25 minutes to generate once. [docs/PERFORMANCE.md](../docs/PERFORMANCE.md) explains the design and records measurements. For a quick search micro-benchmark, run `npm run build:test-host` then `node scripts/benchmark-native-search.mjs`.
