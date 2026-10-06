/**
 * ChatGitSheet — the chat-scoped git tool surface (desktop GitToolsSidebar
 * parity): repo status for the chat's bound project, changed files (tap →
 * the diff overlay), commit, push, branches and recent log — everything the
 * desktop sidebar does, in a bottom sheet keyed to THIS chat's project.
 *
 * Reuses the global git relay ops (same arms the Git screen drives); events
 * land on shared buses, which is safe because stack screens unmount.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal, View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView, ActivityIndicator,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { theme } from '../../theme';
import {
  useRelay, onGitStatus, onGitOutput, onGitBranches, onGitLog, onDomainError,
} from '../../hooks/useRelay';
import { tapLight } from '../../lib/haptics';

type ChangedFile = { status: string; kind: string; path: string };
type GitStatus = {
  is_repo: boolean; branch?: string | null; dirty: boolean;
  ahead: number; behind: number; remote_url?: string | null;
  changed_files: ChangedFile[];
};

const STATUS_COLOR: Record<string, string> = {
  M: theme.colors.accent,
  A: theme.colors.success,
  D: theme.colors.error,
  '?': theme.colors.textSecondary,
};

export interface ChatGitSheetProps {
  visible: boolean;
  projectId: string | null;
  projectName?: string | null;
  /** Opens the diff overlay for a changed file (SessionChat owns the sheet). */
  onPeekFile: (path: string) => void;
  onClose: () => void;
}

