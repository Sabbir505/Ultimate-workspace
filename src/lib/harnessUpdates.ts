// Boot-time harness update check — the notification-panel half of the
// harness "Update" feature (the Settings half lives in SettingsView +
// state/projects.ts). Once per app open: compare each installed harness CLI
// against its npm registry latest; when something is out of date, drop ONE
// row into the bell panel that deep-links to Settings → Agent harnesses.
//
// Goes through the projects store's refreshHarnessUpdates so the results
// also seed `harnessUpdates` for the Settings rows (the backend caches the
// check for an hour, so the panel's own refresh reads the same data).
//
// Dedupe: the check runs on every start, but re-alerting the same version
// every boot would train the user to ignore the bell. A localStorage map of
// `harnessId -> latestVersionNotified` keeps each version to a single
// notification; a NEWER release notifies again, an older check result does
// not (e.g. registry lag after the user already updated out-of-band).
import { relayNotify } from "./notifyCenter";
import { useProjectsStore } from "../state/projects";
import { harnessShortName, type HarnessId } from "../types";

const NOTIFIED_KEY = "relay.harnessUpdates.notified.v1";

function loadNotified(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(NOTIFIED_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Fire-and-forget boot check. Failures (offline, backend not ready) stay
 *  silent — the Settings panel's Re-check covers manual refresh. */
export async function checkAndNotifyHarnessUpdates(): Promise<void> {
  try {
    await useProjectsStore.getState().refreshHarnessUpdates(false);
  } catch {
    return;
  }
  const pending = Object.values(useProjectsStore.getState().harnessUpdates).filter(
    (u): u is typeof u & { latestVersion: string } =>
      u.updateAvailable && typeof u.latestVersion === "string" && u.latestVersion.length > 0,
  );
  if (pending.length === 0) return;

  const notified = loadNotified();
  const fresh = pending.filter((u) => notified[u.id] !== u.latestVersion);
  // Record everything now seen (fresh or not): if the registry later flips
  // back to an already-notified version we still don't re-alert it.
  if (fresh.length === 0) return;
  for (const u of pending) notified[u.id] = u.latestVersion;
  try {
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify(notified));
  } catch {
    // Storage full — worst case the same update re-notifies next boot.
  }
  const body = fresh
    .map((u) => `${harnessShortName(u.id as HarnessId)} ${u.installedVersion ?? "?"} → ${u.latestVersion}`)
    .join(" · ");
  relayNotify({
    kind: "alert",
    title: fresh.length === 1 ? "Harness update available" : `${fresh.length} harness updates available`,
    body: `${body} — update from Settings → Agent harnesses`,
    view: "settings",
    settingsCategory: "harnesses",
  });
}
