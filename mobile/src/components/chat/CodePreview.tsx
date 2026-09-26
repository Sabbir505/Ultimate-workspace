/**
 * CodePreview — a dependency-free, themed syntax highlighter for artifact
 * code files (the desktop's code preview, phone-sized). Tokenizes per line
 * with a small rules engine (comments, strings, numbers, keywords, punct)
 * and renders colored Text runs with line numbers — no highlighter
 * dependency, works inside the sheet's ScrollView, and streams fine because
 * the content arrives as one string.
 */
import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { theme } from '../../theme';

type Lang = 'js' | 'ts' | 'py' | 'html' | 'css' | 'json' | 'rs' | 'go' | 'sh' | 'yaml' | 'sql' | 'txt';

const KEYWORDS: Record<Lang, Set<string>> = {
  js: new Set('const let var function return if else for while class extends new await async import export from default try catch finally throw typeof instanceof of in this null undefined true false switch case break continue do delete void yield static get set'.split(' ')),
  ts: new Set('const let var function return if else for while class extends implements interface type enum new await async import export from default try catch finally throw typeof instanceof of in this null undefined true false switch case break continue do delete void yield readonly public private protected static get set as satisfies keyof infer'.split(' ')),
  py: new Set('def class return if elif else for while import from as pass break continue try except finally raise with lambda None True False and or not in is yield global nonlocal async await assert del'.split(' ')),
  html: new Set('html head body div span p a img script style link meta title h1 h2 h3 h4 h5 h6 ul ol li table tr td th input button form section header footer nav main code pre'.split(' ')),
  css: new Set('important media supports keyframes import from to and not only root'.split(' ')),
  json: new Set('true false null'.split(' ')),
  rs: new Set('fn let mut const struct enum impl trait pub use mod match if else for while loop return async await move ref self Self where as in crate super unsafe dyn'.split(' ')),
  go: new Set('func package import var const type struct interface map chan go defer if else for range return switch case default break continue select fallthrough nil true false'.split(' ')),
  sh: new Set('if then else elif fi for while do done case esac function return export local echo cd source'.split(' ')),
  yaml: new Set([]),
  sql: new Set('select from where insert into values update set delete create table alter drop join left right inner outer on group by order having limit as not null and or'.split(' ')),
  txt: new Set([]),
};

const COLORS = {
  keyword: '#c084fc',
  string: '#86efac',
  number: '#fbbf24',
  comment: '#64748b',
  punct: '#94a3b8',
  plain: '#e2e8f0',
  tag: '#f472b6',
  attr: '#fbbf24',
} as const;

type Tok = { text: string; color: string };

function tokenizeLine(line: string, lang: Lang): Tok[] {
  const out: Tok[] = [];
  const kw = KEYWORDS[lang] ?? KEYWORDS.txt;
  const isHtml = lang === 'html';
  const lineComment = lang === 'py' || lang === 'sh' || lang === 'yaml' || lang === 'sql' || lang === 'rs' || lang === 'go';
  const blockPairs: [string, string] = isHtml ? ['<!--', '-->'] : ['/*', '*/'];
  let i = 0;
  let buf = '';
  const flush = () => {
    if (!buf) return;
    // keyword / number / plain within the buffer
    const parts = buf.split(/(\s+|[A-Za-z_$][\w$]*|\d+(?:\.\d+)?)/g);
    for (const p of parts) {
      if (!p) continue;
      if (kw.has(p)) out.push({ text: p, color: COLORS.keyword });
      else if (/^\d/.test(p)) out.push({ text: p, color: COLORS.number });
      else if (/^[A-Za-z_$]/.test(p)) out.push({ text: p, color: COLORS.plain });
      else out.push({ text: p, color: COLORS.punct });
    }
    buf = '';
  };
  while (i < line.length) {
    const rest = line.slice(i);
    // block comment start
    if (rest.startsWith(blockPairs[0])) {
      flush();
      const end = rest.indexOf(blockPairs[1], blockPairs[0].length);
      const stop = end >= 0 ? end + blockPairs[1].length : rest.length;
      out.push({ text: rest.slice(0, stop), color: COLORS.comment });
      i += stop;
      continue;
    }
    // line comment
    if ((lineComment && (rest.startsWith('//') || rest.startsWith('#'))) || (isHtml && rest.startsWith('<!--'))) {
      flush();
      out.push({ text: rest, color: COLORS.comment });
      break;
    }
    // strings
    const q = line[i];
    if (q === '"' || q === "'" || q === '`') {
      flush();
      let j = i + 1;
      while (j < line.length && line[j] !== q) {
        if (line[j] === '\\') j++;
        j++;
      }
      out.push({ text: line.slice(i, Math.min(j + 1, line.length)), color: COLORS.string });
      i = j + 1;
      continue;
    }
    // html tag name / attribute coloring
    if (isHtml && q === '<') {
      flush();
      const m = /^<\/?[A-Za-z][\w-]*/.exec(rest);
      if (m) {
        out.push({ text: m[0], color: COLORS.tag });
        i += m[0].length;
        continue;
      }
    }
    buf += q;
    i++;
  }
  flush();
  return out;
}

export function extToLang(filename: string): Lang {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const map: Record<string, Lang> = {
    js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
    ts: 'ts', tsx: 'ts',
    py: 'py', rb: 'txt', go: 'go', rs: 'rs', sh: 'sh', bash: 'sh',
    css: 'css', scss: 'css', less: 'css',
    json: 'json', yml: 'yaml', yaml: 'yaml', sql: 'sql', toml: 'yaml',
    html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html',
  };
  return map[ext] ?? 'txt';
}

export default React.memo(function CodePreview({
  code,
  filename,
  startLine = 1,
  showLineNumbers = true,
}: {
  code: string;
  filename: string;
  startLine?: number;
  showLineNumbers?: boolean;
}) {
  const c = theme.colors;
  const lang = useMemo(() => extToLang(filename), [filename]);
  const lines = useMemo(() => code.replace(/\r\n/g, '\n').split('\n'), [code]);
  // Tokenize ONCE per (code, lang), not per render: a large artifact
  // re-tokenized its every line — rebuilding the whole nested Text tree —
  // on every parent re-render (poll tick, webLoading toggle, theme change).
  const tokenized = useMemo(
    () => lines.map((line) => tokenizeLine(line, lang)),
    [lines, lang],
  );
  return (
    <View style={styles.wrap}>
      {tokenized.map((tokens, idx) => (
        <View key={idx} style={styles.line}>
          {showLineNumbers ? (
            <Text style={[styles.ln, { color: c.textSecondary }]}>
              {String(startLine + idx).padStart(3, ' ')}
            </Text>
          ) : null}
          <Text style={styles.code} selectable>
            {tokens.map((t, j) => (
              <Text key={j} style={{ color: t.color }}>
                {t.text}
              </Text>
            ))}
            {lines[idx]!.length === 0 ? ' ' : ''}
          </Text>
        </View>
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { paddingVertical: 6 },
  line: { flexDirection: 'row', paddingHorizontal: 2 },
  ln: {
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 17,
    marginRight: 10,
    opacity: 0.6,
  },
  code: { fontFamily: 'monospace', fontSize: 12, lineHeight: 17, flex: 1 },
});
