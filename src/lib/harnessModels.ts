// Static per-harness model catalog for the composer's agent-then-model
// selector (mockup 02, state C). The ids mirror the canonical pricing keys in
// `canonical_model_key()` / `default_rates()` in
// src-tauri/src/harness_adapters/mod.rs — keep the two in sync when the Rust
// table changes.
//
// TODO(headless-cli-chat): replace this static catalog with a live query of
// the selected CLI itself (stream-json handshake / ACP `session/new`
// capabilities) once the headless CLI chat protocol lands. The mockup's
// "↻ Refresh list from CLI" row depends on that.

export interface HarnessModel {
  /** Canonical id — stored on the chat session and matched by the backend's
   *  loose `contains` pricing-key matcher. */
  id: string;
  /** Human label shown in the model dropdown (e.g. "Sonnet 4.5"). */
  label: string;
}

const CLAUDE_MODELS: HarnessModel[] = [
  { id: "claude-opus-4-8", label: "Opus 4.8" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-sonnet-4-5", label: "Sonnet 4.5" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5" },
];

const KIMI_MODELS: HarnessModel[] = [
  { id: "kimi-k3", label: "Kimi K3" },
  { id: "kimi-k2.7-code", label: "Kimi K2.7 Code" },
  { id: "kimi-k2.6", label: "Kimi K2.6" },
];

/** Models offered for a CLI agent, keyed by harness id. Claude and Kimi
 *  accept the bare ids above on their `--model`/`-m` selectors (and remap
 *  them through their own settings), so a static fallback list is safe.
 *  OpenCode, Pi, Omp, and CommandCode are provider-scoped: their selectors
 *  only accept "provider/id" strings discovered from each CLI's own
 *  config/live query (listHarnessModels). A static union of bare ids can't be
 *  selected by those CLIs — a bare pick silently fell back to the CLI's
 *  configured default, which read as "changing the model does nothing" — so
 *  those harnesses deliberately get no static rows. */
export function harnessModelCatalog(harnessId: string): HarnessModel[] {
  switch (harnessId) {
    case "claude_code":
      return CLAUDE_MODELS;
    case "kimi_code":
      return KIMI_MODELS;
    default:
      return [];
  }
}

/** id → label lookup for the catalog of one harness (feeds ModelEffortMenu's
 *  `labels` prop so rows and the trigger pill show the human label). */
export function harnessModelLabels(harnessId: string): Record<string, string> {
  return Object.fromEntries(harnessModelCatalog(harnessId).map((m) => [m.id, m.label]));
}
