/**
 * PlanCard — the live plan-proposal card (pinned above the composer).
 *
 * The desktop's agent can pause and present a plan (`present_plan`); the
 * phone renders it as a card the user can approve or revise:
 *   - header: the plan title + a "Plan proposal" label
 *   - body: the plan markdown via MarkdownText
 *   - when expanded (default): a revise input ("What should change?") and
 *     two actions — "Revise" (secondary; sends the feedback as a rejection)
 *     and "Approve plan" (accent, medium tap haptic).
 *
 * Resolving removes the card via useSessionChat state — no local dismissal.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { theme } from '../../theme';
import { tapMedium } from '../../lib/haptics';
import MarkdownText from './MarkdownText';

// M4: Ionicons glyph-font wrappers preserving the lucide call-shapes.
const ChevronUp = ({ size, color }: { size?: number; color?: string }) => (
  <Ionicons name="chevron-up" size={size} color={color} />
);
const ChevronDown = ({ size, color }: { size?: number; color?: string }) => (
  <Ionicons name="chevron-down" size={size} color={color} />
);
const ListIcon = ({ size, color }: { size?: number; color?: string }) => (
  <Ionicons name="list" size={size} color={color} />
);

export interface PlanCardProps {
  pendingId: string;
  title: string;
  plan: string;
  /** Approve — the caller resolves with approved=true. */
  onApprove: () => void;
  /** Revise — the caller resolves with approved=false + the feedback text. */
  onRevise: (feedback: string) => void;
}

export default function PlanCard({ title, plan, onApprove, onRevise }: PlanCardProps) {
  const c = theme.colors;
  const [expanded, setExpanded] = useState(true);
  const [feedback, setFeedback] = useState('');

  const handleRevise = () => {
    const text = feedback.trim();
    if (!text) return;
    setFeedback('');
    onRevise(text);
  };

  const handleApprove = () => {
    tapMedium();
    onApprove();
  };

  return (
    <View style={[styles.card, { backgroundColor: c.surface2, borderColor: c.border }]}>
      <TouchableOpacity
        style={styles.head}
        activeOpacity={0.7}
        onPress={() => setExpanded((v) => !v)}
        accessibilityLabel={expanded ? 'Collapse plan' : 'Expand plan'}
      >
        <ListIcon size={16} color={c.accent} />
        <View style={styles.headText}>
          <Text style={[styles.kickerLabel, { color: c.textSecondary }]}>Plan proposal</Text>
          <Text style={[styles.title, { color: c.text }]} numberOfLines={2}>
            {title}
          </Text>
        </View>
        {expanded ? (
          <ChevronUp size={16} color={c.textSecondary} />
        ) : (
          <ChevronDown size={16} color={c.textSecondary} />
        )}
      </TouchableOpacity>

      {expanded ? (
        <>
          <View style={styles.planBody}>
            <MarkdownText content={plan} />
          </View>

          <TextInput
            style={[styles.reviseInput, { borderColor: c.border, color: c.text, backgroundColor: c.background }]}
            value={feedback}
            onChangeText={setFeedback}
            placeholder="What should change?"
            placeholderTextColor={c.textSecondary}
            multiline
          />

          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.btn, styles.btnSecondary, { borderColor: c.border }]}
              onPress={handleRevise}
              disabled={feedback.trim().length === 0}
              activeOpacity={0.7}
            >
              <Text style={[styles.btnSecondaryText, { color: feedback.trim() ? c.text : c.textSecondary }]}>
                Revise
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, styles.btnPrimary, { backgroundColor: c.accent }]}
              onPress={handleApprove}
              activeOpacity={0.8}
            >
              <Text style={[styles.btnPrimaryText, { color: c.white }]}>Approve plan</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    marginHorizontal: theme.spacing.md,
    marginVertical: 6,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  headText: { flex: 1 },
  kickerLabel: {
    ...theme.type.label,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 2,
  },
  title: {
    ...theme.type.secondary,
    fontWeight: '600',
    fontSize: 15,
    lineHeight: 20,
  },
  planBody: {
    marginTop: 10,
  },
  reviseInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.radius.pill,
    paddingHorizontal: 16,
    paddingTop: 9,
    paddingBottom: 9,
    marginTop: 4,
    fontSize: 14,
    maxHeight: 88,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
    marginTop: 12,
  },
  btn: {
    borderRadius: theme.radius.pill,
    paddingVertical: 9,
    paddingHorizontal: 18,
    alignItems: 'center',
  },
  btnSecondary: { borderWidth: StyleSheet.hairlineWidth },
  btnSecondaryText: { ...theme.type.secondary, fontWeight: '600' },
  btnPrimary: {},
  btnPrimaryText: {
    ...theme.type.secondary,
    fontWeight: '600',
  },
});
