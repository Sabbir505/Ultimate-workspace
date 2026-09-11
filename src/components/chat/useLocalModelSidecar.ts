// Local GGUF model discovery + sidecar lifecycle for the chat view, carved
// out of ChatView.tsx verbatim: the scanned-model list, the live sidecar id,
// the persisted per-model overrides blob, spawn/swap with prompt-cache
// warmup, and the chat-switch re-warm. The session-mutating pick handlers
// (handleModelChange / handleLoadLocalModel / handleAgentModelPick) stay in
// ChatView — their agent→spawn→provider→model ordering contract spans store
// writes this hook doesn't own.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChatStore } from "../../state/chat";
import { useProjectsStore } from "../../state/projects";
import {
  getLocalModelOverrides,
  scanLocalModels,
  startLocalModel,
  localModelStatus,
  warmupLocalPrompt,
  type GgufModel,
  type LlamaOverrides,
} from "../../lib/ipc";

export function useLocalModelSidecar({
  activeChatSessionId,
  isLocal,
  activeSessionModel,
}: {
  activeChatSessionId: string | null;
  isLocal: boolean;
  /** The active session's stored model — the sidecar probe re-runs when it
   *  changes (the ⏏ button tracks what the session points at). */
  activeSessionModel: string | null | undefined;
}) {
  // Scanned local GGUF records — resolve picks from the combined picker into
  // spawnable sidecars, and `resolvedModel` into name/filename form. The
  // picker itself fetches every agent's/model list (harness config, provider
  // /v1/models, local scan) directly.
  const [localModels, setLocalModels] = useState<GgufModel[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  // id of the running local-model sidecar, or null if none. Drives the ⏏
  // button on the model pill — the button is only shown when a sidecar is
  // actually live (verified via local_model_status, not just inferred from
  // the session's stored model, since the user may have killed the sidecar
  // manually between sessions).
  const [activeLocalModelId, setActiveLocalModelId] = useState<string | null>(null);
  // Persisted per-model runtime overrides (`localModels.overrides` blob) —
  // the single source of truth the backend also reads at spawn time. Loaded
  // on mount and refreshed after every Apply; a ref mirror keeps the spawn
  // handlers free of stale closures.
  const [localOverridesMap, setLocalOverridesMap] = useState<Record<string, LlamaOverrides>>({});
  const localOverridesMapRef = useRef<Record<string, LlamaOverrides>>({});
  const refreshLocalOverrides = useCallback(async () => {
    try {
      const blob = await getLocalModelOverrides();
      const map = blob ? (JSON.parse(blob) as Record<string, LlamaOverrides>) : {};
      localOverridesMapRef.current = map;
      setLocalOverridesMap(map);
    } catch {
      /* best-effort — empty map means "all auto" */
    }
  }, []);
  useEffect(() => {
    void refreshLocalOverrides();
  }, [refreshLocalOverrides]);
  /** Per-model persisted overrides keyed by the picker's row id
   *  (name/filename) — seeds the gear panel drafts. */
  const localOverridesByName = useMemo(() => {
    const out: Record<string, LlamaOverrides> = {};
    for (const m of localModels) {
      const ov = localOverridesMap[m.id];
      if (ov) out[m.name || m.filename] = ov;
    }
    return out;
  }, [localModels, localOverridesMap]);

  // Scan local GGUF files (default locations + any persisted folders) for
  // EVERY session — local models are offered in the picker regardless of
  // the session's provider; picking one switches the session to local_gguf.
  useEffect(() => {
    let stale = false;
    void scanLocalModels()
      .then((list) => {
        if (!stale && list) setLocalModels(list);
      })
      .catch(() => {
        /* local-model discovery is best-effort; leave the list empty */
      });
    return () => {
      stale = true;
    };
    // PERF (audit #37): the scan walks the model directories over IPC and its
    // result doesn't depend on the session — it used to re-run on EVERY chat
    // switch. Rescan on mount and when a local-model load settles (a fresh
    // download can add a model).
  }, [localLoading]);

  // Track the running sidecar so the ⏏ button on the model pill only shows
  // when a llama-server is actually live. Polled on mount, whenever the
  // active session changes, and whenever a local model finishes loading
  // (so the button appears the moment a pick completes).
  useEffect(() => {
    let stale = false;
    void localModelStatus()
      .then((status) => {
        if (stale) return;
        setActiveLocalModelId(status?.modelId ?? null);
      })
      .catch(() => {
        /* status probe failure just means no live sidecar */
      });
    return () => {
      stale = true;
    };
  }, [activeChatSessionId, localLoading, activeSessionModel]);

  // Spawn/swap the local-model sidecar for a scanned GGUF record. Returns the
  // error text on failure (surfaced by the callers via the chat error banner)
  // or null on success. The caller decides what to persist — on failure the
  // session must NOT be stomped to the failed model (the previous sidecar is
  // the only thing a send could still hit). `overrides` (from the picker's
  // per-model gear panel) wins; without it the backend loads the persisted
  // overrides blob itself (incl. last-good ngl).
  //
  // lastWarmRef dedupes prompt warmups with the chat-switch effect below:
  // the cached prefix includes the chat's working-directory section, so
  // switching between chats with different roots needs a re-warm.
  const lastWarmRef = useRef<{ sid: string | null; wd: string } | null>(null);
  const spawnLocalModel = useCallback(
    async (match: GgufModel, overrides?: LlamaOverrides): Promise<string | null> => {
      setLocalLoading(true);
      try {
        await startLocalModel(match.id, match.path, match.mmprojPath, overrides);
        // Warm the prompt cache with the EXACT prefix this session's next
        // send will render — system prompt + tools + the `## Working
        // directory` tail. The working dir is frontend state (custom folder →
        // worktree → bound project), resolved here exactly like sendMessage
        // resolves it; the backend can't know it at load time. The loading
        // spinner stays up until the warmup completes, so "loaded" means the
        // first message answers immediately instead of paying CUDA init +
        // multi-thousand-token prompt eval. Best-effort: a failed warmup
        // just means the first send pays the normal cold-start cost.
        try {
          const s = useChatStore.getState();
          const sid = s.activeChatSessionId;
          const session = sid ? s.sessions.find((x) => x.id === sid) : undefined;
          const projects = useProjectsStore.getState();
          const boundProject = sid
            ? projects.projectById(s.sessionProjects[sid] ?? projects.selectedProjectId)
            : undefined;
          const workingDir =
            (sid ? s.cwdOverrides[sid] : undefined) ??
            session?.worktreePath ??
            boundProject?.path;
          // Composer toggles ride along: the tool specs are part of the cached
          // prefix, so a warmup that assumes different toggles than the first
          // send uses saves nothing (this mismatch — web_search/code_exec —
          // is exactly what made first messages pay the full prompt eval).
          await warmupLocalPrompt(
            workingDir,
            sid,
            s.toolsEnabled,
            s.codeExecEnabled,
          );
          lastWarmRef.current = { sid: sid ?? null, wd: workingDir ?? "" };
        } catch (warmErr) {
          console.warn("prompt warmup failed (non-fatal)", warmErr);
        }
        return null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("start local model failed", msg);
        return msg;
      } finally {
        setLocalLoading(false);
      }
    },
    [],
  );

  // Re-warm the prompt cache when the active chat changes (while a local
  // model is loaded and idle): the cached prefix includes the chat's
  // working-directory section, so the first message in a NEW chat (different
  // project, or unbound) used to pay the full ~22s re-eval. Fire-and-forget —
  // a message sent mid-warmup queues behind it (the same cost it would pay
  // without any warmup), and a completed one makes the first token instant.
  useEffect(() => {
    if (!isLocal || localLoading) return;
    const s = useChatStore.getState();
    if (activeChatSessionId && activeChatSessionId in s.streaming) return;
    // Only fresh conversations need a warmup: a session with completed turns
    // already has its real prefix cached from the last turn, and a synthetic
    // warmup would just churn the GPU queue behind live traffic.
    if (activeChatSessionId && s.messages.some((m) => m.role === "assistant")) return;
    const session = activeChatSessionId
      ? s.sessions.find((x) => x.id === activeChatSessionId)
      : undefined;
    const projects = useProjectsStore.getState();
    const boundProject = activeChatSessionId
      ? projects.projectById(s.sessionProjects[activeChatSessionId] ?? projects.selectedProjectId)
      : undefined;
    const wd =
      (activeChatSessionId ? s.cwdOverrides[activeChatSessionId] : undefined) ??
      session?.worktreePath ??
      boundProject?.path ??
      "";
    const last = lastWarmRef.current;
    if (last && last.sid === (activeChatSessionId ?? null) && last.wd === wd) return;
    lastWarmRef.current = { sid: activeChatSessionId ?? null, wd };
    void warmupLocalPrompt(
      wd || null,
      activeChatSessionId,
      s.toolsEnabled,
      s.codeExecEnabled,
    ).catch(() => {});
  }, [activeChatSessionId, isLocal, localLoading]);

  return {
    localModels,
    localLoading,
    activeLocalModelId,
    setActiveLocalModelId,
    localOverridesMap,
    setLocalOverridesMap,
    localOverridesMapRef,
    localOverridesByName,
    refreshLocalOverrides,
    spawnLocalModel,
  };
}
