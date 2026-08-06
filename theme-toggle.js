/**
 * theme-toggle.js
 * ------------------------------------------------------------------
 * Shared dark/light theme handling for the popup, dashboard, and
 * onboarding pages. Loaded FIRST in <head>, before any CSS/content
 * renders, so the correct theme applies with zero flash-of-wrong-
 * theme — this is why it uses synchronous localStorage rather than
 * chrome.storage.local (which is always async). Extension pages
 * (chrome-extension://...) have their own real, synchronous
 * localStorage, same as any normal web page.
 * ------------------------------------------------------------------
 */

(function initScrollTrackerTheme(global) {
  if (global.ScrollTrackerTheme) return;

  const THEME_KEY = "scrollTrackerTheme";

  function getStoredTheme() {
    try {
      return localStorage.getItem(THEME_KEY);
    } catch (err) {
      return null;
    }
  }

  /** Stored preference wins; otherwise follow the OS-level setting. */
  function getPreferredTheme() {
    const stored = getStoredTheme();
    if (stored === "dark" || stored === "light") return stored;
    const prefersDark =
      global.matchMedia && global.matchMedia("(prefers-color-scheme: dark)").matches;
    return prefersDark ? "dark" : "light";
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
  }

  function setTheme(theme) {
    applyTheme(theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (err) {
      // best-effort only — theme just won't persist across sessions
    }
    document.dispatchEvent(new CustomEvent("scrolltracker:themechange", { detail: { theme } }));
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") || "light";
    const next = current === "dark" ? "light" : "dark";
    setTheme(next);
    return next;
  }

  function getCurrentTheme() {
    return document.documentElement.getAttribute("data-theme") || "light";
  }

  // Apply immediately — synchronously, before body content paints —
  // so there's no visible flash of the wrong theme on page load.
  applyTheme(getPreferredTheme());

  global.ScrollTrackerTheme = { getCurrentTheme, setTheme, toggleTheme };
})(typeof window !== "undefined" ? window : globalThis);
