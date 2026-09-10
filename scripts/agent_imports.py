"""Auto-fix: add explicit `use super::<home>::<names>;` imports to carved
agent_sessions files, driven by cargo's E0425/E0433 errors. Glob-of-glob
imports don't chain, so sibling references need explicit paths."""
import io
import re
import subprocess
from collections import defaultdict

CARVED = [
    "lifecycle", "primer", "attachments", "acp", "dirwatch", "bundle",
    "claude", "perturn", "ask", "opencode", "handlers", "oneshot",
]


def build_home_map():
    """symbol -> module (within agent_sessions) or '' for mod.rs itself."""
    home = {}
    for mod in CARVED + ["mod"]:
        path = rf"src/agent_sessions/{mod}.rs" if mod != "mod" else r"src/agent_sessions/mod.rs"
        with io.open(path, encoding="utf-8") as fh:
            for ln in fh:
                m = re.match(
                    r"(?:pub(?:\(super\)|\(crate\))? )?(?:fn|struct|enum|const|static|type) (\w+)",
                    ln,
                )
                if m:
                    home.setdefault(m.group(1), mod)
    return home


def main():
    home = build_home_map()
    for round_no in range(1, 8):
        r = subprocess.run(
            ["cargo", "check", "--lib", "--message-format=short"],
            capture_output=True, text=True,
        )
        out = r.stdout + r.stderr
        nerr = len(re.findall(r"error\[?E?\d*\]?", out)) or sum(
            1 for ln in out.splitlines() if ": error:" in ln
        )
        nerr = sum(1 for ln in out.splitlines() if ": error:" in ln or re.search(r": error\b", ln))
        per_file = defaultdict(set)
        for ln in out.splitlines():
            m = re.match(r"(src\\agent_sessions\\(\w+)\.rs):\d+:\d+: error (?:E\d+: )?cannot find (?:function|type|value) `(\w+)`", ln)
            if m:
                per_file[m.group(2)].add((m.group(3), ln))
        if not per_file:
            print(f"round {round_no}: no unresolved names; errors={nerr}")
            for ln in out.splitlines():
                if ": error:" in ln:
                    print("  ", ln[:150])
            return
        print(f"round {round_no}:")
        for fname, names in per_file.items():
            path = rf"src/agent_sessions/{fname}.rs"
            s = io.open(path, encoding="utf-8").read()
            # name -> home module
            imports = defaultdict(set)
            unresolved = set()
            for sym, _ in names:
                h = home.get(sym)
                if h is None:
                    unresolved.add(sym)
                    continue
                imports[h].add(sym)
            for h, syms in imports.items():
                use_line = f"use super::{h}::{{{', '.join(sorted(syms))}}};\n" if len(syms) > 1 else f"use super::{h}::{sorted(syms)[0]};\n"
                if use_line in s:
                    continue
                anchor = "use super::*;\n"
                s = s.replace(anchor, anchor + use_line, 1)
                print(f"  {fname}.rs += {use_line.strip()}")
            for u in unresolved:
                print(f"  UNRESOLVED: {u}")
            io.open(path, "w", encoding="utf-8", newline="\n").write(s)
    print("WARNING: did not converge in 7 rounds")


main()
