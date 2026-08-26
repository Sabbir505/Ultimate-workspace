// Conduit app logo — a React rendering of src-tauri/icons/conduit-logo.svg
// (dark squircle + concentric tunnel rings + glow core). Used where the brand
// needs to stand in for UI chrome, e.g. the collapsed-sidebar restore button.
// Gradient ids are namespaced per instance via useId so multiple logos can
// mount in one document without id collisions.
import { useId } from "react";

export function AppLogo({ size = 20 }: { size?: number }) {
  const uid = useId();
  const bgId = `bg-${uid}`;
  const ring1Id = `ring1-${uid}`;
  const ring2Id = `ring2-${uid}`;
  const ring3Id = `ring3-${uid}`;
  const coreId = `core-${uid}`;
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={bgId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#0B0B12" />
          <stop offset="100%" stopColor="#08080C" />
        </linearGradient>
        <linearGradient id={ring1Id} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#00D4AA" />
          <stop offset="100%" stopColor="#00D4AA" stopOpacity="0.35" />
        </linearGradient>
        <linearGradient id={ring2Id} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#3FDFC0" />
          <stop offset="100%" stopColor="#7C6FF7" stopOpacity="0.55" />
        </linearGradient>
        <linearGradient id={ring3Id} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#9C90FF" />
          <stop offset="100%" stopColor="#7C6FF7" />
        </linearGradient>
        <radialGradient id={coreId} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#EDEBFF" />
          <stop offset="55%" stopColor="#7C6FF7" />
          <stop offset="100%" stopColor="#7C6FF7" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* squircle background */}
      <rect x="0" y="0" width="512" height="512" rx="112" fill={`url(#${bgId})`} />

      {/* concentric tunnel rings, open arc for directional/flow feel */}
      <g transform="rotate(-45 256 256)">
        <circle cx="256" cy="256" r="176" fill="none" stroke={`url(#${ring1Id})`} strokeWidth="26" strokeLinecap="round" strokeDasharray="740 828" />
        <circle cx="256" cy="256" r="130" fill="none" stroke={`url(#${ring2Id})`} strokeWidth="30" strokeLinecap="round" strokeDasharray="545 817" />
        <circle cx="256" cy="256" r="84" fill="none" stroke={`url(#${ring3Id})`} strokeWidth="36" strokeLinecap="round" strokeDasharray="352 528" />
      </g>

      {/* vanishing point / core */}
      <circle cx="256" cy="256" r="42" fill={`url(#${coreId})`} />
      <circle cx="256" cy="256" r="10" fill="#F5F3FF" />
    </svg>
  );
}
