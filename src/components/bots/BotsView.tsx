// BotsView — the Bots destination (docs/architecture/BOTS.md).
//
// Left rail = the roster (state dot, pet, name, one-line description, gold
// pending-approval count, pulse while a run is in flight). Center = the bot's
// conversation, rendered by the REAL ChatView on the bot's own session — the
// same component the main pane uses, so streaming, tools, approvals,
// artifacts, checkpoints and TTS all work here for free and the thread stays
// openable from Chat History like any other session.
//
// This is the only place a bot's actions are managed: the editor modal, the
// standing jobs list, the run activity strip and the approval inbox all live
// in this view (there is no Settings page for bots).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageCirclePlus, Pin } from "lucide-react";
import { ChatView } from "../chat/ChatView";
import { ToolbarHeader } from "../common/ToolbarHeader";
import { BotEditorModal } from "./BotEditorModal";
import { BotSidebar } from "./BotSidebar";
import { useBots } from "../../hooks/useBots";
import { listAutomations } from "../../lib/ipc/automations";
import type { Automation } from "../../lib/ipc/automations";
import { useChatStore } from "../../state/chat";
import { useUiStore } from "../../state/ui";
import { PetAvatar } from "../pet/PetAvatar";
import { relativeTime } from "../../lib/relativeTime";
import type { Bot } from "../../lib/ipc/bots";

