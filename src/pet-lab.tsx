// Pet Lab (dev-only, /pet-lab.html): the REAL pet components + store mounted
// outside the Tauri shell so every animation can be driven deterministically
// in a plain browser (Playwright screenshots, design review). Not part of the
// production build — vite only serves it from the dev server.
import { createRoot } from "react-dom/client";
import { createElement as h, useEffect } from "react";

import "../src/styles/tokens.css";
import "../src/styles/global.css";
import "../src/styles/pet.css";
import { PetStrip } from "../src/components/pet/PetStrip";
import { PetTicker } from "../src/components/pet/PetTicker";
import { usePetStore } from "../src/state/pet";

declare module "react" {
  // noop — keeps JSX-free createElement calls type-friendly below
}

function Lab() {
  const focusUntil = usePetStore((s) => s.focusUntil);
  const mood = usePetStore((s) => s.core.mood);
  const home = usePetStore((s) => s.home);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = usePetStore.getState();
      const map: Record<string, () => void> = {
        "1": () => s.petThePet(),
        "2": () => s.zoomies(),
        "3": () => s.event({ type: "celebrate", source: "turn" }),
        "4": () => s.event({ type: "concerned", source: "error" }),
        "5": () => s.event({ type: "agentOutput" }),
        "6": () => s.event({ type: "chatToken" }),
        "7": () => s.debugForceMood("doze"),
        "8": () => s.event({ type: "wake" }),
        "9": () => (s.focusUntil > Date.now() ? s.stopFocus() : s.startFocus()),
        "0": () =>
          s.teleportTo(s.home === "sidebar" ? "composer" : "sidebar"),
      };
      map[e.key]?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const btn = (label: string, fn: () => void) =>
    h("button", {
      onClick: fn,
      style: {
        padding: "6px 12px",
        borderRadius: 8,
        border: "1px solid rgba(120,128,148,0.4)",
        background: "rgba(95,212,196,0.12)",
        color: "#e8ecf5",
        fontSize: 12,
        cursor: "pointer",
      },
    }, label);

  return h(
    "div",
    { style: { minHeight: "100vh", background: "#14161d", padding: 24, fontFamily: "system-ui" } },
    h("h1", { style: { color: "#e8ecf5", fontSize: 18, margin: "0 0 4px" } }, "Relay Pet — Live Lab"),
    h("p", { style: { color: "#9aa3ba", fontSize: 12, margin: "0 0 12px" } },
      `real store + real components · mood: ${mood} · home: ${home}${focusUntil > Date.now() ? " · focusing" : ""}`),
    h(
      "div",
      { style: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 } },
      btn("Pet the pet (1)", () => usePetStore.getState().petThePet()),
      btn("Zoomies (2)", () => usePetStore.getState().zoomies()),
      btn("Celebrate (3)", () => usePetStore.getState().event({ type: "celebrate", source: "turn" })),
      btn("Concerned (4)", () => usePetStore.getState().event({ type: "concerned", source: "error" })),
      btn("Agent working (5)", () => usePetStore.getState().event({ type: "agentOutput" })),
      btn("Chat streaming (6)", () => usePetStore.getState().event({ type: "chatToken" })),
      btn("Doze (7)", () => usePetStore.getState().debugForceMood("doze")),
      btn("Wake (8)", () => usePetStore.getState().event({ type: "wake" })),
      btn(focusUntil > Date.now() ? "Stop focus (9)" : "Focus 25m (9)", () =>
        usePetStore.getState().focusUntil > Date.now()
          ? usePetStore.getState().stopFocus()
          : usePetStore.getState().startFocus()),
      btn("Teleport (0)", () =>
        usePetStore.getState().teleportTo(
          usePetStore.getState().home === "sidebar" ? "composer" : "sidebar",
        )),
      btn("Level-up party", () => {
        const s = usePetStore.getState();
        usePetStore.setState({ core: { ...s.core, xp: 125 } });
        s.event({ type: "celebrate", source: "automation" });
      }),
    ),
    // fake sidebar rail
    h(
      "div",
      { style: { width: 260, marginBottom: 18 } },
      h("div", { style: { height: 40, color: "#ffd166", fontWeight: 700, letterSpacing: 2, fontSize: 15, padding: "6px 10px" } }, "RELAY"),
      h(PetStrip, { myHome: "sidebar" }),
      h("div", {
        style: {
          height: 38,
          borderRadius: 10,
          border: "1px solid rgba(120,128,148,0.35)",
          display: "flex",
          alignItems: "center",
          padding: "0 12px",
          color: "#9aa3ba",
          fontSize: 13,
        },
      }, "🔍 Search"),
    ),
    // fake chat column
    h(
      "div",
      { style: { width: 720 } },
      h(PetStrip, { myHome: "composer" }),
      h("div", {
        style: {
          borderRadius: 14,
          border: "1px solid rgba(120,128,148,0.3)",
          padding: 16,
          color: "#9aa3ba",
          fontSize: 13,
          minHeight: 90,
        },
      }, "Write a message… / for skills · @ for apps"),
    ),
    h(PetTicker),
  );
}

createRoot(document.getElementById("root")!).render(h(Lab));
