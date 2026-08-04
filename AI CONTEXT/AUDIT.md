# Conduit — Grounded Audit Log

All findings grounded in actual code/config (`file:line`), not framework assumptions.
Verdicts: **proved** / **no-issue** / **weak** / **N/A**
Severity: critical / high / medium / low / info
Status: 🟢 fixed+tested · 🟡 mitigated/doc-only · 🔴 unfixed · ⚪ N/A

## E2E Test Results (2026-07-27)
- 🟢 **12/12 E2E checks passed** — page title, render, buttons, no console errors, no build errors, screenshot confirms UI intact
- 🟢 **207 Rust unit tests passed** (0 failed)
- 🟢 **128 vitest frontend tests passed** (0 failed)
- 🟢 `cargo build` clean (only pre-existing warnings)

> **Implementation note:** As of 2026-08-04 the test counts are **295+** Rust + vitest combined (see `BUILD_LOG.md` for the most recent run). The 207/128 split above is the snapshot from 2026-07-27.

---

## Completed fixes (14 items)

### Critical
| ID | Item | File | Fix |
|----|------|------|-----|
| 3.1 | CSP `null` — full renderer compromise | `tauri.conf.json:28` | Restrictive CSP: `default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com; ...` |

### High
| ID | Item | File | Fix |
|----|------|------|-----|
| 3.3/8.2 | OAuth fixed port 17963 (squatting risk) | `oauth.rs:114` | `TcpListener::bind("127.0.0.1:0")` — random port |
| 3.4/8.3 | OAuth state not validated (CSRF) | `oauth.rs:218-262` | State generated per-flow, stored in `OAuthFlows`, validated in `accept_one_callback` |
| 3.5/8.1/4.2 | Path traversal in `path_within_granted_roots` | `permission.rs:282-309` | `canonicalize()` resolves `..` before prefix check; test updated |
| 8.4 | GGUF Hermes dual-format tool calls | `streaming.rs` | Validate tool names against registry; fall through to Hermes on unknown tool names |

### Medium
| ID | Item | File | Fix |
|----|------|------|-----|
| 3.7 | Browser MCP WS no auth | `browser_mcp.rs` + `conduit_browser_mcp.rs` | Random token at startup (`CONDUIT_MCP_AUTH_TOKEN` env); first WS message must be `{"auth":"<token>"}` |
| 8.5 | Source ledger no dedup/cap | `source_ledger.rs` + `mod.rs` | `INSERT OR IGNORE` + `UNIQUE INDEX (session, url, fact)` + `LIMIT 50` |
| 8.6 | xml_unescape entity order | `office.rs:20-26` | `&amp;` resolved first, then `&lt;`/`&gt;`/`&quot;`/`&apos;` |
| 8.7 | Local model title generation | `commands.rs:281-288` | `local_gguf` skips API key check (keyless), uses sidecar base_url |
| 8.10 | SSE parse errors silent stall | `streaming.rs` | `MAX_PARSE_FAILURES = 50` counter; error after N consecutive failures |
| 2.5 | llama-server paths Windows-biased | `local_models.rs:622-625` | Added `/opt/homebrew/bin`, `/usr/local/opt/llama.cpp/bin`, `/usr/bin` for mac/linux |

### Low
| ID | Item | File | Fix |
|----|------|------|-----|
| 8.11 | Chat state Sets unbounded | `chat.ts:39-75` | `capSet()` helper; `deletedSessions`, `manuallyRenamed`, `fullAutoConfirmed` capped at 1000 |
| 5.5 | PTY seen_urls never pruned | `pty/mod.rs:477-480` | Clear set when >1000 entries |
| 8.12 | resolveApproval optimistic clear | `chat.ts:490-501` | Clear card only on `chat:approval-resolved` event |
| 8.13 | Pane writer thread leak | `pty/mod.rs:419-428` | `Drop` impl closes writer channel |

---

## Remaining (acknowledged/design decisions)

| ID | Item | Severity | Status |
|----|------|----------|--------|
| 3.2/2.2 | Linux secrets XOR obfuscation | high | 🟡 (needs `linux-native` keyring backend; documented risk) |
| 3.6 | Notion client_secret in binary | high | 🟡 (acknowledged in source; needs dynamic config endpoint) |
| 3.8/4.1 | Code exec not OS-sandboxed | medium | 🟡 (mitigated by permission mode gating; default `manual`) |
| 3.9 | Capability wildcards `browser-*`/`oauth-*` | medium | 🟡 (loopback-only mitigates remote risk) |
| 3.10 | CUDA DLL path injection | medium | 🟡 (requires admin access) |
| 4.3 | PTY PID-reuse race | medium | 🟡 (~ms window; low practical risk) |
| 2.1/6.3 | Bundled Python Windows-only | high | 🟡 (needs mac/linux TARGETS in fetch-bundled-python.mjs) |
| 2.3 | Browser panes disabled on Linux | high | 🟡 (Tauri limitation; doc only) |
| 2.4 | macOSPrivateApi blocks App Store | medium | 🟡 (doc only; distribution via GitHub Releases) |
| 6.1 | No CI/CD | high | 🟡 (needs .github/workflows) |
| 6.2 | Updater Windows-only | high | 🟡 (add mac/linux to make-latest-json.mjs) |
| 6.4 | Signing key in repo tree | high | 🟡 (.gitignored; present for local signing) |
| 5.1 | Per-token IPC no throttling | medium | 🟡 (batch tokens in useChatEvents; memo MessageBubble) |
| 5.3 | MCP sessions not reused | medium | 🟡 (cache per chat session) |
| 5.4 | No per-turn timeout | medium | 🟡 (add 5-min wall-clock timeout; capped at 45/96 iterations) |
| 8.8 | Connector tool name collision | medium | 🟡 (namespace with connector prefix) |
| 8.9 | Artifact attribution race | medium | 🟡 (backend returns message ID with artifact) |
| 6.5 | Browser MCP not in bundle | medium | 🟡 (document as dev-only or add externalBin) |
| 6.7 | RELEASE.md missing Cargo.toml bump | low | 🟢 (already documented at RELEASE.md:44-46) |
