// Base-URL canonicalization for API endpoints. Mirrors the Rust
// `chat::providers::normalize_base_url` (src-tauri/src/chat/providers.rs) —
// keep the two in step: the backend normalizes on save and once over stored
// rows, this one keeps the Settings form honest about what will actually be
// called.

/** Canonicalize a user-supplied provider base URL.
 *
 *  The app appends its own `/v1/...` path to every request
 *  (`{base}/v1/chat/completions`, `{base}/v1/responses`, `{base}/v1/messages`,
 *  `{base}/v1/models`), so a stored base must EXCLUDE that prefix. Provider
 *  docs, though, advertise the full endpoint (`https://host/v1/chat/...`), so
 *  pasting the documented URL produced `.../v1/v1/...` — a 404 from the relay
 *  ("not a registered API route") that reads exactly like a dead API key.
 *  Trailing slashes are dropped for the same reason (`//v1/...`).
 *
 *  Only a pure `/v1` path segment is stripped — never `/v1beta` or `/v10`. */
export function normalizeBaseUrl(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/v1")) {
    const head = trimmed.slice(0, -"/v1".length);
    if (head.length > 0) return head.replace(/\/+$/, "");
  }
  return trimmed;
}
