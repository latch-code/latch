import { execFile } from 'node:child_process'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { latchCodeRoot } from '../src/paths.ts'

const run = promisify(execFile)

/** Built separately, like latch-files: without the helper the Host offers no terminal rather than another way to run one. */
export async function buildTerminalHelper(codeRoot = latchCodeRoot()): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined
  const directory = join(codeRoot, 'dist', 'native')
  const output = join(directory, 'latch-pty')
  const temporary = join(directory, `.latch-pty-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  try {
    await run(
      '/usr/bin/xcrun',
      [
        'swiftc',
        '-swift-version',
        '6',
        '-O',
        '-parse-as-library',
        '-o',
        temporary,
        join(codeRoot, 'native', 'macos', 'LatchTerminal.swift'),
      ],
      { timeout: 120_000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: tmpdir() } },
    )
    await run('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--identifier', 'dev.latch.pty', temporary], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: {},
    })
    await run('/usr/bin/codesign', ['--verify', '--strict', temporary], { timeout: 30_000, maxBuffer: 1024 * 1024, env: {} })
    await rename(temporary, output)
    return output
  } finally {
    await rm(temporary, { force: true })
  }
}

if (import.meta.main) {
  try {
    const result = await buildTerminalHelper()
    console.log(result ? 'latch-pty 已构建' : 'latch-pty 仅支持 macOS')
  } catch {
    console.error('latch-pty 构建失败；终端将不可用')
    process.exitCode = 1
  }
}
