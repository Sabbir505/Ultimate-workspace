// BotPetDock — the docked companions on the composer and the search bar
// (docs/architecture/BOTS.md + the pets work that replaced the 2D sprite
// sheets with the six 3D pets).
//
// One pet per bot that chose one, no name label — the animal IS the identity
// (its tooltip carries the bot name). Clicking a pet opens that bot's thread
// and switches to the Bots view.
//
// WALKING: the 3D engine plays an IN-PLACE walk cycle (legs/bob) — it does not
// locomote, exactly like the classic companion. So, like the companion, the
// pet's locomotion is DOM: a square host moved across its lane by `left`, with
// a target-spot stroll (walk to a spot → pause → repeat, with the odd nap). The
// bot's own state always overrides the ambient stroll: working while a run is
// in flight, sleeping while disabled/awaiting approval, celebrating on a
// resolved approval.
//
// The pets live in ONE home at a time (per bot). Drag a pet onto the other home
// to move just that one — both docks arm as drop targets while a drag is in
// flight.
//
// A hidden home shows nothing: the full-screen wiki / vault views hide every
// dock, and the sidebar dock also goes dark while the rail is collapsed. The
// BOTS view is the exception — its composer keeps the dock, showing only the
// SELECTED bot's pet (not the whole roster; the selected bot id lives in the
// ui store). The dodge is deliberate: the shared 3D canvas draws from each
// host's layout rect, which ignores the rail's overflow/visibility clipping
// (pets used to bleed over the view behind a hidden rail).

import { useEffect, useMemo, useRef, useState } from "react";
import { useBots } from "../../hooks/useBots";
import { PetAvatar } from "./PetAvatar";
import { useChatStore } from "../../state/chat";
import { useUiStore } from "../../state/ui";
import { isFullScreenView } from "../../lib/viewKinds";
import { petHomeOf, useBotPetHome } from "../../state/botPets";
import { PET_EMOJI } from "../../lib/pets/manifest";
import type { PetState } from "../../lib/pets/stage";

/** Lane fraction per second — matches the companion's PET_WALK_SPEED so the
 *  docked pets amble at the same pace the old companion did. */
const PET_WALK_SPEED = 0.09;

interface Stroll {
  /** Position within the lane, 0..1. */
  x: number;
  /** Where it is walking to, or null while paused. */
  target: number | null;
  /** Epoch ms when the next stroll may start. */
  nextWalkAt: number;
  /** Resting pose while paused: a nap (sleeping) or a sit (idle). */
  napping: boolean;
  /** Which way it faces (the walk direction) so it never walks backwards. */
  facing: 1 | -1;
}

export interface BotPetDockProps {
  /** Where this dock lives: "sidebar" (search bar) or a composer home. */
  myHome?: string;
  compact?: boolean;
}

