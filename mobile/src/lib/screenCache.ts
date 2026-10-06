/**
 * screenCache — a PERSISTENT stale-while-revalidate cache for every data
 * screen, following the pattern the ChatGPT / Claude / Gmail apps use:
 *
 *   1. the UI always paints from the LOCAL cache first (instant),
 *   2. a background refresh replaces it when the network answers,
 *   3. the cache survives process restarts (they use SQLite/MMKV; here it's
 *      AsyncStorage — a single JSON blob, hydrated once at boot).
 *
 * Screens seed `useState` initial values from `screenCacheGet` and write back
 * through `screenCacheSet` on every event; navigation and cold starts both
 * paint last-known data instantly instead of blanking to a spinner.
 *
 * Entries larger than MAX_ENTRY_JSON are kept in memory but skipped on disk
 * (they'd bloat the blob for little gain — e.g. artifact library payloads).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORE_KEY = 'screenCache.v1';
const MAX_ENTRY_JSON = 150_000;
const SAVE_DEBOUNCE_MS = 600;

const cache = new Map<string, unknown>();
let hydrated = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Load the persisted blob once at app boot. Call as early as possible
 *  (App.tsx). Screens mounted before hydration simply miss the seed on their
 *  first mount — the next one picks it up. */
export async function hydrateScreenCache(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY);
    if (raw) {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) cache.set(k, v);
    }
  } catch {
    // Corrupt or missing blob — start empty; the next successful refresh
    // re-persists everything.
  }
  hydrated = true;
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of cache) {
        let json: string | undefined;
        try {
          json = JSON.stringify(v);
        } catch {
          continue;
        }
        if (json.length <= MAX_ENTRY_JSON) obj[k] = v;
      }
      void AsyncStorage.setItem(STORE_KEY, JSON.stringify(obj)).catch(() => {});
    } catch {
      // Serialization failure — memory cache stays authoritative.
    }
  }, SAVE_DEBOUNCE_MS);
}

export function screenCacheGet<T>(key: string): T | undefined {
  return cache.get(key) as T | undefined;
}

export function screenCacheSet(key: string, value: unknown): void {
  cache.set(key, value);
  if (hydrated) scheduleSave();
}

/** True when the key has ever been written — distinguishes "no data yet"
 *  (show the loading spinner) from "loaded and genuinely empty" (show the
 *  empty-state text). */
export function screenCacheHas(key: string): boolean {
  return cache.has(key);
}
