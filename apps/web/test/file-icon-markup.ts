import material from '../src/assets/file-types/material.json'
import sprite from '../src/assets/file-types/material.svg?no-inline'

const iconHrefs = new Set(
  [material.fileNames, material.fileExtensions, material.light.fileNames, material.light.fileExtensions]
    .flatMap(icons => Object.values(icons))
    .map(id => `${sprite}#${id}`),
)

/** Keep every href except the SVG references to known symbols in the bundled icon sprite. */
export function nonIconHrefs(html: string): string[] {
  const markup = html.replace(/<use href="([^"]+)"[^>]*><\/use>/gu, (element, href: string) => (iconHrefs.has(href) ? '' : element))
  return Array.from(markup.matchAll(/\bhref="([^"]*)"/gu), match => match[1]!)
}
