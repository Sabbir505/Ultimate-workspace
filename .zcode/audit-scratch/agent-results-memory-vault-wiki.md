# Agent findings: memory/vault/wiki (21 files)
# Status: COMPLETE — verified result captured 2026-10-02 19:20

FILES COVERED: src-tauri/src/memory/*, src-tauri/src/vault/*, src-tauri/src/wiki/*, docs_index.rs, docs_watcher.rs, improve_engine.rs (cross-checks into db/memory.rs, db/wiki.rs, chat/docs.rs, chat/local_models.rs, util.rs).

Notably solid (verified): `safe_join` blocks every traversal form (Windows drive letters, dot-dirs, symlink canonicalization); `atomic_write` fsyncs before rename; `rename_note_core` rolls back rewrites on every failure path; memory cursor monotonic; judge target-ids validated; FTS query strings sanitized in memories/wiki/vault; parse.rs/render.rs slicing char-boundary-safe.

## P0

None verified.

## P1

**1. docs_watcher: file changes arriving during an in-flight index run are consumed and permanently dropped — corpus index silently stale.**
- docs_watcher.rs:113-119 (debounce drains events), :205-225 — when `spawn_index_job` refuses because the corpus is already indexing, the watcher just logs and drops (`eprintln!("[docs_watcher] skip corpus {}: {e}")`); docs_index.rs:455-457 returns Err("indexing already in progress"). Index runs take minutes (embedding), so saving files mid-run fires debounced events the loop consumes; the spawn is refused; the events are gone — no re-arm, no dirty flag. The saved files' chunks stay stale (search_docs / auto-retrieval serve old content) until an unrelated later event or manual Index. Fix: on "already in progress", set a per-corpus `pending` flag in DocsWatcherState that the `SlotLease` drop / finish block checks and re-spawns.

**2. docs_index::spawn_index_job runs a model-folder filesystem walk (GGUF header parsing) while holding the global DB mutex — on every index spawn, including watcher fires.**
- docs_index.rs:467-496: `find_embedding_gguf` (:149-186) and `caption_base_url` → `local_models::scan_folder` (local_models.rs:371-410) do walkdir over all model dirs + `parse_gguf` (opens/reads each GGUF header) under `db.lock()`. DbState is the single shared connection every command/chat persist uses; violates the stated rule ("never hold the DB mutex across file IO", vault/mod.rs:172-175). `caption_base_url` runs even when the sidecar is up — on **every watcher-triggered reindex**. Fix: resolve the corpus row under the lock, run the walks lock-free (both take &Connection only for settings — pass the two strings out), re-lock only for the insert.

## P2

**3. Vault index never indexes non-md assets despite its schema contract — `![[img.png]]` embeds permanently "unresolved".**
- vault/index.rs:23-24 claims "notes AND linkable assets", but `collect_note_paths` (:583) keeps only .md and the watcher reindexes only .md (vault/mod.rs:873). Every image/pdf embed counts as unresolved (inflating stats.unresolved, note_meta.unresolved_mentions); the graph's `include_attachments` toggle (:997-1035) is dead. Fix: index asset metadata rows on watcher Create events, or fix the contract + exclude embed-kind links from unresolved stats.

**4. Vault search: negated operators (`-tag:x`, `-path:x`, `-file:x`) degrade to a literal text exclusion that excludes nothing.**
- vault/index.rs:683-691: a negated `tag:work` falls into the generic arm pushing `"tag:work"` into `not`, which the exclusion pass (:724-734) runs as an FTS phrase — matching bodies containing that literal text, never the tagged notes. `-tag:work` silently fails to exclude tagged notes (Obsidian semantics exclude). Fix: explicit negate arms collecting excluded paths from vault_tags (case-insensitive).

**5. `rename_note_core` rewrites wikilinks inside fenced code blocks — the parser is fence-aware, the rewriter is not.**
- vault/parse.rs:688-776 (`rewrite_inbound_links`) processes every line with only `mask_inline_code`, no `in_fence` tracking, while `parse_note` (:118-141) deliberately refuses fenced content ("code-fence awareness is the one correctness trap that matters", parse.rs:8-10). A code sample containing `[[Old Name]]` gets silently rewritten on rename. Fix: thread the fence-toggle through the rewriter.

**6. Wiki `.git` watchers never uninstalled — `wiki_remove` (and project deletion) leak a kernel watcher per removed wiki for the app session.**
- wiki/commands.rs:163-174 deletes DB rows but never touches `WikiGitWatchState.watchers`; no removal API exists (wiki/mod.rs:1969-1972); db/projects.rs:98 delete path doesn't either. Every commit in a removed repo still wakes the freshness loop; the notify handle stays resident until restart. Fix: `uninstall_wiki_git_watcher(app, root)` called from wiki_remove and project deletion.

**7. improve_engine regression gate dilutes judge scores by dividing by total case count — real judge regressions can pass.**
- improve_engine.rs:611-618: `n = outcomes.len()` counts all cases but scores exist only on `judge: true` cases; with 5 cases / 1 judge-scored, a full 1-point regression (5→4) yields diff 1/5 = 0.2 < 0.3 → `score_ok` passes, contradicting the documented gate ("judge average ≥ champion − 0.3", :605). Fix: average over scored cases only; skip the gate when none have scores.

**8. docs `run_index` does the corpus walk and per-file reads synchronously on the tokio async worker.**
- docs_index.rs:637 (`docs::walk_corpus`), :691 (`std::fs::read_to_string`) directly in the async task — every other subsystem offloads this (wiki/vault use spawn_blocking). A 20k-file walk stalls a worker for seconds. Fix: spawn_blocking the walk + reads.

**9. A manual Index against an unreadable/missing corpus root wipes the entire chunk index and stamps it "done".**
- docs_index.rs:637-649: `walk_corpus` returns `[]` when `read_dir` fails (chat/docs.rs:84-86) → `keep` empty → `delete_indexed_files_not_in` deletes every row+chunk → `finish!("done", None)` stamps totals 0 + schema version. Watcher path is guarded (canonicalize filter); the `docs_start_index` command path is not. Trigger: corpus folder renamed/moved/unmounted when the user presses Index → search silently returns nothing; when the folder returns, everything re-embeds at full cost. Fix: error state on root read failure instead of empty-keep-as-vanished.

**10. Vault watcher reindex during `full_scan` phase 1 can mis-resolve ambiguous basenames — the exact case the two-phase scan exists to prevent; the final sweep can't repair it.**
- vault/index.rs:544-562 indexes with `resolve: false`, then one `refresh_all_unresolved`; but a watcher event mid-scan goes through `reindex_file_locked` → `index_note(..., resolve=true)` (:326), resolving against the partial file set; a wrongly-set `dest` is never revisited (`refresh_all_unresolved` only touches `dest IS NULL`, :417). Trigger: a save during rescan + two same-basename notes. Fix: per-vault scanning flag the watcher respects.

**11. DRY: worker.rs duplicates the ~55-line provider/model/key/base-URL resolution block.**
- memory/worker.rs:273-311 (`extract_session`) and :803-840 (`save_memory`) are near-verbatim copies (session lookup, key, base-url, fallback, local_gguf wire-model + live-port swap, resolve_memory_model + extract override, sidecar-dead guard repeated again at :312-328/:841-857); the comments cross-reference each other. Fix: extract `resolve_pipeline_model(app, chat_session_id)`.

**12. Vault search's no-positive-term branch loads every `vault_files` row with no SQL LIMIT — O(files) per `tag:`-only query.**
- vault/index.rs:738-753: bare `tag:work` / `path:Projects` / lone `-word` queries materialize the full table into `hits` before Rust-side filtering and the limit break. Fix: push operator filters into SQL (join/EXISTS + LIMIT) or LIMIT the no-terms query.
