// Decides whether a relative path inside a session folder is ignored by Git: only when the folder is a Git work tree,
// the path is not tracked in Git's index, and `.gitignore` rules (checked top-down from the root) ignore it.
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { readGitLayout } from '../branch-reader.ts'
import type { GitReader } from '../changes/git.ts'
import { ignoreVerdict, matchBudget, readIgnoreRules, type IgnoreRules } from './gitignore.ts'
import { beginLoopWork, yieldTurn } from './loop-turn.ts'
import type { FileRoot } from './resolve.ts'

export interface RootGitIgnore {
  readonly inRepo: boolean
  isIgnoredDir(relativeDir: string): Promise<boolean>
  isIgnored(relativePath: string): Promise<boolean>
}

const NONE: RootGitIgnore = {
  inRepo: false,
  isIgnoredDir: async () => false,
  isIgnored: async () => false,
}

function parentOf(relativePath: string): string {
  const cut = relativePath.lastIndexOf('/')
  return cut < 0 ? '' : relativePath.slice(0, cut)
}

function ancestorsOf(relativePath: string): string[] {
  const parts = relativePath.split('/')
  const dirs: string[] = []
  for (let index = 1; index < parts.length; index++) dirs.push(parts.slice(0, index).join('/'))
  return dirs
}

export async function openRootGitIgnore(
  root: FileRoot,
  options?: { git?: GitReader; entryLimit?: number; deadlineMs?: number },
): Promise<RootGitIgnore> {
  const hasGit = await lstat(join(root.path, '.git')).then(
    () => true,
    () => false,
  )
  if (!hasGit) return NONE

  const tracked = new Set<string>()
  const trackedDirs = new Set<string>()
  if (options?.git) {
    const layout = await readGitLayout(root.path).catch(() => undefined)
    const listing = layout ? await options.git.index(layout, options.entryLimit ?? 100_000).catch(() => undefined) : undefined
    if (listing) {
      for (const path of [...listing.tracked, ...listing.skipped]) {
        tracked.add(path)
        for (const dir of ancestorsOf(path)) trackedDirs.add(dir)
      }
    }
  }

  const budget = matchBudget(options?.deadlineMs !== undefined ? performance.now() + Math.max(50, options.deadlineMs) : undefined)
  const rulesByDir = new Map<string, Promise<IgnoreRules | undefined>>()
  const dirVerdicts = new Map<string, Promise<boolean>>()

  const checkMatch = async (rules: IgnoreRules | undefined, relativePath: string, directory: boolean): Promise<boolean> => {
    const end = beginLoopWork()
    try {
      let verdict = ignoreVerdict(rules, relativePath, directory, budget)
      if (verdict === 'undecided' && budget.cut === 'time') {
        await yieldTurn()
        verdict = ignoreVerdict(rules, relativePath, directory, budget)
      }
      return verdict !== 'kept'
    } finally {
      end()
    }
  }

  const rulesForDir = (relativeDir: string): Promise<IgnoreRules | undefined> => {
    const cached = rulesByDir.get(relativeDir)
    if (cached) return cached
    const promise = (async () => {
      const end = beginLoopWork()
      try {
        if (!relativeDir) return await readIgnoreRules(root.path, '', undefined, budget)
        const parent = await rulesForDir(parentOf(relativeDir))
        return await readIgnoreRules(join(root.path, ...relativeDir.split('/')), relativeDir, parent, budget)
      } finally {
        end()
      }
    })()
    rulesByDir.set(relativeDir, promise)
    return promise
  }

  const rawDirIgnored = (relativeDir: string): Promise<boolean> => {
    const cached = dirVerdicts.get(relativeDir)
    if (cached) return cached
    const promise = (async () => {
      const parent = parentOf(relativeDir)
      if (parent && (await rawDirIgnored(parent))) return true
      const rules = await rulesForDir(parent)
      return checkMatch(rules, relativeDir, true)
    })()
    dirVerdicts.set(relativeDir, promise)
    return promise
  }

  return {
    inRepo: true,
    async isIgnoredDir(relativeDir: string): Promise<boolean> {
      if (!relativeDir || trackedDirs.has(relativeDir)) return false
      return rawDirIgnored(relativeDir)
    },
    async isIgnored(relativePath: string): Promise<boolean> {
      if (!relativePath || tracked.has(relativePath)) return false
      const parent = parentOf(relativePath)
      if (parent && (await rawDirIgnored(parent))) return true
      const rules = await rulesForDir(parent)
      return checkMatch(rules, relativePath, false)
    },
  }
}
