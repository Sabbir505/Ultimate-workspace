// The Logs view: rows render from the store, selecting one opens its detail,
// and the toolbar filters flow through. Mocked at the IPC barrel the way
// costDashboard.test.tsx does — importOriginal keeps every other export real so
// the child components don't hit undefined imports.
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { LogsView } from "../components/logs/LogsView";
import { llmLogGet, llmLogList } from "../lib/ipc";
import type { LlmLogSummary } from "../types";

// vi.mock is hoisted above module-level consts, so the fixtures have to be
// hoisted with them or the factory sees them uninitialized.
//
// `createdAt` is unix SECONDS — the Rust store writes now_ts(), and the row
// renderer divides accordingly. (Fixtures in ms here once made every row read
// "~20000d" while the tests stayed green.)
const { ROWS, OLDER, NOW } = vi.hoisted(() => {
  const NOW = Math.floor(Date.now() / 1000);
  // The list pages at 200 rows, so a full page exercises "load older"; the
  // first two rows are the ones the assertions read.
  const rows: LlmLogSummary[] = Array.from({ length: 200 }, (_, i) => ({
    id: `r${i}`,
    rowId: 1000 - i,
    createdAt: NOW - 5 - i,
    origin: "relay",
    target: "ollama",
    method: "POST",
    path: `/api/chat/${i}`,
    model: "llama3.2",
    upstreamStatus: null,
    error: null,
    durationMs: null,
    ttftMs: null,
    inputTokens: null,
    outputTokens: null,
    tokensPerSecond: null,
    requestBytes: 120,
    responseBytes: 2048,
    truncated: false,
  }));
  rows[0] = {
    ...rows[0],
    origin: "external",
    target: "llamacpp",
    path: "/v1/chat/completions",
    model: "MiniCPM5-2B-Q8_0.gguf",
    upstreamStatus: 200,
    durationMs: 812,
    ttftMs: 255,
    inputTokens: 17,
    outputTokens: 24,
    tokensPerSecond: 66.9,
  };
  rows[1] = {
    ...rows[1],
    path: "/api/chat",
    upstreamStatus: 500,
    error: "upstream error: model not loaded",
    durationMs: 40,
  };
  const older = {
    ...rows[199],
    id: "older-row",
    rowId: 1,
    createdAt: NOW - 86_400 * 3,
    path: "/api/chat/old",
  };
  return { ROWS: rows, OLDER: older, NOW };
});

vi.mock("../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...actual,
    llmLogList: vi.fn().mockImplementation((filter: { beforeCreatedAt?: number | null }) =>
      Promise.resolve(filter?.beforeCreatedAt != null ? [OLDER] : ROWS),
    ),
    llmLogStats: vi.fn().mockResolvedValue({
      total: 201,
      errorCount: 1,
      inputTokens: 17,
      outputTokens: 24,
      avgTtftMs: 255,
      avgTokensPerSecond: 66.9,
      oldestAt: OLDER.createdAt,
      newestAt: NOW - 5,
    }),
    llmLogGet: vi.fn().mockImplementation((id: string) =>
      Promise.resolve({
        ...ROWS.find((r) => r.id === id)!,
        requestBody: '{"model":"local","messages":[{"role":"user","content":"Reply pong"}]}',
        responseBody: 'data: {"object":"chat.completion.chunk"}\n\ndata: [DONE]\n\n',
        timingsJson: '{"prompt_n":17,"predicted_n":24,"predicted_per_second":66.9}',
      }),
    ),
    llmLogClear: vi.fn().mockResolvedValue(200),
    llmLogPrune: vi.fn().mockResolvedValue(0),
    gatewayStatus: vi.fn().mockResolvedValue({
      port: 8791,
      running: true,
      requireAuth: true,
      token: "tok",
      defaultTarget: null,
      knownTargets: ["llamacpp", "ollama", "lmstudio"],
    }),
    gatewayProbe: vi.fn().mockResolvedValue(true),
    safeListen: vi.fn().mockResolvedValue(() => {}),
  };
});

// NOTE: if the row list is ever virtualized again (@tanstack/react-virtual),
// jsdom needs two stubs for rows to render: offsetHeight on the scroll
// element (virtual-core's getRect reads offsetWidth/offsetHeight) AND a
// non-zero getBoundingClientRect for `measureElement` — zero there collapses
// every measured item and unmounts the rows.

