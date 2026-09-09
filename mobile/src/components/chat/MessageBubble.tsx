/**
 * MessageBubble — renders one chat turn for the SessionChat screen.
 *
 * The ChatGPT-app contrast, which IS the design:
 *   - "user"      right-aligned rounded bubble (theme.colors.bubble, radius
 *                 20 with a 6 bottom-right tail, 12/16 padding, body type).
 *   - "assistant" FULL-WIDTH PLAIN text on the background — no bubble.
 *                 The content is split into ordered segments: markdown
 *                 text (MarkdownText), `<think>` reasoning (ThinkingBlock),
 *                 and `<tool>` activity rows (ActivityRow).
 *   - "system"    small centered muted notice text.
 *
 * Segment parser: a direct port of the desktop algorithm (src/components/
 * chat/MessageBubble.tsx `parseSegments`). Markers may arrive UNTERMINATED
 * mid-stream (`done: false`); parallel subagent fan-out opens several
 * `<tool>` markers back-to-back, so a repeated opener terminates the
 * current tool segment instead of being swallowed into its JSON.
 */
import React, { useMemo, useRef, useEffect } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { theme } from '../../theme';
import MarkdownText from './MarkdownText';
import ThinkingBlock from './ThinkingBlock';
import ActivityRow, { type ToolData } from './ActivityRow';

export type { ToolData };

export interface MessageBubbleProps {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** True while tokens are still arriving — shows the live caret indicator. */
  streaming?: boolean;
}

export type Segment =
  | { type: 'text'; text: string }
  | { type: 'think'; text: string; done: boolean }
  | { type: 'tool'; data: ToolData | null; raw: string; done: boolean };

/** Split an assistant message into ordered segments: plain markdown text,
 *  `<think>` reasoning blocks, and `<tool>` process cards. A block whose
 *  closing tag hasn't streamed in yet is marked `done: false`. */
export function parseSegments(content: string): Segment[] {
  const segs: Segment[] = [];
  let rest = content;
  const tagRe = /<(think|tool)>/;
  for (;;) {
    const m = tagRe.exec(rest);
    if (!m) {
      if (rest) segs.push({ type: 'text', text: rest });
      break;
    }
    const before = rest.slice(0, m.index);
    if (before) segs.push({ type: 'text', text: before });

    const tag = m[1];
    if (tag === undefined) break;
    const afterOpen = rest.slice(m.index + m[0].length);
    const close = `</${tag}>`;
    const ci = afterOpen.indexOf(close);
    // Parallel subagent fan-out opens several <tool> markers BACK-TO-BACK
    // (the pre-pass emits every Task's opener before any tool completes), so
    // a repeated opener can arrive before the closing tag. Treat the next
    // opener as the end of THIS segment — still unterminated (done: false) —
    // instead of swallowing the whole run into one inner blob whose JSON
    // parse fails and renders a phantom "working…" row. Tool-marker content
    // is sanitizer-escaped, so a real opener inside `inner` can't false-hit;
    // `<think>` never stacks, so the split stays tool-only.
    const ni = tag === 'tool' ? afterOpen.indexOf('<tool>') : -1;
    const end = ci === -1 ? ni : ni === -1 ? ci : Math.min(ci, ni);
    const inner = end === -1 ? afterOpen : afterOpen.slice(0, end);
    const done = end !== -1 && end === ci;

    if (tag === 'think') {
      segs.push({ type: 'think', text: inner.trim(), done });
    } else {
      let data: ToolData | null = null;
      try {
        data = JSON.parse(inner) as ToolData;
      } catch {
        data = null;
      }
      segs.push({ type: 'tool', data, raw: inner, done });
    }

    if (end === -1) break;
    rest = end === ci ? afterOpen.slice(ci + close.length) : afterOpen.slice(end);
  }
  return segs;
}

/** Blinking caret — the live "still writing" signal at the stream tail. */
function Caret() {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.15, duration: 500, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 500, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return (
    <Animated.Text style={[styles.caret, { color: theme.colors.accent, opacity }]}>
      {' ▍'}
    </Animated.Text>
  );
}

/** Subtle "•••" breathing indicator shown before the first token lands. */
function TypingDots() {
  const opacity = useRef(new Animated.Value(0.35)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 600, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.35, duration: 600, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return (
    <Animated.Text style={[styles.dots, { color: theme.colors.textSecondary, opacity }]}>
      {'•••'}
    </Animated.Text>
  );
}

function AssistantContent({ content, streaming }: { content: string; streaming: boolean }) {
  const segments = useMemo(() => parseSegments(content), [content]);
  const empty = content.length === 0;

  if (empty) return streaming ? <TypingDots /> : null;

  return (
    <View style={styles.assistantBody}>
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        switch (seg.type) {
          case 'think':
            return <ThinkingBlock key={i} thinking={seg.text} done={seg.done} />;
          case 'tool':
            return <ActivityRow key={i} data={seg.data} raw={seg.raw} done={seg.done} />;
          default:
            return (
              <View key={i} style={styles.textSeg}>
                <MarkdownText content={seg.text} />
                {streaming && isLast ? <Caret /> : null}
              </View>
            );
        }
      })}
      {/* Stream ends inside a think/tool block (no trailing text segment) —
          hang the caret off the row so "still working" stays visible. */}
      {streaming && segments[segments.length - 1]?.type !== 'text' ? <Caret /> : null}
    </View>
  );
}

export default function MessageBubble({ role, content, streaming = false }: MessageBubbleProps) {
  const c = theme.colors;

  if (role === 'system') {
    return (
      <View style={styles.systemRow}>
        <Text style={[styles.systemText, { color: c.textSecondary }]} numberOfLines={3}>
          {content}
        </Text>
      </View>
    );
  }

  if (role === 'user') {
    return (
      <View style={styles.userRow}>
        <View style={[styles.userBubble, { backgroundColor: c.bubble }]}>
          <Text style={[styles.userText, { color: c.text }]}>{content}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.assistantRow}>
      <AssistantContent content={content} streaming={streaming} />
    </View>
  );
}

const styles = StyleSheet.create({
  // Generous 20px vertical rhythm BETWEEN turns (10+10 on adjacent rows).
  userRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginVertical: 10,
    paddingHorizontal: theme.spacing.md,
  },
  userBubble: {
    maxWidth: '85%',
    borderRadius: theme.radius.lg, // 20
    borderBottomRightRadius: 6,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  userText: {
    ...theme.type.body,
  },
  assistantRow: {
    marginVertical: 10,
    paddingHorizontal: theme.spacing.md,
  },
  assistantBody: {
    gap: 2,
  },
  textSeg: {},
  caret: {
    ...theme.type.body,
    fontWeight: '600',
  },
  dots: {
    ...theme.type.body,
    letterSpacing: 2,
  },
  systemRow: {
    alignItems: 'center',
    marginVertical: 10,
    paddingHorizontal: theme.spacing.lg,
  },
  systemText: {
    fontSize: 12,
    lineHeight: 16,
    textAlign: 'center',
  },
});
