// Smooth expand/collapse for disclosure bodies — the in-chat counterpart of
// the tool panel / sidebar slide. Same two-directional feel as those panels:
// the wrapper stays mounted across the toggle and CSS animates the height
// (grid-template-rows 0fr→1fr, no measuring), with opacity riding along.
//
// Children unmount AFTER the closing transition finishes (unlike the always-
// mounted .git-section-collapse pattern) so heavy bodies — inline diffs with
// thousands of lines — don't linger in the DOM once collapsed.
//
// Pairs with the .smooth-reveal rules in motion.css.
import { useEffect, useRef, useState, type ReactNode } from "react";

/** Must match the transition duration on .smooth-reveal in motion.css. */
const CLOSE_MS = 260;

export function SmoothReveal({
  open,
  children,
  className,
}: {
  open: boolean;
  children: ReactNode;
  /** Extra class on the OUTER wrapper, e.g. to add margins. */
  className?: string;
}) {
  // Two flags, one commit apart on the open path: `mounted` renders the
  // wrapper (with children), `expanded` flips the class that starts the
  // 0fr→1fr transition. Mounting straight into .open would skip the
  // transition entirely — the browser needs one collapsed frame first.
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);
  // Remember having been open so a body that mounts closed (e.g. a finished
  // turn's collapsed process summary) never flashes its content.
  const everOpen = useRef(open);

  useEffect(() => {
    if (open) {
      everOpen.current = true;
      setMounted(true);
      // Double rAF: the first collapsed frame must actually paint before the
      // .open class lands, or the browser coalesces the two states and the
      // transition never plays.
      let raf2 = 0;
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setExpanded(true));
      });
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
      };
    }
    setExpanded(false);
    if (!everOpen.current) return;
    const t = window.setTimeout(() => setMounted(false), CLOSE_MS);
    return () => window.clearTimeout(t);
  }, [open]);

  if (!mounted) return null;
  return (
    <div
      className={`smooth-reveal${expanded ? " open" : ""}${className ? ` ${className}` : ""}`}
      aria-hidden={!open}
    >
      <div className="smooth-reveal-inner">{children}</div>
    </div>
  );
}
