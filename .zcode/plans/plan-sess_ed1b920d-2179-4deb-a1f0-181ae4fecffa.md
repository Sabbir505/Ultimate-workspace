# P1 Remote-access hardening via Tailscale + QR pairing + mobile attachments

**Core guarantee:** desktop ↔ phone connects over the Tailnet (cross-network automatically). Same-host (USB-bridge/adb) continues to work as fallback.

## Architecture
- Desktop runs `tailscale serve <port>` (HTTPS on a stable tailnet URL) OR falls back to plain `ws://127.0.0.1:<port>` when tailscale isn't available / user disables it
- Pairing URL is `{scheme}://{host}[:port]/#<token>` — fragment carries the 43-char token so the phone needs one paste-and-scan (or one pasted string)
- QR encodes that full URL; manual entry works too
- Phone attaches `Pair { token }` as first frame (relay's fail-closed gate is already correct, the mobile app was just never sending it)
- Mobile attachments: phone picks doc/image → base64 → `ChatAttachment { name, kind, data/base64, media_type/format }` → desktop handler mirrors the existing `process_attachments` logic (images: vision-vec + placeholder text; docs: decode → `doc_to_text` inline fence)

## Backend (src-tauri)

1. **`mobile/tailscale.rs`** (new): pure helpers — `tailscale_cli_present()`, `tailscale_status() -> Option<(BackendState, IpDnsName)>`, `tailscale_serve_args(port) -> Vec<String>` (verify exact subcommand at test time), `tailscale_serve_stop_args()`. No side effects; callers spawn via `resolve_for_spawn` / `Command`.
2. **New Tauri commands** (`mobile/commands.rs`):
   - `get_mobile_pairing_info() -> { port, token, local_url, tailscale_url, tailscale: { installed, loggedIn, dnsName, backendState } }`
   - `tailscale_serve_enable(port) -> Result<String, String>` (spawns, returns wss URL)
   - `tailscale_serve_disable() -> Result<(), String>`
   - `listen_mobile_pairing_token()` (Tauri listener registration wrapper)
   - Wire through `lib.rs`.
3. **Relay binding tweak**: keep `127.0.0.1` as default (security-first — the explore agent confirmed a prior 0.0.0.0 bind was the attack surface); Tailscale's `serve` termintes TLS at the desktop side so the relay itself needn't gain TLS. When tailscale is active, the pairing UI advertises the `wss://...ts.net` URL + QR; when not, `ws://127.0.0.1:<port>/#token` + QR. No loopback→LAN switch needed.
4. **Mobile attachment handling** (`session_chat.rs`): make desktop `process_attachments` shareable (pub(crate) helper or extract), feed it the mobile-side attachments. Replace the hardcoded `images: Vec::new()` and empty tool-call vecs.
5. **Cargo tests**: tailscale status parse, arg builders (with a `#[cfg(test)]` that won't actually spawn), session_chat attachment processing (image/doc/text + oversize guard).

## Desktop frontend (src/)

6. **Settings "Remote" panel** (`src/components/settings/RemotePanel.tsx`, new):
   - **Pairing card**: live token + QR (`react-native-qrcode-svg` equivalent on desktop — `qrcode` npm dep + `<canvas>` or `<img data-URI>`). Copyable token field. Shows local URL by default; when tailscale `serve` is active, shows the `wss://machine.tailnet.ts.net` URL and renders a second QR for it.
   - **Tailscale card**: `tailscale status --json` drive; "Install / Log in" guidance when absent; "Enable Serve" / "Disable Serve" buttons; resulting URL with copy button.
   - **Usage notes**: explains adb-reverse (same-network fallback) and tailscale serve (cross-network) paths.
7. **ipc.ts**: `getMobilePairingInfo`, `tailscaleServeEnable/disable`, `listenMobilePairingToken`, plus the new response types.
8. **CSS**: minimal — reuse existing panel patterns.

## Mobile (mobile/)

9. **`useRelay.ts`**:
   - Persist token alongside URL (`conduit.relayUrl` + new `conduit.relayToken`).
   - On `ws.onopen` fire `Pair { token }` BEFORE `ListAvailableProviders`.
   - Treat the `DesktopMessage::ChatError { error: "pairing failed" }` frame as fatal → surface error toast → stop reconnect until next manual connect attempt.
10. **`mobile/src/lib/relayUrl.ts`** (new): parse `scheme://host[:port]/#token` into `{ url, token }`; format back. Plain URLs (legacy) still work.
11. **`SettingsScreen.tsx`**:
   - Keep the manual URL field for adb-fallback.
   - Add "Scan QR to pair" button → opens a QR scanner overlay (expo-camera CodeScanner) that auto-extracts the URL+token, saves them, triggers connect.
   - Show connection status with the effective URL.
12. **ChatComposer + useSessionChat**:
   - Composer: 📎 attach button → `expo-document-picker` (images + docs) + `expo-file-system` legacy base64 read; desktop-matching caps (15 MB img / 10 MB doc / 512 KB text). Attachment chips above input with ✕ remove.
   - `useSessionChat.send(text, attachments?)` — thread through to `sendSessionChat`.
   - SessionChat screen passes the updated `onSend`.
13. **Deps + config**:
   - `npx expo install expo-camera expo-document-picker expo-file-system`
   - `app.json`: add `plugins` array with `expo-camera` (camera permission descriptions for iOS/Android 13+)
   - Note in docs that a dev-client rebuild is required after plugin changes.

## Docs
14. **`docs/remote-access.md`** (new): architecture diagram, the two paths (Tailscale / adb-reverse), security model (loopback bind + per-launch rotating token + fail-closed compare + TLS via tailscale serve), attachment limits, mobile rebuild note.

## Verify + ship
- `cargo test --lib` + `npx tsc --noEmit` (desktop) + `npx tsc --noEmit` (mobile delta) + `npx vitest run`
- Desktop dev app hot-reloads; manual smoke-test QR scan + connect + attachment send
- Commit: `feat(mobile): remote access via Tailscale + QR pairing + phone attachments (roadmap P1)`
- Strike COMPETITOR_ANALYSIS_AND_GAPS.md §6 P1 row
- Push

Out of scope: native relay TLS, LAN bind toggle, E2E payload encryption, camera-capture attachments, automated rebuild pipeline.