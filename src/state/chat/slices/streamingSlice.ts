// Streaming slice: the send paths (built-in + harness/ACP + broadcast), the
// cancel path, and the four terminal/live event handlers (onToken / onStatus /
// onDone / onError) that useChatEvents dispatches into.
import {
  cancelAgentChatMessage,
  cancelChatMessage,
  persistPartialChatMessage,
  generateChatTitle,
  getChatMessages,
  listChatSessions,
  sendAgentChatMessage,
  sendChatMessage,
  setChatSessionUnread,
  toastError,
  updateChatSessionTitle,
  finishArtifactRuns,
  loopSessionFinish,
} from "../../../lib/ipc";
import type { ChatAttachmentInput, ChatMessageRecord } from "../../../lib/ipc";
import type { QueuedChatMessage } from "../types";
import { tailCodePointsHysteresis } from "../../../lib/safeSlice";
import { generateSessionTitle } from "../../../lib/sessionTitle";
import { useProjectsStore } from "../../projects";
import {
  STREAM_TAIL_CAP,
  STREAM_TAIL_MARGIN,
  appendUserBubble,
  bufferTargetFor,
  bufferWriteBack,
  clearStreamState,
  cliAgentId,
  hasManuallyRenamed,
  isCliAgent,
  isDeletedSession,
  markManuallyRenamed,
  omitKey,
  optimisticMsgIdCounter,
  patchSessions,
  queueIdCounter,
  rememberLiveAttachments,
  sortSessions,
  withoutDeleted,
} from "../moduleState";
import type { LastTurnMetrics } from "../types";
import type { ChatStoreGet, ChatStoreSet } from "../types";

