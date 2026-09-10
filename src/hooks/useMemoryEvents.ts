// Memory pipeline events → notification center. The extraction/document
// machinery runs in the background (often for chats the user isn't looking
// at), so a merge that lands is recorded in the bell panel — "Memory updated
// (1 added, 2 updated)" — with a jump straight to the Memory settings.
// Quiet by design: in-app toast only, never an OS toast or chime.
import { listenMemoryUpdated, type MemoryUpdatedPayload } from "../lib/ipc";
import { relayNotify } from "../lib/notifyCenter";
import { useEventSubscription } from "./useTauriEvent";

export function useMemoryEvents(): void {
  useEventSubscription<MemoryUpdatedPayload>(listenMemoryUpdated, (payload) => {
    const { summary, chatSessionId, trimmed } = payload;
    relayNotify({
      kind: "alert",
      title: "Memory updated",
      body: trimmed
        ? `${summary} — document trimmed to fit the injection budget`
        : summary,
      chatSessionId: chatSessionId ?? undefined,
      view: "settings",
      inAppToast: true,
    });
  }, []);
}
