/**
 * MarkdownText — a small, hand-rolled markdown renderer for assistant text.
 *
 * The ChatGPT-app look renders assistant replies as full-width plain text,
 * so this is the workhorse for every text segment. It upgrades the old
 * inline-subset renderer with:
 *
 *   - paragraphs (body 16/24)
 *   - **bold**, *italic*, _italic_, `inline code` (mono, surface2 pill)
 *   - fenced code blocks (mono 13, surface2 bg, language label row,
 *     horizontal scroll — long lines scroll instead of wrapping)
 *   - unordered / ordered lists (indent + marker)
 *   - links [text](url) in accent color, opened via Linking
 *   - headings # / ## / ### → scaled weight + size
 *   - simple pipe tables (flex rows, hairline borders, capped at 6 columns)
 *
 * Deliberately NO markdown dependency: the phone renders a light subset,
 * and the renderer is a PURE FUNCTION of the content string so streaming
 * re-renders stay cheap and predictable (unterminated fences degrade to a
 * code-to-end block, unterminated emphasis renders as literal text).
 */
import React, { memo, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Linking,
  type StyleProp,
  type TextStyle,
} from 'react-native';
import { theme } from '../../theme';

// ---------------------------------------------------------------------------
// Parsing (pure)
// ---------------------------------------------------------------------------

type InlineToken =
  | { kind: 'text'; value: string }
  | { kind: 'bold'; value: string }
  | { kind: 'italic'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'link'; value: string; url: string };

type Block =
  | { type: 'p'; text: string }
  | { type: 'code'; lang?: string; code: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'h'; level: 1 | 2 | 3; text: string }
  | { type: 'table'; header: string[]; rows: string[][] };

/** Inline tokenizer: one combined pass so constructs emit in source order.
 *  Alternation order gives the right precedence: code spans win first, then
 *  bold over italic at the same position, then links. */
const INLINE_RE =
  /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|_([^_\n]+)_|\[([^\]\n]+)\]\(([^()\s]+)\)/g;

function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let last = 0;
  const re = new RegExp(INLINE_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) tokens.push({ kind: 'text', value: text.slice(last, m.index) });
    if (m[1] !== undefined) tokens.push({ kind: 'code', value: m[1] });
    else if (m[2] !== undefined) tokens.push({ kind: 'bold', value: m[2] });
    else if (m[3] !== undefined) tokens.push({ kind: 'italic', value: m[3] });
    else if (m[4] !== undefined) tokens.push({ kind: 'italic', value: m[4] });
    else if (m[5] !== undefined && m[6] !== undefined) {
      tokens.push({ kind: 'link', value: m[5], url: m[6] });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) tokens.push({ kind: 'text', value: text.slice(last) });
  return tokens;
}

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((cell) => cell.trim());
}

const FENCE_OPEN_RE = /^\s*```(.*)$/;
const FENCE_CLOSE_RE = /^\s*```\s*$/;
const H_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const UL_ITEM_RE = /^\s*[-*+]\s+(.*)$/;
const OL_ITEM_RE = /^\s*\d+[.)]\s+(.*)$/;
const TABLE_DELIM_RE = /^\s*\|?\s*:?-{2,}[\s:|-]*$/;

/** Block parser: a single line scan. Unterminated constructs (mid-stream)
 *  degrade gracefully — an unclosed fence becomes code-to-end, stray list
 *  rows become lists, everything else is paragraph text. */
