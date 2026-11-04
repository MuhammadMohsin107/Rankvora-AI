import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isEmbedded } from '../lib/embedded';

/**
 * ─── Theme ───────────────────────────────────────────────────────────
 *
 * THREE STATES, NOT TWO. "System" is a real choice: it means "follow the OS", and it keeps
 * following it when the OS changes at sunset. Collapsing it into a light/dark boolean on first load
 * would silently freeze whatever the OS happened to be saying at that moment.
 *
 * DARK IS THE DEFAULT. Someone who has never chosen — a new user, a fresh browser, the sign-in and
 * onboarding pages they see first — gets dark regardless of their OS. Light and System remain one
 * click away in Settings and the header toggle.
 *
 * ONLY A CHOICE IS STORED. The default is never written to storage, so a visitor who has not picked
 * a theme is always on whatever the current default is, and storage only ever holds something the
 * customer actually chose.
 *
 * The provider owns one side effect: stamping `data-theme` on <html>, or removing it for system.
 * Everything visual follows from there, because the palette in index.css is defined against that
 * attribute — no component subscribes to this context to pick colours, and none needs to.
 */

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'scorelo.theme';

/** What someone who has never chosen sees. Mirrored in index.html's inline bootstrap. */
const DEFAULT_PREFERENCE: ThemePreference = 'dark';

interface ThemeContextValue {
  /** What the customer chose. 'system' means "whatever the OS says, now and later". */
  preference: ThemePreference;
  /** What that currently resolves to — the value actually on screen. */
  theme: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
  /** Flips to the opposite of what is currently showing, leaving 'system' behind. */
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function prefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
}

/**
 * Reads the stored choice.
 *
 * Wrapped because storage throws outright in some contexts — a private window with site data
 * blocked, an embedded webview — and a theme preference is never worth a blank screen.
 */
function readStoredPreference(): ThemePreference {
  // Inside the Shopify admin the app is always light: it is drawn on the admin's own light surface,
  // and a dark panel set into it reads as a fault rather than a choice. There is no toggle there to
  // change it, and nothing is read from storage — an embedded app must work with storage blocked.
  if (isEmbedded()) return 'light';
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // Storage unavailable: fall through to the default.
  }
  return DEFAULT_PREFERENCE;
}

/** Persists an explicit choice. Failures are swallowed for the same reason reads are: the app must
 * work with storage disabled, just without memory. */
function storePreference(preference: ThemePreference) {
  if (isEmbedded()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // No persistence available — the choice still applies for this session.
  }
}

/**
 * Applies the theme to the document.
 *
 * Exported and called once from index.html's inline bootstrap as well as from the provider, so the
 * attribute is set BEFORE React paints. Without that, a dark-mode customer sees a white flash on
 * every load — the page renders light, then corrects itself a frame later.
 */
export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved: ResolvedTheme = preference === 'system' ? (prefersDark() ? 'dark' : 'light') : preference;

  // 'system' removes the attribute rather than stamping the resolved value. That is what keeps the
  // OS in charge: index.css's prefers-color-scheme block only applies when nothing is stamped.
  if (preference === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', preference);

  return resolved;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference);
  const [theme, setTheme] = useState<ResolvedTheme>(() => applyTheme(readStoredPreference()));

  // Re-apply whenever the choice changes. Persisting happens where the customer chooses, not here,
  // so mounting with the default never writes it to storage.
  useEffect(() => {
    setTheme(applyTheme(preference));
  }, [preference]);

  // While following the system, track it live. Someone whose OS switches at sunset should see the
  // app switch too, without a reload.
  useEffect(() => {
    if (preference !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setTheme(applyTheme('system'));
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [preference]);

  // A theme chosen in one tab should not leave the others disagreeing with storage.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) setPreferenceState(readStoredPreference());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    storePreference(next);
    setPreferenceState(next);
  }, []);

  // Toggling from 'system' commits to the opposite of what is on screen — the customer is reaching
  // for the switch because they want the other one, not because they want to keep following the OS.
  const toggle = useCallback(() => {
    const showing = preference === 'system' ? (prefersDark() ? 'dark' : 'light') : preference;
    setPreference(showing === 'dark' ? 'light' : 'dark');
  }, [preference, setPreference]);

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, theme, setPreference, toggle }),
    [preference, theme, setPreference, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside a ThemeProvider');
  return context;
}
