// Protocol-kind resolution for API endpoint ids. Shared by the IPC layer
// and any consumer that must treat a named endpoint as its kind (context
// windows, effort gating, icons). Kept dependency-free: lib/ipc re-exports
// it, and lib modules that ipc itself imports can safely use it too.

export type ChatProviderKind =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "anthropic_compatible"
  | "openai_compatible"
  | "local_gguf";

const CHAT_PROVIDER_KINDS: ChatProviderKind[] = [
  "anthropic",
  "openai",
  "openrouter",
  "anthropic_compatible",
  "openai_compatible",
  "local_gguf",
];

/** Protocol kind behind an endpoint id — mirrors the backend's
 *  chat::providers::provider_kind. Endpoint ids are either a bare kind
 *  ("anthropic" — the kind's default endpoint) or "<kind>-<suffix>" for
 *  extra endpoints of the same kind. Ids not shaped "<kind>-<suffix>" are
 *  returned unchanged. */
export const providerKindOf = (id: string): ChatProviderKind => {
  const dash = id.indexOf("-");
  const head = dash > 0 ? id.slice(0, dash) : id;
  return (
    CHAT_PROVIDER_KINDS.find((k) => k === head) ?? (id as ChatProviderKind)
  );
};
