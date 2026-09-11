// First-run local-model onboarding (roadmap P0 §4.1): when no GGUF is
// installed anywhere and the user hasn't seen/dismissed the nudge, point
// them at the Model Market with a VRAM-aware hint — as a centered modal
// (it used to be a banner pinned over the chat). Deep-links straight to
// Settings → Local Models → market tab. Dismissal ("Not now", Escape, or an
// overlay click) — and the first successful market download completing (see
// ModelMarket's onDownloadComplete → runScan path) — persists via the
// `localModels.onboarded` KV, so it shows at most once per install.
//
// Suppressed while the welcome wizard is open (or deciding): the wizard's
// chat-model step covers the same choice, and finishing/skipping past it
// writes this KV itself. The probe therefore waits for initOnboarding()
// first, and the component hides on any wizard visibility change.
import { useEffect, useState } from "react";
import { getGpuVram, getSetting, scanLocalModels, setSetting, type GpuVramInfo } from "../../lib/ipc";
import { initOnboarding, useOnboardingStore } from "../../state/onboarding";
import { useUiStore } from "../../state/ui";
import { Modal } from "../common/Modal";

function fmtGb(bytes: number | undefined | null): string | null {
  if (!bytes || bytes <= 0) return null;
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 10 ? String(Math.round(gb)) : gb.toFixed(1);
}

export function LocalModelModal() {
  const [state, setState] = useState<"pending" | "hidden" | "show">("pending");
  const [vram, setVram] = useState<GpuVramInfo | null>(null);
  const wizardVisible = useOnboardingStore((s) => s.visible);

  useEffect(() => {
    let stale = false;
    void (async () => {
      // The wizard's gate must resolve first — on a first run it wins and
      // this modal stays hidden (the wizard's finish writes our KV itself).
      await initOnboarding().catch(() => {});
      if (useOnboardingStore.getState().visible) return;
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

  // The wizard re-opening (replay) or its gate resolving visible wins over
  // an already-decided "show".
  if (wizardVisible || state !== "show") return null;

  const vramGb = fmtGb(vram?.totalVramBytes);
  const dismiss = () => {
    setState("hidden");
    void setSetting("localModels.onboarded", "1").catch(() => {
      /* best-effort — worst case the modal returns next launch */
    });
  };
  const openMarket = () => {
    const ui = useUiStore.getState();
    ui.setSettingsCategory("localmodels");
    ui.setLocalModelsOpenMarket(true);
    ui.setActiveView("settings");
  };

  return (
    <Modal
      title="Run models locally — free and private"
      onClose={dismiss}
      actions={
        <>
          <button type="button" className="ghost" onClick={dismiss}>
            Not now
          </button>
          <button type="button" onClick={openMarket}>
            Browse the Model Market
          </button>
        </>
      }
    >
      <p>
        Relay can run GGUF models on your machine via the bundled llama.cpp
        server{vramGb ? ` — picks sized for your ${vramGb} GB of VRAM` : " — sized to your hardware"}{" "}
        are marked <em>Recommended</em> in the Model Market.
      </p>
    </Modal>
  );
}
