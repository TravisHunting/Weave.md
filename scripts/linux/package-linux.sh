#!/usr/bin/env bash
# Builds, checks and packages Weave for Linux from a clean snapshot of the
# repository. Run on the build machine prepared by setup-build-env.sh:
#
#   bash scripts/linux/package-linux.sh                  # working tree, with checks
#   bash scripts/linux/package-linux.sh --commit v1.0.0  # exactly one commit
#   bash scripts/linux/package-linux.sh --arch arm64     # ARM (cross-compiled)
#   bash scripts/linux/package-linux.sh --verify-reproducible
#
# Options:
#   --repo DIR              Repository to build (default: the one holding this script)
#   --commit REF            Build a commit instead of the working tree (uncommitted
#                           and untracked, non-ignored files included)
#   --arch amd64|arm64      Target architecture (default amd64; arm64 needs
#                           setup-build-env.sh --arm64)
#   --out DIR               Where packages go (default: <repo>/dist/linux)
#   --skip-checks           Skip unit, native and package tests
#   --verify-reproducible   Rebuild from scratch in a second target directory and
#                           require byte-identical packages
#
# Output in <out>/<version>-<tree>/: weave_<version>_<arch>.deb,
# Weave-<version>-linux-<x64|arm64>.tar.gz and SHA256SUMS (covering every
# package in the folder). docs/LINUX.md explains the layout.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/toolchain.env"

repo="$(cd "$here/../.." && pwd)" commit="" out="" checks=1 reproducible=0 arch=amd64
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="$(cd "$2" && pwd)"; shift 2 ;;
    --commit) commit="$2"; shift 2 ;;
    --arch) arch="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --skip-checks) checks=0; shift ;;
    --verify-reproducible) reproducible=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
out="${out:-$repo/dist/linux}"
step() { printf '\n=== %s\n' "$*"; }

# --- Pinned toolchain only --------------------------------------------------
node_dir="$WEAVE_LINUX_HOME/node-v$NODE_VERSION-linux-x64"
export PATH="$node_dir/bin:$HOME/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export RUSTUP_TOOLCHAIN="$RUST_VERSION"
[ "$(uname -m)" = x86_64 ] || { echo "Build on x86_64 Linux." >&2; exit 1; }
[ "$(node -v 2>/dev/null)" = "v$NODE_VERSION" ] || { echo "Node $NODE_VERSION is missing: run scripts/linux/setup-build-env.sh." >&2; exit 1; }
rustc -V | grep -q "^rustc $RUST_VERSION " || { echo "Rust $RUST_VERSION is missing: run scripts/linux/setup-build-env.sh." >&2; exit 1; }
case "$arch" in
  amd64) target=x86_64-unknown-linux-gnu suffix=x64 ;;
  arm64)
    target=aarch64-unknown-linux-gnu suffix=arm64
    if [ -z "${WEAVE_IN_CROSS_CONTAINER:-}" ]; then
      rustup target list --installed | grep -qx "$target" && podman image exists "$ARM64_CROSS_IMAGE" \
        || { echo "The arm64 cross toolchain is missing: run scripts/linux/setup-build-env.sh --arm64." >&2; exit 1; }
      # Build inside the cross image with the same home, toolchains and paths,
      # then check the packages here, where lintian and podman are available.
      step "Cross-building arm64 in $ARM64_CROSS_IMAGE"
      inner=(--arch arm64 --repo "$repo" --out "$out" --skip-checks)
      [ -n "$commit" ] && inner+=(--commit "$commit")
      [ "$reproducible" = 1 ] && inner+=(--verify-reproducible)
      mkdir -p "$out"
      mounts=(-v "$HOME:$HOME" -v "$repo:$repo" -v "$here:$here:ro" -v "$out:$out" -v /etc/ssl/certs/ca-certificates.crt:/etc/ssl/certs/ca-certificates.crt:ro)
      podman --cgroup-manager=cgroupfs run --rm --userns=keep-id --network=host -e HOME="$HOME" -e WEAVE_IN_CROSS_CONTAINER=1 "${mounts[@]}" \
        "$ARM64_CROSS_IMAGE" bash "$here/package-linux.sh" "${inner[@]}"
      read -r dest version < "$WEAVE_LINUX_HOME/last-arm64-build"
      if [ "$checks" = 1 ]; then
        step "Package checks"
        bash "$here/check-packages.sh" "$dest" "$version" arm64
      fi
      echo "Packages: $dest"
      exit 0
    fi
    # Cross-compile against the arm64 libraries installed in the cross image.
    export PKG_CONFIG_ALLOW_CROSS=1 PKG_CONFIG_SYSROOT_DIR=/ \
      PKG_CONFIG_LIBDIR=/usr/lib/aarch64-linux-gnu/pkgconfig:/usr/share/pkgconfig \
      CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
      CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc CXX_aarch64_unknown_linux_gnu=aarch64-linux-gnu-g++ ;;
  *) echo "--arch must be amd64 or arm64." >&2; exit 2 ;;
esac
. /etc/os-release
if [ "$ID" != "$BUILD_DISTRO_ID" ] || [ "$VERSION_ID" != "$BUILD_DISTRO_VERSION" ]; then
  echo "Warning: release builds are made on $BUILD_DISTRO_ID $BUILD_DISTRO_VERSION; this is $PRETTY_NAME, so the packages need its glibc or newer." >&2
fi

