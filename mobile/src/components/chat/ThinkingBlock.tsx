/**
 * ThinkingBlock — the "Thought process" disclosure for `<think>` segments.
 *
 * ChatGPT-app behavior: the block is expanded while the reasoning is still
 * streaming (done === false), auto-collapses to a one-line summary the
 * moment the turn finishes, and a manual toggle by the user overrides the
 * auto-collapse for the life of the row. The body renders in the secondary
 * typeface, muted and italic — it's context, not content.
 */
import React, { useEffect, useState } from 'react';
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
  const [open, setOpen] = useState(!done);
  // Once the user manually toggles, stop auto-driving the state.
  const [userToggled, setUserToggled] = useState(false);

  useEffect(() => {
    if (done && !userToggled) setOpen(false);
  }, [done, userToggled]);

  return (
    <View style={styles.wrap}>
      <TouchableOpacity
        style={styles.head}
        activeOpacity={0.7}
        onPress={() => {
          setUserToggled(true);
          setOpen((v) => !v);
        }}
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