describe("LogsView", () => {
  it("renders a row per logged request with its telemetry", async () => {
    render(<LogsView />);

    expect(await screen.findByText("/v1/chat/completions")).toBeTruthy();
    expect(await screen.findByText("/api/chat")).toBeTruthy();

    // Both origins are shown — a relay call and a proxied one are different
    // things and the view must not conflate them.
    expect((await screen.findAllByText("external")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("relay")).length).toBeGreaterThan(0);

    // Token counts and throughput come from the normalizer.
    expect((await screen.findAllByText("24 out")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("66.9 tok/s")).length).toBeGreaterThan(0);

    // Timestamps are unix seconds: every row is seconds-to-minutes old. A
    // ms/ms mixup here would render each one as "~20000d".
    const times = await screen.findAllByText(/^\d+[sm]$/);
    expect(times.length).toBeGreaterThan(0);
    expect(document.querySelector(".logs-row-time")?.textContent).toMatch(/^\d+[sm]$/);
    expect(screen.queryByText(/d$/)).toBeNull();
  });

  it("surfaces a failed upstream call rather than hiding it", async () => {
    render(<LogsView />);
    expect(await screen.findByText("500")).toBeTruthy();
  });

  it("opens the selected row's verbatim request and response", async () => {
    render(<LogsView />);
    fireEvent.click(await screen.findByText("/v1/chat/completions"));

    // The bodies are the record of truth — they must render as sent, not as a
    // re-serialized approximation.
    await waitFor(() => expect(screen.getByText(/Reply pong/)).toBeTruthy());
    expect(screen.getByText(/chat\.completion\.chunk/)).toBeTruthy();
    // The runtime's own timings object is kept unparsed.
    expect(screen.getByText(/predicted_per_second/)).toBeTruthy();
    // A request with no tools and a response with no tool calls renders no
    // tool-call pane at all — the section exists for the tool story only.
    expect(screen.queryByTestId("log-tool-calls")).toBeNull();
  });

  it("derives the tool-call debug pane from raw bodies", async () => {
    // Override the module mock for this one row: a tools request answered by
    // a streamed tool call whose arguments arrive in two fragments.
    vi.mocked(llmLogGet).mockImplementationOnce((id: string) =>
      Promise.resolve({
        ...ROWS.find((r) => r.id === id)!,
        requestBody: JSON.stringify({
          model: "local",
          tools: [
            { type: "function", function: { name: "read_file", parameters: {} } },
            { type: "function", function: { name: "search_docs", parameters: {} } },
          ],
          messages: [],
        }),
        responseBody: [
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"docs/x.md\\"}"}}]}}]}',
          "data: [DONE]",
          "",
        ].join("\n"),
      }),
    );
    render(<LogsView />);
    fireEvent.click(await screen.findByText("/v1/chat/completions"));

    await waitFor(() => expect(screen.getByTestId("log-tool-calls")).toBeTruthy());
    // Advertised schemas…
    expect(screen.getByText("Tools advertised")).toBeTruthy();
    expect(screen.getAllByText("read_file").length).toBe(2);
    expect(screen.getByText("search_docs")).toBeTruthy();
    // …and the response's re-assembled call with its arguments joined.
    expect(screen.getByText("Tool calls in response")).toBeTruthy();
    expect(screen.getByText('{"path":"docs/x.md"}')).toBeTruthy();
  });

  it("shows the real bound gateway port, not a placeholder", async () => {
    render(<LogsView />);
    expect(await screen.findByText("http://127.0.0.1:8791")).toBeTruthy();
  });

  it("loads the next-older page when a full page is shown", async () => {
    render(<LogsView />);
    const btn = await screen.findByText("Load older requests");
    expect(screen.queryByText("/api/chat/old")).toBeNull();

    fireEvent.click(btn);
    expect(await screen.findByText("/api/chat/old")).toBeTruthy();
    // The cursor must be the last on-screen row, not a fresh first page.
    const calls = vi.mocked(llmLogList).mock.calls;
    const lastCall = calls[calls.length - 1]?.[0];
    expect(lastCall?.beforeCreatedAt).toBe(ROWS[199].createdAt);
    expect(lastCall?.beforeRowId).toBe(ROWS[199].rowId);
  });

  it("refreshes the list after Clear so deleted rows disappear", async () => {
    render(<LogsView />);
    await screen.findByText("/v1/chat/completions");
    const callsBefore = vi.mocked(llmLogList).mock.calls.length;

    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByText("Clear"));

    // Clear deletes rows behind the list's back; refresh() must re-run the
    // query rather than leaving ghosts until the next event.
    await waitFor(() =>
      expect(vi.mocked(llmLogList).mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });
});
