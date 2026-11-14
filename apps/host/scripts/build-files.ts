import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { latchCodeRoot } from '../src/paths.ts'

const run = promisify(execFile)
const VERIFICATION_TIMEOUT = 30_000

/** Exercise the signed artifact before publishing it; request deadlines still apply independently at runtime. */
async function verifyListing(binary: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'latch-files-check-'))
  try {
    const root = await realpath(directory)
    const check = run(binary, [], { timeout: VERIFICATION_TIMEOUT, maxBuffer: 4096, env: {} })
    check.child.stdin?.on('error', () => {})
    check.child.stdin?.end(JSON.stringify({ root, dir: '', protectedPaths: [], showHidden: false }))
    const { stdout, stderr } = await check
    const value: unknown = JSON.parse(stdout)
    if (
      stderr !== ''
      || !value
      || typeof value !== 'object'
      || Array.isArray(value)
      || Object.keys(value).length !== 2
      || !('entries' in value)
      || !('truncated' in value)
      || !Array.isArray(value.entries)
      || value.entries.length !== 0
      || value.truncated !== false
    )
      throw new Error('Invalid self-check result')
  } catch {
    throw new Error('Directory helper self-check failed')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Build separately: a missing helper disables macOS directory listing instead of using a path-only fallback. */
export async function buildFilesHelper(codeRoot = latchCodeRoot()): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined
  const directory = join(codeRoot, 'dist', 'native')
  const output = join(directory, 'latch-files')
  const temporary = join(directory, `.latch-files-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  try {
    await run(
      '/usr/bin/xcrun',
      ['swiftc', '-swift-version', '6', '-O', '-parse-as-library', '-o', temporary, join(codeRoot, 'native', 'macos', 'LatchFiles.swift')],
      { timeout: 120_000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: tmpdir() } },
    )
    await run('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--identifier', 'dev.latch.files', temporary], {
      timeout: VERIFICATION_TIMEOUT,
      maxBuffer: 1024 * 1024,
      env: {},
    })
    await run('/usr/bin/codesign', ['--verify', '--strict', temporary], { timeout: VERIFICATION_TIMEOUT, maxBuffer: 1024 * 1024, env: {} })
    await verifyListing(temporary)
    await rename(temporary, output)
    return output
  } finally {
    await rm(temporary, { force: true })
  }
}

if (import.meta.main) {
  try {
    const result = await buildFilesHelper()
    console.log(result ? 'latch-files 已构建' : 'latch-files 仅支持 macOS')
  } catch {
    console.error('latch-files 构建失败；目录读取将不可用')
    process.exitCode = 1
  }
}
