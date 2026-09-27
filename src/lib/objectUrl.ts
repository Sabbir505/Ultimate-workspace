// Blob-URL conversion for large `data:` URLs.
//
// A CSS custom property silently stops accepting values past roughly 1.3 MB
// (measured in Chromium/WebView2): `setProperty` keeps the PREVIOUS value and
// the new one is dropped with no error. So a multi-megabyte wallpaper handed to
// `--app-wallpaper` as `url("data:image/jpeg;base64,…")` never lands — the
// layer keeps painting whatever it had (usually `none`) and the wallpaper
// simply doesn't appear, while the UI reports success.
//
// The blob URL is ~50 characters no matter how big the image is, and the app's
// CSP already allows `blob:` in img-src. The bytes still cross the IPC once (as
// they always have); only the CSS hand-off changes.

/** Turn a `data:` URL into a `blob:` object URL the browser will accept
 *  anywhere a normal image URL goes. Non-data input is returned untouched, so
 *  callers can pass either shape.
 *
 *  Never throws. A data URL is untrusted input — `atob` rejects a body with
 *  characters outside the base64 alphabet, and the non-base64 branch's
 *  `decodeURIComponent` throws a URIError on a literal `%` (`data:image/svg+xml,<svg
 *  width="100%"/>` is a perfectly ordinary SVG data URL). Callers run this
 *  inside an effect, where an exception escapes to the app's error boundary and
 *  unmounts the whole tree — so picking a wallpaper would take the app down. On
 *  any failure the original URL is returned: a small data URL still renders
 *  inline, which is exactly where the 1.3MB CSS ceiling doesn't bite. */
export function dataUrlToObjectUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || comma === -1) return dataUrl;
  const header = dataUrl.slice("data:".length, comma);
  const isBase64 = header.endsWith(";base64");
  const mime = (isBase64 ? header.slice(0, -";base64".length) : header) || "application/octet-stream";
  const payload = dataUrl.slice(comma + 1);
  try {
    let bytes: Uint8Array<ArrayBuffer>;
    if (isBase64) {
      const binary = atob(payload);
      bytes = new Uint8Array(new ArrayBuffer(binary.length));
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(payload));
    }
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  } catch {
    return dataUrl;
  }
}

/** Refcounted cache so every surface showing the same data URL shares ONE
 *  blob (and one decode). The wallpaper is painted in several places at once —
 *  the shell layer, the settings preview, the upload thumbnail — and a
 *  per-instance conversion meant a multi-megabyte image was base64-decoded
 *  once per surface, synchronously, on the main thread. */
const cache = new Map<string, { url: string; refs: number }>();

/** Get the shared blob URL for `dataUrl`, taking a reference. Pair every call
 *  with exactly one `releaseObjectUrl` for the same key. */
export function acquireObjectUrl(dataUrl: string): string {
  const hit = cache.get(dataUrl);
  if (hit) {
    hit.refs += 1;
    return hit.url;
  }
  const url = dataUrlToObjectUrl(dataUrl);
  cache.set(dataUrl, { url, refs: 1 });
  return url;
}

/** Drop a reference taken by `acquireObjectUrl`, revoking the blob once the
 *  last holder lets go. */
export function releaseObjectUrl(dataUrl: string): void {
  const hit = cache.get(dataUrl);
  if (!hit) return;
  hit.refs -= 1;
  if (hit.refs <= 0) {
    URL.revokeObjectURL(hit.url);
    cache.delete(dataUrl);
  }
}
