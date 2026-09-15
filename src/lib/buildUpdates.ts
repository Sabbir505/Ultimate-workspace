// Boot-time native-build update check — the harness notification flow applied
// to the pinned binaries (whisper CPU/CUDA builds, TTS GPU runtime). Once per
// app open: compare each installed build's version marker against the version
// this app pins; when something is behind, drop ONE row into the bell panel
// that deep-links to Settings → Local Models → Speech.
//
// Goes through the buildUpdates store so the results also seed the Settings
// panel's Update buttons (the check is a cheap marker read per build — no
// network — so the panel can simply re-run it on open).
//
// Dedupe mirrors harnessUpdates: a localStorage map of
// `buildId -> latestVersionNotified` keeps each version to a single
// notification; a NEWER pin notifies again, an already-notified one doesn't.
import { relayNotify } from "./notifyCenter";
import { useBuildUpdatesStore } from "../state/buildUpdates";

const NOTIFIED_KEY = "relay.buildUpdates.notified.v1";

function loadNotified(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(NOTIFIED_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Fire-and-forget boot check. Failures (backend not ready) stay silent —
 *  the speech panel's own refresh covers manual re-checks. */
export async function checkAndNotifyBuildUpdates(): Promise<void> {
  try {
    await useBuildUpdatesStore.getState().refreshBuildUpdates();
  } catch {
    return;
  }
  const pending = Object.values(useBuildUpdatesStore.getState().buildUpdates).filter(
    (u) => u.installed && u.updateAvailable,
  );
  if (pending.length === 0) return;

  const notified = loadNotified();
  const fresh = pending.filter((u) => notified[u.id] !== u.latestVersion);
  // Record everything now seen (fresh or not): if a pin later flips back to
  // an already-notified version we still don't re-alert it.
  if (fresh.length === 0) return;
  for (const u of pending) notified[u.id] = u.latestVersion;
  try {
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify(notified));
  } catch {
    // Storage full — worst case the same update re-notifies next boot.
  }
  const body = fresh
    .map((u) => `${u.title} ${u.installedVersion ?? "unversioned"} → ${u.latestVersion}`)
    .join(" · ");
  relayNotify({
    kind: "alert",
    title: fresh.length === 1 ? "Native build update available" : `${fresh.length} native build updates available`,
    body: `${body} — update from Settings → Local Models → Speech`,
    view: "settings",
    settingsCategory: "localmodels",
  });
}
