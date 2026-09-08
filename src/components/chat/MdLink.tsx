/**
 * MdLink — the shared markdown anchor override: http(s) links open in the
 * built-in browser pane (back/forward arrows, tabs, session continuity)
 * instead of a new OS browser window, which is what Tauri does with an
 * un-intercepted `target="_blank"`.
 *
 * The chat bubble and the artifact preview had this logic inline; every other
 * markdown surface that renders agent output (ToolPanel tool results, the
 * SubagentPanel transcript, DevDiffPanel reviews, PlanProposalCard) kept the
 * default anchors — so a link from a subagent or a tool result popped a full
 * external window with no way back. Panels spread `mdLinkComponents` into
 * their ReactMarkdown `components` prop to get the pane routing.
 */

import type { ReactNode } from "react";
import { openInBrowserPane } from "../../lib/openBrowserPane";

export function MdLink({ href, children }: { href?: string; children?: ReactNode }) {
  const isHttp = !!href && /^https?:\/\//i.test(href);
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="chat-md-link"
      // No `title` attribute: the native tooltip is OS-positioned and paints
      // over the surrounding text (see the chat bubble's anchor, same reason).
      onClick={
        isHttp
          ? (e) => {
              e.preventDefault();
              openInBrowserPane(href!);
            }
          : undefined
      }
    >
      {children}
    </a>
  );
}

/** Spread into ReactMarkdown's `components` on every surface that renders
 *  agent-authored markdown but doesn't need the citation-chip pipeline. */
export const mdLinkComponents = { a: MdLink };
