// Canonical catalog of runnable agent/provider targets shown by the surfaces
// that let the user pick what executes a task: the Automations form, the
// artifact proposal card, and the Memory extraction picker. Harnesses first,
// then cloud API providers, then local. When a new harness or provider ships,
// add it here once — every picker updates together.

export type AgentOptionGroup = "harness" | "api" | "local";

export interface AgentOption {
  id: string;
  label: string;
  group: AgentOptionGroup;
}

export const AGENT_OPTIONS: AgentOption[] = [
  // Harnesses
  { id: "claude_code", label: "Claude Code (harness)", group: "harness" },
  { id: "opencode", label: "OpenCode (harness)", group: "harness" },
  { id: "pi", label: "Pi (harness)", group: "harness" },
  { id: "omp", label: "Omp (harness)", group: "harness" },
  { id: "commandcode", label: "CommandCode (harness)", group: "harness" },
  // API providers
  { id: "anthropic", label: "Anthropic API", group: "api" },
  { id: "openai", label: "OpenAI API", group: "api" },
  { id: "openrouter", label: "OpenRouter", group: "api" },
  { id: "anthropic_compatible", label: "Anthropic-compatible", group: "api" },
  { id: "openai_compatible", label: "OpenAI-compatible", group: "api" },
  // Local
  { id: "local_gguf", label: "Local GGUF", group: "local" },
];

/** The five cloud providers from Settings → API Keys — each is its own
 *  endpoint, so surfaces that probe per-provider state iterate this tuple. */
export const CLOUD_PROVIDER_IDS = [
  "anthropic",
  "openai",
  "openrouter",
  "anthropic_compatible",
  "openai_compatible",
] as const;

export type CloudProviderId = (typeof CLOUD_PROVIDER_IDS)[number];
