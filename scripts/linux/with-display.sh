#!/usr/bin/env bash
# Runs a command on a private virtual X display with a window manager (so
# maximise, minimise and window placement behave as on a desktop) and its own
# D-Bus session. Native Linux tests use it so they never touch a real desktop.
#   bash scripts/linux/with-display.sh <command> [args...]
set -euo pipefail
for display in $(seq 90 120); do [ -e "/tmp/.X11-unix/X$display" ] || break; done
Xvfb ":$display" -screen 0 1920x1080x24 -nolisten tcp >/dev/null 2>&1 &
xvfb=$!
cleanup() { kill "${wm:-}" "$xvfb" 2>/dev/null || true; wait 2>/dev/null || true; }
trap cleanup EXIT
for _ in $(seq 50); do [ -e "/tmp/.X11-unix/X$display" ] && break; sleep 0.1; done
export DISPLAY=":$display"
# GTK would otherwise fall back to a default Wayland socket (WSLg provides one).
unset WAYLAND_DISPLAY
export GDK_BACKEND=x11
openbox >/dev/null 2>&1 &
wm=$!
sleep 0.5
dbus-run-session -- "$@"
