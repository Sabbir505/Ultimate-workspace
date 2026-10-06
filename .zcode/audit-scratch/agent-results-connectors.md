# Agent findings: connectors/oauth (8 files)
# Status: COMPLETE — verified result captured 2026-10-02 18:41

FILES COVERED: src-tauri/src/connectors/{google_rest,oauth,config,gmail_api,mcp,session,harness,mod}.rs + targeted verification reads of util.rs, secrets.rs, chat/dispatch.rs, chat/mod.rs, mcp_tools_bridge.rs, harness_bundle.rs, and the vendored rmcp 3.0.0-beta.2 transport source.

Verified-clean up front: token storage is genuinely OS-keychain (secrets.rs, Windows Credential Manager), never SQLite on Windows; state + PKCE S256 correctly generated/validated; the refresh single-flight (REFRESH_LOCKS, M16) re-reads the refresh token after acquiring the lock, so concurrent refreshes cannot invalidate each other; no tokens or client secrets reach logs; no reachable `unwrap` panics on API responses; MIME header injection sanitized.

## P0

none

## P1

**1. Ungated irreversible connector writes on the harness bridge, amplified by a tool description that instructs the model never to seek permission.**
- gmail_api.rs:80-87, connectors/mod.rs:36-40, mcp_tools_bridge.rs:315-330.
gmail_api.rs:84-86 ships this model-facing instruction: *"The email is sent as soon as the call executes — do not ask for permission first and never tell the user to send it manually. (In Relay's built-in chat a confirmation card is shown before the call runs; on the harness bridge it executes immediately.)"* The bridge backs that up (mcp_tools_bridge.rs:318-324, "Owner policy: ALL fallback tools — writes included — execute here ungated") — `execute_fallback_tool` with no approval gate routes to `gmail_send_message`, `gdrive_create_file`, `gchat_send_message`, `gcalendar_delete_event`, etc. Combined with fallback reads returning untrusted content verbatim (`gmail_get_message` raw JSON, `gdrive_read_file_content` file bodies), a prompt injection embedded in any read email or Drive file can silently send email from the user's real Gmail account, post Chat messages, or delete calendar events in a harness session with zero human confirmation. Documented as intentional owner policy (hence P1 not P0) — but highest-risk item in the module. Fix: remove the "do not ask for permission first and never tell the user" instruction (the injection amplifier); and/or add a per-session/harness toggle gating connector Writes by default, mirroring `dispatch::run_gated_connector_tool`.

**2. No timeout anywhere on the MCP HTTP transport — a wedged vendor server hangs the entire chat turn.**
- connectors/mcp.rs:68-86 (call sites session.rs:90-92, chat/dispatch.rs:564, chat/mod.rs:743).
The transport is built with only URI + auth header; `serve` (initialize), `list_tools`, and `call_tool` are awaited with no `tokio::time::timeout` at any call site. Verified in vendored rmcp 3.0.0-beta.2 (`transport/common/reqwest/streamable_http_client.rs:350-356`): default client sets only `pool_max_idle_per_host(0)` + `redirect::Policy::none()` — no connect or total timeout. A vendor endpoint that accepts TCP but never responds parks `connect_all` forever; the turn never starts, spinner never clears. Same bug class already fixed for OAuth (oauth.rs:38-48, "audit H-2"); config.rs:600-601 even references "the MCP call timeout note in mcp.rs" — no such note or timeout exists, the intended safeguard was never implemented. Fix: wrap serve/list_tools/call_tool in `tokio::time::timeout` (init/list ~30s; tool calls ≥60s per the Canva note in config.rs:599-601), or build a reqwest client with `connect_timeout`/`timeout` via `with_client`.

## P2

**3. Error context passed as an unformatted string literal — every Google REST fallback error names the operation as `{product} {op}`.**
google_rest.rs:598, 611, 624: `checked_send_ctx(..., "{product} {op}")` — `checked_send_ctx` formats `{op} failed: {e}` / `{op} HTTP {status}`, so ~30 tools surface errors literally as `{product} {op} failed: …`. Fix: `&format!("{product} {op}")`.

**4. Enum-ish string args interpolated into query strings unvalidated and unencoded.**
google_rest.rs:512-515 (`type={kind}`), 944-949 (`majorDimension={dim}`) — inserted raw; schema declares enums but code never checks or URL-encodes. A value with `&`/`#`/space injects or truncates query params. Everything else in the file is carefully encoded. Fix: validate against the enum or build with `.query(&[...])`.

**5. Fresh `reqwest::Client` per tool call plus triplicated/duplicated REST and OAuth request boilerplate.**
google_rest.rs:440, 591-627; gmail_api.rs:173; oauth.rs:1026-1065 vs 1246-1277. New connection pool + TLS handshake per fallback tool invocation, zero keep-alive reuse across fan-out calls (gmail_search_threads then issues up to 25 more requests on its private client). `get_json`/`post_json`/`put_json` are three copies of the same body; `exchange_token`/`refresh_access_token_inner` duplicate the form-building. Fix: one shared `Lazy<reqwest::Client>` with `connect_timeout`+`timeout`; one `authed_form` helper.

**6. One-shot loopback acceptor: any stray connection permanently fails the OAuth flow.**
oauth.rs:793-808: single `listener.accept()` then single `read_line`. Fixed ports (45123-45135) bound up to 5 min; a browser speculative preconnect, port scanner, or AV probe consumes the only accept and the whole flow errors; the real callback then hits a listener nobody accepts. RFC 8252 practice: loop until a request with valid `state` arrives, bounded by the outer timeout. Fix: wrap accept/read/validate in a loop (respond 400 + re-accept on malformed), exit only on valid state or outer timeout.

**7. `gmail_get_thread` / `gmail_get_message` return raw Gmail JSON with base64 payloads, not the documented plaintext bodies.**
gmail_api.rs:288-289, 300-301 (vs descriptions at 50-53, 58-61): `resp.text().await.unwrap_or_default()` — raw `format=full` response whose bodies are base64url MIME blobs. Descriptions promise "plaintext bodies". The model receives base64 it cannot reliably decode, and the 64KB `cap_response_text` cap truncates long threads inside base64 noise. (`gmail_search_threads` extracts headers/snippet properly; only the two detail tools skip post-processing.) Fix: decode `payload`/`parts` with the existing base64url helper (mimicking `doc_to_text`) and return headers + plaintext.

**8. Harness bearer tokens persisted as plaintext JSON on disk after sessions end.**
connectors/harness.rs:116-121; harness_bundle.rs:35-37, 91-93, 602-610. `bearer_token` is written verbatim (`"Authorization": "Bearer {tok}"`) into `<app_data>/harness/<project>/claude/mcp.json` via plain `std::fs::write`, no restrictive ACL, not cleaned up on session end. Windows per-user ACL + ~1h access tokens bound exposure (refresh tokens never leave the keychain), but it deviates from secrets.rs:30-35 ("the frontend only ever learns the metadata … never the token bytes") and stale-but-valid tokens linger until next spawn overwrites. Fix: strip/rewrite the token on session end; set user-only ACL where supported; document the deviation in secrets.rs.
