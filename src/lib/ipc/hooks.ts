// User hooks (Settings → Hooks): scripts that run before/after agent tool
// calls and can block, approve, rewrite, or annotate them. Config is a JSON
// array under the `hooks` app_settings key (same generic-settings pattern as
// `permissions.rules`); the only dedicated command is `hooks_test`, which runs
// a hook against a synthetic payload through the same exec-gate trust as live
// turns. Command names and payload shapes are binding (CONTRACT.md).
import { safeInvoke, safeListen } from "../ipcCore";
import { jsonSetting } from "../ipc";

export type HookEvent =
  | "pre_tool_use"
  | "post_tool_use"
  | "turn_complete"
  | "session_start";

export interface HookDef {
  id: string;
  event: HookEvent;
  name: string;
  /** Tool names to match: `*`/empty = all, else exact names joined with `|`. */
  matcher: string;
  command: string;
  /** Exec-form arguments; `${tool_input.key}` tokens substitute per call. */
  args: string[];
  timeoutSecs: number;
  /** `open` skips a failed hook; `closed` denies the call instead. */
  onError: "open" | "closed";
  /** Post-hooks only: run detached as a pure observer. */
  async: boolean;
  /**
   * Origin scope: EMPTY = global (fires for every dispatch origin — the
   * default, and what every config saved before this field means). Otherwise
   * the hook fires only when the call's origin is in the list. The backend
   * compares verbatim and never rejects an unknown value, so subagent ids stay
   * expressible.
   */
  origins: string[];
  enabled: boolean;
}

export interface HookTestReport {
  ran: boolean;
  gateDenied: boolean;
  spawnFailed: boolean;
  timedOut: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  decision: string | null;
  reason: string | null;
  durationMs: number;
}

const HOOKS_KEY = "hooks";
const jsonHooks = jsonSetting<HookDef>(HOOKS_KEY);

/** The origin strings the backend dispatches, minus the open-ended
 *  `agent:<subagent-id>` family (see {@link isKnownOrigin}). A hook whose
 *  `origins` is empty is global and fires for all of them. */
export const KNOWN_HOOK_ORIGINS: string[] = [
  "chat",
  "subagents",
  "harness",
  "relay_tools",
];

/** Human labels for the origin picker — the stored value is always the raw
 *  string, these are display-only. */
export const HOOK_ORIGIN_LABELS: Record<string, string> = {
  chat: "main chat",
  subagent: "builtin Task roles",
  harness: "CLI harness (claude/kimi)",
  relay_tools: "relay tools bridge",
};

/** True for a known origin, and for any `agent:<id>` — subagent ids are dynamic,
 *  so a closed vocabulary would flag every subagent-scoped hook as unknown. */
export function isKnownOrigin(o: string): boolean {
  return KNOWN_HOOK_ORIGINS.includes(o) || /^agent:/.test(o);
}

/** Fill in the fields a hand-edited / pre-`origins` config may be missing, so
 *  callers never have to guard for `undefined`. Only `origins` defaults
 *  matter here; everything else is filled by the editor, not by the loader. */
export function normalizeHookDef(def: HookDef): HookDef {
  return { ...def, origins: Array.isArray(def.origins) ? def.origins : [] };
}

/** Load the configured hooks (empty array when unset/invalid). Each entry is
 *  normalized, so a config written before `origins` existed reads back as the
 *  global scope rather than `undefined`. */
export const getHooks = async (): Promise<HookDef[]> =>
  (await jsonHooks.load()).map(normalizeHookDef);

/** Persist the full hooks list. */
export const saveHooks = jsonHooks.save;

/** Run one hook against a synthetic pre_tool_use payload (Test button). */
export const testHook = (def: HookDef) =>
  safeInvoke<HookTestReport>("hooks_test", { def });

export interface ClaudeImportReport {
  imported: string[];
  skippedDuplicates: number;
  skippedNonCommand: number;
  fileFound: boolean;
}

/** Import command-type hooks from ~/.claude/settings.json (deduped). */
export const importFromClaude = () =>
  safeInvoke<ClaudeImportReport>("hooks_import_claude", {});

/** One live hook-run observation, emitted by the backend on `chat:hook-run`
 *  after each hook execution (and for a hook `ask` degraded to proceed under
 *  full_auto — `verdict: "ask-dropped"`, no hook name). */
export interface HookRunPayload {
  chatSessionId: string | null;
  event: HookEvent;
  hookName: string;
  tool: string;
  verdict: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

/** Stream `chat:hook-run` events for the Hooks panel's live run list. */
export const onHookRun = (handler: (p: HookRunPayload) => void) =>
  safeListen<HookRunPayload>("chat:hook-run", handler);
