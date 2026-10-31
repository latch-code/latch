/**
 * A change of theme switches every colour at once instead of sweeping through the transitions of hover fills and
 * fields: `switchTheme` applies a change (the page's data-theme, its theme-color) with transitions turned off until two
 * frames later (base.css), and `followSystemTheme` does the same whenever the system's light or dark preference flips
 * while the page follows it.
 */
export function switchTheme(apply: () => void): void {
  const root = document.documentElement
  root.dataset.themeSwitching = ''
  apply()
  // The next frame computes the new colours with transitions off; the one after it lets them back on.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      delete root.dataset.themeSwitching
    })
  })
}

/** Keeps a flip of the system's colour scheme free of transitions; returns the function that stops listening. */
export function followSystemTheme(): () => void {
  const query = matchMedia('(prefers-color-scheme: dark)')
  const flip = () => {
    switchTheme(() => {})
  }
  query.addEventListener('change', flip)
  return () => {
    query.removeEventListener('change', flip)
  }
}
