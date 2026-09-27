// One blob: object URL per data: URL, shared by every surface that shows the
// same image.
//
// The wallpaper is painted in three places — the shell's CSS layer
// (useWallpaper), the settings live preview, and the small upload thumbnail —
// and all three used to inline the raw data: URL. A CSS declaration silently
// drops values past ~1.3MB (see lib/objectUrl.ts), so a real photo rendered
// in NEITHER the shell nor the previews: the custom upload showed no preview at
// all while the bundled presets (small, referenced by URL) always did.
//
// The conversion is refcounted and shared: every holder of the same data URL
// gets the same blob URL, and the blob is revoked only when the last one lets
// go (see lib/objectUrl.ts).
import { useEffect, useState } from "react";

import { acquireObjectUrl, releaseObjectUrl } from "../lib/objectUrl";

/** `dataUrl` → a `blob:` URL the browser accepts anywhere, or `null` when
 *  there is nothing to show. Non-data input (a bundled preset path) passes
 *  through untouched. */
export function useObjectUrl(dataUrl: string | null | undefined): string | null {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!dataUrl) {
      setObjectUrl(null);
      return;
    }
    // Already a plain URL (a bundled preset) — nothing to convert.
    if (!dataUrl.startsWith("data:")) {
      setObjectUrl(dataUrl);
      return;
    }
    const url = acquireObjectUrl(dataUrl);
    setObjectUrl(url);
    return () => releaseObjectUrl(dataUrl);
  }, [dataUrl]);

  return objectUrl;
}
