// Lists the files created by a session's turns and removes chosen ones once verified unchanged since creation.
import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, rmdir, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import {
  isFileMention,
  type FileMention,
  type Message,
  type OutputsCleanupPreview,
  type OutputsCleanupResult,
  type OutputsCleanupSkipped,
  type SessionOutputFile,
  type SessionOutputsList,
} from '@latch/protocol'
import { AppError, type ProjectFolder } from '@latch/sdk'
import { canonicalJson } from '@latch/core/node-kit'
import { openRootGitIgnore } from '../files/git-ignore-scope.ts'
import { isIgnoredPath } from '../files/ignore.ts'
import type { FileRoot, ManagedHomeAccess } from '../files/resolve.ts'
import { hasSecretContent, isSecretPath } from '../files/secrets.ts'
import { SNIFF_BYTES } from '../files/sniff.ts'
import { isInsidePath } from '../paths.ts'
import type { GitReader } from './git.ts'
import { hashHandle } from './objects.ts'
import { NAMED_FILE_LIMIT } from './records.ts'
import { removeFrom } from './restore.ts'
import { ProtectedIndex, fileKey, realRoots } from './walk.ts'

const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const HASH_LIMIT = 128 * 1024 * 1024
const DOCUMENT_KINDS: ReadonlySet<string> = new Set(['pptx', 'pdf', 'docx', 'xlsx', 'csv', 'html', 'image', 'svg', 'audio', 'video'])

interface RecordedCreation {
  root: string
  path: string
  kind?: SessionOutputFile['kind']
  size?: number
  gitIgnored?: true
  sha256?: string
  messageId: string
  turnIndex: number
  turnId?: string
}

interface VerifiedStep {
  root: FileRoot
  path: string
  size: number
  expectedHash: string
}

export interface OutputsAuditPlan {
  sessionId: string
  remove: number
  skipped: number
  planHash: string
}

async function openGuard(
  sessionId: string,
  folders: readonly ProjectFolder[],
  protectedPaths: readonly string[],
  managedHome?: ManagedHomeAccess,
): Promise<{ guard: ProtectedIndex; roots: FileRoot[] }> {
  let guard: ProtectedIndex
  if (managedHome && folders.length === 1) {
    const single = await openRootPath(folders[0]!.path)
    if (single && (await managedHome.permits(sessionId, single)))
      guard = await ProtectedIndex.of(protectedPaths, { root: single, protectedAncestor: managedHome.protectedAncestor })
    else guard = await ProtectedIndex.of(protectedPaths)
  } else {
    guard = await ProtectedIndex.of(protectedPaths)
  }
  const roots = await realRoots(folders, guard)
  return { guard, roots }
}

async function openRootPath(path: string): Promise<string | undefined> {
  const { realpath } = await import('node:fs/promises')
  return realpath(path).catch(() => undefined)
}

/** Collects files created across the session's messages, keeping the latest state and hash recorded by the session's turns. */
async function collectCreations(
  messages: readonly Message[],
  roots: readonly FileRoot[],
  fallbackHashes: ReadonlyMap<string, string>,
  git?: GitReader,
): Promise<Map<string, RecordedCreation>> {
  const scopes = new Map(
    await Promise.all(roots.map(async root => [root.id, await openRootGitIgnore(root, { ...(git ? { git } : {}) })] as const)),
  )
  const created = new Map<string, RecordedCreation>()
  let turnIndex = 0
  let currentTurnId: string | undefined
  for (const message of messages) {
    if (message.role === 'user' && !message.steered) {
      turnIndex += 1
      currentTurnId = message.turnId
      continue
    }
    if (!message.outputs?.length) continue
    for (const output of message.outputs) {
      if (!isFileMention({ root: output.root, path: output.path }) || isIgnoredPath(output.path)) continue
      const key = fileKey(output.root, output.path)
      if (output.change === 'deleted') {
        created.delete(key)
        continue
      }
      const gitIgnored = (await scopes.get(output.root)?.isIgnored(output.path)) ?? output.gitIgnored === true
      const isCreated = output.change === 'created' || output.fresh === true
      if (isCreated) {
        if (!gitIgnored && !(output.kind !== undefined && DOCUMENT_KINDS.has(output.kind))) continue
        const sha256 = output.sha256 ?? fallbackHashes.get(key)
        created.set(key, {
          root: output.root,
          path: output.path,
          ...(output.kind ? { kind: output.kind } : {}),
          ...(output.size !== undefined ? { size: output.size } : {}),
          ...(gitIgnored ? { gitIgnored: true as const } : {}),
          ...(sha256 ? { sha256 } : {}),
          messageId: message.id,
          turnIndex: Math.max(1, turnIndex),
          ...(currentTurnId ? { turnId: currentTurnId } : {}),
        })
      } else if (output.change === 'modified') {
        const previous = created.get(key)
        if (!previous) continue
        const sha256 = output.sha256 ?? fallbackHashes.get(key) ?? previous.sha256
        created.set(key, {
          ...previous,
          ...(output.size !== undefined ? { size: output.size } : {}),
          ...(gitIgnored ? { gitIgnored: true as const } : {}),
          ...(sha256 ? { sha256 } : {}),
        })
      }
    }
  }
  return created
}

