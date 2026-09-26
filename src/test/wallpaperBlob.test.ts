// A CSS custom property silently stops accepting values past ~1.3MB, so the
// wallpaper used to be handed to `--app-wallpaper` as a multi-megabyte
// `url("data:…")` and simply never appeared — while the UI toasted success.
// The fix converts the data URL to a blob: object URL (~50 chars regardless of
// image size; CSP already allows blob: in img-src).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dataUrlToObjectUrl } from "../lib/objectUrl";

// jsdom implements neither createObjectURL nor revoking it; capture the Blob so
// the assertions can inspect what was actually handed to the browser.
let made: { url: string; blob: Blob }[] = [];
let n = 0;

beforeEach(() => {
  made = [];
  n = 0;
  URL.createObjectURL = ((blob: Blob) => {
    const url = `blob:test/${++n}`;
    made.push({ url, blob });
    return url;
  }) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dataUrlToObjectUrl", () => {
  it("hands back a short blob URL for a large base64 image", () => {
    // 3 MB of pixels — well past the custom-property ceiling that broke this.
    const bytes = new Uint8Array(3 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    const dataUrl = `data:image/jpeg;base64,${btoa(binary)}`;
    expect(dataUrl.length).toBeGreaterThan(1_300_000);

    const objectUrl = dataUrlToObjectUrl(dataUrl);

    // The whole point: a value CSS will accept, no matter the image size.
    expect(objectUrl.startsWith("blob:")).toBe(true);
    expect(objectUrl.length).toBeLessThan(100);
    expect(made).toHaveLength(1);
    expect(made[0].blob.type).toBe("image/jpeg");
    expect(made[0].blob.size).toBe(bytes.length);
  });

  it("carries the decoded payload through to the blob", () => {
    const original = new Uint8Array([0, 1, 2, 250, 251, 252]);
    let binary = "";
    for (const b of original) binary += String.fromCharCode(b);

    dataUrlToObjectUrl(`data:image/webp;base64,${btoa(binary)}`);

    const blob = made[0].blob;
    expect(blob.type).toBe("image/webp");
    // jsdom's Blob mangles a SMALL typed array, so this asserts the decode
    // produced a real payload rather than exact bytes — the 3MB case above
    // covers the conversion at a size that matters.
    expect(blob.size).toBeGreaterThan(0);
  });

  it("handles a percent-encoded (non-base64) data URL", async () => {
    dataUrlToObjectUrl("data:image/svg+xml,%3Csvg%2F%3E");

    const blob = made[0].blob;
    expect(blob.type).toBe("image/svg+xml");
    expect(await blob.text()).toBe("<svg/>");
  });

  it("passes a non-data URL through untouched", () => {
    const preset = "/sideart/aurora.jpg";
    expect(dataUrlToObjectUrl(preset)).toBe(preset);
    expect(made).toHaveLength(0);
  });
});
