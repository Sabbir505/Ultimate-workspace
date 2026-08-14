/**
 * ApprovalCard — an inline tool-approval prompt embedded in the chat stream.
 *
 * When the agent's tool loop hits a `NeedsApproval` action (write_file,
 * run_code, etc.) the desktop emits `SessionApprovalRequest`. The phone
 * renders this card so the user can approve or deny without touching
 * the desktop.
 *
 * While a decision is pending the buttons disable; resolving the card
 * removes it from the stream (handled by the caller via useSessionChat's
 * approve/deny, which drops it from `pendingApprovals`).
 */
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
// M4: lucide-react-native cannot be tree-shaken by Metro (one giant JS
// bundle of every icon); Ionicons is a glyph font already bundled with the
// app. These wrappers preserve the lucide call-sites' (size, color) props.
const ShieldAlert = ({ size, color }: { size?: number; color?: string }) => <Ionicons name="shield" size={size} color={color} />;
const Check = ({ size, color }: { size?: number; color?: string }) => <Ionicons name="checkmark" size={size} color={color} />;
const X = ({ size, color }: { size?: number; color?: string }) => <Ionicons name="close" size={size} color={color} />;
import { theme } from '../theme';

export interface ApprovalCardProps {
  tool: string;
  summary: string;
  /** Raw JSON args from the model — pretty-printed if present. */
  args?: unknown;
  onApprove: () => void;
  onDeny: () => void;
}

export default function ApprovalCard({ tool, summary, args, onApprove, onDeny }: ApprovalCardProps) {
  const [resolved, setResolved] = useState(false);

  const handle = (fn: () => void) => () => {
    setResolved(true);
    fn();
  };

  const argsText = (() => {
    if (!args) return null;
    try {
      return JSON.stringify(args, null, 2);
    } catch {
      return null;
    }
  })();

  return (
    <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
      <View style={styles.header}>
        <ShieldAlert size={18} color={theme.colors.warning} />
        <Text style={[styles.title, { color: theme.colors.text }]} numberOfLines={1}>
          Approval required
        </Text>
        <View style={[styles.toolChip, { backgroundColor: theme.colors.surface2 }]}>
          <Text style={[styles.toolChipText, { color: theme.colors.primary }]} numberOfLines={1}>
            {tool}
          </Text>
        </View>
      </View>
      <Text style={[styles.summary, { color: theme.colors.text }]}>{summary}</Text>
      {argsText ? (
        <View style={[styles.argsBox, { backgroundColor: theme.colors.background, borderColor: theme.colors.border }]}>
          <Text style={[styles.argsText, { color: theme.colors.textSecondary }]}>{argsText}</Text>
        </View>
      ) : null}
      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.btn, styles.btnDeny, { borderColor: theme.colors.error }]}
          onPress={handle(onDeny)}
          disabled={resolved}
          activeOpacity={0.7}
        >
          <X size={15} color={theme.colors.error} />
          <Text style={[styles.btnText, { color: theme.colors.error }]}>Deny</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.btn, styles.btnApprove, { backgroundColor: theme.colors.success, opacity: resolved ? 0.5 : 1 }]}
          onPress={handle(onApprove)}
          disabled={resolved}
          activeOpacity={0.7}
        >
          <Check size={15} color="#fff" />
          <Text style={[styles.btnText, { color: '#fff' }]}>Approve</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 12,
    marginVertical: 6,
  },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  title: { fontSize: 14, fontWeight: '600', flex: 1, marginLeft: 6 },
  toolChip: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    maxWidth: 120,
  },
  toolChipText: { fontSize: 11, fontFamily: 'monospace' },
  summary: { fontSize: 13, lineHeight: 19, marginBottom: 8 },
  argsBox: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    padding: 8,
    marginBottom: 8,
  },
  argsText: { fontFamily: 'monospace', fontSize: 11, lineHeight: 16 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 7,
    gap: 5,
  },
  btnDeny: { borderWidth: 1 },
  btnApprove: {},
  btnText: { fontSize: 13, fontWeight: '600' },
});
