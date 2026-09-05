// C4 (ISSUES.md): ApiKeysPanel's in-flight model fetch wasn't cancelled when
// the user switched providers — a late resolution landed provider A's model
// list in provider B's panel. handleFetchModels must capture the provider at
// fetch start and drop the resolution when the panel has moved on.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const listChatModelsMock = vi.fn();

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listChatModels: (...a: unknown[]) => listChatModelsMock(...a),
}));

// GlassSelect → a native <select> so the provider switch is a simple change
// event (same trick apiKeysPanel.test.tsx uses).
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
import { useUiStore } from "../state/ui";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe("ApiKeysPanel stale model fetch (C4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUiStore.setState({ activeView: "settings", settingsCategory: "apikeys" });
  });

  afterEach(() => {
    cleanup();
    useUiStore.setState({ activeView: "chat", settingsCategory: null });
  });

  it("keeps provider B's model list empty when A's fetch resolves after a switch", async () => {
    const pending = deferred<Array<{ id: string; object: string; created: number; ownedBy: string }>>();
    listChatModelsMock.mockImplementation(() => pending.promise);

    render(<SettingsView />);
    await waitFor(() => expect(screen.getByText("API providers")).toBeTruthy());

    // Provider A: OpenAI Compatible. Type key + base URL — the auto-fetch
    // effect (or the manual button) starts the fetch we keep in flight.
    const providerSelect = screen.getAllByTestId("glass-select")[0] as HTMLSelectElement;
    fireEvent.change(providerSelect, { target: { value: "openai_compatible" } });
    await waitFor(() => expect(screen.getByLabelText("API key")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-test" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "http://localhost:1337/v1" } });

    // The debounced auto-fetch (600 ms) kicks off provider A's fetch.
    await waitFor(() => expect(listChatModelsMock).toHaveBeenCalled(), { timeout: 3000 });
    expect(listChatModelsMock.mock.calls[0][0]).toBe("openai_compatible");

    // Switch to provider B while A's fetch is still in flight.
    fireEvent.click(screen.getByLabelText("Select Anthropic Compatible"));
    expect(screen.getByLabelText("API key")).toBeTruthy();

    // A's fetch finally resolves with models — they must NOT land in B's panel
    // (the "Model list" header would show the count).
    await act(async () => {
      pending.resolve([{ id: "stale-model-a", object: "model", created: 1, ownedBy: "x" }]);
    });
    expect(screen.queryByText("stale-model-a")).toBeNull();
    expect(screen.queryByText("1 available")).toBeNull();

    // A fetch started for B still works normally.
    const second = deferred<Array<{ id: string; object: string; created: number; ownedBy: string }>>();
    listChatModelsMock.mockImplementation(() => second.promise);
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-b" } });
    fireEvent.click(screen.getByRole("button", { name: "Fetch models" }));
    await act(async () => {
      second.resolve([{ id: "fresh-model-b", object: "model", created: 2, ownedBy: "x" }]);
    });
    expect(await screen.findByText("1 available")).toBeTruthy();
  });
});
