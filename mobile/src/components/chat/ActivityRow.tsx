/**
 * ActivityRow — the ChatGPT-app style "activity" step for a tool call.
 *
 * The desktop's assistant stream embeds `<tool>{json}</tool>` markers; the
 * segment parser in MessageBubble extracts each one and hands the parsed
 * payload here. This component is the ONLY place tool JSON renders.
 *
 * One quiet line: a status glyph (pulsing accent dot while the call is in
 * flight, a check once done), the tool title (or kind fallback), and the
 * detail inline truncated. Subagent Task tools (role + task present) render
 * as "Subagent · <role>" rows.
 *
 * No expansion for now — the phone's `<tool>` payloads don't carry the
 * code/edit bodies the desktop shows, so there is nothing to reveal (the
 * chevron opened an empty sheet). The desktop-side expansion machinery was
 * removed with it; restore both together when tool details come to mobile.
 */
import React from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { theme } from '../../theme';

// M4: Ionicons glyph-font wrappers preserving the lucide call-shapes.
const Check = ({ size, color }: { size?: number; color?: string }) => (
  <Ionicons name="checkmark" size={size} color={color} />
);

/** Tool-call payload from the desktop's `<tool>` markers (proto tool_block).
 *  Every field is optional — render defensively, the shape is model-fed. */
export interface ToolData {
  kind?: string;
  title?: string;
  detail?: string;
  lang?: string;
  code?: string;
  path?: string;
  /** write_file / edit_file payload: { path?, old?, new? } — shape is NOT
   *  guaranteed, narrow at runtime in renderEdit(). */
  edit?: unknown;
  /** Subagent Task steps carry the spawned agent's role + task. */
  role?: string;
  task?: string;
  result?: string;
  args?: unknown;
}

export interface ActivityRowProps {
  data: ToolData | null;
  /** Raw inner JSON of the marker — shown when the payload failed to parse. */
  raw?: string;
  /** False while the closing marker hasn't streamed in yet (still running). */
  done: boolean;
}

function PulsingDot({ color }: { color: string }) {
  const opacity = React.useRef(new Animated.Value(0.35)).current;
  React.useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 650, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.35, duration: 650, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return (
    <View style={styles.glyphBox}>
      <Animated.View style={[styles.dot, { backgroundColor: color, opacity }]} />
    </View>
  );
}

export default function ActivityRow({ data, done }: ActivityRowProps) {
  const c = theme.colors;

  const isSubagent = data?.role != null && data?.task != null;
  const title = isSubagent
    ? `Subagent · ${data!.role}`
    : (data?.title || data?.kind || (done ? 'Tool call' : 'Working…'));
  const detail = isSubagent ? data!.task : (data?.detail || data?.path || '');

  return (
    <View style={[styles.card, { backgroundColor: c.surface2, borderColor: c.border }]}>
      <View style={styles.head}>
        {done ? (
          <View style={styles.glyphBox}>
            <Check size={14} color={c.success} />
          </View>
        ) : (
          <PulsingDot color={c.accent} />
        )}
        <Text style={[styles.title, { color: c.text }]} numberOfLines={1}>
          {title}
        </Text>
        {detail ? (
          <Text style={[styles.detail, { color: c.textSecondary }]} numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: theme.radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    marginVertical: 6,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  glyphBox: { width: 16, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  title: {
    fontSize: 14,
    lineHeight: 19,
    fontWeight: '600',
    flexShrink: 0,
    maxWidth: '55%',
  },
  detail: {
    ...theme.type.secondary,
    flex: 1,
  },
});
