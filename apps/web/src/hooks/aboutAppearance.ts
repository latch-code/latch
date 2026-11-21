import { shellTheme } from './useShellTheme.ts'

const aboutColors = ['--work-float', '--work-ink', '--work-muted', '--work-faint']

/** Read the workbench's used colors, so the browser resolves light-dark() with the workbench's color scheme. */
export function aboutAppearance(): string | null {
  const sample = document.createElement('span')
  sample.hidden = true
  document.body.append(sample)
  const colors = aboutColors.map(token => {
    sample.style.backgroundColor = `var(${token})`
    const rgb = /^rgb\((\d+), (\d+), (\d+)\)$/u.exec(getComputedStyle(sample).backgroundColor)
    return rgb
      ? `#${rgb
          .slice(1)
          .map(channel => Number(channel).toString(16).padStart(2, '0'))
          .join('')}`
      : null
  })
  sample.remove()
  return colors.every(color => color !== null) ? `${shellTheme()} ${colors.join(' ')}` : null
}
