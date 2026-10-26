import { execFile } from 'node:child_process'
import { mkdir, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { latchCodeRoot } from '../src/paths.ts'

const execute = promisify(execFile)
export async function buildNetworkHelper(codeRoot = latchCodeRoot()): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined
  const output = join(codeRoot, 'dist/native/latch-network'),
    temporary = `${output}.${randomUUID()}.tmp`,
    info = join(codeRoot, 'native/macos/LatchNetwork-Info.plist')
  await mkdir(join(codeRoot, 'dist/native'), { recursive: true })
  try {
    await execute(
      '/usr/bin/xcrun',
      [
        'swiftc',
        '-swift-version',
        '6',
        '-O',
        '-parse-as-library',
        ...['-sectcreate', '__TEXT', '__info_plist', info].flatMap(argument => ['-Xlinker', argument]),
        '-o',
        temporary,
        join(codeRoot, 'native/macos/LatchNetwork.swift'),
      ],
      { timeout: 120000, maxBuffer: 1048576, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: tmpdir() } },
    )
    await execute('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--identifier', 'dev.latch.network', temporary], {
      timeout: 30000,
      maxBuffer: 1048576,
      env: {},
    })
    await execute('/usr/bin/codesign', ['--verify', '--strict', temporary], { timeout: 30000, maxBuffer: 1048576, env: {} })
    await rename(temporary, output)
    return output
  } finally {
    await rm(temporary, { force: true })
  }
}
