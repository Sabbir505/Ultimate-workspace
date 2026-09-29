// IPC for the local-model request log + loopback gateway (src-tauri/llm_log).
// Command names and payload shapes are binding (CONTRACT.md).
import { safeInvoke } from "../ipcCore";
import type { LlmLogDetail, LlmLogSummary, LlmLogStats, LogConfig, GatewayStatus } from "../../types";

export interface LlmLogFilter {
  origin?: "relay" | "external" | null;
  target?: string | null;
  search?: string | null;
  limit?: number;
}

/** Newest-first page of log rows, without bodies (the list can be long). */
export const llmLogList = (filter: LlmLogFilter = {}) =>
  safeInvoke<LlmLogSummary[]>("llm_log_list", {
    filter: {
      origin: filter.origin ?? null,
      target: filter.target ?? null,
      search: filter.search ?? null,
      limit: filter.limit ?? 200,
    },
  });

/** One row with its verbatim request/response bodies. */
export const llmLogGet = (id: string) => safeInvoke<LlmLogDetail | null>("llm_log_get", { id });

export const llmLogClear = () => safeInvoke<number>("llm_log_clear");

export const llmLogStats = () => safeInvoke<LlmLogStats>("llm_log_stats");

/** Run retention + row-cap pruning now instead of waiting for the hourly tick. */
export const llmLogPrune = () => safeInvoke<number>("llm_log_prune");

export const llmLogConfigGet = () => safeInvoke<LogConfig>("llm_log_config_get");

export const llmLogConfigSet = (patch: Partial<Omit<LogConfig, "">>) =>
  safeInvoke<LogConfig>("llm_log_config_set", patch);

export const gatewayStatus = () => safeInvoke<GatewayStatus>("gateway_status");

export const gatewaySetRequireAuth = (require: boolean) =>
  safeInvoke<boolean>("gateway_set_require_auth", { require });

export const gatewaySetDefaultTarget = (target: string | null) =>
  safeInvoke<void>("gateway_set_default_target", { target: target ?? null });

/**
 * Register arbitrary upstreams so a runtime we don't know about can be proxied
 * without a rebuild: `{ "my-llama": "http://127.0.0.1:18080" }`.
 */
export const gatewaySetTargets = (targets: Record<string, string>) =>
  safeInvoke<void>("gateway_set_targets", { targets });

/** Is the named target answering right now? */
export const gatewayProbe = (name: string) => safeInvoke<boolean>("gateway_probe", { name });
