import { execFile } from 'node:child_process'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { latchCodeRoot } from '../src/paths.ts'

const run = promisify(execFile)

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
      { timeout: 120_000, maxBuffer: 1024 * 1024 },
    )
    await run('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--identifier', 'dev.latch.files', temporary], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    })
    await run('/usr/bin/codesign', ['--verify', '--strict', temporary], { timeout: 30_000, maxBuffer: 1024 * 1024 })
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
