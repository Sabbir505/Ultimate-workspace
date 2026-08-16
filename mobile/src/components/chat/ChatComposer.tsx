/**
 * ChatComposer — the input bar at the bottom of the SessionChat screen.
 *
 * - Multi-line text input that grows up to 4 lines, then scrolls.
 * - Send button is disabled while empty or while a stream is in-flight;
 *   when streaming it shows a stop icon that calls `onCancel`.
 * - Optional model/provider hint in the corner (the picker lives on the
 *   project-level harness selector, not on the composer itself).
 * - Attachment button (📎) opens expo-document-picker. Selected files are
 *   read as base64 and shown as removable chips above the input. On send,
 *   attachments are threaded through `onSend(text, attachments)`.
 */
import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Keyboard,
  ScrollView,
  Alert,
  Platform,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { theme } from '../theme';
import type { SessionChatAttachment } from '../../hooks/useRelay';

// M4: lucide-react-native cannot be tree-shaken by Metro (one giant JS
// bundle of every icon); Ionicons is a glyph font already bundled with the
// app. These wrappers preserve the lucide call-sites' (size, color) props.
const Send = ({ size, color }: { size?: number; color?: string; fill?: string; }) => <Ionicons name="send" size={size} color={color} />;
const Square = ({ size, color }: { size?: number; color?: string; fill?: string; }) => <Ionicons name="stop" size={size} color={color} />;
const AttachIcon = ({ size, color }: { size?: number; color?: string }) => <Ionicons name="attach" size={size} color={color} />;
const CloseIcon = ({ size, color }: { size?: number; color?: string }) => <Ionicons name="close-circle" size={size} color={color} />;

// Match the desktop composer's size caps (ChatComposer.tsx:21-23) so the
// relay's 64 MiB default message cap is never the gate.
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_DOC_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
const DOC_EXTS = ['pdf', 'docx', 'pptx', 'xlsx', 'txt', 'md', 'csv', 'json', 'ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h'];

function classifyByName(name: string): 'image' | 'doc' | 'text' {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (DOC_EXTS.includes(ext)) return 'doc';
  return 'text';
}

interface ChatComposerProps {
  onSend: (text: string, attachments?: SessionChatAttachment[]) => void;
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
  const [attachments, setAttachments] = useState<SessionChatAttachment[]>([]);

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !streaming;

  const handleSend = () => {
    if (!canSend) return;
    const trimmed = text.trim();
    setText('');
    setAttachments([]);
    Keyboard.dismiss();
    onSend(trimmed, attachments);
  };

  const handleAttach = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: true,
      });
      if (result.canceled || !result.assets?.length) return;

      const picked: SessionChatAttachment[] = [];
      for (const asset of result.assets) {
        const name = asset.name;
        const kind = classifyByName(name);
        const uri = asset.uri;

        if (kind === 'image') {
          // Read as base64 (no data: prefix — matches the desktop path).
          const size = asset.size ?? 0;
          if (size > MAX_IMAGE_BYTES) {
            Alert.alert('File too large', `${name} exceeds the 15 MB image limit.`);
            continue;
          }
          const data = await FileSystem.readAsStringAsync(uri, {
            encoding: FileSystem.EncodingType.Base64,
          });
          picked.push({
            name,
            kind: 'image',
            data,
            media_type: name.split('.').pop()?.toLowerCase() ?? 'image/png',
          });
        } else if (kind === 'doc') {
          const ext = name.split('.').pop()?.toLowerCase() ?? '';
          const size = asset.size ?? 0;
          if (size > MAX_DOC_BYTES) {
            Alert.alert('File too large', `${name} exceeds the 10 MB document limit.`);
            continue;
          }
          const data = await FileSystem.readAsStringAsync(uri, {
            encoding: FileSystem.EncodingType.Base64,
          });
          picked.push({ name, kind: 'doc', data, format: ext });
        } else {
          // Text — read as UTF-8 string.
          const size = asset.size ?? 0;
          if (size > MAX_TEXT_BYTES) {
            Alert.alert('File too large', `${name} exceeds the 512 KB text limit.`);
            continue;
          }
          const fileText = await FileSystem.readAsStringAsync(uri, {
            encoding: FileSystem.EncodingType.UTF8,
          });
          picked.push({ name, kind: 'text', text: fileText });
        }
      }

      if (picked.length > 0) {
        setAttachments((prev) => [...prev, ...picked]);
      }
    } catch (e) {
      Alert.alert('Attachment failed', (e as Error)?.message ?? 'Could not pick file.');
    }
  }, []);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  return (
    <View style={[styles.wrap, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
      {modelHint ? (
        <Text style={[styles.hint, { color: theme.colors.textSecondary }]} numberOfLines={1}>
          {modelHint}
        </Text>
      ) : null}

      {attachments.length > 0 && (
        <ScrollView horizontal style={styles.attachmentRow} showsHorizontalScrollIndicator={false}>
          {attachments.map((att, i) => (
            <View key={`${att.name}-${i}`} style={[styles.attachmentChip, { backgroundColor: theme.colors.surface2, borderColor: theme.colors.border }]}>
              <Ionicons
                name={att.kind === 'image' ? 'image' : att.kind === 'doc' ? 'document' : 'document-text'}
                size={14}
                color={theme.colors.primary}
              />
              <Text style={[styles.attachmentName, { color: theme.colors.text }]} numberOfLines={1}>{att.name}</Text>
              <TouchableOpacity onPress={() => removeAttachment(i)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <CloseIcon size={16} color={theme.colors.textSecondary} />
              </TouchableOpacity>
            </View>
          ))}
        </ScrollView>
      )}

      <View style={styles.row}>
        <TouchableOpacity
          style={[styles.attachBtn, { borderColor: theme.colors.border }]}
          onPress={handleAttach}
          disabled={streaming}
          activeOpacity={0.7}
          accessibilityLabel="Attach file"
        >
          <AttachIcon size={20} color={streaming ? theme.colors.textSecondary : theme.colors.text} />
        </TouchableOpacity>
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
  attachmentRow: {
    flexDirection: 'row',
    marginBottom: 6,
    flexGrow: 0,
  },
  attachmentChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 14,
    borderWidth: 1,
    marginRight: 6,
    maxWidth: 160,
  },
  attachmentName: {
    fontSize: 12,
    maxWidth: 100,
  },
  row: { flexDirection: 'row', alignItems: 'flex-end' },
  attachBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
    marginBottom: 0,
  },
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
