// Root error boundary: catches any render/lifecycle error in the tree below
// it so a crash shows a recoverable full-screen panel instead of a blank
// webview (or a half-painted splash). Deliberately tiny and dependency-free —
// it must never fail itself.
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The boundary itself has no UI surface beyond the panel below — log the
    // stack so devtools/telemetry still see the full picture.
    console.error("[relay] unhandled render error:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        className="flex h-screen w-screen flex-col items-center justify-center gap-3 bg-white p-6 text-center text-gray-900 dark:bg-slate-900 dark:text-slate-100"
      >
        <h1 className="text-base font-semibold">Something went wrong</h1>
        <p className="max-w-md text-xs text-gray-500 dark:text-slate-400">
          Relay hit an unexpected error and can't continue rendering. Reload to
          recover — your sessions are kept.
        </p>
        <button
          className="rounded-md bg-gray-900 px-4 py-1.5 text-xs font-medium text-white hover:bg-gray-700 dark:bg-white dark:text-slate-900 dark:hover:bg-slate-200"
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
        {/* Collapsed by default: the raw message is for bug reports, not the
            first thing a user should read. */}
        <details className="max-w-lg text-left">
          <summary className="cursor-pointer text-xs text-gray-500 dark:text-slate-400">
            Error details
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-gray-100 p-2 text-[11px] text-gray-700 dark:bg-white/10 dark:text-slate-300">
            {error.message}
            {error.stack ? `\n\n${error.stack}` : ""}
          </pre>
        </details>
      </div>
    );
  }
}