type DiskState =
  | { status: 'missing' }
  | { status: 'secret' }
  | { status: 'too-large'; size: number }
  | { status: 'ok'; size: number; hash: string }

/** Reads a candidate file through a non-following handle after checking every parent directory stays inside `root`. */
async function inspectOnDisk(root: FileRoot, relativePath: string, guard: ProtectedIndex): Promise<DiskState> {
  const parts = relativePath.split('/')
  let directory = root.path
  for (const part of parts.slice(0, -1)) {
    directory = join(directory, part)
    const info = await lstat(directory, { bigint: true }).catch(() => undefined)
    if (!info || !info.isDirectory() || info.isSymbolicLink() || guard.has(directory, info)) return { status: 'missing' }
  }
  const target = join(directory, parts.at(-1)!)
  const before = await lstat(target, { bigint: true }).catch(() => undefined)
  if (!before || !before.isFile() || before.isSymbolicLink() || guard.has(target, before)) return { status: 'missing' }
  if (await guard.paths.contains(target)) return { status: 'missing' }
  let handle: FileHandle
  try {
    handle = await open(target, constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return { status: 'missing' }
  }
  try {
    const info = await handle.stat({ bigint: true })
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) return { status: 'missing' }
    const size = Number(info.size)
    const head = Buffer.alloc(Math.min(SNIFF_BYTES, size))
    if (head.length > 0) await handle.read(head, 0, head.length, 0)
    if (isSecretPath(relativePath, head) || hasSecretContent(head)) return { status: 'secret' }
    if (size > HASH_LIMIT) return { status: 'too-large', size }
    const hash = await hashHandle(handle)
    return { status: 'ok', size, hash }
  } finally {
    await handle.close().catch(() => {})
  }
}

export async function listSessionOutputs(input: {
  sessionId: string
  folders: readonly ProjectFolder[]
  messages: readonly Message[]
  protectedPaths: readonly string[]
  managedHome?: ManagedHomeAccess
  fallbackHashes: ReadonlyMap<string, string>
  git?: GitReader
}): Promise<SessionOutputsList> {
  const { guard, roots } = await openGuard(input.sessionId, input.folders, input.protectedPaths, input.managedHome)
  const creations = await collectCreations(input.messages, roots, input.fallbackHashes, input.git)
  const files: SessionOutputFile[] = []
  for (const item of creations.values()) {
    const root = roots.find(entry => entry.id === item.root)
    if (!root) continue
    const disk = await inspectOnDisk(root, item.path, guard)
    if (disk.status === 'secret') continue
    const exists = disk.status === 'ok' || disk.status === 'too-large'
    const size = disk.status === 'ok' || disk.status === 'too-large' ? disk.size : item.size
    const matches = disk.status === 'ok' && item.sha256 !== undefined && disk.hash === item.sha256
    const changedSince = disk.status === 'ok' && item.sha256 !== undefined && disk.hash !== item.sha256
    files.push({
      root: item.root,
      path: item.path,
      ...(item.kind ? { kind: item.kind } : {}),
      ...(size !== undefined ? { size } : {}),
      ...(item.gitIgnored ? { gitIgnored: true as const } : {}),
      exists,
      ...(changedSince ? { changedSince: true as const } : {}),
      removable: exists && matches,
      messageId: item.messageId,
      turnIndex: item.turnIndex,
      ...(item.turnId ? { turnId: item.turnId } : {}),
    })
  }
  return { files }
}