export function BotPetDock({ myHome, compact }: BotPetDockProps) {
  const { bots, runs, runningBots, approvals, openThread } = useBots();
  const selectSession = useChatStore((s) => s.selectSession);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const baseView = useUiStore((s) => s.baseView);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const activeBotId = useUiStore((s) => s.activeBotId);
  const setActiveBotId = useUiStore((s) => s.setActiveBotId);
  const homes = useBotPetHome((s) => s.homes);
  const dragging = useBotPetHome((s) => s.dragging);
  const setHome = useBotPetHome((s) => s.setHome);
  const beginDrag = useBotPetHome((s) => s.beginDrag);
  const endDrag = useBotPetHome((s) => s.endDrag);

  const here = myHome ?? "main";
  // The Bots view is full-screen, but its composer still hosts the dock — and
  // there it shows ONLY the selected bot's pet (not the whole roster).
  const inBotsView = baseView === "bots";
  // Hidden: the sidebar home goes dark on any full-screen view (the rail is
  // gone) or a collapsed rail; the composer home hides on install wiki/vault
  // but stays on chat AND on bots.
  const hiddenHere =
    here === "sidebar"
      ? sidebarCollapsed || isFullScreenView(baseView)
      : isFullScreenView(baseView) && !inBotsView;
  const docked = useMemo(() => bots.filter((b) => Boolean(b.pet)), [bots]);
  const mine = useMemo(() => {
    if (inBotsView && here !== "sidebar") {
      return docked.filter((b) => b.id === activeBotId);
    }
    return docked.filter((b) => petHomeOf(homes, b.id) === here);
  }, [docked, homes, here, inBotsView, activeBotId]);
  const pendingByBot = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of approvals) {
      if (a.status === "pending") m[a.botId] = (m[a.botId] ?? 0) + 1;
    }
    return m;
  }, [approvals]);

  const strolls = useRef<Record<string, Stroll>>({});
  // The moving host element per bot (the actor span), so the walk loop can move
  // it imperatively instead of through React.
  const actorRefs = useRef<Record<string, HTMLElement | null>>({});
  const lastLeft = useRef<Record<string, string>>({});
  // What the DOM/GL is CURRENTLY showing per bot, so the loop only re-renders
  // React on a DISCRETE change (mood or facing) — never once per frame.
  const visualsRef = useRef<Record<string, { state: PetState; facing: 1 | -1 }>>({});
  const [visuals, setVisuals] = useState<Record<string, { state: PetState; facing: 1 | -1 }>>({});

  // The stroll loop: walk to a spot, pause (sometimes nap), repeat.
  //
  // Driven by requestAnimationFrame and written IMPERATIVELY to the actor
  // element's `left`. It used to run on a 100ms setInterval that called a
  // React `force()` re-render: the pet's host rectangle then moved only 10
  // steps/second, while the 3D stage samples that rectangle at 30fps — so the
  // walk visibly juddered. Now the rect moves at frame rate and React only
  // re-renders on a state/facing transition.
  useEffect(() => {
    if (hiddenHere || mine.length === 0) return;
    let raf = 0;
    let last = 0;
    const step = (now: number) => {
      raf = requestAnimationFrame(step);
      const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
      last = now;
      let next: Record<string, { state: PetState; facing: 1 | -1 }> | null = null;
      for (const bot of mine) {
        const base = petStateFor(bot, runningBots, pendingByBot, approvals);
        const s = (strolls.current[bot.id] ??= {
          x: 0.5,
          target: null,
          nextWalkAt: now + 2000 + Math.random() * 5000,
          napping: false,
          facing: 1,
        });
        if (base !== "idle") {
          // The bot is doing something — no ambient stroll.
          if (s.target !== null || s.napping) {
            s.target = null;
            s.napping = false;
          }
        } else if (s.target !== null) {
          const dx = s.target - s.x;
          const stepLen = PET_WALK_SPEED * dt;
          if (Math.abs(dx) <= stepLen) {
            s.x = s.target;
            s.target = null;
            s.napping = Math.random() < 0.25;
            s.nextWalkAt =
              now + (s.napping ? 40_000 + Math.random() * 40_000 : 9_000 + Math.random() * 14_000);
          } else {
            s.x += Math.sign(dx) * stepLen;
            s.facing = dx > 0 ? 1 : -1;
          }
        } else if (now >= s.nextWalkAt) {
          s.napping = false;
          s.target = 0.2 + Math.random() * 0.6;
        }
        // Sub-React locomotion: move the host only when the value changed, so
        // an idle pet costs no style writes.
        const el = actorRefs.current[bot.id];
        if (el) {
          const left = `${(s.x * 100).toFixed(2)}%`;
          if (lastLeft.current[bot.id] !== left) {
            lastLeft.current[bot.id] = left;
            el.style.left = left;
          }
        }
        const state: PetState =
          base !== "idle" ? base : s.target !== null ? "strolling" : s.napping ? "sleeping" : "idle";
        const cur = visualsRef.current[bot.id];
        if (!cur || cur.state !== state || cur.facing !== s.facing) {
          (next ??= { ...visualsRef.current })[bot.id] = { state, facing: s.facing };
        }
      }
      if (next) {
        visualsRef.current = next;
        setVisuals(next);
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [hiddenHere, mine, runningBots, pendingByBot, approvals]);

  const anyDragging = dragging !== null;
  // Nothing to dock, this home is hidden (full-screen view / collapsed rail),
  // or no pets here and no drag in flight. While dragging, both docks stay
  // mounted as drop targets — but never a hidden one.
  if (docked.length === 0 || hiddenHere) return null;
  if (mine.length === 0 && !anyDragging) return null;

  return (
    <div
      className={`bot-pet-dock${compact ? " is-compact" : ""}${anyDragging ? " is-drop-armed" : ""}`}
      data-bot-pet-home={here}
      aria-label="Bots"
      onDragOver={(e) => {
        if (!anyDragging) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }}
      onDrop={(e) => {
        if (!anyDragging || !dragging) return;
        e.preventDefault();
        setHome(dragging, here);
        endDrag();
      }}
    >
      {mine.length > 0 && (
        <div className="bot-pet-dock-row">
          {mine.map((bot) => {
            const base = petStateFor(bot, runningBots, pendingByBot, approvals);
            const v = visuals[bot.id];
            const state: PetState = v?.state ?? (base !== "idle" ? base : "idle");
            const facing: 1 | -1 = v?.facing ?? 1;
            return (
              <button
                key={bot.id}
                type="button"
                className="bot-pet-slot"
                draggable
                title={`${bot.name}${bot.description ? ` — ${bot.description}` : ""}`}
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", "bot-pet");
                  e.dataTransfer.effectAllowed = "move";
                  // The 3D pet is drawn on a fixed canvas, so the element carries
                  // no art to use as a drag image — make one from the species
                  // emoji instead of dragging an empty box.
                  const ghost = document.createElement("div");
                  ghost.textContent = PET_EMOJI[bot.pet] ?? "🐾";
                  ghost.style.cssText =
                    "position:fixed;top:-100px;left:-100px;font-size:34px;line-height:1;pointer-events:none;";
                  document.body.appendChild(ghost);
                  try {
                    e.dataTransfer.setDragImage(ghost, 17, 17);
                  } catch {
                    /* some engines refuse a detached image */
                  }
                  window.setTimeout(() => ghost.remove(), 0);
                  beginDrag(bot.id);
                }}
                onDragEnd={() => endDrag()}
                onClick={async () => {
                  // A working bot opens its LIVE run (what it is doing now);
                  // otherwise its idle thread. "Working" = the in-memory
                  // running set, never a possibly-stale DB `running` status
                  // (which may point at a deleted session and silently fail).
                  const liveRun = runningBots.includes(bot.id)
                    ? runs.find((r) => r.botId === bot.id && r.status === "running")
                    : undefined;
                  const sid = liveRun?.sessionId ?? (await openThread(bot.id));
                  // Selecting the bot here also drives the Bots view (and its
                  // single-pet dock) — otherwise the auto-open would pick the
                  // first bot instead of this one.
                  setActiveBotId(bot.id);
                  if (sid) await selectSession(sid, { recordNav: false });
                  setActiveView("bots");
                }}
              >
                <span
                  className="bot-pet-actor"
                  ref={(el) => {
                    actorRefs.current[bot.id] = el;
                  }}
                >
                  <PetAvatar
                    species={bot.pet}
                    size={compact ? 85 : 120}
                    state={state}
                    facing={facing}
                  />
                  {!bot.enabled && (
                    <span className="bot-pet-badge" aria-label="Waiting for approval">
                      !
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** How long a resolved approval keeps the pet celebrating. Without a window
 *  the "celebrating" pose was permanent: `approvals` carries up to 200 rows
 *  including every historical resolved one, so a bot that had ever had an
 *  approval approved never strolled or napped again. */
const CELEBRATE_MS = 60_000;

export function petStateFor(
  bot: { id: string; enabled: boolean },
  runningBots: string[],
  pendingByBot: Record<string, number>,
  approvals: { botId: string; status: string; resolvedAt: number | null }[],
): PetState {
  if (!bot.enabled) return "sleeping";
  if (runningBots.includes(bot.id)) return "working";
  if ((pendingByBot[bot.id] ?? 0) > 0) return "strolling";
  const now = Date.now();
  const justResolved = approvals.some(
    (a) =>
      a.botId === bot.id &&
      (a.status === "approved" || a.status === "failed") &&
      a.resolvedAt != null &&
      now - a.resolvedAt < CELEBRATE_MS,
  );
  return justResolved ? "celebrating" : "idle";
}
