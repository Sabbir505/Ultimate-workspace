// Visual attachment cards rendered ABOVE the message text bubble.
//
// Attachments are not stored as structured data on a persisted message — at
// send time they're folded into the message `content` as text markers (see
// state/chat.ts and src-tauri/src/chat/commands.rs::process_attachments):
//   [Attached image: NAME]                              → image
//   Attached file: NAME\n```\nEXTRACTED_TEXT\n```       → doc/text with content
//   [Attached file NAME could not be read as text.]     → unreadable doc
//
// This module parses those markers out of the content, renders each as a
// rounded preview card (image thumbnail for images, a file card with ext
// badge + content preview for docs/text), and returns the cleaned text with
// the markers removed so they no longer appear as inline plain text.
//
// For the optimistic just-sent message, real ChatAttachment objects (with the
// image base64) can be passed in `liveAttachments` so images get a genuine
// thumbnail even before the backend persists anything.
import type { ChatAttachmentInput } from "../../lib/ipc";

/** A parsed attachment to render as a card. */
export interface ParsedAttachment {
  /** Stable key. */
  key: string;
  /** Original filename. */
  name: string;
  /** "image" | "doc" | "text" — drives the card style. */
  kind: "image" | "doc" | "text";
  /** Upper-cased extension / label badge, e.g. "PDF", "PNG", "PASTED". */
  badge: string;
  /** For doc/text: a short excerpt of the extracted content (preview). */
  preview?: string;
  /** For the optimistic message: a live image data URI (base64). */
  thumbDataUri?: string;
}

/** A single combined regex matching any attachment marker, with three
 *  alternatives captured positionally: group 1 = image name, group 2 =
 *  unreadable-doc name, group 3 = doc name, group 4 = doc body. Matched in one
 *  pass (matchAll) so attachments come out in document order regardless of kind. */
const RE_ANY =
  /(?:\n*\[Attached image: ([^\]]+)\]\n*)|(?:\n*\[Attached file ([^\]]+) could not be read as text\.\]\n*)|(?:\n*Attached file: (.+?)\n```(?:\r?\n)([\s\S]*?)\r?\n```)/g;

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

function badgeFor(name: string, kind: ParsedAttachment["kind"]): string {
  if (kind === "image") {
    const e = extOf(name).toUpperCase();
    return e || "IMAGE";
  }
  const e = extOf(name).toUpperCase();
  return e || "FILE";
}

/** Parse attachment markers out of `content`. Returns the list of attachments
 *  (in document order) and the content with every marker stripped, so the
 *  bubble shows clean text + the cards above it. */
export function parseAttachments(
  content: string,
  liveAttachments?: ChatAttachmentInput[],
): { attachments: ParsedAttachment[]; text: string } {
  const attachments: ParsedAttachment[] = [];
  let i = 0;

  // Collect every match in document order, then strip them all in one pass.
  for (const m of content.matchAll(RE_ANY)) {
    if (m[1] != null) {
      // [Attached image: NAME]
      const name = m[1].trim();
      attachments.push({
        key: `img-${i++}`,
        name,
        kind: "image",
        badge: badgeFor(name, "image"),
      });
    } else if (m[2] != null) {
      // [Attached file NAME could not be read as text.]
      const name = m[2].trim();
      attachments.push({
        key: `unread-${i++}`,
        name,
        kind: "doc",
        badge: badgeFor(name, "doc"),
        preview: "Could not be read as text",
      });
    } else if (m[3] != null) {
      // Attached file: NAME\n```\nBODY\n```
      const name = m[3].trim();
      const body = (m[4] ?? "").trim();
      const ext = extOf(name);
      attachments.push({
        key: `doc-${i++}`,
        name,
        kind: ext && ["docx", "pptx", "xlsx", "pdf", "doc", "ppt", "xls"].includes(ext) ? "doc" : "text",
        badge: badgeFor(name, "doc"),
        preview: body.slice(0, 280),
      });
    }
  }

  const text = attachments.length > 0 ? content.replace(RE_ANY, "") : content;

  // For the optimistic message, attach live image thumbnails by filename match.
  if (liveAttachments && liveAttachments.length > 0) {
    for (const a of attachments) {
      if (a.kind !== "image") continue;
      const live = liveAttachments.find(
        (la) => la.kind === "image" && la.name === a.name,
      );
      if (live?.data && live.mediaType) {
        // MIME allowlist: only forward known image media types to a data:
        // URI. An attacker who controls the `mediaType` field (a model
        // replying to the user with a synthetic attachment marker) could
        // otherwise set text/html, image/svg+xml-with-script, or
        // application/javascript, which a permissive renderer would treat
        // as active content. The frontend receives the marker from the
        // backend (which in turn trusts the user) but defensively the
        // frontend double-checks.
        if (/^image\/(png|jpe?g|gif|webp|bmp)$/i.test(live.mediaType)) {
          a.thumbDataUri = `data:${live.mediaType};base64,${live.data}`;
        }
      }
    }
  }

  return { attachments, text: text.replace(/\n{3,}/g, "\n\n").trim() };
}

function FileGlyph({ kind }: { kind: ParsedAttachment["kind"] }) {
  // Minimal outline file icon; image kind gets a picture glyph.
  if (kind === "image") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="m21 15-5-5L5 21" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

/** A single attachment preview card. Images with a live thumbnail show it;
 *  otherwise a file card with an icon, name, ext/label badge, and an optional
 *  content preview. */
function AttachmentPreviewCard({ att }: { att: ParsedAttachment }) {
  const isImage = att.kind === "image";
  return (
    <div className="msg-attachment-card" title={att.name}>
      <div className="msg-attachment-thumb">
        {isImage && att.thumbDataUri ? (
          <img src={att.thumbDataUri} alt={att.name} loading="lazy" />
        ) : (
          <FileGlyph kind={att.kind} />
        )}
      </div>
      <div className="msg-attachment-meta">
        <span className="msg-attachment-name">{att.name}</span>
        <span className="msg-attachment-badge" data-kind={att.kind}>{att.badge}</span>
      </div>
      {att.preview && (
        <div className="msg-attachment-preview">{att.preview}</div>
      )}
    </div>
  );
}

/** The attachment grid rendered above the message text. Returns null when
 *  there are no attachments, so the bubble layout is unchanged for plain
 *  messages. */
export function MessageAttachments({
  attachments,
}: {
  attachments: ParsedAttachment[];
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="msg-attachments">
      {attachments.map((a) => (
        <AttachmentPreviewCard key={a.key} att={a} />
      ))}
    </div>
  );
}
