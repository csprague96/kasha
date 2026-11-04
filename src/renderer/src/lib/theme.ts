/**
 * Puts the chosen theme on <html>. A window opens with it in its address, so
 * the first paint already has the right colours, then checks Settings (the
 * address goes stale if the window is reloaded) and follows them after.
 */
export function followTheme(): void {
  const set = (theme: string | null | undefined) => {
    if (theme) document.documentElement.dataset.theme = theme
  }
  set(new URLSearchParams(location.search).get('theme'))
  void window.kasha.getSettings().then((s) => set(s.theme))
  window.kasha.onSettingsChanged((s) => set(s.theme))
}
