// Shared tab strip for the vault's two independent panes — the note pane's
// `openNotes` and the asset pane's `openAssets`.
//
// Extracted from the note strip so both surfaces get identical behaviour
// rather than a second, drifting copy: click activates, ✕ (or middle-click)
// closes just that tab, the wheel scrolls an overflowing strip, and dragging
// a tab reorders it. The STORE owns ordering and the active-tab neighbor
// handoff; this component only reports intent.
import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

export function VaultTabStrip({
  tabs,
  active,
  ariaLabel,
  labelFor,
  titleFor,
  onSelect,
  onClose,
  onReorder,
}: {
  tabs: string[];
  active: string | null;
  ariaLabel: string;
  /** Display text for a tab (stem of the filename, usually). */
  labelFor: (path: string) => string;
  /** Tooltip for a tab — the full path, for the truncated case. */
  titleFor?: (path: string) => string;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onReorder: (path: string, toIndex: number) => void;
}) {
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const [scrollable, setScrollable] = useState(false);
  const dragIndexRef = useRef<number | null>(null);
  const dragOverRef = useRef<number | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // Overflowed strips get edge-fade + wheel scrolling; re-check on resize.
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const check = () => setScrollable(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabs.length]);

  // Keep the active tab in view when it changes (or when the strip resizes).
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const tab = el.querySelector<HTMLElement>('.vault-note-tab[aria-selected="true"]');
    if (!tab) return;
    if (tab.offsetLeft < el.scrollLeft) {
      el.scrollLeft = tab.offsetLeft;
    } else if (tab.offsetLeft + tab.offsetWidth > el.scrollLeft + el.clientWidth) {
      el.scrollLeft = tab.offsetLeft + tab.offsetWidth - el.clientWidth;
    }
  }, [active, tabs.length]);

  const onTabMouseDown = useCallback(
    (index: number, e: React.MouseEvent) => {
      // Don't start a drag from the close button.
      if ((e.target as HTMLElement).closest(".vault-note-tab-close")) return;
      e.preventDefault();
      dragIndexRef.current = index;
      setDragIndex(index);
      setDragOverIndex(index);
      const handleMove = (ev: MouseEvent) => {
        const el = document.elementFromPoint(ev.clientX, ev.clientY);
        const tab = el?.closest(".vault-note-tab") as HTMLElement | null;
        if (!tab) return;
        const newIndex = Number(tab.dataset.index);
        if (!Number.isNaN(newIndex) && newIndex !== dragOverRef.current) {
          dragOverRef.current = newIndex;
          setDragOverIndex(newIndex);
        }
      };
      const handleUp = () => {
        const from = dragIndexRef.current;
        const to = dragOverRef.current;
        if (from !== null && to !== null && from !== to) {
          const path = tabs[from];
          if (path) onReorder(path, to);
        }
        dragIndexRef.current = null;
        dragOverRef.current = null;
        setDragIndex(null);
        setDragOverIndex(null);
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
      };
      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
    },
    [tabs, onReorder],
  );

  if (tabs.length === 0) return null;

  return (
    <div
      className={`vault-note-tabs${scrollable ? " scrollable" : ""}`}
      role="tablist"
      aria-label={ariaLabel}
      ref={tabsRef}
      onWheel={(e) => {
        // Vertical wheel scrolls an overflowing strip horizontally.
        if (!scrollable) return;
        if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
        e.preventDefault();
        tabsRef.current?.scrollBy({ left: e.deltaY });
      }}
    >
      {tabs.map((p, index) => (
        <div
          key={p}
          role="tab"
          aria-selected={p === active}
          className={`vault-note-tab${p === active ? " active" : ""}${index === dragIndex ? " dragging" : ""}${index === dragOverIndex && dragIndex !== index ? " drag-over" : ""}`}
          title={titleFor ? titleFor(p) : p}
          data-index={index}
          onClick={() => onSelect(p)}
          onMouseDown={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              onClose(p);
              return;
            }
            onTabMouseDown(index, e);
          }}
        >
          <span className="vault-note-tab-name">{labelFor(p)}</span>
          <button
            className="vault-note-tab-close"
            title="Close tab"
            onClick={(e) => {
              e.stopPropagation();
              onClose(p);
            }}
          >
            <X size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}
