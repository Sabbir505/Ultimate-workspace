#!/usr/bin/env bash
# Start a real llama-server and run the live end-to-end tests for the
# local-model log + gateway (src-tauri/src/llm_log/live_tests.rs).
#
# Those tests are not mocks: they bind a real gateway socket in front of a
# real llama.cpp server, stream a real completion through it, and assert the
# bytes came back unchanged and were logged. Without a server up they skip,
# which is why this exists — a skipped test proves nothing.
#
# Usage (Git Bash / WSL):
#   scripts/live-llm-log-test.sh
#
# Override the binary, model or port if yours live elsewhere:
#   LLAMA_SERVER=/d/llama.cpp/llama-server.exe \
#   MODEL="/d/local models/models/MiniCPM5-2B-GGUF/MiniCPM5-2B-Q8_0.gguf" \
#   PORT=18080 UPSTREAM_KEY=whatever scripts/live-llm-log-test.sh

set -euo pipefail

PORT="${PORT:-18080}"
# Must match LIVE_UPSTREAM in live_tests.rs.
UPSTREAM_KEY="${UPSTREAM_KEY:-testtoken123}"

LLAMA_SERVER="${LLAMA_SERVER:-}"
MODEL="${MODEL:-}"

# Fall back to the common local build layout when not told otherwise.
if [[ -z "$LLAMA_SERVER" ]]; then
  for cand in /d/llama.cpp/llama-server.exe /c/llama.cpp/llama-server.exe; do
    [[ -x "$cand" ]] && LLAMA_SERVER="$cand" && break
  done
fi
# A 2B model keeps the round trip quick enough to sit in a test loop.
if [[ -z "$MODEL" ]]; then
  for cand in \
    "/d/local models/models/MiniCPM5-2B-GGUF/MiniCPM5-2B-Q8_0.gguf" \
    "/d/local models/models/Ling-3.0-tiny/Ling-3.0-tiny-Q4_K_M.gguf"; do
    [[ -f "$cand" ]] && MODEL="$cand" && break
  done
fi

if [[ ! -x "$LLAMA_SERVER" ]]; then
  echo "error: no llama-server binary. Set LLAMA_SERVER=/path/to/llama-server" >&2
  exit 1
fi
if [[ ! -f "$MODEL" ]]; then
  echo "error: no GGUF model found. Set MODEL=/path/to/model.gguf" >&2
  exit 1
fi

echo "llama-server : $LLAMA_SERVER"
echo "model        : $MODEL"
echo "port         : $PORT"

# llama.cpp loads its DLLs from its own directory on Windows, so run from there.
cd "$(dirname "$LLAMA_SERVER")"

./"$(basename "$LLAMA_SERVER")" \
  --model "$MODEL" \
  --port "$PORT" \
  --host 127.0.0.1 \
  -c 4096 \
  --jinja \
  --api-key "$UPSTREAM_KEY" \
  > /tmp/llama-server-live.log 2>&1 &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Wait for readiness rather than sleeping a fixed amount — a cold model load
# on a spinning disk can take well over a minute.
echo -n "waiting for /health"
for _ in $(seq 1 240); do
  if curl -fsS -m 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo " — ready"
    break
  fi
  echo -n "."
  sleep 1
done

if ! curl -fsS -m 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo
  echo "error: server never became healthy; see /tmp/llama-server-live.log" >&2
  exit 1
fi

cd "$(dirname "$0")/../src-tauri"
cargo test --lib llm_log -- --nocapture
