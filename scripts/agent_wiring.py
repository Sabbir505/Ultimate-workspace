"""Rebuild the agent_sessions wiring region: one canonical block, doc
reunification, dedup. Run from src-tauri/."""
import io
import re

MOD = r"src/agent_sessions/mod.rs"
LC = r"src/agent_sessions/lifecycle.rs"

with io.open(MOD, encoding="utf-8") as fh:
    lines = fh.read().split("\n")

# 1. Remove the orphaned ONE_SHOT_CHILDREN doc lines + every wiring line
#    (mod/use/re-export) that the carve and fix passes inserted.
orphan_start = None
for i, ln in enumerate(lines):
    if ln.startswith("/// Registry of one-shot (automation) children"):
        orphan_start = i
        break
assert orphan_start is not None

orphan_doc = []
j = orphan_start
while j < len(lines) and (lines[j].startswith("///") or lines[j].startswith("mod ")):
    if lines[j].startswith("mod "):
        break
    orphan_doc.append(lines[j])
    j += 1

drop = set()
j = orphan_start
while j < len(lines):
    ln = lines[j]
    if ln.startswith("/// Registry of one-shot"):
        drop.add(j)
    elif ln in {f"mod {n};" for n in ["tracker", "lifecycle", "primer", "attachments", "acp", "dirwatch", "bundle", "claude", "perturn", "ask", "opencode", "handlers", "oneshot"]}:
        drop.add(j)
    elif re.fullmatch(r"use (lifecycle|primer|attachments|acp|dirwatch|bundle|claude|perturn|ask|opencode|handlers|oneshot|tracker)::\*;", ln):
        drop.add(j)
    elif ln.startswith("pub use oneshot::") or ln.startswith("pub(crate) use "):
        drop.add(j)
    j += 1

lines = [ln for i, ln in enumerate(lines) if i not in drop]

# 2. Insert the canonical wiring where the orphan block was.
wiring = """mod lifecycle;
mod primer;
mod attachments;
mod acp;
mod dirwatch;
mod bundle;
mod claude;
mod perturn;
mod ask;
mod opencode;
mod handlers;
mod oneshot;
mod tracker;

use lifecycle::*;
use primer::*;
use attachments::*;
use acp::*;
use dirwatch::*;
use bundle::*;
use claude::*;
use perturn::*;
use ask::*;
use opencode::*;
use handlers::*;
use oneshot::*;
use tracker::*;

pub use oneshot::{harness_oneshot_text, run_one_shot};
pub(crate) use ask::{build_opencode_reply_answers, compose_ask_follow_up, opencode_answer_question};
pub(crate) use attachments::prepare_agent_attachments;
pub(crate) use bundle::{artifacts_dir_for_bundle, resolve_harness_bundle};
pub(crate) use dirwatch::previewable_ext;
pub(crate) use lifecycle::{kill_child_tree, kill_one_shot_children};
pub(crate) use primer::{actual_model_key, build_primer_summary, persist_actual_model};"""

lines[orphan_start:orphan_start] = wiring.split("\n")
with io.open(MOD, "w", encoding="utf-8", newline="\n") as fh:
    fh.write("\n".join(lines))
print("wiring rebuilt")

# 3. lifecycle.rs: drop the stray doc tail line and reunify the doc.
with io.open(LC, encoding="utf-8") as fh:
    lc = fh.read()
lc = lc.replace("/// const (HashMap's RandomState isn't).\npub(super) static ONE_SHOT_CHILDREN",
                "pub(super) static ONE_SHOT_CHILDREN", 1)
with io.open(LC, "w", encoding="utf-8", newline="\n") as fh:
    fh.write(lc)
print("lifecycle doc tail removed")
