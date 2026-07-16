#!/usr/bin/env bash
# Render the WebUI in headless Chrome and screenshot each motion at its peak pose.
#
# Usage:
#   tools/verify_browser.sh                     # every PromptSoul motion + UI interaction test
#   tools/verify_browser.sh PromptSoul:0 1.4    # one motion, frozen at the given second
# Output: tmp-verify/*.png (inspect visually for expressions / poses / artifacts)
#
# The Node helper drives Chrome through the DevTools protocol. It waits for the
# model and debug hook instead of treating a loading-placeholder image as success.
# WebGL uses SwiftShader because --disable-gpu prevents Live2D initialization.
set -euo pipefail
cd "$(dirname "$0")/.."

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PORT="${PORT:-8791}"
OUT=tmp-verify
if [ $# -gt 2 ]; then
  echo "ERROR: expected at most Group:index and freeze-seconds arguments" >&2
  exit 2
fi
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "ERROR: PORT must be an integer from 1 to 65535" >&2
  exit 2
fi
if [ -L "$OUT" ]; then
  echo "ERROR: $OUT must not be a symbolic link" >&2
  exit 1
fi
mkdir -p "$OUT"
rm -f "$OUT"/*.png  # avoid mixing results from a previous run

if [ ! -x "$CHROME" ]; then
  echo "ERROR: Chrome not found: $CHROME (set the CHROME env var to override)" >&2
  exit 1
fi

# Refuse an occupied port before starting Next.js. Otherwise an old local
# server could answer the readiness request and make us verify the wrong build.
if node -e '
  const net = require("node:net");
  const socket = net.createConnection({ host: "127.0.0.1", port: Number(process.argv[1]) });
  let settled = false;
  const finish = (code) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    process.exit(code);
  };
  socket.setTimeout(1000, () => finish(0));
  socket.once("connect", () => finish(0));
  socket.once("error", (error) => finish(error.code === "ECONNREFUSED" ? 1 : 0));
' "$PORT"; then
  echo "ERROR: port $PORT is already in use; set PORT to a free loopback port" >&2
  exit 1
fi

# Throwaway Next.js server (killed on exit). This project intentionally has no
# Python runtime dependency.
./node_modules/.bin/next dev --hostname 127.0.0.1 --port "$PORT" >/dev/null 2>&1 &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  for _ in $(seq 1 20); do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      wait "$SERVER_PID" 2>/dev/null || true
      return
    fi
    sleep 0.1
  done
  kill -KILL "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT
for _ in $(seq 1 60); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "ERROR: Next.js server exited before becoming ready (is port $PORT already in use?)" >&2
    exit 1
  fi
  if curl --fail --silent --connect-timeout 1 --max-time 2 --output /dev/null "http://127.0.0.1:$PORT/"; then
    break
  fi
  sleep 0.5
done
if ! curl --fail --silent --connect-timeout 1 --max-time 2 --output /dev/null "http://127.0.0.1:$PORT/"; then
  echo "ERROR: Next.js server did not start on port $PORT" >&2
  exit 1
fi
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "ERROR: Next.js server exited after the readiness check (is port $PORT already in use?)" >&2
  exit 1
fi

if [ $# -ge 1 ]; then
  CAPTURE_ARGS=(
    --chrome "$CHROME" --port "$PORT" --out "$OUT"
    --motion "$1"
  )
  if [ $# -eq 2 ]; then
    CAPTURE_ARGS+=(--freeze "$2")
  fi
  ./node_modules/.bin/tsx scripts/capture-browser.ts "${CAPTURE_ARGS[@]}"
else
  ./node_modules/.bin/tsx scripts/capture-browser.ts \
    --chrome "$CHROME" --port "$PORT" --out "$OUT"
fi

echo "done. Inspect $OUT/*.png visually (motions applied? any artifacts, overflow or missing attribution?)."
