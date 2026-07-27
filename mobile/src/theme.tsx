import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';

export const lightColors = {
  background: '#FAF7F5',
  surface: '#FFFFFF',
  primary: '#C15F3C',
  primaryLight: '#D47655',
  text: '#3D322C',
  textSecondary: '#7A6F67',
  border: '#E8E3DF',
  success: '#4CAF50',
  warning: '#FF9800',
  error: '#E53935',
  green: '#4CAF50',
  yellow: '#FFC107',
  blue: '#2196F3',
  gray: '#9E9E9E',
  white: '#FFFFFF',
  black: '#000000',
} as const;

export const darkColors: typeof lightColors = {
  background: '#1E1B1A',
  surface: '#2A2726',
  primary: '#C15F3C',
  primaryLight: '#D47655',
  text: '#E8E4E0',
  textSecondary: '#A09B96',
  border: '#3D3936',
  success: '#4CAF50',
  warning: '#FFC107',
  error: '#E53935',
  green: '#4CAF50',
  yellow: '#FFC107',
  blue: '#2196F3',
  gray: '#9E9E9E',
  white: '#FFFFFF',
  black: '#000000',
} as const;

export type ThemeColors = typeof lightColors;

// ---- Reactive theme singleton ----
// Components that import `theme` get colors that update when dark mode toggles.
// StyleSheet.create is module-level frozen, so components must apply the 5
// wallpaper colors (background, surface, text, textSecondary, border) as inline
// overrides: style={[styles.foo, { backgroundColor: theme.colors.surface }]}

let _current: ThemeColors = lightColors;
const _changeListeners = new Set<() => void>();

export const theme = {
  get colors(): ThemeColors { return _current; },
  spacing: {
    xs: 4, sm: 8, md: 16, lg: 24, xl: 32,
  } as const,
  borderRadius: {
    sm: 6, md: 12, lg: 16, xl: 24,
  } as const,
  fontSize: {
    xs: 10, sm: 12, md: 14, lg: 16, xl: 18, '2xl': 20, '3xl': 24,
  } as const,
};

export function applyThemeColors(colors: ThemeColors) {
  _current = colors;
  _changeListeners.forEach(fn => fn());
}

function useThemeColors() {
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    const fn = () => forceUpdate(n => n + 1);
    _changeListeners.add(fn);
    return () => { _changeListeners.delete(fn); };
  }, []);
}

// ---- Theme context (for imperative toggle + reading isDark) ----

interface ThemeCtx {
  isDark: boolean;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeCtx>({
  isDark: false,
  toggle: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  const [isDark, setIsDark] = useState(systemScheme === 'dark');

  useEffect(() => {
    setIsDark(systemScheme === 'dark');
  }, [systemScheme]);

  // Keep the module-level theme.colors in sync.
  useEffect(() => {
    applyThemeColors(isDark ? darkColors : lightColors);
  }, [isDark]);

  const toggle = () => setIsDark(v => !v);

  return (
    <ThemeContext.Provider value={{ isDark, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeCtx {
  // Subscribe to theme changes so components that use the static `theme`
  // import re-render when colors change.
  useThemeColors();
  return useContext(ThemeContext);
}
