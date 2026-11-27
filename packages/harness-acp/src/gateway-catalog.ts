import { statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { sha256Hex, writeFileAtomic } from '@latch/core/node-kit'
import { locateProgram, runPresetProgram } from './login.ts'
import { selectProfile } from './permission.ts'
import type { AgentRecord } from './types.ts'

/** What the program printed, and which built files it accepted, for as long as the program's file is the same one. */
const reads = new Map<string, { stamp: string; stdout: Promise<string | undefined>; accepted: Set<string> }>()

function stampOf(path: string): string | undefined {
  try {
    const stats = statSync(path)
    return `${stats.dev}:${stats.ino}:${stats.mtimeMs}:${stats.size}`
  } catch {
    return undefined
  }
}

/**
 * Builds a profile's catalog file for one launch and gives its path, or undefined when the harness's program cannot be
 * run, prints something else, or refuses the built file. The read and each accepted content are remembered per program
 * file, a failed read too, so a launch after the first runs nothing.
 */
export async function buildGatewayCatalog(
  record: AgentRecord,
  path: string,
  build: (stdout: string) => string | undefined,
): Promise<string | undefined> {
  const { preset, profile } = selectProfile(record)
  const catalog = profile?.gateway?.via === 'launch' ? profile.gateway.catalog : undefined
  const program = preset ? locateProgram(preset.command) : undefined
  const stamp = program ? stampOf(program) : undefined
  if (!catalog || !program || !stamp) return undefined
  const key = `${program}\0${record.accountDirectory ?? ''}`
  let known = reads.get(key)
  if (known?.stamp !== stamp) {
    known = {
      stamp,
      stdout: runPresetProgram(record, catalog.read.args, catalog.read).then(result => (result?.code === 0 ? result.stdout : undefined)),
      accepted: new Set(),
    }
    reads.set(key, known)
  }
  const stdout = await known.stdout
  // A program that does not answer is not asked again until its file changes: a launch never waits for it twice.
  if (stdout === undefined) return undefined
  const text = build(stdout)
  if (text === undefined) return undefined
  await writeFileAtomic(path, text)
  const digest = sha256Hex(text)
  if (known.accepted.has(digest)) return path
  const checked = await runPresetProgram(record, catalog.check(path), { timeoutMs: catalog.read.timeoutMs, maxOutput: 1024 })
  if (checked?.code === 0) {
    known.accepted.add(digest)
    return path
  }
  await rm(path, { force: true })
  return undefined
}
