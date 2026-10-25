import { constants } from 'node:fs'
import { mkdir, readdir, realpath, lstat, open, rename, unlink, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { FileDiff } from '@latch/protocol'
import type { HarnessPlugin, SessionFolder } from '@latch/sdk'

const pathInput = z.object({ path: z.string().min(1).max(1024), folder: z.string().min(1).max(64).optional() }).strict()
const writeInput = pathInput.extend({ content: z.string().max(65536) })
const noInput = z.object({}).strict()
const FOLDERS_HINT = 'The project may have several folders: call list_folders and pass `folder`; without it the primary folder is used.'
const FOLDER_PARAMETER = { type: 'string', description: 'Folder ID from list_folders. Default: the primary folder.' }
const READ_LIMIT = 131072
const SYMLINK_REFUSED = '工作区工具不访问符号链接'
// Windows has no O_NOFOLLOW; the identity checks below still apply there.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0

export interface WorkspacePluginOptions {
  /** Absolute paths no tool may read, list, or write, e.g. the Host's private data directory. */
  protectedPaths?: string[]
  /**
   * Test seam only; the Host never sets it. `afterResolve` runs after a path has been walked and
   * checked: before `read_file` opens the file, and before `write_file` renames its temporary file into place.
   */
  hooks?: { afterResolve?(absolutePath: string): Promise<void> }
}

type Hooks = WorkspacePluginOptions['hooks']

interface FolderContext {
  workspaceRoot: string
  workspaceFolders?: ReadonlyArray<SessionFolder>
}

/** The session's folders; a driver that passes none has one, its working directory. */
function foldersOf(context: FolderContext): ReadonlyArray<SessionFolder> {
  return context.workspaceFolders?.length ? context.workspaceFolders : [{ id: 'default', path: context.workspaceRoot, primary: true }]
}

/** The folder a call works in: the one `folder` names, or the primary folder. Paths are relative to it. */
function targetFolder(context: FolderContext, id: string | undefined): { folder: SessionFolder; several: boolean } {
  const folders = foldersOf(context)
  const folder = id === undefined ? (folders.find(item => item.primary) ?? folders[0]) : folders.find(item => item.id === id)
  if (!folder) throw new Error(`这个会话没有 ID 为 ${JSON.stringify(id)} 的文件夹，请调用 list_folders 查看`)
  return { folder, several: folders.length > 1 }
}

/** The name a folder is shown by: its directory name, never its absolute path. */
function folderName(folder: SessionFolder): string {
  return basename(folder.path) || folder.id
}

/** `<verb> <path>`, naming the folder it is in when the session has several. */
function describe(verb: string, path: string, target: { folder: SessionFolder; several: boolean }): string {
  return target.several ? `${verb}「${folderName(target.folder)}」中的 ${path}` : `${verb} ${path}`
}

function codeOf(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}
function missing(error: unknown): boolean {
  return codeOf(error) === 'ENOENT' || codeOf(error) === 'ENOTDIR'
}
function identity(stats: { dev: number | bigint; ino: number | bigint }): string {
  return `${stats.dev}:${stats.ino}`
}
function sameFile(left: { dev: bigint; ino: bigint }, right: { dev: bigint; ino: bigint }): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/**
 * Identity comparison also covers case-insensitive file systems and alternate spellings, which a
 * string prefix check of a not-yet-existing target cannot.
 */
class ProtectedPaths {
  constructor(private readonly paths: readonly string[]) {}

  get empty(): boolean {
    return this.paths.length === 0
  }

  async identities(): Promise<Set<string>> {
    const ids = new Set<string>()
    for (const path of this.paths) {
      try {
        ids.add(identity(await stat(path, { bigint: true })))
      } catch (error) {
        if (!missing(error)) throw error
      }
    }
    return ids
  }

  /** Rejects `target` when it, or any ancestor, is a protected path. */
  async assertAllowed(target: string): Promise<void> {
    if (this.empty) return
    const ids = await this.identities()
    const spelled = await Promise.all(this.paths.map(path => realpath(path).catch(() => resolve(path))))
    for (let current = target; ; current = dirname(current)) {
      let id: string | undefined
      try {
        id = identity(await lstat(current, { bigint: true }))
      } catch (error) {
        if (!missing(error)) throw error
      }
      if (spelled.includes(current) || (id !== undefined && ids.has(id)))
        throw new Error('该路径属于 Latch 的私有数据目录，工作区工具不能访问')
      if (dirname(current) === current) return
    }
  }
}

/** Resolves existing ancestors and refuses symlinks rather than following them outside the workspace. */
async function workspacePath(root: string, name: string, guard: ProtectedPaths): Promise<string> {
  if (isAbsolute(name) || name.includes('\0')) throw new Error('请使用工作区内的相对路径')
  const base = await realpath(root)
  const target = resolve(base, name)
  if (target !== base && !target.startsWith(base + sep)) throw new Error('路径超出工作区')
  let current = base
  for (const part of relative(base, target).split(sep).filter(Boolean)) {
    current = resolve(current, part)
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(SYMLINK_REFUSED)
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error
    }
  }
  await guard.assertAllowed(target)
  return target
}

