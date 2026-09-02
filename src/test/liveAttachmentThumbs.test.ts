// Sent-message thumbnail cache (state/chat liveAttachmentCache).
//
// Attachments persist as text markers inside message content — the backend
// never stores the bytes — so a persisted user row used to lose its image
// thumbnail the moment a refetch replaced the optimistic bubble. sendMessage
// now remembers the live attachments under the exact role+content the
// backend persists, and MessageBubble consults the cache, so thumbnails
// survive the optimistic → persisted swap, refetches, and chat switches for
// the whole app session.
import { describe, expect, it } from "vitest";
import {
  liveAttachmentsForMessage,
  rememberLiveAttachments,
} from "../state/chat";

const pngAttachment = {
  name: "image.png",
  kind: "image" as const,
  data: "iVBORw==",
  mediaType: "image/png",
};

describe("liveAttachmentsForMessage", () => {
  it("returns the remembered attachments for the exact persisted content", () => {
    const content = "look at this\n\n[Attached image: image.png]";
    rememberLiveAttachments("s1", content, [pngAttachment]);
    expect(liveAttachmentsForMessage({ chatSessionId: "s1", content })).toEqual([
      pngAttachment,
    ]);
  });

  it("misses for other sessions or different content", () => {
    const content = "look at this\n\n[Attached image: image.png]";
    rememberLiveAttachments("s1", content, [pngAttachment]);
    expect(
      liveAttachmentsForMessage({ chatSessionId: "s2", content }),
    ).toBeUndefined();
    expect(
      liveAttachmentsForMessage({ chatSessionId: "s1", content: "different" }),
    ).toBeUndefined();
  });

  it("returns undefined for history this run never sent", () => {
    expect(
      liveAttachmentsForMessage({
        chatSessionId: "s-none",
        content: "[Attached image: old.png]",
      }),
    ).toBeUndefined();
  });

  it("evicts the oldest entries beyond the cap instead of growing forever", () => {
    // Each image attachment holds its full base64 — the cache must stay
    // bounded. Fill past the cap (100) and check the FIRST entry fell out
    // while a recent one survives.
    const first = "first\n\n[Attached image: a.png]";
    rememberLiveAttachments("s-cap", first, [{ ...pngAttachment, name: "a.png" }]);
    for (let i = 0; i < 100; i++) {
      rememberLiveAttachments("s-cap", `m${i}\n\n[Attached image: a.png]`, [
        { ...pngAttachment, name: "a.png" },
      ]);
    }
    expect(
      liveAttachmentsForMessage({ chatSessionId: "s-cap", content: first }),
    ).toBeUndefined();
    expect(
      liveAttachmentsForMessage({
        chatSessionId: "s-cap",
        content: "m99\n\n[Attached image: a.png]",
      }),
    ).toEqual([{ ...pngAttachment, name: "a.png" }]);
  });
});
