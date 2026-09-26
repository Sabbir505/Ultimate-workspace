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
 *  callers can pass either shape. The caller owns the result and must
 *  `URL.revokeObjectURL` it when it's replaced. */
export function dataUrlToObjectUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || comma === -1) return dataUrl;
  const header = dataUrl.slice("data:".length, comma);
  const isBase64 = header.endsWith(";base64");
  const mime = (isBase64 ? header.slice(0, -";base64".length) : header) || "application/octet-stream";
  const payload = dataUrl.slice(comma + 1);
  let bytes: Uint8Array<ArrayBuffer>;
  if (isBase64) {
    const binary = atob(payload);
    bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(payload));
  }
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}
