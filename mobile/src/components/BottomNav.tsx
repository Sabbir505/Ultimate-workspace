import React, { useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
// M4: lucide-react-native cannot be tree-shaken by Metro (one giant JS
// bundle of every icon); Ionicons is a glyph font already bundled with the
// app. These wrappers preserve the lucide call-sites' (size, color) props.
const Home = ({ size, color }: { size?: number; color?: string; strokeWidth?: number; }) => <Ionicons name="home" size={size} color={color} />;
const MessageSquare = ({ size, color }: { size?: number; color?: string; strokeWidth?: number; }) => <Ionicons name="chatbubble" size={size} color={color} />;
const Settings = ({ size, color }: { size?: number; color?: string; strokeWidth?: number; }) => <Ionicons name="settings" size={size} color={color} />;
import { theme, useTheme } from '../theme';

interface BottomNavProps {
  state: any;
  descriptors: any;
  navigation: any;
}

export default function BottomNav({ state, descriptors, navigation }: BottomNavProps) {
  useTheme(); // subscribe so theme.colors is reactive
  const c = theme.colors;
  const icons = useMemo(() => ({
    Home: Home,
    Chat: MessageSquare,
    Settings: Settings,
  }), []);

  return (
    <View style={[styles.container, { backgroundColor: c.surface, borderTopColor: c.border }]}>
      {state.routes.map((route: any, index: number) => {
        const { options } = descriptors[route.key];
        const label = options.tabBarLabel !== undefined
          ? options.tabBarLabel
          : options.title !== undefined
            ? options.title
            : route.name;

        const isFocused = state.index === index;
        const Icon = icons[route.name as keyof typeof icons] || Home;

        const onPress = () => {
          const event = navigation.emit({
            type: 'tabPress',
            target: route.key,
            canPreventDefault: true,
          });

          if (!isFocused && !event.defaultPrevented) {
            navigation.navigate(route.name);
          }
        };

        return (
          <TouchableOpacity
            key={route.key}
            accessibilityRole="button"
            accessibilityState={isFocused ? { selected: true } : {}}
            accessibilityLabel={options.tabBarAccessibilityLabel}
            testID={options.tabBarTestID}
            onPress={onPress}
            style={styles.tab}
          >
            <View style={styles.iconContainer}>
              <Icon
                size={24}
                color={isFocused ? theme.colors.primary : theme.colors.textSecondary}
                strokeWidth={isFocused ? 2.5 : 2}
              />
            </View>
            <Text
              style={[
                styles.label,
                isFocused ? styles.labelFocused : styles.labelUnfocused,
              ]}
            >
              {label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    backgroundColor: theme.colors.surface,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingBottom: 8,
    paddingTop: 8,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
  },
  iconContainer: {
    position: 'relative',
    marginBottom: 2,
  },
  label: {
    fontSize: theme.fontSize.xs,
    marginTop: 2,
  },
  labelFocused: {
    color: theme.colors.primary,
    fontWeight: '600',
  },
  labelUnfocused: {
    color: theme.colors.textSecondary,
  },
});
