// Shared model-output segment model: how an assistant message (or a subagent
// transcript) splits into plain text, <think> reasoning blocks, and <tool>
// process cards. Consumed by the chat MessageBubble and the Agents subagent
// pane — kept as a leaf lib module so UI components don't have to depend on
// each other for parsing.

/** Payload of a file-write/edit tool call (write_file / edit_file): the
 *  old/new content the UI renders as an inline diff review card (mockup 01
 *  callout 5). See `tool_block` in src-tauri/src/chat/proto.rs. */
export type EditPayload =
  | { mode: "write"; content: string }
  | { mode: "append"; append: string }
  | { mode: "replace"; find: string; replace: string };

/** A tool-call process step emitted by the backend as `<tool>{json}</tool>`. */
export interface ToolData {
  kind?: string;
  title?: string;
  detail?: string;
  lang?: string;
  code?: string;
  /** File-edit payloads carry the target path and the old/new content so the
   *  UI can render an inline diff review card. */
  path?: string;
  edit?: EditPayload;
  /** Subagent Task steps carry the spawned agent's role + task so the row
   *  renders as the "SubAgent <role> · <task>" chip (shine while running). */
  role?: string;
  task?: string;
  /** Optional result text rendered once the call completes. The backend
   *  doesn't populate this today (tool output is summarized by the model in
   *  the following narration), but the expandable step detail shows args/code
   *  regardless — `result` is reserved so a future backend field flows
   *  straight into the same disclosure. */
  result?: string;
}

export type Segment =
  | { type: "text"; text: string }
  | { type: "think"; text: string; done: boolean }
  | { type: "tool"; data: ToolData | null; done: boolean };

/** Split an assistant message into ordered segments: plain markdown text,
 *  `<think>` reasoning blocks, and `<tool>` process cards. A block whose
 *  closing tag hasn't streamed in yet is marked `done: false`. */
export function parseSegments(content: string): Segment[] {
  const segs: Segment[] = [];
  let rest = content;
  const tagRe = /<(think|tool)>/;
  for (;;) {
    const m = tagRe.exec(rest);
    if (!m) {
      if (rest) segs.push({ type: "text", text: rest });
      break;
    }
    const before = rest.slice(0, m.index);
    if (before) segs.push({ type: "text", text: before });

    const tag = m[1];
    const afterOpen = rest.slice(m.index + m[0].length);
    const close = `</${tag}>`;
    const ci = afterOpen.indexOf(close);
    // Parallel subagent fan-out opens several <tool> markers BACK-TO-BACK
    // (the pre-pass emits every Task's opener before any tool completes), so
    // a repeated opener can arrive before the closing tag. Treat the next
    // opener as the end of THIS segment — still unterminated (done: false) —
    // instead of swallowing the whole run into one inner blob whose JSON
    // parse fails and renders a phantom "working…" row. Tool-marker content
    // is sanitizer-escaped, so a real opener inside `inner` can't false-hit;
    // `<think>` never stacks, so the split stays tool-only.
    const ni = tag === "tool" ? afterOpen.indexOf("<tool>") : -1;
    const end = ci === -1 ? ni : ni === -1 ? ci : Math.min(ci, ni);
    const inner = end === -1 ? afterOpen : afterOpen.slice(0, end);
    const done = end !== -1 && end === ci;

    if (tag === "think") {
      segs.push({ type: "think", text: inner.trim(), done });
    } else {
      let data: ToolData | null = null;
      try {
        data = JSON.parse(inner) as ToolData;
      } catch {
        data = null;
      }
      segs.push({ type: "tool", data, done });
    }

    if (end === -1) break;
    rest =
      end === ci
        ? afterOpen.slice(ci + close.length)
        : afterOpen.slice(end);
  }
  return segs;
}
