/**
 * useRelayList — (re)fetch a screen's list data on mount AND on every
 * false→true `connected` transition of the relay socket.
 *
 * Why: `_send` silently drops frames while the socket isn't OPEN, so a list
 * fetch fired before pairing (or during a flap) never gets answered — the
 * screen sat on a spinner forever or showed a false "nothing here" state.
 * The callback runs on mount regardless (a dropped frame is harmless) and
 * again the moment the socket pairs, so a lost first fetch self-heals.
 *
 * `deps` (optional) re-fires the fetch when they change (e.g. the Skills
 * screen's kind toggle or Cost screen's range switch); the reconnect refetch
 * ALWAYS uses the latest callback via a ref, so a lost fetch after a deps
 * change is re-run with current arguments too.
 */
import { useEffect, useRef } from 'react';
import { useRelay } from './useRelay';

export function useRelayList(fetch: () => void, deps: readonly unknown[] = []): void {
  const { connected } = useRelay();
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;
  const wasConnected = useRef(false);
  const prevDeps = useRef<readonly unknown[] | null>(null);

  useEffect(() => {
    const prev = prevDeps.current;
    const depsChanged =
      prev === null ||
      deps.length !== prev.length ||
      deps.some((d, i) => !Object.is(d, prev[i]));
    if (depsChanged || (connected && !wasConnected.current)) fetchRef.current();
    prevDeps.current = deps;
    wasConnected.current = connected;
    // `deps` is a caller-owned array (stable length); spreading it into the
    // effect deps is the point of the parameter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, ...deps]);
}
