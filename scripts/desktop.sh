#!/usr/bin/env bash
# Run a command inside a throwaway headless desktop: an Xvfb display, a private D-Bus session
# bus, and (activated on demand) the AT-SPI accessibility bus. Nothing touches your real session.
#
#   scripts/desktop.sh node --test test/integration/*.test.ts
#   scripts/desktop.sh bash          # poke around interactively
#
# Needs: Xvfb, dbus-daemon and at-spi2-core.
set -euo pipefail

for tool in Xvfb dbus-daemon; do
  command -v "$tool" >/dev/null || { echo "desktop.sh: $tool is not installed" >&2; exit 127; }
done

display=${NORTHBRIDGE_DISPLAY:-}
if [ -z "$display" ]; then
  for n in $(seq 90 199); do
    if [ ! -e "/tmp/.X${n}-lock" ] && [ ! -e "/tmp/.X11-unix/X${n}" ]; then display=":$n"; break; fi
  done
fi
[ -n "$display" ] || { echo "desktop.sh: no free display number" >&2; exit 1; }

workdir=$(mktemp -d "${TMPDIR:-/tmp}/northbridge-desktop.XXXXXX")
xvfb_pid=
dbus_pid=
cleanup() {
  [ -n "$dbus_pid" ] && kill "$dbus_pid" 2>/dev/null || true
  [ -n "$xvfb_pid" ] && kill "$xvfb_pid" 2>/dev/null || true
  rm -rf "$workdir"
}
trap cleanup EXIT

Xvfb "$display" -screen 0 "${NORTHBRIDGE_SCREEN:-1280x800x24}" -nolisten tcp >"$workdir/xvfb.log" 2>&1 &
xvfb_pid=$!
for _ in $(seq 1 100); do
  [ -e "/tmp/.X11-unix/X${display#:}" ] && break
  kill -0 "$xvfb_pid" 2>/dev/null || { cat "$workdir/xvfb.log" >&2; exit 1; }
  sleep 0.05
done

# A clean, quiet environment: no animations, settings in memory, a private runtime dir.
mkdir -p "$workdir/runtime" "$workdir/config/gtk-3.0" "$workdir/config/gtk-4.0"
chmod 700 "$workdir/runtime"
printf '[Settings]\ngtk-enable-animations=false\n' | tee "$workdir/config/gtk-3.0/settings.ini" >"$workdir/config/gtk-4.0/settings.ini"

export DISPLAY="$display"
export XDG_RUNTIME_DIR="$workdir/runtime"
export XDG_CONFIG_HOME="$workdir/config"
export GSETTINGS_BACKEND=memory
unset WAYLAND_DISPLAY XDG_SESSION_TYPE DBUS_SESSION_BUS_ADDRESS NO_AT_BRIDGE
export NORTHBRIDGE_HEADLESS_DESKTOP=1

# A private session bus; the AT-SPI bus launcher is started from it on first use.
dbus-daemon --session --nofork --address="unix:path=$workdir/bus" >"$workdir/dbus.log" 2>&1 &
dbus_pid=$!
for _ in $(seq 1 100); do
  [ -S "$workdir/bus" ] && break
  kill -0 "$dbus_pid" 2>/dev/null || { cat "$workdir/dbus.log" >&2; exit 1; }
  sleep 0.05
done
export DBUS_SESSION_BUS_ADDRESS="unix:path=$workdir/bus"

status=0
"$@" || status=$?
exit "$status"
