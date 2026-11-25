import { lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalPath, isInsidePath, pathKey, type LatchPaths } from './paths.ts'
import { SessionFolders } from './session-folders.ts'
import { SessionMetaStore } from './session-meta.ts'
import { Worktrees } from './worktrees.ts'

/** Only a real directory at an old default path can still be used as an automatic default. */
async function oldDirectory(path: string, codeRoot: string): Promise<string | undefined> {
  if (!(await lstat(path).catch(() => undefined))?.isDirectory()) return undefined
  const resolved = await realpath(path).catch(() => undefined)
  if (resolved === undefined || pathKey(resolved) !== pathKey(path)) return undefined
  const canonical = await canonicalPath(resolved).catch(() => undefined)
  if (canonical === undefined || isInsidePath(canonical, codeRoot) || isInsidePath(codeRoot, canonical)) return undefined
  return resolved
}

/** Under the Host lock, keep the earlier automatic paths only for existing ordinary work. */
export async function legacyDefaultPaths(
  paths: Pick<LatchPaths, 'dataDir' | 'workspaceSource'>,
  home: string,
  codeRoot: string,
  explicitWorktrees: boolean,
): Promise<{ workspaceRoot?: string; worktreesDir?: string }> {
  if (paths.workspaceSource !== 'default') return {}
  const realHome = await realpath(home)
  const canonicalCode = await canonicalPath(codeRoot)
  const { dataDir } = paths
  const compatible: { workspaceRoot?: string; worktreesDir?: string } = {}
  let savedWorktrees: ReturnType<SessionMetaStore['worktrees']> | undefined
  for (const name of ['Latch', 'Latch Files']) {
    const parent = join(realHome, name)
    if (!compatible.workspaceRoot) {
      const root = await oldDirectory(join(parent, 'workspace'), canonicalCode)
      if (root) {
        const folders = new SessionFolders({
          dataDir,
          root,
          canonicalRoot: await canonicalPath(root),
          clock: Date.now,
          now: Date.now,
          log() {},
        })
        if (await folders.hasRecordedSessionFolder()) compatible.workspaceRoot = root
      }
    }
    if (!explicitWorktrees && !compatible.worktreesDir) {
      const root = await oldDirectory(join(parent, 'worktrees'), canonicalCode)
      if (root) {
        savedWorktrees ??= (await SessionMetaStore.open(dataDir)).worktrees().filter(worktree => !worktree.removed)
        const worktrees = new Worktrees({ dataDir, root, log() {} })
        for (const { path, sessionId } of savedWorktrees) {
          if (isInsidePath(path, root) && (await worktrees.sessionOf(path)) === sessionId) {
            compatible.worktreesDir = root
            break
          }
        }
      }
    }
  }
  return compatible
}
