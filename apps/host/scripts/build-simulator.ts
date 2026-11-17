import { execFile } from 'node:child_process'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { latchCodeRoot } from '../src/paths.ts'
import { parseSelfTest } from '../src/simulator-helper.ts'

const run = promisify(execFile)
const TIMEOUT = 30_000

/**
 * Built separately, like latch-pty. The helper loads Apple's private CoreSimulator at run time only, so it builds and
 * signs on any Mac with the Swift toolchain; where the frameworks are missing or changed it reports frames as
 * unsupported and the device panel keeps its screenshots.
 */
export async function buildSimulatorHelper(codeRoot = latchCodeRoot()): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined
  const directory = join(codeRoot, 'dist', 'native')
  const output = join(directory, 'latch-simulator')
  const temporary = join(directory, `.latch-simulator-${randomUUID()}`)
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
        join(codeRoot, 'native', 'macos', 'LatchSimulator.swift'),
      ],
      { timeout: 180_000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: tmpdir() } },
    )
    await run('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--identifier', 'dev.latch.simulator', temporary], {
      timeout: TIMEOUT,
      maxBuffer: 1024 * 1024,
      env: {},
    })
    await run('/usr/bin/codesign', ['--verify', '--strict', temporary], { timeout: TIMEOUT, maxBuffer: 1024 * 1024, env: {} })
    // The signed artifact must start and describe itself; whether frames are available on this Mac does not matter here.
    const { stdout } = await run(temporary, ['--self-test'], { timeout: TIMEOUT, maxBuffer: 65_536, env: {}, cwd: '/' })
    parseSelfTest(stdout)
    await rename(temporary, output)
    return output
  } finally {
    await rm(temporary, { force: true })
  }
}

if (import.meta.main) {
  try {
    const result = await buildSimulatorHelper()
    console.log(result ? 'latch-simulator 已构建' : 'latch-simulator 仅支持 macOS')
  } catch {
    console.error('latch-simulator 构建失败；设备面板只有截图')
    process.exitCode = 1
  }
}
