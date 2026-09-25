// The running app's version (e.g. "0.6.0", "0.6.1-staging.1"), rendered next to
// the Relay wordmark in the sidebar header.
//
// Nothing else in the app shows the CURRENT version — UpdateButton and
// UpdateBanner only ever render the version of an update that is AVAILABLE — so
// without this a channel build is indistinguishable from production in the UI,
// which makes a staging install impossible to identify at a glance.
//
// getVersion() is a core:app call; `allow-version` is already granted through
// `core:default` in capabilities/default.json, so no capability change is
// needed. Under jsdom / a plain `vite dev` browser session there is no Tauri
// runtime, so render nothing (same guard ipcCore uses).
import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { tauriRuntimeAvailable } from "../../lib/ipcCore";

export function AppVersion() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!tauriRuntimeAvailable()) return;
    let cancelled = false;
    getVersion()
      .then((v) => {
        if (!cancelled) setVersion(v);
      })
      .catch(() => {
        /* permission denied or runtime gone — show nothing rather than an error */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!version) return null;
  return (
    <span className="sidebar-version" title={`Relay ${version}`}>
      v{version}
    </span>
  );
}
