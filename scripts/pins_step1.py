"""Re-apply the round-parser pin work (lost in a git reset):
1. dev-dep tauri test feature
2. runtime-generic emit_marker/emit_chunk/emit_token in dispatch.rs
3. runtime-generic openai/anthropic_stream_round in streaming.rs
Idempotent. Run from src-tauri/."""
import io

# 1. Cargo.toml
p = r"Cargo.toml"
s = io.open(p, encoding="utf-8").read()
if 'features = ["test"]' not in s:
    anchor = '[dev-dependencies]\ntempfile = "3"'
    assert anchor in s
    s = s.replace(anchor, anchor + '\n# mock_app()/MockRuntime for unit-testing emit-path fns without a window.\ntauri = { version = "2", features = ["test"] }', 1)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("Cargo.toml updated")

# 2. dispatch.rs generics
p = r"src/chat/dispatch.rs"
s = io.open(p, encoding="utf-8").read()
changed = False
pairs = [
    ("pub(crate) fn emit_marker(app: &AppHandle, sid: &str, token: &str, full: &mut String) {",
     "pub(crate) fn emit_marker<R: tauri::Runtime>(app: &AppHandle<R>, sid: &str, token: &str, full: &mut String) {"),
    ("fn emit_chunk(app: &AppHandle, sid: &str, token: &str, full: &mut String, record: bool) {",
     "fn emit_chunk<R: tauri::Runtime>(app: &AppHandle<R>, sid: &str, token: &str, full: &mut String, record: bool) {"),
    ("pub(crate) fn emit_token(app: &AppHandle, sid: &str, token: &str, full: &mut String) {",
     "pub(crate) fn emit_token<R: tauri::Runtime>(app: &AppHandle<R>, sid: &str, token: &str, full: &mut String) {"),
]
for old, new in pairs:
    if old in s:
        s = s.replace(old, new, 1)
        changed = True
if changed:
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("dispatch.rs generics applied" if changed else "dispatch.rs already generic")

# 3. streaming.rs rounds generic
p = r"src/chat/streaming.rs"
s = io.open(p, encoding="utf-8").read()
changed = False
if "async fn openai_stream_round(" in s:
    s = s.replace("async fn openai_stream_round(\n    client: &reqwest::Client,",
                  "async fn openai_stream_round<R: tauri::Runtime>(\n    client: &reqwest::Client,", 1)
    changed = True
if "async fn anthropic_stream_round(" in s:
    s = s.replace("async fn anthropic_stream_round(\n    client: &reqwest::Client,",
                  "async fn anthropic_stream_round<R: tauri::Runtime>(\n    client: &reqwest::Client,", 1)
    changed = True
if changed:
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("streaming.rs rounds generic" if changed else "streaming.rs already generic")
