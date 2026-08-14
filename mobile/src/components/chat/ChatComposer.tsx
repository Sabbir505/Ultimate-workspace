/**
 * ChatComposer — the input bar at the bottom of the SessionChat screen.
 *
 * - Multi-line text input that grows up to 4 lines, then scrolls.
 * - Send button is disabled while empty or while a stream is in-flight;
 *   when streaming it shows a stop icon that calls `onCancel`.
 * - Optional model/provider hint in the corner (the picker lives on the
 *   project-level harness selector, not on the composer itself).
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Keyboard,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
// M4: lucide-react-native cannot be tree-shaken by Metro (one giant JS
// bundle of every icon); Ionicons is a glyph font already bundled with the
// app. These wrappers preserve the lucide call-sites' (size, color) props.
const Send = ({ size, color }: { size?: number; color?: string; fill?: string; }) => <Ionicons name="send" size={size} color={color} />;
const Square = ({ size, color }: { size?: number; color?: string; fill?: string; }) => <Ionicons name="stop" size={size} color={color} />;
import { theme } from '../theme';

interface ChatComposerProps {
  onSend: (text: string) => void;
  onCancel?: () => void;
  streaming?: boolean;
  placeholder?: string;
  /** Subtle hint line above the input ("Claude 3.5 · claude-sonnet-4-5"). */
  modelHint?: string;
}

export default function ChatComposer({
  onSend,
  onCancel,
  streaming = false,
  placeholder = 'Message…',
  modelHint,
}: ChatComposerProps) {
  const [text, setText] = useState('');

  const canSend = text.trim().length > 0 && !streaming;

  const handleSend = () => {
    if (!canSend) return;
    const trimmed = text.trim();
    setText('');
    Keyboard.dismiss();
    onSend(trimmed);
  };

  return (
    <View style={[styles.wrap, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
      {modelHint ? (
        <Text style={[styles.hint, { color: theme.colors.textSecondary }]} numberOfLines={1}>
          {modelHint}
        </Text>
      ) : null}
      <View style={styles.row}>
        <TextInput
          style={[
            styles.input,
            {
              color: theme.colors.text,
              backgroundColor: theme.colors.surface2,
              borderColor: theme.colors.border,
            },
          ]}
          value={text}
          onChangeText={setText}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.textSecondary}
          multiline
          maxHeight={4 * 22}
          editable={!streaming}
          onSubmitEditing={handleSend}
          blurOnSubmit={false}
          returnKeyType="default"
        />
        {streaming && onCancel ? (
          <TouchableOpacity
            style={[styles.iconBtn, { backgroundColor: theme.colors.error }]}
            onPress={onCancel}
            activeOpacity={0.7}
            accessibilityLabel="Stop generating"
          >
            <Square size={16} color="#fff" fill="#fff" />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[
              styles.iconBtn,
              { backgroundColor: canSend ? theme.colors.primary : theme.colors.gray, opacity: canSend ? 1 : 0.5 },
            ]}
            onPress={handleSend}
            disabled={!canSend}
            activeOpacity={0.7}
            accessibilityLabel="Send message"
          >
            <Send size={16} color="#fff" />
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 10,
  },
  hint: { fontSize: 11, marginBottom: 4, marginLeft: 4 },
  row: { flexDirection: 'row', alignItems: 'flex-end' },
  input: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 8,
    fontSize: 15,
    minHeight: 36,
    maxHeight: 4 * 22 + 16,
  },
  iconBtn: {
    marginLeft: 8,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
