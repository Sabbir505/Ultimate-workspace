// Panel-toggle glyph: a rounded rectangle with a vertical divider near one
// edge — the app's single "show/hide a panel" icon. `side` places the
// divider on the matching edge (left = sidebar glyph; right = the title
// bar's side-panel split, also used by the vault's note-rail toggle) so
// every panel affordance shares one consistent icon.
export function PanelIcon({ size = 16, side = "left" }: { size?: number; side?: "left" | "right" }) {
  const x = side === "right" ? 15 : 9;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1={x} y1="3" x2={x} y2="21" />
    </svg>
  );
}
