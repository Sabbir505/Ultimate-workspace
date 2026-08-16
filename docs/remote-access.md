# Remote access — pairing your phone to the desktop

Conduit's desktop app runs a **loopback-only** WebSocket relay (`127.0.0.1:<port>`) that the mobile companion app connects to. The phone never holds API keys — every request is proxied through the desktop session.

There are two ways to bridge the phone to the loopback relay:

1. **USB bridge** (development) — `adb reverse` forwards a phone-side port to the desktop's loopback.
2. **Tailscale Serve** (remote) — the desktop runs `tailscale serve` to expose the loopback relay over HTTPS on your tailnet, and the phone connects via `wss://`.

## Pairing flow

The relay generates a fresh **pairing token** (43-char base64) on each desktop app launch. The token rides in the connection URL's fragment:

```
ws://localhost:54321/#<token>          # USB bridge
wss://laptop.tailnet-name.ts.net/#<token>  # Tailscale
```

On connect, the phone sends the token as the first WebSocket frame (`{ "type": "Pair", "token": "<token>" }`). The desktop validates it before any command is honored; mismatch closes the connection within 30 seconds.

### Option A: USB bridge (adb)

1. Connect the phone via USB with debugging enabled.
2. On the desktop, open **Settings → Remote** and note the relay port (e.g. `54321`).
3. Run `adb reverse tcp:54321 tcp:54321` from a terminal.
4. On the phone, open **Settings → Desktop Connection**, enter `ws://localhost:54321/#<token>` (copy the token from the desktop's Remote panel), and tap **Connect**.

Alternatively, scan the **local fallback QR** shown in the desktop Remote panel — it encodes the full `ws://localhost:<port>#<token>` URL.

### Option B: Tailscale Serve (recommended for remote)

**Prerequisites:**
- [Tailscale](https://tailscale.com/download) installed and logged in on **both** the desktop and the phone (same tailnet).
- Tailscale CLI on the desktop (`tailscale` command available on PATH — the Windows installer includes it).

**Steps:**

1. On the desktop, open **Settings → Remote → Tailscale**.
2. The panel shows the Tailscale status:
   - **Not installed** — download from [tailscale.com](https://tailscale.com/download).
   - **Logged out** — run `tailscale login` from a terminal.
   - **Ready** — your machine's tailnet DNS name is shown (e.g. `laptop.tailnet-name.ts.net`).
3. Tap **Enable Tailscale Serve**. The desktop runs `tailscale serve --bg https+insecure://http://127.0.0.1:<port>` (background mode), and the resulting `wss://` URL is shown.
4. Scan the QR code (or manually enter the URL on the phone). The QR encodes `wss://<machine>.<tailnet>.ts.net/#<token>`.
5. On the phone, open **Settings → Desktop Connection → Scan QR**. Point the camera at the desktop's QR code.
6. The phone connects automatically.

**To disable:** tap **Disable Tailscale Serve** in the desktop Remote panel. This runs `tailscale serve off` and removes the public URL.

## Mobile attachments

The phone's ChatComposer has an attach button (📎) that opens the document picker. Selected files are:

- **Images** (png, jpg, gif, webp) — sent as base64 with MIME type, up to 15 MB.
- **Documents** (pdf, docx, pptx, xlsx, txt, code files) — sent as base64 with format extension, up to 10 MB. The desktop extracts text via its office-to-text pipeline.
- **Text files** — sent as UTF-8 inline text, up to 512 KB.

The desktop processes mobile attachments through the same path as desktop-attached files: images go to the vision model, documents are text-extracted and inlined, text is appended to the message.

## Security model

| Layer | Protection |
|---|---|
| Network bind | `127.0.0.1` only — not reachable from LAN without a tunnel |
| Pairing | Per-launch token (43-char base64), constant-time compared, 30s timeout |
| TLS | Via Tailscale Serve (HTTPS/WSS) — the relay itself is plain WS behind the proxy |
| API keys | Phone never holds keys — all requests proxied through the desktop |

The relay performs no Host/Origin validation and no path routing — it relies entirely on the loopback bind + pairing token. For cross-network access, **always use Tailscale Serve** rather than exposing the port directly.

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
