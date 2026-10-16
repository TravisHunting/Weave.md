#!/usr/bin/env bash
# Checks built Linux packages. Called by package-linux.sh; can be run alone:
#   bash scripts/linux/check-packages.sh <package-dir> <version> [amd64|arm64]
# 1. lintian, desktop-file-validate and appstreamcli on the package metadata.
# 2. The archive and .deb hold the expected files with the expected modes.
# 3. In clean containers (podman), the .deb installs with apt and Weave starts
#    and opens its window: Debian 12 (the base of Linux on ChromeOS),
#    Debian 13 and Ubuntu 24.04. arm64 containers run under QEMU emulation.
#    Set WEAVE_CONTAINER_IMAGES to change the list or to "" to skip.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dir="$(cd "$1" && pwd)" version="$2" arch="${3:-amd64}"
suffix=x64; [ "$arch" = arm64 ] && suffix=arm64
deb="$dir/weave_${version}_$arch.deb" tarball="$dir/Weave-$version-linux-$suffix.tar.gz"
fail() { echo "Package check failed: $*" >&2; exit 1; }

echo "--- Checksums"
(cd "$dir" && sha256sum -c SHA256SUMS)

echo "--- lintian"
# Tags suppressed on purpose: Weave has no man page or upstream changelog, its
# copyright file is plain text, and the binary embeds its own SQLite. The
# placeholder maintainer address in toolchain.env is tolerated until replaced.
. "$here/toolchain.env"
suppressed=no-manual-page,no-changelog,debian-changelog-file-missing-or-wrong-name,embedded-library,copyright-without-copyright-notice,initial-upload-closes-no-bugs,odd-historical-debian-changelog-version,unusual-documentation-package-name
case "$PACKAGE_MAINTAINER" in *@invalid\>) suppressed="$suppressed,bogus-mail-host,bogus-mail-host-in-debian-changelog" ;; esac
lintian --fail-on error --no-tag-display-limit --suppress-tags "$suppressed" "$deb"

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
dpkg-deb -x "$deb" "$work/deb"
echo "--- Desktop entry and AppStream metadata"
desktop-file-validate "$work/deb/usr/share/applications/weave.desktop"
appstreamcli validate --no-net --explain "$work/deb/usr/share/metainfo/app.weave.knowledge.metainfo.xml" || fail "AppStream metadata is invalid"

echo "--- Contents"
for path in usr/bin/weave usr/share/applications/weave.desktop usr/share/icons/hicolor/256x256/apps/weave.png \
  usr/share/metainfo/app.weave.knowledge.metainfo.xml usr/share/doc/weave/copyright usr/share/doc/weave/weave_lite.html usr/share/doc/weave/START-HERE.txt; do
  [ -f "$work/deb/$path" ] || fail ".deb is missing /$path"
done
[ -x "$work/deb/usr/bin/weave" ] || fail "/usr/bin/weave is not executable"
dpkg-deb -f "$deb" Depends | grep -q 'libwebkit2gtk-4.1-0' || fail ".deb does not depend on WebKitGTK 4.1"
tar -xzf "$tarball" -C "$work"
portable="$work/Weave-$version-linux-$suffix"
for path in weave weave_lite.html README.md START-HERE.txt THIRD-PARTY-NOTICES.txt install-desktop-entry.sh share/weave.desktop share/icon.png; do
  [ -e "$portable/$path" ] || fail "archive is missing $path"
done
[ -x "$portable/weave" ] && [ -x "$portable/install-desktop-entry.sh" ] || fail "archive executables lost their mode"
cmp -s "$portable/weave" "$work/deb/usr/bin/weave" || fail "archive and .deb hold different binaries"
grep -q '__WEAVE_EXPORT_DATA__\|"portable"' "$portable/weave" || fail "binary is missing the embedded export template"
# The portable menu entry installs into a private XDG data folder and removes cleanly.
XDG_DATA_HOME="$work/xdg" bash "$portable/install-desktop-entry.sh" >/dev/null
grep -q "^Exec=\"$portable/weave\"$" "$work/xdg/applications/weave.desktop" || fail "install-desktop-entry.sh wrote a wrong Exec line"
desktop-file-validate "$work/xdg/applications/weave.desktop"
XDG_DATA_HOME="$work/xdg" bash "$portable/install-desktop-entry.sh" --remove >/dev/null
[ ! -e "$work/xdg/applications/weave.desktop" ] || fail "install-desktop-entry.sh --remove left the entry"
echo "Contents OK."

echo "--- Install and start in clean containers"
images="${WEAVE_CONTAINER_IMAGES-debian:12 debian:13 ubuntu:24.04}"
if [ -n "$images" ] && ! command -v podman >/dev/null; then
  echo "podman is not installed: skipping container install tests (setup-build-env.sh installs it)." >&2
  images=""
fi
for image in $images; do
  echo "[$image, $arch]"
  podman --cgroup-manager=cgroupfs run --rm --arch "$arch" --network=host -v "$deb:/tmp/weave.deb:ro" -v "$here/container-smoke.sh:/tmp/container-smoke.sh:ro" \
    -v /etc/ssl/certs/ca-certificates.crt:/tmp/host-ca.crt:ro \
    "docker.io/library/$image" bash /tmp/container-smoke.sh || fail "$image could not install or start Weave"
done
echo "Package checks passed."
