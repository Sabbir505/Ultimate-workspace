/**
 * maskRelayAsk — the phone twin of the desktop helper in src/lib/segments.ts
 * (same algorithm, same rules — kept byte-for-byte in behaviour so the phone
 * and the desktop never disagree about what the model actually said).
 *
 * The backend appends a `RELAY_ASK: {json}` line to every harness prompt
 * (src-tauri/src/agent_sessions/ask.rs) so a turn can ask the user a question:
 * the model must end its reply with one line of exactly that form. The backend
 * strips that line from the PERSISTED reply, but the raw line streams into the
 * live transcript first — without this mask the phone painted the question's
 * JSON as the last paragraph of the answer, right underneath the QuestionCard
 * that already renders it properly.
 *
 * Mirrors the backend's rule with a streaming allowance: the LAST marker line
 * wins; a line that is still streaming (the open tail of the buffer) hides as
 * soon as it looks like the channel — bare marker or a `{` payload; a closed
 * line only stays hidden when its payload parses as a JSON object (wrapped
 * backticks tolerated), so ordinary text mentioning "RELAY_ASK:" is never
 * mistaken for a question.
 */
const RELAY_ASK_MARKER = "RELAY_ASK:";

export function maskRelayAsk(content: string): string {
  const lines = content.split("\n");
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trimStart().startsWith(RELAY_ASK_MARKER)) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return content;
  const openTail = idx === lines.length - 1 && !content.endsWith("\n");
  const rest = lines[idx]
    .trim()
    .slice(RELAY_ASK_MARKER.length)
    .trim()
    .replace(/^`+/, "")
    .replace(/`+$/, "")
    .trim();
  // Open tail = the marker line is still streaming: hide from the marker on
  // once it looks like the channel (the JSON brace may not have arrived yet).
  if (openTail && (rest === "" || rest.startsWith("{"))) {
    return lines.slice(0, idx).join("\n");
  }
  if (!rest.startsWith("{")) return content;
  let parses = false;
  try {
    const v = JSON.parse(rest) as unknown;
    parses = v != null && typeof v === "object";
  } catch {
    parses = false;
  }
  // Closed but not a question payload — show the text, same as the backend's
  // strip-or-keep decision on the persisted reply.
  if (!parses) return content;
  lines.splice(idx, 1);
  return lines.join("\n").trimEnd();
}
