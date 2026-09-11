// Welcome-screen constants and helpers shared by ChatWelcome.tsx (the
// rendered empty-session screen).

/** Starter prompts shown on the welcome screen for a fresh, empty
 *  conversation. Clicking one sends it immediately. */
export const WELCOME_PROMPTS: Array<{ title: string; sub: string; icon: "doc" | "concept" | "code" | "research" }> = [
  { title: "Write a document", sub: "Draft a brief, memo, or report", icon: "doc" },
  { title: "Explain a concept", sub: "Get a clear breakdown of any topic", icon: "concept" },
  { title: "Write code", sub: "Build a script, fix a bug, or refactor", icon: "code" },
  { title: "Research a topic", sub: "Gather and synthesize sources", icon: "research" },
];

/** Time-aware greeting — the welcome screen reads like it knows what part of
 *  your day it is instead of a static "Good to see you". */
export function timeGreeting(): { hi: string; ask: string } {
  const h = new Date().getHours();
  if (h < 5) return { hi: "Still up?", ask: "Let's get this done." };
  if (h < 12) return { hi: "Good morning", ask: "What should we get done today?" };
  if (h < 18) return { hi: "Good afternoon", ask: "What are we working on?" };
  return { hi: "Good evening", ask: "How can I help you tonight?" };
}

export function WelcomePromptIcon({ kind }: { kind: "doc" | "concept" | "code" | "research" }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };
  switch (kind) {
    case "doc":
      return (
        <svg {...common}>
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="8" y1="13" x2="16" y2="13" />
          <line x1="8" y1="17" x2="13" y2="17" />
        </svg>
      );
    case "concept":
      return (
        <svg {...common}>
          <path d="M9 18h6" />
          <path d="M10 21h4" />
          <path d="M12 3a6 6 0 0 0-4 10.5c.8.7 1 1.5 1 2.5h6c0-1 .2-1.8 1-2.5A6 6 0 0 0 12 3z" />
        </svg>
      );
    case "code":
      return (
        <svg {...common}>
          <polyline points="8 6 3 12 8 18" />
          <polyline points="16 6 21 12 16 18" />
          <line x1="13.5" y1="4" x2="10.5" y2="20" />
        </svg>
      );
    case "research":
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.5" y2="16.5" />
          <line x1="11" y1="8" x2="11" y2="14" />
          <line x1="8" y1="11" x2="14" y2="11" />
        </svg>
      );
  }
}
