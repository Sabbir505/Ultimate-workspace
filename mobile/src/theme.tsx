import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';

export const lightColors = {
  background: '#ffffff',
  surface: '#ffffff',
  surface2: '#f3f3f3',
  primary: '#0078a8',
  primaryLight: '#0078a8',
  text: '#1a1a1a',
  textSecondary: '#6a6a6a',
  border: '#e0e0e0',
  success: '#16a34a',
  warning: '#FFC107',
  error: '#d64545',
  green: '#16a34a',
  yellow: '#FFC107',
  blue: '#0078a8',
  gray: '#9E9E9E',
  white: '#FFFFFF',
  black: '#000000',
};

export type ThemeColors = {
  background: string;
  surface: string;
  surface2: string;
  primary: string;
  primaryLight: string;
  text: string;
  textSecondary: string;
  border: string;
  success: string;
  warning: string;
  error: string;
  green: string;
  yellow: string;
  blue: string;
  gray: string;
  white: string;
  black: string;
};

export const darkColors: ThemeColors = {
  background: '#181818',
  surface: '#1a1a1a',
  surface2: '#1f1f1f',
  primary: '#88C0D0',
  primaryLight: '#88C0D0',
  text: '#e4e4e4',
  textSecondary: '#a0a0a0',
  border: '#2a2a2a',
  success: '#4ec9b0',
  warning: '#FFC107',
  error: '#ff7b72',
  green: '#4ec9b0',
  yellow: '#FFC107',
  blue: '#88C0D0',
  gray: '#9E9E9E',
  white: '#FFFFFF',
  black: '#000000',
};

// ---- Reactive theme singleton ----
// Components that import `theme` get colors that update when dark mode toggles.
// StyleSheet.create is module-level frozen, so components must apply the 5
// wallpaper colors (background, surface, surface2, text, textSecondary, border) as inline
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
