/**
 * ArtifactChip — one pill chip for an artifact attached to a message.
 *
 * Design: pill row per artifact under a message — a file-format badge
 * (uppercase extension, or JSX/TSX for inline previews), a one-line
 * filename, and a chevron. Tapping opens the ArtifactSheet bottom sheet,
 * which lists every artifact in `artifacts` (defaults to just this one)
 * and previews the tapped file.
 *
 * Usage (SessionChat / MessageBubble):
 *   <ArtifactChip artifact={a} artifacts={chat.artifacts} sessionId={sessionId} />
 */
import { useState, type JSX } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { theme } from '../../theme';
import { tapLight } from '../../lib/haptics';
import type { SessionArtifact } from '../../hooks/useRelay';
import ArtifactSheet, { extOf } from './ArtifactSheet';

export interface ArtifactChipProps {
  artifact: SessionArtifact;
  /** Every artifact in the session — the sheet's list. Defaults to [artifact]. */
  artifacts?: SessionArtifact[];
  /** Session id — required for the sheet to fetch file contents over the relay. */
  sessionId?: string;
}

export function ArtifactChip({ artifact, artifacts, sessionId }: ArtifactChipProps): JSX.Element {
  const [sheetOpen, setSheetOpen] = useState(false);
  const c = theme.colors;

  const filename = artifact.filename || artifact.path.split(/[\\/]/).pop() || artifact.path;
  const badge = artifact.inline
    ? artifact.inline.kind.toUpperCase()
    : (extOf(artifact.filename || artifact.path) || 'file');

  return (
    <View>
      <TouchableOpacity
        style={[styles.chip, { backgroundColor: c.surface2, borderColor: c.border }]}
        onPress={() => {
          tapLight();
          setSheetOpen(true);
        }}
        activeOpacity={0.7}
      >
        <View style={[styles.badge, { backgroundColor: c.bubble }]}>
          <Text style={[styles.badgeText, { color: c.accent }]} numberOfLines={1}>
            {badge.slice(0, 5)}
          </Text>
        </View>
        <Text style={[styles.filename, { color: c.text }]} numberOfLines={1}>
          {filename}
        </Text>
        <Text style={[styles.chevron, { color: c.textSecondary }]}>›</Text>
      </TouchableOpacity>

      <ArtifactSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        artifacts={artifacts && artifacts.length > 0 ? artifacts : [artifact]}
        sessionId={sessionId}
        initialPath={artifact.path}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.radius.pill,
    paddingLeft: 4,
    paddingRight: theme.spacing.sm,
    paddingVertical: 4,
    marginTop: theme.spacing.sm,
    marginBottom: 2,
    gap: 6,
    maxWidth: '100%',
  },
  badge: {
    borderRadius: theme.radius.pill,
    minWidth: 36,
    paddingHorizontal: 6,
    paddingVertical: 3,
    justifyContent: 'center',
    alignItems: 'center',
  },
  badgeText: { fontSize: 9, fontWeight: '700', letterSpacing: 0.5 },
  filename: { fontSize: theme.fontSize.sm, fontWeight: '500', flexShrink: 1 },
  chevron: { fontSize: theme.fontSize.md, lineHeight: theme.fontSize.lg },
});

export default ArtifactChip;
