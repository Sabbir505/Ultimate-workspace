"""Fix pass for the agent_sessions carve (handles all file I/O with blocks)."""
import io
import re

MOD = r"src/agent_sessions/mod.rs"
CHAIN = [
    "lifecycle", "primer", "attachments", "acp", "dirwatch", "bundle",
    "claude", "perturn", "ask", "opencode", "handlers", "oneshot",
]


def read(path):
    with io.open(path, encoding="utf-8") as fh:
        return fh.read()


def write(path, text):
    with io.open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


def main():
    s = read(MOD)

    # 1. re-imports + re-exports
    anchor = "mod tracker;"
    if "use lifecycle::*;" not in s:
        globs = "\n".join(f"use {name}::*;" for name in CHAIN)
        reexports = (
            "pub use oneshot::{harness_oneshot_text, run_one_shot};\n"
            "pub(crate) use ask::{build_opencode_reply_answers, compose_ask_follow_up, opencode_answer_question};\n"
            "pub(crate) use attachments::prepare_agent_attachments;\n"
            "pub(crate) use bundle::{artifacts_dir_for_bundle, resolve_harness_bundle};\n"
            "pub(crate) use dirwatch::previewable_ext;\n"
            "pub(crate) use lifecycle::{kill_child_tree, kill_one_shot_children};\n"
            "pub(crate) use primer::{actual_model_key, build_primer_summary, persist_actual_model};\n"
        )
        s = s.replace(anchor, f"mod tracker;\n{globs}\n{reexports}\n{anchor}", 1)
        write(MOD, s)
    print("1. mod.rs wiring ok")

    # 2. trailing-doc chain
    moved = 0
    for i in reversed(range(len(CHAIN))):
        name = CHAIN[i]
        path = rf"src/agent_sessions/{name}.rs"
        lines = read(path).split("\n")
        while lines and not lines[-1].strip():
            lines.pop()
        docs = []
        while lines and re.match(r"^\s*//", lines[-1]):
            docs.append(lines.pop())
        if not docs:
            continue
        docs.reverse()
        write(path, "\n".join(lines).rstrip() + "\n")
        moved += len(docs)
        if i + 1 < len(CHAIN):
            nxt = rf"src/agent_sessions/{CHAIN[i + 1]}.rs"
            nlines = read(nxt).split("\n")
            k = nlines.index("use super::*;") + 1
            nlines[k:k] = docs
            write(nxt, "\n".join(nlines))
        else:
            m = read(MOD)
            m = m.replace("mod tracker;", "\n".join(docs) + "\nmod tracker;", 1)
            write(MOD, m)
    print(f"2. trailing docs moved: {moved}")

    # 3. prune mod.rs head imports that are now unused
    s = read(MOD)
    for dead in [
        "use std::collections::BTreeMap;\n",
        "use std::path::PathBuf;\n",
        "use std::time::SystemTime;\n",
    ]:
        s = s.replace(dead, "", 1)
    write(MOD, s)
    print("3. head imports pruned")


main()
