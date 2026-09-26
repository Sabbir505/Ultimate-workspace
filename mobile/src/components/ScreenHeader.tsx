/**
 * ScreenHeader — the shared stack-screen header: back chevron + centered
 * title + optional right-side slot, with the shared <DomainErrorBar> mounted
 * directly below the row. Eight screens used to hand-copy this scaffold with
 * drifting styles; this is the one copy.
 *
 * `right` renders a right-side control (refresh / add / actions). When
 * omitted a fixed-width spacer keeps the title optically centred.
 */
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useNavigation } from '@react-navigation/native';
import { theme } from '../theme';
import DomainErrorBar from './DomainErrorBar';

export default function ScreenHeader({
  title,
  errorDomains,
  right,
}: {
  title: string;
  /** Domains forwarded to the shared <DomainErrorBar> under the header. */
  errorDomains?: string[];
  /** Optional right-side controls (buttons). */
  right?: React.ReactNode;
}) {
  const navigation = useNavigation<any>();
  const c = theme.colors;
  return (
    <>
      <View style={[styles.header, { borderBottomColor: c.border }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Ionicons name="arrow-back" size={22} color={c.text} />
        </TouchableOpacity>
        <Text numberOfLines={1} style={[styles.headerTitle, { color: c.text }]}>
          {title}
        </Text>
        {right ?? <View style={styles.rightSpacer} />}
      </View>
      {errorDomains ? <DomainErrorBar domains={errorDomains} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { fontSize: 17, fontWeight: '700' },
  rightSpacer: { width: 22 },
});
