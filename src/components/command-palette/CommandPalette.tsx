// Command palette (§7.5, wireframe §12.3): fuzzy search over sessions,
// projects, and top-level actions. Hand-rolled scorer in lib/fuzzy.ts.
// The "Chats" section is different: full-text search over chat message
// content + titles via the backend FTS5 index (debounced IPC).
import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { fuzzyFilter } from "../../lib/fuzzy";
import { searchChatMessages, toastError, type ChatSearchResult } from "../../lib/ipc";
import { relativeTime } from "../../lib/relativeTime";
import { sessionDisplayTitle } from "../../lib/sessionTitle";
import { defaultHarness, newSessionFlow, openSession } from "../../lib/sessionLauncher";
import { useChatStore } from "../../state/chat";
import { useProjectsStore } from "../../state/projects";
import { useUiStore } from "../../state/ui";
import type { SessionRecord } from "../../types";

interface PaletteItem {
  id: string;
  section: "Sessions" | "Chats" | "Projects" | "Actions";
  label: string;
  hint?: string;
  run: () => void;
}

export function CommandPalette() {
  const paletteOpen = useUiStore((s) => s.paletteOpen);
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
  const projects = useProjectsStore((s) => s.projects);
  const sessions = useProjectsStore((s) => s.sessions);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [chatHits, setChatHits] = useState<ChatSearchResult[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (paletteOpen) {
      setQuery("");
      setActiveIdx(0);
      setChatHits([]);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [paletteOpen]);

  // Debounced full-text chat search. Unlike the fuzzy sections (in-memory),
  // this hits the SQLite FTS5 index over every stored chat message.
  useEffect(() => {
    if (!paletteOpen) return;
    const q = query.trim();
    if (q.length < 2) {
      setChatHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void searchChatMessages(q, 12)
        .then((res) => {
          if (!cancelled) setChatHits(res ?? []);
        })
        .catch(() => {
          if (!cancelled) setChatHits([]);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [paletteOpen, query]);

  const items = useMemo<PaletteItem[]>(() => {
    if (!paletteOpen) return [];
    const close = () => setPaletteOpen(false);
    const ui = useUiStore.getState();
    const store = useProjectsStore.getState();

    const all: PaletteItem[] = [
      ...sessions.map((session): PaletteItem => {
        const project = store.projectById(session.projectId);
        return {
          id: `session:${session.id}`,
          section: "Sessions",
          label: sessionDisplayTitle(session.title),
          hint: `${project?.name ?? "?"} · ${relativeTime(session.lastActiveAt)}`,
          run: () => {
            close();
            void openSession(session as SessionRecord);
          },
        };
      }),
      ...projects.map((project): PaletteItem => ({
        id: `project:${project.id}`,
        section: "Projects",
        label: project.name,
        hint: project.path,
        run: () => {
          close();
          store.selectProject(project.id);
          store.setExpanded(project.id, true);
        },
      })),
      {
        id: "action:new-session",
        section: "Actions",
        label: "New Session",
        run: () => {
          close();
          const projectId = store.selectedProjectId ?? store.projects[0]?.id;
          const harness = defaultHarness();
          if (projectId && harness) void newSessionFlow(projectId, harness);
        },
      },
      {
        id: "action:add-project",
        section: "Actions",
        label: "Add Project",
        run: () => {
          close();
          void open({ directory: true }).then(async (picked) => {
            if (typeof picked === "string") await useProjectsStore.getState().addProjectAtPath(picked);
          });
        },
      },
      {
        id: "action:new-worktree",
        section: "Actions",
        label: "New Worktree",
        run: () => {
          close();
          const projectId = store.selectedProjectId ?? store.projects[0]?.id;
          if (projectId) ui.setProjectSettingsFor(projectId); // worktree UI lives on the project context menu
        },
      },
      {
        id: "action:open-settings",
        section: "Actions",
        label: "Open Settings",
        run: () => {
          close();
          ui.setActiveView("settings");
        },
      },
      {
        id: "action:open-skills",
        section: "Actions",
        label: "Open Skills Library",
        run: () => {
          close();
          ui.setActiveView("skills");
        },
      },
      {
        id: "action:open-cost",
        section: "Actions",
        label: "Open Cost Dashboard",
        run: () => {
          close();
          ui.setActiveView("cost");
        },
      },
    ];

    if (!query.trim()) {
      // No query: sessions (recent first), then projects, then actions.
      return all;
    }
    const ranked = fuzzyFilter(query, all, (item) => item.label);
    return ranked.map((r) => r.item);
  }, [paletteOpen, query, sessions, projects, setPaletteOpen]);

  if (!paletteOpen) return null;

  // FTS hits are server-ranked already (titles first, then rank) — no
  // fuzzyFilter here. Selecting a hit opens that chat session.
  const chatItems: PaletteItem[] = chatHits.map((hit) => ({
    id: `chat:${hit.chatSessionId}:${hit.messageId ?? "title"}`,
    section: "Chats",
    label: hit.sessionTitle?.trim() || "Untitled chat",
    hint: hit.snippet ?? (hit.messageId == null ? "Title match" : undefined),
    run: () => {
      setPaletteOpen(false);
      // selectSession hits the DB and can reject (e.g. a brief lock) — same
      // toast as the sidebar's open path instead of an unhandled rejection.
      void useChatStore
        .getState()
        .selectSession(hit.chatSessionId)
        .catch((err) => toastError("Couldn't open that chat", err));
    },
  }));

  const sections: Array<{ name: PaletteItem["section"]; items: PaletteItem[] }> = [];
  for (const name of ["Sessions", "Chats", "Projects", "Actions"] as const) {
    const sectionItems = name === "Chats" ? chatItems : items.filter((i) => i.section === name);
    if (sectionItems.length > 0) sections.push({ name, items: sectionItems });
  }
  const flat = sections.flatMap((s) => s.items);
  const clampedActive = Math.min(activeIdx, Math.max(0, flat.length - 1));

  let runningIndex = -1;

  return (
    <div
      className="palette-overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) setPaletteOpen(false);
      }}
    >
      <div className="palette">
        <input
          ref={inputRef}
          placeholder="Search sessions, chats, projects, actions…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIdx(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setPaletteOpen(false);
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setActiveIdx(Math.min(clampedActive + 1, flat.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActiveIdx(Math.max(clampedActive - 1, 0));
            } else if (e.key === "Enter") {
              flat[clampedActive]?.run();
            }
          }}
        />
        <div className="results">
          {flat.length === 0 && <div className="section">No matches</div>}
          {sections.map((section) => (
            <div key={section.name}>
              <div className="section">{section.name.toUpperCase()}</div>
              {section.items.map((item) => {
                runningIndex += 1;
                const idx = runningIndex;
                return (
                  <div
                    key={item.id}
                    className={`item${idx === clampedActive ? " active" : ""}`}
                    onPointerEnter={() => setActiveIdx(idx)}
                    onClick={() => item.run()}
                  >
                    <span className="label">{item.label}</span>
                    {item.hint && <span className="hint">{item.hint}</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
