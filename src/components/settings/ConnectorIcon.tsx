// Real brand logos for connector families / individual connectors, drawn as
// inline SVGs (no asset pipeline, no network fetch). Unknown ids return null
// so callers can fall back to the emoji glyph from the connector registry.
import type { ReactNode } from "react";

type Svg = (size: number) => ReactNode;

const GoogleG: Svg = (size) => (
  <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
    <path
      fill="#EA4335"
      d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
    />
    <path
      fill="#4285F4"
      d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
    />
    <path
      fill="#FBBC05"
      d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
    />
    <path
      fill="#34A853"
      d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
    />
  </svg>
);

const Gmail: Svg = (size) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2.5" fill="#EA4335" />
    <path
      d="M5.5 7.5 12 13l6.5-5.5"
      stroke="#fff"
      strokeWidth="2.2"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const Drive: Svg = (size) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12.1 1.9 3.5 15.4l1.7 3.6 8.6-13.5L12.1 1.9z" fill="#0066da" />
    <path d="m13.8 5.5-2.7 5.5 2.7 5.5 2.7-5.5-2.7-5.5z" fill="#00ac47" />
    <path d="M5.2 19 6.9 21.9h13.9l1.7-2.9H5.2z" fill="#ffba00" />
  </svg>
);

const Docs: Svg = (size) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" fill="#4285F4" />
    <path d="M14 2v6h6" fill="#2B7DE9" />
    <rect x="8" y="12" width="8" height="1.6" rx="0.8" fill="#fff" />
    <rect x="8" y="15" width="8" height="1.6" rx="0.8" fill="#fff" />
    <rect x="8" y="18" width="5" height="1.6" rx="0.8" fill="#fff" />
  </svg>
);

const Sheets: Svg = (size) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="2.5" fill="#0F9D58" />
    <path d="M3 9.5h18M3 14.5h18M9.5 3v18M14.5 3v18" stroke="#fff" strokeWidth="1.4" />
  </svg>
);

const Slides: Svg = (size) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path d="M5 2.5h1.6v19H5z" fill="#FBBC04" />
    <path d="M6.6 3.5h11l-3.5 5 3.5 5H6.6v-10z" fill="#FBBC04" />
    <path d="M6.6 3.5h5.5v10H6.6z" fill="#F29900" />
  </svg>
);

const Calendar: Svg = (size) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3" y="4.5" width="18" height="17" rx="2.5" fill="#4285F4" />
    <path d="M3 9.5h18" stroke="#fff" strokeWidth="1.6" />
    <rect x="7" y="2.5" width="2.2" height="4.5" rx="1.1" fill="#4285F4" />
    <rect x="14.8" y="2.5" width="2.2" height="4.5" rx="1.1" fill="#4285F4" />
  </svg>
);

const Chat: Svg = (size) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path
      d="M12 3C6.8 3 2.5 6.5 2.5 10.8c0 2.4 1.4 4.6 3.5 6l-1 3.4 3.9-2c1 .3 2.1.4 3.1.4 5.2 0 9.5-3.5 9.5-7.8S17.2 3 12 3z"
      fill="#00AC47"
    />
  </svg>
);

const People: Svg = (size) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="10" fill="#4285F4" />
    <circle cx="12" cy="9.2" r="3.2" fill="#fff" />
    <path d="M12 13.4c-3.1 0-5.2 1.7-5.2 3.9V19h10.4v-1.7c0-2.2-2.1-3.9-5.2-3.9z" fill="#fff" />
  </svg>
);

const Notion: Svg = (size) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <rect x="2" y="2" width="20" height="20" rx="4.5" fill="#0D0D0D" />
    <path
      d="M8.5 6.5v11M15.5 6.5v11M8.5 6.5l7 11"
      stroke="#fff"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </svg>
);

// Kiwi.com's smiling kiwi bird: round orange-gradient body, long beak
// pointing down-left, smile, and a single dark eye.
const Kiwi: Svg = (size) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12.6" cy="12.6" r="8.2" fill="#F27E00" />
    <circle cx="10" cy="9.4" r="5.2" fill="#FFB42B" />
    <path
      d="M8.6 11.4c.2.5.2 1.1 0 1.6l-3.4 3.9c-.4.4-1.1.2-1.2-.4l-.3-2.5c-.1-1.1.4-2.1 1.3-2.9l3.6-.7z"
      fill="#C14D00"
    />
    <path
      d="M7.1 13.4c.9 1 2.1 1.5 3.4 1.4"
      stroke="#9C3C00"
      strokeWidth="1.2"
      strokeLinecap="round"
      fill="none"
    />
    <circle cx="9.3" cy="8.9" r="1.9" fill="#FFF8EC" />
    <circle cx="9.9" cy="9.2" r="1" fill="#33261C" />
  </svg>
);

// GitHub's octocat silhouette (the official brand mark path) on a white tile
// — GitHub's canonical mark presentation, visible on both app themes.
const GitHub: Svg = (size) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <rect
      x="1"
      y="1"
      width="22"
      height="22"
      rx="5.5"
      fill="#fff"
      stroke="rgba(127,127,127,0.28)"
      strokeWidth="1"
    />
    <g transform="translate(2, 2) scale(0.8333)">
      <path
        fill="#181717"
        d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
      />
    </g>
  </svg>
);

const LOGOS: Record<string, Svg> = {
  gmail: Gmail,
  gdrive: Drive,
  gdocs: Docs,
  gsheets: Sheets,
  gslides: Slides,
  gcalendar: Calendar,
  gchat: Chat,
  gpeople: People,
  notion: Notion,
  kiwi: Kiwi,
  github: GitHub,
};

/** Logo for a single connector product (falls back to null → caller uses the
 *  registry emoji glyph). */
export function ConnectorIcon({ id, size = 28 }: { id: string; size?: number }) {
  const svg = LOGOS[id];
  return svg ? svg(size) : null;
}

/** Logo for a product family card (one per vendor: "google", "notion", ...). */
export function FamilyIcon({ family, size = 28 }: { family: string; size?: number }) {
  if (family === "google") return GoogleG(size);
  if (family === "notion") return Notion(size);
  if (family === "kiwi") return Kiwi(size);
  if (family === "github") return GitHub(size);
  return null;
}

/** Human-readable title for a product family card. */
export const FAMILY_NAMES: Record<string, string> = {
  google: "Google",
  notion: "Notion",
  kiwi: "Kiwi.com",
  github: "GitHub",
};
