// First-run local-model onboarding (roadmap P0 §4.1): when no GGUF is
// installed anywhere and the user hasn't seen/dismissed the nudge, point
// them at the Model Market with a VRAM-aware hint. Deep-links straight to
// Settings → Local Models → market tab. Dismissal (and the first successful
// market download completing — see ModelMarket's onDownloadComplete →
// runScan path) persists via the `localModels.onboarded` KV, so it shows at
// most once per install.
import { useEffect, useState } from "react";
import { getGpuVram, getSetting, scanLocalModels, setSetting, type GpuVramInfo } from "../../lib/ipc";
import { useUiStore } from "../../state/ui";

function fmtGb(bytes: number | undefined | null): string | null {
  if (!bytes || bytes <= 0) return null;
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 10 ? String(Math.round(gb)) : gb.toFixed(1);
}

export function LocalModelBanner() {
  const [state, setState] = useState<"pending" | "hidden" | "show">("pending");
  const [vram, setVram] = useState<GpuVramInfo | null>(null);

  useEffect(() => {
    let stale = false;
    void (async () => {
      const [seen, models, gpu] = await Promise.all([
        getSetting("localModels.onboarded").catch(() => null),
        scanLocalModels().catch(() => null),
        getGpuVram().catch(() => null),
      ]);
      if (stale) return;
      if (seen) {
        setState("hidden");
        return;
      }
      setVram(gpu ?? null);
      // Show only when nothing local is installed yet — an existing local
      // model means the user is past onboarding.
      setState(models && models.length > 0 ? "hidden" : "show");
    })();
    return () => {
      stale = true;
    };
  }, []);

  if (state !== "show") return null;

  const vramGb = fmtGb(vram?.totalVramBytes);
  const dismiss = () => {
    setState("hidden");
    void setSetting("localModels.onboarded", "1").catch(() => {
      /* best-effort — worst case the banner returns next launch */
    });
  };
  const openMarket = () => {
    const ui = useUiStore.getState();
    ui.setSettingsCategory("localmodels");
    ui.setLocalModelsOpenMarket(true);
    ui.setActiveView("settings");
  };

  return (
    <div className="onboarding-banner">
      <button
        className="onboarding-banner-close"
        onClick={dismiss}
        title="Dismiss"
        aria-label="Dismiss notification"
      >
        ×
      </button>
      <strong>Run models locally — free and private</strong>
      <div className="hint">
        Relay can run GGUF models on your machine via the bundled llama.cpp
        server{vramGb ? ` — picks sized for your ${vramGb} GB of VRAM` : " — sized to your hardware"}{" "}
        are marked <em>Recommended</em> in the Model Market.
      </div>
      <div>
        <button onClick={openMarket}>Browse the Model Market</button>
      </div>
    </div>
  );
}
