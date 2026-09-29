// Header chrome that lives in the WINDOW TITLE BAR, not in the page.
//
// The app runs undecorated (decorations:false), so the `.toolbar` in App.tsx
// IS the caption: it floats over the top of `.main` and the window controls
// sit at its right edge. The full-page views (Automations / Subagent / Vault)
// each used to spend their own row on a header underneath it, wasting ~50px
// of vertical space and splitting the chrome in two. This renders that same
// header markup INTO the caption instead, so the window frame owns where it
// sits and the view owns what it says.
//
// Two things make that work without moving any state:
//
//   - The view still renders the header. The DOM home changes (a portal),
//     not the owner: AutomationsView keeps its automation counts, VaultView
//     keeps its stats chip, and both keep re-rendering when those change.
//   - No slot means no portal. Rendered on its own (unit tests, a popout
//     with no shell) the header simply stays inline, where it was.
//
// Sizing note: everything portaled in has to fit the caption's 28px content
// box, or the toolbar grows past --toolbar-h and the content below it stops
// clearing the bar. styles/shell.css compacts the three headers for it.

import { useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** The caption's landing pad. App.tsx renders it unconditionally (empty for
 *  the chat view) so the id is always findable by the time a view mounts. */
export const TOOLBAR_SLOT_ID = "relay-toolbar-slot";

function findSlot(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.getElementById(TOOLBAR_SLOT_ID);
}

export function ToolbarHeader({ children }: { children: ReactNode }) {
  // Read at render time: the view is lazy-loaded, so the toolbar is already
  // committed to the document by the time this first runs.
  const [slot, setSlot] = useState<HTMLElement | null>(findSlot);

  // Belt and braces for an eager mount, where the parent may not have
  // committed the slot yet on the first pass. Layout effect, so if it ever
  // does fire the move happens before paint — no visible reflow.
  useLayoutEffect(() => {
    if (!slot) setSlot(findSlot());
  }, [slot]);

  if (!slot) return <>{children}</>;
  return createPortal(children, slot);
}

export default ToolbarHeader;
