// The usage-limit warning notch above the composer card: shown when the
// composer's own session target has a warn/crit alert (configured cap or
// provider/CLI-reported window), scoped to the session's provider/harness,
// dismissible until the tier escalates.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatComposer } from "../components/chat/ChatComposer";
import { useChatStore } from "../state/chat";
import { useUsageLimitsStore } from "../state/usageLimits";
import type { UsageLimitAlert } from "../lib/ipc";

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listConnectors: vi.fn(async () => []),
  mcpGalleryList: vi.fn(async () => ({ installed: [] })),
  listSessionConnectors: vi.fn(async () => []),
  listChatSkills: vi.fn(async () => []),
  listPromptTemplates: vi.fn(async () => []),
  getUsageMeters: vi.fn(async () => []),
  checkUsageLimits: vi.fn(async () => []),
}));

afterEach(() => {
  cleanup();
  useChatStore.setState({ activeChatSessionId: null, loopState: {} });
  useUsageLimitsStore.setState({ meters: {}, alerts: [], dismissed: {}, loading: false });
});

const SESSION = "usage-notch-test";

function alert(tier: "warn" | "crit", target = "commandcode"): UsageLimitAlert {
  return {
    target,
    label: "CommandCode",
    tier,
    window: "day",
    windowLabel: "daily",
    usedPct: tier === "crit" ? 101 : 86,
    usedUsd: 0.86,
    capUsd: 1,
    usedTokens: null,
    capTokens: null,
    usedRequests: null,
    capRequests: null,
    resetsAt: null,
    message: `CommandCode at ${tier === "crit" ? 101 : 86}% of its daily cap ($0.86 / $1.00)`,
  };
}

function renderComposer(props: { provider?: string; agent?: string | null } = {}) {
  render(
    <ChatComposer
      sessionId={SESSION}
      onSend={vi.fn()}
      streaming={false}
      onAgentModelPick={vi.fn()}
      {...props}
    />,
  );
}

describe("composer usage notch", () => {
  it("warns for the composer's own harness target", () => {
    useUsageLimitsStore.setState({ alerts: [alert("warn")] });
    renderComposer({ agent: "harness:commandcode" });
    const notch = document.querySelector(".composer-usage-notch");
    expect(notch).toBeTruthy();
    expect(notch?.className).toContain("composer-usage-notch-warn");
    expect(screen.getByText(/86% of its daily cap/)).toBeTruthy();
  });

  it("escalates to the crit variant at the limit", () => {
    useUsageLimitsStore.setState({ alerts: [alert("crit")] });
    renderComposer({ agent: "harness:commandcode" });
    expect(document.querySelector(".composer-usage-notch-crit")).toBeTruthy();
  });

  it("warns for an API-provider session too", () => {
    useUsageLimitsStore.setState({ alerts: [alert("warn", "chat:anthropic")] });
    renderComposer({ provider: "anthropic" });
    expect(document.querySelector(".composer-usage-notch")).toBeTruthy();
  });

  it("never shows another target's warning", () => {
    useUsageLimitsStore.setState({ alerts: [alert("warn", "chat:anthropic")] });
    renderComposer({ agent: "harness:commandcode" });
    expect(document.querySelector(".composer-usage-notch")).toBeNull();
  });

  it("hides with no alert and reappears when the tier escalates after a dismissal", () => {
    renderComposer({ agent: "harness:commandcode" });
    expect(document.querySelector(".composer-usage-notch")).toBeNull();

    act(() => useUsageLimitsStore.setState({ alerts: [alert("warn")] }));
    expect(document.querySelector(".composer-usage-notch")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Dismiss the usage warning"));
    expect(document.querySelector(".composer-usage-notch")).toBeNull();

    // Same tier stays hidden; crossing to crit shows again.
    act(() => useUsageLimitsStore.setState({ alerts: [alert("warn")] }));
    expect(document.querySelector(".composer-usage-notch")).toBeNull();
    act(() => useUsageLimitsStore.setState({ alerts: [alert("crit")] }));
    expect(document.querySelector(".composer-usage-notch-crit")).toBeTruthy();
  });

  it("does not warn for auto-routed sessions (no concrete provider)", () => {
    useUsageLimitsStore.setState({ alerts: [alert("warn", "chat:anthropic")] });
    renderComposer({ provider: "auto" });
    expect(document.querySelector(".composer-usage-notch")).toBeNull();
  });
});