function parseBlocks(content: string): Block[] {
  const lines = content.split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length > 0) {
      blocks.push({ type: 'p', text: para.join('\n') });
      para = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';

    const fence = FENCE_OPEN_RE.exec(line);
    if (fence) {
      flushPara();
      const lang = fence[1]?.trim() || undefined;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_CLOSE_RE.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      i += 1; // skip the closing fence (or run to EOF mid-stream)
      blocks.push({ type: 'code', lang, code: body.join('\n') });
      continue;
    }

    const h = H_RE.exec(line);
    if (h) {
      flushPara();
      const level = Math.min(h[1]?.length ?? 1, 3) as 1 | 2 | 3;
      blocks.push({ type: 'h', level, text: h[2] ?? '' });
      i += 1;
      continue;
    }

    if (UL_ITEM_RE.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length) {
        const m = UL_ITEM_RE.exec(lines[i] ?? '');
        if (!m) break;
        items.push(m[1] ?? '');
        i += 1;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    if (OL_ITEM_RE.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length) {
        const m = OL_ITEM_RE.exec(lines[i] ?? '');
        if (!m) break;
        items.push(m[1] ?? '');
        i += 1;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }

    // Pipe table: current row contains `|` and the next line is a delimiter.
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      TABLE_DELIM_RE.test(lines[i + 1] ?? '')
    ) {
      flushPara();
      const header = splitTableRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? '').includes('|')) {
        rows.push(splitTableRow(lines[i] ?? ''));
        i += 1;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }

    if (line.trim() === '') {
      flushPara();
      i += 1;
      continue;
    }

    para.push(line);
    i += 1;
  }
  flushPara();
  return blocks;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** One row of inline tokens. `baseStyle` carries the size/lineHeight/color of
 *  the enclosing block; each token overlays its own style on top. */
function InlineRun({
  text,
  baseStyle,
}: {
  text: string;
  baseStyle: StyleProp<TextStyle>;
}) {
  const tokens = useMemo(() => parseInline(text), [text]);
  return (
    <>
      {tokens.map((t, i) => {
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
              <Text key={i} style={[baseStyle, styles.inlineCode, { backgroundColor: theme.colors.surface2 }]}>
                {t.value}
              </Text>
            );
          case 'link':
            return (
              <Text
                key={i}
                style={[baseStyle, styles.link, { color: theme.colors.accent }]}
                onPress={() => {
                  // Links are always absolute-ish http(s) — never navigate.
                  void Linking.openURL(t.url).catch(() => {});
                }}
              >
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
      })}
    </>
  );
}

const MAX_TABLE_COLUMNS = 6;

function CodeBlock({ lang, code }: { lang?: string; code: string }) {
  const c = theme.colors;
  return (
    <View style={[styles.codeBlock, { backgroundColor: c.surface2 }]}>
      {lang ? (
        <View style={styles.codeLangRow}>
          <Text style={[styles.codeLang, { color: c.textSecondary }]}>{lang}</Text>
        </View>
      ) : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.codeScroll}
      >
        <Text style={[styles.codeText, { color: c.text }]}>{code}</Text>
      </ScrollView>
    </View>
  );
}

function TableBlock({ header, rows }: { header: string[]; rows: string[][] }) {
  const c = theme.colors;
  const cols = Math.max(1, Math.min(header.length, MAX_TABLE_COLUMNS));
  const cellStyle = [styles.td, { borderColor: c.border }];
  return (
    <View style={[styles.table, { borderColor: c.border }]}>
      <View style={[styles.tr, styles.thRow, { borderColor: c.border, backgroundColor: c.surface2 }]}>
        {header.slice(0, MAX_TABLE_COLUMNS).map((h, i) => (
          <View key={i} style={[cellStyle, i > 0 && styles.tdNotFirst]}>
            <Text style={[styles.tdText, { color: c.text }, styles.bold]}>
              <InlineRun text={h} baseStyle={styles.tdTextRun} />
            </Text>
          </View>
        ))}
      </View>
      {rows.map((row, r) => (
        <View key={r} style={[styles.tr, { borderColor: c.border }]}>
          {row.slice(0, MAX_TABLE_COLUMNS).map((cell, i) => (
            <View key={i} style={[cellStyle, i > 0 && styles.tdNotFirst]}>
              <Text style={[styles.tdText, { color: c.text }]}>
                <InlineRun text={cell} baseStyle={styles.tdTextRun} />
              </Text>
            </View>
          ))}
          {/* Pad short rows so the hairline grid stays rectangular. */}
          {Array.from({ length: Math.max(0, cols - row.length) }, (_, i) => (
            <View key={`pad-${i}`} style={[cellStyle, styles.tdNotFirst]} />
          ))}
        </View>
      ))}
    </View>
  );
}

