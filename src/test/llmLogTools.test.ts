// The Logs page's tool-call debug summarizer: re-derives advertised tool
// schemas and emitted tool calls from the raw stored bodies. Covers the four
// shapes llama-server traffic actually takes (non-stream JSON, SSE deltas,
// Hermes text calls, error bodies) plus resilience to garbage.
import { describe, expect, it } from "vitest";
import { summarizeToolCalls } from "../lib/llmLogTools";

describe("summarizeToolCalls", () => {
  it("extracts the request's advertised tool names in order", () => {
    const req = JSON.stringify({
      model: "local",
      tools: [
        { type: "function", function: { name: "read_file", parameters: {} } },
        { type: "function", function: { name: "search_docs", parameters: {} } },
        { type: "function", function: { name: "write_file", parameters: {} } },
      ],
      messages: [],
    });
    const got = summarizeToolCalls(req, null);
    expect(got.requestedTools).toEqual(["read_file", "search_docs", "write_file"]);
    expect(got.respondedCalls).toEqual([]);
  });

  it("handles a request without tools and absent bodies", () => {
    const got = summarizeToolCalls('{"model":"m","messages":[]}', null);
    expect(got.requestedTools).toEqual([]);
    expect(got.respondedCalls).toEqual([]);
    expect(summarizeToolCalls(null, null).requestedTools).toEqual([]);
  });

  it("reads non-stream responses' message.tool_calls", () => {
    const res = JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "write_file", arguments: '{"path":"a.md","content":"hi"}' },
              },
            ],
          },
        },
      ],
    });
    const got = summarizeToolCalls(null, res);
    expect(got.respondedCalls).toEqual([
      { name: "write_file", argsPreview: '{"path":"a.md","content":"hi"}' },
    ]);
  });

  it("re-assembles SSE delta fragments by index", () => {
    const res = [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}',
      "",
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}',
      "",
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"docs/x.md\\"}"}}]}}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const got = summarizeToolCalls('{"tools":[{"function":{"name":"read_file"}}]}', res);
    expect(got.respondedCalls).toEqual([
      { name: "read_file", argsPreview: '{"path":"docs/x.md"}' },
    ]);
  });

  it("keeps parallel tool calls in stream order", () => {
    const res = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"name":"search_docs","arguments":"{}"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read_file","arguments":"{}"}}]}}]}',
      "data: [DONE]",
    ].join("\n");
    const got = summarizeToolCalls(null, res);
    expect(got.respondedCalls.map((c) => c.name)).toEqual(["read_file", "search_docs"]);
  });

  it("sweeps Hermes-style <tool_call> text out of streamed content", () => {
    const content = 'Let me check. <tool_call>{"name":"read_file","arguments":"{\\"path\\":\\"a.md\\"}"}</tool_call>';
    const res = `data: ${JSON.stringify({
      choices: [{ delta: { content } }],
    })}\n\ndata: [DONE]\n\n`;
    const got = summarizeToolCalls(null, res);
    expect(got.respondedCalls).toEqual([
      { name: "read_file", argsPreview: '{"path":"a.md"}' },
    ]);
  });

  it("also reads Hermes calls from a non-stream content string", () => {
    const res = JSON.stringify({
      choices: [{ message: { role: "assistant", content: '<tool_call>{"name":"list_skills","arguments":"{}"}</tool_call>' } }],
    });
    const got = summarizeToolCalls(null, res);
    expect(got.respondedCalls).toEqual([{ name: "list_skills", argsPreview: "{}" }]);
  });

  it("treats an error body as no calls, never a parse failure", () => {
    const got = summarizeToolCalls(
      '{"tools":[{"function":{"name":"read_file"}}]}',
      '{"error":{"message":"tools param requires --jinja flag"}}',
    );
    expect(got.requestedTools).toEqual(["read_file"]);
    expect(got.respondedCalls).toEqual([]);
  });

  it("never throws on non-JSON bodies; notes them instead", () => {
    const got = summarizeToolCalls("binary garbage \u0000\u0001", "\u0000not json");
    expect(got.requestedTools).toEqual([]);
    expect(got.respondedCalls).toEqual([]);
    expect(got.requestNote).toBeTruthy();
  });

  it("caps the argument preview", () => {
    const big = "x".repeat(1000);
    const res = JSON.stringify({
      choices: [{ message: { tool_calls: [{ function: { name: "f", arguments: big } }] } }],
    });
    const got = summarizeToolCalls(null, res);
    expect(got.respondedCalls[0].argsPreview.length).toBeLessThanOrEqual(301);
    expect(got.respondedCalls[0].argsPreview.endsWith("…")).toBe(true);
  });
});
