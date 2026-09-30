// Per-model tool-calling badge — shared by the model picker's local pane,
// the settings Local Models panel, and the Model Market "My Models" rows.
// Renders nothing for "unknown": no signal either way is the normal case
// for untuned bases, and a gray badge on every row is noise.
import type { GgufModel } from "../../lib/ipc";

type ToolSupport = GgufModel["toolSupport"];

const BADGES: Record<Exclude<ToolSupport, "unknown">, { label: string; title: string }> = {
  template: {
    label: "Tools",
    title:
      "This model's chat template renders tool calls — agent tools should work out of the box.",
  },
  likely: {
    label: "Tools ~",
    title:
      "The architecture family ships tool-calling templates, but this file's own template doesn't advertise it. Verify in the Logs page; force on/off under the model's gear → Tool calling.",
  },
  forced: {
    label: "Tools forced",
    title:
      "Tool calling forced on for this model (gear → Tool calling), overriding a missing scan signal.",
  },
  disabled: {
    label: "No tools",
    title:
      "Tool calling disabled for this model — local turns skip the tools schema instead of failing. Toggle under the model's gear → Tool calling.",
  },
};

export function ModelToolBadge({ toolSupport }: { toolSupport: ToolSupport }) {
  // Unknown (and undefined from pre-flag fixtures/backends) renders nothing —
  // a gray badge on every untuned base is noise, not signal.
  if (!toolSupport || toolSupport === "unknown") return null;
  const b = BADGES[toolSupport];
  return (
    <span className={`model-tag tools tools-${toolSupport}`} title={b.title}>
      {b.label}
    </span>
  );
}