export default function ChatGitSheet({
  visible, projectId, projectName, onPeekFile, onClose,
}: ChatGitSheetProps) {
  const c = theme.colors;
  const { gitStatus, gitCommit, gitPush, gitBranches, gitLog } = useRelay();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [branches, setBranches] = useState<{ name?: unknown; current?: unknown }[]>([]);
  const [logEntries, setLogEntries] = useState<{ sha?: unknown; message?: unknown }[]>([]);
  const [showBranches, setShowBranches] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [commitText, setCommitText] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  // Load once per OPEN. The ref guard makes a setState-in-effect feedback
  // loop impossible: whatever re-runs this effect (a dep identity flapping,
  // a parent remount), the same open never fires the loads twice.
  const loadedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!visible) {
      loadedForRef.current = null; // next open reloads
      return;
    }
    if (!projectId || loadedForRef.current === projectId) return;
    loadedForRef.current = projectId;
    setStatus(null);
    setBranches([]);
    setLogEntries([]);
    setNotice(null);
    setCommitText('');
    setBusy(true);
    gitStatus(projectId);
    gitBranches(projectId);
    gitLog(projectId, 10);
  }, [visible, projectId, gitStatus, gitBranches, gitLog]);

  useEffect(() => {
    if (!visible) return;
    const offS = onGitStatus.on(({ status: st }) => { setStatus(st); setBusy(false); });
    const offB = onGitBranches.on(({ branches: b }) => setBranches(b as { name?: unknown; current?: unknown }[]));
    const offL = onGitLog.on(({ entries }) => { setLogEntries(entries as { sha?: unknown; message?: unknown }[]); setBusy(false); });
    const offO = onGitOutput.on(({ output }) => {
      setBusy(false);
      setNotice(output.split('\n').slice(0, 4).join('\n'));
    });
    const offE = onDomainError.on(({ domain }) => { if (domain === 'git') setBusy(false); });
    return () => { offS(); offB(); offL(); offO(); offE(); };
  }, [visible]);

  const doCommit = useCallback(() => {
    const msg = commitText.trim();
    if (!projectId || !msg) return;
    tapLight();
    setBusy(true);
    gitCommit(projectId, msg);
    setCommitText('');
  }, [projectId, commitText, gitCommit]);

  const doPush = useCallback(() => {
    if (!projectId) return;
    tapLight();
    setBusy(true);
    setNotice('Pushing…');
    gitPush(projectId);
  }, [projectId, gitPush]);

  const changed = useMemo(() => status?.changed_files ?? [], [status]);
  const staged = changed.filter((f) => f.status[0] !== ' ' && f.status[0] !== '?').length;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.scrim}>
        <PressableClose onClose={onClose} />
        <View style={[styles.sheet, { backgroundColor: c.background }]}>
          {/* Header */}
          <View style={styles.header}>
            <Ionicons name="git-branch-outline" size={17} color={c.accent} />
            <Text numberOfLines={1} style={[styles.title, { color: c.text }]}>
              Git{projectName ? ` — ${projectName}` : ''}
            </Text>
            <TouchableOpacity
              onPress={() => {
                if (!projectId) return;
                tapLight();
                setBusy(true);
                gitStatus(projectId);
                gitBranches(projectId);
                gitLog(projectId, 10);
              }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Refresh git"
            >
              {busy ? (
                <ActivityIndicator size="small" color={c.textSecondary} />
              ) : (
                <Ionicons name="refresh" size={17} color={c.textSecondary} />
              )}
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onClose}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Close git panel"
            >
              <Ionicons name="close" size={19} color={c.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
            {busy && !status ? (
              <ActivityIndicator color={c.accent} style={{ marginVertical: 16 }} />
            ) : status && !status.is_repo ? (
              <Text style={[styles.empty, { color: c.textSecondary }]}>
                This project isn't a git repository.
              </Text>
            ) : status ? (
              <>
                {/* Status card */}
                <View style={[styles.card, { backgroundColor: c.surface2, borderColor: c.border }]}>
                  <View style={styles.statusRow}>
                    <Ionicons name="git-branch-outline" size={13} color={c.textSecondary} />
                    <Text numberOfLines={1} style={[styles.branch, { color: c.text }]}>
                      {status.branch ?? '—'}
                    </Text>
                    {status.dirty ? (
                      <Text style={[styles.dirtyBadge, { color: c.accent }]}>dirty</Text>
                    ) : (
                      <Text style={[styles.cleanBadge, { color: c.success }]}>clean</Text>
                    )}
                  </View>
                  <Text style={{ color: c.textSecondary, fontSize: 11 }}>
                    ↑{status.ahead} ↓{status.behind}
                    {status.remote_url ? ` · ${status.remote_url.replace(/^https?:\/\//, '').replace(/\.git$/, '')}` : ''}
                  </Text>
                </View>

                {/* Changed files */}
                <Text style={[styles.section, { color: c.textSecondary }]}>
                  Changes{changed.length > 0 ? ` (${changed.length}${staged ? ` · ${staged} staged` : ''})` : ''}
                </Text>
                {changed.length === 0 ? (
                  <Text style={[styles.empty, { color: c.textSecondary }]}>No changes.</Text>
                ) : (
                  <View style={[styles.card, { backgroundColor: c.surface2, borderColor: c.border }]}>
                    {changed.map((f) => (
                      <TouchableOpacity
                        key={f.path}
                        style={styles.fileRow}
                        activeOpacity={0.6}
                        accessibilityRole="button"
                        accessibilityLabel={`Diff ${f.path}`}
                        onPress={() => { tapLight(); onPeekFile(f.path); }}
                      >
                        <Text style={[styles.statusLetter, { color: STATUS_COLOR[f.status[0]] ?? c.textSecondary }]}>
                          {f.status[0]}
                        </Text>
                        <Text numberOfLines={1} style={[styles.filePath, { color: c.text }]}>{f.path}</Text>
                        <Ionicons name="chevron-forward" size={12} color={c.textSecondary} />
                      </TouchableOpacity>
                    ))}
                  </View>
                )}

                {/* Commit */}
                <Text style={[styles.section, { color: c.textSecondary }]}>Commit</Text>
                <TextInput
                  style={[styles.commitInput, { color: c.text, backgroundColor: c.surface2, borderColor: c.border }]}
                  placeholder="Commit message"
                  placeholderTextColor={c.textSecondary}
                  value={commitText}
                  onChangeText={setCommitText}
                  multiline
                />
                <View style={styles.actionRow}>
                  <TouchableOpacity
                    style={[
                      styles.actionBtn,
                      { backgroundColor: c.accent, opacity: commitText.trim() && !busy ? 1 : 0.4 },
                    ]}
                    disabled={!commitText.trim() || busy}
                    onPress={doCommit}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityLabel="Commit changes"
                  >
                    <Ionicons name="checkmark" size={14} color={c.white} />
                    <Text style={{ color: c.white, fontSize: 12, fontWeight: '700' }}>Commit</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.actionBtn, { borderColor: c.border, opacity: busy ? 0.4 : 1 }]}
                    disabled={busy}
                    onPress={doPush}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityLabel="Push to remote"
                  >
                    <Ionicons name="cloud-upload-outline" size={14} color={c.text} />
                    <Text style={{ color: c.text, fontSize: 12, fontWeight: '700' }}>Push</Text>
                  </TouchableOpacity>
                </View>

                {/* Branches + log (collapsible) */}
                <TouchableOpacity
                  style={styles.disclosure}
                  onPress={() => { tapLight(); setShowBranches((v) => !v); }}
                  accessibilityRole="button"
                  accessibilityLabel="Toggle branches"
                >
                  <Ionicons name="git-branch-outline" size={13} color={c.textSecondary} />
                  <Text style={{ color: c.textSecondary, fontSize: 12, fontWeight: '600', flex: 1 }}>Branches</Text>
                  <Ionicons name={showBranches ? 'chevron-up' : 'chevron-down'} size={13} color={c.textSecondary} />
                </TouchableOpacity>
                {showBranches ? (
                  <View style={[styles.card, { backgroundColor: c.surface2, borderColor: c.border }]}>
                    {branches.length === 0 ? (
                      <Text style={[styles.empty, { color: c.textSecondary }]}>No branches.</Text>
                    ) : (
                      branches.map((b, i) => (
                        <Text key={i} style={[styles.branchLine, { color: b.current ? c.accent : c.text }]}>
                          {String(b.name ?? b)}{b.current ? '  ✓' : ''}
                        </Text>
                      ))
                    )}
                  </View>
                ) : null}

                <TouchableOpacity
                  style={styles.disclosure}
                  onPress={() => {
                    tapLight();
                    if (!showLog && projectId) gitLog(projectId, 10);
                    setShowLog((v) => !v);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Toggle log"
                >
                  <Ionicons name="list-outline" size={13} color={c.textSecondary} />
                  <Text style={{ color: c.textSecondary, fontSize: 12, fontWeight: '600', flex: 1 }}>Recent log</Text>
                  <Ionicons name={showLog ? 'chevron-up' : 'chevron-down'} size={13} color={c.textSecondary} />
                </TouchableOpacity>
                {showLog ? (
                  <View style={[styles.card, { backgroundColor: c.surface2, borderColor: c.border }]}>
                    {logEntries.length === 0 ? (
                      <Text style={[styles.empty, { color: c.textSecondary }]}>No commits.</Text>
                    ) : (
                      logEntries.map((e, i) => (
                        <View key={i} style={styles.logRow}>
                          <Text style={[styles.sha, { color: c.textSecondary }]}>
                            {String(e.sha ?? '').slice(0, 7)}
                          </Text>
                          <Text numberOfLines={1} style={{ color: c.text, fontSize: 12, flex: 1 }}>
                            {String(e.message ?? '').split('\n')[0]}
                          </Text>
                        </View>
                      ))
                    )}
                  </View>
                ) : null}

                {notice ? (
                  <TouchableOpacity onPress={() => setNotice(null)}>
                    <Text numberOfLines={4} style={[styles.notice, { color: c.textSecondary }]}>
                      {notice} · tap to dismiss
                    </Text>
                  </TouchableOpacity>
                ) : null}
              </>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

/** Tapping the scrim closes the sheet. */
function PressableClose({ onClose }: { onClose: () => void }) {
  return (
    <TouchableOpacity
      style={StyleSheet.absoluteFill}
      activeOpacity={1}
      onPress={onClose}
      accessibilityRole="button"
      accessibilityLabel="Close"
    />
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    maxHeight: '82%',
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    paddingBottom: theme.spacing.lg,
  },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: theme.spacing.md, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.border,
  },
  title: { flex: 1, fontSize: 15, fontWeight: '700' },
  body: { paddingHorizontal: theme.spacing.md, paddingTop: theme.spacing.sm },
  card: {
    borderRadius: theme.radius.md, borderWidth: 1,
    padding: theme.spacing.md, marginBottom: theme.spacing.sm,
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  branch: { fontSize: 14, fontWeight: '700', flexShrink: 1 },
  dirtyBadge: { fontSize: 10, fontWeight: '800', textTransform: 'uppercase' },
  cleanBadge: { fontSize: 10, fontWeight: '800', textTransform: 'uppercase' },
  section: {
    fontSize: 10, fontWeight: '700', textTransform: 'uppercase',
    letterSpacing: 0.5, marginBottom: 6, marginTop: theme.spacing.sm,
  },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  statusLetter: { fontSize: 13, fontWeight: '800', width: 14 },
  filePath: { flex: 1, fontSize: 12, fontFamily: 'monospace' },
  commitInput: {
    borderWidth: 1, borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.md, paddingVertical: 10,
    fontSize: 13, minHeight: 44, textAlignVertical: 'top',
  },
  actionRow: { flexDirection: 'row', gap: theme.spacing.sm, marginTop: 8 },
  actionBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    borderRadius: theme.radius.pill, paddingHorizontal: 16, paddingVertical: 9,
    borderWidth: 1, borderColor: 'transparent',
  },
  disclosure: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: 9, paddingHorizontal: 4,
  },
  branchLine: { fontSize: 12, paddingVertical: 2 },
  logRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 3 },
  sha: { fontSize: 11, fontFamily: 'monospace' },
  empty: { fontSize: 12, paddingVertical: 4 },
  notice: { fontSize: 11, fontFamily: 'monospace', marginTop: 10 },
});
