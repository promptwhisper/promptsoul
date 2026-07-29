#!/usr/bin/env bash
# Start a throwaway loopback Next.js process and create an unattended recording
# only after AivisSpeech and the configured voice pass the real preflight.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8765}"
RECORD_ARGS=("$@")
for ((index = 0; index < ${#RECORD_ARGS[@]}; index += 1)); do
  if [ "${RECORD_ARGS[$index]}" = "--port" ]; then
    next_index=$((index + 1))
    if [ "$next_index" -ge "${#RECORD_ARGS[@]}" ]; then
      echo "ERROR: --port requires a value" >&2
      exit 2
    fi
    PORT="${RECORD_ARGS[$next_index]}"
    index=$next_index
  fi
done
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "ERROR: PORT must be an integer from 1 to 65535" >&2
  exit 2
fi

# This check may launch AivisSpeech only when AIVIS_AUTOSTART=true. It never
# installs the application or imports a model.
npm run tts:check

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

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/promptsoul-record.XXXXXX")"
SERVER_LOG="$WORK_DIR/next.log"
./node_modules/.bin/next dev --hostname 127.0.0.1 --port "$PORT" >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  for _ in $(seq 1 20); do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      wait "$SERVER_PID" 2>/dev/null || true
      rm -rf "$WORK_DIR"
      return
    fi
    sleep 0.1
  done
  kill -KILL "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

READY=false
for _ in $(seq 1 120); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "ERROR: Next.js exited before becoming ready" >&2
    tail -n 30 "$SERVER_LOG" >&2 || true
    exit 1
  fi
  if curl --fail --silent --connect-timeout 1 --max-time 4 \
    --output /dev/null "http://127.0.0.1:$PORT/api/status"; then
    READY=true
    break
  fi
  sleep 0.5
done
if [ "$READY" != true ]; then
  echo "ERROR: Next.js did not become ready on 127.0.0.1:$PORT" >&2
  tail -n 30 "$SERVER_LOG" >&2 || true
  exit 1
fi

# record-browser repeats the aggregate health check and then requires real
# AudioContext time, non-silent RMS and changing Live2D mouth values.
PORT="$PORT" ./node_modules/.bin/tsx scripts/record-browser.ts "${RECORD_ARGS[@]}"
