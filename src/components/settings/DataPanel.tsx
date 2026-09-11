// Extracted panel of SettingsView (see its header for context).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import {
  deleteDownloadedModel,
  detectGpuPower,
  exportProjectZip,
  getChatDbPath,
  getDataPaths,
  getSetting,
  importChatZip,
  listChatModels,
  listConnectors,
  connectorConnect,
  connectorConnectFamily,
  connectorDisconnect,
  listenOAuthCallback,
  setChatDbDir,
  setChatDefaultModel,
  setSetting,
  toastError,
  toastSuccess,
  type ChatProvider,
  type ConnectorWithStatus,
  type DataPaths,
  type GgufModel,
  type OAuthCallbackPayload,
  type SelectedModelEntry,
} from "../../lib/ipc";
import { runLoginFlow } from "../../lib/sessionLauncher";
import type { HarnessId } from "../../types";
import { useProjectsStore } from "../../state/projects";
import { openOnboarding } from "../../state/onboarding";
import { formatBytes } from "../../lib/format";
import { useChatStore } from "../../state/chat";
import { useArtifactsStore } from "../../state/artifacts";
import { useSettingsStore } from "../../state/settings";
import { useUiStore } from "../../state/ui";
import { GlassSelect } from "../common/GlassSelect";
import { Modal } from "../common/Modal";
import { ToggleSwitch } from "./ToggleSwitch";
import {
  Database,
  Eye,
  EyeOff,
  KeyRound,
  Plug,
  Plus,
  Pencil,
  Trash2,
} from "lucide-react";

