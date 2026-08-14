/**
 * ArtifactChip — a small inline chip that surfaces an artifact attached
 * to the latest message in the stream (created files, JSX previews, etc.).
 *
 * For JSX/TSX inline previews the chip can be tapped to expand the code
 * in a modal-style overlay (the actual preview rendering is the desktop's
 * job — the phone shows the path + filename + a tap-to-copy action).
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  ScrollView,
  TouchableWithoutFeedback,
  Alert,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
// M4: lucide-react-native cannot be tree-shaken by Metro (one giant JS
// bundle of every icon); Ionicons is a glyph font already bundled with the
// app. These wrappers preserve the lucide call-sites' (size, color) props.
const FileCode2 = ({ size, color }: { size?: number; color?: string }) => <Ionicons name="code-slash" size={size} color={color} />;
const FileText = ({ size, color }: { size?: number; color?: string }) => <Ionicons name="document-text" size={size} color={color} />;
const X = ({ size, color }: { size?: number; color?: string }) => <Ionicons name="close" size={size} color={color} />;
import { theme } from '../theme';
import type { SessionArtifact } from '../hooks/useRelay';

interface ArtifactChipProps {
  artifact: SessionArtifact;
}

export default function ArtifactChip({ artifact }: ArtifactChipProps) {
  const [expanded, setExpanded] = useState(false);
  const isInline = !!artifact.inline;
  const filename = artifact.filename || artifact.path.split('/').pop() || artifact.path;

  return (
    <>
      <TouchableOpacity
        style={[
          styles.chip,
          { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
        ]}
        onPress={() => {
          if (isInline) setExpanded(true);
          else Alert.alert(filename, artifact.path);
        }}
        activeOpacity={0.7}
      >
        {isInline ? (
          <FileCode2 size={14} color={theme.colors.primary} />
        ) : (
          <FileText size={14} color={theme.colors.textSecondary} />
        )}
        <Text
          style={[styles.filename, { color: isInline ? theme.colors.primary : theme.colors.text }]}
          numberOfLines={1}
        >
          {filename}
        </Text>
        {isInline ? (
          <Text style={[styles.previewHint, { color: theme.colors.textSecondary }]}>(preview)</Text>
        ) : null}
      </TouchableOpacity>

      {isInline ? (
        <Modal
          visible={expanded}
          animationType="fade"
          transparent
          onRequestClose={() => setExpanded(false)}
        >
          <TouchableWithoutFeedback onPress={() => setExpanded(false)}>
            <View style={styles.modalBackdrop}>
              <TouchableWithoutFeedback onPress={() => {}}>
                <View
                  style={[
                    styles.modalCard,
                    { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
                  ]}
                >
                  <View style={styles.modalHeader}>
                    <FileCode2 size={16} color={theme.colors.primary} />
                    <Text style={[styles.modalTitle, { color: theme.colors.text }]} numberOfLines={1}>
                      {filename}
                    </Text>
                    <TouchableOpacity
                      onPress={() => setExpanded(false)}
                      style={styles.modalClose}
                      hitSlop={{ top: 10, left: 10, right: 10, bottom: 10 }}
                    >
                      <X size={16} color={theme.colors.textSecondary} />
                    </TouchableOpacity>
                  </View>
                  <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalScrollContent}>
                    <Text
                      style={[
                        styles.codeText,
                        { color: theme.colors.text, backgroundColor: theme.colors.background },
                      ]}
                    >
                      {artifact.inline!.code}
                    </Text>
                  </ScrollView>
                </View>
              </TouchableWithoutFeedback>
            </View>
          </TouchableWithoutFeedback>
        </Modal>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginTop: 6,
    marginBottom: 2,
    gap: 6,
    maxWidth: '100%',
  },
  filename: { fontSize: 12, fontWeight: '500', flexShrink: 1 },
  previewHint: { fontSize: 11, fontStyle: 'italic' },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  modalCard: {
    width: '100%',
    maxHeight: '80%',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.1)',
    gap: 8,
  },
  modalTitle: { fontSize: 14, fontWeight: '600', flex: 1 },
  modalClose: { padding: 4 },
  modalScroll: { maxHeight: 480 },
  modalScrollContent: { padding: 12 },
  codeText: {
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 18,
    padding: 10,
    borderRadius: 6,
  },
});
