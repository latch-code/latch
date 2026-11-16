import { argumentView } from '../format.ts'

/** How many of a far folder's last names are shown; the whole path is in the row's tooltip. */
const FOLDER_PARTS = 4

/**
 * The folder a command ran in, as its opened row shows it: nothing when it is one of the session's folders, the part
 * under one of them, or the path itself, shortened from the front when it is long.
 */
export function commandFolder(cwd: string | undefined, roots: readonly string[]): string | undefined {
  const folder = cwd?.trim().replace(/(.)[\\/]+$/u, '$1')
  if (!folder) return undefined
  for (const root of roots) {
    const base = root.replace(/(.)[\\/]+$/u, '$1')
    if (folder === base) return undefined
    if (folder.startsWith(`${base}/`)) return folder.slice(base.length + 1)
  }
  const parts = folder.split('/')
  return parts.length > FOLDER_PARTS + 1 ? `…/${parts.slice(-FOLDER_PARTS).join('/')}` : folder
}

/** The folder a call says it ran in, from its arguments. */
export function reportedFolder(input: string | undefined): string | undefined {
  const view = argumentView(input)
  if (view.kind !== 'entries') return undefined
  return view.entries.find(([key, value]) => (key === 'cwd' || key === 'workdir') && value.trim() && !value.includes('\n'))?.[1]
}
