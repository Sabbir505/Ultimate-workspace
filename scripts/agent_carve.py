"""Carve agent_sessions/mod.rs into domain child modules. Slices are
contiguous; each child does `use super::*` (inheriting the parent's imports
and private helpers), items become pub(super), and mod.rs glob-reimports
them so all call sites are unchanged. Run from src-tauri/."""
import io
import re

p = r"src/agent_sessions/mod.rs"
lines = io.open(p, encoding="utf-8").read().split("\n")

# (name, start_line_1based, end_line_1based_exclusive)
CARVES = [
    ("lifecycle", 868, 1016),
    ("primer", 1016, 1329),
    ("attachments", 1329, 1461),
    ("acp", 1461, 2123),
    ("dirwatch", 2123, 2446),
    ("bundle", 2446, 2612),
    ("claude", 2612, 3620),
    ("perturn", 3620, 4201),
    ("ask", 4201, 4522),
    ("opencode", 4522, 5515),
    ("handlers", 5515, 6193),
    ("oneshot", 6193, 7074),
]

DESCRIPTIONS = {
    "lifecycle": "one-shot child registry + guards, reader-alive guard, and CLI session-id persistence",
    "primer": "context-primer assembly (history tail/head, summaries) and per-session actual-model persistence",
    "attachments": "agent attachment preparation: decode, sanitize, and write to the artifacts dir",
    "acp": "Claude/ACP turn dispatch and the ACP JSON stream reader",
    "dirwatch": "per-turn directory watching: snapshots, change previews, and path allow-listing",
    "bundle": "harness bundle/context resolution (opencode config, gallery servers, context sections)",
    "claude": "Claude Code spawn, permission/can-use-tool + ask-user question handling, and read_claude_stream",
    "perturn": "per-turn harness spawn (kimi/pi/opencode/commandcode) and read_per_turn_stream",
    "ask": "RELAY_ASK question channel: parsing, repair, follow-up composition, and surfacing",
    "opencode": "opencode turn dispatch, server lifecycle, SSE reader, and tool emission",
    "handlers": "per-harness event handlers (kimi/opencode/pi/commandcode) + subagent spawn/usage helpers",
    "oneshot": "run_one_shot: the automation engine's self-contained blocking turn",
}

# Sort so removal works back-to-front without shifting later ranges.
for name, start, end in sorted(CARVES, key=lambda c: -c[1]):
    sl = lines[start - 1 : end - 1]
    body = "\n".join(sl).rstrip() + "\n"

    # Top-level private items become pub(super).
    body = re.sub(r"^(fn |struct |enum |const |static |type )", r"pub(super) \1", body, flags=re.M)
    # Inherent impl methods become pub(super) too…
    body = re.sub(r"(?m)^    fn ", "    pub(super) fn ", body)
    # …but trait-impl methods (Drop::drop) must keep no visibility.
    body = body.replace("    pub(super) fn drop(", "    fn drop(")

    header = (
        f"//! {DESCRIPTIONS[name]} — extracted carve of agent_sessions (see\n"
        f"//! mod.rs). `use super::*` inherits the parent's imports and private\n"
        f"//! helpers; items are pub(super) and glob-reimported by the parent.\n"
        f"use super::*;\n\n"
    )
    io.open(rf"src/agent_sessions/{name}.rs", "w", encoding="utf-8", newline="\n").write(
        header + body
    )

# Remove carved ranges back-to-front and splice the module wiring.
wiring = "\n".join(
    f"mod {name};" for name, _, _ in sorted(CARVES, key=lambda c: c[1])
)
for name, start, end in sorted(CARVES, key=lambda c: -c[1]):
    lines[start - 1 : end - 1] = []
# Insert the wiring where the tracker wiring sits (end of the file's own
# sections, before shared emit/persist).
idx = next(
    i
    for i, ln in enumerate(lines)
    if ln.startswith("pub(crate) use tracker::tool_meta_generic;")
)
lines[idx:idx] = wiring.split("\n") + [""]
io.open(p, "w", encoding="utf-8", newline="\n").write("\n".join(lines))
print("carved:", ", ".join(name for name, _, _ in CARVES))
