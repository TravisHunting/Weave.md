#!/usr/bin/env bash
# Runs inside a clean distro container (see check-packages.sh): installs the
# .deb with apt so its Depends are resolved by the distro, then starts Weave on
# a virtual display and waits for its window. Needs only /tmp/weave.deb.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
# Networks that inspect TLS need the host's CA bundle for apt's HTTPS mirrors.
[ -f /tmp/host-ca.crt ] && mkdir -p /etc/ssl/certs && cp /tmp/host-ca.crt /etc/ssl/certs/ca-certificates.crt
apt-get update -qq
apt-get install -y -qq --no-install-recommends /tmp/weave.deb xvfb xauth x11-utils >/dev/null
. /etc/os-release
echo "Installed on $PRETTY_NAME: $(dpkg-query -W -f '${Package} ${Version}' weave)"
export XDG_DATA_HOME=/tmp/data HOME=/tmp/home
mkdir -p "$HOME"
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/dev/null 2>&1 &
export DISPLAY=:99
sleep 1
weave >/tmp/weave.log 2>&1 &
pid=$!
for _ in $(seq 300); do
  if xwininfo -root -tree 2>/dev/null | grep -q '"Weave"'; then break; fi
  kill -0 "$pid" 2>/dev/null || { cat /tmp/weave.log; echo "Weave exited at startup." >&2; exit 1; }
  sleep 0.2
done
xwininfo -root -tree | grep -q '"Weave"' || { cat /tmp/weave.log; echo "Weave opened no window." >&2; exit 1; }
# The database appears once the backend starts; emulated arm64 runs are slow.
for _ in $(seq 300); do [ -f /tmp/data/Weave/.weave/weave.sqlite ] && break; sleep 0.2; done
sleep 3
kill -0 "$pid" 2>/dev/null || { cat /tmp/weave.log; echo "Weave exited after opening its window." >&2; exit 1; }
[ -f /tmp/data/Weave/.weave/weave.sqlite ] || { cat /tmp/weave.log; echo "Weave created no database." >&2; exit 1; }
kill "$pid"
echo "Weave started, opened its window and created its database."
