import React from 'react';
import { Text, StyleSheet, Platform } from 'react-native';
import { useTheme } from '../theme';

// Cross-platform monospace: Android has 'monospace', iOS needs a named face.
const MONO = Platform.select({ ios: 'Courier New', android: 'monospace', default: 'monospace' });

interface AnsiRendererProps { text: string; fontSize?: number; }

interface TextSegment { text: string; color?: string; bold?: boolean; italic?: boolean; underline?: boolean; }

function makeAnsiColors(isDark: boolean): Record<string, string> {
  return {
    '30': isDark ? '#c9d1d9' : '#3D322C',
    '31': '#E53935', '32': '#4CAF50', '33': '#FF9800', '34': '#2196F3',
    '35': '#9C27B0', '36': '#00BCD4',
    '37': isDark ? '#c9d1d9' : '#7A6F67',
    '90': isDark ? '#8b949e' : '#7A6F67',
    '91': '#FF5252', '92': '#69F0AE', '93': '#FFD740', '94': '#448AFF',
    '95': '#E040FB', '96': '#18FFFF',
    '97': isDark ? '#FFFFFF' : '#1a1a1a',
  };
}

function parseAnsi(input: string, isDark: boolean): TextSegment[] {
  const colors = makeAnsiColors(isDark);
  const segments: TextSegment[] = [];
  const regex = /\x1b\[(\d+(?:;\d+)*)m/g;
  let lastIndex = 0;
  let style: TextSegment = { text: '' };
  let m: RegExpExecArray | null;
  while ((m = regex.exec(input)) !== null) {
    if (m.index > lastIndex) segments.push({ ...style, text: input.slice(lastIndex, m.index) });
    const codes = m[1].split(';').map(Number);
    if (codes[0] === 0) { style = { text: '' }; }
    else for (const c of codes) {
      if (c === 1) style.bold = true; else if (c === 3) style.italic = true;
      else if (c === 4) style.underline = true;
      else if (colors[c.toString()]) style.color = colors[c.toString()];
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < input.length) segments.push({ ...style, text: input.slice(lastIndex) });
  return segments.length > 0 ? segments : [{ text: input }];
}

export default function AnsiRenderer({ text, fontSize = 12 }: AnsiRendererProps) {
  const { isDark } = useTheme();
  const segments = parseAnsi(text, isDark);
  const defColor = isDark ? '#c9d1d9' : '#3D322C';
  return (
    <Text style={[styles.container, { fontSize, lineHeight: Math.round(fontSize * 1.35) }]}>
      {segments.map((seg, i) => (
        <Text key={i} style={[
          seg.bold && styles.bold, seg.italic && styles.italic,
          seg.underline && styles.underline,
          { color: seg.color || defColor },
        ]}>
          {seg.text}
        </Text>
      ))}
    </Text>
  );
}

const styles = StyleSheet.create({
  container: { fontFamily: MONO, fontSize: 12, lineHeight: 16 },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  underline: { textDecorationLine: 'underline' },
});