export function createStreamingSlice(set: ChatStoreSet, get: ChatStoreGet) {
  return {
    sendMessage: async (content: string, attachments?: ChatAttachmentInput[], forceResearch?: boolean, sessionIdOverride?: string) => {
      const {
        sessions,
        effort,
        toolsEnabled,
        codeExecEnabled,
        thinking,
      } = get();
      // The split pane passes its own session id; without an override this is
      // the plain active-session send. Every reference below keys off this
      // local, so the whole action naturally targets the right session.
      const activeChatSessionId = sessionIdOverride ?? get().activeChatSessionId;
      if (!activeChatSessionId) return;
      if (isDeletedSession(activeChatSessionId)) return;
      // A turn is already running for this session: stack the message above
      // the composer instead of dropping it. drainQueue sends the queue FIFO
      // when the current turn finishes (onDone / onError / cancelStream).
      // Per-session check (H2): concurrent sessions each own a `streaming` key,
      // and the legacy scalar may name whichever session last emitted a token —
      // gating on it would let a second turn start in an already-streaming chat.
      if (activeChatSessionId in get().streaming) {
        const queued: QueuedChatMessage = {
          id: queueIdCounter.next++,
          content,
          attachments: attachments ?? undefined,
          forceResearch: forceResearch || undefined,
        };
        set((s) => ({
          messageQueue: {
            ...s.messageQueue,
            [activeChatSessionId]: [...(s.messageQueue[activeChatSessionId] ?? []), queued],
          },
        }));
        return;
      }

      // Client-side fallback title. The LLM auto-titling in onDone
      // (generateChatTitle) silently no-ops for harness-backed sessions (no
      // stored API key) and other failure modes, leaving "Untitled Chat"
      // forever. Derive a deterministic title from the first user message
      // instead. Persisted via the same backend command renameChat uses, but
      // WITHOUT markManuallyRenamed — this is an auto title, so the turn-3
      // generateChatTitle refinement may still improve it later.
      const untitled = sessions.find((s) => s.id === activeChatSessionId);
      if (untitled && !(untitled.title ?? "").trim()) {
        const derived = generateSessionTitle(content);
        if (derived) {
          set((s) => ({
            sessions: patchSessions(s.sessions, activeChatSessionId, { title: derived }),
          }));
          void updateChatSessionTitle(activeChatSessionId, derived).catch(() => {
            /* best-effort: the local title above still stands for this run */
          });
        }
      }

      // Optimistic bubble mirrors what the backend will persist: the typed text
      // plus a compact note per attachment (the model gets the real content).
      // Optimistic bubble mirrors what the backend will persist. Mirror
      // process_attachments folding EXACTLY where the frontend can: text
      // attachments inline the body in the same fenced block the backend
      // writes, so the optimistic card even shows the same preview. Docs keep
      // the compact bracket note (extraction is backend-side) and rely on
      // mergeOptimistic's base-text twin match.
      const attachNote = (attachments ?? [])
        .map((a) => {
          if (a.kind === "image") return `\n\n[Attached image: ${a.name}]`;
          if (a.kind === "text" && a.text) {
            return `\n\nAttached file: ${a.name}\n\`\`\`\n${a.text}\n\`\`\``;
          }
          return `\n\n[Attached file: ${a.name}]`;
        })
        .join("");
      const displayContent = `${content}${attachNote}`;
      // Remember the real bytes under the persisted content so the sent message
      // keeps its image thumbnails after the optimistic bubble is swapped for
      // the persisted row (see liveAttachmentCache).
      rememberLiveAttachments(activeChatSessionId, displayContent, attachments ?? []);

      // Optimistically append the user message.
      const userMsg: ChatMessageRecord = {
        // Monotonic negative id (same mechanism as queueIdCounter) — two sends
        // in one millisecond used to collide on -Date.now().
        id: optimisticMsgIdCounter.next--, // temporary negative id
        chatSessionId: activeChatSessionId,
        role: "user",
        content: displayContent,
        // Carry the live attachments so the bubble can render real image
        // thumbnails before the backend persists (persisted messages parse
        // attachment markers out of `content` instead).
        attachments: attachments ?? undefined,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        createdAt: Date.now(),
        startedAt: null,
        completedAt: null,
      };
      set((s) => {
        // The optimistic bubble lands in whichever buffer displays the target
        // session: the main list (active session), the pinned pane's buffer
        // (split-pane send), or NEITHER — a background send (drainQueue
        // re-entering with a session no view displays) must touch no open
        // buffer; the persisted row surfaces when that session is opened
        // (appendUserBubble handles all three cases).
        // A fresh turn supersedes any stop-marker for this session.
        const stoppedPartial = { ...s.stoppedPartial };
        delete stoppedPartial[activeChatSessionId];
        return {
          ...appendUserBubble(s, activeChatSessionId, userMsg),
          streamingChatSessionId: activeChatSessionId,
          streaming: { ...get().streaming, [activeChatSessionId]: "" },
          chatStatus: { ...get().chatStatus, [activeChatSessionId]: { reason: "thinking", message: "" } },
          // Start a fresh artifact buffer for this turn.
          pendingArtifacts: { ...get().pendingArtifacts, [activeChatSessionId]: [] },
          stoppedPartial,
          error: null,
          errorCode: null,
        };
      });

      // Bump the session to top of the list. Re-read from state rather than
      // using the `sessions` snapshot — the derived-title set() above may
      // already have updated this session's entry.
      const active = get().sessions.find((s) => s.id === activeChatSessionId);
      if (active) {
        set((s) => ({
          sessions: sortSessions([
            active,
            ...s.sessions.filter((sess) => sess.id !== activeChatSessionId),
          ]),
        }));
      }

      const session = get().sessions.find((s) => s.id === activeChatSessionId);

      // Working folder resolution, shared by both send paths: a custom folder
      // from the composer "+" picker wins, then the chat's isolated worktree
      // (roadmap P0 §3.1.1), then the chat's explicitly bound project. This is
      // read-only — browsing a project does NOT rebind the chat to it (binding
      // is explicit; see newChat and unbindProject). A brand-new chat has no
      // binding and NO working directory: it runs in the app's default
      // directory, NOT the previously-selected project — clicking a project in
      // the sidebar must never silently scope a fresh chat to it.
      const projectsState = useProjectsStore.getState();
      const boundProject = projectsState.projectById(
        get().sessionProjects[activeChatSessionId],
      );
      const workingDir =
        get().cwdOverrides[activeChatSessionId] ??
        session?.worktreePath ??
        boundProject?.path;

      // CLI harness / ACP agents (Phase 2 + roadmap #20): the turn goes to the
      // headless CLI process (agent_sessions.rs) instead of the built-in
      // provider path. Same chat:* events come back, so streaming/done handling
      // above works unchanged.
      if (session && isCliAgent(session.agent)) {
        const projects = useProjectsStore.getState();
        const cwd = workingDir;
        // A typed "/research …" carries the flag itself: the slug STAYS in
        // the message (the bubble shows the command that ran — built-in
        // sessions strip it from the model-bound copy backend-side), and the
        // flag engages the CLI-facing research appendix here.
        const researchTurn =
          !!forceResearch || /^\/research\b/i.test(content.trimStart());
        try {
          await sendAgentChatMessage(
            activeChatSessionId,
            content,
            cliAgentId(session.agent),
            session.model || undefined,
            cwd,
            // Feeds the relay-browser MCP registration (RELAY_PROJECT_ID) so
            // browser auto-open is scoped to the selected project.
            projects.selectedProjectId ?? undefined,
            // Attachments ride along: the backend folds display markers +
            // extracted doc text into the persisted message and saves image/
            // doc bytes to disk paths the CLI's own file tools can open.
            attachments ?? undefined,
            researchTurn,
          );
        } catch (err) {
          console.error('[agent] sendAgentChatMessage failed:', err);
          // Delete the keys (not `undefined` assignments — those keep the key
          // present, so `sid in streaming` stays true and the sidebar "Working…"
          // dot never clears; it also breaks the Record<string, string> type).
          const streaming = { ...get().streaming };
          const chatStatus = { ...get().chatStatus };
          delete streaming[activeChatSessionId];
          delete chatStatus[activeChatSessionId];
          // Gate the banner on the session still being the active one — a
          // split-pane send failure must not surface the error in every open
          // chat view (same guard as onError).
          set((s) => ({
            streamingChatSessionId: null,
            streaming,
            chatStatus,
            error:
              s.activeChatSessionId === activeChatSessionId ? String(err) : s.error,
            errorCode:
              s.activeChatSessionId === activeChatSessionId ? null : s.errorCode,
          }));
          return;
        }
        return;
      }

      // The built-in path can reject synchronously (unknown session/provider,
      // local-model warmup failure) before any chat:error event exists. Without
      // a catch the session wedges: streamingChatSessionId stays set, the
      // double-send guard blocks every later send, and the user stares at a
      // permanent "thinking" spinner with no error. Mirror the harness reset.
      try {
        await sendChatMessage(
          activeChatSessionId,
          content,
          effort || undefined,
          toolsEnabled,
          codeExecEnabled,
          attachments,
          forceResearch,
          thinking === null ? undefined : thinking,
          // Working folder for this chat (custom folder → bound project →
          // global selection, resolved above). The backend grants it as an
          // fs_root AND names it in the system prompt so the model knows
          // which directory it is working in.
          workingDir,
        );
      } catch (err) {
        console.error('[chat] sendChatMessage failed:', err);
        const streaming = { ...get().streaming };
        const chatStatus = { ...get().chatStatus };
        delete streaming[activeChatSessionId];
        delete chatStatus[activeChatSessionId];
        // Gate the banner on the session still being the active one — a
        // split-pane send failure must not surface the error in every open
        // chat view (same guard as onError).
        set((s) => ({
          streamingChatSessionId: null,
          streaming,
          chatStatus,
          error:
            s.activeChatSessionId === activeChatSessionId ? String(err) : s.error,
          errorCode:
            s.activeChatSessionId === activeChatSessionId ? null : s.errorCode,
        }));
      }
    },

    // Team broadcast (roadmap #18): one prompt to N sessions. The active session
    // reuses sendMessage (optimistic bubble + queue rules); background sessions
    // get a direct send — streaming state is session-keyed so they run
    // concurrently and each sidebar row shows its own working dot.
    broadcastToSessions: async (sessionIds: string[], content: string, forceResearch?: boolean) => {
      const state = get();
      const targets = sessionIds.filter(
        (id) => state.sessions.some((s) => s.id === id) && !(id in state.streaming),
      );
      if (targets.length === 0) return;

      const activeId = get().activeChatSessionId;
      const projectsState = useProjectsStore.getState();

      for (const sid of targets) {
        if (sid === activeId) {
          // Active session: full optimistic path.
          await get().sendMessage(content, undefined, forceResearch);
          continue;
        }
        // Background session: mark it streaming and fire the send directly.
        // No optimistic bubble — `messages` only holds the active session's
        // list; the persisted user row will appear when the session is opened.
        const session = get().sessions.find((s) => s.id === sid);
        if (!session) continue;
        set((s) => ({
          streaming: { ...s.streaming, [sid]: "" },
          chatStatus: { ...s.chatStatus, [sid]: { reason: "thinking", message: "" } },
          pendingArtifacts: { ...s.pendingArtifacts, [sid]: [] },
        }));
        // Same resolution as sendMessage: explicit binding only — an unbound
        // (fresh) chat runs in the app's default directory, never the
        // previously-selected project.
        const boundProject = projectsState.projectById(
          get().sessionProjects[sid],
        );
        const workingDir =
          get().cwdOverrides[sid] ?? session.worktreePath ?? boundProject?.path;
        try {
          if (isCliAgent(session.agent)) {
            await sendAgentChatMessage(
              sid,
              content,
              cliAgentId(session.agent),
              session.model || undefined,
              workingDir,
              projectsState.selectedProjectId ?? undefined,
              undefined,
              // Typed "/research …" carries the flag itself; same appendix
              // contract as the single-session harness send.
              !!forceResearch || /^\/research\b/i.test(content.trimStart()),
            );
          } else {
            // Pass the store's tool flags (audit B-22): ipc.ts maps omitted
            // flags to false, which silently ran every background turn with
            // tools off. Same values the single-session sendMessage path uses.
            await sendChatMessage(
              sid,
              content,
              undefined,
              state.toolsEnabled,
              state.codeExecEnabled,
              undefined,
              forceResearch,
              undefined,
              workingDir,
            );
          }
        } catch (err) {
          // Clear this session's streaming state so its dot doesn't wedge.
          set((s) => {
            const streaming = { ...s.streaming };
            const chatStatus = { ...s.chatStatus };
            delete streaming[sid];
            delete chatStatus[sid];
            return { streaming, chatStatus };
          });
          toastError(`Broadcast to "${session.title ?? sid}" failed`, err);
        }
      }
    },

    cancelStream: async (sessionIdOverride?: string) => {
      // Cancel the session the calling view is showing (the active one by
      // default, the split pane's session via the override). The legacy scalar
      // names whichever session last emitted a token — with concurrent streams
      // it could point at a background chat, cancelling the wrong turn (or
      // no-op when it's null before the first token lands).
      const activeChatSessionId = sessionIdOverride ?? get().activeChatSessionId;
      if (activeChatSessionId && activeChatSessionId in get().streaming) {
        const streamingChatSessionId = activeChatSessionId;
        const session = get().sessions.find((s) => s.id === streamingChatSessionId);
        // Persist the partial reply BEFORE cancelling: the backend's abort path
        // discards its accumulated buffer, and the streaming buffer here holds
        // exactly the text the user already saw. Best-effort — a cancel with no
        // streamed tokens writes nothing (the backend no-ops on empty).
        const partial = get().streaming[streamingChatSessionId] ?? "";
        // Tear down the per-session streaming state SYNCHRONOUSLY, before any
        // await (audit A2): the harness cancel emits a terminal chat:error while
        // the persist/cancel round-trips below are still in flight, and with the
        // entry still present onError passed its "still streaming" guard and
        // persisted the SAME partial again — duplicate assistant rows after
        // every reload. With the keys already gone, the late chat:error no-ops
        // the persist (same straggler guard shape as onToken/onPerf). This is
        // also the builtin path's ONLY cleanup: its cancel is handle.abort(), so
        // no terminal chat:done/chat:error ever arrives to clear these keys.
        set((s) => ({
          // Also clear livePerf so the next turn starts its timer from 0, not
          // the cancelled turn's elapsed time (regression: stale timer).
          ...clearStreamState(s, streamingChatSessionId),
          livePerf: omitKey(s.livePerf, streamingChatSessionId),
          streamingChatSessionId: null,
        }));
        if (partial.trim().length > 0) {
          try {
            await persistPartialChatMessage(streamingChatSessionId, partial);
          } catch {
            /* best-effort: the cancel itself still proceeds */
          }
        }
        // Best-effort (audit H2): every other call site wraps these cancels in
        // try/catch. An IPC rejection here used to abort cancelStream BEFORE
        // the stoppedPartial re-assert + drainQueue below — steerQueuedMessage
        // parks the queue, awaits cancelStream, then restores it, so a throw
        // silently discarded the steered message AND the whole stack.
        try {
          if (isCliAgent(session?.agent)) {
            await cancelAgentChatMessage(streamingChatSessionId);
          } else {
            await cancelChatMessage(streamingChatSessionId);
          }
        } catch {
          /* best-effort: the local teardown above already ran; the queue
             restore below must run regardless */
        }
        // Remember WHAT the stopped turn had produced (matches the persisted
        // partial row's content) so that bubble keeps its process section
        // expanded instead of collapsing to an empty "Worked" row. Re-asserted
        // AFTER the awaits: a terminal chat:error landing mid-cancel runs
        // onError first, and its !hadPartial branch deletes the key.
        set((s) => {
          const nextStopped = { ...s.stoppedPartial };
          if (partial.trim().length > 0) {
            nextStopped[streamingChatSessionId] = partial.trim();
          } else {
            delete nextStopped[streamingChatSessionId];
          }
          return { stoppedPartial: nextStopped };
        });
        // A cancelled turn frees the queue too — send the next stacked message.
        get().drainQueue(streamingChatSessionId);
        // User hit Stop: disarm any active goal loop so it doesn't resume on the
        // next turn.
        const loop = get().loopState[streamingChatSessionId];
        if (loop && loop.active) {
          if (loop.backendId) void loopSessionFinish(loop.backendId, "stopped").catch(() => {});
          set((s) => ({
            loopState: {
              ...s.loopState,
              [streamingChatSessionId]: { ...loop, active: false },
            },
          }));
        }
        // The cancel path never emits a terminal event, so the session's open
        // artifact runs would stay open forever — close them as abandoned.
        void finishArtifactRuns(streamingChatSessionId, "abandoned").catch(() => {});
        // Refresh the message list so the persisted partial shows up inline.
        // mergeOptimistic keeps the just-drained queued message's bubble: the
        // refetch snapshot can predate that send's DB persist.
        try {
          // Same 200-row page cap as loadMessages (M10 / audit B-23): the
          // unbounded refetch deserialized the FULL history and desynced
          // hasMoreHistory. bufferWriteBack scopes the write to whichever
          // buffer still displays this session — the active view's list or
          // the pinned pane's (Stop pressed on a split session — without
          // that the live bubble vanished and the persisted partial never
          // landed until a reload; same contract as onDone).
          const messages = await getChatMessages(streamingChatSessionId, undefined, 200);
          if (messages) {
            set((s) => bufferWriteBack(s, streamingChatSessionId, messages, { merge: true }));
          }
        } catch {
          /* best-effort refresh */
        }
      }
    },

    // ---- Event handlers (called by useChatEvents) ----

    // Backend-initiated turn lifecycle (automation runs). These mirror the
    // pre-create/cleanup sendMessage does around its own turns so the same
    // streaming machinery — and onToken's straggler guard — applies unchanged.
    beginRemoteTurn: (chatSessionId: string) => {
      set((s) => {
        // Never clobber a live entry: a user-initiated send to this session
        // (or a previous run-started event) owns the existing buffer.
        if (chatSessionId in s.streaming) return s;
        return {
          streaming: { ...s.streaming, [chatSessionId]: "" },
          streamingChatSessionId: chatSessionId,
        };
      });
    },

    endRemoteTurn: async (chatSessionId: string) => {
      // The harness path's chat:done may have cleaned up already; only act
      // when a streaming entry survived (provider one-shots emit no terminal
      // chat event, and failure paths can die before emitting one).
      if (!(chatSessionId in get().streaming)) return;
      set((s) => clearStreamState(s, chatSessionId));
      // Surface the persisted reply: a viewer (active view or the pinned pane
      // showing this session) refetches the page (same bufferWriteBack
      // contract as cancelStream / onDone); everyone else gets the unread
      // mark (same posture as onDone).
      if (bufferTargetFor(get(), chatSessionId) == null) {
        void setChatSessionUnread(chatSessionId, true).catch(() => {});
        return;
      }
      try {
        const messages = await getChatMessages(chatSessionId, undefined, 200);
        if (messages && !(chatSessionId in get().streaming)) {
          // Scoped post-await write: a pane re-pin mid-fetch must not write
          // the rows into another view's buffer.
          set((s) => bufferWriteBack(s, chatSessionId, messages, { merge: true }));
        }
      } catch {
        /* best-effort: the sidebar relist picks it up on the next interaction */
      }
    },

    onToken: (chatSessionId: string, token: string) => {
      // Ignore stragglers (same guard as onPerf): a token emitted just before
      // an abort can cross IPC AFTER done/cancel/error cleared the entry, and
      // the write below would resurrect the key — a stuck "working" dot until
      // the next terminal event. Safe to early-out because onToken never
      // CREATES the turn's entry: sendMessage and broadcastToSessions
      // pre-create it (as "") before the first token can arrive.
      if (!(chatSessionId in get().streaming)) return;
      set((s) => {
        const prev = s.streaming[chatSessionId] ?? "";
        // Cap the streaming buffer per session to avoid OOM on extremely long
        // streaming turns (hundreds of thousands of tokens). The tail is what
        // matters for rendering; anything beyond ~50K chars is scrolled out of
        // view already. Code-point-safe: a raw slice can split an emoji
        // surrogate pair at the cap boundary. Hysteresis (audit A5): re-slicing
        // 200K chars on EVERY token past the cap made each token an O(buffer)
        // copy — the buffer now trims once per 20K chars of growth instead.
        const next = tailCodePointsHysteresis(prev + token, STREAM_TAIL_CAP, STREAM_TAIL_MARGIN);
        return {
          streaming: {
            ...s.streaming,
            [chatSessionId]: next,
          },
          // First token arrived — drop any pre-token status notice (e.g. the
          // "local model loading" line) since the wait is over. Only clone the
          // map when an entry actually exists — the common case is none, and
          // this runs per token (audit #6).
          chatStatus:
            chatSessionId in s.chatStatus
              ? omitKey(s.chatStatus, chatSessionId)
              : s.chatStatus,
          // The session is actively streaming — the sidebar's "working" dot is
          // driven by this flag. Don't change it if the streaming session is
          // the one the user is currently viewing; switching away keeps it set
          // so the sidebar shows the streaming session is still in progress.
          streamingChatSessionId: chatSessionId,
        };
      });
    },

    onStatus: (chatSessionId: string, reason: string, message: string) => {
      // Routine Auto resolution notices ("Auto → Provider · model (why)") are
      // deliberately NOT displayed — a pill on every Auto turn read as noise.
      // The resolution is still visible where it matters: the composer chip
      // stays "Auto" and its tooltip picks up the resolved model from the
      // post-turn session relist. Fail-over hand-offs use "auto_failover" and
      // DO render (rare, and the user should know the model switched).
      if (reason === "auto_route") return;
      // Reconnect notices (chat/reconnect.rs) ride this same event, and two of
      // the three need more than the notice line:
      // - "reconnect_restart" means the pending request is being re-issued, so
      //   the answer restarts from zero. The live buffer is DROPPED here or
      //   the restarted text would append to the old partial. Dropped, not
      //   discarded: it moves to `supersededPartial`, which `onError` falls
      //   back to when a ladder that ultimately fails never produced text of
      //   its own — the user watched that text, so it still has to persist.
      // - "reconnected" retires the line (the first token of the recovered
      //   stream normally does it, via onToken; this covers a retry that ends
      //   the turn without emitting another token).
      // "reconnecting" is display-only: the partial stays put under the
      // "Reconnecting… (n/10)" line while the ladder backs off.
      if (reason === "reconnect_restart") {
        set((s) => ({
          streaming: { ...s.streaming, [chatSessionId]: "" },
          supersededPartial: {
            ...s.supersededPartial,
            [chatSessionId]: s.streaming[chatSessionId] ?? "",
          },
          chatStatus: { ...s.chatStatus, [chatSessionId]: { reason, message } },
        }));
        return;
      }
      if (reason === "reconnected") {
        set((s) => ({ chatStatus: omitKey(s.chatStatus, chatSessionId) }));
        return;
      }
      set((s) => {
        // An empty reason is the backend's "clear this notice" signal — used
        // when compaction was a no-op or errored so the "Compacting earlier
        // context…" spinner doesn't linger past the chat:done.
        if (!reason) {
          const next = { ...s.chatStatus };
          delete next[chatSessionId];
          return { chatStatus: next };
        }
        // A compaction that actually shortened the history triggers an
        // immediate re-poll of the context meter so the ring ticks down
        // right away. We bump `compactionRevision` only for the active
        // session — other sessions' compactions shouldn't churn this.
        const compactionBump =
          reason === "context_compacted" && s.activeChatSessionId === chatSessionId
            ? { compactionRevision: s.compactionRevision + 1 }
            : {};
        return {
          chatStatus: { ...s.chatStatus, [chatSessionId]: { reason, message } },
          ...compactionBump,
        };
      });
    },

    onDone: async (chatSessionId: string, inputTokens: number | null, outputTokens: number | null, costUsd: number | null, llmTimeMs?: number | null, toolTimeMs?: number | null, ttftMs?: number | null, tokensPerSecond?: number | null, cacheHitRate?: number | null) => {
      // A reply that lands while the user is viewing a different chat marks the
      // finished one unread, so it surfaces in the sidebar. Best-effort: this
      // handler must ALWAYS reach the streaming-state cleanup below — an
      // awaited IPC rejection here would wedge the session in "working" state.
      // Pane-displayed sessions count as viewed too: in split view both panes
      // are on screen, so marking the un-focused-but-visible one unread while
      // the user watches it complete was wrong (audit L-25).
      if (bufferTargetFor(get(), chatSessionId) == null) {
        void setChatSessionUnread(chatSessionId, true).catch(() => {});
      }
      // Capture the finished turn's final metrics for the composer's idle row
      // BEFORE the live snapshot is cleared below — the idle row shows the last
      // turn's numbers (matching the "Worked for Xs" just watched) instead of
      // the session aggregate, which sums every turn and is empty for providers
      // that don't write cost events.
      const finalLive = get().livePerf[chatSessionId];
      const lastTurn: LastTurnMetrics = {
        llmTimeMs: llmTimeMs ?? finalLive?.llmTimeMs ?? 0,
        toolTimeMs: toolTimeMs ?? finalLive?.toolTimeMs ?? 0,
        ttftMs: ttftMs ?? finalLive?.ttftMs ?? null,
        tokensPerSecond: tokensPerSecond ?? finalLive?.tokensPerSecond ?? null,
        outputTokens: outputTokens ?? finalLive?.outputTokens ?? 0,
        inputTokens: inputTokens ?? null,
        cacheHitRate: cacheHitRate ?? null,
        elapsedMs: finalLive?.elapsedMs ?? null,
      };

      // Clear streaming + live-perf state for this session.
      set((s) => ({
        // A turn can only complete after its question was answered, but a
        // CANCELLED turn drops the pending on the backend without a resolved
        // event — clear any stale card here so cancel never leaves one stuck.
        ...clearStreamState(s, chatSessionId),
        livePerf: omitKey(s.livePerf, chatSessionId),
        pendingQuestions: omitKey(s.pendingQuestions, chatSessionId),
        lastTurnPerf: { ...s.lastTurnPerf, [chatSessionId]: lastTurn },
      }));

      // Refetch messages from the backend to get the final persisted
      // ChatMessageRecord with usage data. Best-effort: a transient IPC/DB
      // failure must not skip the title refresh + relist below. Same 200-row
      // page cap as loadMessages (M10): replacing the capped page with the
      // FULL history on every completed turn re-rendered huge sessions and
      // defeated pagination. The title logic only needs the young-session
      // turn counts (1 or 3), which always fit inside the latest page.
      let messages: ChatMessageRecord[] | null = null;
      try {
        messages = await getChatMessages(chatSessionId, undefined, 200);
      } catch {
        /* keep null; downstream guards handle it */
      }

      // Auto-summarize the chat title after the 1st completed turn (a quick
      // first guess) and refine it after the 3rd, unless the user renamed it.
      const assistantTurns = (messages ?? []).filter((m) => m.role === "assistant").length;
      if (
        !hasManuallyRenamed(chatSessionId) &&
        (assistantTurns === 1 || assistantTurns === 3)
      ) {
        void generateChatTitle(chatSessionId)
          .then((title) => {
            if (!title) return;
            set((s) => ({
              sessions: sortSessions(
                patchSessions(s.sessions, chatSessionId, { title }),
              ),
            }));
          })
          .catch(() => {
            /* best-effort: keep the existing title on failure */
          });
      }

      if (messages) {
        set((s) => {
          // Attribute the artifacts produced during this turn to the assistant
          // message that just completed (the last assistant record). This must
          // run even when the user is viewing a DIFFERENT chat: artifactsByMessage
          // is keyed by the persisted message id (globally unique), so the chips
          // will be there when the user opens that session — previously they were
          // silently discarded while the pending buffer was cleared regardless.
          const pending = s.pendingArtifacts[chatSessionId] ?? [];
          const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
          const artifactsByMessage =
            pending.length > 0 && lastAssistant
              ? { ...s.artifactsByMessage, [lastAssistant.id]: pending }
              : s.artifactsByMessage;
          const nextPending = { ...s.pendingArtifacts };
          delete nextPending[chatSessionId];
          return {
            // The final-rows write-back lands in whichever buffer displays
            // this session (active view or its pinned pane) so the history
            // updates in place — no reload needed.
            ...bufferWriteBack(s, chatSessionId, messages, { merge: true }),
            artifactsByMessage,
            pendingArtifacts: nextPending,
          };
        });
      }

      // Refresh the session list (title may have been updated by the backend).
      // Also re-seed sessionProjects from the refreshed sessions so any
      // project-bound chats stay nested under their project after onDone.
      // Best-effort: a rejection here must not abort onDone before the queue
      // drain + goal-loop advance below (that stranded queued messages until
      // the user manually sent).
      try {
        const sessions = await listChatSessions();
        if (sessions) {
          const clean = withoutDeleted(sessions);
          const nextProjects = { ...get().sessionProjects };
          for (const s of clean) {
            if (s.projectId) nextProjects[s.id] = s.projectId;
          }
          set({ sessions: clean, sessionProjects: nextProjects });
        }
      } catch {
        /* best-effort relist */
      }
      // Turn finished — send the next queued message, if any (FIFO).
      get().drainQueue(chatSessionId);
      // Artifact telemetry (SELF_IMPROVING_ARTIFACTS.md §5): the turn ended
      // cleanly, so any skill/template runs opened for this session count as
      // applied. No-op when the turn used no tracked artifact.
      void finishArtifactRuns(chatSessionId, "applied").catch(() => {});
      // Goal-loop (/goal / /loop): if the loop is armed for this session and
      // drainQueue didn't already start a new turn (no queued user messages),
      // inspect the just-finished assistant reply and, on `continue`, auto-issue
      // the next iteration. Pauses if the user switched away (active-session
      // guard), and never fires while THIS session already has another turn
      // running (per-session check — a background chat streaming elsewhere
      // must not stall the loop).
      // A failed refetch leaves `messages` null and the in-store buffer holding
      // the PREVIOUS turn's reply — advancing on it would feed a stale
      // (already-processed) sentinel back to the model, so skip the advance
      // until a turn whose reply we actually have (audit A4).
      if (
        messages !== null &&
        get().activeChatSessionId === chatSessionId && !(chatSessionId in get().streaming)
      ) {
        const loop = get().loopState[chatSessionId];
        if (loop && loop.active) {
          const lastReply = [...(get().messages ?? [])]
            .reverse()
            .find((m) => m.role === "assistant")?.content ?? "";
          const decision = get().advanceLoop(chatSessionId, lastReply);
          if (decision === "continue") {
            const next = loop.iteration + 1; // advanceLoop already ticked it
            const body =
              `[loop iteration ${next}/${loop.max}] Continue working toward the goal ` +
              `"${loop.goal}". Do exactly the next work that remains (per your previous ` +
              `STATUS line), then end with a single LOOP_STATUS: line as instructed.`;
            // Defer one tick so any synchronous onDone cleanup (set calls above)
            // commits before sendMessage re-enters the streaming path.
            void Promise.resolve().then(() => get().sendMessage(body));
          }
        }
      }
      // Refresh the session's aggregate metrics (turn added to the totals).
      void get().loadSessionMetrics(chatSessionId);
    },

    onError: (chatSessionId: string, message: string, code: string | null) => {
      // Persist the streamed partial the same way the cancel path does (audit
      // B-19): the backend's error path discards its buffer WITHOUT persisting,
      // so this is the only chance to keep the text the user already watched.
      // Gated on the streaming entry still existing — the cleanup below deletes
      // the key synchronously, so a duplicate chat:error for one turn cannot
      // double-persist (the backend never persists on error, so there is no
      // other dedupe to race with).
      //
      // A reconnect that restarted the answer left the buffer empty and the
      // text it replaced in `supersededPartial`: when the restarted attempt
      // produced nothing of its own, that superseded text is what the user
      // actually watched, so it is the partial to keep.
      const live = get().streaming[chatSessionId] ?? "";
      const partial =
        live.trim().length > 0 ? live : (get().supersededPartial[chatSessionId] ?? "");
      const hadPartial = chatSessionId in get().streaming && partial.trim().length > 0;
      // Clear streaming state and surface the error for the active session.
      // Also drop this session's live-perf chip and pending-artifact buffer —
      // onDone clears both, and an errored turn must not leave them stuck
      // (audit H3).
      set((s) => ({
        ...clearStreamState(s, chatSessionId),
        livePerf: omitKey(s.livePerf, chatSessionId),
        pendingArtifacts: omitKey(s.pendingArtifacts, chatSessionId),
        // An errored/cancelled turn must not leave a question card stuck
        // (the backend already dropped its pending).
        pendingQuestions: omitKey(s.pendingQuestions, chatSessionId),
        // Remember what the errored turn had produced (matches the persisted
        // partial row) — same as the cancel path, so the partial bubble keeps
        // its process section expanded and reads "Stopped" instead of
        // collapsing to an empty "Worked" row.
        stoppedPartial: hadPartial
          ? { ...s.stoppedPartial, [chatSessionId]: partial.trim() }
          : omitKey(s.stoppedPartial, chatSessionId),
        streamingChatSessionId:
          s.streamingChatSessionId === chatSessionId ? null : s.streamingChatSessionId,
          error:
            s.activeChatSessionId === chatSessionId ? message : s.error,
          errorCode:
            s.activeChatSessionId === chatSessionId ? (code ?? null) : s.errorCode,
        })),
      // Artifact telemetry (SELF_IMPROVING_ARTIFACTS.md §5.2): the turn errored,
      // so open runs count as failed with the classified error code.
      void finishArtifactRuns(chatSessionId, "failed", code ?? undefined).catch(() => {});
      // Keep the partial VISIBLE (not just persisted): without a refetch the
      // live bubble vanishes with the streaming entry and the persisted row
      // only surfaces on the NEXT turn's history reload — the watched work
      // "disappears, then reappears later" (60s network-timeout regression).
      // Same refresh + merge as cancelStream.
      if (hadPartial) {
        void (async () => {
          try {
            // Persist first, THEN read history — the refetch must land after
            // the partial row is written or it won't include it.
            await persistPartialChatMessage(chatSessionId, partial).catch(() => {});
            const messages = await getChatMessages(chatSessionId, undefined, 200);
            if (messages) {
              // Same bufferWriteBack scoping as cancelStream: the pinned
              // pane's errored session must surface its partial too, and a
              // background session must not write into an open buffer.
              set((s) => bufferWriteBack(s, chatSessionId, messages, { merge: true }));
            }
          } catch {
            /* best-effort: the partial still shows on the next turn */
          }
        })();
      }
      // Turn ended (in error) — keep the queue moving rather than stranding it.
      get().drainQueue(chatSessionId);
      // Disarm any active goal loop on this session so an errored iteration
      // can never keep firing continuation turns.
      const loop = get().loopState[chatSessionId];
      if (loop && loop.active) {
        set((s) => ({
          loopState: { ...s.loopState, [chatSessionId]: { ...loop, active: false } },
        }));
      }
    },
  };
}