export function DataPanel() {
  const [paths, setPaths] = useState<DataPaths | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"chats" | "artifacts" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [selectedProjectForBackup, setSelectedProjectForBackup] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState<"backup" | "restore" | null>(null);
  // Projects expose a native-list selector for "back up project" (export the
  // chats of one project). Sourced from the projects store like the rest of
  // the sidebar.
  const backupProjects = useProjectsStore((s) => s.projects);
  // After restoring, refresh the sidebar's live chat list from the DB.
  const importDone = useCallback(async () => {
    await useChatStore.getState().loadSessions();
  }, []);

  // Store-backed deletes so the sidebar/chat view update immediately —
  // the raw IPC commands alone leave stale in-memory state on screen.
  const deleteAllChats = useChatStore((s) => s.deleteAllChats);
  const clearAllArtifacts = useArtifactsStore((s) => s.clearAll);

  const refresh = () => {
    void getDataPaths().then((p) => p && setPaths(p));
  };
  useEffect(refresh, []);

  const handleBackupProject = async () => {
    if (!selectedProjectForBackup) return;
    setBackupBusy("backup");
    try {
      await exportProjectZip(selectedProjectForBackup);
      setNote("Project chat backup exported.");
    } catch (err) {
      setNote(`Backup failed: ${String(err)}`);
      toastError("Backup failed", err);
    } finally {
      setBackupBusy(null);
    }
  };

  const handleRestore = async () => {
    setBackupBusy("restore");
    try {
      const imported = await importChatZip();
      if (imported && imported.length > 0) {
        await importDone();
        setNote(`Restored ${imported.length} chat session(s).`);
      } else if (imported) {
        setNote("No chats found in that backup.");
      }
      // imported === null → user cancelled; stay quiet.
    } catch (err) {
      setNote(`Restore failed: ${String(err)}`);
      toastError("Restore failed", err);
    } finally {
      setBackupBusy(null);
    }
  };

  const pickDbDir = async () => {
    const picked = await open({
      directory: true,
      title: "Choose where to store chats (database)",
    });
    if (typeof picked !== "string") return;
    setBusy(true);
    try {
      await setChatDbDir(picked);
      setNote(`Chat database moved to ${picked}`);
      refresh();
    } catch (err) {
      setNote(`Failed to move chat database: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const resetDbDir = async () => {
    setBusy(true);
    try {
      await setChatDbDir(null);
      setNote("Chat database moved back to the default location");
      refresh();
    } catch (err) {
      setNote(`Failed to reset chat database: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const pickArtifactsDir = async () => {
    const picked = await open({
      directory: true,
      title: "Choose where to store artifacts",
    });
    if (typeof picked !== "string") return;
    await setSetting("storage.artifactsDir", picked);
    setNote(`Artifacts will be stored in ${picked}`);
    refresh();
  };

  const resetArtifactsDir = async () => {
    await setSetting("storage.artifactsDir", "");
    setNote("Artifacts will be stored in the default location");
    refresh();
  };

  const runDelete = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm === "chats") {
        const n = await deleteAllChats();
        setNote(`Deleted ${n} chat session(s)`);
      } else {
        const n = await clearAllArtifacts();
        setNote(`Deleted ${n} artifact(s)`);
      }
      refresh();
    } catch (err) {
      setNote(`Delete failed: ${String(err)}`);
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  return (
    <div className="settings-form">
      <div className="panel-head">
        <h3>Data</h3>
        <span className="panel-count">Backup · storage · cleanup</span>
      </div>

      {note && <div className="settings-note">{note}</div>}

      {/* Welcome setup replay (PRD §9): the first-run wizard, on demand. */}
      <div className="settings-section">
        <div className="settings-section-title">Welcome</div>
        <p className="settings-section-hint">
          Replay the first-run welcome setup — theme, chat model, and agent harness checks.
        </p>
        <button className="ghost" onClick={openOnboarding}>
          Replay welcome
        </button>
      </div>

      {/* Backup / Restore — roadmap #7 local-first backup story */}
      <div className="settings-section">
        <div className="settings-section-title">Backup</div>
        <p className="settings-section-hint">
          Export a project's chats to a <code>.zip</code>, or restore a previous backup.
          Imported chats are added fresh — nothing is overwritten.
        </p>
        <div className="data-backup-row">
          <select
            value={selectedProjectForBackup ?? ""}
            onChange={(e) => setSelectedProjectForBackup(e.target.value || null)}
          >
            <option value="">Select project…</option>
            {(backupProjects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            className="primary cta-strong"
            onClick={() => void handleBackupProject()}
            disabled={backupBusy !== null || !selectedProjectForBackup}
            title={selectedProjectForBackup ? undefined : "Pick a project first"}
          >
            {backupBusy === "backup" ? "Exporting…" : "Back up"}
          </button>
          <button className="ghost" onClick={() => void handleRestore()} disabled={backupBusy === "restore"}>
            {backupBusy === "restore" ? "Restoring…" : "Restore from backup"}
          </button>
        </div>
      </div>

      {/* Storage locations */}
      <div className="settings-section">
        <div className="settings-section-title">Storage</div>
        <div className="data-path-card">
          <div className="data-path-info">
            <div className="data-path-name">Chats (database)</div>
            <div className="data-path-value mono">
              {paths?.chatDbPath ?? "…"}
              {paths ? ` · ${formatBytes(paths.chatDbSize)}` : ""}
            </div>
          </div>
          <div className="data-path-actions">
            <button className="ghost" onClick={pickDbDir} disabled={busy}>
              Change…
            </button>
            <button className="ghost" onClick={resetDbDir} disabled={busy}>
              Reset
            </button>
          </div>
        </div>
        <div className="data-path-card">
          <div className="data-path-info">
            <div className="data-path-name">Artifacts</div>
            <div className="data-path-value mono">
              {paths?.artifactsDir ?? "…"}
              {paths ? ` · ${formatBytes(paths.artifactsSize)}` : ""}
            </div>
          </div>
          <div className="data-path-actions">
            <button className="ghost" onClick={pickArtifactsDir}>
              Change…
            </button>
            <button className="ghost" onClick={resetArtifactsDir}>
              Reset
            </button>
          </div>
        </div>
      </div>

      {/* Delete */}
      <div className="settings-section">
        <div className="settings-section-title">Danger zone</div>
        <div className="data-danger">
          <span className="data-danger-text">
            Permanently delete all chat sessions or all generated artifacts. This cannot be undone.
          </span>
          <div className="data-danger-actions">
            <button className="danger" onClick={() => setConfirm("chats")} disabled={busy}>
              Delete all chats
            </button>
            <button className="danger" onClick={() => setConfirm("artifacts")} disabled={busy}>
              Delete all artifacts
            </button>
          </div>
        </div>
      </div>

      {confirm && (
        <Modal
          title={confirm === "chats" ? "Delete all chats?" : "Delete all artifacts?"}
          onClose={() => setConfirm(null)}
          actions={
            <>
              <button className="ghost" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button className="danger" onClick={runDelete} disabled={busy}>
                {busy ? "Deleting…" : "Delete"}
              </button>
            </>
          }
        >
          <p>
            {confirm === "chats"
              ? "This permanently deletes every chat session and all of their messages. Generated artifacts are kept."
              : "This permanently deletes every generated artifact (files and diagrams). Chat history is kept."}
          </p>
        </Modal>
      )}
    </div>
  );
}
