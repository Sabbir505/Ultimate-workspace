/**
 * ActionSheet — a compact bottom-sheet menu used across the phone for the
 * desktop's overflow menus: per-message actions, permission modes, the chat
 * menu, and checkpoint restore. Mirrors the desktop's dropdown/menu surfaces
 * one level down: scrim tap closes, destructive rows tint red.
 */
import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  ScrollView,
  TouchableOpacity,
  TouchableWithoutFeedback,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { theme } from '../../theme';
import { tapLight } from '../../lib/haptics';

export interface ActionSheetItem {
  key: string;
  label: string;
  icon?: keyof typeof Ionicons.glyphMap;
  /** Show a check on the active row (permission mode, etc.). */
  selected?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  /** Secondary line under the label (checkpoint file counts, etc.). */
  detail?: string;
  onPress: () => void;
}

export interface ActionSheetProps {
  visible: boolean;
  title?: string;
  items: ActionSheetItem[];
  onClose: () => void;
}

export function ActionSheet({ visible, title, items, onClose }: ActionSheetProps) {
  const c = theme.colors;
  if (!visible) return null;
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={[styles.scrim, { backgroundColor: c.scrim }]}>
          <TouchableWithoutFeedback>
            <View style={[styles.sheet, { backgroundColor: c.elevated }]}>
              {title ? (
                <Text style={[styles.title, { color: c.textSecondary }]}>{title}</Text>
              ) : null}
              <ScrollView bounces={false} style={styles.list}>
                {items.map((item) => (
                  <TouchableOpacity
                    key={item.key}
                    disabled={item.disabled}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel={item.label}
                    onPress={() => {
                      tapLight();
                      onClose();
                      item.onPress();
                    }}
                    style={[
                      styles.row,
                      item.selected ? { backgroundColor: c.surface2 } : null,
                    ]}
                  >
                    {item.icon ? (
                      <Ionicons
                        name={item.icon}
                        size={17}
                        color={item.disabled ? c.textSecondary : item.destructive ? c.error : c.text}
                      />
                    ) : null}
                    <View style={styles.rowText}>
                      <Text
                        style={[
                          styles.label,
                          {
                            color: item.disabled
                              ? c.textSecondary
                              : item.destructive
                                ? c.error
                                : item.selected
                                  ? c.accent
                                  : c.text,
                          },
                        ]}
                      >
                        {item.label}
                      </Text>
                      {item.detail ? (
                        <Text style={[styles.detail, { color: c.textSecondary }]} numberOfLines={1}>
                          {item.detail}
                        </Text>
                      ) : null}
                    </View>
                    {item.selected ? <Ionicons name="checkmark" size={16} color={c.accent} /> : null}
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: theme.radius.sheet,
    borderTopRightRadius: theme.radius.sheet,
    paddingBottom: theme.spacing.xl,
    paddingTop: theme.spacing.sm,
    maxHeight: '70%',
  },
  title: {
    ...theme.type.label,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
  },
  list: { paddingHorizontal: theme.spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: theme.radius.sm,
  },
  rowText: { flex: 1 },
  label: { fontSize: 15 },
  detail: { fontSize: 11, marginTop: 1 },
});

export default ActionSheet;
