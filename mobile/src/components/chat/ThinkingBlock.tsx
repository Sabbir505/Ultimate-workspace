/**
 * ThinkingBlock — the "Thought process" disclosure for `<think>` segments.
 *
 * Collapsed by default — while the reasoning is still streaming AND once the
 * turn finishes (the desktop transcript made the same call: a live block
 * shoving the answer down on every token read as noise). A tap opens it;
 * nothing auto-collapses afterwards, so the row stays where the user put it.
 * The body renders in the secondary typeface, muted and italic — it's
 * context, not content.
 */
import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { theme } from '../../theme';

// M4: Ionicons glyph-font wrapper preserving the lucide call-shape.
const ChevronDown = ({ size, color }: { size?: number; color?: string }) => (
  <Ionicons name="chevron-down" size={size} color={color} />
);

export interface ThinkingBlockProps {
  thinking: string;
  /** True when the closing `</think>` has streamed in. */
  done: boolean;
}

export default function ThinkingBlock({ thinking, done }: ThinkingBlockProps) {
  const c = theme.colors;
  const [open, setOpen] = useState(false);

  return (
    <View style={styles.wrap}>
      <TouchableOpacity
        style={styles.head}
        activeOpacity={0.7}
        onPress={() => setOpen((v) => !v)}
        accessibilityLabel={open ? 'Hide thought process' : 'Show thought process'}
      >
        <Text style={[styles.label, { color: c.textSecondary }]}>
          {done ? 'Thought process' : 'Thinking…'}
        </Text>
        <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}>
          <ChevronDown size={14} color={c.textSecondary} />
        </View>
      </TouchableOpacity>

      {open ? (
        <Text style={[styles.body, { color: c.textSecondary }]}>{thinking}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.border,
    paddingLeft: 10,
    marginVertical: 6,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
  },
  label: {
    ...theme.type.label,
  },
  body: {
    ...theme.type.secondary,
    fontStyle: 'italic',
    paddingBottom: 6,
  },
});
