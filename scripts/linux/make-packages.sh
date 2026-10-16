#!/usr/bin/env bash
# Assembles the .deb and portable .tar.gz from a built source tree and binary.
# Called by package-linux.sh, which sets SOURCE_DATE_EPOCH, TZ and umask.
#   make-packages.sh <src> <binary> <version> <work-dir> <output-dir> <source-state> <amd64|arm64>
set -euo pipefail
src="$1" binary="$2" version="$3" work="$4" dest="$5" state="$6" arch="$7"
: "${SOURCE_DATE_EPOCH:?package-linux.sh sets SOURCE_DATE_EPOCH}"
. "$(dirname "${BASH_SOURCE[0]}")/toolchain.env"
packaging="$src/packaging/linux"
case "$arch" in
  amd64) suffix=x64 machine="x86-64 (Intel or AMD)" ;;
  arm64) suffix=arm64 machine="64-bit ARM (arm64)" ;;
  *) echo "Unknown architecture: $arch" >&2; exit 2 ;;
esac

# Normalise what tar and dpkg-deb record: modes, owners and timestamps.
normalise() {
  find "$1" -type d -exec chmod 0755 {} +
  find "$1" -type f -exec chmod 0644 {} +
  for executable in "${@:2}"; do chmod 0755 "$executable"; done
  find "$1" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
}

notices() {
  for package in nspell dictionary-en dictionary-en-gb; do
    printf '===== %s =====\n' "$package"
    cat "$src/node_modules/$package/license"
    printf '\n\n'
  done
}

start_here() {
  cat <<EOF
Weave $version for Linux $suffix

$1

Requirements: a $machine Linux desktop with GTK 3 and WebKitGTK 4.1, such as
Ubuntu 22.04 or newer, Debian 12 or newer (including Linux on ChromeOS),
Linux Mint 21+, Pop!_OS 22.04+, Fedora 38+ or a current Arch Linux.
Git is optional and installed separately; it enables each workspace's Git section.

Open a Markdown workspace using Open workspace. No folder opens automatically.
Application data defaults to \$XDG_DATA_HOME/Weave/.weave (normally
~/.local/share/Weave/.weave). Change its location in Settings; the full folder
moves on the next launch.
Search uses chunk-based SQLite FTS5/BM25. No models or downloads are used.
weave_lite.html is Weave Lite: open it in a web browser and choose a Markdown
folder to read it, with nothing installed.
If the window stays blank (some virtual machines and graphics drivers), start
Weave with WEBKIT_DISABLE_DMABUF_RENDERER=1 weave
See README.md for an overview; docs/USER_GUIDE.md in the source repository covers recovery and first-run details, and scripts/README.md development.
Built from $state.
EOF
}

# --- Debian package -------------------------------------------------------------
deb="$work/deb"
mkdir -p "$deb/DEBIAN" "$deb/usr/bin" "$deb/usr/share/applications" "$deb/usr/share/metainfo" \
  "$deb/usr/share/icons/hicolor/256x256/apps" "$deb/usr/share/doc/weave/docs"
install -m 0755 "$binary" "$deb/usr/bin/weave"
cp "$packaging/weave.desktop" "$deb/usr/share/applications/weave.desktop"
cp "$packaging/app.weave.knowledge.metainfo.xml" "$deb/usr/share/metainfo/app.weave.knowledge.metainfo.xml"
cp "$src/src-tauri/icons/icon.png" "$deb/usr/share/icons/hicolor/256x256/apps/weave.png"
doc="$deb/usr/share/doc/weave"
cp "$src/README.md" "$src/weave_lite.html" "$doc/"
cp "$src/docs/WEAVE_ARCHITECTURE.md" "$src/docs/PERFORMANCE.md" "$doc/docs/"
start_here "Start Weave from the applications menu, or run weave in a terminal.
Weave Lite is installed at /usr/share/doc/weave/weave_lite.html." > "$doc/START-HERE.txt"
{
  echo "Weave, copyright $PACKAGE_COPYRIGHT. No licence has been published for Weave itself."
  echo "Weave embeds the third-party data below; their notices follow."
  echo
  notices
} > "$doc/copyright"
printf 'weave (%s) stable; urgency=medium\n\n  * Release %s.\n\n -- %s  %s\n' \
  "$version" "$version" "$PACKAGE_MAINTAINER" "$(date -u -d "@$SOURCE_DATE_EPOCH" -R)" | gzip -9n > "$doc/changelog.gz"

# Library dependencies are read from the binary itself, with minimum versions.
shlibs="$work/shlibs"; mkdir -p "$shlibs/debian"
printf 'Source: weave\n\nPackage: weave\nArchitecture: %s\n' "$arch" > "$shlibs/debian/control"
depends="$(cd "$shlibs" && DEB_HOST_ARCH="$arch" dpkg-shlibdeps -O -e "$deb/usr/bin/weave" 2>/dev/null | sed -n 's/^shlibs:Depends=//p')"
[ -n "$depends" ] || { echo "dpkg-shlibdeps found no dependencies." >&2; exit 1; }
size="$(du -sk --exclude=DEBIAN "$deb" | cut -f1)"
cat > "$deb/DEBIAN/control" <<EOF
Package: weave
Version: $version
Architecture: $arch
Maintainer: $PACKAGE_MAINTAINER
Installed-Size: $size
Depends: $depends, libayatana-appindicator3-1
Recommends: git
Section: editors
Priority: optional
Homepage: $PACKAGE_HOMEPAGE
Description: local Markdown knowledge workspace
 Weave reads, links and searches folders of Open Knowledge Format Markdown,
 with typed links, a relationship graph, SQLite FTS5 search, split view,
 Kanban boards kept in frontmatter and built-in Git.
EOF
normalise "$deb" "$deb/usr/bin/weave"
deb_file="weave_${version}_$arch.deb"
dpkg-deb --root-owner-group -Zxz -z9 --build "$deb" "$dest/$deb_file" >/dev/null

# --- Portable archive ---------------------------------------------------------
name="Weave-$version-linux-$suffix"
portable="$work/$name"
mkdir -p "$portable/docs" "$portable/share"
install -m 0755 "$binary" "$portable/weave"
cp "$src/README.md" "$src/weave_lite.html" "$portable/"
cp "$src/docs/WEAVE_ARCHITECTURE.md" "$src/docs/PERFORMANCE.md" "$portable/docs/"
cp "$packaging/weave.desktop" "$src/src-tauri/icons/icon.png" "$portable/share/"
install -m 0755 "$packaging/install-desktop-entry.sh" "$portable/install-desktop-entry.sh"
notices > "$portable/THIRD-PARTY-NOTICES.txt"
start_here "Run ./weave from this folder. ./install-desktop-entry.sh adds Weave to your
applications menu (for your user only, pointing at this folder); run it with
--remove to take it out again. On Debian, Ubuntu and ChromeOS the .deb package
installs Weave and its dependencies in one step instead." > "$portable/START-HERE.txt"
normalise "$portable" "$portable/weave" "$portable/install-desktop-entry.sh"
tar --sort=name --mtime="@$SOURCE_DATE_EPOCH" --owner=0 --group=0 --numeric-owner \
  --pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime \
  -C "$work" -cf - "$name" | gzip -9n > "$dest/$name.tar.gz"

# One checksum file covers every package in the folder (both architectures).
(cd "$dest" && sha256sum -- $(ls weave_*.deb Weave-*.tar.gz | LC_ALL=C sort) > SHA256SUMS)
