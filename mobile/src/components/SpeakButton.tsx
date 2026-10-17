/**
 * SpeakButton — the one-tap read-aloud control shared by every surface that
 * shows readable text (chat turns, artifacts, wiki/vault notes, terminal
 * output…).
 *
 * Tap once: the phone's speaker reads `text` (markdown normalized by
 * lib/tts). Tap the same button again (or any other SpeakButton, or the
 * floating player pill's stop) to stop — only one read plays at a time.
 * The glyph flips to a stop square while THIS id is the one being read.
 */
import React, { useEffect, useState } from 'react';
import { TouchableOpacity } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { theme } from '../theme';
import { subscribeTts, toggleSpeak } from '../lib/tts';
import { tapLight } from '../lib/haptics';

export default function SpeakButton({
  id,
  text,
  label,
  size = 18,
  color,
  style,
  hitSlop,
}: {
  /** Stable identity of what's being read (`msg:<id>`, `artifact:<path>`). */
  id: string;
  text: string;
  /** Short label for the floating player pill (e.g. "Assistant reply"). */
  label?: string;
  size?: number;
  /** Defaults to theme.colors.textSecondary. */
  color?: string;
  style?: object;
  hitSlop?: { top: number; bottom: number; left: number; right: number };
}) {
  const c = theme.colors;
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    // Subscribe to the module-level player so every button reflects the
    // single active read (buttons are cheap; there are never many mounted).
    const off = subscribeTts((s) => setSpeaking(s.key === id && s.phase === 'speaking'));
    return off;
  }, [id]);

  return (
    <TouchableOpacity
      style={[{ padding: 4 }, style]}
      hitSlop={hitSlop ?? { top: 8, bottom: 8, left: 8, right: 8 }}
      activeOpacity={0.6}
      accessibilityRole="button"
      accessibilityLabel={speaking ? 'Stop reading aloud' : 'Read aloud'}
      onPress={() => {
        tapLight();
        toggleSpeak(id, text, label);
      }}
    >
      <Ionicons
        name={speaking ? 'stop' : 'play'}
        size={size}
        color={color ?? (speaking ? c.accent : c.textSecondary)}
      />
    </TouchableOpacity>
  );
}
