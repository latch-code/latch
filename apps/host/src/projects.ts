import { basename } from 'node:path'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import { availableId, folderIdFor, type WorkspaceFolderRecord, type WorkspaceRecord } from './config.ts'
import { checkFolderCandidate, checkProjectFolders, isAgentSafePath, type FolderCheckOptions, type FolderGuardContext } from './paths.ts'

/**
 * Project rules shared by the Host's routes and `pnpm latch project`, so a folder added while the Host is stopped meets
 * exactly the rules of one added from the desktop.
 */

export interface FolderRefusal {
  /** As the request gave it. */
  path: string
  code: string
  message: string
}

/** The primary folder of another project, or the start directory (`id: 'default'`). */
export interface ProjectPrimary {
  id: string
  name: string
  path: string
}

export interface FolderPlan {
  /** The project's folders after the change, in order. */
  folders: WorkspaceFolderRecord[]
  /** Folders that joined, with their IDs, in order. */
  added: WorkspaceFolderRecord[]
  refused: FolderRefusal[]
}

/**
 * Applies R1–R10 to each path and the project rules to the list as it grows, in the order given: a path that fails is
 * refused and the others still join. For a new project (`current` empty) the first accepted path becomes the primary
 * folder. `replace` puts its single path in place of that folder, keeping the folder's ID and position.
 */
export async function planFolders(input: {
  current: readonly WorkspaceFolderRecord[]
  paths: readonly string[]
  replace?: string
  /** Primary folders of the other projects and the start directory; a new primary folder may equal none of them. */
  primaries: readonly ProjectPrimary[]
  guard: FolderGuardContext
  check?: Pick<FolderCheckOptions, 'opendir'>
}): Promise<FolderPlan> {
  const folders = input.current.map(folder => ({ ...folder }))
  const replaceIndex = input.replace === undefined ? -1 : folders.findIndex(folder => folder.id === input.replace)
  if (input.replace !== undefined && replaceIndex < 0) throw new AppError(404, 'workspace-folder-not-found', '找不到该文件夹')
  if (input.replace !== undefined && input.paths.length !== 1) throw new AppError(400, 'invalid-input', '重新选择文件夹时只能提供一个路径')
  const added: WorkspaceFolderRecord[] = []
  const refused: FolderRefusal[] = []
  for (const path of input.paths) {
    const verdict = await checkFolderCandidate(path, input.guard, { ...input.check, added: true, readable: true })
    if (!verdict.ok) {
      refused.push({ path, code: verdict.error.code, message: verdict.error.message })
      continue
    }
    const folder =
      replaceIndex >= 0
        ? { id: input.replace!, path: verdict.realPath }
        : {
            id: folderIdFor(
              basename(verdict.realPath),
              folders.map(item => item.id),
            ),
            path: verdict.realPath,
          }
    const next = replaceIndex >= 0 ? folders.map((item, index) => (index === replaceIndex ? folder : item)) : [...folders, folder]
    const primaryChanged = next[0]?.path !== folders[0]?.path
    const project = await checkProjectFolders(
      next.map(item => item.path),
      { existing: primaryChanged ? input.primaries : [] },
    )
    if (!project.ok) {
      refused.push({ path, code: project.error.code, message: project.error.message })
      continue
    }
    folders.splice(0, folders.length, ...next)
    added.push(folder)
  }
  return { folders, added, refused }
}

/**
 * A new project record around planned folders: its ID never reuses one in `taken` (saved projects and
 * `remote.workspaces`). The ID comes from `idBase`, else the name, else the primary folder's basename.
 */
export function newProject(input: {
  name?: string
  idBase?: string
  folders: WorkspaceFolderRecord[]
  taken: Iterable<string>
}): WorkspaceRecord {
  const primary = input.folders[0].path
  let derived = ''
  for (const character of basename(primary) || primary) {
    if (derived.length + character.length > 80) break
    derived += character
  }
  const name = input.name ?? derived
  return { id: availableId(input.idBase ?? input.name ?? basename(primary), input.taken), name, path: primary, folders: input.folders }
}

/** Audit form of a folder list: SHA-256 of the canonical list of realpaths. */
export function foldersHash(folders: readonly WorkspaceFolderRecord[]): string {
  return sha256Hex(canonicalJson(folders.map(folder => folder.path)))
}

/**
 * A new order for a project's folders: a permutation of its folder IDs. Folders moved out of the primary position must
 * pass R9 (a primary folder saved before R9 existed may contain `,`, `*` or `?`).
 */
export function reorderFolders(current: readonly WorkspaceFolderRecord[], order: readonly string[]): WorkspaceFolderRecord[] {
  const byId = new Map(current.map(folder => [folder.id, folder]))
  if (order.length !== current.length || new Set(order).size !== order.length || order.some(id => !byId.has(id)))
    throw new AppError(400, 'workspace-order-invalid', '新的顺序必须包含项目的每个文件夹，且各出现一次')
  const next = order.map(id => byId.get(id)!)
  if (next.slice(1).some(folder => !isAgentSafePath(folder.path)))
    throw new AppError(400, 'workspace-folder-chars', '路径含逗号、* 或 ? 的文件夹只能作为主文件夹')
  return next
}
