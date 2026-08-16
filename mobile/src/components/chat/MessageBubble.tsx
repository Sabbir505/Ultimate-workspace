/**
 * MessageBubble — renders a single chat message for the SessionChat screen.
 *
 * The bubble supports three content shapes:
 *  - "user"        — plain user-typed text. Right-aligned, accent-tinted.
 *  - "assistant"   — markdown-rendered, code-fenced, with think-block support.
 *  - "system"      — small grey centered status line.
 *
 * Streaming mode: a live assistant bubble shows a blinking caret at the
 * tail of the text and disables markdown for the duration of the stream
 * (re-renders on every token otherwise thrash the markdown pipeline).
 *
 * Markdown rendering: we use a small purpose-built renderer that handles
 * fenced code blocks, inline code, **bold**, *italic*, line breaks, and
 * a <think>…</think> block (the desktop emits reasoning tokens with a
 * <think> prefix). We intentionally do NOT pull in a heavy markdown lib
 * to keep the bundle small — the desktop composer renders full markdown
 * but the phone shows a lighter subset.
 */
import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { theme } from '../../theme';

export interface MessageBubbleProps {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** True while tokens are still arriving — disables markdown + shows caret. */
  streaming?: boolean;
  /** Optional timestamp (unix seconds) shown under the bubble. */
  createdAt?: number;
  /** Optional cost / token chip rendered under assistant bubbles. */
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
}

interface Block {
  kind: 'think' | 'code' | 'p';
  lang?: string;
  text: string;
}

/**
 * Pre-parse the content into a list of blocks. Fenced code blocks become
 * a single "code" block; <think>…</think> spans become a "think" block;
 * everything else is paragraph text rendered as inline markdown.
 */
function parseBlocks(raw: string): Block[] {
  const blocks: Block[] = [];
  let text = raw;

  // Pull out <think>…</think> first so subsequent parsing isn't confused
  // by the angle brackets in the body.
  const thinkRe = /<think>([\s\S]*?)<\/think>/g;
  let m: RegExpExecArray | null;
  while ((m = thinkRe.exec(text)) !== null) {
    blocks.push({ kind: 'think', text: m[1]!.trim() });
  }
  text = text.replace(thinkRe, '');

  // Then fenced code blocks.
  const fenceRe = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  while ((m = fenceRe.exec(text)) !== null) {
    if (m.index > lastIndex) {
      const between = text.slice(lastIndex, m.index);
      if (between.trim()) blocks.push({ kind: 'p', text: between });
    }
    blocks.push({ kind: 'code', lang: m[1] || undefined, text: m[2]! });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) {
    const tail = text.slice(lastIndex);
    if (tail.trim()) blocks.push({ kind: 'p', text: tail });
  }
  return blocks;
}

