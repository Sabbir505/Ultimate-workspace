// Sidebar (Â§5): inbox-style layout â€” brand/search header, Artifacts,
// Automations, then the Chat History inbox (every chat in one flat list,
// two lines per row: title + working-spinner/relative time, then the
// project Â· branch context and the provider/harness/local-model brand icon)
// and footer links to Settings / Skills Library / Cost Dashboard. The old
// Projects tree is retired: project + branch live on each chat's second
// row instead of a nested tree.
//
// Visual style: white / frosted glass (light) with a matching dark variant.
// The <aside> shell is bg-white/95 in light, bg-slate-900/60 in dark, both
// with backdrop-blur. Interactive surfaces are bg-gray-100 (light) /
// bg-white/10 (dark), darkening slightly on hover. Selected items get a
// darker bg + border. Text uses gray-700/gray-900 (light) and slate-200/
// white (dark). All Tailwind classes use dark: variants keyed to
// [data-theme="dark"] so a single source of truth covers both themes.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";

import { toastError, toastSuccess, exportChatZip, getMobilePairingInfo, type MobilePairingInfo } from "../../lib/ipc";
import {
  ArrowLeft,
  ArrowRight,
  DollarSign,
  Library,
  MessageCirclePlus,
  MessageSquare,
  Search,
  Settings,
  CalendarClock,
  X,
  QrCode,
} from "lucide-react";
import { useProjectsStore } from "../../state/projects";
import { useChatStore } from "../../state/chat";
import { useUiStore } from "../../state/ui";
import { useArtifactsStore } from "../../state/artifacts";
import { useNewChatAction } from "../../hooks/useNewChatAction";
import { useViewNav } from "../../hooks/useViewNav";
import { ArtifactLibrary } from "./ArtifactLibrary";
import { ChatSessionRowMemo as ChatSessionRow, type ChatSessionRowData } from "../chat/ChatSessionRow";
import { UpdateButton } from "./UpdateButton";
import { seedFakeUpdate, SHOW_FAKE_UPDATE } from "../../state/updater";

