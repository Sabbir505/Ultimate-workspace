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

/** Load the configured hooks (empty array when unset/invalid). */
export const getHooks = jsonHooks.load;

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
