// Settings → Compaction panel: the extracted + redesigned home for every
// context-compaction engine. Verifies the three trigger groups render, the
// idle master switch drives the store, the idle-age field persists, and the
// float threshold path is not floored to an integer.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CompactionPanel } from "../components/settings/CompactionPanel";
import { useSettingsStore } from "../state/settings";

// GlassSelect → native <select> (the convention the other panel tests use).
vi.mock("../components/common/GlassSelect", () => ({
  GlassSelect: ({ value, options, onChange, ariaLabel }: any) => (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o: any) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));

function resetStore() {
  useSettingsStore.setState({
    idleCompactionEnabled: true,
    idleCompactionMinutes: 60,
    idleCompactionMinTokens: 200_000,
    idleCompactionMaxPerPass: 3,
    cloudCompactionEnabled: true,
    cloudCompactionThreshold: 0.75,
    localCompactionThreshold: 0.75,
  });
}

describe("CompactionPanel (Settings → Compaction)", () => {
  afterEach(() => {
    cleanup();
    resetStore();
  });

  it("renders the three trigger groups with their master switches", () => {
    render(<CompactionPanel />);
    expect(screen.getByText("Compaction")).toBeTruthy();
    expect(screen.getByText("Idle threads")).toBeTruthy();
    expect(screen.getByText("Cloud & API chats")).toBeTruthy();
    expect(screen.getByText("Local models (GGUF)")).toBeTruthy();
    // Master switches present (switch role) — idle, cloud, local rebuild.
    expect(screen.getAllByRole("switch").length).toBe(3);
  });

  it("toggles idle compaction through the store", () => {
    const { container } = render(<CompactionPanel />);
    const toggle = container.querySelector("#idle-compaction-enabled") as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(useSettingsStore.getState().idleCompactionEnabled).toBe(false);
  });

  it("edits the idle-age threshold", () => {
    render(<CompactionPanel />);
    const input = screen.getByLabelText("Idle time (minutes)") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "180" } });
    expect(useSettingsStore.getState().idleCompactionMinutes).toBe(180);
  });

  it("keeps the float threshold a float (not floored to an integer)", () => {
    render(<CompactionPanel />);
    // Two "Threshold" fields exist (cloud + local); either exercises the
    // allowFloat path — an integer floor would corrupt a 0.25–0.99 fraction.
    const [cloudThreshold] = screen.getAllByLabelText("Threshold") as HTMLInputElement[];
    fireEvent.change(cloudThreshold, { target: { value: "0.9" } });
    expect(
      [useSettingsStore.getState().cloudCompactionThreshold, useSettingsStore.getState().localCompactionThreshold],
    ).toContain(0.9);
  });
});
