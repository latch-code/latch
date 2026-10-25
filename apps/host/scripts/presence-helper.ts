import { execFile } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { latchCodeRoot } from '../src/paths.ts'

const run = promisify(execFile)
const SKIPPED = '未构建 latch-presence：本机确认将不可用'

export type PresenceBuildResult =
  | { built: true; path: string; cdhash: string }
  | { built: false; reason: 'platform' | 'no-swiftc' | 'failed'; message: string }

async function mtime(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return undefined
  }
}

async function cdhashOf(path: string): Promise<string> {
  const { stderr } = await run('/usr/bin/codesign', ['-dvvv', path], { env: {} })
  const cdhash = /^CDHash=([0-9a-f]{40})$/mu.exec(stderr)?.[1]
  if (!cdhash) throw new Error('codesign did not report a CDHash')
  return cdhash
}

/** Builds and ad-hoc signs the macOS confirmation helper (hardened runtime). Skips without failing elsewhere. */
export async function buildPresenceHelper(
  options: { codeRoot?: string; force?: boolean; log?: (text: string) => void } = {},
): Promise<PresenceBuildResult> {
  const log = options.log ?? (text => console.error(text))
  if (process.platform !== 'darwin') {
    log(`${SKIPPED}（仅支持 macOS）`)
    return { built: false, reason: 'platform', message: SKIPPED }
  }
  const root = options.codeRoot ?? latchCodeRoot()
  const source = join(root, 'native', 'macos', 'LatchPresence.swift')
  // Embedded as the binary's Info.plist, so the system sheet can name the helper Latch rather than latch-presence.
  const info = join(root, 'native', 'macos', 'LatchPresence-Info.plist')
  const output = join(root, 'dist', 'native', 'latch-presence')
  try {
    await run('/usr/bin/xcrun', ['--find', 'swiftc'])
  } catch {
    log(`${SKIPPED}（未找到 swiftc，请安装 Xcode 命令行工具）`)
    return { built: false, reason: 'no-swiftc', message: SKIPPED }
  }
  try {
    const [built, sourceTime, infoTime] = await Promise.all([mtime(output), mtime(source), mtime(info)])
    if (
      !options.force
      && built !== undefined
      && sourceTime !== undefined
      && infoTime !== undefined
      && built > Math.max(sourceTime, infoTime)
    ) {
      await run('/usr/bin/codesign', ['--verify', '--strict', output])
      const cdhash = await cdhashOf(output)
      log(`latch-presence cdhash ${cdhash}`)
      return { built: true, path: output, cdhash }
    }
    await mkdir(join(root, 'dist', 'native'), { recursive: true })
    const linker = ['-sectcreate', '__TEXT', '__info_plist', info].flatMap(argument => ['-Xlinker', argument])
    await run(
      '/usr/bin/xcrun',
      ['swiftc', '-O', '-parse-as-library', '-framework', 'LocalAuthentication', ...linker, '-o', output, source],
      {
        maxBuffer: 16 * 1024 * 1024,
      },
    )
    await run('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--identifier', 'dev.latch.presence', output])
    await run('/usr/bin/codesign', ['--verify', '--strict', output])
    const cdhash = await cdhashOf(output)
    log(`latch-presence cdhash ${cdhash}`)
    return { built: true, path: output, cdhash }
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error)
    log(`${SKIPPED}（构建失败：${detail}）`)
    return { built: false, reason: 'failed', message: SKIPPED }
  }
}
