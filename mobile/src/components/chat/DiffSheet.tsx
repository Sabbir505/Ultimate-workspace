/**
 * DiffSheet — the chat "diff peek" (desktop PeekPanel diff mode parity).
 *
 * Opened from a file-edit activity row: runs the desktop's `get_git_file_diff`
 * for the touched path (via the relay GitDiff op against the session's bound
 * project) and renders the unified diff with the desktop's line coloring —
 * green tint for additions, red for removals, accent for @@ hunks. Read-only;
 * a repo-less or untracked path shows the git output (typically empty) as a
 * muted note instead of an error.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Modal } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { theme } from '../../theme';
import { useRelay, onGitOutput, onDomainError } from '../../hooks/useRelay';

export interface DiffSheetProps {
  visible: boolean;
  /** Repo-relative path the agent touched — the diff is filtered to it. */
  path: string | null;
  /** The session's bound project (GitDiff runs against its working dir). */
  projectId: string | null;
  onClose: () => void;
}

interface DiffLine {
  kind: 'add' | 'del' | 'hunk' | 'meta' | 'ctx';
  text: string;
}

/** Parse a unified diff into colored lines (desktop parseUnifiedDiff parity,
 *  line-level instead of word-level — phone screens don't need intraline). */
export function parseDiffLines(diff: string): DiffLine[] {
  return diff.split('\n').map((line) => {
    if (line.startsWith('@@')) return { kind: 'hunk', text: line };
    if (line.startsWith('+++') || line.startsWith('---')) return { kind: 'meta', text: line };
    if (line.startsWith('+')) return { kind: 'add', text: line };
    if (line.startsWith('-')) return { kind: 'del', text: line };
    return { kind: 'ctx', text: line };
  });
}

export default function DiffSheet({ visible, path, projectId, onClose }: DiffSheetProps) {
  const c = theme.colors;
  const { gitDiff } = useRelay();
  const [loading, setLoading] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // One request per open; the reply lands on the shared GitOutput bus (no
  // correlation id on the relay protocol — the Git rail is the only other
  // subscriber and lives on a different screen). A deadline turns a dropped
  // reply (desktop busy, repo lock, lost frame) into an error note instead
  // of an eternal "Loading diff…" — same contract as ArtifactSheet.
  const FETCH_TIMEOUT_MS = 12_000;
  useEffect(() => {
    if (!visible || !path || !projectId) return;
    setLoading(true);
    setOutput(null);
    setError(null);
    gitDiff(projectId, path);
    let done = false;
    const timeout = setTimeout(() => {
      if (!done) {
        done = true;
        setLoading(false);
        setError('The desktop didn’t respond — it may be busy. Try again.');
      }
    }, FETCH_TIMEOUT_MS);
    const offOut = onGitOutput.on(({ output: text }) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      setOutput(text);
      setLoading(false);
    });
    const offErr = onDomainError.on(({ domain, error: e }) => {
      if (domain !== 'git' || done) return;
      done = true;
      clearTimeout(timeout);
      setError(e);
      setLoading(false);
    });
    return () => { done = true; clearTimeout(timeout); offOut(); offErr(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, path, projectId]);

  const lines = useMemo(() => (output ? parseDiffLines(output) : []), [output]);
  const filename = path?.split(/[\\/]/).pop() ?? '';

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.scrim, { backgroundColor: c.scrim }]}>
        <View style={[styles.sheet, { backgroundColor: c.elevated }]}>
          <View style={styles.head}>
            <Ionicons name="git-compare-outline" size={15} color={c.accent} />
            <Text numberOfLines={1} style={[styles.title, { color: c.text }]}>
              {filename || 'Diff'}
            </Text>
            <Text numberOfLines={1} style={[styles.path, { color: c.textSecondary }]}>
              {path}
            </Text>
            <TouchableOpacity
              onPress={onClose}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Close diff"
            >
              <Ionicons name="close" size={18} color={c.textSecondary} />
            </TouchableOpacity>
          </View>

          {loading ? (
            <Text style={[styles.note, { color: c.textSecondary }]}>Loading diff…</Text>
          ) : error ? (
            <Text style={[styles.note, { color: c.error }]}>{error}</Text>
          ) : lines.length === 0 ? (
            <Text style={[styles.note, { color: c.textSecondary }]}>
              No git changes for this file (untracked or already committed).
            </Text>
          ) : (
            <ScrollView style={styles.body} horizontal={false}>
              {lines.map((l, i) => (
                <View
                  key={i}
                  style={[
                    styles.line,
                    l.kind === 'add' && { backgroundColor: `${c.success}1A` },
                    l.kind === 'del' && { backgroundColor: `${c.error}1A` },
                  ]}
                >
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.lineText,
                      { color: c.text },
                      l.kind === 'hunk' && { color: c.accent, fontWeight: '600' },
                      l.kind === 'add' && { color: c.success },
                      l.kind === 'del' && { color: c.error },
                      l.kind === 'meta' && { color: c.textSecondary, fontWeight: '600' },
                    ]}
                  >
                    {l.text || ' '}
                  </Text>
                </View>
              ))}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    maxHeight: '85%',
    borderTopLeftRadius: theme.radius.sheet,
    borderTopRightRadius: theme.radius.sheet,
    padding: theme.spacing.md,
    gap: 10,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    fontSize: 14,
    fontWeight: '700',
    flexShrink: 0,
    maxWidth: 140,
  },
  path: {
    ...theme.type.secondary,
    flex: 1,
    fontFamily: 'monospace',
    fontSize: 11,
  },
  note: {
    ...theme.type.secondary,
    paddingVertical: theme.spacing.lg,
    textAlign: 'center',
  },
  body: { maxHeight: 520 },
  line: { paddingHorizontal: 6 },
  lineText: {
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 16,
  },
});
