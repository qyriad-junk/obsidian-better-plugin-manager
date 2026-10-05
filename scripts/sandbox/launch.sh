#!/usr/bin/env bash
# Start the sandbox Obsidian under Xvfb with the Chrome DevTools Protocol on $BPM_SANDBOX_PORT (default 9222),
# wait for the workspace, and leave community plugins enabled (restricted mode off).
#
#   scripts/sandbox/launch.sh        # start (no-op if already running)
#   scripts/sandbox/launch.sh stop   # stop
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SANDBOX="${BPM_SANDBOX:-$REPO/.sandbox}"
VERSION="${OBSIDIAN_VERSION:-1.13.7}"
PORT="${BPM_SANDBOX_PORT:-9222}"
PIDFILE="$SANDBOX/obsidian.pid"

stop() {
	if [[ -f "$PIDFILE" ]]; then
		# setsid below makes the pid a process-group leader: kill Xvfb and Obsidian together.
		kill -- "-$(cat "$PIDFILE")" 2>/dev/null || true
		rm -f "$PIDFILE"
	fi
}

if [[ "${1:-}" == "stop" ]]; then
	stop
	exit 0
fi

if curl -s "localhost:$PORT/json/version" >/dev/null 2>&1; then
	echo "Already running on port $PORT."
	exit 0
fi
stop

[[ -x "$SANDBOX/obsidian-$VERSION/obsidian" ]] || "$REPO/scripts/sandbox/setup.sh"

HOME="$SANDBOX/home" XDG_CONFIG_HOME="$SANDBOX/home/.config" setsid \
	xvfb-run -a -s "-screen 0 1400x900x24" \
	"$SANDBOX/obsidian-$VERSION/obsidian" --no-sandbox --disable-gpu --remote-debugging-port="$PORT" \
	> "$SANDBOX/obsidian.log" 2>&1 < /dev/null &
echo $! > "$PIDFILE"

for _ in $(seq 1 60); do
	curl -s "localhost:$PORT/json/version" >/dev/null 2>&1 && break
	sleep 0.5
done
node "$REPO/scripts/sandbox/obsidian.mjs" trust
echo "Obsidian $VERSION running (CDP port $PORT, log $SANDBOX/obsidian.log)."
