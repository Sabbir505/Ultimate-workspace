# Agent findings: chat tools layer (13 files)
# Status: COMPLETE — verified result captured 2026-10-03 (retry4)

FILES COVERED: src-tauri/src/chat/tools/{specs,mod,search,fs,search_content,generate,capabilities,automations,subagents,vault,serp_browser,imagegen}.rs + chat/proto.rs. Cross-referenced dispatch.rs, permission.rs, vault/mod.rs, artifacts.rs, automation_triggers.rs, automation_cmds.rs, chat/subagents.rs, installed_skills.rs only to verify gates/sanitizers — the fs mutating gate, `vault::safe_join`, `artifacts::sanitize_filename`, skill-slug resolution, and trigger validation all check out.

## P0

none. Verified specifically: mutating fs/vault/automation tools are schema-stripped under `read_only` in both builders and approval-gated in dispatch (incl. WRITE_AGENTS_MD via is_mutating_fs_tool); generate_file/document/diagram/image all sanitize filenames (last component, `..`/separator-stripped) before joining into artifacts dir; vault_* go through safe_join (segment rules + canonical-parent check); SSRF guard covers IPv4-mapped/compatible IPv6, CGNAT, post-connect rebinding; no panic path reachable from model-controlled input found in these files.

## P1

**1. `fetch_url` fallback extraction does O(n²) tag-stripping synchronously on the async runtime — a hostile page stalls tokio workers for minutes (no timeout covers it).**
- search.rs:480-520: `remove_blocks` re-lowercases the entire remaining document on EVERY occurrence of EVERY tag (`loop { let lower = s.to_ascii_lowercase(); ... }`). `fetch_url` caps the body at 1 MiB but then runs `extract_html` inline in the async fn (:280 → html_to_text :421 → remove_blocks). A 1 MiB page of ~60k tiny `<script>x</script>` blocks (exactly the shape where Readability finds no article → fallback triggers) does ~60k full-document lowercase passes ≈ tens of GB of byte churn — minutes of a pegged worker. `fetch_url` is auto-run read-only with a model/attacker-chosen URL (web_search → fetch_url), no approval needed. The codebase's own D2 comment (mod.rs:1636) says this class must go to the blocking pool; the reqwest 30s timeout bounds HTTP, not this CPU work. Fix: `extract_html` via spawn_blocking; make `remove_blocks` single-pass (precomputed open/close positions per tag) or cap iterations.

## P2

**2. `create_automation` returns the webhook trigger URL — including its secret — into the model-visible tool result, contradicting the module's own redaction contract.**
- automations.rs:409-417: `Ok(url) => format!(" Trigger URL (contains the secret — share carefully): {url}")` — fed to the model and persisted in conversation history (thus to cloud providers). The same file's trigger_config_brief (:233) states "The webhook secret is never included (see strip_webhook_secret)"; the UI path strips it everywhere. A secret that fires unattended agent runs should not sit in transcripts. Fix: return id + instructions to get the URL from the Automations view (or gate behind explicit user confirmation).

**3. Capability report claims model-created subagents are "created READ-ONLY … only the user can widen what it is allowed to do", but `create_subagent`/`update_subagent` accept `sandbox_policy`/`tools`/`approval_policy` verbatim from model args.**
- capabilities.rs:305-309 vs subagents.rs:111-127 (`sandbox_policy: get_str(... "read_only")` — an explicit "workspace_write" passes validate_input at chat/subagents.rs:540-548) and specs.rs:2013-2017 advertises the enum escape. Only backstop is the approval card; the report tells the model a boundary the schema openly contradicts. Fix: force agent-origin rows to read_only/default tools as claimed, or correct the report text to say widening requires the user's approval click.

**4. Jina-reader fallbacks buffer the entire response body — the OOM guard the direct path exists for is bypassed.**
- search.rs:228 (fetch_url_via_jina: `resp.text().await`) and :805 (serp_via_reader, same). Direct fetch caps streaming at 1 MiB ("stops a hostile server streaming gigabytes from OOM-killing the Tauri backend", :36-40); the reader paths read the full body before truncate_chars, and r.jina.ai returns the full text of the model-picked target. Fix: reuse the bytes_stream + FETCH_URL_MAX_BODY_BYTES cap in both helpers.

**5. Blocking DNS resolution runs on the async runtime.**
- search.rs:136-137: `(h, 0u16).to_socket_addrs()` called synchronously inside async fetch_url (:270) — getaddrinfo on a tokio worker; slow/broken resolvers (VPN, TUN) block a worker for seconds per fetch. Fix: `tokio::net::lookup_host` or spawn_blocking.

**6. `fs_search_files` keeps walking the entire tree after the result cap — missing outer-loop break.**
- fs.rs:107-131: the `break` only exits the inner `for`; the `while` keeps read_dir-ing every remaining directory. The sibling (search_content.rs:318-320) does it right (`if truncated { break; }` after the inner loop). Searching a drive root still completes the full walk after 100 matches. Fix: break the outer loop too.

**7. `search_content` "Notes" section unbounded — one line per skipped file fed to the model.**
- search_content.rs:396-403/:420-427 push a note per skipped (too-large/binary) file, all rendered (:327-330/:371-375). SKIP_DIRS (:51-73) omits `bin`, `obj`, `Pods`, `packages` — a .NET/iOS repo emits thousands of skip lines into context; the match list is capped, the noise isn't. Fix: cap notes (~20 + "and N more") and/or count.

**8. `fs_list_directory` output uncapped.**
- fs.rs:42-56 joins every entry with no limit — listing WinSxS/node_modules returns megabytes in one tool result while neighbors cap (FS_READ_MAX 32k, search_files 100, vault_list 200). Fix: cap ~500 entries with a marker.

**9. `update_automation` cannot clear `schedule` — spec-vs-implementation drift documented in the schema.**
- automations.rs:474-481: empty string indistinguishable from absent → stale cron kept and echoed by get/list_automations even after switching to a webhook/file/git trigger; specs.rs:2342-2344 tells the model "empty is valid". The same function solves this for `model`/`cwd` with presence-based matching (:496-505). Fix: apply presence check to schedule.
