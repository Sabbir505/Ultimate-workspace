// The Logs view: rows render from the store, selecting one opens its detail,
// and the toolbar filters flow through. Mocked at the IPC barrel the way
// costDashboard.test.tsx does — importOriginal keeps every other export real so
// the child components don't hit undefined imports.
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { LogsView } from "../components/logs/LogsView";

// vi.mock is hoisted above module-level consts, so the fixtures have to be
// hoisted with them or the factory sees them uninitialized.
const { ROWS } = vi.hoisted(() => ({ ROWS: [
  {
    id: "r1",
    createdAt: Date.now() - 5_000,
    origin: "external",
    target: "llamacpp",
    method: "POST",
    path: "/v1/chat/completions",
    model: "MiniCPM5-2B-Q8_0.gguf",
    upstreamStatus: 200,
    error: null,
    durationMs: 812,
    ttftMs: 255,
    inputTokens: 17,
    outputTokens: 24,
    tokensPerSecond: 66.9,
    requestBytes: 120,
    responseBytes: 2048,
    truncated: false,
  },
  {
    id: "r2",
    createdAt: Date.now() - 90_000,
    origin: "relay",
    target: "ollama",
    method: "POST",
    path: "/api/chat",
    model: "llama3.2",
    upstreamStatus: 500,
    error: "upstream error: model not loaded",
    durationMs: 40,
    ttftMs: null,
    inputTokens: null,
    outputTokens: null,
    tokensPerSecond: null,
    requestBytes: 64,
    responseBytes: 12,
    truncated: false,
  },
] }));

vi.mock("../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...actual,
    llmLogList: vi.fn().mockResolvedValue(ROWS),
    llmLogStats: vi.fn().mockResolvedValue({
      total: 2,
      errorCount: 1,
      inputTokens: 17,
      outputTokens: 24,
      avgTtftMs: 255,
      avgTokensPerSecond: 66.9,
      oldestAt: ROWS[1].createdAt,
      newestAt: ROWS[0].createdAt,
    }),
    llmLogGet: vi.fn().mockImplementation((id: string) =>
      Promise.resolve({
        ...ROWS.find((r) => r.id === id)!,
        requestBody: '{"model":"local","messages":[{"role":"user","content":"Reply pong"}]}',
        responseBody: 'data: {"object":"chat.completion.chunk"}\n\ndata: [DONE]\n\n',
        timingsJson: '{"prompt_n":17,"predicted_n":24,"predicted_per_second":66.9}',
      }),
    ),
    llmLogClear: vi.fn().mockResolvedValue(2),
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

describe("LogsView", () => {
  it("renders a row per logged request with its telemetry", async () => {
    render(<LogsView />);

    expect(await screen.findByText("/v1/chat/completions")).toBeTruthy();
    expect(await screen.findByText("/api/chat")).toBeTruthy();

    // Both origins are shown — a relay call and a proxied one are different
    // things and the view must not conflate them.
    expect(await screen.findByText("external")).toBeTruthy();
    expect(await screen.findByText("relay")).toBeTruthy();

    // Token counts and throughput come from the normalizer.
    expect(await screen.findByText("24 out")).toBeTruthy();
    expect(await screen.findByText("66.9 tok/s")).toBeTruthy();
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
  });

  it("shows the real bound gateway port, not a placeholder", async () => {
    render(<LogsView />);
    expect(await screen.findByText("http://127.0.0.1:8791")).toBeTruthy();
  });
});