export function Sidebar() {
  const projects = useProjectsStore((s) => s.projects);
  // Per-project git status (branch) — polled by the projects store; rows
  // fall back to the project name alone when a branch isn't known yet.
  const gitStatuses = useProjectsStore((s) => s.gitStatuses);
  const activeView = useUiStore((s) => s.activeView);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
  const setGitPromptProjectId = useUiStore((s) => s.setGitPromptProjectId);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  // Browser-style back/forward over views AND visited chats (shared with
  // the collapsed rail so both clusters behave identically).
  const { back: navBack, forward: navForward, canBack, canForward } = useViewNav();

  // Chat store
  const chatSessions = useChatStore((s) => s.sessions);
  const activeChatSessionId = useChatStore((s) => s.activeChatSessionId);
  // Per-chat project binding (newer of the two binding paths: DB column via
  // s.projectId, or the newer sessionProjects map).
  const sessionProjects = useChatStore((s) => s.sessionProjects);
  // Chats pointed at an arbitrary folder via the composer's folder notch —
  // shown on the inbox row's second line when there's no bound project.
  const cwdOverrides = useChatStore((s) => s.cwdOverrides);
  // Every session id currently streaming — the sidebar row needs the spinner
  // even for background sessions (a user working in chat A must still see
  // chat B is responding). The old selector filtered to the active session
  // only, so nested-project background chats never lit up.
  const streamingIds = useChatStore(
    useCallback((s) => Object.keys(s.streaming), []),
  );
  const chatConfig = useChatStore((s) => s.config);
  const lastSelection = useChatStore((s) => s.lastSelection);
  const chatLoaded = useChatStore((s) => s.loaded);
  const selectSession = useChatStore((s) => s.selectSession);
  const newChat = useChatStore((s) => s.newChat);
  const deleteChat = useChatStore((s) => s.deleteChat);
  const renameChat = useChatStore((s) => s.renameChat);
  const setStarred = useChatStore((s) => s.setStarred);
  const setUnread = useChatStore((s) => s.setUnread);
  const toggleSessionWorktree = useChatStore((s) => s.toggleSessionWorktree);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const loadConfig = useChatStore((s) => s.loadConfig);

  // Artifacts count
  const artifactItems = useArtifactsStore((s) => s.items);

  // â”€â”€ Pairing QR modal (sidebar footer quick access) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const [pairingModalOpen, setPairingModalOpen] = useState(false);
  const [pairingInfo, setPairingInfo] = useState<MobilePairingInfo | null>(null);
  const [pairingQr, setPairingQr] = useState<string>("");
  const [pairingLoading, setPairingLoading] = useState(false);
  const pairingTimer = useRef<number | null>(null);

  const loadPairingInfo = useCallback(async () => {
    try {
      const info = await getMobilePairingInfo();
      setPairingInfo(info);
      // Prefer: tailnet direct (no HTTPS serve needed) â†’ HTTPS serve â†’ local USB bridge.
      const url = info?.tailnetUrl ?? info?.tailscaleUrl ?? info?.localUrl ?? "";
      if (url) {
        const { default: QRCode } = await import("qrcode");
        const dataUrl = await QRCode.toDataURL(url, { width: 240, margin: 1 });
        setPairingQr(dataUrl);
      } else {
        setPairingQr("");
      }
    } catch {
      setPairingInfo(null);
      setPairingQr("");
    } finally {
      setPairingLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!pairingModalOpen) return;
    setPairingLoading(true);
    void loadPairingInfo();
    // Poll while modal is open so QR stays fresh if serve state changes.
    pairingTimer.current = window.setInterval(() => void loadPairingInfo(), 3000);
    return () => {
      if (pairingTimer.current) window.clearInterval(pairingTimer.current);
    };
  }, [pairingModalOpen, loadPairingInfo]);

  const closePairingModal = useCallback(() => {
    if (pairingTimer.current) window.clearInterval(pairingTimer.current);
    setPairingModalOpen(false);
  }, []);

  const openPairingModal = useCallback(() => {
    setPairingModalOpen(true);
  }, []);

  // The pairing QR popover isn't a Modal, so it must register itself with the
  // webview-occlusion system (M22) — a native browser webview would otherwise
  // paint on top of it.
  const setModalOpen = useUiStore((s) => s.setModalOpen);
  useEffect(() => {
    if (!pairingModalOpen) return;
    setModalOpen("sidebar:pairing-qr", true);
    return () => setModalOpen("sidebar:pairing-qr", false);
  }, [pairingModalOpen, setModalOpen]);

  // DEV-ONLY mock update for visual review (see SHOW_FAKE_UPDATE in state/updater).
  useEffect(() => {
    if (!SHOW_FAKE_UPDATE) return;
    seedFakeUpdate();
  }, []);

  const handleNewChat = useNewChatAction();

  const handleSelectChat = useCallback(
    (id: string) => {
      void selectSession(id).catch((err) => toastError("Couldn't open that chat", err));
      setActiveView("chat");
    },
    [selectSession, setActiveView],
  );

  const handleDeleteChat = useCallback(
    (id: string) => {
      void deleteChat(id);
    },
    [deleteChat],
  );

  const handleRenameChat = useCallback(
    (id: string, title: string) => {
      void renameChat(id, title);
    },
    [renameChat],
  );

  const handleToggleStar = useCallback(
    (id: string, starred: boolean) => {
      void setStarred(id, starred);
    },
    [setStarred],
  );

  const handleSetUnread = useCallback(
    (id: string, unread: boolean) => {
      void setUnread(id, unread);
    },
    [setUnread],
  );

  const handleExportChat = useCallback((id: string) => {
    exportChatZip(id)
      .then((saved) => {
        if (saved) toastSuccess("Chat exported to .zip");
      })
      .catch((err) => toastError("Chat export failed", err));
  }, []);

  // Open the chat in the split pane beside the main view; clicking the item
  // for the already-split chat closes the pane (toggle).
  const handleOpenSplitChat = useCallback((id: string) => {
    const chat = useChatStore.getState();
    if (chat.splitChatSessionId === id) {
      chat.closeChatSplit();
    } else {
      chat.openChatSplit(id);
    }
  }, []);

  useEffect(() => {
    if (!chatLoaded) {
      void loadSessions();
      void loadConfig();
    }
  }, [chatLoaded, loadSessions, loadConfig]);

  // Inbox list: EVERY chat in one flat list — project-bound chats included
  // (their project/branch now live on the row's second line instead of a
  // nested tree). Starred chats float to the top, then most-recent.
  const chatRowData: ChatSessionRowData[] = useMemo(
    () =>
      chatSessions
        .map((s) => {
          const projectId = s.projectId ?? sessionProjects[s.id] ?? null;
          const project = projectId
            ? projects.find((p) => p.id === projectId) ?? null
            : null;
          const overridePath = cwdOverrides[s.id] ?? null;
          const folderName = overridePath
            ? overridePath.split(/[\/]/).filter(Boolean).pop() ?? null
            : null;
          const branchName = s.worktreePath
            ? `relay/${s.id}` // isolated-worktree branch naming (P0 §3.1.1)
            : projectId
              ? gitStatuses[projectId]?.branch ?? null
              : null;
          return {
            id: s.id,
            title: s.title ?? "Untitled Chat",
            lastActiveAt: s.lastActiveAt,
            lastMessage: undefined,
            starred: s.starred ?? false,
            unread: s.unread ?? false,
            worktreePath: s.worktreePath ?? null,
            projectName: project?.name ?? folderName ?? null,
            branchName,
            agent: s.agent ?? null,
            provider: s.provider ?? null,
          };
        })
        .sort(
          (a, b) =>
            Number(b.starred) - Number(a.starred) || b.lastActiveAt - a.lastActiveAt,
        ),
    [chatSessions, sessionProjects, projects, gitStatuses, cwdOverrides],
  );

  // PERF (PERFORMANCE_AUDIT.md mi27/F5): virtualize the flat chat-history
  // list â€” 100+ sessions used to mount 100+ ChatSessionRow subtrees (each
  // with hover action buttons + context menu wiring), making sidebar scroll
  // stutter. Rows self-measure via measureElement.
  const chatListRef = useRef<HTMLDivElement>(null);
  const chatListVirtualizer = useVirtualizer({
    count: chatRowData.length,
    getScrollElement: () => chatListRef.current,
    estimateSize: () => 80,
    overscan: 8,
    // Key cached row measurements by session id, not list index. Switching
    // chats or creating one re-sorts the sessions array; with index-keyed
    // measurements the cached heights attach to whatever rows moved into
    // those index slots, leaving tall phantom gaps between history rows.
    getItemKey: (index) => chatRowData[index].id,
  });

  return (
    <aside className="sidebar-glass flex flex-col h-full overflow-hidden select-none">
      {/* â”€â”€ Consolidated Header: branding + search + collapse in one block â”€â”€ */}
      <div data-tauri-drag-region className="p-3 border-b border-gray-200 dark:border-white/20">
        {/* The brand doubles as the collapse control (no separate panel icon);
            back/forward sit at the header's right edge. */}
        <div className="flex items-center justify-between mb-2">
          <button
            type="button"
            className="sidebar-brand-btn sidebar-wordmark select-none px-1.5 py-0.5 -ml-1.5 rounded-md"
            onClick={toggleSidebar}
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
          >
            Relay
          </button>
          <span className="flex items-center flex-shrink-0">
            <UpdateButton />
            <button
              type="button"
              className="sidebar-nav-btn"
              onClick={navBack}
              disabled={!canBack}
              title="Back"
              aria-label="Back"
            >
              <ArrowLeft size={14} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              className="sidebar-nav-btn"
              onClick={navForward}
              disabled={!canForward}
              title="Forward"
              aria-label="Forward"
            >
              <ArrowRight size={14} strokeWidth={1.8} />
            </button>
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* Search / command palette trigger */}
          <button
            onClick={() => setPaletteOpen(true)}
            className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/10 border border-gray-200 dark:border-white/20 text-gray-700 dark:text-slate-200 hover:bg-gray-200 dark:hover:bg-white/20 hover:text-gray-900 dark:hover:text-white transition-all duration-150 active:scale-95"
            title="Search (Cmd/Ctrl+K)"
          >
            <Search size={14} strokeWidth={1.8} />
            <span className="text-xs font-medium">Search</span>
          </button>
        </div>
      </div>

      {/* â”€â”€ Pinned upper block (non-scrolling) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <div className="flex-shrink-0">
        {/* Global Views: Artifacts pill + Schedule button (automations) */}
        <div className="flex flex-col gap-1 px-2 pt-2 pb-0">
          <ArtifactLibrary />
          <div className="chat-new-btn-row">
            <button
              type="button"
              onClick={() => setActiveView("automations")}
              className={`artifact-lib-title ${activeView === "automations" ? "is-active" : ""}`}
              style={{ width: "100%" }}
              title="Open automations"
              aria-label="Open automations"
            >
              <CalendarClock size={14} strokeWidth={1.8} className="artifact-lib-title-icon" />
              <span className="artifact-lib-title-label">Automations</span>
            </button>
          </div>
        </div>
      </div>

      {/* â”€â”€ Recent History â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      {/* Label stays pinned; only the chat list below scrolls. */}
      <div className="px-2 pt-0.5 pb-1 flex-shrink-0">
          <div className="sidebar-section-header flex items-center gap-1 mb-1">
            <span className="sidebar-section-label">
              <MessageSquare size={14} strokeWidth={1.8} className="sidebar-section-label-icon" />
              Chat History
            </span>
          {/* New Chat â€” same "+" affordance as the Projects header */}
          <button
            onClick={handleNewChat}
            className="sidebar-quiet-btn p-2 rounded-md bg-transparent text-gray-700 dark:text-slate-200 hover:bg-gray-200 dark:hover:bg-white/20 hover:text-gray-900 dark:hover:text-white transition-all duration-150 active:scale-95"
            title="New Chat"
            aria-label="New Chat"
          >
            <MessageCirclePlus size={14} strokeWidth={1.8} />
          </button>
        </div>
      </div>
      {/* â”€â”€ Scrolling chat list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <div className="flex-1 overflow-y-auto sidebar-thin-scroll min-h-0" ref={chatListRef}>
        {chatRowData.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-6 px-3">
            <MessageSquare size={20} className="text-gray-300 dark:text-slate-400" strokeWidth={1.5} />
            <span className="text-xs text-gray-500 dark:text-slate-300">No chats yet</span>
          </div>
        ) : (
          <div
            style={{
              height: chatListVirtualizer.getTotalSize(),
              position: "relative",
            }}
          >
            {chatListVirtualizer.getVirtualItems().map((vi) => {
              const s = chatRowData[vi.index];
              return (
                <div
                  key={s.id}
                  data-index={vi.index}
                  ref={chatListVirtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  <ChatSessionRow
                    session={s}
                    active={s.id === activeChatSessionId}
                    working={streamingIds.includes(s.id)}
                    onSelect={handleSelectChat}
                    onDelete={handleDeleteChat}
                    onRename={handleRenameChat}
                    onToggleStar={handleToggleStar}
                    onSetUnread={handleSetUnread}
                    onExport={handleExportChat}
                    onOpenSplit={handleOpenSplitChat}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* â”€â”€ Pinned Footer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <div className="flex-shrink-0 flex flex-row justify-center gap-2 p-2 border-t border-gray-200 dark:border-white/20">
        <button
          className={`sidebar-quiet-btn p-2 rounded-lg transition-all duration-150 active:scale-95 ${
            activeView === "skills"
              ? "bg-gray-200 dark:bg-white/15 text-gray-900 dark:text-white"
              : "bg-transparent dark:bg-transparent text-gray-700 dark:text-slate-200 hover:bg-gray-200 dark:hover:bg-white/20 hover:text-gray-900 dark:hover:text-white"
          }`}
          onClick={() => setActiveView(activeView === "skills" ? "chat" : "skills")}
          title="Skills Library"
          aria-label="Skills Library"
        >
          <Library size={16} strokeWidth={1.8} />
        </button>
        <button
          className={`sidebar-quiet-btn p-2 rounded-lg transition-all duration-150 active:scale-95 ${
            activeView === "cost"
              ? "bg-gray-200 dark:bg-white/15 text-gray-900 dark:text-white"
              : "bg-transparent dark:bg-transparent text-gray-700 dark:text-slate-200 hover:bg-gray-200 dark:hover:bg-white/20 hover:text-gray-900 dark:hover:text-white"
          }`}
          onClick={() => setActiveView(activeView === "cost" ? "chat" : "cost")}
          title="Cost"
          aria-label="Cost"
        >
          <DollarSign size={16} strokeWidth={1.8} />
        </button>
        <button
          className={`sidebar-quiet-btn p-2 rounded-lg transition-all duration-150 active:scale-95 ${
            pairingModalOpen
              ? "bg-gray-200 dark:bg-white/15 text-gray-900 dark:text-white"
              : "bg-transparent dark:bg-transparent text-gray-700 dark:text-slate-200 hover:bg-gray-200 dark:hover:bg-white/20 hover:text-gray-900 dark:hover:text-white"
          }`}
          onClick={openPairingModal}
          title="Phone pairing QR"
          aria-label="Phone pairing QR"
        >
          <QrCode size={16} strokeWidth={1.8} />
        </button>
        <button
          className={`sidebar-quiet-btn p-2 rounded-lg transition-all duration-150 active:scale-95 ${
            activeView === "settings"
              ? "bg-gray-200 dark:bg-white/15 text-gray-900 dark:text-white"
              : "bg-transparent dark:bg-transparent text-gray-700 dark:text-slate-200 hover:bg-gray-200 dark:hover:bg-white/20 hover:text-gray-900 dark:hover:text-white"
          }`}
          onClick={() => setActiveView(activeView === "settings" ? "chat" : "settings")}
          title="Settings"
          aria-label="Settings"
        >
          <Settings size={16} strokeWidth={1.8} />
        </button>
      </div>

      {/* â”€â”€ Pairing QR modal (sidebar quick access) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
          Rendered via portal to document.body so it overlays the entire app
          (the sidebar's backdrop-blur creates its own containing block,
          which would trap a position:fixed overlay inside the rail). */}
      {pairingModalOpen &&
        createPortal(
          <div className="pairing-modal" onClick={closePairingModal}>
            <div className="pairing-modal-card" onClick={(e) => e.stopPropagation()}>
              <div className="pairing-modal-head">
                <span className="pairing-modal-title">Phone pairing</span>
                <button className="pairing-modal-close" onClick={closePairingModal} aria-label="Close">
                  <X size={16} />
                </button>
              </div>
              {pairingLoading ? (
                <p className="muted" style={{ fontSize: 12 }}>Loadingâ€¦</p>
              ) : pairingInfo?.running && pairingQr ? (
                <>
                  <div className="pairing-modal-qr">
                    <img src={pairingQr} alt="Pairing QR" width={240} height={240} />
                  </div>
<p className="pairing-modal-hint">
                  Scan with the mobile app to pair. Works over Tailscale
                  {pairingInfo.tailnetUrl || pairingInfo.tailscaleUrl ? " (cross-network)" : " (local)"}.
                  Token rotates each time the relay restarts.
                </p>
                <div className="field">
                  <label className="field-label" style={{ fontSize: 11 }}>URL</label>
                  <code className="pairing-modal-url" style={{ color: "var(--text-dim)" }}>
                    {pairingInfo.tailnetUrl ?? pairingInfo.tailscaleUrl ?? pairingInfo.localUrl}
                  </code>
                </div>
                </>
              ) : (
                <p className="muted" style={{ fontSize: 12 }}>
                  Relay is not running. Open Settings â†’ Remote to start it.
                </p>
              )}
            </div>
          </div>,
          document.body,
        )}
    </aside>
  );
}