/**
 * Reads a regular UTF-8 file. The walk and the open are separate system calls, so the open refuses a
 * final symlink (O_NOFOLLOW) and the path is walked again afterwards: the opened file must still be
 * the one at that path, which catches an ancestor swapped for a symlink in between. O_NONBLOCK keeps
 * a FIFO from blocking the run before the type check.
 */
async function readRegular(root: string, name: string, guard: ProtectedPaths, signal: AbortSignal, hooks: Hooks): Promise<string> {
  const target = await workspacePath(root, name, guard)
  await hooks?.afterResolve?.(target)
  const handle = await open(target, constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK).catch((error: unknown) => {
    throw codeOf(error) === 'ELOOP' ? new Error(SYMLINK_REFUSED) : error
  })
  try {
    const info = await handle.stat({ bigint: true })
    if (!info.isFile()) throw new Error('只能读取普通文件')
    await workspacePath(root, name, guard)
    const current = await lstat(target, { bigint: true }).catch(() => undefined)
    if (!current || !sameFile(current, info)) throw new Error(SYMLINK_REFUSED)
    if (info.size > READ_LIMIT) throw new Error('文件超过 128 KiB，请缩小读取范围')
    return await handle.readFile({ encoding: 'utf8', signal })
  } finally {
    await handle.close()
  }
}

/**
 * Writes through a 0600 temporary file in the target's directory, then renames it into place. The
 * rename resolves the path again, so it happens only while the parent directory is still the one that
 * was checked, no component is a symlink, and the temporary file is still ours.
 */
