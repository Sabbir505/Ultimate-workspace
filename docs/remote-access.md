# Remote access — pairing your phone to the desktop

Relay's desktop app runs a local WebSocket relay that the mobile companion app connects to. The relay always binds the loopback interface (`127.0.0.1:<port>`); when the desktop is on a Tailscale network it **additionally** binds the same port on the tailnet interface, so only tailnet peers (or a USB bridge) can reach it. The phone never holds API keys — every request is proxied through the desktop session.

There are two ways to bridge the phone to the relay:

1. **USB bridge** (development) — `adb reverse` forwards a phone-side port to the desktop's loopback.
2. **Tailscale** (remote) — the phone connects either **directly** over the tailnet (`ws://<tailnet-ip>:<port>`, the primary QR the desktop shows) or through **Tailscale Serve**, which exposes the loopback relay over HTTPS on your tailnet (`wss://`, requires TLS-terminating proxy).

## Pairing flow

The relay uses a **pairing token** (43-char base64) that is created once and then **persisted in the OS keychain**, so a phone paired yesterday reconnects automatically after a desktop restart — the phone retries its saved `ws://host/#token` URL with capped backoff, and a per-launch-rotated token would turn every restart into a mandatory re-scan. Rotate it deliberately with **Settings → Remote → New pairing token** (`regen_mobile_pairing_token`). The token rides in the connection URL's fragment:

```
ws://127.0.0.1:<port>/#<token>          # USB bridge (what the desktop's QR encodes;
                                       #  localhost works too over `adb reverse`)
wss://laptop.tailnet-name.ts.net/#<token>  # Tailscale
```

`<port>` is not fixed: the relay binds `127.0.0.1:0` on first launch, takes the OS-assigned port, and persists it to the `mobile.relay_port` setting for reuse on later launches. Read the actual port from the desktop's Remote panel — the panel renders the matching `adb reverse` command for you.

On connect, the phone pairs as the first WebSocket frame. Pairing is **E2E-proof-only**: the phone sends an HMAC-SHA256 *proof* of the token — never the raw token — and both sides derive an XChaCha20-Poly1305 session key from the token via HKDF-SHA256 (per-connection random salt, delivered in `PairOk`). Since 2026-10-01 the proof is **challenge-bound**: the desktop opens with a `PairChallenge` frame carrying a fresh 32-byte nonce, and the phone answers `Hex(HMAC-SHA256(token, "E2E-NONCE-V1" ‖ challenge))`, so a captured proof cannot be replayed against a later connection. The legacy static proof `Hex(HMAC-SHA256(token, "E2E"))` remains the pre-v2 fallback, and the `PairOk` salt is folded with the challenge (`SHA256(challenge ‖ salt)`) rather than used raw. **Settings → Remote → Require challenge-response pairing** refuses the legacy fallback outright. Every post-pair frame is AEAD-encrypted (Binary WS frames, per-direction counter nonces), so a passive on-path observer sees ciphertext, not conversations. There is no raw-token / plaintext fallback: a `Pair` frame without a valid proof is rejected and the connection is dropped within the 30s pairing window, and the phone retries with capped exponential backoff (3s doubling to 60s per launch). Five consecutive failed proofs trigger a 60-second lockout.

### Option A: USB bridge (adb)

