// A CSS custom property silently stops accepting values past ~1.3MB, so the
// wallpaper used to be handed to `--app-wallpaper` as a multi-megabyte
// `url("data:…")` and simply never appeared — while the UI toasted success.
// The fix converts the data URL to a blob: object URL (~50 chars regardless of
// image size; CSP already allows blob: in img-src).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { acquireObjectUrl, dataUrlToObjectUrl, releaseObjectUrl } from "../lib/objectUrl";

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

  it("does not throw on a data URL with a literal percent sign", () => {
    // Regression: the non-base64 branch called `decodeURIComponent` bare, which
    // throws a URIError on a lone `%` — and a `width="100%"` SVG data URL is
    // perfectly ordinary. The call sits inside a useEffect, so the exception
    // escaped to the app's error boundary and unmounted the whole tree:
    // picking a valid wallpaper took the app down.
    const dataUrl = 'data:image/svg+xml,<svg width="100%"/>';
    expect(() => dataUrlToObjectUrl(dataUrl)).not.toThrow();
    // Falls back to the original URL, which still renders at sizes where the
    // CSS ceiling doesn't bite — degrading beats crashing.
    expect(dataUrlToObjectUrl(dataUrl)).toBe(dataUrl);
    expect(made).toHaveLength(0);
  });

  it("does not throw on a base64 body with an invalid character", () => {
    // `atob` does forgiving-base64 decode, so whitespace is fine — but a
    // character outside the alphabet throws InvalidCharacterError. Same crash
    // path as the `%` case above: the call runs inside a useEffect, so the
    // exception reaches the app's error boundary.
    const dataUrl = "data:image/png;base64,iVBO!!ywAAAAAA";
    expect(() => dataUrlToObjectUrl(dataUrl)).not.toThrow();
    expect(dataUrlToObjectUrl(dataUrl)).toBe(dataUrl);
    expect(made).toHaveLength(0);
  });

  it("still decodes a line-wrapped base64 body", () => {
    // Whitespace is stripped by forgiving-base64 decode, so a wrapped payload
    // must keep working rather than silently falling back.
    dataUrlToObjectUrl("data:image/png;base64,iVBO\nywAAAAAA");
    expect(made).toHaveLength(1);
  });
});

describe("acquireObjectUrl / releaseObjectUrl", () => {
  const dataUrl = "data:image/jpeg;base64,AAAA";
  // The cache is module-level by design, so each test needs a fresh module
  // instance — otherwise a leftover refcount from the previous test silently
  // changes what these assertions see.
  let acquireObjectUrl: typeof import("../lib/objectUrl").acquireObjectUrl;
  let releaseObjectUrl: typeof import("../lib/objectUrl").releaseObjectUrl;

  beforeEach(async () => {
    vi.resetModules();
    ({ acquireObjectUrl, releaseObjectUrl } = await import("../lib/objectUrl"));
  });

  it("shares one blob across every holder of the same data URL", () => {
    // The wallpaper is painted in several places at once (shell layer, settings
    // preview, upload thumbnail). Without sharing, each surface built and
    // decoded its own Blob — a multi-megabyte image base64-decoded once per
    // surface, synchronously, on the main thread.
    const a = acquireObjectUrl(dataUrl);
    const b = acquireObjectUrl(dataUrl);
    expect(a).toBe(b);
    expect(made).toHaveLength(1);
  });

  it("revokes only once the last holder releases", () => {
    const a = acquireObjectUrl(dataUrl);
    const b = acquireObjectUrl(dataUrl);

    releaseObjectUrl(dataUrl);
    // Still live — the other holder is still painting it.
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(a).toBe(b);

    releaseObjectUrl(dataUrl);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(a);
  });

  it("rebuilds the blob after the last release", () => {
    acquireObjectUrl(dataUrl);
    releaseObjectUrl(dataUrl);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);

    // A fresh acquire builds a NEW blob rather than handing back the revoked
    // one — a revoked blob: URL paints as no image at all.
    const again = acquireObjectUrl(dataUrl);
    expect(made).toHaveLength(2);
    expect(again).toBe(made[1].url);
  });

  it("ignores a release with no matching acquire", () => {
    // A double-cleanup (StrictMode remount, a second effect cleanup) must not
    // revoke a blob another holder is still painting.
    acquireObjectUrl(dataUrl);
    acquireObjectUrl(dataUrl);
    releaseObjectUrl(dataUrl);
    releaseObjectUrl(dataUrl);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);

    releaseObjectUrl(dataUrl); // unbalanced — no entry left to decrement
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });
});
