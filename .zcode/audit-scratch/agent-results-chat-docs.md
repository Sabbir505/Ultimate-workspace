# Agent findings: chat docs/citation/codegen (15 files)
# Status: COMPLETE — verified result captured 2026-10-02 18:33

FILES COVERED: src-tauri/src/chat/{plan,citation_lint,citation_verify,codeexec,docs,docs_images,jsdocgen,pdfprint,pygen,python_runtime,subagent_model,totp}.rs + chat/docdesign/{plan,mod,qa}.rs (cross-checked dispatch/capabilities where findings depend on them).

## P0

none.

## P1

**1. `generate_document` executes model-authored Python with full user privileges with no opt-in gate and no sandbox warning — pygen.rs:71-76 (dispatch: chat/tools/generate.rs:181-185, 269).**
`run_code` is gated: `if !caps.code_exec { return ... "code execution is disabled" }` (chat/tools/mod.rs:1612-1617). `generate_document` is not — `pub(super) async fn generate_document(app, artifacts_dir, args)` takes no caps at all, so any turn with tools on can reach `crate::chat::pygen::generate(...)`, which spawns the bundled/system interpreter running arbitrary model Python with the app's privileges (pygen.rs:125-133; no `apply_sandbox` equivalent on this path). pygen's header claims "Security posture (identical to `codeexec`)" including codeexec's "Opt-in only" — but the opt-in is not enforced here, and unlike `run_code` (codeexec.rs:234-238) the result text never appends the "⚠ No OS-level sandbox is enforced…" warning. A prompt-injected web page or repo file steering the model into a `generate_document(language="python")` call gets unsandboxed code execution the user never opted into. Fix: pass `caps` into `generate_document`, require `caps.code_exec` for the python engine (ideally JS/HTML too), append the same sandbox note.

**2. Hidden, reused WebView2 print window navigates to model-authored `file://` HTML — pdfprint.rs:142, 221-245.**
`render_html_to_pdf` writes the model's HTML to `%TEMP%/relay-print-<nanos>.html` and navigates the shared hidden window to `file:///...` (line 232). The window "is created lazily and reused for every PDF render" (24-25) and nothing ever navigates it back to `about:blank` after printing. Consequences: (a) a `file://` document in WebView2 may embed other local files as subresources (`<iframe src="file:///C:/Users/me/secret.txt">`), whose contents get rendered into the produced PDF — a local-file read channel bypassing permission-gated `read_file`; (b) model JS keeps running in the hidden window after the tool returns and can navigate it anywhere, leaving a persistent hidden page on an attacker-chosen origin. Capabilities files cover only `main`/`browser-*`/`oauth-*` — `relay-pdf-print` gets no plugin permissions, but Tauri app-defined commands are not ACL-gated by default, so IPC reachability is unverified rather than safe. Fix: register `NavigationStarting` permitting only the one temp file then force `about:blank` after `PrintToPdf`, strip `file:` subresource references (or serve via custom protocol with settings locked down), and destroy (not reuse) the window per render.

**3. Reachable panic in `apply_patches`: `slide["slots"][slot]` on a non-object — docdesign/plan.rs:527.**
`slide["slots"][slot] = value.clone();` — `slide` is an object but nothing guarantees `slots` is; serde_json `index_or_insert` with a string key panics on `Value::String/Array/Number/Bool`. Trigger: `revise_document` loads its sidecar from any model-supplied path (only `{path}.plan.json` must exist, lines 405-413) and `plan_sanity_errors` (59-90) checks only `kind` + non-empty `slides`. The model can write a sidecar itself (`generate_file` writing `x.plan.json` with `{"kind":"deck","slides":[{"id":"s1","slots":"oops"}]}`) then call `revise_document(path="…/x", patches=[...])` → panic inside the async tool dispatch, killing the chat turn. Fix: resolve the slot map explicitly with `get_mut("slots")` + `as_object_mut().ok_or_else(...)` and insert into that.

**4. Citation lint computes the report body via `content.rfind("\n#")`, so tolerant Sources headings corrupt every metric — citation_lint.rs:378.**
`is_sources_heading` (133-165) deliberately accepts `**Source References:**` / `6. Source References:` styles (the module's own test fixture uses `**Source References:**`). For such a report with no other `\n#`-heading, `body_end = len` and the entire Sources section is linted as report body: each `- [1] [Apple press release](https://…)` entry re-triggers `extract_citation_numbers`, so `total_citations` double-counts every bracketed entry, and each entry line is counted as an `uncited_sentence` and falsely flagged by weak-attribution. Symmetrically, a `#`-heading *after* Sources (e.g. `## Appendix`) produces the same leak. Numbers are persisted (`save_citation_report`) and shown as integrity chips. Fix: make `parse_sources_section` return the heading's byte offset and cut the body there.

## P2

**5. `split_sentences` decimal heuristic detects the wrong pattern — citation_lint.rs:579-585.**
`before`/`nth(2)` are the two characters *before* the period, but a decimal point needs the digit *after* it. Result inverted vs stated intent ("digit.digit ('3.5')"): "costs 3.5 million [1]." splits mid-number, while "…shipped in 2026." does not break and merges with the next sentence. Skews `uncited_sentences` and fragments `WeakAttribution.sentence` text. Fix: skip the break only when the *next* char (peeked ahead) is also a digit.

**6. Temp dirs/files named from a bare nanosecond timestamp — codeexec.rs:179, pygen.rs:98/248-253, pdfprint.rs:222-229.**
`relay_exec_{nanos}` / `relay_pygen_{nanos}` / `relay-print-{nanos}.html` — no randomness, no collision check. Two concurrent executions in the same clock tick share a work dir; `create_dir_all` succeeds silently and one run overwrites the other's `main.py`, executing the wrong source. `uuid` is already a dependency. Fix: `uuid::Uuid::new_v4()` suffixes (or the `tempfile` crate).

**7. Blocking interpreter probe runs on the async runtime — python_runtime.rs:139-152 via codeexec.rs:151 / pygen.rs:64-66.**
`probe()` runs synchronous `Command::status()` spawns (`py --version`, `python --version`) inside async `run_code`/`generate`. Success is cached in `RESOLVED`, but a machine with *no* Python skips the cache (`None => return system_interpreter()`, 98-101), so every call pays two blocking process spawns on a tokio worker. Fix: resolve once at startup into the `OnceLock`, or wrap in `spawn_blocking` / cache the negative result briefly.

**8. DRY: output-name and truncate logic reimplemented across the three generators — jsdocgen.rs:68-74 and 158-166, pygen.rs:82-88, docdesign/plan.rs:640-648; codeexec.rs:268-277 vs pygen.rs:255-265.**
The "sanitize filename, maybe append canonical extension, join dir" block exists three times (plus a duplicate inside jsdocgen's own `generate`, plus a private copy in docdesign); `truncate` (char-boundary-safe cut + "… (output truncated)") exists twice with only the byte cap differing. A drift in one copy silently misses the others. Fix: one `artifacts::planned_path(dir, format, filename)` and one `util::truncate_bytes(s, cap)`.

Cleared (checked, no issue): docs.rs chunking (char-boundary flooring + `max(start+1)` guard = provable forward progress); totp.rs decode + dynamic truncation (RFC 6238 vectors pinned); subagent_model pick/engine/key-fallback; citation_verify degradation-to-partial; jsdocgen/docdesign pending-waiter maps; sanitize_filename (can't traverse).