function MarkdownTextImpl({ content }: { content: string }) {
  const c = theme.colors;
  const blocks = useMemo(() => parseBlocks(content), [content]);

  return (
    <View style={styles.root}>
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'code':
            return <CodeBlock key={i} lang={b.lang} code={b.code} />;
          case 'h': {
            const style =
              b.level === 1 ? styles.h1 : b.level === 2 ? styles.h2 : styles.h3;
            return (
              <Text key={i} style={[style, { color: c.text }]}>
                {b.text}
              </Text>
            );
          }
          case 'ul':
          case 'ol':
            return (
              <View key={i} style={styles.list}>
                {b.items.map((it, j) => (
                  <View key={j} style={styles.li}>
                    <Text style={[styles.liMarker, { color: c.textSecondary }]}>
                      {b.type === 'ul' ? '•' : `${j + 1}.`}
                    </Text>
                    <Text style={[styles.liText, { color: c.text }]}>
                      <InlineRun text={it} baseStyle={styles.bodyRun} />
                    </Text>
                  </View>
                ))}
              </View>
            );
          case 'table':
            return <TableBlock key={i} header={b.header} rows={b.rows} />;
          default:
            return (
              <Text key={i} style={[styles.body, { color: c.text }]}>
                <InlineRun text={b.text} baseStyle={styles.bodyRun} />
              </Text>
            );
        }
      })}
    </View>
  );
}

/** Memoized: the same content string never re-runs the parser. Streaming
 *  calls pass a new string each flush, finalized messages are stable. */
const MarkdownText = memo(MarkdownTextImpl);
export default MarkdownText;

const styles = StyleSheet.create({
  root: {},
  body: {
    ...theme.type.body,
    marginBottom: theme.spacing.sm,
  },
  bodyRun: {
    ...theme.type.body,
  },
  h1: { fontSize: 20, lineHeight: 28, fontWeight: '700', marginTop: 4, marginBottom: theme.spacing.sm },
  h2: { fontSize: 18, lineHeight: 26, fontWeight: '600', marginTop: 4, marginBottom: theme.spacing.sm },
  h3: { ...theme.type.body, fontWeight: '600', marginTop: 4, marginBottom: theme.spacing.sm },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  link: { textDecorationLine: 'underline' },
  inlineCode: {
    fontFamily: 'monospace',
    fontSize: 14,
    borderRadius: 6,
    overflow: 'hidden',
    paddingHorizontal: 2,
  },
  list: { marginBottom: theme.spacing.sm },
  li: { flexDirection: 'row', marginBottom: 4 },
  liMarker: { width: 22, ...theme.type.body },
  liText: { flex: 1, ...theme.type.body },
  codeBlock: {
    borderRadius: theme.radius.md,
    marginBottom: theme.spacing.sm,
    overflow: 'hidden',
  },
  codeLangRow: {
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
  },
  codeLang: {
    ...theme.type.label,
    fontFamily: 'monospace',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  codeScroll: { padding: theme.spacing.md },
  codeText: {
    ...theme.type.mono,
    fontFamily: 'monospace',
  },
  table: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.radius.sm,
    overflow: 'hidden',
    marginBottom: theme.spacing.sm,
  },
  tr: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  thRow: {},
  td: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 6,
    paddingHorizontal: theme.spacing.sm,
  },
  tdNotFirst: { borderLeftWidth: StyleSheet.hairlineWidth },
  tdText: { flex: 1 },
  tdTextRun: { fontSize: 13, lineHeight: 18 },
});
