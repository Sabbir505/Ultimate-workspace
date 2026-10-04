"""Final live test: the app's NEW request/flag behavior end-to-end.

Mirrors exactly what the patched app does:
  - spawns the sidecar with the new arg set (--jinja --cache-reuse 256)
  - fires the warmup request (system+tools, max_tokens=1, cache_prompt:true)
  - turn 1 with the same prefix  -> should reuse the warmup prefix
  - a tool-round turn, title one-shot, then the flattened/stripped next
    turn (cache_prompt:true) -> should re-prefill only the divergence tail
Reports timings.cache_n / prompt_n / prompt_ms per request.
"""

import json
import subprocess
import threading
import time
import urllib.request

PORT = 8791
BASE = f"http://127.0.0.1:{PORT}"

SYS = " ".join(
    f"Relay system policy section {i}: " + "rule text " * 22 for i in range(120)
)
TOOL_SPEC = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Reads a file. " + "Detail " * 60,
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_shell",
            "description": "Runs a shell command. " + "Detail " * 60,
            "parameters": {
                "type": "object",
                "properties": {"command": {"type": "string"}},
                "required": ["command"],
            },
        },
    },
]

THINK = "Let me work through this. " * 3 + "".join(
    f"Step {i}: consider the aspect {i} carefully because it affects the result. "
    for i in range(60)
)
ANSWER = "Here is the summary of the analysis: " + " ".join(
    f"point {i} matters" for i in range(30)
)
U1 = "Summarize the project status."
U2 = "Now also list the risks."


def post(body, timeout=600):
    req = urllib.request.Request(
        BASE + "/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read())
    wall = time.time() - t0
    tim = data.get("timings", {}) or {}
    return {
        "wall_s": round(wall, 2),
        "prompt_n": tim.get("prompt_n"),
        "cache_n": tim.get("cache_n"),
        "prompt_ms": round(tim.get("prompt_ms") or 0),
    }


def wait_health(timeout=300):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with urllib.request.urlopen(BASE + "/health", timeout=5) as r:
                if json.loads(r.read()).get("status") == "ok":
                    return time.time() - t0
        except Exception:
            time.sleep(1)
    raise RuntimeError("server not healthy")


def main():
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--ngl", type=int, default=99)
    ap.add_argument("--ctx", type=int, default=32768)
    ap.add_argument("--label", required=True)
    ap.add_argument("flags", nargs="*")
    a = ap.parse_args()

    cmd = [
        r"C:\Users\sabbi\AppData\Roaming\dev.relay.app\bin\llama-cpp-cuda\llama-server.exe",
        "-m", a.model,
        "-c", str(a.ctx),
        "--port", str(PORT),
        "--host", "127.0.0.1",
        "--jinja",
        "--cache-reuse", "256",
        "-ngl", str(a.ngl),
    ] + a.flags
    print("SPAWN (new app args):", " ".join(cmd))
    proc = subprocess.Popen(
        cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    try:
        print(f"healthy in {wait_health():.1f}s")

        # Warmup (run_prompt_warmup): full system + tools, max_tokens=1,
        # cache_prompt — exactly what the patched warmup sends.
        r = post({
            "model": "m", "max_tokens": 1, "stream": False, "cache_prompt": True,
            "tools": TOOL_SPEC,
            "messages": [
                {"role": "system", "content": SYS},
                {"role": "user", "content": "Warmup — reply with: ok"},
            ],
        })
        print("WARMUP (system+tools, cold):                   ", r)

        # Turn 1: same prefix + the user's question.
        r = post({
            "model": "m", "max_tokens": 1, "cache_prompt": True,
            "tools": TOOL_SPEC,
            "messages": [
                {"role": "system", "content": SYS},
                {"role": "user", "content": U1},
            ],
        })
        print("T1 (warmup prefix reused?):                    ", r)

        # Turn 1's live tool loop shape (round with a tool call + result),
        # then generation of the final answer (with think).
        r = post({
            "model": "m", "max_tokens": 1, "cache_prompt": True,
            "tools": TOOL_SPEC,
            "messages": [
                {"role": "system", "content": SYS},
                {"role": "user", "content": U1},
                {
                    "role": "assistant", "content": None,
                    "tool_calls": [{
                        "id": "call_1", "type": "function",
                        "function": {"name": "read_file", "arguments": "{\"path\": \"notes.md\"}"},
                    }],
                },
                {"role": "tool", "tool_call_id": "call_1", "content": "status: on track; " + "detail " * 60},
                {"role": "assistant", "content": f"<think>{THINK}</think>{ANSWER}"},
                {"role": "user", "content": U2},
            ],
        })
        print("T2 live tool-round shape (cached prefix?):     ", r)

        # Turn 3 as the app actually re-sends history: flat assistant rows,
        # think + tool narration stripped. Should re-prefill only the tail.
        r = post({
            "model": "m", "max_tokens": 1, "cache_prompt": True,
            "tools": TOOL_SPEC,
            "messages": [
                {"role": "system", "content": SYS},
                {"role": "user", "content": U1},
                {"role": "assistant", "content": ANSWER},
                {"role": "user", "content": U2},
                {"role": "assistant", "content": ANSWER},
                {"role": "user", "content": "one more question please"},
            ],
        })
        print("T3 flattened+stripped history (the app today): ", r)

        # Background title one-shot racing the user's next turn.
        done = {}
        def bg():
            done["r"] = post({"model": "m", "max_tokens": 60, "cache_prompt": True, "messages": [
                {"role": "system", "content": "You generate a very short chat title. Reply with ONLY the title."},
                {"role": "user", "content": "Conversation:\nUser: " + U1 + "\nAssistant: " + ANSWER[:200] + "\nTitle:"},
            ]})
        th = threading.Thread(target=bg); th.start()
        time.sleep(0.2)
        r = post({
            "model": "m", "max_tokens": 1, "cache_prompt": True,
            "tools": TOOL_SPEC,
            "messages": [
                {"role": "system", "content": SYS},
                {"role": "user", "content": U1},
                {"role": "assistant", "content": ANSWER},
                {"role": "user", "content": U2},
                {"role": "assistant", "content": ANSWER},
                {"role": "user", "content": "and the timeline?"},
            ],
        })
        print("T4 while a title one-shot is in flight:        ", r)
        th.join()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    main()
