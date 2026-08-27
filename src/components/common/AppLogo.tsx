// Conduit app logo — inline SVG matching the 2026-08 brand (src-tauri/icons/
// "final logo.png"): dark squircle with an orange circuit border, a glowing
// chip carrying the "R" mark, and a rail of module dots. Used where the brand
// stands in for UI chrome (e.g. the collapsed-sidebar restore button).
// Gradient ids are namespaced per instance via useId so multiple logos can
// mount in one document without id collisions.
import { useId } from "react";

export function AppLogo({ size = 20 }: { size?: number }) {
  const uid = useId();
  const bgId = `bg-${uid}`;
  const borderId = `border-${uid}`;
  const chipId = `chip-${uid}`;
  const wireId = `wire-${uid}`;
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={bgId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#241a10" />
          <stop offset="100%" stopColor="#0e0a06" />
        </linearGradient>
        <linearGradient id={borderId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#ffb347" />
          <stop offset="100%" stopColor="#b45309" />
        </linearGradient>
        <linearGradient id={chipId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#3a2a12" />
          <stop offset="100%" stopColor="#120c05" />
        </linearGradient>
        <linearGradient id={wireId} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#f59e0b" />
          <stop offset="100%" stopColor="#b45309" stopOpacity="0.55" />
        </linearGradient>
      </defs>

      {/* dark squircle with the orange circuit border */}
      <rect x="14" y="14" width="484" height="484" rx="116" fill={`url(#${bgId})`} />
      <rect
        x="14"
        y="14"
        width="484"
        height="484"
        rx="116"
        stroke={`url(#${borderId})`}
        strokeWidth="14"
      />

      {/* circuit wires feeding the chip */}
      <g stroke={`url(#${wireId})`} strokeWidth="18" strokeLinecap="round" fill="none">
        <path d="M118 200h96" />
        <path d="M118 256h120" />
        <path d="M118 312h96" />
      </g>

      {/* glowing chip with the R mark */}
      <rect
        x="226"
        y="182"
        width="160"
        height="148"
        rx="26"
        fill={`url(#${chipId})`}
        stroke="#f59e0b"
        strokeWidth="14"
      />
      <text
        x="306"
        y="256"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fontWeight="800"
        fontSize="96"
        fill="#fff"
      >
        R
      </text>

      {/* code glyph */}
      <text
        x="428"
        y="262"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="ui-monospace, monospace"
        fontWeight="700"
        fontSize="72"
        fill="#f59e0b"
      >
        &lt;/&gt;
      </text>
    </svg>
  );
}
