// C12 (ISSUES.md): settings inputs persisted to the backend on EVERY
// keystroke — bursty, out-of-order writes could persist an intermediate
// (shorter) value over the final one. The WebSearchPanel key input and the
// MemoryPanel extraction-model input now debounce ~400ms: N keystrokes must
// produce exactly ONE persisted write carrying the final value.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSettingMock = vi.fn();
const setSettingMock = vi.fn();
const memorySetExtractModelMock = vi.fn();
const listChatModelsMock = vi.fn();

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSetting: (...a: unknown[]) => getSettingMock(...(a as [])),
  setSetting: (...a: unknown[]) => setSettingMock(...(a as [])),
  memorySetExtractModel: (...a: unknown[]) => memorySetExtractModelMock(...(a as [])),
  listChatModels: (...a: unknown[]) => listChatModelsMock(...(a as [])),
  memoryStatus: vi.fn(async () => ({
    enabled: true,
    activeCount: 0,
    document: "",
    documentStored: false,
    documentUpdatedAt: null,
    documentBudget: 2200,
    extractModel: "",
  })),
  memoryList: vi.fn(async () => []),
}));

// GlassSelect → a native <select> so the search-engine pick is a plain
// change event.
vi.mock("../components/common/GlassSelect", () => ({
  GlassSelect: ({ value, options, onChange, ...props }: any) => (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      data-testid="glass-select"
      {...props}
    >
      {options.map((o: any) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  ),
}));

import { SettingsView } from "../components/settings/SettingsView";
import { MemoryPanel } from "../components/settings/MemoryPanel";
import { useUiStore } from "../state/ui";

beforeEach(() => {
  vi.clearAllMocks();
  getSettingMock.mockResolvedValue("");
  setSettingMock.mockResolvedValue(undefined);
  memorySetExtractModelMock.mockResolvedValue(undefined);
  listChatModelsMock.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useUiStore.setState({ activeView: "chat", settingsCategory: null });
});

describe("WebSearchPanel key input debounce (C12)", () => {
  it("types 30 chars → exactly 1 persisted write with the final value", async () => {
    vi.useFakeTimers();
    useUiStore.setState({ activeView: "settings", settingsCategory: "websearch" });
    const { container } = render(<SettingsView />);
    await act(async () => {}); // flush the initial getSetting load
    expect(screen.getAllByText("Web Search").length).toBeGreaterThanOrEqual(1);

    // Pick an engine (discrete pick — its own immediate persist).
    const select = container.querySelector("select")!;
    await act(async () => {
      fireEvent.change(select, { target: { value: "serper" } });
    });
    setSettingMock.mockClear();

    // Type a 30-char key, one character at a time.
    const input = screen.getByPlaceholderText("Paste your API key…");
    for (let i = 1; i <= 30; i++) {
      fireEvent.change(input, { target: { value: "k".repeat(i) } });
    }
    expect((input as HTMLInputElement).value).toBe("k".repeat(30));
    // Nothing persisted while typing.
    expect(setSettingMock).not.toHaveBeenCalled();

    // After the debounce window: exactly one write, with the final value.
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(setSettingMock).toHaveBeenCalledTimes(1);
    expect(setSettingMock).toHaveBeenCalledWith("search.serper_key", "k".repeat(30));
  });
});

describe("MemoryPanel extraction-model input debounce (C12)", () => {
  it("types a model id → exactly 1 persisted write with the final value", async () => {
    vi.useFakeTimers();
    render(<MemoryPanel />);
    await act(async () => {}); // flush initial refresh

    // Pick a cloud API source so the free-text model input appears.
    const agentSelect = screen.getByLabelText("Extraction model") as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(agentSelect, { target: { value: "anthropic" } });
    });
    // Flush the model-list fetch (empty result → free-text input renders).
    await act(async () => {});
    await act(async () => {});
    setSettingMock.mockClear();
    memorySetExtractModelMock.mockClear();

    // Type a model id, one character at a time.
    const input = screen.getByPlaceholderText("model id");
    const final = "claude-haiku-v9";
    for (let i = 1; i <= final.length; i++) {
      fireEvent.change(input, { target: { value: final.slice(0, i) } });
    }
    expect((input as HTMLInputElement).value).toBe(final);
    expect(memorySetExtractModelMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(memorySetExtractModelMock).toHaveBeenCalledTimes(1);
    expect(memorySetExtractModelMock).toHaveBeenCalledWith(final);
  });
});
