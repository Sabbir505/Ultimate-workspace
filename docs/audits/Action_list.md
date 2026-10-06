# Relay — What We Should Do (action list, 2026-09-06)

Condensed from `IMPROVEMENT_ROADMAP_2026-09.md`. Check items off as they land.

> **Re-verified 2026-10-05 against the code.** Several boxes below were still
> unchecked after the work had already shipped; those are now checked with the
> evidence noted. Items that are genuinely still open keep their boxes.

## 1. Do now — bugs & performance
- [x] **Fix `remove_project`** — DONE: the DELETEs run inside `conn.unchecked_transaction()` (`src-tauri/src/db/projects.rs:63`), with a `remove_project_is_transactional` rollback test.
- [x] **PTY panic hooks** — DONE: reader/writer/waiter threads are wrapped in `catch_unwind` and emit `pty:crashed` (`src-tauri/src/pty/mod.rs:47-53`); the frontend shows the crash overlay and Resume respawns.
- [x] **Entry-bundle diet** — DONE, and the custom `manualChunks` rules were subsequently **removed** because they backfired (Rollup hoisted shared module-loader helpers into the entry). `vite.config.ts:18-30` now sets `rollupOptions: {}` by design; the entry went 1,179 KB → ~460 KB.
- [x] **Narrow the sessions mutex** — DONE: `agent_sessions/mod.rs:76` holds `Mutex<HashMap<String, Arc<Mutex<AgentChild>>>>`, so the global lock covers only map insert/remove, not spawn + wait-ready.
- [x] **Debug browser result bug** — FIXED 2026-09-06: root cause was evals racing in-flight navigations (dying JS context never reports); fixed with a bounded nav-quiesce gate before every eval + a `pagehide` report fallback in the action wrapper.
- [x] **Sync stale docs** — DONE 2026-10-05: a full doc pass re-grounded the living docs (`ai-context/`, `README.md`, `docs/README.md`, `remote-access.md`, `RELEASE.md`, `BUILD_LOG.md`, `architecture/`, `audits/`) against the code.

## 2. Next — safety & parity
- [ ] **Decide the sandbox question** — implement `run_code`/`run_shell` sandboxing (Windows Job Objects + restricted token first, then Landlock/sandbox-exec) (`chat/codeexec.rs:103-134`). **Still open** — there is no OS-level sandbox on the code-exec path today.
- [x] **Kill the replayable pairing proof** — DONE: since 2026-10-01 the desktop opens with a `PairChallenge` nonce frame and the phone answers `HMAC(token, "E2E-NONCE-V1" ‖ challenge)`, so a captured proof cannot be replayed (`mobile/relay_crypto.rs:1-20`). The legacy static proof is the pre-v2 fallback and can be refused outright via Settings → Remote → "Require challenge-response pairing".
- [ ] **Approval cards for Kimi/OpenCode harnesses** — they currently run full-auto with only post-hoc diff cards. **Still open.**
- [x] **Batch the deferred low-severity fixes** — DONE 2026-09-06 (see FIXES.md: E-9a paired status clears, P-3 artifact cap, P-2 tokio injection tasks, B-28 Unix kill-probe)
- [x] **One-shot children registry Arc leak** (Round-3 M2) — fixed with an RAII guard, all exit paths unregister

## 3. Then — moat upgrades (browser agent)
- [x] **Self-healing actions** — DONE 2026-09-06: stale-ref results auto re-resolve the original description and retry once; healed payloads tagged
- [x] **`extract(prompt)` + `observe()` tools** — DONE 2026-09-06 as MCP ops + chat tools (observe = compact actionable census; extract = deterministic prompt-scored sections; schema-structuring stays in the agent's context)
- [x] **Credentials & 2FA for browser agents** — PARTIAL 2026-09-06: `totp_code` ships (keychain seeds + Bitwarden/1Password CLI sources). Password retrieval deliberately out (credential-takeover policy); session persistence rides the existing per-project WebView profiles
- [x] **`relay-browser` CLI verbs** — DONE 2026-09-06 (navigate/read/observe/extract/click/type/find/screenshot; text-only output)

## 4. After — platform & growth
- [x] **Automation triggers beyond cron** — DONE: `automations.rs` distinguishes `trigger_type == "cron"` from event rows (webhook / file / git / gmail), with `automation_triggers.rs` doing the evaluation and `docs_watcher.rs` providing the file watch.
- [x] **Non-blocking background subagents** — DONE 2026-09-06: verified Task was blocking-in-turn; added `background: true` (task-id return, get_task_status polling, cancel_task abort); foreground default unchanged
- [x] **Hooks system** — DONE: `src-tauri/src/hooks.rs` implements `pre_tool_use` (which can DENY) and `post_tool_use` with the Claude-Code I/O contract, exec gate, and `onError` open/closed semantics; UI at `src/components/settings/HooksPanel.tsx`.
- [ ] **macOS .dmg + wider distribution** — real release bundles, winget/store presence. **Still open** (`targets: ["nsis"]`, Windows-only today).
- [ ] **GitLab support** — second git provider for the PR workflow (GitHub-only today). **Still open** — note GitHub support has since grown to cover **Issues** as well as PRs.
- [ ] **Mobile companion v2** — voice input (whisper exists on desktop, nothing on phone), push when agent finishes/needs approval, cost/budget view. **Still open** (Expo push fallback exists; the rest does not).
- [ ] **Connector health dashboard** — token expiry / reconnect status; add Slack / Linear / Jira. **Still open.**
- [x] **Skills/plugins install-from-URL** — DONE: `install_skill_from_url` plus a curated gallery (`skills_gallery.rs`) with raw/blob/tree/zip guards and zip-slip validation.
- [ ] **Auto-routing Phase 4** — `openrouter/auto` as ranking source, TTFB-based ranking. **Still open** (Phase 4 deferred).

## 5. Hygiene (any time)
- [x] **Real app icon** — DONE: `src-tauri/icons/` ships the full Tauri icon set (`128x128.png`, `Square*Logo.png`, `StoreLogo.png`, `icon.icns`) and `icon.ico` is ~86 KB, not a 32×32 placeholder.
- [ ] **Register or remove quick-action keybindings** — stored in settings but never registered OS-wide. **Still open** — the CRUD commands exist in `lib.rs` but there is no `register_global_shortcut` anywhere in the tree.
- [ ] **Repo cleanup** — `tauri_dev.log` (4.2 MB, growing), stray `nul` file, old screenshots, social-post drafts → archive or .gitignore. **Still open** — several large screenshots and a built APK are currently untracked at the repo root.

## Don't do (deliberate non-goals)
Cloud execution VMs · IDE autocomplete · enterprise SSO/SCIM · free frontier-model access · web client — revisit only deliberately.
