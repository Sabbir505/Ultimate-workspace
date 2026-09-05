// Last committed composer pick (`chat.last_selection` setting) — the seed for
// every new chat. Written on EVERY selection (builtin, harness, ACP, local —
// including the Settings "Use this model" path), unlike the per-provider
// `chat.<provider>.model` default which only tracks cloud picks. This is what
// makes a fresh chat open ready-to-send on the thing the user was last using
// instead of falling back to a keyless provider with an empty model.
import { getSetting, setSetting } from "./ipc";

export interface LastSelection {
  /** "builtin" | "local" | "harness:<id>" | "acp:<id>" — same values as
   *  ChatSession.agent. */
  agent: string;
  /** Cloud provider id for builtin/local picks ("anthropic", …,
   *  "local_gguf"); null for harness/ACP picks (their sessions keep whatever
   *  provider the row was created with — the CLI send path ignores it). */
  provider: string | null;
  /** Model id as committed ("" for ACP — the agent decides). */
  model: string;
}

const KEY = "chat.last_selection";

export async function loadLastSelection(): Promise<LastSelection | null> {
  try {
    const raw = await getSetting(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastSelection> | null;
    if (!parsed || typeof parsed.agent !== "string" || typeof parsed.model !== "string") {
      return null;
    }
    return { agent: parsed.agent, provider: parsed.provider ?? null, model: parsed.model };
  } catch {
    // Corrupt blob must never block starting a chat — fall through to the
    // legacy per-provider config seed.
    return null;
  }
}

export async function saveLastSelection(sel: LastSelection): Promise<void> {
  await setSetting(KEY, JSON.stringify(sel));
}

/** What a brand-new chat should be seeded with, given the last committed
 *  pick (preferred — strictly fresher) and the legacy per-provider config
 *  from get_chat_config (fallback for users who never picked in the
 *  composer). Pure so the seeding rule can be pinned by tests. */
export function seedSelectionFrom(
  last: LastSelection | null | undefined,
  config: { provider: string | null; model: string | null } | null | undefined,
): { provider: string; model: string; agent: string | null } {
  if (last) {
    return {
      // Harness/ACP picks carry provider null — keep whatever provider
      // default exists (the CLI/ACP send path ignores it anyway).
      provider: last.provider ?? config?.provider ?? "openai_compatible",
      model: last.model,
      agent: last.agent,
    };
  }
  return {
    provider: config?.provider ?? "openai_compatible",
    model: config?.model ?? "",
    agent: null,
  };
}
