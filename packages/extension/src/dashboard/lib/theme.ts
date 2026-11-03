/**
 * Theme controller for the M3 light/dark schemes.
 *
 * The stored value is a *preference* (`system` | `light` | `dark`), not a scheme.
 * `system` is resolved against `prefers-color-scheme` at read time and re-resolved
 * whenever the OS changes, so a live scheme switch is reflected without a reload.
 *
 * Mirrors the `nashir:lang` convention: plain localStorage on the shared extension
 * origin, so the popup can read the same value without messaging the service worker.
 * The matching pre-paint snippet lives in `themePreloadScript()`.
 */

export type ThemeMode = "system" | "light" | "dark";
export type Scheme = "light" | "dark";

export const THEME_STORAGE_KEY = "nashir:theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";
const MODES: readonly ThemeMode[] = ["system", "light", "dark"];

export function getSavedTheme(): ThemeMode {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  return MODES.includes(saved as ThemeMode) ? (saved as ThemeMode) : "system";
}

export function prefersDark(): boolean {
  return typeof matchMedia === "function" && matchMedia(DARK_QUERY).matches;
}

/** Collapses a preference into the scheme actually being rendered. */
export function resolveTheme(mode: ThemeMode): Scheme {
  if (mode === "system") return prefersDark() ? "dark" : "light";
  return mode;
}

/** Paints a preference onto <html>. Does not persist it. */
export function applyTheme(mode: ThemeMode): Scheme {
  const scheme = resolveTheme(mode);
  document.documentElement.classList.toggle("dark", scheme === "dark");
  return scheme;
}

/** Persists a preference and paints it. */
export function setTheme(mode: ThemeMode): Scheme {
  localStorage.setItem(THEME_STORAGE_KEY, mode);
  return applyTheme(mode);
}

/**
 * Repaints on OS scheme changes, but only while the user is following the system —
 * an explicit light/dark choice must survive the OS flipping underneath it.
 * Returns a dispose function.
 */
export function watchSystemTheme(): () => void {
  if (typeof matchMedia !== "function") return () => {};

  const mql = matchMedia(DARK_QUERY);
  const onChange = () => {
    if (getSavedTheme() === "system") applyTheme("system");
  };

  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/** Paints the stored preference and starts following the OS. Returns a dispose function. */
export function initTheme(): () => void {
  applyTheme(getSavedTheme());
  return watchSystemTheme();
}

/**
 * Inlined into both HTML entry points and run before first paint, so a dark-mode
 * load does not flash light while the bundle boots. Deliberately dependency-free
 * and defensive — it runs before anything else on the page, and a storage
 * exception here would block rendering entirely.
 */
export function themePreloadScript(): string {
  return `(function(){try{var m=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})||"system";var d=m==="dark"||(m==="system"&&matchMedia(${JSON.stringify(DARK_QUERY)}).matches);document.documentElement.classList.toggle("dark",d);}catch(e){}})();`;
}
