// Tool-call debug summarizer for the Logs page (llm_log entries). The log
// stores the raw request/response BYTES verbatim; this module re-derives the
// tool-calling story from them — which tool schemas the request advertised
// and what tool calls (native `tool_calls` or Hermes-style `<tool_call>`
// text) the response actually produced. Pure and dependency-free so it is
// unit-testable and safe on 256 KiB bodies.

export interface ToolCallSummary {
  /** Names from the request's `tools` array, in request order. */
  requestedTools: string[];
  /** Tool calls the response produced, in stream order. */
  respondedCalls: ToolCallDebugEntry[];
  /** Set when the body is neither JSON nor SSE-decodable (e.g. binary). */
  requestNote?: string;
  responseNote?: string;
}

export interface ToolCallDebugEntry {
  name: string;
  /** First N chars of the concatenated arguments JSON (stream fragments
   *  re-assembled by index). "" when the call carries no arguments. */
  argsPreview: string;
}

const ARGS_PREVIEW_CHARS = 300;

function preview(s: string): string {
  return s.length > ARGS_PREVIEW_CHARS ? `${s.slice(0, ARGS_PREVIEW_CHARS)}…` : s;
}

function safeParse(body: string): unknown | undefined {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function functionNameOf(call: unknown): string {
  if (typeof call !== "object" || call === null) return "";
  const c = call as Record<string, unknown>;
  const fn = c.function;
  if (typeof fn === "object" && fn !== null) {
    const f = fn as Record<string, unknown>;
    if (typeof f.name === "string") return f.name;
  }
  if (typeof c.name === "string") return c.name;
  return "";
}

function functionArgsOf(call: unknown): string {
  if (typeof call !== "object" || call === null) return "";
  const c = call as Record<string, unknown>;
  const fn = c.function;
  if (typeof fn === "object" && fn !== null) {
    const f = fn as Record<string, unknown>;
    if (typeof f.arguments === "string") return f.arguments;
  }
  if (typeof c.arguments === "string") return c.arguments;
  return "";
}

/** Tool names from a chat-completions request body. */
function toolsFromRequest(json: unknown): string[] {
  if (typeof json !== "object" || json === null) return [];
  const tools = (json as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t) => {
      if (typeof t === "object" && t !== null) {
        const fn = (t as Record<string, unknown>).function;
        if (typeof fn === "object" && fn !== null) {
          const name = (fn as Record<string, unknown>).name;
          if (typeof name === "string") return name;
        }
        const name = (t as Record<string, unknown>).name;
        if (typeof name === "string") return name;
      }
      return "";
    })
    .filter((n) => n !== "");
}

/** Hermes-style text tool calls (`<tool_call>{...}</tool_call>`) — what
 *  llama.cpp models emit when the server-side grammar path is off. */
function hermesCallsFromText(text: string): ToolCallDebugEntry[] {
  const out: ToolCallDebugEntry[] = [];
  const re = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const parsed = safeParse(m[1].trim());
    if (typeof parsed === "object" && parsed !== null) {
      const p = parsed as Record<string, unknown>;
      const name = typeof p.name === "string" ? p.name : "";
      const args =
        typeof p.arguments === "string"
          ? p.arguments
          : p.arguments != null
            ? JSON.stringify(p.arguments)
            : "";
      if (name) out.push({ name, argsPreview: preview(args) });
    }
  }
  return out;
}

/** One SSE/NDJSON line's delta tool_calls, if any. Returns [] for lines
 *  without tool-call fragments (most of them). */
