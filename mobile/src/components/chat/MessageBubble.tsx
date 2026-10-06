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
import React, { useMemo, useRef, useEffect, useState } from 'react';
import { View, Text, StyleSheet, Animated, TouchableOpacity } from 'react-native';
import { theme } from '../../theme';
import Ionicons from '@expo/vector-icons/Ionicons';
import MarkdownText from './MarkdownText';
import ThinkingBlock from './ThinkingBlock';
import ActivityRow, { type ToolData } from './ActivityRow';
import { parseAttachments, MessageAttachmentCards, LocalImageCards } from './MessageAttachments';
import { formatDuration } from '../../lib/format';

export type { ToolData };

export interface MessageBubbleProps {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** True while tokens are still arriving — shows the live caret indicator. */
  streaming?: boolean;
  /** Diff peek (desktop DiffCard parity) — forwarded to file tool rows. */
  onPeekDiff?: (path: string) => void;
  /** Images held locally for the optimistic just-sent message — rendered
   *  from data URIs with zero round-trip. */
  liveImages?: { name: string; dataUri: string }[];
  /** Turn duration in seconds (desktop durationSec parity) — drives the
   *  "Worked for Xs" fold header on process turns. */
  workedForSec?: number | null;
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

function AssistantContent({
  content,
  streaming,
  onPeekDiff,
  workedForSec,
}: {
  content: string;
  streaming: boolean;
  onPeekDiff?: (path: string) => void;
  workedForSec?: number | null;
}) {
  const segments = useMemo(() => parseSegments(content), [content]);
  const empty = content.length === 0;

  if (empty) return streaming ? <TypingDots /> : null;

  // DESKTOP TURN-FOLD PARITY: process segments (thinking + tool calls) up to
  // and including the LAST one fold into a collapsible "Worked for Xs"
  // disclosure — auto-expanded while the turn streams, auto-collapsed when
  // it ends. Text after the last process block (the final answer) renders
  // outside, always visible — exactly the desktop's inside/outside split.
  const lastProc = segments.reduce((last, seg, i) => (seg.type !== 'text' ? i : last), -1);
  const hasProcess = lastProc !== -1;

  const renderSeg = (seg: Segment, i: number, isLast: boolean) => {
    switch (seg.type) {
      case 'think':
        return <ThinkingBlock key={i} thinking={seg.text} done={seg.done} />;
      case 'tool':
        return (
          <ActivityRow key={i} data={seg.data} raw={seg.raw} done={seg.done} onPeekDiff={onPeekDiff} />
        );
      default:
        return (
          <View key={i} style={styles.textSeg}>
            <MarkdownText content={seg.text} />
            {streaming && isLast ? <Caret /> : null}
          </View>
        );
    }
  };

  // Live turn: everything expanded (desktop parity — the live process is the
  // "what's happening" view).
  if (streaming || !hasProcess) {
    return (
      <View style={styles.assistantBody}>
        {segments.map((seg, i) => renderSeg(seg, i, i === segments.length - 1))}
        {/* Stream ends inside a think/tool block (no trailing text segment) —
            hang the caret off the row so "still working" stays visible. */}
        {streaming && segments[segments.length - 1]?.type !== 'text' ? <Caret /> : null}
      </View>
    );
  }

  // Finished turn with process: fold [0..lastProc], render the answer after.
  const inside = segments.slice(0, lastProc + 1);
  const outside = segments.slice(lastProc + 1);
  return (
    <View style={styles.assistantBody}>
      <TurnProcessFold workedForSec={workedForSec}>
        {inside.map((seg, i) => renderSeg(seg, i, false))}
      </TurnProcessFold>
      {outside.map((seg, i) => renderSeg(seg, i, i === outside.length - 1))}
    </View>
  );
}

/** Collapsed "Worked for Xs" summary for a finished turn's process region —
 *  the phone twin of the desktop's ProcessSummary toggle. The label IS the
 *  timer (desktop parity); a duration-less turn reads plain "Worked". */
function TurnProcessFold({
  workedForSec,
  children,
}: {
  workedForSec?: number | null;
  children: React.ReactNode;
}) {
  const c = theme.colors;
  const [open, setOpen] = useState(false);
  const label = workedForSec != null && workedForSec > 0
    ? `Worked for ${formatDuration(workedForSec)}`
    : 'Worked';
  return (
    <View>
      <TouchableOpacity
        // Plain row, like the desktop's process summary: no card, no border —
        // the label + caret are the whole affordance.
        style={styles.foldHeader}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`${label} — show process`}
        onPress={() => setOpen((v) => !v)}
      >
        <Text style={[styles.foldLabel, { color: c.textSecondary }]}>{label}</Text>
        <Ionicons
          name={open ? 'chevron-up' : 'chevron-down'}
          size={14}
          color={c.textSecondary}
        />
      </TouchableOpacity>
      {open ? <View style={styles.foldBody}>{children}</View> : null}
    </View>
  );
}

export default function MessageBubble({
  role,
  content,
  streaming = false,
  onPeekDiff,
  liveImages,
  workedForSec,
}: MessageBubbleProps) {
  const c = theme.colors;
  // Attachment markers live in the content for BOTH roles (user messages carry
  // them; parse before any branch so hook order stays stable).
  const { attachments, text: cleanedContent } = useMemo(() => parseAttachments(content), [content]);

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
    // Render attachment preview cards above the text (desktop parity); the
    // raw "[Attached image: …|C:\…]" marker never shows.
    return (
      <View style={styles.userRow}>
        <View style={[styles.userBubble, { backgroundColor: c.bubble }]}>
          <LocalImageCards images={liveImages ?? []} />
          <MessageAttachmentCards attachments={attachments} />
          {cleanedContent ? <Text style={[styles.userText, { color: c.text }]}>{cleanedContent}</Text> : null}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.assistantRow}>
      <AssistantContent
        content={content}
        streaming={streaming}
        onPeekDiff={onPeekDiff}
        workedForSec={workedForSec}
      />
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
  foldHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    alignSelf: 'flex-start',
    paddingVertical: 4,
  },
  foldLabel: { fontSize: 13, fontWeight: '600' },
  foldBody: { paddingTop: 6, gap: 2 },
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
