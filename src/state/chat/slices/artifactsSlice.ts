// Artifacts slice: per-session artifact tracking, the proposal cards, and
// the auto-open behavior for viewable deliverables.
import { useUiStore } from "../../ui";
import {
  AUTO_OPEN_ARTIFACT_EXTS,
  MAX_ARTIFACTS_PER_SESSION,
  scheduleArtifactLibraryLoad,
  selectContextSessionId,
} from "../moduleState";
import type { ArtifactProposal } from "../../../lib/ipc";
import type { ChatArtifact } from "../types";
import type { ChatStoreGet, ChatStoreSet } from "../types";

export function createArtifactsSlice(set: ChatStoreSet, get: ChatStoreGet) {
  return {
    setPreviewArtifact: (artifact: ChatArtifact | null) => {
      // Every artifact preview opens as its own named tab in the tool panel
      // (the Canvas tab is gone). openArtifactTab dedupes by path and expands
      // the panel; null is a no-op kept for call-site compatibility.
      if (!artifact) return;
      useUiStore.getState().openArtifactTab({
        path: artifact.path,
        filename: artifact.filename,
        inline: artifact.inline,
      });
    },

    addArtifactProposal: (chatSessionId: string, proposal: ArtifactProposal) =>
      set((s) => ({
        artifactProposals: {
          ...s.artifactProposals,
          [chatSessionId]: [
            ...(s.artifactProposals[chatSessionId] ?? []),
            { id: proposal.id, proposal, state: "generating" as const },
          ],
        },
      })),

    updateArtifactProposal: (chatSessionId: string, proposalId: string, updates: Partial<{ proposal: ArtifactProposal; state: "generating" | "ready" | "editing" | "created" | "rejected" }>) => {
        // If the proposal was replaced, update the wrapper ID to match
        // so subsequent handlers find the correct entry by the same ID.
        // This stabilizes the ID across regenerations and prevents
        // "handler finds nothing" bugs when backend returns a new proposal.id.
        return set((s) => {
          const proposals = s.artifactProposals[chatSessionId] ?? [];
          let idx = proposals.findIndex((p) => p.id === proposalId);
          // If not found by wrapper ID, try finding by proposal.id (backend ID)
          const replacementProposal = updates.proposal;
          if (idx < 0 && replacementProposal) {
            idx = proposals.findIndex((p) => p.proposal.id === replacementProposal.id);
          }
          if (idx < 0) return s;
          const oldEntry = proposals[idx];
          let updated: typeof oldEntry;
          if (updates.proposal) {
            // Proposal was replaced — keep the old wrapper.id stable (it is the card's action key),
            // only swap the proposal.payload. This ensures the card's `proposalId` prop still
            // matches the wrapper ID, and all handlers work correctly.
            updated = {
              id: oldEntry.id, // stable wrapper ID (card's action key)
              proposal: updates.proposal,
              state: updates.state ?? oldEntry.state,
            };
          } else {
            updated = { ...oldEntry, ...updates };
          }
          return {
            artifactProposals: {
              ...s.artifactProposals,
              [chatSessionId]: [
                ...proposals.slice(0, idx),
                updated,
                ...proposals.slice(idx + 1),
              ],
            },
          };
        });
      },

    removeArtifactProposal: (chatSessionId: string, proposalId: string) =>
      set((s) => {
        const proposals = s.artifactProposals[chatSessionId] ?? [];
        const filtered = proposals.filter((p) => p.id !== proposalId);
        if (filtered.length === proposals.length) return s;
        return {
          artifactProposals: {
            ...s.artifactProposals,
            [chatSessionId]: filtered,
          },
        };
      }),

    getArtifactProposals: (chatSessionId: string) => {
      return get().artifactProposals[chatSessionId] ?? [];
    },

    editArtifactProposal: (chatSessionId: string, proposalId: string, proposal: ArtifactProposal) => {
      const { artifactType, spec } = proposal;
      const ui = useUiStore.getState();
      // Set the pending form data that SkillsLibrary/AutomationsView will read on mount.
      // Carry the session/proposal IDs so the editor can reset the card's `editing`
      // state back to `ready` after consuming the data — otherwise the card stays
      // stuck on "Opening in editor…" when the user navigates back to chat.
      ui.setPendingArtifactFormData({ artifactType, spec, chatSessionId, proposalId });
      // Update proposal state
      set((s) => ({
        artifactProposals: {
          ...s.artifactProposals,
          [chatSessionId]: (s.artifactProposals[chatSessionId] ?? []).map((p) =>
            p.id === proposalId ? { ...p, state: "editing" as const } : p
          ),
        },
      }));
      // Navigate to the appropriate editor
      switch (artifactType) {
        case "skill":
        case "loop":
          ui.setActiveView("skills");
          break;
        case "prompt_template":
          ui.setActiveView("skills");
          break;
        case "automation":
          ui.setActiveView("automations");
          break;
      }
    },

    onArtifact: ({ chatSessionId, path, filename }: { chatSessionId: string; path: string; filename: string }) => {
      const artifact = { path, filename };
      const ext = filename.split(".").pop()?.toLowerCase();
      // Track the artifact regardless of where it opens.
      set((s) => {
        const existing = s.artifacts[chatSessionId] ?? [];
        const alreadyTracked = existing.some((a) => a.path === path);
        const pending = s.pendingArtifacts[chatSessionId] ?? [];
        const pendingTracked = pending.some((a) => a.path === path);
        // P-3: cap per-session growth. The map used to grow unbounded for the
        // life of the app (entries left only on session delete); the newest
        // MAX_ARTIFACTS_PER_SESSION artifacts are kept — oldest dropped. Files
        // on disk are untouched; this is only the session's tracking list.
        const capped = alreadyTracked
          ? s.artifacts
          : {
              ...s.artifacts,
              [chatSessionId]: [...existing, artifact].slice(
                -MAX_ARTIFACTS_PER_SESSION,
              ),
            };
        return {
          artifacts: capped,
          pendingArtifacts: pendingTracked
            ? s.pendingArtifacts
            : { ...s.pendingArtifacts, [chatSessionId]: [...pending, artifact] },
        };
      });
      // Debounced: a turn writing N artifacts fires N events but only one
      // library reload (see scheduleArtifactLibraryLoad above).
      scheduleArtifactLibraryLoad();

      // SVG renders inline in the chat bubble — no pane, no browser.
      if (ext === "svg") return;

      // Only viewable deliverables (images/pdf/office/csv) open as their own
      // top-level tab in the right-side tool panel. Source-code writes
      // (html/tsx/jsx/…) stay in the Artifacts gallery; the agent opens them
      // deliberately via `open_file` when the user actually needs to see one.
      if (!AUTO_OPEN_ARTIFACT_EXTS.has(ext ?? "")) return;

      // Images, pdf, csv, office docs render in ArtifactPreviewPane, with the
      // filename as the tab label.
      //
      // Cross-session gate: the tool panel is ONE shared surface, so auto-open
      // only when the PRODUCING session is the one whose context the shared UI
      // displays (focused split pane, else the active session). A screenshot
      // from a background pane must not yank the panel while the user works in
      // another session — the file is still tracked above, and it still shows
      // on the producing bubble and in the Artifacts gallery.
      if (selectContextSessionId(get()) !== chatSessionId) return;
      const ui = useUiStore.getState();
      ui.openArtifactTab({ path, filename });
      ui.setToolPanelCollapsed(false);
    },
  };
}
