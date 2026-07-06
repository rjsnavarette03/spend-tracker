import { useSyncExternalStore } from 'react';

// Light/dark theme, stored per-device in localStorage (so it also applies to the
// login screen, before any user session exists). The chosen theme is reflected
// on <html data-theme="…">, which flips the CSS variables in styles.css.

export type Theme = 'light' | 'dark';

const KEY = 'spendtracker-theme';

function detectInitial(): Theme {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // localStorage may be unavailable (private mode) — fall back to system.
  }
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches) {
    return 'light';
  }
  return 'dark';
}

let current: Theme = detectInitial();
const listeners = new Set<() => void>();

/** Reflect the current (or given) theme on the document so the CSS vars switch. */
export function applyTheme(theme: Theme = current): void {
  document.documentElement.setAttribute('data-theme', theme);
}

export function setTheme(theme: Theme): void {
  current = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // ignore persistence failure
  }
  applyTheme(theme);
  listeners.forEach((l) => l());
}

export function toggleTheme(): void {
  setTheme(current === 'dark' ? 'light' : 'dark');
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): Theme {
  return current;
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
