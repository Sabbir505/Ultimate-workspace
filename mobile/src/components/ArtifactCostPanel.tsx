/**
 * ArtifactCostPanel — the phone twin of the desktop's ArtifactCostPanel.
 *
 * Cost attribution per artifact: the improvement engine's own eval turns
 * plus its live runs' sessions, joined to chat messages for tokens and
 * cost. Feeds from the relay's GetArtifactCosts arm (7/30/90 day range, the
 * same window the rest of the dashboard uses).
 */
import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { theme } from '../theme';
import {
  onArtifactCosts, useRelay, type ArtifactCostRollup,
} from '../hooks/useRelay';
import { formatTokens } from '../lib/format';

/** Desktop KIND_LABEL parity. */
const KIND_LABEL: Record<string, string> = {
  skill: 'Skill',
  loop: 'Loop',
  prompt_template: 'Template',
  automation: 'Automation',
};

export default function ArtifactCostPanel({ rangeDays }: { rangeDays: number }) {
  const c = theme.colors;
  const { getArtifactCosts } = useRelay();
  const [rows, setRows] = useState<ArtifactCostRollup[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const off = onArtifactCosts.on(({ rows }) => { setRows(rows); setLoading(false); });
    return off;
  }, []);
  useEffect(() => {
    setLoading(true);
    getArtifactCosts(rangeDays);
    // Refetch with the dashboard's range — the desktop does the same.
  }, [getArtifactCosts, rangeDays]);

  if (loading && rows.length === 0) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="small" color={c.textSecondary} />
      </View>
    );
  }
  // Desktop hides the panel entirely when nothing was attributed.
  if (!loading && rows.length === 0) return null;

  return (
    <View>
      <Text style={[styles.note, { color: c.textSecondary }]}>
        live runs + the improvement engine's own eval turns, per artifact
      </Text>
      <View style={[styles.table, { borderColor: c.border }]}>
        <View style={[styles.headRow, { borderBottomColor: c.border }]}>
          <Text style={[styles.head, { color: c.textSecondary, flex: 2 }]} numberOfLines={1}>Artifact</Text>
          <Text style={[styles.head, { color: c.textSecondary }]}>Runs</Text>
          <Text style={[styles.head, { color: c.textSecondary }]}>In</Text>
          <Text style={[styles.head, { color: c.textSecondary }]}>Out</Text>
          <Text style={[styles.head, { color: c.textSecondary }]}>Cached</Text>
          <Text style={[styles.head, { color: c.textSecondary, textAlign: 'right' }]}>Cost</Text>
        </View>
        {rows.map((r) => (
          <View key={r.artifactId} style={styles.row}>
            <View style={{ flex: 2, flexShrink: 1 }}>
              <Text style={{ color: c.text, fontSize: 11, fontWeight: '600' }} numberOfLines={1}>{r.name}</Text>
              <Text style={{ color: c.textSecondary, fontSize: 9 }} numberOfLines={1}>
                {KIND_LABEL[r.kind] ?? r.kind}
              </Text>
            </View>
            <Text style={[styles.cell, { color: c.textSecondary }]}>
              {r.liveRuns}/{r.evalRuns}
            </Text>
            <Text style={[styles.cell, { color: c.textSecondary }]}>{formatTokens(r.inputTokens)}</Text>
            <Text style={[styles.cell, { color: c.textSecondary }]}>{formatTokens(r.outputTokens)}</Text>
            <Text style={[styles.cell, { color: c.textSecondary }]}>{formatTokens(r.cacheReadTokens)}</Text>
            <Text style={[styles.cell, { color: c.text, textAlign: 'right' }]}>${r.costUsd.toFixed(2)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  centered: { alignItems: 'center', paddingVertical: 24 },
  note: { fontSize: 11, paddingBottom: 6 },
  table: { borderWidth: StyleSheet.hairlineWidth, borderRadius: theme.radius.md, overflow: 'hidden' },
  headRow: {
    flexDirection: 'row', alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 6, paddingHorizontal: 8, gap: 4,
  },
  head: { fontSize: 9, fontWeight: '700', letterSpacing: 0.3, flex: 1 },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 7, paddingHorizontal: 8, gap: 4,
  },
  cell: { fontSize: 10, flex: 1 },
});