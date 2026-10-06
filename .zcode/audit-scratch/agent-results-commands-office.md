# Agent findings: chat commands + office (12 files)
# Status: COMPLETE — verified 2026-10-02 19:12. P0 #1 CROSS-VERIFIED BY ORCHESTRATOR (direct read of send.rs:1094-1193 + lib.rs:172 `DbState(Arc<parking_lot::Mutex<Connection>>)` — outer guard held through block end; inner locks at 1141/1155 re-lock same non-reentrant mutex on same thread).

FILES COVERED: src-tauri/src/chat/commands/{send,selection,preview,sessions,llama_sidecar,api_keys,generators,approval,artifacts}.rs, chat/commands.rs, chat/office.rs, chat/export.rs

## P0

**1. `send_chat_message` deadlocks the whole app for every project-bound session — nested `db.0.lock()` on a non-reentrant parking_lot::Mutex.**
- send.rs:1094 (outer `let conn = db.0.lock();`) with re-locks at :1141 (`agents_md_section` closure) and :1155 (`wiki_section` closure); guard alive through block end (1192-1193); no `drop(conn)` anywhere in the file. `DbState.0` is `Arc<parking_lot::Mutex<Connection>>` (lib.rs:172) — parking_lot is not reentrant, so the second `lock()` blocks forever on the same thread. Trigger: any send into a chat with a bound project (`session_project_id` = Some) — the primary use case. The global DB mutex is then held forever: every other IPC command freezes too (total app hang). The codebase documents this exact failure class at selection.rs:864-868 ("a nested lock here deadlocked the whole app on model load"). The inner locks are the AGENTS.md (§4.2.10) and project-wiki (§6.15) sections — i.e., a fresh regression from the 2026-10-01/02 wiki + AGENTS.md layering commits. Fix: reuse the already-held guard inside both closures (no awaits there), or hoist the `get_project` / `wiki.layer_index` reads before line 1094.

## P1

**2. A one-time tool approval permanently grants write access to the target's whole directory, for all future sessions — approval.rs:84-88.**
`grant_directory_for_approved_tool(&db.0.lock(), &pending.tool, &pending.args)` runs on *every* `approved = true` — `resolve_tool_action` has no "always/remember" parameter, so a plain "Allow once" on `write_file C:\Users\me\important\notes.txt` persists `C:\Users\me\important` into `permissions.grantedRoots`, which send.rs:1746-1758 merges into `fs_roots` for every turn of every session. Both doc comments (approval.rs:17-22, send.rs:1744-1745) say this should happen only "when an approval is remembered ('always allow')". Fix: thread the card's choice through (`always: bool`) and grant only for the remembered variant.

**3. `render_xlsx_sheet`: unbounded row index from the sheet's `r` attribute → multi-GB HTML string / tens of millions of HashSet inserts — office.rs:962-965, 1001, 1020-1050, merge loop 946-952.**
`MAX_ROWS`/`MAX_COLS` cap only how many `<row>` elements are parsed; `n_rows = n_rows.max(row_idx + 1)` then feeds `for r in 0..n_rows { while c < n_cols { push "<td></td>" } }`. A single `<row r="1048576">` (file-controlled, reached via read_artifact_preview → xlsx_to_html for any previewed .xlsx) emits up to 1,048,576 × 256 empty cells ≈ multi-GB HTML — OOM/hang. Likewise `parse_merge_range` feeds `for rr in r1..=r2 { for cc in c1..=c2 { covered.insert(...) } }` unbounded — `mergeCell ref="A1:ZZ1048576"` ≈ 268M HashSet inserts. Fix: skip rows with `row_idx >= MAX_ROWS`; clamp/skip merge spans beyond MAX.

