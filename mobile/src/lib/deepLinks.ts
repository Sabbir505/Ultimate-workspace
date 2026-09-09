import * as Linking from 'expo-linking';

/**
 * Deep links for desktop pairing. The desktop's QR / share button emits
 * `relay://connect#<token>` (token-only — the phone must already know the
 * host) and `relay://connect?host=ws://host:port/#token` (full connect URL).
 *
 * Parsing is deliberately liberal: ANY `relay://…` URL that carries a token
 * fragment is accepted. The token is the text after `#` — either a fragment
 * of the link itself or, when the link embeds a `host=` query param, the
 * fragment inside that URL. The host, when present, is normalized to a
 * connect URL the relay layer already understands: `<ws|wss>://host[:port]#<token>`.
 *
 * Usage (integrator, from App.tsx):
 *   const dispose = initDeepLinkHandling((url) => connect(url));
 *   // call dispose() on unmount.
 */

export interface ParsedRelayLink {
  /** Normalized connect URL (`ws(s)://host[:port]#<token>`) — null when the
   *  link carried only a token and no host. */
  url: string | null;
  /** The pairing token (fragment). */
  token: string;
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Text after the first `#` (percent-decoded, trimmed), or null. */
function fragmentOf(s: string): string | null {
  const idx = s.indexOf('#');
  if (idx === -1) return null;
  const frag = decodeSafe(s.slice(idx + 1)).trim();
  return frag || null;
}

/** First matching query param's value (liberal: no full URL parser — the
 *  host value may itself be a `ws://…#token` URL with separator chars). */
function queryParam(query: string, keys: string[]): string | null {
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = decodeSafe(eq >= 0 ? part.slice(0, eq) : part).toLowerCase();
    if (!keys.includes(key)) continue;
    const value = eq >= 0 ? part.slice(eq + 1) : '';
    return decodeSafe(value).trim() || null;
  }
  return null;
}

/** Parse a `relay://connect…` deep link into { url?, token }. Returns null
 *  for non-relay URLs or relay URLs without any token fragment. */
export function parseRelayConnectLink(rawUrl: string): ParsedRelayLink | null {
  if (!rawUrl) return null;
  // Liberal scheme check: relay:// (and bare relay:) — accept any host/path shape.
  const match = /^relay:(\/\/)?/i.exec(rawUrl);
  if (!match) return null;

  let rest = rawUrl.slice(match[0].length);
  // The query may embed a full connect URL (with its own #fragment) — split
  // the query off FIRST so the inner fragment isn't misread as the link's.
  const qIdx = rest.indexOf('?');
  const query = qIdx >= 0 ? rest.slice(qIdx + 1) : '';
  rest = qIdx >= 0 ? rest.slice(0, qIdx) : rest;

  const hostParam = queryParam(query, ['host', 'url', 'target', 'relay']);
  const token = fragmentOf(rest) ?? (hostParam ? fragmentOf(hostParam) : null);
  if (!token) return null;

  const host = hostParam?.trim();
  if (host && /^(wss?|https?):\/\//i.test(host)) {
    // Already a connect URL — keep its scheme/host/port, re-attach the token.
    return { url: `${host.split('#')[0]}#${token}`, token };
  }
  if (host && /^[\w.-]+(:\d+)?$/.test(host)) {
    // Bare host[:port] — default to the ws scheme.
    return { url: `ws://${host}#${token}`, token };
  }
  // Token only — the desktop host is unknown; the caller decides what to do.
  return { url: null, token };
}

/**
 * Subscribe to relay deep links for the lifetime of the app.
 *
 * Calls `onUrl` for every recognized relay link: with the normalized
 * `ws(s)://host[:port]#<token>` connect URL when the link carried a host,
 * otherwise with the bare token string. Also checks `getInitialURL()` so a
 * cold start from a tapped link isn't missed. Returns an unsubscribe fn.
 */
export function initDeepLinkHandling(onUrl: (url: string) => void): () => void {
  let stale = false;
  const handle = (raw: string | null) => {
    if (stale || !raw) return;
    const parsed = parseRelayConnectLink(raw);
    if (!parsed) return;
    onUrl(parsed.url ?? parsed.token);
  };

  void Linking.getInitialURL().then(handle).catch(() => {});
  const subscription = Linking.addEventListener('url', ({ url }) => handle(url));

  return () => {
    stale = true;
    subscription.remove();
  };
}
