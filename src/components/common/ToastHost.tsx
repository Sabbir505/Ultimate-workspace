// Toast notifications: a fixed bottom-right stack fed by ui store `toasts`.
// This is the app's global error surface — IPC failures that used to die in
// console.warn (git push, downloads, connector calls, …) become visible here.
// Errors use role="alert" (assertive), info/success role="status" (polite).
import { useUiStore, type Toast } from "../../state/ui";

const ICONS: Record<Toast["kind"], string> = { error: "⚠", info: "ℹ", success: "✓" };

export function ToastHost() {
  const toasts = useUiStore((s) => s.toasts);
  const dismissToast = useUiStore((s) => s.dismissToast);
  if (toasts.length === 0) return null;
  return (
    <div className="toast-host">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.kind}`}
          role={t.kind === "error" ? "alert" : "status"}
        >
          <span className="toast-icon" aria-hidden="true">
            {ICONS[t.kind]}
          </span>
          <div className="toast-body">
            <div className="toast-message">{t.message}</div>
            {t.detail && <div className="toast-detail">{t.detail}</div>}
          </div>
          <button
            className="ghost toast-close"
            title="Dismiss"
            aria-label="Dismiss notification"
            onClick={() => dismissToast(t.id)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
