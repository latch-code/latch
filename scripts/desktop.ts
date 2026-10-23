import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { desktopLaunchOptions, desktopShellEnvironment, ensureDesktopHost } from './desktop-host.ts'

const require = createRequire(import.meta.url)
const electron = require('electron') as string
const options = desktopLaunchOptions(process.argv.slice(2))
for (const warning of options.warnings) console.warn(warning)
const host = await ensureDesktopHost(options)
if (host.notice) console.warn(host.notice)
// The shell is told where host.json is; it verifies the Host over host.sock itself.
const app = spawn(electron, [fileURLToPath(new URL('../desktop/main.cjs', import.meta.url)), `--latch-host-state=${host.hostStatePath}`], {
  cwd: process.cwd(),
  stdio: 'inherit',
  env: desktopShellEnvironment(process.env),
})
app.on('exit', code => {
  process.exitCode = code ?? 0
})
