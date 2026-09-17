// Sessions slice: session list, CRUD, per-session config (model/provider/
// agent/policies/worktree/cwd), and the mobile owner-session map.
import {
  cancelAgentChatMessage,
  cancelChatMessage,
  createChatSession,
  getChatMessages,
  setChatSessionProject,
  setChatSessionCwd,
  deleteAllChatSessions,
  deleteChatSession,
  listChatArtifacts,
  listChatCheckpoints,
  listChatSessions,
  setChatDefaultModel,
  setChatSessionAuto,
  setChatSessionPermissionMode,
  setChatSessionStarred,
  setChatSessionUnread,
  touchChatSession,
  updateChatSessionAgent,
  updateChatSessionModel,
  updateChatSessionProvider,
  updateChatSessionPolicies,
  updateChatSessionTitle,
  updateChatSessionWatchMode,
  setChatSessionWorktree,
} from "../../../lib/ipc";
import { toastError } from "../../../lib/ipc";
import type { ChatCheckpoint } from "../../../lib/ipc";
import type { ApprovalPolicy, ChatArtifact, SandboxPolicy, WatchMode } from "../types";
import { useAutomationsStore } from "../../automations";
import { useProjectsStore } from "../../projects";
import { useUiStore } from "../../ui";
import {
  clearSessionState,
  hasFullAccessConfirmed,
  HARNESS_PERMISSION_MODES,
  isCliAgent,
  isDeletedSession,
  markDeleted,
  markFullAccessConfirmed,
  markManuallyRenamed,
  maybeEnsureWorktree,
  mergeOptimistic,
  patchSessions,
  policiesToPermissionMode,
  sortSessions,
  withoutDeleted,
  clearManuallyRenamed,
} from "../moduleState";
import { findPaneForSession } from "../paneTree";
import type { ChatStoreGet, ChatStoreSet } from "../types";

