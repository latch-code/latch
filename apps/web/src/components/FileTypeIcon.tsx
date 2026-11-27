import { Icon, type IconSize } from '@latch/ui'
import material from '../assets/file-types/material.json'
import sprite from '../assets/file-types/material.svg?no-inline'
import { fileNameIcon, referenceIcon, withoutPosition } from '../fileReference.ts'

interface MaterialIcon {
  id: string
  light: string | undefined
}

function iconsByName(icons: Readonly<Record<string, string>>, light: Readonly<Record<string, string>>): ReadonlyMap<string, MaterialIcon> {
  const lightIcons = new Map(Object.entries(light))
  return new Map(Object.entries(icons).map(([key, id]) => [key, { id, light: lightIcons.get(key) }]))
}

const FILE_NAMES = iconsByName(material.fileNames, material.light.fileNames)
const FILE_EXTENSIONS = iconsByName(material.fileExtensions, material.light.fileExtensions)
const LONGEST_EXTENSION = Math.max(...Array.from(FILE_EXTENSIONS.keys(), extension => extension.length))

function materialIcon(path: string): MaterialIcon | undefined {
  const slash = path.lastIndexOf('/')
  if (slash > 0) {
    const parentStart = path.lastIndexOf('/', slash - 1) + 1
    const qualified = FILE_NAMES.get(path.slice(parentStart).toLowerCase())
    if (qualified) return qualified
  }
  const lower = path.slice(slash + 1).toLowerCase()
  const named = FILE_NAMES.get(lower)
  if (named) return named
  // A name can end in several known suffixes (e.g. `view.test.tsx`). Use the longest match.
  const start = Math.max(0, lower.length - LONGEST_EXTENSION - 1)
  for (let dot = lower.indexOf('.', start); dot >= 0; dot = lower.indexOf('.', dot + 1)) {
    const icon = FILE_EXTENSIONS.get(lower.slice(dot + 1))
    if (icon) return icon
  }
  return undefined
}

/** Mentions name a literal file. References in replies may also name a folder or a source location. */
export function FileTypeIcon({ path, mention = false, size = 14 }: { path: string; mention?: boolean; size?: IconSize }) {
  const filePath = mention ? path : withoutPosition(path).replace(/\/+$/u, '')
  const icon = !mention && path.trim().endsWith('/') ? undefined : materialIcon(filePath)
  if (!icon) return <Icon icon={mention ? fileNameIcon(path.slice(path.lastIndexOf('/') + 1)) : referenceIcon(path)} size={size} />
  return (
    <svg className="ui-icon" data-file-icon={icon.id} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      {icon.light && <use href={`${sprite}#${icon.light}`} width={16} height={16} data-theme-art="light" />}
      <use href={`${sprite}#${icon.id}`} width={16} height={16} data-theme-art={icon.light ? 'dark' : undefined} />
    </svg>
  )
}
