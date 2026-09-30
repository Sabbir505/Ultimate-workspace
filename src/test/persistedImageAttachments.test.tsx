// Persisted image attachment cards (the "image is just a PNG glyph after a
// restart" report).
//
// The backend now saves an uploaded image's bytes under the app-data dir and
// records the path inside the message marker, so history can re-render the
// real picture instead of a placeholder. These tests cover the card end: the
// read-over-IPC, the live-bytes-wins case, and the two fallbacks (no path in
// the marker, file unreadable).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

vi.mock("../lib/ipc", () => ({
  readArtifactPreview: vi.fn(),
  downloadArtifact: vi.fn(),
  openArtifact: vi.fn(),
  getFileMtime: vi.fn().mockResolvedValue(null),
}));

const { readArtifactPreview } = await import("../lib/ipc");
const readMock = vi.mocked(readArtifactPreview);

import {
  MessageAttachments,
  parseAttachments,
} from "../components/chat/MessageAttachments";

// A distinct path per case: the data-URI cache is module-level, so reusing
// one path across tests would hit the previous test's entry.
const pathFor = (name: string) => `C:/up/chat-uploads/1756-${name}.png`;

function renderCard(content: string, live?: Parameters<typeof parseAttachments>[1]) {
  const { attachments, text } = parseAttachments(content, live);
  const { container } = render(
    <MessageAttachments attachments={attachments} />,
  );
  return { container, text };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("persisted image attachment previews", () => {
  it("re-reads the saved upload and shows the real image (post-restart case)", async () => {
    readMock.mockResolvedValue({
      path: pathFor("shot"),
      filename: "shot",
      ext: "png",
      kind: "image",
      text: null,
      dataUri: "data:image/png;base64,AAAA",
      size: 4,
      truncated: false,
    } as never);

    const { container } = renderCard(`look\n\n[Attached image: shot.png|${pathFor("shot")}]`);

    // Reads the file the backend persisted for this message…
    await waitFor(() => expect(readMock).toHaveBeenCalledWith(pathFor("shot")));
    // …and renders it as the bare picture instead of the placeholder.
    const img = await waitFor(() => {
      const el = container.querySelector<HTMLImageElement>(".msg-attachment-image");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(img.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    // The image renders as ITSELF — no filename row, no type pill — with the
    // name kept only in the tooltip/alt.
    expect(container.querySelector(".msg-attachment-name")).toBeNull();
    expect(container.querySelector(".msg-attachment-placeholder")).toBeNull();
    expect(img.getAttribute("alt")).toBe("shot.png");
    expect(img.getAttribute("title")).toBe("shot.png");
  });

  it("prefers this run's live bytes over the disk copy", async () => {
    readMock.mockResolvedValue({
      path: pathFor("shot"),
      filename: "shot",
      ext: "png",
      kind: "image",
      text: null,
      dataUri: "data:image/png;base64,FROMDISK",
      size: 4,
      truncated: false,
    } as never);

    const { container } = renderCard(`look\n\n[Attached image: shot.png|${pathFor("shot")}]`, [
      { name: "shot.png", kind: "image", data: "iVBORw==", mediaType: "image/png" },
    ]);

    const img = await waitFor(() => {
      const el = container.querySelector<HTMLImageElement>(".msg-attachment-image");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(img.getAttribute("src")).toBe("data:image/png;base64,iVBORw==");
    // The live bytes made a disk read pointless.
    expect(readMock).not.toHaveBeenCalled();
  });

  it("falls back to the dashed placeholder for old history that has no saved path", async () => {
    const { container } = renderCard(`look\n\n[Attached image: old.png]`);
    await waitFor(() => {
      expect(container.querySelector(".msg-attachment-placeholder")).not.toBeNull();
    });
    expect(container.querySelector(".msg-attachment-image")).toBeNull();
    // The placeholder keeps the name — a bare glyph identifies nothing.
    expect(container.querySelector(".msg-attachment-name")!.textContent).toBe("old.png");
    expect(readMock).not.toHaveBeenCalled();
  });

  it("falls back to the dashed placeholder when the saved file can't be read", async () => {
    readMock.mockRejectedValue(new Error("cannot stat file") as never);
    const { container } = renderCard(`look\n\n[Attached image: gone.png|${pathFor("gone")}]`);
    await waitFor(() => expect(readMock).toHaveBeenCalledWith(pathFor("gone")));
    expect(container.querySelector(".msg-attachment-image")).toBeNull();
    expect(container.querySelector(".msg-attachment-placeholder svg")).not.toBeNull();
    expect(container.querySelector(".msg-attachment-name")!.textContent).toBe("gone.png");
  });
});