function deltaCallsFromChunk(json: unknown): Array<{ index: number; name: string; args: string }> {
  if (typeof json !== "object" || json === null) return [];
  const choices = (json as Record<string, unknown>).choices;
  if (!Array.isArray(choices)) return [];
  const out: Array<{ index: number; name: string; args: string }> = [];
  for (const choice of choices) {
    if (typeof choice !== "object" || choice === null) continue;
    const delta = (choice as Record<string, unknown>).delta;
    if (typeof delta !== "object" || delta === null) continue;
    const calls = (delta as Record<string, unknown>).tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (typeof call !== "object" || call === null) continue;
      const c = call as Record<string, unknown>;
      const idx = typeof c.index === "number" ? c.index : out.length;
      const fn = c.function;
      const name =
        typeof fn === "object" && fn !== null && typeof (fn as Record<string, unknown>).name === "string"
          ? ((fn as Record<string, unknown>).name as string)
          : "";
      const args =
        typeof fn === "object" && fn !== null && typeof (fn as Record<string, unknown>).arguments === "string"
          ? ((fn as Record<string, unknown>).arguments as string)
          : "";
      out.push({ index: idx, name, args });
    }
  }
  return out;
}

/** Non-stream chat-completions response tool calls. */
function messageCallsFromResponse(json: unknown): ToolCallDebugEntry[] {
  if (typeof json !== "object" || json === null) return [];
  const choices = (json as Record<string, unknown>).choices;
  if (!Array.isArray(choices)) return [];
  const out: ToolCallDebugEntry[] = [];
  for (const choice of choices) {
    if (typeof choice !== "object" || choice === null) continue;
    const message = (choice as Record<string, unknown>).message;
    if (typeof message !== "object" || message === null) continue;
    const calls = (message as Record<string, unknown>).tool_calls;
    if (Array.isArray(calls)) {
      for (const call of calls) {
        const name = functionNameOf(call);
        if (name) out.push({ name, argsPreview: preview(functionArgsOf(call)) });
      }
    }
    const content = (message as Record<string, unknown>).content;
    if (typeof content === "string") out.push(...hermesCallsFromText(content));
  }
  return out;
}

/**
 * Re-derive the tool-calling story from the stored raw bodies. Never throws:
 * a body that is not JSON simply yields an empty/note result — the verbatim
 * pane above it remains the source of truth.
 */
export function summarizeToolCalls(
  requestBody: string | null | undefined,
  responseBody: string | null | undefined,
): ToolCallSummary {
  const out: ToolCallSummary = { requestedTools: [], respondedCalls: [] };

  if (requestBody) {
    const json = safeParse(requestBody);
    if (json === undefined) {
      out.requestNote = "request body is not JSON";
    } else {
      out.requestedTools = toolsFromRequest(json);
    }
  }

  if (responseBody) {
    // Whole-body JSON first (non-stream responses, error bodies).
    const asJson = safeParse(responseBody);
    if (asJson !== undefined) {
      out.respondedCalls = messageCallsFromResponse(asJson);
    } else {
      // SSE (`data: {...}` lines) or Ollama-style NDJSON: per-line JSON,
      // accumulating delta fragments by tool-call index. The final line of a
      // truncated body fails to parse and is skipped silently.
      const acc = new Map<number, { name: string; args: string }>();
      for (const line of responseBody.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed === "data: [DONE]") continue;
        const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
        const json = safeParse(payload);
        if (json === undefined) continue;
        for (const d of deltaCallsFromChunk(json)) {
          const slot = acc.get(d.index) ?? { name: "", args: "" };
          if (!slot.name && d.name) slot.name = d.name;
          slot.args += d.args;
          acc.set(d.index, slot);
        }
      }
      out.respondedCalls = [...acc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, slot]) => ({ name: slot.name, argsPreview: preview(slot.args) }));
      // Also sweep Hermes-style calls out of streamed content deltas.
      const text = responseBody
        .split("\n")
        .map((l) => l.replace(/^\s*data:\s?/, ""))
        .join("");
      const streamedText = [...text.matchAll(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/g)]
        .map((m) => {
          try {
            return JSON.parse(`"${m[1]}"`) as string;
          } catch {
            return "";
          }
        })
        .join("");
      const hermes = hermesCallsFromText(streamedText);
      if (hermes.length > 0) out.respondedCalls.push(...hermes);
    }
  }

  return out;
}
