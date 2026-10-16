#!/usr/bin/env bash
# Prepares an Ubuntu 22.04 machine (or WSL2 distro) to build, test and package
# Weave for Linux. Safe to re-run: every step checks what is already present.
#
#   sudo bash scripts/linux/setup-build-env.sh            # from inside Linux
#   wsl -d Ubuntu-22.04 -u root -- bash scripts/linux/setup-build-env.sh --user <name>
#   sudo bash scripts/linux/setup-build-env.sh --arm64   # also cross-build for ARM
#
# Run as root it installs the apt packages, then installs the pinned per-user
# toolchain (rustup, Node, Playwright) for the invoking user. docs/LINUX.md
# lists everything this script changes.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

target_user="${SUDO_USER:-}"
phase=all arm64=0
while [ $# -gt 0 ]; do
  case "$1" in
    --user) target_user="$2"; shift 2 ;;
    --user-phase) phase=user; shift ;;
    --arm64) arm64=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

arm64_flag=()
[ "$arm64" = 1 ] && arm64_flag=(--arm64)
if [ "$phase" = all ] && [ "$(id -u)" -ne 0 ]; then
  exec sudo bash "$0" --user "$(id -un)" "${arm64_flag[@]}"
fi

# --- System packages (root) -------------------------------------------------
if [ "$phase" = all ]; then
  [ -n "$target_user" ] && [ "$target_user" != root ] || { echo "Pass --user <name>: the toolchain is installed per user, not for root." >&2; exit 2; }
  . /etc/os-release
  if [ "$ID" != ubuntu ] || [ "$VERSION_ID" != 22.04 ]; then
    echo "Warning: release builds are made on Ubuntu 22.04; this is $PRETTY_NAME. Binaries built here need this distro's glibc or newer." >&2
  fi
  packages=(
    # Compilers and build tools
    build-essential pkg-config curl ca-certificates file xz-utils rsync git
    # Tauri 2 / WebKitGTK 4.1 development headers
    libayatana-appindicator3-dev libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev
    # Packaging and package validation
    dpkg-dev fakeroot lintian desktop-file-utils appstream
    # Headless native tests: virtual display, window manager, WebKit WebDriver, D-Bus
    xvfb xauth openbox webkit2gtk-driver dbus-x11 x11-utils
    # Clean-distro install tests of the .deb (Debian 12 as on ChromeOS, Ubuntu 24.04)
    podman uidmap slirp4netns fuse-overlayfs
    # Fonts close to the ones Chromebooks and common desktops ship
    fonts-noto-core fonts-dejavu-core
  )
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends "${packages[@]}"
  if [ "$arm64" = 1 ]; then
    # arm64 (ARM Chromebooks and laptops) is cross-compiled in the container
    # image built below; Ubuntu cannot install the arm64 WebKitGTK headers
    # beside the amd64 ones. QEMU lets podman run arm64 containers for the
    # package install test.
    apt-get install -y --no-install-recommends qemu-user-static binfmt-support
    systemctl restart systemd-binfmt 2>/dev/null || update-binfmts --enable qemu-aarch64 || true
  fi
  # Run the per-user phase as the target user, then install the system
  # libraries Playwright's test browsers need (it reads its own dependency list).
  su - "$target_user" -c "bash '$here/setup-build-env.sh' --user-phase ${arm64_flag[*]:-}"
  user_home="$(getent passwd "$target_user" | cut -d: -f6)"
  HOME="$user_home" . "$here/toolchain.env"
  node_dir="$WEAVE_LINUX_HOME/node-v$NODE_VERSION-linux-x64"
  PLAYWRIGHT_BROWSERS_PATH="$WEAVE_LINUX_HOME/ms-playwright" \
    "$node_dir/bin/node" "$WEAVE_LINUX_HOME/playwright-$PLAYWRIGHT_VERSION/node_modules/playwright/cli.js" install-deps chromium webkit
  echo "Linux build environment ready for $target_user."
  exit 0
fi

# --- Per-user toolchain -----------------------------------------------------
. "$here/toolchain.env"
mkdir -p "$WEAVE_LINUX_HOME"

# Rust, through rustup, with only the pinned toolchain.
if [ ! -x "$HOME/.cargo/bin/rustup" ]; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none --no-modify-path
fi
"$HOME/.cargo/bin/rustup" toolchain install "$RUST_VERSION" --profile minimal
"$HOME/.cargo/bin/rustup" default "$RUST_VERSION"
if [ "$arm64" = 1 ]; then
  "$HOME/.cargo/bin/rustup" target add --toolchain "$RUST_VERSION" aarch64-unknown-linux-gnu
  # The arm64 cross-compilation image (rootless podman images belong to this user).
  # cgroupfs: under su there is no systemd user session for podman to talk to.
  podman --cgroup-manager=cgroupfs build -t "$ARM64_CROSS_IMAGE" -f "$here/../../packaging/linux/arm64-cross.Containerfile" "$here/../../packaging/linux"
fi

# Node, from the official tarball, checked against the pinned SHA-256.
node_dir="$WEAVE_LINUX_HOME/node-v$NODE_VERSION-linux-x64"
if [ ! -x "$node_dir/bin/node" ]; then
  archive="$WEAVE_LINUX_HOME/node-v$NODE_VERSION-linux-x64.tar.xz"
  curl --proto '=https' --tlsv1.2 -fsSL -o "$archive" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz"
  echo "$NODE_SHA256  $archive" | sha256sum -c -
  tar -xJf "$archive" -C "$WEAVE_LINUX_HOME"
  rm "$archive"
fi

# Playwright's Chromium and WebKit test browsers (and, above, their system
# libraries). The suites themselves use the repository's pinned devDependency;
# PLAYWRIGHT_VERSION matches it so these browsers fit.
playwright="$WEAVE_LINUX_HOME/playwright-$PLAYWRIGHT_VERSION"
export PATH="$node_dir/bin:$PATH" PLAYWRIGHT_BROWSERS_PATH="$WEAVE_LINUX_HOME/ms-playwright"
# Node ships its own CA list; also trust the system store (and any root added by import-windows-root-ca.sh).
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
if [ ! -f "$playwright/node_modules/playwright/package.json" ]; then
  mkdir -p "$playwright"
  npm install --prefix "$playwright" --no-audit --no-fund --save-exact "playwright@$PLAYWRIGHT_VERSION"
fi
node "$playwright/node_modules/playwright/cli.js" install chromium webkit

echo "Toolchain: $("$HOME/.cargo/bin/rustc" -V), node $(node -v), playwright $PLAYWRIGHT_VERSION"
