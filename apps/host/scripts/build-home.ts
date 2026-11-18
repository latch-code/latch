import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { latchCodeRoot } from '../src/paths.ts'

const run = promisify(execFile)
const VERIFICATION_TIMEOUT = 30_000

/** The signed artifact archives and removes a scratch home, and leaves a link's target alone when a directory is swapped mid-walk. */
async function verifyHome(binary: string): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), 'latch-home-check-'))
  try {
    const { stdout, stderr } = await run(binary, ['--self-test', scratch], { timeout: VERIFICATION_TIMEOUT, maxBuffer: 4096, env: {} })
    const value: unknown = JSON.parse(stdout)
    if (stderr !== '' || !value || typeof value !== 'object' || !('ok' in value) || value.ok !== true)
      throw new Error('Invalid self-check result')
  } catch {
    throw new Error('Home helper self-check failed')
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** Built separately, like latch-files: without it an Agent's folder is neither exported nor removed, only left and reported. */
export async function buildHomeHelper(codeRoot = latchCodeRoot()): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined
  const directory = join(codeRoot, 'dist', 'native')
  const output = join(directory, 'latch-home')
  const temporary = join(directory, `.latch-home-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  try {
    await run(
      '/usr/bin/xcrun',
      ['swiftc', '-swift-version', '6', '-O', '-parse-as-library', '-o', temporary, join(codeRoot, 'native', 'macos', 'LatchHome.swift')],
      { timeout: 120_000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: tmpdir() } },
    )
    await run('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--identifier', 'dev.latch.home', temporary], {
      timeout: VERIFICATION_TIMEOUT,
      maxBuffer: 1024 * 1024,
      env: {},
    })
    await run('/usr/bin/codesign', ['--verify', '--strict', temporary], { timeout: VERIFICATION_TIMEOUT, maxBuffer: 1024 * 1024, env: {} })
    await verifyHome(temporary)
    await rename(temporary, output)
    return output
  } finally {
    await rm(temporary, { force: true })
  }
}

if (import.meta.main) {
  try {
    const result = await buildHomeHelper()
    console.log(result ? 'latch-home 已构建' : 'latch-home 仅支持 macOS')
  } catch {
    console.error('latch-home 构建失败；Agent 的文件夹将不能导出或删除')
    process.exitCode = 1
  }
}