export function createSessionsSlice(set: ChatStoreSet, get: ChatStoreGet) {
  return {
    setCwdOverride: (chatSessionId: string, path: string | null) => {
      // Persist the pick: the DB column is what survives an app restart — the
      // in-memory map alone evaporated, so every post-restart send silently
      // fell back to the artifacts dir. Fire-and-forget like unbindProject.
      void setChatSessionCwd(chatSessionId, path).catch(() => {});
      set((s) => {
        const next = { ...s.cwdOverrides };
        if (path) next[chatSessionId] = path;
        else delete next[chatSessionId];
        return { cwdOverrides: next };
      });
    },

    unbindProject: (chatSessionId: string) => {
      void setChatSessionProject(chatSessionId, null).catch(() => {});
      // The picker's folder override dies with the binding too (existing
      // behavior) — persist the clear so a restart doesn't resurrect it.
      void setChatSessionCwd(chatSessionId, null).catch(() => {});
      set((s) => {
        const sessionProjects = { ...s.sessionProjects };
        delete sessionProjects[chatSessionId];
        const cwdOverrides = { ...s.cwdOverrides };
        delete cwdOverrides[chatSessionId];
        return {
          sessionProjects,
          cwdOverrides,
          sessions: patchSessions(s.sessions, chatSessionId, { projectId: null, worktreePath: null }),
        };
      });
    },

    toggleSessionWorktree: async (chatSessionId: string) => {
      const session = get().sessions.find((s) => s.id === chatSessionId);
      if (!session) return;
      if (session.worktreePath) {
        // "Join main working tree": backend removes the worktree best-effort
        // (branch stays in the repo) and clears the pointer; mirror locally.
        try {
          await setChatSessionWorktree(chatSessionId, null);
        } catch {
          // Best-effort by design — still clear the local pointer below.
        }
        set((s) => ({
          sessions: patchSessions(s.sessions, chatSessionId, { worktreePath: null }),
        }));
        return;
      }
      // Isolate: create + persist + watch, patching state when it resolves.
      await maybeEnsureWorktree(session, set);
    },

    loadSessions: async () => {
      const sessions = await listChatSessions();
      const clean = withoutDeleted(sessions ?? []);
      // Seed the in-memory binding cache from the persisted project_id so the
      // sidebar nesting + composer notch survive an app restart. Same for the
      // working-folder overrides — without the re-seed a restart dropped the
      // picked folder and every later send ran in the artifacts dir.
      const seeded: Record<string, string> = {};
      const seededCwd: Record<string, string> = {};
      for (const s of clean) {
        if (s.projectId) seeded[s.id] = s.projectId;
        if (s.cwdOverride) seededCwd[s.id] = s.cwdOverride;
      }
      set({
        loaded: true,
        sessions: clean,
        sessionProjects: seeded,
        cwdOverrides: seededCwd,
      });
    },

    selectSession: async (chatSessionId: string, opts?: { recordNav?: boolean }) => {
      // Ignore selects for sessions deleted this run (stale sidebar row, in-
      // flight click). The tombstone is the source of truth until restart.
      if (isDeletedSession(chatSessionId)) return;
      const tree = get().chatPaneTree;
      // Uniqueness invariant: a session pinned in a split pane is ALREADY on
      // screen — selecting it focuses that pane (shared chrome follows) and
      // leaves the active session alone. Copying it into the main view would
      // mirror one chat — and its live agent turn — into two panes.
      const pinnedPaneId = findPaneForSession(tree, chatSessionId);
      if (pinnedPaneId) {
        get().setFocusedPane(pinnedPaneId);
        return;
      }
      if (tree) {
        // The click names a chat shown in NO pane: leave the split layout for
        // a plain single chat — but REMEMBER the layout so clicking any of
        // its chats later brings the panes back exactly as they were.
        set((s) => ({
          rememberedChatPaneState: { tree, activeSessionId: s.activeChatSessionId },
          chatPaneTree: null,
          focusedPaneId: null,
          focusedChatSessionId: null,
        }));
      } else {
        // Panes are closed — is the clicked chat part of a remembered pane
        // layout? Then bring the panes back (and focus the clicked one).
        const remembered = get().rememberedChatPaneState;
        if (remembered && findPaneForSession(remembered.tree, chatSessionId)) {
          await get().restoreChatPaneState(chatSessionId);
          return;
        }
      }
      // Capture the outgoing session's emptiness BEFORE the switch: the
      // `messages` buffer is replaced by the target session's messages below,
      // so the post-switch check would always see a non-empty buffer.
      // The buffer only counts as the outgoing session's emptiness when it
      // actually holds THAT session's rows — a rapid A→B→C switch reaches here
      // before B's fetch commits, and the buffer still shows A's (empty) page;
      // trusting it would delete B's whole history (audit H1).
      const outgoingId = get().activeChatSessionId;
      const outgoingEmpty =
        get().messagesSessionId === outgoingId && get().messages.length === 0;
      // Opening a chat clears its unread mark (persisted only if it was set).
      const wasUnread = get().sessions.find((s) => s.id === chatSessionId)?.unread ?? false;
      // Reset the per-session thinking override to the provider default
      // whenever the user switches chats. The "brain" button is per-session.
      set((s) => ({
        activeChatSessionId: chatSessionId,
        error: null,
        errorCode: null,
        thinking: null,
        sessions: s.sessions.map((sess) =>
          sess.id === chatSessionId && sess.unread ? { ...sess, unread: false } : sess,
        ),
      }));
      if (wasUnread) void setChatSessionUnread(chatSessionId, false).catch(() => {});
      // Record the switch in the ui store's browser-style nav timeline so
      // Back/Forward return to the chat the user was reading, not just the
      // view. Restore-driven switches (nav Back/Forward) skip recording.
      if (opts?.recordNav !== false && outgoingId !== chatSessionId) {
        useUiStore.getState().recordChatNav(chatSessionId);
      }
      // Follow the chat's project binding: switching to a chat that was working
      // on a different project moves the global selection (and with it the
      // composer notch, Files tab, and the working directory) to that project.
      // Without this every chat showed whatever project was clicked last.
      const boundProjectId = get().sessionProjects[chatSessionId];
      if (boundProjectId) {
        const ps = useProjectsStore.getState();
        if (ps.selectedProjectId !== boundProjectId && ps.projectById(boundProjectId)) {
          ps.selectProject(boundProjectId);
        }
      }
      const [messages, records, checkpoints] = await Promise.all([
        getChatMessages(chatSessionId, undefined, 200),
        listChatArtifacts(chatSessionId),
        listChatCheckpoints(chatSessionId),
      ]);
      // Only update messages if the user hasn't clicked away to another session
      // while the fetch was in-flight.
      if (get().activeChatSessionId === chatSessionId) {
        set((s) => ({
          // mergeOptimistic, scoped to THIS session's still-optimistic rows: a
          // re-open while the session's send is mid-persist keeps the in-flight
          // bubble (same as loadBufferPage) — without the session filter the
          // OUTGOING session's optimistic bubbles would leak into the new
          // transcript, since the buffer still holds the previous chat's rows
          // until this write.
          messages: mergeOptimistic(
            s.messages.filter((m) => m.chatSessionId === chatSessionId),
            messages ?? [],
          ),
          messagesSessionId: chatSessionId,
          activeChatSessionId: chatSessionId,
          hasMoreHistory: (messages?.length ?? 0) >= 200,
        }));
        // Restore this chat's generated artifacts (inline diagrams / file chips)
        // so they reappear when the session is reopened. Skip sessions that are
        // mid-stream — their live buffers are the source of truth. Per-session
        // check: the legacy scalar can name another concurrently-streaming chat.
        if (records && !(chatSessionId in get().streaming)) {
          const list: ChatArtifact[] = records.map((r) => ({
            path: r.path,
            filename: r.filename,
          }));
          const byMessage: Record<number, ChatArtifact[]> = {};
          for (const r of records) {
            if (r.chatMessageId == null) continue;
            (byMessage[r.chatMessageId] ??= []).push({
              path: r.path,
              filename: r.filename,
            });
          }
          set((s) => ({
            artifacts: { ...s.artifacts, [chatSessionId]: list },
            artifactsByMessage: { ...s.artifactsByMessage, ...byMessage },
          }));
        }
        // Checkpoint chips: keyed by messageId (globally unique). Prune only
        // THIS session's freshly-loaded message ids, then merge the new chips
        // in — replacing the whole map on every open used to wipe the other
        // pane's (and every other session's) chips for the rest of the run.
        // Baselines and safety snapshots (messageId null) are backend-only.
        if (checkpoints) {
          const byMessage: Record<number, ChatCheckpoint[]> = {};
          for (const c of checkpoints) {
            if (c.messageId == null) continue;
            (byMessage[c.messageId] ??= []).push(c);
          }
          set((s) => {
            const next = { ...s.checkpointsByMessage };
            for (const m of messages ?? []) delete next[m.id];
            return { checkpointsByMessage: { ...next, ...byMessage } };
          });
        }
      }
      // Touch and reorder in the background. Rejection-tolerant: a failed
      // touch/relist must not surface as an unhandled rejection (M9).
      void touchChatSession(chatSessionId)
        .then(async () => {
          const sessions = await listChatSessions();
          if (sessions) set({ sessions: withoutDeleted(sessions) });
        })
        .catch(() => {
          /* best-effort: the sidebar relists on the next interaction */
        });
      // Switching away from a brand-new chat that never received a message
      // (e.g. the auto-started default chat) should not leave an empty session
      // row behind in the sidebar. deleteChat() tombstones it, so the relist
      // above can't resurrect it.
      // Harness/ACP sessions get a narrower guard: they can be automation run
      // logs — the run-log chat is bound on first run and artifact/Open
      // buttons point at it, so only sweep one when no automation references
      // it. Any other empty harness chat (e.g. the auto-started default after
      // a harness pick) goes the same way as an empty built-in chat.
      if (outgoingId && outgoingId !== chatSessionId && outgoingEmpty) {
        const outgoingSession = get().sessions.find((s) => s.id === outgoingId);
        if (isCliAgent(outgoingSession?.agent)) {
          const autos = useAutomationsStore.getState();
          if (!autos.loaded) await autos.load().catch(() => {});
          const { loaded, automations } = useAutomationsStore.getState();
          // Store not loaded (IPC failure): can't rule out a run log — skip.
          if (loaded && !automations.some((a) => a.chatSessionId === outgoingId)) {
            get()
              .deleteChat(outgoingId)
              .catch((e) => toastError("Couldn't clean up the empty chat", e));
          }
        } else {
          get()
            .deleteChat(outgoingId)
            .catch((e) => toastError("Couldn't clean up the empty chat", e));
        }
      }
      // Opening a session that has messages stacked in its queue (queued while
      // it was in the background) starts draining them now that it's active.
      get().drainQueue(chatSessionId);
      // Load this session's aggregate perf metrics for the composer row.
      void get().loadSessionMetrics(chatSessionId);
    },

    newChat: async (provider: string, model: string, projectId?: string | null, agent?: string | null) => {
      // Reuse the active session when it already has no turns — clicking "New
      // Chat" while sitting in a fresh empty chat should not spawn yet another
      // empty session. If the caller wants a different provider/model than the
      // empty session already has (e.g. Settings → "Use this model"), update it
      // in place rather than creating a duplicate.
      const { activeChatSessionId, messages, messagesSessionId, sessions } = get();
      const active = activeChatSessionId
        ? sessions.find((s) => s.id === activeChatSessionId)
        : undefined;
      // Buffer-ownership guard (same H1 shape): only reuse the active session
      // when the buffer actually holds ITS rows — after a fast session switch
      // the buffer can still show the previous chat's (empty) page, and
      // reusing based on that would silently hijack a chat with history.
      if (active && messagesSessionId === active.id && messages.length === 0) {
        // Agent first (same order as handleAgentModelPick): re-targeting the
        // empty chat to the seeded agent goes through the full store action so
        // harness picks get their permission-mode init. The session is empty —
        // there is no CLI process to kill and no turns to disturb.
        if (agent && active.agent !== agent) {
          await get().setSessionAgent(active.id, agent);
        }
        if (provider && active.provider !== provider) {
          await updateChatSessionProvider(active.id, provider);
        }
        if (model && active.model !== model) {
          await updateChatSessionModel(active.id, model);
        }
        // Adopt the requested project binding so the reused chat nests under
        // the right project (e.g. clicking "+" on a different project).
        const targetProject = projectId !== undefined ? projectId : active.projectId;
        if (targetProject !== active.projectId) {
          await setChatSessionProject(active.id, targetProject ?? null);
        }
        set((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id === active.id
              ? {
                  ...sess,
                  provider: provider || sess.provider,
                  model: model || sess.model,
                  projectId: targetProject ?? null,
                  // The backend removes the old project's worktree on rebind;
                  // mirror that locally so a stale pointer can't block ensure.
                  worktreePath:
                    targetProject !== sess.projectId ? null : sess.worktreePath,
                }
              : sess,
          ),
          // Keep the in-memory binding cache in sync with the persisted value.
          sessionProjects:
            targetProject != null
              ? { ...s.sessionProjects, [active.id]: targetProject }
              : Object.fromEntries(
                  Object.entries(s.sessionProjects).filter(([id]) => id !== active.id),
                ),
          error: null,
          errorCode: null,
        }));
        // Give the (possibly just rebound) chat its own worktree, fire-and-forget.
        void maybeEnsureWorktree(get().sessions.find((s) => s.id === active.id), set);
        return active;
      }

      // Project/folder inheritance: a caller that doesn't pass an explicit
      // projectId ("+" on a project row passes one) creates the chat in the
      // SAME project as the previously active chat; when that chat is
      // unbound, the new chat is independent (null). Matches the empty-chat
      // reuse path above, which already adopts active.projectId.
      const inheritedProjectId =
        projectId !== undefined ? projectId : (active?.projectId ?? null);

      const session = await createChatSession(provider, model, inheritedProjectId);
      if (session) {
        // Insert FIRST, synchronously after create, with a same-id guard. The
        // seeded-agent apply below is an awaited IPC round-trip; a background
        // relist (loadSessions after the empty-chat sweep, onDone's
        // touch-then-relist) can land inside it and already include the new
        // row — prepending then produced TWO copies of the session in this
        // array (React duplicate-key warning in the sidebar, and sessions.find
        // returning the STALE copy first, which made the composer chip show a
        // previous model instead of Auto). Filtering same-id rows makes the
        // insert idempotent; applying the agent after the insert means its
        // store patch updates the one row in place.
        useUiStore.getState().recordChatNav(session.id);
        set((s) => ({
          sessions: sortSessions([session, ...s.sessions.filter((x) => x.id !== session.id)]),
          activeChatSessionId: session.id,
          messages: [],
          messagesSessionId: session.id,
          error: null,
          errorCode: null,
          // Seed the in-memory binding cache from the persisted value so the
          // composer notch + working-dir resolution work before first send.
          sessionProjects:
            session.projectId != null
              ? { ...s.sessionProjects, [session.id]: session.projectId }
              : s.sessionProjects,
        }));
        // Apply the seeded agent (harness/ACP/local picks) through the full
        // store action — same post-pick state as a manual pick on a fresh
        // chat, including the harness permission-mode init. The session is
        // already in the list, so the action's store patch lands on it.
        if (agent) {
          try {
            await get().setSessionAgent(session.id, agent);
            session.agent = agent;
          } catch {
            /* best-effort — the chat still opens, just without the agent */
          }
        }
        // Worktree-per-session default: isolate the new chat, fire-and-forget.
        void maybeEnsureWorktree(session, set);
      }
      return session;
    },

    deleteChat: async (chatSessionId: string) => {
      // Kill any running agent for this session before removing the DB row.
      // Without this a persistent harness CLI (or a mid-turn builtin SSE/tool
      // loop) keeps running and emitting chat:token events for a session that
      // no longer exists — and onToken would re-create the streaming state
      // deleteChat just removed.
      const session = get().sessions.find((s) => s.id === chatSessionId);
      if (isCliAgent(session?.agent)) {
        try { await cancelAgentChatMessage(chatSessionId); } catch { /* best-effort */ }
      } else if (chatSessionId in get().streaming) {
        // Builtin-provider turn in flight: the backend delete only kills
        // harness processes, not ChatManager streams — cancel explicitly.
        try { await cancelChatMessage(chatSessionId); } catch { /* best-effort */ }
      }
      await deleteChatSession(chatSessionId);
      // Tombstone this session for the rest of the app run so background
      // session-list refreshes (selectSession's touch-then-relist, onDone's
      // relist) can't resurrect it via a stale IPC payload that raced the
      // DELETE. Cleared on a full app restart.
      markDeleted(chatSessionId);
      clearManuallyRenamed(chatSessionId);
      // A deleted split-pane session closes its pane (the tree collapses
      // around it; focus resets if that pane held it).
      const paneId = findPaneForSession(get().chatPaneTree, chatSessionId);
      if (paneId) get().closeChatPane(paneId);
      // A remembered pane layout naming the deleted chat is no longer
      // restorable intact — drop it.
      const remembered = get().rememberedChatPaneState;
      if (
        remembered &&
        (remembered.activeSessionId === chatSessionId ||
          findPaneForSession(remembered.tree, chatSessionId))
      ) {
        set({ rememberedChatPaneState: null });
      }
      set((s) => ({
        // Strip every per-session key (H3), plus the session row and — when
        // the deleted chat was active — the message buffer, so switching
        // sessions never briefly shows this chat's old messages/artifacts.
        ...clearSessionState(s, chatSessionId),
        sessions: s.sessions.filter((sess) => sess.id !== chatSessionId),
        activeChatSessionId: s.activeChatSessionId === chatSessionId ? null : s.activeChatSessionId,
        messages: s.activeChatSessionId === chatSessionId ? [] : s.messages,
        messagesSessionId:
          s.activeChatSessionId === chatSessionId ? null : s.messagesSessionId,
        focusedChatSessionId:
          s.focusedChatSessionId === chatSessionId ? null : s.focusedChatSessionId,
      }));
    },

    deleteAllChats: async () => {
      // Cancel every in-flight stream first (both kinds) — deleting the rows
      // alone doesn't stop backend ChatManager streams or harness children, and
      // their events would recreate state for sessions that no longer exist.
      const state = get();
      const harnessIds = state.sessions
        .filter((s) => isCliAgent(s.agent))
        .map((s) => s.id);
      const builtinIds = Object.keys(state.streaming).filter((id) => !harnessIds.includes(id));
      await Promise.allSettled([
        ...harnessIds.map((id) => cancelAgentChatMessage(id)),
        ...builtinIds.map((id) => cancelChatMessage(id)),
      ]);
      const count = await deleteAllChatSessions();
      // Tombstone every id that existed so background session-list refreshes
      // can't resurrect any of them (same guard as single deleteChat).
      for (const s of get().sessions) markDeleted(s.id);
      set((s) => ({
        sessions: [],
        activeChatSessionId: null,
        messages: [],
        messagesSessionId: null,
        chatPaneTree: null,
        paneBuffers: {},
        rememberedChatPaneState: null,
        focusedPaneId: null,
        focusedChatSessionId: null,
        streaming: {},
        streamingChatSessionId: null,
        chatStatus: {},
        artifacts: {},
        artifactsByMessage: {},
        checkpointsByMessage: {},
        pendingArtifacts: {},
        pendingApprovals: {},
        pendingQuestions: {},
        tasks: {},
        planSteps: {},
        sessionTodos: {},
        planMode: {},
        pendingPlanProposals: {},
        sessionPlans: {},
        messageQueue: {},
        cwdOverrides: {},
        sessionProjects: {},
        ownerSessionByChatId: {},
        loopState: {},
        subagents: {},
        meshMail: {},
        meshMailBySession: {},
        meshChildren: {},
        livePerf: {},
        lastTurnPerf: {},
        sessionMetrics: {},
        artifactProposals: {},
        stoppedPartial: {},
        citationReports: {},
        // Audit L-17: delete-all missed these two keyed maps (single-delete
        // clears them via clearSessionState).
        composerDrafts: {},
        supersededPartial: {},
      }));
      return count;
    },

    deleteActiveIfEmpty: async () => {
      const { activeChatSessionId, messages, messagesSessionId } = get();
      if (!activeChatSessionId) return null;
      // Only delete when the buffer genuinely holds THIS session's (empty)
      // rows — trusting a buffer that still belongs to the previous session
      // after a fast switch would delete a chat with history (same H1 shape).
      if (messagesSessionId !== activeChatSessionId || messages.length > 0) return null;
      await get().deleteChat(activeChatSessionId);
      return activeChatSessionId;
    },

    renameChat: async (chatSessionId: string, title: string) => {
      markManuallyRenamed(chatSessionId);
      await updateChatSessionTitle(chatSessionId, title);
      set((s) => ({
        sessions: patchSessions(s.sessions, chatSessionId, { title }),
      }));
    },

    setStarred: async (chatSessionId: string, starred: boolean) => {
      await setChatSessionStarred(chatSessionId, starred);
      set((s) => ({
        sessions: sortSessions(
          patchSessions(s.sessions, chatSessionId, { starred }),
        ),
      }));
    },

    setUnread: async (chatSessionId: string, unread: boolean) => {
      await setChatSessionUnread(chatSessionId, unread);
      set((s) => ({
        sessions: patchSessions(s.sessions, chatSessionId, { unread }),
      }));
    },

    setSessionModel: async (chatSessionId: string, model: string) => {
      // For a harness session, a model change requires killing the running CLI
      // process: claude_code is spawned with `--model`, so the old process is
      // bound to the old model and must be respawned (the next send does that
      // via the spawned_model check, but killing here stops any in-flight work
      // immediately instead of letting it finish on the old model).
      const session = get().sessions.find((s) => s.id === chatSessionId);
      if (session && isCliAgent(session.agent) && session.model !== model) {
        try { await cancelAgentChatMessage(chatSessionId); } catch { /* best-effort */ }
      }
      await updateChatSessionModel(chatSessionId, model);
      set((s) => ({
        sessions: patchSessions(s.sessions, chatSessionId, { model }),
      }));
      // Keep the per-provider default in sync with explicit picks so freshly
      // created chats seed with THIS model instead of a long-stale one (the
      // auto-start path reads get_chat_config → chat.<provider>.model).
      // Skipped for harness/ACP sessions (their model ids are CLI-specific)
      // and local_gguf (its default is owned by start_local_model — it must
      // stay identical to the id llama-server was started with or sends 400).
      if (session && !isCliAgent(session.agent) && session.provider !== "local_gguf") {
        void setChatDefaultModel(session.provider, model).catch(() => {
          /* best-effort — seeding just falls back to the previous default */
        });
      }
    },

    setSessionProvider: async (chatSessionId: string, provider: string) => {
      await updateChatSessionProvider(chatSessionId, provider);
      set((s) => ({
        sessions: patchSessions(s.sessions, chatSessionId, { provider }),
      }));
    },

    setSessionAuto: async (chatSessionId: string, auto: boolean) => {
      await setChatSessionAuto(chatSessionId, auto);
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === chatSessionId
            ? auto
              ? // Placeholders — the first send resolves the concrete pick and
                // the row (and this mirror) get the real values back.
                { ...sess, autoModel: true, provider: "auto", model: "auto" }
              : { ...sess, autoModel: false }
            : sess,
        ),
      }));
    },

    setSessionAgent: async (chatSessionId: string, agent: string | null) => {
      // Switching away from a harness agent, or switching between different
      // harnesses, must kill the running CLI process — otherwise it keeps
      // executing and emitting tokens for this session.
      const prev = get().sessions.find((s) => s.id === chatSessionId);
      if (prev && isCliAgent(prev.agent) && prev.agent !== agent) {
        try { await cancelAgentChatMessage(chatSessionId); } catch { /* best-effort */ }
      }
      // Reset the per-session permission mode when the harness actually
      // CHANGES (e.g. built-in → opencode, or opencode → claude_code). The
      // session row's permission_mode label is harness-specific — Claude Code's
      // "default"/"acceptEdits" or OpenCode's "build"/"plan" are meaningless
      // outside their CLI, so reusing the previous label made the mode menu
      // show a stale posture. Switch INTO harness: start at the harness's
      // first catalog entry. Switch OUT of harness to builtin: leave the
      // built-in posture alone (the toggle stays on the same dual policies).
      let nextPermissionMode: string | null | undefined = undefined;
      let ejectToFullAuto: string | null = null;
      if (agent && agent.startsWith("harness:") && agent !== prev?.agent) {
        const harnessId = agent.slice("harness:".length);
        const catalog = HARNESS_PERMISSION_MODES[harnessId];
        nextPermissionMode = catalog?.[0]?.value ?? "default";
      } else if (agent === null && prev?.agent && prev.agent.startsWith("harness:")) {
        // Built-in sessions don't track a mode in permission_mode; the store
        // treats the built-in posture as derived from the dual policies.
        // Return to the built-in DEFAULT (full-auto), not manual — ejection
        // must not silently downgrade the session to per-action approvals.
        // Goes through setSessionPolicies (not the label-only mode setter) so
        // older sessions created before the full-auto default actually get
        // the matching policies instead of a lying label.
        ejectToFullAuto = chatSessionId;
      }
      await updateChatSessionAgent(chatSessionId, agent);
      if (ejectToFullAuto) {
        try {
          // confirmFullAccess (not setSessionPolicies): full-auto is the app
          // default, so ejecting must not pop the one-time confirmation modal.
          await get().confirmFullAccess(ejectToFullAuto);
        } catch {
          // Best-effort — agent swap still applied.
        }
      }
      if (nextPermissionMode !== undefined) {
        try {
          await setChatSessionPermissionMode(chatSessionId, nextPermissionMode);
        } catch {
          // Best-effort — agent swap still applied; the harness menu will
          // read the session row on the next render regardless.
        }
      }
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === chatSessionId
            ? {
                ...sess,
                agent,
                permissionMode:
                  nextPermissionMode !== undefined
                    ? nextPermissionMode
                    : sess.permissionMode,
              }
            : sess,
        ),
      }));
    },

    setSessionWatchMode: async (chatSessionId: string, mode: WatchMode | null) => {
      await updateChatSessionWatchMode(chatSessionId, mode);
      set((s) => ({
        sessions: patchSessions(s.sessions, chatSessionId, { watchMode: mode }),
      }));
    },

    setSessionPolicies: async (chatSessionId: string, sandbox: SandboxPolicy, approval: ApprovalPolicy) => {
      // Switching INTO full_access approval opens a one-time confirmation modal
      // first (per session — `fullAccessConfirmed` suppresses re-prompting within
      // the same app run). All other transitions apply immediately.
      if (approval === "full_access" && !hasFullAccessConfirmed(chatSessionId)) {
        set({ fullAccessConfirmingFor: chatSessionId });
        return false;
      }
      await updateChatSessionPolicies(chatSessionId, sandbox, approval);
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === chatSessionId
            ? {
                ...sess,
                sandboxPolicy: sandbox,
                approvalPolicy: approval,
                // Legacy field kept in sync for components still reading it.
                permissionMode: policiesToPermissionMode(sandbox, approval),
              }
            : sess,
        ),
        fullAccessConfirmingFor: null,
      }));
      return true;
    },

    confirmFullAccess: async (chatSessionId: string) => {
      markFullAccessConfirmed(chatSessionId);
      await updateChatSessionPolicies(chatSessionId, "workspace_write", "full_access");
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === chatSessionId
            ? {
                ...sess,
                sandboxPolicy: "workspace_write",
                approvalPolicy: "full_access",
                permissionMode: "full_auto",
              }
            : sess,
        ),
        fullAccessConfirmingFor: null,
      }));
    },

    cancelFullAccessConfirm: () => set({ fullAccessConfirmingFor: null }),

    setOwnerSessionId: (chatSessionId: string, ownerSessionId: string) =>
      set((s) => ({
        ownerSessionByChatId: { ...s.ownerSessionByChatId, [chatSessionId]: ownerSessionId },
      })),

    getOwnerSessionId: (chatSessionId: string) => get().ownerSessionByChatId[chatSessionId],
  };
}
