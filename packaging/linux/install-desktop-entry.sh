#!/usr/bin/env bash
# Adds this portable Weave folder to your applications menu (current user only).
#   ./install-desktop-entry.sh           add or update the menu entry
#   ./install-desktop-entry.sh --remove  remove it
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
data="${XDG_DATA_HOME:-$HOME/.local/share}"
entry="$data/applications/weave.desktop" icon="$data/icons/hicolor/256x256/apps/weave.png"
if [ "${1:-}" = --remove ]; then
  rm -f "$entry" "$icon"
  echo "Removed the Weave menu entry."
else
  mkdir -p "$(dirname "$entry")" "$(dirname "$icon")"
  cp "$here/share/icon.png" "$icon"
  # Quote the executable path as the Desktop Entry specification requires.
  exec_path="$(printf '%s' "$here/weave" | sed -e 's/\\/\\\\\\\\/g' -e 's/"/\\"/g' -e 's/`/\\`/g' -e 's/\$/\\$/g' -e 's/%/%%/g')"
  while IFS= read -r line; do
    if [ "$line" = Exec=weave ]; then printf 'Exec="%s"\n' "$exec_path"; else printf '%s\n' "$line"; fi
  done < "$here/share/weave.desktop" > "$entry"
  echo "Added Weave to the applications menu ($entry)."
fi
command -v update-desktop-database >/dev/null && update-desktop-database -q "$data/applications" || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$data/icons/hicolor" 2>/dev/null || true
