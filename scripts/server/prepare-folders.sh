#!/bin/sh
# Prepares host folders for Weave Server in Docker and writes
# compose.override.yaml so the container uses them instead of named volumes.
#
#   scripts/server/prepare-folders.sh [--workspaces DIR] [--data DIR] [--force]
#
# Defaults: ./weave/workspaces and ./weave/data beside compose.yaml. The
# container runs as UID/GID 10001, so both folders are given to that owner
# (with sudo when needed, or through the Weave image when sudo is missing).
# Existing Markdown folders can be passed with --workspaces; each direct child
# folder becomes a workspace. Keep the data folder private: it holds accounts,
# indexes and Git deploy keys.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
workspaces="$root/weave/workspaces"
data="$root/weave/data"
force=0
while [ $# -gt 0 ]; do
  case "$1" in
    --workspaces) workspaces=$2; shift 2 ;;
    --data) data=$2; shift 2 ;;
    --force) force=1; shift ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

mkdir -p "$workspaces" "$data"
workspaces=$(CDPATH= cd -- "$workspaces" && pwd)
data=$(CDPATH= cd -- "$data" && pwd)
case "$data/" in "$workspaces/"*) echo "The data folder must not be inside the workspaces folder." >&2; exit 1 ;; esac
case "$workspaces/" in "$data/"*) echo "The workspaces folder must not be inside the data folder." >&2; exit 1 ;; esac

owner() {
  if [ "$(uname -s)" != Linux ]; then
    return 0 # Docker Desktop (macOS) maps file ownership itself.
  fi
  if [ "$(id -u)" = 0 ]; then
    chown -R 10001:10001 "$workspaces" "$data"
  elif command -v sudo >/dev/null 2>&1; then
    echo "Giving the folders to the container user (UID 10001); sudo may ask for your password."
    sudo chown -R 10001:10001 "$workspaces" "$data"
  else
    image=${WEAVE_IMAGE:-weave-server:local}
    echo "sudo is unavailable; using the $image image to change ownership."
    docker run --rm --user 0 --entrypoint chown -v "$workspaces:/workspaces" -v "$data:/data" "$image" -R 10001:10001 /workspaces /data
  fi
  chmod 700 "$data" 2>/dev/null || sudo chmod 700 "$data" 2>/dev/null || true
}
owner

override="$root/compose.override.yaml"
if [ -e "$override" ] && [ "$force" != 1 ]; then
  echo "$override already exists; left unchanged (use --force to replace it)."
else
  cat > "$override" <<EOF
# Written by scripts/server/prepare-folders.sh: host folders replace the named volumes.
services:
  weave:
    volumes: !override
      - "$workspaces:/workspaces"
      - "$data:/data"
EOF
  echo "Wrote $override"
fi

cat <<EOF

Folders ready:
  workspaces  $workspaces   (each direct child folder is a workspace)
  data        $data   (private: accounts, indexes, Git deploy keys)

Start Weave:   docker compose up -d --build
Then open http://localhost:${WEAVE_PORT:-8765} and create the administrator account.
EOF
