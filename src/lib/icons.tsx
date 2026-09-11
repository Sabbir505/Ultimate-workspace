// Transport + speaker glyphs for read-aloud.
//
// These live outside the chat components because both the per-message action bar
// (components/chat/ActivitySteps) and the player bar (components/chat/
// TtsPlayerBar) need them, and the player bar renders from the app shell — if it
// imported ActivitySteps for four small SVGs, react-markdown/katex/highlight.js
// would land in the entry chunk instead of their lazy chunk.
//
// `iconProps` is re-exported to match ActivitySteps' other action icons rather
// than re-styled here (same 15px stroke grid).
export const iconProps = {
  width: 15,
  height: 15,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/** Read-aloud: a speaker with sound waves. */
export function SpeakerIcon() {
  return (
    <svg {...iconProps} aria-hidden="true">
      <path d="M11 5 6 9H2v6h4l5 4V5Z" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  );
}

/** Stop: a filled square, the transport convention. */
export function StopIcon() {
  return (
    <svg {...iconProps} aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function PauseIcon() {
  return (
    <svg {...iconProps} aria-hidden="true">
      <path d="M9 4v16" />
      <path d="M15 4v16" />
    </svg>
  );
}

export function PlayIcon() {
  return (
    <svg {...iconProps} aria-hidden="true">
      <path d="M7 4v16l13-8Z" />
    </svg>
  );
}

/** Previous / next sentence — a triangle against a stop bar. */
export function PrevIcon() {
  return (
    <svg {...iconProps} aria-hidden="true">
      <path d="M18 5v14L8 12Z" />
      <path d="M6 5v14" />
    </svg>
  );
}

export function NextIcon() {
  return (
    <svg {...iconProps} aria-hidden="true">
      <path d="M6 5v14l10-7Z" />
      <path d="M18 5v14" />
    </svg>
  );
}
