/**
 * GitScreen — the phone mirror of the desktop Git rail: repo status
 * (branch, ahead/behind, remote), changed files, per-file unified diffs,
 * commit, push, branches, and log. Every command runs on the desktop against
 * a REGISTERED project (the phone can only reach repos the desktop knows),
 * through the same git core the desktop panel uses.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { theme } from '../theme';
import { useScreenMountTiming } from '../lib/screenTiming';
import {
  useRelay, onDomainError, onProjectList, onGitStatus, onGitOutput, onGitBranches, onGitLog,
  type ProjectInfo,
} from '../hooks/useRelay';
import { useRelayList } from '../hooks/useRelayList';
import { tapLight } from '../lib/haptics';
import ScreenHeader from '../components/ScreenHeader';

type ChangedFile = { status: string; kind: string; path: string };

export default function GitScreen() {
  useScreenMountTiming('GitScreen');
  const c = theme.colors;
  const { gitStatus, gitDiff, gitCommit, gitPush, gitBranches, gitLog, listProjects } = useRelay();
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [status, setStatus] = useState<{
    is_repo: boolean; branch?: string | null; dirty: boolean; ahead: number; behind: number;
    remote_url?: string | null; changed_files: ChangedFile[];
  } | null>(null);
  const [output, setOutput] = useState<{ title: string; text: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [commitText, setCommitText] = useState('');
  const [busy, setBusy] = useState(false);
  const [branches, setBranches] = useState<Record<string, unknown>[]>([]);
  const [logEntries, setLogEntries] = useState<Record<string, unknown>[]>([]);
  const [showLog, setShowLog] = useState(false);
  // GitOutput carries only text, never a title — remember what the in-flight
  // request was for so the result sheet keeps the diff's file path instead of
  // retitling every reply to 'Result'.
  const pendingTitleRef = useRef('Result');

  // The project list must survive a lost first fetch too: the mount send is
  // dropped while the socket is still pairing, so refetch on reconnect.
  useRelayList(() => { listProjects(); refresh(projectId); });

  useEffect(() => {
    const offP = onProjectList.on(({ projects: list }) => {
      setProjects(list);
      if (!projectId && list.length > 0) setProjectId(list[0].id);
    });
    const offS = onGitStatus.on(({ status: st }) => { setStatus(st); setBusy(false); });
    const offO = onGitOutput.on(({ output: text }) => {
      // Only overwrite the text — the title stays whatever the pending
      // request (diff path or a command result) set it to.
      setOutput((prev) => ({ title: prev?.title ?? pendingTitleRef.current, text }));
      setBusy(false);
    });
    const offB = onGitBranches.on(({ branches: b }) => setBranches(b));
    const offL = onGitLog.on(({ entries }) => { setLogEntries(entries); setBusy(false); });
    // A failed git op answers with a git-domain ChatError (routed to the
    // DomainErrorBar below); busy must clear too, or the spinner never does.
    const offErr = onDomainError.on(({ domain }) => {
      if (domain === 'git') setBusy(false);
    });
    return () => { offP(); offS(); offO(); offB(); offL(); offErr(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const refresh = useMemo(
    () => (id: string | null) => {
      if (!id) return;
      setBusy(true);
      gitStatus(id);
    },
    [gitStatus],
  );

  useEffect(() => { refresh(projectId); }, [projectId, refresh]);

  const changed = status?.changed_files ?? [];
  const staged = changed.filter((f) => f.status[0] !== ' ' && f.status[0] !== '?').length;

  const openDiff = (f: ChangedFile) => {
    if (!projectId) return;
    pendingTitleRef.current = f.path;
    setBusy(true);
    setOutput({ title: f.path, text: 'Loading diff…' });
    gitDiff(projectId, f.path);
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: c.background }]} edges={['top']}>
      <ScreenHeader
        title="Git"
        errorDomains={['git', 'projects']}
        right={
          <TouchableOpacity
            // No project selected → nothing to refresh; gitBranches('') is
            // rejected by the desktop, so no-op it exactly like refresh().
            onPress={() => { refresh(projectId); if (projectId) gitBranches(projectId); }}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="button"
            accessibilityLabel="Refresh git"
          >
            <Ionicons name="refresh" size={20} color={c.textSecondary} />
          </TouchableOpacity>
        }
      />

      {/* Project picker */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.projectRow} contentContainerStyle={styles.projectRowContent}>
        {projects.map((p) => (
          <TouchableOpacity
            key={p.id}
            style={[styles.projectChip, projectId === p.id && { backgroundColor: c.accent }]}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={`Git for ${p.name}`}
            onPress={() => { setProjectId(p.id); setStatus(null); setBranches([]); setLogEntries([]); }}
          >
            <Text style={{ color: projectId === p.id ? c.white : c.text, fontSize: 12, fontWeight: '700' }}>
              {p.name}
            </Text>
          </TouchableOpacity>
        ))}
        {projects.length === 0 ? (
          <Text style={{ color: c.textSecondary, fontSize: 12, paddingVertical: 8 }}>
            No projects registered — add one from the new-chat sheet's Manage projects.
          </Text>
        ) : null}
      </ScrollView>

      <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
        {busy && !output ? <ActivityIndicator color={c.accent} style={{ marginVertical: 8 }} /> : null}
        {message ? (
          <TouchableOpacity onPress={() => setMessage(null)}>
            <Text style={{ color: c.accent, fontSize: 12, marginBottom: 6 }}>{message} · tap to dismiss</Text>
          </TouchableOpacity>
        ) : null}

        {status && !status.is_repo ? (
          <Text style={[styles.empty, { color: c.textSecondary }]}>This project isn't a git repository.</Text>
        ) : null}

        {status?.is_repo ? (
          <>
            <View style={[styles.statusCard, { backgroundColor: c.surface, borderColor: c.border }]}>
              <View style={styles.statusRow}>
                <Ionicons name="git-branch-outline" size={16} color={c.accent} />
                <Text style={[styles.branch, { color: c.text }]}>{status.branch ?? '—'}</Text>
              </View>
              <Text style={[styles.meta, { color: c.textSecondary }]}>
                ↑{status.ahead} ↓{status.behind}
                {status.dirty ? ' · uncommitted changes' : ' · clean'}
                {status.remote_url ? ` · ${status.remote_url}` : ''}
              </Text>
            </View>

            <Text style={[styles.section, { color: c.textSecondary }]}>
              Changes {changed.length > 0 ? `(${changed.length})` : ''}
            </Text>
            <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
              {changed.length === 0 ? (
                <Text style={{ color: c.textSecondary, fontSize: 12.5, paddingVertical: 6 }}>Working tree clean.</Text>
              ) : null}
              {changed.map((f) => (
                <TouchableOpacity
                  key={`${f.status}-${f.path}`}
                  style={styles.fileRow}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`Diff ${f.path}`}
                  onPress={() => openDiff(f)}
                >
                  <Text style={[styles.kindTag, { color: kindColor(f.kind) }]}>{f.kind}</Text>
                  <Text numberOfLines={1} style={[styles.path, { color: c.text, flex: 1 }]}>{f.path}</Text>
                  <Ionicons name="chevron-forward" size={14} color={c.textSecondary} />
                </TouchableOpacity>
              ))}
            </View>

            <Text style={[styles.section, { color: c.textSecondary }]}>Commit</Text>
            <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
              <TextInput
                style={[styles.commitInput, { color: c.text, backgroundColor: c.surface2, borderColor: c.border }]}
                placeholder={`Message (${staged} staged)`}
                placeholderTextColor={c.textSecondary}
                value={commitText}
                onChangeText={setCommitText}
                accessibilityLabel="Commit message"
              />
              <View style={styles.commitActions}>
                <TouchableOpacity
                  style={[styles.primaryBtn, { backgroundColor: c.accent, opacity: commitText.trim() ? 1 : 0.4 }]}
                  disabled={!commitText.trim()}
                  accessibilityRole="button"
                  accessibilityLabel="Commit"
                  onPress={() => {
                    if (!projectId || !commitText.trim()) return;
                    tapLight();
                    pendingTitleRef.current = 'Result';
                    setBusy(true);
                    gitCommit(projectId, commitText.trim());
                    setCommitText('');
                  }}
                >
                  <Text style={{ color: c.white, fontWeight: '700', fontSize: 13 }}>Commit</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.ghostBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Push"
                  onPress={() => {
                    if (!projectId) return;
                    pendingTitleRef.current = 'Result';
                    setBusy(true);
                    gitPush(projectId);
                  }}
                >
                  <Ionicons name="cloud-upload-outline" size={15} color={c.textSecondary} />
                  <Text style={{ color: c.textSecondary, fontWeight: '600', fontSize: 13 }}>Push</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.ghostBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Toggle git log"
                  onPress={() => {
                    setShowLog((v) => !v);
                    if (!showLog && projectId) { setBusy(true); gitLog(projectId); }
                  }}
                >
                  <Ionicons name="list-outline" size={15} color={c.textSecondary} />
                  <Text style={{ color: c.textSecondary, fontWeight: '600', fontSize: 13 }}>
                    {showLog ? 'Hide log' : 'Log'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            {branches.length > 0 ? (
              <>
                <Text style={[styles.section, { color: c.textSecondary }]}>Branches</Text>
                <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
                  {branches.map((b, i) => (
                    <Text key={i} style={[styles.fileRowText, { color: c.text }]}>
                      {String(b.name ?? b)}
                      {b.current ? '  (current)' : ''}
                    </Text>
                  ))}
                </View>
              </>
            ) : null}

            {showLog && logEntries.length > 0 ? (
              <>
                <Text style={[styles.section, { color: c.textSecondary }]}>Log</Text>
                <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
                  {logEntries.map((e, i) => (
                    <View key={i} style={styles.logRow}>
                      <Text style={[styles.sha, { color: c.textSecondary }]}>
                        {String(e.sha ?? '').slice(0, 7)}
                      </Text>
                      <Text numberOfLines={1} style={[styles.path, { color: c.text, flex: 1 }]}>
                        {String(e.message ?? '').split('\n')[0]}
                      </Text>
                    </View>
                  ))}
                </View>
              </>
            ) : null}
          </>
        ) : null}
      </ScrollView>

      {/* Output overlay (diff / command result) */}
      <Modal visible={output != null} transparent animationType="slide" onRequestClose={() => setOutput(null)}>
        <View style={[styles.outputScrim, { backgroundColor: c.scrim }]}>
          <View style={[styles.outputSheet, { backgroundColor: c.elevated }]}>
            <View style={styles.outputHead}>
              <Text numberOfLines={1} style={[styles.outputTitle, { color: c.text, flex: 1 }]}>
                {output?.title}
              </Text>
              <TouchableOpacity
                onPress={() => setOutput(null)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                accessibilityRole="button"
                accessibilityLabel="Close output"
              >
                <Ionicons name="close" size={20} color={c.textSecondary} />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.outputBody} horizontal={false}>
              <Text style={[styles.mono, { color: c.text }]} selectable>
                {output?.text}
              </Text>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function kindColor(kind: string): string {
  switch (kind) {
    case 'M': return '#fbbf24';
    case 'A': return '#22c55e';
    case 'D': return '#ef4444';
    case 'R': return '#38bdf8';
    default: return '#94a3b8';
  }
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  projectRow: { flexGrow: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'transparent' },
  projectRowContent: { padding: 10, gap: 8 },
  projectChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: theme.radius.pill, backgroundColor: 'transparent', borderWidth: StyleSheet.hairlineWidth, borderColor: '#8884' },
  body: { padding: 12, gap: 10, paddingBottom: 40 },
  statusCard: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 6 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  branch: { fontSize: 15, fontWeight: '700' },
  meta: { fontSize: 12 },
  section: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 6 },
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 2 },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 7 },
  fileRowText: { fontSize: 13, paddingVertical: 4 },
  kindTag: { fontSize: 11, fontWeight: '800', width: 16 },
  path: { fontSize: 13 },
  logRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5 },
  sha: { fontFamily: 'monospace', fontSize: 11 },
  commitInput: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10, fontSize: 14 },
  commitActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  primaryBtn: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: theme.radius.pill },
  ghostBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 9 },
  empty: { textAlign: 'center', paddingVertical: 48, fontSize: 13 },
  outputScrim: { flex: 1, justifyContent: 'flex-end' },
  outputSheet: { maxHeight: '85%', borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 16, gap: 10 },
  outputHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  outputTitle: { fontSize: 14, fontWeight: '700' },
  outputBody: { maxHeight: 500 },
  mono: { fontFamily: 'monospace', fontSize: 11, lineHeight: 16 },
});
