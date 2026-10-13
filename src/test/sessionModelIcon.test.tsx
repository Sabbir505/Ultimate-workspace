// Sidebar brand icon: the row's glyph is derived from the session's agent +
// provider, and the agent must win. A harness/ACP session keeps whichever
// provider the row was created under — a chat created while a local model was
// active still reads "local_gguf" after the picker switched it to the CLI
// (the CLI send path ignores the provider), and the old local-first
// precedence made those rows show the local desktop glyph while the picker
// rail and the composer chip showed the CLI's own mark.
//
// Note: the project doesn't register @testing-library/jest-dom, so we use
// plain DOM queries (toBeNull / toBeTruthy) instead of the custom matchers.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { sessionModelIcon } from "../components/chat/agentIcons";
import { ChatSessionRow, type ChatSessionRowData } from "../components/chat/ChatSessionRow";

/** The glyph's own <title> (each brand icon renders one) — the discriminator
 *  between the local desktop mark and a harness/provider brand. */
function iconTitle(agent?: string | null, provider?: string | null): string | null {
  const { container } = render(<>{sessionModelIcon(agent, provider)}</>);
  const title = container.querySelector("title")?.textContent ?? null;
  cleanup();
  return title;
}

describe("sessionModelIcon precedence", () => {
  it("shows the harness mark over a stale local_gguf provider", () => {
    expect(iconTitle("harness:claude_code", "local_gguf")).toBe("Claude");
    expect(iconTitle("harness:opencode", "local_gguf")).toBe("OpenCode");
  });

  it("shows the harness mark with no provider at all", () => {
    expect(iconTitle("harness:claude_code", null)).toBe("Claude");
  });

  it("shows the ACP mark over a stale local_gguf provider", () => {
    expect(iconTitle("acp:zed", "local_gguf")).toBe("Zed");
  });

  it("still shows the local mark for local sessions", () => {
    // Both columns agree (the picker's local pick writes them together)…
    expect(iconTitle("local", "local_gguf")).toBe("Local model");
    // …and agent "local" alone is enough — provider is what can be stale.
    expect(iconTitle("local", null)).toBe("Local model");
    // Legacy rows with no agent at all read local from the provider column.
    expect(iconTitle(null, "local_gguf")).toBe("Local model");
    // Built-in sessions parked on the sidecar (agent never left "builtin").
    expect(iconTitle("builtin", "local_gguf")).toBe("Local model");
  });

  it("resolves cloud providers by kind", () => {
    expect(iconTitle("builtin", "anthropic")).toBe("Anthropic");
    expect(iconTitle("builtin", "openai")).toBe("OpenAI");
    expect(iconTitle("builtin", "openrouter")).toBe("OpenRouter");
  });

  it("falls back to the auto mark for auto routing and unknown pairs", () => {
    expect(iconTitle("builtin", "auto")).toBe("Auto");
    expect(iconTitle(null, null)).toBe("Auto");
  });

  it("falls back to a monogram for agents with no brand glyph", () => {
    const { container } = render(<>{sessionModelIcon("harness:user_defined", null)}</>);
    expect(container.querySelector(".agent-rail-monogram")?.textContent).toBe("U");
  });
});

function rowData(over: Partial<ChatSessionRowData> = {}): ChatSessionRowData {
  return { id: "chat-1", title: "My chat", lastActiveAt: 1_700_000_000, ...over };
}

afterEach(cleanup);

describe("ChatSessionRow provider mark", () => {
  it("marks a CLI chat as the CLI, with the cosmetic provider kept out of the tooltip", () => {
    const { container } = render(
      <ChatSessionRow
        session={rowData({ agent: "harness:claude_code", provider: "local_gguf" })}
        active={false}
        onSelect={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onToggleStar={() => {}}
        onSetUnread={() => {}}
        onExport={() => {}}
      />,
    );
    const mark = container.querySelector(".chat-session-provider");
    expect(mark?.querySelector("title")?.textContent).toBe("Claude");
    expect(mark?.getAttribute("title")).toBe("claude_code");
  });

  it("keeps the provider in the tooltip for built-in sessions", () => {
    const { container } = render(
      <ChatSessionRow
        session={rowData({ agent: "builtin", provider: "anthropic" })}
        active={false}
        onSelect={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onToggleStar={() => {}}
        onSetUnread={() => {}}
        onExport={() => {}}
      />,
    );
    const mark = container.querySelector(".chat-session-provider");
    expect(mark?.getAttribute("title")).toBe("anthropic · builtin");
  });
});
