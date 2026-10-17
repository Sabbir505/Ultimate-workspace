// ChatView's empty-session welcome screen: time-aware greeting, starter
// prompt chips, and the prompt icons. Extracted from ChatView.tsx (see its
// header for the streaming/markdown context shared by the real transcript).
import { WELCOME_PROMPTS, timeGreeting, WelcomePromptIcon } from "./chatWelcomeShared";

/** Clicking a starter chip: `sendPrompt(title)` when a model is configured,
 *  otherwise the parent prefills the composer so the user picks a model. */
export function ChatWelcome({ sendPrompt, prefill, hasModel, sidechat }: {
  sendPrompt: (text: string) => void;
  prefill: (text: string) => void;
  hasModel: boolean;
  /** Present when this empty chat is a sidechat. The source chat's recent
   *  history rides along as model context but its rows are intentionally not
   *  shown in the pane — without this hint an empty sidechat reads as a bug.
   *  `title` is the source chat's title, or null when it has none/is gone. */
  sidechat?: { title: string | null } | null;
}) {
  return (
    <div className="chat-welcome">
      <div className="chat-welcome-inner">
        <div className="chat-welcome-greeting">{sidechat ? "Side chat" : timeGreeting().hi}</div>
        <div className="chat-welcome-question">
          {sidechat ? (
            <>
              Continues {sidechat.title ? `“${sidechat.title}”` : "another chat"} — its recent
              messages are already in context, but they aren&apos;t shown here. Ask your question
              below.
            </>
          ) : (
            timeGreeting().ask
          )}
        </div>
        <div className="chat-welcome-prompts">
          {WELCOME_PROMPTS.map((p, i) => (
            <button
              key={p.title}
              type="button"
              className="chat-welcome-prompt"
              style={{ animationDelay: `${i * 45}ms` }}
              onClick={() => {
                // Chips send immediately. Without any model (session model
                // or provider default from Settings) the send would fail,
                // so fall back to prefilling the composer — the user picks
                // a model, then hits send.
                if (hasModel) {
                  sendPrompt(p.title);
                } else {
                  prefill(p.title);
                }
              }}
            >
              <span className="chat-welcome-prompt-icon">
                <WelcomePromptIcon kind={p.icon} />
              </span>
              <span className="chat-welcome-prompt-text">
                <span className="chat-welcome-prompt-title">{p.title}</span>
                <span className="chat-welcome-prompt-sub">{p.sub}</span>
              </span>
              <svg
                className="chat-welcome-prompt-arrow"
                width={14}
                height={14}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
