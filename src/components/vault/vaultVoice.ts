// Vault voice — read-aloud and dictation for note documents.
//
// Both ride the engines that already serve the chat composer
// (lib/tts.ts and lib/voiceDictationCore.ts); this file is only the vault's
// adapter layer: which document is "current", how a text span maps onto the
// live CodeMirror view, and what to do when the note changes underneath an
// in-flight operation.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { toggleReadAloud, ttsPlayer } from "../../lib/tts";
import { useTtsStore } from "../../state/tts";
import { useVaultStore } from "../../state/vault";
import { useVoiceDictationCore, type DictationTarget } from "../../lib/voiceDictationCore";

/** Read-aloud keys are namespaced by source, exactly like the chat's
 *  `msg:` and the artifact pane's `artifact:`. `vault:<path>` is a whole
 *  note; `vault:<path>#sel` is the selection read of that same note. */
export const VAULT_TTS_PREFIX = "vault:";

/** The note a TTS key belongs to, or null for keys from another surface. */
export function vaultTtsNote(key: string | null): string | null {
  if (!key || !key.startsWith(VAULT_TTS_PREFIX)) return null;
  return key.slice(VAULT_TTS_PREFIX.length).split("#")[0];
}

export function vaultTtsKey(path: string, selection = false): string {
  return `${VAULT_TTS_PREFIX}${path}${selection ? "#sel" : ""}`;
}

/** The live CodeMirror view for the active note, or null in preview mode
 *  and while a note is still loading. */
export type VaultEditorHandle = { current: EditorView | null };

/** A CodeMirror-backed dictation target.
 *
 *  Dispatching on the view is all that's needed: the editor's existing
 *  updateListener turns each transaction into `onChange`/`onEdit`, so dictated
 *  text reaches the vault store and the debounced autosave through the same
 *  path as a keystroke — and CodeMirror's history() makes the whole dictation
 *  a single undo step. Document positions ARE character offsets, so the
 *  engine's span numbers need no translation.
 */
export function createVaultDictationTarget(getView: () => EditorView | null): DictationTarget {
  return {
    read: () => getView()?.state.doc.toString() ?? "",
    write(from, to, text) {
      const view = getView();
      if (!view) return { from: 0, to: 0 };
      // Clamp against the LIVE length: the note may have been edited or
      // reloaded since the span was captured.
      const len = view.state.doc.length;
      const f = Math.max(0, Math.min(from, len));
      const t = Math.max(f, Math.min(to, len));
      view.dispatch({ changes: { from: f, to: t, insert: text } });
      return { from: f, to: f + text.length };
    },
    setCaret(pos) {
      const view = getView();
      if (!view) return;
      const p = Math.max(0, Math.min(pos, view.state.doc.length));
      view.dispatch({ selection: { anchor: p } });
    },
    focus() {
      getView()?.focus();
    },
    isFocused() {
      return getView()?.hasFocus ?? false;
    },
  };
}

/** The current selection's text, or null when there is no editor or the
 *  selection is empty (a bare caret is not something to read aloud). */
export function readVaultSelection(view: EditorView | null): string | null {
  if (!view) return null;
  const { from, to, empty } = view.state.selection.main;
  if (empty) return null;
  const text = view.state.sliceDoc(from, to);
  return text.trim() ? text : null;
}

/** Short display name for the transport bar — the file name, not the path. */
function noteLabel(path: string): string {
  const base = path.split(/[\\/]/).pop() || path;
  return base.replace(/\.md$/i, "");
}

/** Fired by the command palette and the keyboard shortcut, which live outside
 *  the React tree that owns the dictation engine. VaultView listens and calls
 *  the engine's toggle. Same escape-hatch idiom as `vault:insert-text`. */
export const VAULT_TOGGLE_DICTATION = "vault:toggle-dictation";

/** Read (or stop reading) the active note aloud, from anywhere. `toggleReadAloud`
 *  stops when the same key is already playing, so this doubles as the toggle. */
export function readVaultNoteAloud(): void {
  const v = useVaultStore.getState();
  if (!v.activePath) return;
  toggleReadAloud({
    key: vaultTtsKey(v.activePath),
    label: noteLabel(v.activePath),
    text: v.content,
  });
}

/** Ask the mounted editor to start/stop dictation. */
export function toggleVaultDictation(): void {
  window.dispatchEvent(new CustomEvent(VAULT_TOGGLE_DICTATION));
}

export interface VaultReadAloud {
  /** Whole-note key for the active note, or null when none is open. */
  noteKey: string | null;
  /** Whether a whole-note read of the active note is in progress. */
  readingNote: boolean;
  /** Whether a selection read is in progress. */
  readingSelection: boolean;
  /** True when the editor is mounted and something is selected. */
  hasSelection: boolean;
  readNote: () => void;
  readSelection: () => void;
  /** Stop whichever vault read is running. */
  stop: () => void;
}