export function BotsView() {
  const {
    bots,
    runs,
    approvals,
    runningBots,
    loading,
    error,
    createBot,
    updateBot,
    deleteBot,
    setBotEnabled,
    runNow,
    stopRun,
    resolveApproval,
    listMemory,
    deleteMemory,
    openThread,
    newConversation,
    refresh,
  } = useBots();

  const [threadSessionId, setThreadSessionId] = useState<string | null>(null);
  const [editorBot, setEditorBot] = useState<Bot | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [jobs, setJobs] = useState<Automation[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const selectSession = useChatStore((s) => s.selectSession);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const activeChatSessionId = useChatStore((s) => s.activeChatSessionId);
  const chatSessions = useChatStore((s) => s.sessions);
  const setStarred = useChatStore((s) => s.setStarred);
  const deleteChat = useChatStore((s) => s.deleteChat);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const setPendingAutomationBotId = useUiStore((s) => s.setPendingAutomationBotId);
  // The selected bot lives in the ui store so the composer's pet dock can show
  // only this bot's pet while the Bots view is open.
  const activeBotId = useUiStore((s) => s.activeBotId);
  const setActiveBotId = useUiStore((s) => s.setActiveBotId);

  // The active bot's CONVERSATIONS (its threads), pinned first then newest —
  // listed in the rail's Sessions section. RUN sessions are deliberately NOT
  // listed here: a run is one headless execution, already reachable from the
  // "Recent runs" strip, and listing it alongside the conversation read as
  // "ask_bot spawned two chats".
  const activeBotSessions = useMemo(() => {
    if (!activeBotId) return [];
    return chatSessions
      .filter((s) => s.botId === activeBotId && s.botRole !== "run")
      .sort(
        (a, b) =>
          Number(b.starred) - Number(a.starred) || b.lastActiveAt - a.lastActiveAt,
      );
  }, [chatSessions, activeBotId]);

  const activeBot = useMemo(
    () => bots.find((b) => b.id === activeBotId) ?? null,
    [bots, activeBotId],
  );

  const botRuns = useMemo(
    () => (activeBot ? runs.filter((r) => r.botId === activeBot.id) : []),
    [runs, activeBot],
  );

  // The session ids that count as "this bot's output": every conversation plus
  // every run session. The activity rail filters the artifact ledger by this
  // set.
  const botSessions = useMemo(() => {
    const ids = new Set<string>();
    if (threadSessionId) ids.add(threadSessionId);
    if (activeBotId) {
      for (const s of chatSessions) {
        if (s.botId === activeBotId && s.botRole !== "run") ids.add(s.id);
      }
    }
    for (const r of botRuns) if (r.sessionId) ids.add(r.sessionId);
    return [...ids];
  }, [botRuns, threadSessionId, chatSessions, activeBotId]);

  // Select a bot: lazily create its thread, select it in the chat store, and
  // record which row is active. Bot sessions select with `recordNav: false` so
  // they never enter the MAIN chat's Back/Forward history (useMainChatRestore
  // hands the main chat its own session back on the way out of this view).
  const openBot = useCallback(
    async (bot: Bot) => {
      try {
        const sid = await openThread(bot.id);
        setActiveBotId(bot.id);
        setThreadSessionId(sid ?? null);
        // If the bot is working RIGHT NOW, open its LIVE run so the center
        // shows what it is doing instead of the idle (usually empty) thread.
        // "Right now" is the in-memory running set, NOT a DB `running` status:
        // a stale row (crash leftover, or a run whose session was deleted)
        // would otherwise be picked and its `selectSession` silently ignored
        // (tombstoned/deleted sessions are skipped), leaving the center on the
        // PREVIOUS bot — the reported "clicking a bot doesn't switch" bug.
        const liveRun = runningBots.includes(bot.id)
          ? runs.find((r) => r.botId === bot.id && r.status === "running")
          : undefined;
        const target = liveRun?.sessionId ?? sid;
        if (target) await selectSession(target, { recordNav: false });
        // If the live run's session had vanished, the select above was a no-op
        // — fall back to the thread so the center always shows THIS bot.
        if (
          target &&
          target !== sid &&
          sid &&
          useChatStore.getState().activeChatSessionId !== target
        ) {
          await selectSession(sid, { recordNav: false });
        }
      } catch (e) {
        // A deleted bot (or a failed thread creation) must not surface as an
        // unhandled rejection — say so in the flash line instead.
        setFlash(e instanceof Error ? e.message : String(e));
      }
    },
    [openThread, selectSession, runs, runningBots],
  );

  // Auto-open the first bot so the view is never blank.
  useEffect(() => {
    if (!activeBotId && bots.length > 0) void openBot(bots[0]);
  }, [bots, activeBotId, openBot]);

  // Standing jobs + the pulse that keeps the run strip live while a run works.
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void listAutomations()
        .then((list) => {
          if (!cancelled) setJobs(list ?? []);
        })
        .catch(() => {});
    };
    load();
    const t = window.setInterval(load, 20000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [bots.length]);

  const pendingByBot = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of approvals) {
      if (a.status === "pending") m[a.botId] = (m[a.botId] ?? 0) + 1;
    }
    return m;
  }, [approvals]);

  const runNowFor = useCallback(
    async (bot: Bot) => {
      try {
        const sid = await runNow(bot.id, undefined);
        setFlash(`${bot.name} is working — its live run is open.`);
        // Open the run session so the user watches it stream in the center.
        if (sid) await selectSession(sid, { recordNav: false });
      } catch (e) {
        setFlash(e instanceof Error ? e.message : String(e));
      }
    },
    [runNow, selectSession],
  );

  // Start a fresh conversation with this bot and open it. The backend creates
  // the thread; we relist chat sessions so it shows in the rail, then select it.
  const newSessionFor = useCallback(
    async (bot: Bot) => {
      try {
        const sid = await newConversation(bot.id);
        setActiveBotId(bot.id);
        setThreadSessionId(sid);
        await loadSessions();
        await selectSession(sid, { recordNav: false });
      } catch (e) {
        setFlash(e instanceof Error ? e.message : String(e));
      }
    },
    [newConversation, loadSessions, selectSession, setActiveBotId],
  );

  // Guards against the Enter key AND the subsequent blur both committing:
  // without it a rename could fire two update_bot calls (and, on a duplicate
  // name, show the error twice).
  const committingRename = useRef(false);
  const commitRename = useCallback(
    async (bot: Bot) => {
      if (committingRename.current) return;
      const next = renameValue.trim();
      if (!next || next === bot.name) {
        setRenamingId(null);
        setRenameError(null);
        return;
      }
      committingRename.current = true;
      try {
        await updateBot(bot.id, { name: next });
        setRenamingId(null);
        setRenameError(null);
      } catch (e) {
        // The backend is authoritative (empty, over 40 chars, duplicate) —
        // keep the input open and show its message verbatim.
        setRenameError(e instanceof Error ? e.message : String(e));
      } finally {
        committingRename.current = false;
      }
    },
    [renameValue, updateBot],
  );

  // The flash line is a transient status; clear it so stale copy does not sit
  // in the header forever.
  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 6000);
    return () => window.clearTimeout(t);
  }, [flash]);

  if (!loading && bots.length === 0) {
    return (
      <div className="bots-view bots-empty">
        <div className="bots-promo">
          <div className="bots-promo-glyph" aria-hidden="true">
            ◎
          </div>
          <h2>No bots yet</h2>
          <p>
            Bots are named agents with their own persona, memory, pet and standing jobs. They run
            on this machine, in their own conversation.
          </p>
          <button type="button" className="primary" onClick={() => setEditorOpen(true)}>
            Create your first bot
          </button>
        </div>
        {editorOpen && <BotEditorModal onClose={() => setEditorOpen(false)} onCreate={createBot} />}
      </div>
    );
  }

  return (
    <div className="bots-view">
      <aside className="bots-rail" aria-label="Bots">
        <div className="bots-rail-bots">
        {error && <div className="bots-rail-error">{error}</div>}
        {bots.map((bot) => {
          const pending = pendingByBot[bot.id] ?? 0;
          return (
            <div
              key={bot.id}
              className={`bots-rail-row${bot.id === activeBotId ? " is-active" : ""}${bot.enabled ? "" : " is-disabled"}`}
            >
              <button
                type="button"
                className="bots-rail-main"
                onClick={() => void openBot(bot)}
                title={bot.description || bot.name}
              >
                <span className="bots-rail-avatar">
                  {bot.pet ? (
                    <PetAvatar species={bot.pet} size={70} className="bots-rail-pet" />
                  ) : (
                    <span className="bots-rail-emoji">{bot.emoji}</span>
                  )}
                </span>
                <span className="bots-rail-text">
                  {renamingId === bot.id ? (
                    <input
                      className="bots-rail-rename"
                      value={renameValue}
                      autoFocus
                      aria-label="Bot name"
                      onChange={(e) => setRenameValue(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={() => void commitRename(bot)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void commitRename(bot);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setRenamingId(null);
                          setRenameError(null);
                        }
                      }}
                    />
                  ) : (
                    <span
                      className="bots-rail-name"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setRenamingId(bot.id);
                        setRenameValue(bot.name);
                      }}
                    >
                      {bot.name}
                    </span>
                  )}
                  <span className="bots-rail-desc">
                    {renameError && renamingId === bot.id
                      ? renameError
                      : bot.description || (bot.enabled ? "No description" : "Waiting for your approval")}
                  </span>
                </span>
                {pending > 0 && <span className="bots-rail-badge">{pending}</span>}
              </button>
              {!bot.enabled && (
                <button
                  type="button"
                  className="bots-rail-approve"
                  onClick={(e) => {
                    e.stopPropagation();
                    void setBotEnabled(bot.id, true);
                  }}
                >
                  Approve
                </button>
              )}
            </div>
          );
        })}
        <button type="button" className="bots-rail-add" onClick={() => setEditorOpen(true)}>
          ＋ New bot
        </button>
        </div>

        {activeBot && (
          <div className="bots-rail-sessions-wrap">
            <header className="bots-rail-sessions-head">
              <span>Sessions</span>
              {/* Same "new chat" affordance as the main sidebar's Chat History
                  header — the selected bot is already known, so no name here. */}
              <button
                type="button"
                className="bots-rail-sessions-new"
                title="New Chat"
                aria-label="New Chat"
                onClick={() => void newSessionFor(activeBot)}
              >
                <MessageCirclePlus size={14} strokeWidth={1.8} />
              </button>
            </header>
            <div className="bots-rail-sessions" aria-label="Bot sessions">
              {activeBotSessions.length === 0 ? (
                <p className="bots-rail-sessions-empty">
                  No conversations yet. Start one with ＋ New.
                </p>
              ) : (
                activeBotSessions.map((s) => {
                  const dot = s.unread ? "waiting" : "idle";
                  const label = s.title || "Conversation";
                  return (
                    <div
                      key={s.id}
                      role="button"
                      tabIndex={0}
                      className={`bots-rail-session${s.id === activeChatSessionId ? " is-active" : ""}${s.starred ? " is-starred" : ""}`}
                      title={label}
                      onClick={() => void selectSession(s.id, { recordNav: false })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          void selectSession(s.id, { recordNav: false });
                        }
                      }}
                    >
                      <button
                        type="button"
                        className={`bots-rail-session-pin${s.starred ? " pinned" : ""}`}
                        title={s.starred ? "Unpin — remove from the top" : "Pin to top"}
                        aria-label={s.starred ? "Unpin chat" : "Pin chat"}
                        aria-pressed={s.starred}
                        onClick={(e) => {
                          e.stopPropagation();
                          void setStarred(s.id, !s.starred);
                        }}
                      >
                        <Pin
                          size={11}
                          strokeWidth={2.2}
                          {...(s.starred ? { fill: "currentColor" } : {})}
                        />
                      </button>
                      <span className={`bots-rail-dot is-${dot}`} aria-hidden="true" />
                      <span className="bots-rail-session-title">{label}</span>
                      <span className="bots-rail-session-when">
                        {relativeTime(s.lastActiveAt)}
                      </span>
                      <button
                        type="button"
                        className="bots-rail-session-del"
                        title="Delete chat"
                        aria-label="Delete chat"
                        onClick={(e) => {
                          e.stopPropagation();
                          const wasActive = s.id === activeChatSessionId;
                          void deleteChat(s.id).then(() => {
                            // Keep the center occupied: if the deleted session
                            // was the open one, fall back to the thread.
                            const fallback =
                              threadSessionId && threadSessionId !== s.id
                                ? threadSessionId
                                : null;
                            if (wasActive && fallback) {
                              void selectSession(fallback, { recordNav: false });
                            }
                          });
                        }}
                      >
                        🗑
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </aside>

      <section className="bots-center">
        {activeBot ? (
          <>
            {/* The bot's header rides in the WINDOW TITLE BAR (portaled into the
                caption beside the window controls) — same as Vault / Wiki /
                Automations, so the conversation gets the row back and the
                chrome reads as one bar instead of two. It carries ONLY the
                actions: the pet, name and description already sit on the rail,
                so repeating them here was noise between the caption's back
                arrow and the buttons. */}
            <ToolbarHeader>
              <header className="bots-header">
                <div className="bots-header-actions">
                  <button type="button" onClick={() => void runNowFor(activeBot)}>
                    Run now
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditorBot(activeBot);
                      setEditorOpen(true);
                    }}
                  >
                    Edit
                  </button>
                </div>
              </header>
            </ToolbarHeader>
            {flash && (
              <div className="bots-flash" role="status">
                {flash}
              </div>
            )}
            <div className="bots-center-chat">
              {activeChatSessionId ? <ChatView hideGitSidebar /> : null}
              <BotSidebar
                approvals={approvals.filter((a) => a.botId === activeBot.id)}
                jobs={jobs.filter((j) => j.botId === activeBot.id)}
                runs={botRuns}
                running={runningBots.includes(activeBot.id)}
                botSessions={botSessions}
                botId={activeBot.id}
                listMemory={listMemory}
                onManageMemory={() => {
                  setEditorBot(activeBot);
                  setEditorOpen(true);
                }}
                onResolveApproval={async (id, approve) => {
                  await resolveApproval(id, approve);
                }}
                onAddJob={() => {
                  // Hand off to the Automations editor, whose new-job form opens
                  // pre-bound to this bot (the only place a bot-bound standing
                  // job can be created).
                  setPendingAutomationBotId(activeBot.id);
                  setActiveView("automations");
                }}
                onOpenRun={async (run) => {
                  await selectSession(run.sessionId, { recordNav: false });
                }}
                onStopRun={async (run) => {
                  await stopRun(run.id);
                }}
              />
            </div>
          </>
        ) : (
          <div className="bots-center-empty">Pick a bot on the left.</div>
        )}
      </section>

      {editorOpen && (
        <BotEditorModal
          bot={editorBot}
          onClose={() => {
            setEditorOpen(false);
            setEditorBot(null);
          }}
          onCreate={async (input) => {
            const bot = await createBot(input);
            await openBot(bot);
            return bot;
          }}
          onUpdate={updateBot}
          onDelete={deleteBot}
          onRun={runNow}
          listMemory={listMemory}
          deleteMemory={deleteMemory}
          onOpenAutomations={() => setActiveView("automations")}
          refresh={refresh}
        />
      )}
    </div>
  );
}
