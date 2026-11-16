import { useEffect, useState } from 'react'

/** The page's theme: the shell's own choice, else the system's. */
export function shellTheme(): 'light' | 'dark' {
  const chosen = document.documentElement.dataset.theme
  if (chosen === 'light' || chosen === 'dark') return chosen
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** The shell's theme as it changes (the system's, or the one chosen in 设置). */
export function useShellTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState(shellTheme)
  useEffect(() => {
    const update = () => {
      setTheme(shellTheme())
    }
    const media = matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', update)
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      media.removeEventListener('change', update)
      observer.disconnect()
    }
  }, [])
  return theme
}
