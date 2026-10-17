/**
 * TurnChangesCard — the phone twin of the desktop's TurnChangesRow.
 *
 * One bordered disclosure card per assistant turn, hung under the bubble
 * where the old flat artifact chips used to be:
 *
 *   › 2 files changed                                       ↺ Undo
 *   A  index.ts   src/                                 [Review]
 *   M  Relay.tsx  src/                                 [Review]
 *
 * Tapping the card header expands the turn's file list; tapping a file's
 * name opens it (the old chip's ArtifactSheet preview) and Review runs the
 * git diff for it (DiffSheet). Undo restores the PREVIOUS checkpoint — the
 * desktop rolls the workspace back to the state before the turn, and on the
 * phone the conversation is always kept (rollbackMessages stays false).
 *
 * Data: the turn's checkpoint files carry the git status letter (A/M/D —
 * files the write/edit tools touched); artifact paths the checkpoint never
 * captured (generated deliverables) list without a badge. No +/− line stats
 * like the desktop — the phone never receives the diff blocks, and a diff
 * request per file would be one relay round-trip per row.
 */
import { useState, type JSX } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { theme } from '../../theme';
import { tapLight } from '../../lib/haptics';
import SpeakButton from '../SpeakButton';
import type { CheckpointFileInfo } from '../../hooks/useRelay';

export interface TurnChangeFile {
  path: string;
  /** Git status letter from the turn's checkpoint ('A' | 'M' | 'D'). */
  status?: string;
}

/** True when two path strings refer to the same file regardless of relative
 *  vs absolute form (checkpoint paths are project-relative; artifact events
 *  may carry absolute ones). Desktop sameTurnFile parity. */
export function sameTurnFile(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  return na === nb || na.endsWith('/' + nb) || nb.endsWith('/' + na);
}

/** Merge the turn's checkpoint files (with status) and its artifact paths
 *  into one de-duplicated list — checkpoint rows win so the A/M/D badge
 *  survives. */
export function buildTurnFiles(
  checkpointFiles: CheckpointFileInfo[],
  artifactPaths: string[],
): TurnChangeFile[] {
  const files: TurnChangeFile[] = [];
  for (const f of checkpointFiles) {
    if (files.some((c) => sameTurnFile(c.path, f.path))) continue;
    files.push({ path: f.path, status: f.status });
  }
  for (const p of artifactPaths) {
    if (files.some((c) => sameTurnFile(c.path, p))) continue;
    files.push({ path: p });
  }
  return files;
}

/** Split a path into basename + directory, mirroring the desktop rows. */
function splitPath(path: string): { basename: string; dirname: string } {
  const sep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return sep >= 0
    ? { basename: path.slice(sep + 1), dirname: path.slice(0, sep) }
    : { basename: path, dirname: '' };
}

function statusColor(status: string | undefined, c: typeof theme.colors): string | undefined {
  if (!status) return undefined;
  const letter = status[0]?.toUpperCase();
  if (letter === 'A') return c.success;
  if (letter === 'D') return c.error;
  if (letter === 'M') return c.warning;
  return c.textSecondary;
}

export interface TurnChangesCardProps {
  files: TurnChangeFile[];
  /** The checkpoint to restore to undo this turn — null hides the Undo
   *  affordance (no earlier snapshot exists). */
  undoTargetId?: number | null;
  onReview: (path: string) => void;
  onOpen: (path: string) => void;
  onUndo: () => void;
}

export function TurnChangesCard({
  files,
  undoTargetId,
  onReview,
  onOpen,
  onUndo,
}: TurnChangesCardProps): JSX.Element | null {
  const c = theme.colors;
  const [open, setOpen] = useState(false);
  if (files.length === 0) return null;

  const label = `${files.length} ${files.length === 1 ? 'file' : 'files'} changed`;

  return (
    <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
      <View style={styles.head}>
        <TouchableOpacity
          style={styles.headToggle}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel={`${label} — ${open ? 'hide' : 'show'} changed files`}
          onPress={() => { tapLight(); setOpen((v) => !v); }}
        >
          <Ionicons
            name={open ? 'chevron-down' : 'chevron-forward'}
            size={14}
            color={c.textSecondary}
          />
          <Text numberOfLines={1} style={[styles.headLabel, { color: c.text }]}>
            {label}
          </Text>
        </TouchableOpacity>
        <SpeakButton
          id={`turn:${files[0]?.path ?? ''}`}
          text={`${label}. ${files.map((f) => `${f.path}${f.status ? `, ${f.status[0] === 'A' ? 'added' : f.status[0] === 'D' ? 'deleted' : 'modified'}` : ''}`).join('. ')}.`}
          label={label}
          size={14}
        />
        {undoTargetId != null ? (
          <TouchableOpacity
            style={styles.undoBtn}
            activeOpacity={0.7}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Undo this turn — roll the workspace back to the state before it"
            onPress={() => { tapLight(); onUndo(); }}
          >
            <Ionicons name="arrow-undo-outline" size={13} color={c.accent} />
            <Text style={[styles.undoText, { color: c.accent }]}>Undo</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {open
        ? files.map((f) => {
            const { basename, dirname } = splitPath(f.path);
            const letter = f.status ? f.status[0] : null;
            return (
              <View key={f.path} style={[styles.row, { borderTopColor: c.border }]}>
                {letter ? (
                  <Text style={[styles.statusLetter, { color: statusColor(f.status, c) }]}>
                    {letter}
                  </Text>
                ) : (
                  <Ionicons name="document-text-outline" size={12} color={c.textSecondary} />
                )}
                {/* The name area IS the open target (the old chip's tap). */}
                <TouchableOpacity
                  style={styles.names}
                  activeOpacity={0.6}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${f.path}`}
                  onPress={() => { tapLight(); onOpen(f.path); }}
                >
                  <Text numberOfLines={1} style={[styles.basename, { color: c.text }]}>
                    {basename}
                  </Text>
                  {dirname ? (
                    <Text numberOfLines={1} style={[styles.dirname, { color: c.textSecondary }]}>
                      {dirname}/
                    </Text>
                  ) : null}
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.reviewBtn}
                  activeOpacity={0.7}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityRole="button"
                  accessibilityLabel={`Review diff for ${f.path}`}
                  onPress={() => { tapLight(); onReview(f.path); }}
                >
                  <Ionicons name="git-compare-outline" size={12} color={c.accent} />
                  <Text style={[styles.reviewText, { color: c.accent }]}>Review</Text>
                </TouchableOpacity>
              </View>
            );
          })
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.radius.sm,
    marginHorizontal: theme.spacing.md,
    marginTop: 6,
    overflow: 'hidden',
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: theme.spacing.sm,
  },
  headToggle: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: theme.spacing.sm,
  },
  headLabel: { fontSize: 12, fontWeight: '600', flexShrink: 1 },
  undoBtn: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  undoText: { fontSize: 11, fontWeight: '600' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 7,
    paddingHorizontal: theme.spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  statusLetter: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
    width: 10,
    textAlign: 'center',
  },
  names: { flex: 1 },
  basename: { fontSize: 12, fontWeight: '500' },
  dirname: { fontSize: 10, fontFamily: 'monospace', marginTop: 1 },
  reviewBtn: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  reviewText: { fontSize: 11, fontWeight: '600' },
});

export default TurnChangesCard;