async function writeRegular(
  root: string,
  name: string,
  content: string,
  guard: ProtectedPaths,
  signal: AbortSignal,
  hooks: Hooks,
): Promise<void> {
  const target = await workspacePath(root, name, guard)
  signal.throwIfAborted()
  await mkdir(dirname(target), { recursive: true })
  await workspacePath(root, name, guard)
  const parent = dirname(target)
  const parentId = await lstat(parent, { bigint: true })
  const unchanged = async (temp: string, tempId: { dev: bigint; ino: bigint }) => {
    const [nowParent, nowTemp] = await Promise.all([lstat(parent, { bigint: true }), lstat(temp, { bigint: true })])
    if (!sameFile(nowParent, parentId) || !sameFile(nowTemp, tempId)) throw new Error(SYMLINK_REFUSED)
  }
  const temp = `${target}.${randomUUID()}.tmp`
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600)
  let tempId: { dev: bigint; ino: bigint }
  try {
    tempId = await handle.stat({ bigint: true })
    // Nothing is written into a directory that was swapped after the walk.
    await unchanged(temp, tempId)
    await handle.writeFile(content, { encoding: 'utf8', signal })
    await handle.sync()
  } catch (error) {
    await handle.close()
    await unlink(temp).catch(() => {})
    throw error
  }
  await handle.close()
  try {
    await hooks?.afterResolve?.(target)
    signal.throwIfAborted()
    await workspacePath(root, name, guard)
    await unchanged(temp, tempId)
    await rename(temp, target)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

/** Built-in file capabilities; all writes pass through the runtime approval gate. */
export function createWorkspacePlugin(options: WorkspacePluginOptions = {}): HarnessPlugin {
  const protectedPaths = (options.protectedPaths ?? []).map(path => {
    if (!isAbsolute(path)) throw new Error('Protected workspace paths must be absolute')
    return resolve(path)
  })
  const guard = new ProtectedPaths(protectedPaths)
  const hooks = options.hooks
  return {
    id: 'workspace-files',
    name: '工作区文件',
    version: '1.2.0',
    description: '列出、读取和编辑项目各文件夹中的文件；每次写入需要审批，节点私有数据不可访问。',
    activate(ctx) {
      ctx.registerTool({
        name: 'list_folders',
        title: '列出文件夹',
        description:
          "List the folders of this session's project: each folder's ID, its directory name, and whether it is the primary folder. Pass an ID as `folder` to list_files, read_file and write_file.",
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        requiresApproval: false,
        kind: 'search',
        async execute(args, context) {
          noInput.parse(args)
          context.signal.throwIfAborted()
          // Directory names only: absolute paths of the owner's computer never reach the model from here.
          const folders = foldersOf(context).map(folder => ({ folder: folder.id, name: folderName(folder), primary: folder.primary }))
          return { text: JSON.stringify(folders, null, 2) }
        },
      })
      ctx.registerTool({
        name: 'list_files',
        title: '列出文件',
        description: `List up to 200 entries in a directory of a project folder. Use path "." for the folder itself. ${FOLDERS_HINT}`,
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, folder: FOLDER_PARAMETER },
          required: ['path'],
          additionalProperties: false,
        },
        requiresApproval: false,
        kind: 'search',
        async execute(args, context) {
          const { path, folder } = pathInput.parse(args)
          context.signal.throwIfAborted()
          const directory = await workspacePath(targetFolder(context, folder).folder.path, path, guard)
          const entries = (await readdir(directory, { withFileTypes: true })).slice(0, 200)
          const hidden = guard.empty ? new Set<string>() : await guard.identities()
          const lines: string[] = []
          for (const entry of entries) {
            let type = entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink (not accessible)' : 'file'
            if (hidden.size) {
              const id = await lstat(join(directory, entry.name), { bigint: true }).then(identity, () => undefined)
              if (id !== undefined && hidden.has(id)) type = 'protected (not accessible)'
            }
            lines.push(`${type}\t${entry.name}`)
          }
          return { text: lines.join('\n') || '空目录' }
        },
      })
      ctx.registerTool({
        name: 'read_file',
        title: '读取文件',
        description: `Read a UTF-8 file in a project folder (up to 128 KiB); path is relative to the folder. ${FOLDERS_HINT}`,
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, folder: FOLDER_PARAMETER },
          required: ['path'],
          additionalProperties: false,
        },
        requiresApproval: false,
        kind: 'read',
        async execute(args, context) {
          const { path, folder } = pathInput.parse(args)
          context.signal.throwIfAborted()
          return { text: await readRegular(targetFolder(context, folder).folder.path, path, guard, context.signal, hooks) }
        },
      })
      ctx.registerTool({
        name: 'write_file',
        title: '写入文件',
        description: `Create or replace a UTF-8 file in a project folder; path is relative to the folder. The user approves the exact path and content before writing. ${FOLDERS_HINT}`,
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' }, folder: FOLDER_PARAMETER },
          required: ['path', 'content'],
          additionalProperties: false,
        },
        requiresApproval: true,
        kind: 'edit',
        async preview(args, context) {
          const input = writeInput.parse(args)
          const folder = targetFolder(context, input.folder)
          const target = await workspacePath(folder.folder.path, input.path, guard)
          let oldText: string | undefined
          // A missing, oversized, non-regular, or swapped file has no previous text to show.
          try {
            oldText = await readRegular(folder.folder.path, input.path, guard, context.signal, undefined)
          } catch (error) {
            if (context.signal.aborted) throw error
          }
          if (oldText?.includes('\0')) oldText = undefined // Binary content is not shown as text.
          // Only a confirmed absence is a new file; anything that exists but is not shown, or could not be checked, is not.
          const previous: NonNullable<FileDiff['previous']> =
            oldText !== undefined
              ? 'text'
              : await lstat(target).then(
                  () => 'unavailable' as const,
                  (error: unknown) => (codeOf(error) === 'ENOENT' ? ('none' as const) : ('unavailable' as const)),
                )
          const diff: FileDiff = { path: input.path, ...(oldText !== undefined ? { oldText } : {}), newText: input.content, previous }
          return { title: describe('写入', input.path, folder), diffs: [diff] }
        },
        async execute(args, context) {
          const input = writeInput.parse(args)
          const folder = targetFolder(context, input.folder)
          await writeRegular(folder.folder.path, input.path, input.content, guard, context.signal, hooks)
          return { text: `${describe('已写入', input.path, folder)}（${Buffer.byteLength(input.content)} 字节）` }
        },
      })
    },
  }
}
