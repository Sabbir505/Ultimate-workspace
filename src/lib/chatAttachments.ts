// Attachment-marker helpers shared by the message bubble (which renders the
// cards) and the chat store (which keys its live-attachment cache by message
// content). They live here, in lib/, so neither has to import the other.
//
// An image attachment is persisted into the message body as a marker:
//   [Attached image: NAME]              → history from before uploads were
//                                         written to disk (thumbnail glyph)
//   [Attached image: NAME|<path on disk>] → current: the backend saves the
//                                         uploaded bytes under the app-data
//                                         dir so the bubble can re-render the
//                                         real image after a restart.
import { useEffect, useState } from "react";
import { readArtifactPreview } from "./ipc";

/** Split a captured image marker into its name and optional on-disk path.
 *  Split on the LAST `|`, which is correct for every name the composer
 *  produces. A filename that itself contains `|` is not representable in this
 *  format — the path still wins, and the card degrades to the glyph. */
export function splitImageMarker(raw: string): { name: string; path?: string } {
  const i = raw.lastIndexOf("|");
  if (i === -1) return { name: raw.trim() };
  return { name: raw.slice(0, i).trim(), path: raw.slice(i + 1).trim() || undefined };
}

/** The same content with every `|<path>` suffix removed from image markers.
 *  Used to key the live-attachment cache: the client builds the optimistic
 *  content (name only) while the backend persists it with the path, and the
 *  cache must still match across that swap or the freshly-sent thumbnail
 *  would be dropped mid-send. */
export function stripImageMarkerPaths(content: string): string {
  return content.replace(/(\[Attached image: [^|\]\n]*)(\|[^\]\n]*)?\]/g, "$1]");
}

/** Decoded image bytes, keyed by path. Bounded like the other render caches:
 *  the message list is virtualized, so rows remount on every scroll and
 *  without this each remount re-read the file over IPC. `null` is a cached
 *  MISS (the file is gone) so a deleted upload isn't re-read on every
 *  remount either. */
const MAX_CACHED = 64;
const imageDataUriCache = new Map<string, string | null>();

function cacheDataUri(path: string, uri: string | null): void {
  imageDataUriCache.delete(path);
  imageDataUriCache.set(path, uri);
  while (imageDataUriCache.size > MAX_CACHED) {
    const oldest = imageDataUriCache.keys().next().value;
    if (oldest === undefined) break;
    imageDataUriCache.delete(oldest);
  }
}

/** Load an on-disk image as a data URI for a persisted attachment card.
 *  Returns null while loading and when the file can't be read, so the caller
 *  can show the placeholder glyph. Never throws. */
export function usePersistedImageDataUri(path: string | undefined): string | null {
  const [uri, setUri] = useState<string | null>(() =>
    path ? (imageDataUriCache.get(path) ?? null) : null,
  );
  useEffect(() => {
    if (!path) {
      setUri(null);
      return;
    }
    const cached = imageDataUriCache.get(path);
    if (cached !== undefined) {
      setUri(cached);
      return;
    }
    let stale = false;
    setUri(null);
    void readArtifactPreview(path)
      .then((preview) => {
        if (stale) return;
        // A file that vanished (or isn't an image) caches as a miss.
        const next = preview?.kind === "image" ? (preview.dataUri ?? null) : null;
        cacheDataUri(path, next);
        setUri(next);
      })
      .catch(() => {
        if (stale) return;
        cacheDataUri(path, null);
        setUri(null);
      });
    return () => {
      stale = true;
    };
  }, [path]);
  return uri;
}
