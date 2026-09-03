// Interactive citation chip rendered in place of `[1]` / `[1,2]` / `(1,2)`
// markers in assistant markdown. Hovering (or focusing) shows a preview of the
// linked source(s) — title + host, one row per cited number; clicking opens
// the source in the built-in browser pane (same routing as chat markdown
// links, never the system browser). Each row inside the tooltip is itself
// clickable, so with `(1,2)` the user can pick which source to open.
import { openInBrowserPane } from "../../lib/openBrowserPane";
import type { ChatSource } from "../../lib/chatCitations";

export function ChatCitation({ nums, sources }: { nums: number[]; sources: ChatSource[] }) {
  const resolved = nums
    .map((n) => sources.find((s) => s.n === n))
    .filter((s): s is ChatSource => !!s);
  if (resolved.length === 0) return null;

  const open = (url: string) => openInBrowserPane(url);

  return (
    // onMouseDown preventDefault: clicking the chip must not collapse a text
    // selection the user is building (the chip sits inside selectable text).
    <span
      className="chat-citation"
      role="link"
      tabIndex={0}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        open(resolved[0].url);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open(resolved[0].url);
        }
      }}
      aria-label={`Citation ${nums.join(", ")}: ${resolved.map((s) => s.title).join("; ")}`}
    >
      <span className="chat-citation-nums">{nums.join(",")}</span>
      <span className="chat-citation-tip" role="tooltip">
        <span className="chat-citation-tip-head">
          {resolved.length === 1 ? "Source" : "Sources"}
        </span>
        {resolved.map((s) => (
          <button
            key={s.n}
            type="button"
            className="chat-citation-tip-row"
            title={s.url}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              open(s.url);
            }}
          >
            <span className="chat-citation-tip-num">[{s.n}]</span>
            <span className="chat-citation-tip-body">
              <span className="chat-citation-tip-title">{s.title}</span>
              <span className="chat-citation-tip-url">{displayUrl(s.url)}</span>
            </span>
          </button>
        ))}
      </span>
    </span>
  );
}

/** Trim a URL for the tooltip's secondary line: scheme stripped, host kept,
 *  long paths elided. */
function displayUrl(url: string): string {
  let out = url.replace(/^https?:\/\//i, "");
  try {
    const u = new URL(url);
    out = u.host.replace(/^www\./, "") + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    /* keep the scheme-stripped form */
  }
  if (out.length > 46) out = `${out.slice(0, 45)}…`;
  return out;
}
