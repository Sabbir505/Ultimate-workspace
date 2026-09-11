// The harness pane's effort slider: the session's per-session tier, offered
// with the CLI's own spawn-able vocabulary (harness_config.rs effortOptions —
// claude `--effort`, omp/pi `--thinking`, kimi env) and narrowed per model
// when the CLI reports per-model tiers (omp). The slider shows on EVERY
// harness pane with tiers — the tier is stored on the chat session and
// applied to whichever harness spawns, so browsing another harness's pane
// and moving its slider still lands on the session.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

import { AgentModelPicker } from "../components/chat/AgentModelPicker";
import { paneCache, paneInFlight } from "../components/chat/agentPickerShared";

const listHarnessesMock = vi.fn();
const listHarnessModelsMock = vi.fn();

vi.mock("../lib/ipc", () => ({
  listHarnesses: (...a: unknown[]) => listHarnessesMock(...a),
  listAcpAgents: vi.fn().mockResolvedValue([]),
  listHarnessModels: (...a: unknown[]) => listHarnessModelsMock(...a),
  listChatModels: vi.fn().mockResolvedValue([]),
  scanLocalModels: vi.fn().mockResolvedValue([]),
  getChatConfig: vi.fn().mockResolvedValue(null),
}));

const openPicker = (container: HTMLElement) => {
  fireEvent.click(container.querySelector<HTMLElement>(".agent-chip")!);
};

function renderPicker(props: Partial<Parameters<typeof AgentModelPicker>[0]> = {}) {
  const view = render(
    <AgentModelPicker
      agent="harness:claude_code"
      model="opus"
      onPick={() => {}}
      {...props}
    />,
  );
  openPicker(view.container);
  return view;
}

const slider = (): HTMLElement | null => screen.queryByRole("slider", { name: "Harness effort" });
const sliderTooltip = (): string | null =>
  document.querySelector(".seg-slider-wrap")?.getAttribute("title") ?? null;

beforeEach(() => {
  vi.clearAllMocks();
  // The pane caches are module-level — one test's fetch must not leak into
  // the next (the picker renders cached panes without refetching).
  paneCache.clear();
  paneInFlight.clear();
  listHarnessesMock.mockResolvedValue([
    { id: "claude_code", displayName: "Claude Code", installed: true },
    { id: "kimi_code", displayName: "Kimi", installed: true },
    { id: "omp", displayName: "Omp", installed: true },
  ]);
});
afterEach(cleanup);

