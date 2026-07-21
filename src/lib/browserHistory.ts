// Local navigation history for the browser pane. Cross-origin iframes don't
// expose their history, so the pane keeps its own stack of URLs the user
// explicitly navigated to. Pure and unit-tested; BrowserPane holds it in state.

export interface BrowserHistory {
  stack: string[];
  index: number;
}

export const DEFAULT_BROWSER_URL = "https://www.google.com";

export function createHistory(initial: string): BrowserHistory {
  return { stack: [initial], index: 0 };
}

/** Push a new URL, dropping any forward entries (standard browser semantics). */
export function pushUrl(history: BrowserHistory, url: string): BrowserHistory {
  const stack = [...history.stack.slice(0, history.index + 1), url];
  return { stack, index: stack.length - 1 };
}

export function goBack(history: BrowserHistory): BrowserHistory {
  return canGoBack(history) ? { ...history, index: history.index - 1 } : history;
}

export function goForward(history: BrowserHistory): BrowserHistory {
  return canGoForward(history) ? { ...history, index: history.index + 1 } : history;
}

export function canGoBack(history: BrowserHistory): boolean {
  return history.index > 0;
}

export function canGoForward(history: BrowserHistory): boolean {
  return history.index < history.stack.length - 1;
}

export function currentUrl(history: BrowserHistory): string {
  return history.stack[history.index];
}

/** Add a scheme when the user typed a bare host ("localhost:5173"). */
/** Bing: verified (2026-07) to serve results without X-Frame-Options or a
 *  frame-ancestors CSP, so it actually renders inside the iframe pane —
 *  Google/DDG/DDG-lite all refuse to embed. */
export const SEARCH_ENGINE_URL = "https://www.bing.com/search?q=";

/**
 * Omnibox heuristic (standard browser behavior): explicit schemes and
 * host-looking inputs (localhost, IPs, anything with a dot and no spaces)
 * navigate directly; everything else is a search query.
 * Note: most search engines send X-Frame-Options, so a search results page
 * may refuse to embed — the pane's "didn't respond" overlay covers that.
 */
export function looksLikeUrl(input: string): boolean {
  if (/\s/.test(input)) return false;
  // localhost / IPv4, optional port and path
  if (/^(localhost|(\d{1,3}\.){3}\d{1,3})(:\d+)?(\/|$)/i.test(input)) return true;
  // anything domain-shaped: contains a dot (example.com, example.com/path)
  return input.includes(".");
}

export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return DEFAULT_BROWSER_URL;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return trimmed;
  if (looksLikeUrl(trimmed)) return `http://${trimmed}`;
  return `${SEARCH_ENGINE_URL}${encodeURIComponent(trimmed)}`;
}
