/**
 * ActionIconPopup — the desktop's per-message hover toolbar, as a CENTERED
 * icon popup for the phone.
 *
 * Desktop reveals a small glyph row (copy · play · regenerate · edit ·
 * delete) when you hover a bubble. A phone has no hover and the bubbles
 * carry no permanent glyphs, so long-pressing a message opens this: one
 * centred row of large icons over a scrim. Tap the scrim to dismiss.
 *
 * Deliberately NOT the bottom ActionSheet: that sheet is for text menus
 * (conversation, permission mode, checkpoints) where a labelled list is the
 * right control. Message actions are glanceable, icon-shaped commands, and
 * they belong near the message under the finger — matching what the user
 * already knows from the desktop.
 */
import React from 'react';
import { Modal, View, Text, StyleSheet, TouchableOpacity, TouchableWithoutFeedback } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { theme } from '../../theme';
import { tapLight, tapMedium } from '../../lib/haptics';
import type { ActionSheetItem } from './ActionSheet';

export interface ActionIconPopupProps {
  visible: boolean;
  items: ActionSheetItem[];
  onClose: () => void;
}

export default function ActionIconPopup({ visible, items, onClose }: ActionIconPopupProps) {
  const c = theme.colors;
  if (!visible) return null;
  const shown = items.filter((i) => !i.disabled);
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <TouchableWithoutFeedback onPress={onClose} accessibilityRole="button" accessibilityLabel="Close message actions">
        <View style={[styles.scrim, { backgroundColor: c.scrim }]}>
          {/* Swallow taps so pressing a gap INSIDE the popup doesn't dismiss. */}
          <TouchableWithoutFeedback>
            <View style={[styles.popup, { backgroundColor: c.elevated, borderColor: c.border }]}>
              {shown.map((item) => (
                <TouchableOpacity
                  key={item.key}
                  style={styles.btn}
                  activeOpacity={0.6}
                  accessibilityRole="button"
                  accessibilityLabel={item.label}
                  onPress={() => {
                    tapMedium();
                    item.onPress();
                    onClose();
                  }}
                >
                  <Ionicons
                    name={item.icon ?? 'ellipse-outline'}
                    size={22}
                    color={item.destructive ? c.error : c.text}
                  />
                  <Text
                    style={[styles.label, { color: item.destructive ? c.error : c.textSecondary }]}
                    numberOfLines={2}
                  >
                    {item.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  popup: {
    flexDirection: 'row',
    // Five labelled icons overflow a 360dp phone in one row — let the row
    // WRAP into two centred lines instead of shrinking the tap targets.
    flexWrap: 'wrap',
    justifyContent: 'center',
    borderRadius: theme.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 8,
    paddingHorizontal: 6,
    maxWidth: '90%',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 16,
  },
  btn: {
    width: 72,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 6,
    borderRadius: theme.radius.md,
  },
  label: {
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'center',
  },
});