describe("harness pane effort slider", () => {
  it("offers the CLI's tiers and moves with the keyboard, calling the setter", async () => {
    listHarnessModelsMock.mockResolvedValue({
      defaultModel: "opus",
      endpoint: null,
      // The CLI's own configured level — surfaced on the Def stop's tooltip.
      effort: "max",
      effortOptions: ["low", "medium", "high", "xhigh", "max"],
      models: [],
    });
    const onHarnessEffortChange = vi.fn();
    renderPicker({ harnessEffort: "", onHarnessEffortChange });
    const el = await waitFor(() => {
      const s = slider();
      expect(s).toBeTruthy();
      return s!;
    });
    // "" = Default → the first stop; the CLI's own "max" lives in the Def
    // stop's tooltip instead of being impersonated by a tier.
    expect(el.getAttribute("aria-valuenow")).toBe("0");
    expect(sliderTooltip()).toContain("max");
    // ArrowRight steps onto the first tier — claude's vocabulary starts at
    // "low" — and the change routes to the session setter.
    fireEvent.keyDown(el, { key: "ArrowRight" });
    expect(onHarnessEffortChange).toHaveBeenCalledWith("low");
    // Every claude tier is offered: 1 Default stop + 5 tiers.
    expect(el.getAttribute("aria-valuemax")).toBe("5");
  });

  it("respects the selected model's own tier set (omp narrowing)", async () => {
    listHarnessModelsMock.mockResolvedValue({
      defaultModel: "sharkai/glm-5.2",
      endpoint: null,
      effort: null,
      effortOptions: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      models: [
        {
          id: "sharkai/glm-5.2",
          label: "GLM 5.2",
          source: "cli",
          // The dump's own (unordered) report — glm-5.2 has no "xhigh".
          thinking: ["max", "low", "minimal", "medium", "high"],
        },
        {
          id: "sharkai/deepseek-v4-flash",
          label: "DeepSeek V4 Flash",
          source: "cli",
          thinking: ["low", "high", "max"],
        },
      ],
    });
    renderPicker({ agent: "harness:omp", model: "sharkai/glm-5.2", harnessEffort: "", onHarnessEffortChange: vi.fn() });
    const el = await waitFor(() => {
      const s = slider();
      expect(s).toBeTruthy();
      return s!;
    });
    // Narrowed to glm-5.2's five tiers + Default — NOT the harness-wide 7.
    expect(el.getAttribute("aria-valuemax")).toBe("5");
  });

  it("shows on a harness pane the session is not running on too", async () => {
    listHarnessModelsMock.mockImplementation((id: string) =>
      Promise.resolve(
        id === "claude_code"
          ? {
              defaultModel: "opus",
              endpoint: null,
              effort: "max",
              effortOptions: ["low", "medium", "high", "xhigh", "max"],
              models: [],
            }
          : {
              defaultModel: "kimi-k3",
              endpoint: null,
              effort: null,
              effortOptions: ["low", "medium", "high"],
              models: [],
            },
      ),
    );
    // Session runs kimi; opening the picker lands on the kimi pane.
    const { container } = renderPicker({
      agent: "harness:kimi_code",
      model: "kimi-k3",
      harnessEffort: "",
      onHarnessEffortChange: vi.fn(),
    });
    await waitFor(() => expect(slider()).toBeTruthy());
    // Browse to the Claude pane (the popup is portaled to <body>, so the
    // rail isn't inside `container`): the slider is there too — the tier is
    // session-scoped, and it applies the moment the user switches harnesses.
    fireEvent.click(document.querySelector<HTMLElement>('button[aria-label="Claude Code"]')!);
    const el = await waitFor(() => {
      const s = slider();
      expect(s).toBeTruthy();
      return s!;
    });
    // Claude's 5 tiers + Default, not kimi's 3 + Default.
    expect(el.getAttribute("aria-valuemax")).toBe("5");
  });

  it("stays hidden when the harness exposes no tiers", async () => {
    listHarnessModelsMock.mockResolvedValue({
      defaultModel: "opus",
      endpoint: null,
      effort: null,
      effortOptions: [],
      models: [],
    });
    renderPicker({ harnessEffort: "", onHarnessEffortChange: vi.fn() });
    await waitFor(() =>
      expect(listHarnessModelsMock).toHaveBeenCalledWith("claude_code"),
    );
    // Let the settle microtask land before asserting absence.
    await waitFor(() => expect(paneCache.get("harness:claude_code")?.status).toBe("ready"));
    expect(slider()).toBeNull();
  });

  it("stays hidden when no setter is wired (non-harness session browsing)", async () => {
    listHarnessModelsMock.mockResolvedValue({
      defaultModel: "opus",
      endpoint: null,
      effort: "max",
      effortOptions: ["low", "medium", "high", "xhigh", "max"],
      models: [],
    });
    renderPicker({ harnessEffort: undefined, onHarnessEffortChange: undefined });
    await waitFor(() => expect(paneCache.get("harness:claude_code")?.status).toBe("ready"));
    // There is no harness session to persist a tier onto.
    expect(slider()).toBeNull();
  });

  it("revalidates a pre-effort cached pane so the slider appears without a restart", async () => {
    // A pane cached by an OLDER backend (or the previous build) carries no
    // `effortOptions` key at all — harness panes otherwise keep their cache
    // for the whole run, which would keep the slider hidden until restart.
    paneCache.set("harness:claude_code", {
      status: "ready",
      rows: [{ id: "opus", label: "opus" }],
      endpoint: null,
      effort: "max",
    });
    renderPicker({ harnessEffort: "", onHarnessEffortChange: vi.fn() });
    // The stale pane renders first (stale-while-revalidate)…
    await waitFor(() => expect(listHarnessModelsMock).toHaveBeenCalledWith("claude_code"));
    // …and the fresh fetch swaps in with the spawn tiers.
    await waitFor(() => expect(slider()).toBeTruthy());
  });
});
