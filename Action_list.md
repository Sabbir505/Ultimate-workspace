# Relay — What We Should Do (action list, 2026-09-06)

Condensed from `IMPROVEMENT_ROADMAP_2026-09.md`. Check items off as they land.

## 1. Do now — bugs & performance
- [ ] **Fix `remove_project`** — wrap the 7 DELETEs in a transaction and stop swallowing the session-delete error (`src-tauri/src/db/projects.rs:50-62`)
- [ ] **PTY panic hooks** — reader/writer thread panics currently freeze panes silently (`src-tauri/src/pty/mod.rs`); emit an event so the UI can show "session crashed → restart"
- [ ] **Entry-bundle diet** — research mode / harness picker / citation UI landed in the entry graph (459 KB → 1,179 KB); `React.lazy` + `manualChunks`, lazy-load KaTeX fonts, audit the >500 KB async chunks
- [ ] **Narrow the sessions mutex** — `send()` holds the global lock across spawn + up-to-20 s wait-ready; hold it only for map insert/remove
- [x] **Debug browser result bug** — FIXED 2026-09-06: root cause was evals racing in-flight navigations (dying JS context never reports); fixed with a bounded nav-quiesce gate before every eval + a `pagehide` report fallback in the action wrapper. Pending one live GUI re-check (`tauri dev`)
- [ ] **Sync stale docs** — FIXES.md (E-2/E-7 are fixed in code), BROWSER_SYSTEM_RESEARCH.md header (P1/P2 shipped), AI_CONTEXT §2.6 file list

## 2. Next — safety & parity
- [ ] **Decide the sandbox question** — implement `run_code`/`run_shell` sandboxing (Windows Job Objects + restricted token first, then Landlock/sandbox-exec) (`chat/codeexec.rs:103-134`)
- [ ] **Kill the replayable pairing proof** — add challenge-response to mobile pairing (needs coordinated phone-side release)
- [ ] **Approval cards for Kimi/OpenCode harnesses** — they currently run full-auto with only post-hoc diff cards
- [x] **Batch the deferred low-severity fixes** — DONE 2026-09-06 (see FIXES.md: E-9a paired status clears, P-3 artifact cap, P-2 tokio injection tasks, B-28 Unix kill-probe)
- [x] **One-shot children registry Arc leak** (Round-3 M2) — fixed with an RAII guard, all exit paths unregister

## 3. Then — moat upgrades (browser agent)
- [x] **Self-healing actions** — DONE 2026-09-06: stale-ref results auto re-resolve the original description and retry once; healed payloads tagged
- [x] **`extract(prompt)` + `observe()` tools** — DONE 2026-09-06 as MCP ops + chat tools (observe = compact actionable census; extract = deterministic prompt-scored sections; schema-structuring stays in the agent's context)
- [x] **Credentials & 2FA for browser agents** — PARTIAL 2026-09-06: `totp_code` ships (keychain seeds + Bitwarden/1Password CLI sources). Password retrieval deliberately out (credential-takeover policy); session persistence rides the existing per-project WebView profiles
- [x] **`relay-browser` CLI verbs** — DONE 2026-09-06 (navigate/read/observe/extract/click/type/find/screenshot; text-only output)

## 4. After — platform & growth
- [ ] **Automation triggers beyond cron** — git events (push / branch / PR open), file watch (webhooks already exist)
- [x] **Non-blocking background subagents** — DONE 2026-09-06: verified Task was blocking-in-turn; added `background: true` (task-id return, get_task_status polling, cancel_task abort); foreground default unchanged
- [ ] **Hooks system** — pre/post tool-execution hooks; cheap because `check_permission()` is already centralized
- [ ] **macOS .dmg + wider distribution** — real release bundles, winget/store presence
- [ ] **GitLab support** — second git provider for the PR workflow (GitHub-only today)
- [ ] **Mobile companion v2** — voice input (whisper exists on desktop, nothing on phone), push when agent finishes/needs approval, cost/budget view
- [ ] **Connector health dashboard** — token expiry / reconnect status; add Slack / Linear / Jira
- [ ] **Skills/plugins install-from-URL** — first step toward a marketplace ecosystem
- [ ] **Auto-routing Phase 4** — `openrouter/auto` as ranking source, TTFB-based ranking

## 5. Hygiene (any time)
- [ ] **Real app icon** — `src-tauri/icons/icon.ico` is a 32×32 placeholder
- [ ] **Register or remove quick-action keybindings** — stored in settings but never registered OS-wide
- [ ] **Repo cleanup** — `tauri_dev.log` (4.2 MB, growing), stray `nul` file, old screenshots, social-post drafts → archive or .gitignore

## Don't do (deliberate non-goals)
Cloud execution VMs · IDE autocomplete · enterprise SSO/SCIM · free frontier-model access · web client — revisit only deliberately.