/** Render a single text run with inline markdown: **bold**, *italic*, `code`. */
function renderInline(text: string, baseStyle: object) {
  // Split on inline tokens but keep the delimiter positions so we can
  // apply the right style. Three separate passes keep the code obvious.
  const tokens: { kind: 'text' | 'bold' | 'italic' | 'code'; value: string }[] = [];
  // Order matters: code spans contain backticks so we strip them first.
  const codeRe = /`([^`\n]+)`/g;
  let remaining = text;
  let m: RegExpExecArray | null;
  let lastIndex = 0;
  while ((m = codeRe.exec(remaining)) !== null) {
    if (m.index > lastIndex) {
      tokens.push({ kind: 'text', value: remaining.slice(lastIndex, m.index) });
    }
    tokens.push({ kind: 'code', value: m[1]! });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < remaining.length) {
    const rest = remaining.slice(lastIndex);
    // Then bold and italic (non-greedy, single-line).
    const boldRe = /\*\*([^*\n]+)\*\*/g;
    let bi = 0;
    let bm: RegExpExecArray | null;
    let restLast = 0;
    while ((bm = boldRe.exec(rest)) !== null) {
      if (bm.index > restLast) {
        const slice = rest.slice(restLast, bm.index);
        // Try italic inside the slice.
        pushItalic(slice, tokens);
      }
      tokens.push({ kind: 'bold', value: bm[1]! });
      restLast = bm.index + bm[0].length;
    }
    if (restLast < rest.length) pushItalic(rest.slice(restLast), tokens);
  }
  return tokens.map((t, i) => {
    switch (t.kind) {
      case 'bold':
        return (
          <Text key={i} style={[baseStyle, styles.bold]}>
            {t.value}
          </Text>
        );
      case 'italic':
        return (
          <Text key={i} style={[baseStyle, styles.italic]}>
            {t.value}
          </Text>
        );
      case 'code':
        return (
          <Text key={i} style={[baseStyle, styles.inlineCode]}>
            {t.value}
          </Text>
        );
      default:
        return (
          <Text key={i} style={baseStyle}>
            {t.value}
          </Text>
        );
    }
  });
}

function pushItalic(s: string, tokens: { kind: 'text' | 'bold' | 'italic' | 'code'; value: string }[]) {
  const re = /\*([^*\n]+)\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) tokens.push({ kind: 'text', value: s.slice(last, m.index) });
    tokens.push({ kind: 'italic', value: m[1]! });
    last = m.index + m[0].length;
  }
  if (last < s.length) tokens.push({ kind: 'text', value: s.slice(last) });
}

function formatTime(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatCost(costUsd?: number): string | null {
  if (costUsd == null) return null;
  if (costUsd < 0.001) return '<$0.001';
  if (costUsd < 1) return `$${costUsd.toFixed(3)}`;
  return `$${costUsd.toFixed(2)}`;
}

export default function MessageBubble({
  role,
  content,
  streaming = false,
  createdAt,
  usage,
}: MessageBubbleProps) {
  const blocks = useMemo(() => (streaming ? null : parseBlocks(content)), [content, streaming]);
  const isUser = role === 'user';
  const isSystem = role === 'system';

  if (isSystem) {
    return (
      <View style={styles.systemRow}>
        <Text style={[styles.systemText, { color: theme.colors.textSecondary }]} numberOfLines={2}>
          {content}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.row, isUser ? styles.rowUser : styles.rowAssistant]}>
      <View
        style={[
          styles.bubble,
          isUser
            ? [styles.bubbleUser, { backgroundColor: theme.colors.primary }]
            : [styles.bubbleAssistant, { backgroundColor: theme.colors.surface2, borderColor: theme.colors.border }],
        ]}
      >
        {streaming ? (
          <Text style={[styles.body, { color: theme.colors.text }]}>
            {content}
            <Text style={[styles.caret, { color: theme.colors.primary }]}>▍</Text>
          </Text>
        ) : (
          blocks!.map((b, i) => {
            if (b.kind === 'think') {
              return (
                <View key={i} style={[styles.thinkBlock, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
                  <Text style={[styles.thinkLabel, { color: theme.colors.textSecondary }]}>Thinking</Text>
                  <Text style={[styles.thinkText, { color: theme.colors.textSecondary }]}>
                    {renderInline(b.text, styles.thinkTextRun)}
                  </Text>
                </View>
              );
            }
            if (b.kind === 'code') {
              return (
                <View key={i} style={[styles.codeBlock, { backgroundColor: theme.colors.background, borderColor: theme.colors.border }]}>
                  {b.lang ? (
                    <Text style={[styles.codeLang, { color: theme.colors.textSecondary }]}>{b.lang}</Text>
                  ) : null}
                  <Text style={[styles.codeText, { color: theme.colors.text }]}>{b.text}</Text>
                </View>
              );
            }
            return (
              <Text key={i} style={[styles.body, { color: isUser ? '#fff' : theme.colors.text }]}>
                {renderInline(b.text, styles.bodyRun)}
              </Text>
            );
          })
        )}
      </View>
      {(createdAt || usage || streaming) && (
        <View style={[styles.metaRow, isUser ? styles.metaRowUser : styles.metaRowAssistant]}>
          {streaming ? (
            <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>streaming…</Text>
          ) : createdAt ? (
            <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>{formatTime(createdAt)}</Text>
          ) : null}
          {!streaming && usage ? (
            <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>
              {` · ${usage.inputTokens}↓ ${usage.outputTokens}↑`}
              {formatCost(usage.costUsd) ? ` · ${formatCost(usage.costUsd)}` : ''}
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { marginVertical: 4, paddingHorizontal: 12 },
  rowUser: { alignItems: 'flex-end' },
  rowAssistant: { alignItems: 'flex-start' },
  bubble: {
    maxWidth: '92%',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 16,
  },
  bubbleUser: { borderBottomRightRadius: 4 },
  bubbleAssistant: { borderWidth: StyleSheet.hairlineWidth, borderBottomLeftRadius: 4 },
  body: { fontSize: 15, lineHeight: 22 },
  bodyRun: { fontSize: 15, lineHeight: 22 },
  caret: { fontSize: 15, lineHeight: 22 },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  inlineCode: {
    fontFamily: 'monospace',
    fontSize: 13,
    backgroundColor: 'rgba(0,0,0,0.05)',
  },
  thinkBlock: {
    borderLeftWidth: 3,
    paddingVertical: 6,
    paddingHorizontal: 10,
    marginVertical: 6,
    borderRadius: 6,
  },
  thinkLabel: { fontSize: 11, fontWeight: '600', marginBottom: 4, textTransform: 'uppercase' },
  thinkText: { fontSize: 13, lineHeight: 19 },
  thinkTextRun: { fontSize: 13, lineHeight: 19 },
  codeBlock: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: 10,
    marginVertical: 6,
  },
  codeLang: { fontSize: 11, marginBottom: 6, fontFamily: 'monospace' },
  codeText: { fontFamily: 'monospace', fontSize: 13, lineHeight: 19 },
  metaRow: { flexDirection: 'row', marginTop: 2, paddingHorizontal: 4 },
  metaRowUser: { justifyContent: 'flex-end' },
  metaRowAssistant: { justifyContent: 'flex-start' },
  metaText: { fontSize: 11 },
  systemRow: { alignItems: 'center', marginVertical: 6, paddingHorizontal: 24 },
  systemText: { fontSize: 12, fontStyle: 'italic', textAlign: 'center' },
});
