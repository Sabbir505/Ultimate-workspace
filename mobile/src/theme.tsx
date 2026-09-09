import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Design tokens — ChatGPT-app layout grammar on Relay's warm-neutral
 * identity. The palette is a quiet warm-gray system with ONE accent that
 * marks interactive/brand moments; everything else is content-first so the
 * conversation is the loudest thing on screen.
 *
 *   light  bg #FFFFFF · bubble #ECE9E4 · text #1C1A16 · accent #C96F4A
 *   dark   bg #171614 · bubble #2A2823 · text #F0EEE8 · accent #E08A66
 */

const MODE_KEY = 'appearance.mode'; // 'system' | 'light' | 'dark'
export type ThemeMode = 'system' | 'light' | 'dark';

export const lightColors = {
  background: '#FFFFFF',
  surface: '#FFFFFF',
  surface2: '#F4F3F0',
  bubble: '#ECE9E4',
  elevated: '#FFFFFF',
  scrim: 'rgba(28, 26, 22, 0.45)',
  accent: '#C96F4A',
  primary: '#C96F4A',
  primaryLight: '#C96F4A',
  text: '#1C1A16',
  textSecondary: '#8A877E',
  border: '#E7E4DD',
  success: '#1F9254',
  warning: '#B7791F',
  error: '#D64545',
  green: '#1F9254',
  yellow: '#B7791F',
  blue: '#3B6EA5',
  gray: '#8A877E',
  white: '#FFFFFF',
  black: '#000000',
};

export type ThemeColors = {
  background: string;
  surface: string;
  surface2: string;
  bubble: string;
  elevated: string;
  scrim: string;
  accent: string;
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
  background: '#171614',
  surface: '#171614',
  surface2: '#201E1B',
  bubble: '#2A2823',
  elevated: '#201E1B',
  scrim: 'rgba(0, 0, 0, 0.55)',
  accent: '#E08A66',
  primary: '#E08A66',
  primaryLight: '#E08A66',
  text: '#F0EEE8',
  textSecondary: '#A19E93',
  border: '#2C2A25',
  success: '#34C47C',
  warning: '#E0A84E',
  error: '#F0716C',
  green: '#34C47C',
  yellow: '#E0A84E',
  blue: '#7BA7D4',
  gray: '#A19E93',
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
  radius: {
    sm: 10, md: 14, lg: 20, pill: 24, sheet: 20,
  } as const,
  // Legacy alias so pre-redesign screens keep compiling.
  borderRadius: {
    sm: 10, md: 14, lg: 20, xl: 24,
  } as const,
  fontSize: {
    xs: 10, sm: 12, md: 14, lg: 16, xl: 18, '2xl': 20, '3xl': 24,
  } as const,
  /** Chat typography — 16/1.5 body is the ChatGPT-app baseline. */
  type: {
    body: { fontSize: 16, lineHeight: 24 } as const,
    secondary: { fontSize: 13, lineHeight: 18 } as const,
    title: { fontSize: 17, lineHeight: 22, fontWeight: '600' as const },
    label: { fontSize: 12, lineHeight: 16, fontWeight: '500' as const },
    mono: { fontSize: 13, lineHeight: 19 } as const,
  },
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

// ---- Theme context (mode preference + reading isDark) ----

interface ThemeCtx {
  isDark: boolean;
  toggle: () => void;
  /** 'system' (default) | 'light' | 'dark' — persisted across restarts. */
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeCtx>({
  isDark: false,
  toggle: () => {},
  mode: 'system',
  setMode: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>('system');
  const [systemDark, setSystemDark] = useState(systemScheme === 'dark');

  // Load the persisted preference once; the manual toggle survives restarts
  // (the old build reset to "follow system" every launch — a bug users read
  // as "dark mode is broken").
  useEffect(() => {
    AsyncStorage.getItem(MODE_KEY)
      .then((stored) => {
        if (stored === 'light' || stored === 'dark' || stored === 'system') {
          setModeState(stored);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setSystemDark(systemScheme === 'dark');
  }, [systemScheme]);

  const isDark = mode === 'system' ? systemDark : mode === 'dark';

  // Keep the module-level theme.colors in sync.
  useEffect(() => {
    applyThemeColors(isDark ? darkColors : lightColors);
  }, [isDark]);

  const setMode = (next: ThemeMode) => {
    setModeState(next);
    void AsyncStorage.setItem(MODE_KEY, next).catch(() => {});
  };

  const toggle = () => setMode(isDark ? 'light' : 'dark');

  return (
    <ThemeContext.Provider value={{ isDark, toggle, mode, setMode }}>
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
