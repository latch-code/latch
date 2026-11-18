import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { latchCodeRoot } from '../src/paths.ts'
import { desktopLaunchOptions, desktopShellEnvironment, ensureDesktopHost } from './desktop-host.ts'

const require = createRequire(import.meta.url)
const electron = require('electron') as string
const options = desktopLaunchOptions(process.argv.slice(2))
for (const warning of options.warnings) console.warn(warning)
const host = await ensureDesktopHost(options).catch((error: unknown) => {
  // A refusal (a Host still running, the data directory not movable) is said in one line, not as a stack trace.
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
if (host.notice) console.warn(host.notice)
// The shell is told where host.json is; it verifies the Host over host.sock itself. Its code is in apps/desktop/src/.
const app = spawn(electron, [join(latchCodeRoot(), 'apps', 'desktop', 'src', 'main.cjs'), `--latch-host-state=${host.hostStatePath}`], {
  cwd: process.cwd(),
  stdio: 'inherit',
  env: desktopShellEnvironment(process.env),
})
app.on('exit', code => {
  process.exitCode = code ?? 0
})
