/**
 * ApprovalCard — an inline tool-approval prompt rendered above the composer.
 *
 * When the agent's tool loop hits a `NeedsApproval` action (write_file,
 * run_code, …) the desktop emits `SessionApprovalRequest`; the phone renders
 * this card so the user can approve or deny without touching the desktop.
 *
 * Permission design: plain "Approve" NEVER grants permanent permission —
 * "Always allow" is a SECOND, clearly-captioned text button that calls
 * `onApprove(true)`. The card disables itself once a decision is tapped; the
 * caller removes it from the stream (useSessionChat's approve/deny drops it
 * from `pendingApprovals`, and `SessionApprovalResolved` dismisses cards
 * resolved on any surface).
 */
import { useState, type JSX } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { theme } from '../../theme';
import { notifySuccess, notifyError, tapLight } from '../../lib/haptics';

export interface ApprovalCardProps {
  approval: {
    pendingId: string;
    tool: string;
    summary: string;
    args: unknown;
    /** True when the Always-Allow shortcut should be offered (FS mutators
     *  only — the desktop's rules engine governs exactly these). */
    canAlwaysAllow: boolean;
  };
  /** `alwaysAllow` is true ONLY from the separate Always-Allow button. */
  onApprove: (alwaysAllow: boolean) => void;
  onDeny: () => void;
}

/** Per-tool glyph (plain text, no icon-font dependency):
 *  ✎ edit/write · ⌫ delete · ⇄ move/copy · 🔍 read/search · ▸ shell/run default. */
function toolGlyph(tool: string): string {
  const t = (tool || '').toLowerCase();
  if (/(delete|remove|unlink|rmdir)/.test(t)) return '⌫';
  if (/(move|copy|rename)/.test(t)) return '⇄';
  if (/(edit|write|create|patch|apply|save)/.test(t)) return '✎';
  if (/(read|search|grep|glob|find|list|fetch|web|open)/.test(t)) return '🔍';
  return '▸'; // shell / run_code / everything else
}

/** Cap pretty-printed args so a giant object can't blow up the card. */
const ARGS_DISPLAY_CAP = 2000;

export function ApprovalCard({ approval, onApprove, onDeny }: ApprovalCardProps): JSX.Element {
  const [resolved, setResolved] = useState(false);
  const [argsOpen, setArgsOpen] = useState(false);
  const c = theme.colors;

  const argsText = (() => {
    const { args } = approval;
    if (args === undefined || args === null) return null;
    try {
      const json = JSON.stringify(args, null, 2);
      return json.length > ARGS_DISPLAY_CAP ? `${json.slice(0, ARGS_DISPLAY_CAP)}\n…` : json;
    } catch {
      return null; // circular or otherwise unserializable — hide the section
    }
  })();

  const deny = () => {
    setResolved(true);
    notifyError();
    onDeny();
  };
  const approve = (alwaysAllow: boolean) => {
    setResolved(true);
    notifySuccess();
    onApprove(alwaysAllow);
  };

  const disabledStyle = resolved ? { opacity: 0.5 } : null;

  return (
    <View style={[styles.card, { backgroundColor: c.elevated, borderColor: c.border }]}>
      {/* Header: glyph badge + tool name over a 1-2 line summary. */}
      <View style={styles.header}>
        <View style={[styles.glyphBadge, { backgroundColor: c.bubble }]}>
          <Text style={[styles.glyph, { color: c.accent }]}>{toolGlyph(approval.tool)}</Text>
        </View>
        <View style={styles.headerText}>
          <Text style={[styles.toolName, { color: c.textSecondary }]} numberOfLines={1}>
            {approval.tool}
          </Text>
          <Text style={[styles.summary, { color: c.text }]} numberOfLines={2}>
            {approval.summary}
          </Text>
        </View>
      </View>

      {/* Args: pretty JSON, collapsed by default. */}
      {argsText ? (
        <View>
          <TouchableOpacity
            style={styles.argsToggle}
            onPress={() => {
              tapLight();
              setArgsOpen((open) => !open);
            }}
            disabled={resolved}
            activeOpacity={0.6}
          >
            <Text style={[styles.argsToggleText, { color: c.textSecondary }]}>
              Arguments
            </Text>
            <Text style={[styles.argsChevron, { color: c.textSecondary }]}>
              {argsOpen ? '▾' : '▸'}
            </Text>
          </TouchableOpacity>
          {argsOpen ? (
            <View style={[styles.argsBox, { backgroundColor: c.surface2, borderColor: c.border }]}>
              <Text style={[styles.argsText, { color: c.text }]} selectable>
                {argsText}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {/* Decision row: Deny (quiet destructive) · Always allow (tertiary text)
          · Approve (accent filled = the primary decision). */}
      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.btnDeny, { borderColor: c.error }, disabledStyle]}
          onPress={deny}
          disabled={resolved}
          activeOpacity={0.7}
        >
          <Text style={[styles.btnDenyText, { color: c.error }]}>Deny</Text>
        </TouchableOpacity>
        {approval.canAlwaysAllow ? (
          <TouchableOpacity
            style={[styles.btnAlways, disabledStyle]}
            onPress={() => approve(true)}
            disabled={resolved}
            activeOpacity={0.7}
          >
            <Text style={[styles.btnAlwaysText, { color: c.textSecondary }]}>Always allow</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          style={[styles.btnApprove, { backgroundColor: c.accent }, disabledStyle]}
          onPress={() => approve(false)}
          disabled={resolved}
          activeOpacity={0.7}
        >
          <Text style={[styles.btnApproveText, { color: c.white }]}>Approve</Text>
        </TouchableOpacity>
      </View>
      {approval.canAlwaysAllow ? (
        <Text style={[styles.alwaysCaption, { color: c.textSecondary }]}>
          Runs this tool without asking from now on
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
    marginVertical: theme.spacing.sm,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.sm },
  glyphBadge: {
    width: 32,
    height: 32,
    borderRadius: theme.radius.sm,
    justifyContent: 'center',
    alignItems: 'center',
  },
  glyph: { fontSize: 15, lineHeight: 19 },
  headerText: { flex: 1, minWidth: 0 },
  toolName: {
    fontSize: theme.fontSize.xs,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  summary: { ...theme.type.body, fontSize: theme.fontSize.md, lineHeight: 19, marginTop: 1 },
  argsToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    marginTop: theme.spacing.sm,
    paddingVertical: 2,
  },
  argsToggleText: { fontSize: theme.fontSize.sm, fontWeight: '500' },
  argsChevron: { fontSize: theme.fontSize.sm },
  argsBox: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.radius.sm,
    padding: theme.spacing.sm,
    marginTop: theme.spacing.xs,
  },
  argsText: { ...theme.type.mono, fontSize: theme.fontSize.sm, lineHeight: 18 },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: theme.spacing.sm,
    marginTop: theme.spacing.sm,
  },
  btnDeny: {
    borderWidth: 1,
    borderRadius: theme.radius.sm,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  btnDenyText: { fontSize: theme.fontSize.sm, fontWeight: '600' },
  btnAlways: { paddingHorizontal: theme.spacing.xs, paddingVertical: 8 },
  btnAlwaysText: { fontSize: theme.fontSize.sm, fontWeight: '500' },
  btnApprove: {
    borderRadius: theme.radius.sm,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  btnApproveText: { fontSize: theme.fontSize.sm, fontWeight: '600' },
  alwaysCaption: {
    ...theme.type.secondary,
    fontSize: theme.fontSize.xs,
    lineHeight: 15,
    marginTop: theme.spacing.xs,
    textAlign: 'right',
  },
});

export default ApprovalCard;
