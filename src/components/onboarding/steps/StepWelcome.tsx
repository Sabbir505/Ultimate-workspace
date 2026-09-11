// Step 1 of the welcome wizard: product intro + theme choice. The theme
// applies immediately via the settings store (same store Settings →
// Appearance writes), so the choice is live-previewed behind the wizard.
import { AppLogo } from "../../common/AppLogo";
import { useSettingsStore, type ThemeSetting } from "../../../state/settings";

const THEME_OPTIONS: Array<{ id: ThemeSetting; label: string }> = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

const FEATURES = [
  {
    icon: (
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <line x1="15" y1="4" x2="15" y2="20" />
      </svg>
    ),
    title: "Agent panes",
    text: "Run up to 6 CLI agents — Claude Code, OpenCode, Pi and more — side by side.",
  },
  {
    icon: (
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      </svg>
    ),
    title: "Built-in chat",
    text: "Cloud APIs or local GGUF models, without leaving the app.",
  },
  {
    icon: (
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="4" y="10" width="16" height="10" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </svg>
    ),
    title: "Local-first by design",
    text: "Keys live in your OS keychain, data in a local database. No account needed.",
  },
];

export function StepWelcome() {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);

  return (
    <div className="onboarding-step onboarding-step-center">
      <div className="onboarding-mark" aria-hidden="true">
        <AppLogo size={30} />
      </div>
      <h2 className="onboarding-title">Welcome to Relay</h2>
      <p className="onboarding-sub">
        A local-first home for the AI coding agents you already use — plus a built-in chat,
        git tools, and local models.
      </p>

      <div className="onboarding-features">
        {FEATURES.map((f) => (
          <div className="onboarding-feature" key={f.title}>
            <span className="onboarding-feature-icon" aria-hidden="true">{f.icon}</span>
            <div className="onboarding-feature-copy">
              <span className="onboarding-feature-title">{f.title}</span>
              <span className="onboarding-feature-text">{f.text}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="onboarding-theme-row">
        <div className="onboarding-themes" role="radiogroup" aria-label="Theme">
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={theme === opt.id}
              className={`onboarding-theme-swatch${theme === opt.id ? " active" : ""}`}
              onClick={() => setTheme(opt.id)}
            >
              <span className={`onboarding-swatch onboarding-swatch-${opt.id}`} aria-hidden="true">
                <span className="onboarding-swatch-bar" />
                <span className="onboarding-swatch-bar short" />
              </span>
              <span className="onboarding-swatch-label">{opt.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
