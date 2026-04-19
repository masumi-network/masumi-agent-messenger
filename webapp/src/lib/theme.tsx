import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
  useState,
} from 'react';

export type ThemeMode = 'light' | 'dark';

const THEME_STORAGE_KEY = 'masumi-agent-messenger:theme';
const DEFAULT_THEME: ThemeMode = 'dark';

const themeContext = createContext<{
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
} | null>(null);

function parseTheme(value: string | null): ThemeMode | null {
  return value === 'light' || value === 'dark' ? value : null;
}

function getStoredTheme(): ThemeMode | null {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return null;
  }

  try {
    return parseTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return null;
  }
}

function readInitialTheme(): ThemeMode {
  if (typeof document === 'undefined') {
    return DEFAULT_THEME;
  }

  const stored = getStoredTheme();
  if (stored) {
    return stored;
  }

  return document.documentElement.classList.contains('dark')
    ? 'dark'
    : DEFAULT_THEME;
}

function applyTheme(theme: ThemeMode) {
  if (typeof document === 'undefined') {
    return;
  }

  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.style.colorScheme = theme;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeMode>(readInitialTheme);

  useEffect(() => {
    applyTheme(theme);

    if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
      return;
    }

    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Ignore storage errors so theme still toggles without persistence.
    }
  }, [theme]);

  const setThemeMode = useCallback((nextTheme: ThemeMode) => {
    setTheme(nextTheme);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(current => (current === 'dark' ? 'light' : 'dark'));
  }, []);

  const value = useMemo(
    () => ({
      theme,
      setTheme: setThemeMode,
      toggleTheme,
    }),
    [theme, setThemeMode, toggleTheme]
  );

  return <themeContext.Provider value={value}>{children}</themeContext.Provider>;
}

export function useTheme() {
  const context = useContext(themeContext);
  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return context;
}
