// Bot docks must not draw where they can't be seen. The docked pets render on
// ONE shared fixed canvas (lib/pets/stage) using each host's layout rect — a
// rect that ignores the rail's overflow/visibility clipping — so a hidden
// home's pets used to float over whatever view was showing (the field report:
// bot pets bleeding over the full-screen vault). The dock now bails out when
// its home is hidden, which unmounts the avatars (and so releases their stage
// handles).
//
// The Bots view is the exception: its composer still hosts the dock, showing
// ONLY the selected bot's pet.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import React from "react";

vi.mock("../hooks/useBots", () => ({
  useBots: () => ({
    bots: [{ id: "b1", name: "Bao", description: "panda bot", pet: "panda", enabled: true }],
    runs: [],
    runningBots: [],
    approvals: [],
    openThread: vi.fn().mockResolvedValue(null),
  }),
}));

// jsdom has no WebGL: report the stage as unavailable so avatars draw their
// CSS fallback chip instead of probing a canvas (which logs noise).
vi.mock("../lib/pets/stage", () => ({
  webglAvailable: () => false,
  mountPet: async () => null,
  pausePets: () => {},
  resumePets: () => {},
}));

import { BotPetDock, petStateFor } from "../components/pet/BotPetDock";
import { useBotPetHome } from "../state/botPets";
import { useUiStore } from "../state/ui";

beforeEach(() => {
  cleanup();
  useBotPetHome.setState({ homes: {}, dragging: null });
  useUiStore.setState({ baseView: "chat", sidebarCollapsed: false, activeBotId: null });
});

describe("BotPetDock visibility", () => {
  it("docks the sidebar pet while the rail is visible", () => {
    render(<BotPetDock myHome="sidebar" compact />);
    expect(screen.getByLabelText("Bots")).toBeTruthy();
  });

  it("hides the sidebar dock while the rail is collapsed", () => {
    useUiStore.setState({ sidebarCollapsed: true });
    render(<BotPetDock myHome="sidebar" compact />);
    expect(screen.queryByLabelText("Bots")).toBeNull();
  });

  it("hides the composer dock in a full-screen view with no pet home (wiki / vault)", () => {
    for (const view of ["wiki", "vault"] as const) {
      useUiStore.setState({ baseView: view, activeBotId: null });
      render(<BotPetDock myHome="main" />);
      expect(screen.queryByLabelText("Bots")).toBeNull();
      cleanup();
    }
  });

  it("shows ONLY the active bot's pet on the composer in the Bots view", () => {
    // No selected bot → nothing docks.
    useUiStore.setState({ baseView: "bots", activeBotId: null });
    const { rerender } = render(<BotPetDock myHome="main" />);
    expect(screen.queryByLabelText("Bots")).toBeNull();
    // Selecting the bot makes its pet ride the composer.
    act(() => useUiStore.setState({ activeBotId: "b1" }));
    rerender(<BotPetDock myHome="main" />);
    expect(screen.getByLabelText("Bots")).toBeTruthy();
  });

  it("never docks the sidebar home on the Bots view", () => {
    useUiStore.setState({ baseView: "bots", activeBotId: "b1" });
    render(<BotPetDock myHome="sidebar" compact />);
    expect(screen.queryByLabelText("Bots")).toBeNull();
  });

  it("hides on the live switch chat → vault and bots → wiki (the field report)", () => {
    const { rerender } = render(<BotPetDock myHome="sidebar" compact />);
    expect(screen.getByLabelText("Bots")).toBeTruthy();

    act(() => useUiStore.setState({ baseView: "vault" }));
    rerender(<BotPetDock myHome="sidebar" compact />);
    expect(screen.queryByLabelText("Bots")).toBeNull();

    // A composer dock mounted while the Bots view was up must stay hidden when
    // the user switches on to the wiki.
    act(() => useUiStore.setState({ baseView: "bots", activeBotId: "b1" }));
    rerender(<BotPetDock myHome="main" />);
    expect(screen.getByLabelText("Bots")).toBeTruthy();
    act(() => useUiStore.setState({ baseView: "wiki" }));
    rerender(<BotPetDock myHome="main" />);
    expect(screen.queryByLabelText("Bots")).toBeNull();
  });
});

describe("petStateFor", () => {
  const bot = { id: "b1", enabled: true };
  const approval = (resolvedAt: number | null, status = "approved") => ({
    botId: "b1",
    status,
    resolvedAt,
  });

  it("celebrates only a RECENTLY resolved approval", () => {
    const now = Date.now();
    expect(petStateFor(bot, [], {}, [approval(now - 1000)])).toBe("celebrating");
  });

  it("does not celebrate a long-resolved approval (the permanent-celebration bug)", () => {
    const now = Date.now();
    expect(petStateFor(bot, [], {}, [approval(now - 10 * 60_000)])).toBe("idle");
    // A resolved row with no timestamp is never treated as fresh.
    expect(petStateFor(bot, [], {}, [approval(null)])).toBe("idle");
  });

  it("prioritizes enabled / running / pending over celebration", () => {
    const now = Date.now();
    expect(petStateFor({ id: "b1", enabled: false }, [], {}, [approval(now)])).toBe("sleeping");
    expect(petStateFor(bot, ["b1"], {}, [approval(now)])).toBe("working");
    expect(petStateFor(bot, [], { b1: 1 }, [approval(now)])).toBe("strolling");
  });
});