1. Connect the phone via USB with debugging enabled.
2. On the desktop, open **Settings → Remote** and note the relay port it shows (e.g. `54321`).
3. Run `adb reverse tcp:<port> tcp:<port>` from a terminal — or copy the command the Remote panel renders for you.
4. On the phone, open **Settings → Desktop Connection**, enter `ws://localhost:<port>/#<token>` (copy the token from the desktop's Remote panel), and tap **Connect**.

Alternatively, scan the **"Local URL (USB bridge)" QR** shown in the desktop Remote panel (it is the panel's primary QR whenever no tailnet/serve URL is available) — it encodes `ws://127.0.0.1:<port>/#<token>`.

### Option B: Tailscale Serve (recommended for remote)

**Prerequisites:**
- [Tailscale](https://tailscale.com/download) installed and logged in on **both** the desktop and the phone (same tailnet).
- Tailscale CLI on the desktop (`tailscale` command available on PATH — the Windows installer includes it).

**Steps:**

1. On the desktop, open **Settings → Remote → Tailscale**.
2. The panel shows the Tailscale status:
   - **Not installed** — download from [tailscale.com](https://tailscale.com/download).
   - **Not logged in** — click **Log in** in the panel (the app runs `tailscale up`, which opens the browser auth flow), or run `tailscale up` from a terminal.
   - **Logged in** — your machine's tailnet DNS name is shown (e.g. `laptop.tailnet-name.ts.net`).
3. Tap **Enable serve**. The desktop runs `tailscale serve --bg --https=443 http://127.0.0.1:<port>` (background mode; TLS is terminated by tailscaled), and the resulting `wss://` URL is shown.
4. Scan the QR code (or manually enter the URL on the phone). The QR encodes `wss://<machine>.<tailnet>.ts.net/#<token>`.

> Tip: if both devices are on the same tailnet, you can skip Serve entirely and scan the **direct tailnet QR** (primary QR in the Remote panel) — it encodes `ws://<tailnet-ip>:<port>/#<token>` and connects without the HTTPS proxy.
5. On the phone, open **Settings → Desktop Connection → Scan QR**. Point the camera at the desktop's QR code.
6. The phone connects automatically.

**To disable:** tap **Disable serve** in the desktop Remote panel. This runs `tailscale serve off` and removes the public URL.

## Mobile attachments

The phone's ChatComposer has an attach button (📎) that opens the document picker. Selected files are:

- **Images** (png, jpg, jpeg, gif, webp, bmp) — sent as base64 with MIME type.
- **Documents** (pdf, docx, pptx, xlsx, txt, code files) — sent as base64 with format extension. The desktop extracts text via its office-to-text pipeline.
- **Text files** — sent as UTF-8 inline text.

All three share one per-file cap (25 MB) enforced identically by the desktop's send path (`MAX_ATTACHMENT_BYTES`), so the phone never rejects a file the desktop would accept.

The desktop processes mobile attachments through the same path as desktop-attached files: images go to the vision model, documents are text-extracted and inlined, text is appended to the message.

## What the phone deliberately does NOT mirror

The phone mirrors the *chat and project* surfaces of the desktop. The domains below are intentionally desktop-only. They are not gaps, not stubs, and not silently failing — no relay op exists for them, so nothing on the phone can half-work or appear broken. (A partial exception is the terminal, noted in its row below.)

| Domain | Why it stays on the desktop |
|---|---|
| **Vault** (secrets, credentials, keychain) | The vault holds the API keys every proxied request uses. Exposing read/write over the relay would turn a paired phone into a key exfiltration surface for anyone who steals it. The phone never holds keys — all requests are proxied through the desktop, which is the whole point of the relay's security model. |
| **Terminal pane — create/spawn/resize is desktop-only** | The phone *does* mirror a live pane: `GetTranscript` returns the rendered vt100 screen (a snapshot, not the raw byte stream, since TUI redraw sequences would be unreadable concatenated) and `SendToSession` writes into the desktop's live pane (a `\r` terminates the line). What stays desktop-only is **spawning** a new shell or resizing one — starting a process is a remote-code-execution primitive, so it must be a deliberate desktop action. Existing panes are reviewable and drivable from the phone. |
| **Browser pane** (Playwright/CDP control) | Same class as the terminal: driving a logged-in desktop browser from a paired phone is account takeover. |
| **PR workflow** (PR list, create/review/merge) | Merging is irreversible from a phone and GitHub credentials live on the desktop. The phone gets the *read/write* Git surface (status, diff, per-file review, commit, push, branches, log) so review is possible anywhere; the merge decision stays deliberate and at a keyboard. |
| **Settings administration** (provider keys, model config, appearance, hooks, updater) | Changing providers or hooks rewrites what the agent is allowed to do. The phone can pick a model and effort per chat and manage budgets, but cannot install capability or redirect credentials. |
| **RAG / embedding index management** | Index rebuilds are long-running desktop jobs over the local corpus. The phone can search chat history (`SearchChatMessages`), which is the part that is useful away from the desk. |
| **Project wiki** (`src-tauri/src/wiki/`) | Generation and claims-ledger maintenance are long-running desktop jobs derived from git and the local checkout; the phone reads chat results that already cite it. |
| **Declarative subagents** (`chat/subagents.rs`) | Authoring a subagent changes what the agent is permitted to do, so it stays behind the desktop's approval surface. |
| **LLM request log / gateway** (`src-tauri/src/llm_log/`) | It captures raw prompts and responses from every local-model call; exposing it over the relay would be a transcript-exfiltration surface. |
| **GitHub Issues** | Creating and closing issues is outward-facing and irreversible from a phone, in the same class as the merge decision below. |
| **Image generation, TTS** | Desktop-only media jobs that write into desktop-managed artifact directories. Their *outputs* are fully visible on the phone through the artifact gallery and previews. |
| **Updater** | Installing a desktop build from a phone would replace the binary executing the very relay serving the request. |

The rule of thumb: if a surface can grant capability, hold a credential, or run a command, it stays on the desktop; if it reads or shapes work already in a chat, it ships to the phone.

## Error handling on management surfaces

Every non-chat relay arm (git, memory, skills, projects, budgets, sessions, artifacts, automations, connectors) answers a failure with an explicit `ChatError` tagged with its domain rather than an empty list. The phone routes those to a dismissible error bar on the affected screen, so a failed request reads as a failure instead of an empty page. A `GetSessionMeta` for a session that doesn't exist is likewise an error — the phone never renders a plausible header for a deleted chat.

## Security model

| Layer | Protection |
|---|---|
| Network bind | `127.0.0.1` always; the tailnet interface additionally when on a tailnet (CGNAT-range — unreachable from the LAN) |
| Pairing | Keychain-persisted token (43-char base64, reused across restarts so a paired phone reconnects automatically; rotate via Settings → Remote), challenge-bound constant-time HMAC proof, 30s window, 5-failure/60s lockout |
| Payload encryption | XChaCha20-Poly1305 session key derived via HKDF-SHA256 from the pairing token; per-direction counter nonces; raw token never on the wire. See `CONTRACT.md` → Mobile Relay for the full protocol |
| TLS | Via Tailscale Serve (HTTPS/WSS) — the relay itself is plain WS behind the proxy. Direct tailnet connections are WS without TLS, but always E2E-encrypted at the payload layer |
| API keys | Phone never holds keys — all requests proxied through the desktop |

The relay performs no Host/Origin validation and no path routing — it relies entirely on the bind posture + pairing token. For cross-network access, use the tailnet bind or **Tailscale Serve** rather than exposing the port directly.

## Rebuilding the mobile app

The QR scanner requires `expo-camera`, which needs a native module. If you're running the Expo Go client, you'll need a **development build** instead:

```bash
cd mobile
npx expo install
npx expo prebuild           # generates native projects
npx expo run:android        # or run:ios
```

For development with fast refresh, use a dev client:

```bash
npx expo start --dev-client
```

The document picker (`expo-document-picker`) does not require a plugin entry on Android (uses the system file picker) but needs iCloud entitlement on iOS.
