import { join } from 'node:path'
import { latchCodeRoot } from '../src/paths.ts'
import { desktopLaunchOptions, ensureDesktopHost } from './desktop-host.ts'
import { readCodeBuild } from '../src/ui-build.ts'
import { redactKnownSecrets } from '@latch/core/node-kit'

// A fixed package entry, called by Electron through the native system-Node launcher.
try {
  const options = desktopLaunchOptions(process.argv.slice(2))
  const root = latchCodeRoot()
  const script = join(root, 'dist/start.js')
  const host = await ensureDesktopHost(options, { script })
  const build = await readCodeBuild(script, join(root, 'dist/web'))
  if (!build || host.info.build !== build) throw new Error('已有其他构建的 Host 正在运行。请先用 latch stop 停止它，再打开 Latch 应用。')
  process.stdout.write(`${JSON.stringify({ hostStatePath: host.hostStatePath })}\n`)
} catch (error) {
  console.error(redactKnownSecrets(error instanceof Error ? error.message : '无法启动 Latch。'))
  process.exitCode = 1
}