# --- Clean source snapshot ----------------------------------------------------
# Git normalises line endings (core.autocrlf=input) exactly as a Linux checkout
# would, so a Windows working tree and a Linux clone give the same snapshot.
git_repo() { git -c safe.directory='*' -c core.autocrlf=input -C "$repo" "$@"; }
if [ -n "$commit" ]; then
  tree="$(git_repo rev-parse "$commit^{tree}")"
  epoch="$(git_repo log -1 --format=%ct "$commit")"
else
  index="$(mktemp)"; trap 'rm -f "$index"' EXIT
  GIT_INDEX_FILE="$index" git_repo read-tree HEAD
  GIT_INDEX_FILE="$index" git_repo add -A
  tree="$(GIT_INDEX_FILE="$index" git_repo write-tree)"
  epoch="$(git_repo log -1 --format=%ct HEAD)"
fi
short="${tree:0:12}"
[ "$tree" = "$(git_repo rev-parse 'HEAD^{tree}')" ] && state="HEAD $(git_repo rev-parse --short=12 HEAD)" || state="uncommitted tree $short"
export SOURCE_DATE_EPOCH="$epoch" TZ=UTC LC_ALL=C.UTF-8
umask 022

src="$WEAVE_LINUX_HOME/src"
step "Snapshot $state into $src"
rm -rf "$src"; mkdir -p "$src"
git_repo archive --format=tar "$tree" | tar -x -C "$src"
version="$(node -p "require('$src/package.json').version")"

# Fixed paths and remapped prefixes keep machine paths out of the binary.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$WEAVE_LINUX_HOME/target}"
export RUSTFLAGS="--remap-path-prefix=$src=/weave --remap-path-prefix=$HOME/.cargo=/cargo --remap-path-prefix=$HOME/.rustup=/rustup"
export CARGO_PROFILE_RELEASE_STRIP=symbols CARGO_INCREMENTAL=0
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
export npm_config_cache="$WEAVE_LINUX_HOME/npm-cache" npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false
export PLAYWRIGHT_BROWSERS_PATH="$WEAVE_LINUX_HOME/ms-playwright"
# The suites use the repository's pinned Playwright (installed by npm ci below)
# with the test browsers setup-build-env.sh installed for the same version.
export WEAVE_BROWSER=chromium
unset WEAVE_PLAYWRIGHT
cd "$src"
pinned="$(node -p "require('./package.json').devDependencies.playwright")"
[ "$pinned" = "$PLAYWRIGHT_VERSION" ] || { echo "package.json pins playwright $pinned but toolchain.env has $PLAYWRIGHT_VERSION; update toolchain.env and rerun setup-build-env.sh." >&2; exit 1; }

step "Dependencies"
npm ci --prefer-offline
cargo fetch --locked --manifest-path src-tauri/Cargo.toml

step "Frontend"
npm run build
npm run build:desktop
npm run prepare:runtime

# Unit tests run on the build machine's own architecture; the frontend and
# Rust sources are the same for every target.
if [ "$checks" = 1 ]; then
  step "Unit and Rust tests"
  npm test
  cargo test --offline --locked --manifest-path src-tauri/Cargo.toml
  # Desktop and multi-workspace suites drive the Linux test host from Chromium.
  step "Browser suites (Playwright Chromium)"
  npm run test:desktop
  npm run test:workspaces
fi

build_binary() {
  cargo build --bin weave --release --offline --locked --target "$target" --manifest-path src-tauri/Cargo.toml --features custom-protocol
}
step "Release binary for $arch (Rust $RUST_VERSION, $target)"
build_binary
binary="$CARGO_TARGET_DIR/$target/release/weave"

if [ "$checks" = 1 ] && [ "$arch" = amd64 ]; then
  step "Native acceptance test (virtual display)"
  bash "$here/with-display.sh" node app/weave/tests/runtime-smoke.mjs "$binary"
fi

# --- Packages -----------------------------------------------------------------
dest="$out/$version-$short"
work="$WEAVE_LINUX_HOME/package-$arch"
rm -rf "$work"; mkdir -p "$work" "$dest"
bash "$here/make-packages.sh" "$src" "$binary" "$version" "$work" "$dest" "$state" "$arch"

if [ "$checks" = 1 ]; then
  step "Package checks"
  bash "$here/check-packages.sh" "$dest" "$version" "$arch"
fi

if [ "$reproducible" = 1 ]; then
  step "Reproducibility: rebuild from scratch in a second target directory"
  export CARGO_TARGET_DIR="$WEAVE_LINUX_HOME/target-verify"
  rm -rf "$CARGO_TARGET_DIR"
  build_binary
  rm -rf "$work" "$work-verify"; mkdir -p "$work" "$work-verify"
  bash "$here/make-packages.sh" "$src" "$CARGO_TARGET_DIR/$target/release/weave" "$version" "$work" "$work-verify" "$state" "$arch"
  files=("weave_${version}_$arch.deb" "Weave-$version-linux-$suffix.tar.gz")
  diff <(cd "$dest" && sha256sum -- "${files[@]}") <(cd "$work-verify" && sha256sum -- "${files[@]}") \
    || { echo "Packages differ between clean builds." >&2; exit 1; }
  rm -rf "$work-verify" "$CARGO_TARGET_DIR"
  echo "Reproducible: both clean builds produced identical packages."
fi

echo "$dest $version" > "$WEAVE_LINUX_HOME/last-$arch-build"
step "Done"
cat "$dest/SHA256SUMS"
echo "Packages: $dest"