**4. Chat-import zip has no decompression caps — a crafted or oversized "chat export" OOMs the process — export.rs:412-415, 387-401, 503-517.**
`import_chat_zip` reads the whole file, and every matching entry via `f.read_to_end(&mut buf)` with no per-entry/total limit; all decompressed artifact bytes retained simultaneously (`ParsedChatExport::art_entries`). A zip-bomb or large archive from someone else inflates without bound. Fix: cap per-entry (~25MB) and total (~500MB) using metadata checks or `take()`, reject oversize with a clear error.

## P2

**5. `parse_merge_range` typo: `r2.max(r2)` is the identity — office.rs:809.**
`Some((c1.min(c2), r1.min(r2), c1.max(c2), r2.max(r2)))` — last element should be `r1.max(r2)`; reversed ranges (D8:B3) collapse to rowspan 1, mis-rendered merges. Fix: `r1.max(r2)`.

**6. Context-window probe uses `{base}/models`, contradicting the app-wide convention — selection.rs:172.**
Everywhere else the stored base excludes `/v1` and the path is appended (`{base}/v1/chat/completions` providers.rs:476, `{base}/v1/messages` :386, `{base}/v1/models` send.rs:173 and selection.rs:101). For the only base config under which chat works, this probe hits the wrong path and 176-185 swallows the failure into an empty map — dynamic windows silently never load for `openai_compatible` relays (llama.cpp/vllm). Fix: probe `{base}/v1/models`.

**7. `is_libreoffice_available` runs blocking `soffice --version` on the async runtime — preview.rs:552-555 → office.rs:1266-1279.**
When LibreOffice is on PATH, `--version` takes seconds; called on every office-preview open; doc comment claims it "never runs on the UI thread" but there's no spawn_blocking. Fix: `spawn_blocking` + memoize.

**8. `generate_commit_message` / `generate_diff_review` run `git diff` inline on the async runtime — generators.rs:182, 357-360.**
`get_git_diff` is a synchronous `Command::new("git")` (git.rs:31, 249); in a large repo it blocks a tokio worker — the hazard these files fix elsewhere (preview.rs:146, sessions.rs:131). Fix: `spawn_blocking`.

**9. Export/import do blocking file IO + Deflate inline on the async runtime and buffer the entire archive in RAM — export.rs:335-337, 375-381, 412-421.**
`finish_serialize_chat` (per-artifact fs::read), `build_zip` (full Deflate into Vec), `write_zip` (fs::write) all in the async command body. Fix: spawn_blocking the phases; stream ZipWriter to file.

**10. Import reads the artifacts directory while holding the global DB mutex — export.rs:633-644 (under the lock at :419-421).**
`std::fs::read_dir(artifacts_dir)` under the shared mutex contradicts the module's own rule (export.rs:413-414 "the lock guards SQL only") — with thousands of artifact entries every DB consumer stalls behind the listing. Fix: collect the `used` set before taking the lock.

**11. `slug()` passes `..` through — a chat titled `..` exports a path-traversal zip — export.rs:116-136 (used at 272-287).**
`slug("..") == ".."` → entries as `chats/../chat.json`; title settable via `update_chat_session_title` (sessions.rs:538-546, no validation). Relay's own import unaffected (reads by name; artifact names sanitized), but Explorer/7-Zip extraction of the export traverses. Fix: map dot-runs to `_` or reject `.`/`..`/reserved names.

**12. `delete_chat_api_key` leaves the provider's curated model list behind — api_keys.rs:108-117.**
Comment: "Clearing a provider removes its whole configuration, not just the key"; deletes `.base_url`, `.model`, `.display_name` but not `chat.{provider}.selected_models` (written by selection.rs:336-352, authoritatively consumed by load_selected_models/load_model_window_override). Re-adding the provider resurrects the stale curated list + pinned windows, overriding the live /v1/models fetch. Fix: add it to the DELETE list.

Below threshold (for the record): same-millisecond image-upload filename collision (send.rs:68-91) needs two same-named attachments decoding within 1ms; all unwraps in scope are `unwrap_or*`; byte-index slicing in strip_tagged_blocks/message_has_slash_token/elements is boundary-safe.
