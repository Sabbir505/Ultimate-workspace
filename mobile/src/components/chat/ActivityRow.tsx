/**
 * ActivityRow — the ChatGPT-app style "activity" step for a tool call.
 *
 * The desktop's assistant stream embeds `<tool>{json}</tool>` markers; the
 * segment parser in MessageBubble extracts each one and hands the parsed
 * payload here. This component is the ONLY place tool JSON renders.
 *
 * Collapsed (default): one quiet line — a status glyph (pulsing accent dot
 * while the call is in flight, a check once done), the tool title (or kind
 * fallback), the detail inline truncated, and a chevron. Subagent Task
 * tools (role + task present) render as "Subagent · <role>" rows.
 *
 * Expanded: the code body (mono, horizontal scroll), args, the target file
 * path, and — for edit payloads — the old/new content as red/green tinted
 * blocks (plain background tints, no diff library).
 */
import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Animated,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { theme } from '../../theme';

// M4: Ionicons glyph-font wrappers preserving the lucide call-shapes.
const Check = ({ size, color }: { size?: number; color?: string }) => (
  <Ionicons name="checkmark" size={size} color={color} />
);
const ChevronDown = ({ size, color }: { size?: number; color?: string }) => (
  <Ionicons name="chevron-down" size={size} color={color} />
);
const ChevronUp = ({ size, color }: { size?: number; color?: string }) => (
  <Ionicons name="chevron-up" size={size} color={color} />
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

/** Derive `rgba(r,g,b,a)` from a token hex color — lets us tint edit blocks
 *  from the theme without hardcoding colors. */
function withAlpha(hex: string, alpha: number): string {
  const h = hex.startsWith('#') ? hex.slice(1) : hex;
  const full = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return hex;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

interface EditView {
  path?: string;
  old?: string;
  new?: string;
}

/** Narrow an arbitrary edit payload — never trust the model-fed shape. */
function renderEdit(edit: unknown, fallbackPath?: string): EditView | null {
  if (edit == null || typeof edit !== 'object') return null;
  const e = edit as Record<string, unknown>;
  const oldStr = typeof e.old === 'string' ? e.old : undefined;
  const newStr = typeof e.new === 'string' ? e.new : undefined;
  const path = typeof e.path === 'string' ? e.path : fallbackPath;
  if (oldStr === undefined && newStr === undefined && path === undefined) return null;
  return { path, old: oldStr, new: newStr };
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

export default function ActivityRow({ data, raw, done }: ActivityRowProps) {
  const c = theme.colors;
  const [expanded, setExpanded] = useState(false);

  const isSubagent = data?.role != null && data?.task != null;
  const title = isSubagent
    ? `Subagent · ${data!.role}`
    : (data?.title || data?.kind || (done ? 'Tool call' : 'Working…'));
  const detail = isSubagent ? data!.task : (data?.detail || data?.path || '');

  const edit = useMemo(() => renderEdit(data?.edit, data?.path), [data]);
  const argsText = useMemo(() => {
    if (data?.args == null) return null;
    try {
      return JSON.stringify(data.args, null, 2);
    } catch {
      return null;
    }
  }, [data]);
  const rawText = useMemo(() => {
    if (data) return null;
    if (!raw) return null;
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }, [data, raw]);

  const hasBody =
    expanded &&
    (edit != null || data?.code != null || data?.path != null || argsText != null || data?.result != null || rawText != null || isSubagent);

  return (
    <View style={[styles.card, { backgroundColor: c.surface2, borderColor: c.border }]}>
      <TouchableOpacity
        style={styles.head}
        activeOpacity={0.7}
        onPress={() => setExpanded((v) => !v)}
        accessibilityLabel={expanded ? 'Hide tool details' : 'Show tool details'}
      >
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
        {expanded ? (
          <ChevronUp size={14} color={c.textSecondary} />
        ) : (
          <ChevronDown size={14} color={c.textSecondary} />
        )}
      </TouchableOpacity>

      {hasBody ? (
        <View style={styles.body}>
          {data?.path ? (
            <Text style={[styles.pathText, { color: c.textSecondary }]} numberOfLines={2}>
              {data.path}
            </Text>
          ) : null}

          {isSubagent ? (
            <Text style={[styles.resultText, { color: c.textSecondary }]}>{data!.task}</Text>
          ) : null}

          {edit?.old != null ? (
            <View style={[styles.diffBlock, { backgroundColor: withAlpha(c.error, 0.14) }]}>
              <Text style={[styles.diffLabel, { color: c.error }]}>{'− Before'}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <Text style={[styles.codeText, { color: c.text }]}>{edit.old}</Text>
              </ScrollView>
            </View>
          ) : null}

          {edit?.new != null ? (
            <View style={[styles.diffBlock, { backgroundColor: withAlpha(c.success, 0.14) }]}>
              <Text style={[styles.diffLabel, { color: c.success }]}>{'+ After'}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <Text style={[styles.codeText, { color: c.text }]}>{edit.new}</Text>
              </ScrollView>
            </View>
          ) : null}

          {data?.code != null ? (
            <View style={[styles.codeBlock, { backgroundColor: c.background, borderColor: c.border }]}>
              {data.lang ? (
                <Text style={[styles.codeLang, { color: c.textSecondary }]}>{data.lang}</Text>
              ) : null}
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <Text style={[styles.codeText, { color: c.text }]}>{data.code}</Text>
              </ScrollView>
            </View>
          ) : null}

          {argsText ? (
            <View style={[styles.codeBlock, { backgroundColor: c.background, borderColor: c.border }]}>
              <Text style={[styles.codeLang, { color: c.textSecondary }]}>args</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <Text style={[styles.codeText, { color: c.textSecondary }]}>{argsText}</Text>
              </ScrollView>
            </View>
          ) : null}

          {data?.result ? (
            <Text style={[styles.resultText, { color: c.textSecondary }]}>{data.result}</Text>
          ) : null}

          {rawText ? (
            <View style={[styles.codeBlock, { backgroundColor: c.background, borderColor: c.border }]}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <Text style={[styles.codeText, { color: c.textSecondary }]}>{rawText}</Text>
              </ScrollView>
            </View>
          ) : null}
        </View>
      ) : null}
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
  body: {
    marginTop: 10,
    gap: 8,
  },
  pathText: {
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 17,
  },
  codeBlock: {
    borderRadius: theme.radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 10,
  },
  codeLang: {
    fontFamily: 'monospace',
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  codeText: {
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 17,
  },
  diffBlock: {
    borderRadius: theme.radius.sm,
    padding: 10,
  },
  diffLabel: {
    ...theme.type.label,
    fontWeight: '700',
    marginBottom: 4,
  },
  resultText: {
    ...theme.type.secondary,
  },
});
