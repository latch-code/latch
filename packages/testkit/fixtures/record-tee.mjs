// Stands between the ACP driver and a real agent while a scenario is recorded: it starts the agent in a sandbox that
// allows connections only to the fake model's port, with a clean environment and a home of its own, and writes every line
// both ways to RECORD_LOG. It refuses to start the agent unless the sandbox demonstrably blocks a connection off this
// computer and one to another port on it, where a local proxy could listen.
// RECORD_COMMAND: JSON [program, ...args]. RECORD_HOME: the agent's home. RECORD_KEEP: JSON list of variable names the
// driver set that the agent keeps. RECORD_ENV: JSON object of variables for the agent. RECORD_SANDBOX: sandbox-exec.
// RECORD_PROFILE: the sandbox profile. RECORD_STDERR: where the agent's error output goes, never into the log.
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { appendFileSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'

const env = process.env
const log = env.RECORD_LOG
const write = record => appendFileSync(log, `${JSON.stringify({ at: Date.now(), ...record })}\n`)
const refuse = reason => {
  write({ refused: reason })
  process.stderr.write(`recording refused: ${reason}\n`)
  process.exit(2)
}
if (!log || !env.RECORD_COMMAND || !env.RECORD_HOME || !env.RECORD_SANDBOX || !env.RECORD_PROFILE) refuse('missing RECORD_* settings')

const [program, ...args] = JSON.parse(env.RECORD_COMMAND)
const home = env.RECORD_HOME
const keep = new Set(['PATH', 'LANG', 'TERM', 'TMPDIR', 'NODE_TLS_REJECT_UNAUTHORIZED', ...JSON.parse(env.RECORD_KEEP ?? '[]')])
const child = {}
for (const [name, value] of Object.entries(env))
  if (value !== undefined && (keep.has(name) || name.startsWith('LC_') || name.startsWith('GIT_CONFIG_'))) child[name] = value
const xdg = { XDG_CONFIG_HOME: '.config', XDG_DATA_HOME: '.local/share', XDG_STATE_HOME: '.local/state', XDG_CACHE_HOME: '.cache' }
for (const [name, path] of Object.entries(xdg)) {
  child[name] = join(home, path)
  mkdirSync(child[name], { recursive: true })
}
Object.assign(child, { HOME: home, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', BROWSER: '/usr/bin/false' })
Object.assign(child, JSON.parse(env.RECORD_ENV ?? '{}'))

const sandbox = [env.RECORD_SANDBOX, '-p', env.RECORD_PROFILE]
// A sandbox that lets either through could let the agent reach a paid model with a login it finds on this computer.
const blocked = (host, port) => {
  const check = spawnSync(
    sandbox[0],
    [
      ...sandbox.slice(1),
      process.execPath,
      '-e',
      `const s=require('node:net').connect(${port},'${host}');s.setTimeout(3000,()=>{console.log('TIMEOUT');process.exit()});s.on('connect',()=>{console.log('CONNECTED');process.exit()});s.on('error',e=>{console.log(e.code);process.exit()})`,
    ],
    { env: { PATH: child.PATH ?? '/usr/bin:/bin' }, encoding: 'utf8', timeout: 10_000 },
  )
  return check.stdout?.trim() === 'EPERM' ? undefined : (check.stdout || check.stderr || 'no answer').trim().slice(0, 200)
}
const away = blocked('192.0.2.1', 9)
if (away) refuse(`the sandbox did not block a connection off this computer (${away})`)
// A port that listens, so only the sandbox can refuse the connection.
const local = createServer(socket => socket.end())
await new Promise(resolve => local.listen(0, '127.0.0.1', resolve))
const other = blocked('127.0.0.1', local.address().port)
local.close()
if (other) refuse(`the sandbox did not block a connection to another port on this computer (${other})`)

write({ start: { program, args } })
const agent = spawn(sandbox[0], [...sandbox.slice(1), program, ...args], {
  env: child,
  stdio: ['pipe', 'pipe', env.RECORD_STDERR ? openSync(env.RECORD_STDERR, 'a') : 'ignore'],
})
const lines = (stream, dir, onLine) => {
  let buffered = ''
  stream.setEncoding('utf8')
  stream.on('data', chunk => {
    buffered += chunk
    for (let index = buffered.indexOf('\n'); index !== -1; index = buffered.indexOf('\n')) {
      const line = buffered.slice(0, index)
      buffered = buffered.slice(index + 1)
      if (line.trim()) write({ dir, line })
      onLine(`${line}\n`)
    }
  })
}
lines(process.stdin, 'out', line => agent.stdin.write(line))
lines(agent.stdout, 'in', line => process.stdout.write(line))
process.stdin.on('end', () => agent.stdin.end())
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => agent.kill(signal))
agent.on('exit', (code, signal) => {
  write({ exit: { code, signal } })
  process.exit(code ?? 1)
})
