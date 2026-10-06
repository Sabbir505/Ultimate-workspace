# Agent findings: mobile React Native app (54 files)
# Status: COMPLETE — verified result captured 2026-10-03

FILES COVERED: all 52 .ts/.tsx under mobile/src/ (components/, components/chat/, hooks/, lib/, screens/, theme.tsx) + mobile/App.tsx, mobile/index.ts, mobile/package.json. No app.json/app.config.* at mobile root (verified). Dead-wiring claims verified by grep over mobile/src and App.tsx.

## P0

**1. Unauthenticated, replayable `PairOk.salt` enables cross-connection nonce reuse (E2E break against the relay MITM).**
- useRelay.ts:710 (`_e2eKey = null; _outCounter = 0; _inCounter = 0;` on every connect), :806 (`_e2eKey = deriveSessionKey(_pairingToken, b64UrlToBytes(msg.salt))`). PairOk arrives as a plaintext frame *before* any E2E state exists; nothing binds the salt to this connection's PairChallenge or checks freshness (relayCrypto.ts:34-42 uses `salt ?? te.encode(HKDF_SALT)` as-is). The nonce-uniqueness guarantee in the header ("the key is unique per connection, so the per-connect counter reset can never reuse (key, nonce) pairs — audit C1") rests entirely on an unauthenticated value. A network MITM — precisely the adversary this E2E relay exists to defeat — records connection N's PairOk(salt=S), then on connection N+1 suppresses the desktop's fresh PairOk and replays PairOk(S). The phone re-derives the identical key while both counters restart at 0: frames 0..n encrypted under the same (key, nonce) pairs in both connections — XChaCha20 keystream reuse (plaintext XOR recovery of the mobile's commands/approvals) plus Poly1305 one-time-key reuse (tag forgery). decryptFrame's counter check (relayCrypto.ts:122-125) is per-connection only. Fix: derive freshness from the already-fresh challenge (`salt' = SHA256(challenge || msg.salt)` — mobile has msg.nonce from PairChallenge), or have PairOk echo the challenge and reject mismatches/repeats; refuse a salt equal to the previous connection's.

## P1

**2. App lock is dead code — can never be enabled, and never locks on cold start.**
(a) `setAppLockEnabled` (lib/appLock.ts:28) has zero call sites; SettingsScreen has no security/app-lock row — `isAppLockEnabled()` is always false unless set by an older build; the gate in App.tsx:148 (`{locked && ...}`) is unreachable. (b) Even enabled, cold start bypasses it: appLock.ts:62 `backgroundedAt` is module memory set only by a live-process AppState event, and :77 `if (away === null) return false;` — force-quit + relaunch never shows the gate. The App.tsx comment (:93-95: "an unlocked phone in someone else's hands is otherwise a remote shell in theirs") documents why this matters. Fix: add the Settings toggle; persist backgroundedAt (AsyncStorage stamp on background) and evaluate at app start.

**3. Push notifications completely unwired — approvals/completions never reach the phone when the relay socket is down.**
Every entry point in lib/notifications.ts is dead: `getPushTokenAsync` (:92), `requestPushPermission`, `isTokenRegistered`/`markTokenRegistered`, `onForegroundPush` — zero call sites. `registerPushToken` (useRelay.ts:1122) is returned but never invoked; `PushAck` (:137) never consumed. The module header claims the desktop relays approvals/turn completions/automation results via Expo push when the socket is down — none of that can happen. Compounding: approvals are never journaled either (useRelay.ts:874 SessionApprovalRequest has no journalNotification call, contrast :867/:871/:885/:946/:955). Net: an approval arriving while the user is on another screen or disconnected is invisible — no push, no journal, no banner. Fix: wire getPushTokenAsync + registerPushToken on connect, consume PushAck, journal approvals.

**4. Deep link accepts `http(s)://` hosts, feeds them to `new WebSocket` (throws), after already persisting the URL — permanently un-pairing the phone.**
- lib/deepLinks.ts:80-83: `if (host && /^(wss?|https?):\/\//i.test(host)) { return { url: `${host.split('#')[0]}#${token}`, token }; }` — an https:// host is returned verbatim (presumably tailscale-share links were meant to be normalized to wss://; no conversion happens). User confirms the App.tsx dialog (:81-84), then globalConnect (useRelay.ts:994) runs `setSecureRelayUrl(url)` BEFORE `_doConnect(url)`, and `new WebSocket('https://…#token')` (:717) throws synchronously for non-ws schemes, landing in the catch (:983) with no reconnect timer. The persisted URL is now broken — every cold start (:572-574) loads it and fails; the phone stays un-paired until manual re-entry. Trigger: tap `relay://connect?host=https://machine.ts.net/#token` and press Connect. Fix: map http→ws / https→wss in parseRelayConnectLink; validate scheme in globalConnect (persist only after a successful pair).

## P2

**5. Reconnect backoff defeated by every `useRelay()` mount (and no jitter).**
- useRelay.ts:1077 mount effect fires `globalConnect()` in every consumer; during backoff `_ws`/`_connecting` are false so each navigation cancels the pending backoff timer (:706) and attempts immediately — a connection attempt per navigation while the desktop is down; RECONNECT_BASE/MAX have no jitter. Fix: mount effect respects a pending reconnect; ±20% jitter.

**6. `_send` returns true for frames only queued pending PairOk — user messages silently lost when pairing fails.**
- useRelay.ts:641-654 (queued → still true), :1089-1093 forwarded, useSessionChat.ts:536-557 shows the optimistic bubble + streaming:true. If pairing fails, the socket closes and `_pendingFrames` is discarded on next _doConnect (:711) with no replay and no error; the message text is gone. Fix: replay pending frames on next successful pair, or surface "message not delivered".

**7. `steerQueued` silently drops duplicate queued messages.**
- useSessionChat.ts:718 `filter((q) => q !== text)` removes every copy; only one is re-added (:729-733). Queue "ok" twice while streaming, steer one — the second vanishes. Fix: remove one instance via indexOf/splice (same for cancelQueued :588-590).

**8. Hook-level `connected` seeded from raw socket state, contradicting the "connected = paired" invariant.**
- useRelay.ts:1036 `useState(_ws?.readyState === WebSocket.OPEN)` and :1055 — reports connected:true while OPEN but unpaired, contradicting the nc(true)-on-PairOk design (:815-821); sends are allowed-to-queue then dropped (compounds #6). Fix: seed from a module-level paired flag.

**9. Settings "About" shows hardcoded version 1.0.0 while the app is 0.4.2.**
- SettingsScreen.tsx:377 `1.0.0` vs package.json:3 "0.4.2". Fix: `Constants.expoConfig?.version` (expo-constants already present).
