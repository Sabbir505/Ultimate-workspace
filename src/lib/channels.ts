// Typed `Channel<T>` wrappers for high-frequency backend streams.
//
// Replaces the global `app.emit` / `safeListen` event bus for per-pane
// raw-byte streams AND per-session chat-token streams. Why: `emit` is a
// global broadcast (every listener in every window gets the message) +
// each event is JSON-serialized on the Rust side. For PTY output
// (50-200 events/sec, each up to 64 KB) the JSON cost is the dominant
// per-keystroke CPU. `Channel<T>` is a typed, point-to-point stream — one
// sender, one receiver, no global fan-out, no JSON envelope.
//
// Frontend usage:
//   const ch = await ptyChannel(paneId);
//   ch.onmessage = (msg) => term.write(new Uint8Array(msg.data));
//   // on unmount: ch.onmessage = null;  (no explicit close needed — the
//   // channel is dropped when the consumer goes out of scope)
//
// In tests / when the Tauri runtime is absent, `ptyChannel` /
// `chatTokenChannel` reject and the caller falls back to
// `safeListen("pty:output", ...)` / `safeListen("chat:token", ...)` (see
// `TerminalPane.tsx`, `useChatEvents.ts`).
import { Channel, invoke } from "@tauri-apps/api/core";
import type { ChatTokenPayload } from "./ipc";

/** Subscribe to a pane's raw PTY output. The returned channel emits
 *  `{ data: number[] }` per coalesced frame (16ms/64KB window). */
export async function ptyChannel(paneId: string): Promise<Channel<number[]>> {
  const ch = new Channel<number[]>();
  await invoke("pty_subscribe", { paneId, channel: ch });
  return ch;
}

/** Subscribe to a chat session's token stream. The returned channel emits
 *  `ChatTokenPayload` (same shape as the legacy `chat:token` event) per
 *  token. Used by `useChatEvents` to drive the streaming message bubble. */
export async function chatTokenChannel(
  sessionId: string,
): Promise<Channel<ChatTokenPayload>> {
  const ch = new Channel<ChatTokenPayload>();
  await invoke("chat_token_subscribe", { sessionId, channel: ch });
  return ch;
}