export function useVaultReadAloud(editorViewRef: VaultEditorHandle): VaultReadAloud {
  const activePath = useVaultStore((s) => s.activePath);
  const content = useVaultStore((s) => s.content);
  const mode = useVaultStore((s) => s.mode);
  const noteKey = activePath ? vaultTtsKey(activePath) : null;
  const selKey = activePath ? vaultTtsKey(activePath, true) : null;
  const speakingKey = useTtsStore((s) => s.key);
  const phase = useTtsStore((s) => s.phase);
  const speaking = phase !== "idle" && speakingKey != null;

  // Re-render whenever the editor's selection changes so the read-selection
  // button enables/disables. The editor has no selection store of its own, so
  // this samples the live view on a short interval while a note is open in
  // edit mode — cheap, and it stops as soon as the editor isn't there.
  const hasSelection = useSelectionPoll(editorViewRef, mode, activePath);

  // A read must not outlive its note: switching tabs, opening another note or
  // closing the vault leaves a transport bar narrating text the user can no
  // longer see. Scoped to vault keys, so chat/artifact reads are untouched.
  useEffect(() => {
    const tts = useTtsStore.getState();
    const note = vaultTtsNote(tts.key);
    if (note && note !== activePath) ttsPlayer.stop();
  }, [activePath]);

  const readNote = useCallback(() => {
    if (!activePath) return;
    toggleReadAloud({ key: noteKey!, label: noteLabel(activePath), text: content });
  }, [activePath, content, noteKey]);

  const readSelection = useCallback(() => {
    if (!activePath) return;
    const text = readVaultSelection(editorViewRef.current);
    if (!text) return;
    toggleReadAloud({ key: selKey!, label: `${noteLabel(activePath)} (selection)`, text });
  }, [activePath, editorViewRef, selKey]);

  const stop = useCallback(() => ttsPlayer.stop(), []);

  return {
    noteKey,
    // Guard on noteKey: with no note open both keys are null, and a
    // null===null match would light the button for a read that isn't ours.
    readingNote: !!noteKey && speaking && speakingKey === noteKey,
    readingSelection: !!selKey && speaking && speakingKey === selKey,
    hasSelection,
    readNote,
    readSelection,
    stop,
  };
}

/** Sample `readVaultSelection` on an interval so the header button reflects
 *  the live selection. Returns false whenever no editor is mounted. */
function useSelectionPoll(
  editorViewRef: VaultEditorHandle,
  mode: string,
  activePath: string | null,
): boolean {
  const [hasSelection, setHasSelection] = useState(false);
  useEffect(() => {
    if (mode !== "edit" || !activePath) {
      setHasSelection(false);
      return;
    }
    const poll = () => setHasSelection(readVaultSelection(editorViewRef.current) != null);
    poll();
    const id = window.setInterval(poll, 250);
    return () => window.clearInterval(id);
  }, [editorViewRef, mode, activePath]);
  return hasSelection;
}

export interface VaultDictation {
  recording: boolean;
  transcribing: boolean;
  waveBarsRef: React.MutableRefObject<(HTMLSpanElement | null)[]>;
  toggleRecording: () => void;
  /** True when there is an editable surface to dictate into. */
  canDictate: boolean;
}

export function useVaultDictation(editorViewRef: VaultEditorHandle): VaultDictation {
  const mode = useVaultStore((s) => s.mode);
  const activePath = useVaultStore((s) => s.activePath);
  const canDictate = mode === "edit" && activePath != null;

  const target = useMemo(
    () => createVaultDictationTarget(() => editorViewRef.current),
    [editorViewRef],
  );

  // The Alt handlers are window-global, so only the pane the user is actually
  // in may react to a solo Alt press.
  const pathRef = useRef(activePath);
  pathRef.current = activePath;
  const isActiveTarget = useCallback(
    () => useVaultStore.getState().activePath === pathRef.current,
    [],
  );

  const engine = useVoiceDictationCore({
    target,
    pushToTalk: canDictate,
    isActiveTarget,
  });

  // Switching notes remounts the editor (it is keyed by path), which would
  // otherwise leave a live microphone feeding text into a document the user
  // just left. Abort rather than let the next note inherit the take. The
  // cancel is a no-op when nothing is recording, so it needs no guard — and
  // it must NOT key off `recording`, or it would fire the moment dictation
  // started.
  const { cancelRecording } = engine;
  const prevPathRef = useRef(activePath);
  useEffect(() => {
    if (prevPathRef.current === activePath) return;
    prevPathRef.current = activePath;
    cancelRecording();
  }, [activePath, cancelRecording]);

  return { ...engine, canDictate };
}