async function buildCleanupPlan(input: {
  sessionId: string
  folders: readonly ProjectFolder[]
  messages: readonly Message[]
  wanted: readonly FileMention[]
  protectedPaths: readonly string[]
  managedHome?: ManagedHomeAccess
  fallbackHashes: ReadonlyMap<string, string>
  git?: GitReader
}): Promise<{
  guard: ProtectedIndex
  steps: VerifiedStep[]
  bytes: number
  skipped: number
  notRemoved: OutputsCleanupSkipped[]
  planHash: string
}> {
  const { guard, roots } = await openGuard(input.sessionId, input.folders, input.protectedPaths, input.managedHome)
  const creations = await collectCreations(input.messages, roots, input.fallbackHashes, input.git)
  const seen = new Set<string>()
  const steps: VerifiedStep[] = []
  const notRemoved: OutputsCleanupSkipped[] = []
  let skipped = 0
  let bytes = 0
  const skip = (file: FileMention, reason: OutputsCleanupSkipped['reason']) => {
    skipped += 1
    if (notRemoved.length < NAMED_FILE_LIMIT) notRemoved.push({ root: file.root, path: file.path, reason })
  }

  for (const target of input.wanted) {
    const key = fileKey(target.root, target.path)
    if (seen.has(key)) continue
    seen.add(key)
    const recorded = creations.get(key)
    if (!recorded) {
      skip(target, 'not-retained')
      continue
    }
    const root = roots.find(item => item.id === target.root)
    if (!root) {
      skip(target, 'folder-missing')
      continue
    }
    const disk = await inspectOnDisk(root, target.path, guard)
    if (disk.status === 'missing') continue
    if (disk.status === 'secret') {
      skip(target, 'secret')
      continue
    }
    if (!recorded.sha256 || disk.status === 'too-large') {
      skip(target, 'not-retained')
      continue
    }
    if (disk.hash !== recorded.sha256) {
      skip(target, 'changed-since')
      continue
    }
    steps.push({ root, path: target.path, size: disk.size, expectedHash: recorded.sha256 })
    bytes += disk.size
  }

  steps.sort((a, b) => a.root.id.localeCompare(b.root.id) || a.path.localeCompare(b.path))
  const planHash = createHash('sha256')
    .update(canonicalJson(steps.map(step => [step.root.id, step.path, step.expectedHash])))
    .digest('hex')

  return { guard, steps, bytes, skipped, notRemoved, planHash }
}

/** Removes newly-emptied parent directories inside `root` without touching symlinks, `.git` or `root` itself. */
async function pruneEmptyParents(steps: readonly VerifiedStep[], guard: ProtectedIndex): Promise<void> {
  const candidates = new Map<string, { root: FileRoot; rel: string; depth: number }>()
  for (const step of steps) {
    const parts = step.path.split('/')
    for (let len = parts.length - 1; len >= 1; len--) {
      const rel = parts.slice(0, len).join('/')
      if (rel === '.git' || rel.startsWith('.git/')) continue
      candidates.set(fileKey(step.root.id, rel), { root: step.root, rel, depth: len })
    }
  }
  const ordered = [...candidates.values()].toSorted((a, b) => b.depth - a.depth || a.rel.localeCompare(b.rel))
  for (const { root, rel } of ordered) {
    const full = join(root.path, ...rel.split('/'))
    if (!isInsidePath(full, root.path) || full === root.path) continue
    const info: BigIntStats | undefined = await lstat(full, { bigint: true }).catch(() => undefined)
    if (!info || !info.isDirectory() || info.isSymbolicLink() || guard.has(full, info)) continue
    await rmdir(full).catch(() => {})
  }
}

export async function previewOutputsCleanup(input: {
  sessionId: string
  folders: readonly ProjectFolder[]
  messages: readonly Message[]
  wanted: readonly FileMention[]
  protectedPaths: readonly string[]
  managedHome?: ManagedHomeAccess
  fallbackHashes: ReadonlyMap<string, string>
  git?: GitReader
}): Promise<OutputsCleanupPreview> {
  const plan = await buildCleanupPlan(input)
  return {
    remove: plan.steps.length,
    bytes: plan.bytes,
    skipped: plan.skipped,
    planHash: plan.planHash,
    removes: plan.steps.slice(0, NAMED_FILE_LIMIT).map(step => ({ root: step.root.id, path: step.path })),
    notRemoved: plan.notRemoved,
  }
}

export async function cleanupOutputs(input: {
  sessionId: string
  folders: readonly ProjectFolder[]
  messages: readonly Message[]
  wanted: readonly FileMention[]
  confirm: string
  protectedPaths: readonly string[]
  managedHome?: ManagedHomeAccess
  fallbackHashes: ReadonlyMap<string, string>
  git?: GitReader
  beforeWrite: (plan: OutputsAuditPlan) => Promise<void>
}): Promise<OutputsCleanupResult> {
  const plan = await buildCleanupPlan(input)
  if (plan.planHash !== input.confirm) throw new AppError(409, 'change-confirm-stale', '这些生成文件已变化，请重新确认。')
  await input.beforeWrite({
    sessionId: input.sessionId,
    remove: plan.steps.length,
    skipped: plan.skipped,
    planHash: plan.planHash,
  })
  let removed = 0
  let removedBytes = 0
  for (const step of plan.steps) {
    await removeFrom(step.root, step.path, plan.guard, async (handle, info) => {
      if (Number(info.size) > HASH_LIMIT) return false
      return (await hashHandle(handle)) === step.expectedHash
    })
    removed += 1
    removedBytes += step.size
  }
  if (plan.steps.length > 0) await pruneEmptyParents(plan.steps, plan.guard)
  return {
    removed,
    bytes: removedBytes,
    skipped: plan.skipped,
    notRemoved: plan.notRemoved,
  }
}
