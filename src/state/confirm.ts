// In-app confirmation prompts (promise-based).
//
// Why not `window.confirm`: in this Tauri build the webview shim routes
// `window.confirm` through `plugin:dialog|confirm`, but the capability set
// (`dialog:default`) does not grant `allow-confirm` — the call rejects with
// "dialog.confirm not allowed. Command not found" and, because a rejected
// Promise is still truthy, every `if (window.confirm(...))` guard PASSED
// silently. Users were never asked before an automation/theme/MCP/knowledge/
// vault delete (found by the desktop E2E suite, 2026-10-07).
//
// This module replaces those guarded sites with an in-app modal that is
// consistent with the rest of the app's confirmations (see common/Modal),
// fully obvious in its outcome, and automatable by tests.

import { create } from "zustand";

export interface ConfirmRequest {
  title: string;
  body: string;
  /** Confirm-button label (default "Delete"). */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive (red). */
  danger?: boolean;
}

interface PendingConfirm extends ConfirmRequest {
  resolve: (ok: boolean) => void;
}

interface ConfirmState {
  current: PendingConfirm | null;
  confirm: (req: PendingConfirm) => void;
  settle: (ok: boolean) => void;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  current: null,
  confirm: (req) => {
    // A second prompt while one is open resolves the first as "no" — a
    // prompt must never be silently orphaned.
    const prev = get().current;
    if (prev) prev.resolve(false);
    set({ current: req });
  },
  settle: (ok) => {
    const current = get().current;
    if (!current) return;
    set({ current: null });
    current.resolve(ok);
  },
}));

/** Show an in-app confirm and resolve with the user's choice. */
export function confirmDialog(req: ConfirmRequest): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    useConfirmStore.getState().confirm({ ...req, resolve });
  });
}
