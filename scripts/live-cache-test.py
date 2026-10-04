"""Live experiment: llama-server prompt-cache behavior under Relay's request shapes.

Phase A (baseline): spawn with the app's current flags, replay a realistic
turn sequence (big system+tools prefix -> turn 1 -> title one-shot -> turn 2)
and report timings.cache_n / timings.prompt_n / prompt_ms per request.

Phase B: same sequence against a server started with the candidate flags
(--parallel / --cache-reuse / --kv-unified) to compare.

Every request uses max_tokens=1 so the measurement is pure prefill.
"""

import json
import subprocess
import time
import urllib.request
import urllib.error

PORT = 8791
BASE = f"http://127.0.0.1:{PORT}"

# ~2.5k tokens of filler so the prefix is meaningful but each prefill stays
# a few seconds on the 1660 Ti.
FILLER = ("You are Relay, a desktop assistant. ".join([""] * 8)).join(
    ["Relay system policy section %d: " % i + "rule text " * 24 for i in range(40)]
)
TOOLS_SPEC = [
    {
        "type": "function",
        "function": {
            "name": f"tool_{i}",
            "description": "Does thing %d. " % i + "Detail " * 40,
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}, "q": {"type": "string"}},
            },
        },
    }
    for i in range(12)
]


def post(path, body, timeout=600):
    req = urllib.request.Request(
        BASE + path,
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
        "predicted_n": tim.get("predicted_n"),
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
    raise RuntimeError("server not healthy in time")


def slots():
    try:
        with urllib.request.urlopen(BASE + "/slots", timeout=10) as r:
            return json.loads(r.read())
    except Exception as e:
        return {"error": str(e)}


def run_sequence(label):
    print(f"\n===== {label} =====")
    big_system = FILLER

    r = post(
        "/v1/chat/completions",
        {
            "model": "test",
            "max_tokens": 1,
            "messages": [
                {"role": "system", "content": big_system},
                {"role": "user", "content": "What is 2+2? Answer with just the number."},
            ],
        },
    )
    print("T1 (system+user, cold):        ", r)

    r = post(
        "/v1/chat/completions",
        {
            "model": "test",
            "max_tokens": 1,
            "messages": [
                {"role": "system", "content": big_system},
                {"role": "user", "content": "What is 2+2? Answer with just the number."},
                {"role": "assistant", "content": "4"},
                {"role": "user", "content": "And 3+3?"},
            ],
        },
    )
    print("T2 (prefix reused, warm):      ", r)

    r = post(
        "/v1/chat/completions",
        {
            "model": "test",
            "max_tokens": 1,
            "messages": [
                {"role": "system", "content": "You generate a very short chat title (3 to 6 words). Reply with ONLY the title."},
                {"role": "user", "content": "Conversation:\nUser: What is 2+2?\nAssistant: 4\nTitle:"},
            ],
        },
    )
    print("TITLE one-shot (evicts slot):  ", r)

    r = post(
        "/v1/chat/completions",
        {
            "model": "test",
            "max_tokens": 1,
            "messages": [
                {"role": "system", "content": big_system},
                {"role": "user", "content": "What is 2+2? Answer with just the number."},
                {"role": "assistant", "content": "4"},
                {"role": "user", "content": "And 3+3?"},
                {"role": "assistant", "content": "6"},
                {"role": "user", "content": "And 5+5?"},
            ],
        },
    )
    print("T3 (after title one-shot):     ", r)

    # Divergence salvage: same as T3 but one middle assistant text changed
    # (simulates think-strip / elision rewriting the middle).
    r = post(
        "/v1/chat/completions",
        {
            "model": "test",
            "max_tokens": 1,
            "messages": [
                {"role": "system", "content": big_system},
                {"role": "user", "content": "What is 2+2? Answer with just the number."},
                {"role": "assistant", "content": "FOUR (changed text after edit)"},
                {"role": "user", "content": "And 3+3?"},
                {"role": "assistant", "content": "6"},
                {"role": "user", "content": "And 7+7?"},
            ],
        },
    )
    print("T4 (diverged middle, reuse?):  ", r)

    s = slots()
    if isinstance(s, list):
        summary = [
            {
                "id": sl.get("id"),
                "is_processing": sl.get("is_processing"),
                "ctx": sl.get("n_ctx"),
                "prompt_head": (sl.get("prompt") or "")[:60].replace("\n", " "),
            }
            for sl in s
        ]
        print("SLOTS:", json.dumps(summary, indent=1))
    else:
        print("SLOTS unavailable:", s)


def main():
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--ngl", type=int, default=99)
    ap.add_argument("--ctx", type=int, default=16384)
    ap.add_argument("--label", required=True)
    ap.add_argument("flags", nargs="*", help="extra llama-server flags")
    a = ap.parse_args()

    cmd = [
        r"C:\Users\sabbi\AppData\Roaming\dev.relay.app\bin\llama-cpp-cuda\llama-server.exe",
        "-m", a.model,
        "-c", str(a.ctx),
        "--port", str(PORT),
        "--host", "127.0.0.1",
        "--jinja",
        "-ngl", str(a.ngl),
    ] + a.flags
    print("SPAWN:", " ".join(cmd))
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
    )
    try:
        load_s = wait_health()
        print(f"healthy in {load_s:.1f}s")
        run_sequence(a.label)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    main()
