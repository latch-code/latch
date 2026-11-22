import { relayGoEnvironment } from '../scripts/go-environment.ts'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { requestPrivateAdmin } from '../src/admin.ts'
import { createTransportCertificate } from '@latch/link-client'
const run = promisify(execFile),
  roots: string[] = [],
  children: ChildProcessWithoutNullStreams[] = []
let directory: string, binary: string
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'latch-relay-supervisor-test-'))
  binary = join(directory, 'gateway')
  await run(
    process.env.LATCH_RELAY_GO ?? 'go',
    [
      'build',
      '-trimpath',
      '-o',
      binary,
      fileURLToPath(new URL('../gateway/main.go', import.meta.url)),
      fileURLToPath(new URL('../gateway/supervisor.go', import.meta.url)),
    ],
    { env: relayGoEnvironment(), timeout: 60000 },
  )
}, 65000)
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.stdin.end()
    if (child.exitCode === null)
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve =>
          setTimeout(() => {
            child.kill('SIGKILL')
            resolve(undefined)
          }, 3000),
        ),
      ])
  }
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true })
})
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})
async function fixture(mode: 'crash' | 'wedge' | 'dependency' | 'corrupt') {
  const dataDir = await mkdtemp('/tmp/latch-relay-parent-')
  roots.push(dataDir)
  const script = join(dataDir, 'worker.mjs')
  await writeFile(
    script,
    `import fs from 'node:fs';import http from 'node:http';
const root=${JSON.stringify(dataDir)};let count=0;try{count=Number(fs.readFileSync(root+'/starts','utf8'))}catch{};fs.writeFileSync(root+'/starts',String(++count),{mode:0o600});fs.fstatSync(3);
if(count===1&&${JSON.stringify(mode)}==='crash')process.exit(1);
const socket=root+'/worker-admin.sock';try{fs.unlinkSync(socket)}catch{};const server=http.createServer((_req,res)=>res.end('{}'));server.listen(socket,()=>{fs.chmodSync(socket,0o600);emit('ready')});
const status={ready:true,connections:0,routes:0,pending:0,draining:false};const emit=type=>process.stdout.write(JSON.stringify({type,...(type==='ready'?{port:12345,adminPort:0,adminSocket:socket}:{}),status})+'\\n');const timer=setInterval(()=>emit('heartbeat'),1000);
process.stdin.on('data',()=>process.exit(0));process.stdin.on('end',()=>process.exit(0));process.stdin.resume();
if(count===1&&${JSON.stringify(mode)}==='dependency')setTimeout(()=>{status.gateway={healthy:false}},100);
if(count===1&&${JSON.stringify(mode)}==='wedge')setTimeout(()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000),100);
`,
    { mode: 0o600 },
  )
  await writeFile(join(dataDir, '.restarts-1234.tmp'), 'incomplete', { mode: 0o600 })
  if (mode === 'corrupt')
    await writeFile(
      join(dataDir, 'restarts.json'),
      `${JSON.stringify({ version: 1, restarts: 1, lastFailure: 'a'.repeat(64), lastRestartAt: 1 })} trailing`,
      { mode: 0o600 },
    )
  const events: Array<Record<string, unknown>> = []
  const child = spawn(binary, ['supervise'], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] })
  children.push(child)
  let text = ''
  child.stdout.on('data', (chunk: Buffer) => {
    text += chunk.toString()
    for (;;) {
      const end = text.indexOf('\n')
      if (end < 0) break
      events.push(JSON.parse(text.slice(0, end)))
      text = text.slice(end + 1)
    }
  })
  child.stderr.resume()
  child.stdin.on('error', () => {})
  child.stdin.write(`${JSON.stringify({ dataDir, node: process.execPath, args: ['--disable-sigusr1', script], adminPort: 0 })}\n`)
  return { dataDir, child, events }
}
it('restarts a real crashed worker, protects one writer with an inherited kernel lease and persists only aggregate recovery state', async () => {
  const f = await fixture('crash')
  await vi.waitFor(() => expect(f.events.some(event => event.started)).toBe(true), { timeout: 5000, interval: 50 })
  expect(f.events.find(event => event.alert)?.retryAfterMs).toBe(1000)
  const ready = f.events.find(event => event.started)!,
    admin = `http://127.0.0.1:${ready.adminPort}`
  expect((await fetch(`${admin}/healthz`)).status).toBe(200)
  const status = await (await fetch(`${admin}/status`)).json()
  expect(status.supervisor.restarts).toBe(1)
  await expect(stat(join(f.dataDir, '.restarts-1234.tmp'))).rejects.toMatchObject({ code: 'ENOENT' })
  const duplicate = spawn(binary, ['supervise'], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] })
  children.push(duplicate)
  duplicate.stderr.resume()
  duplicate.stdout.resume()
  duplicate.stdin.on('error', () => {})
  duplicate.stdin.write(
    `${JSON.stringify({ dataDir: f.dataDir, node: process.execPath, args: ['--disable-sigusr1', '-e', 'process.exit(99)'], adminPort: 0 })}\n`,
  )
  const exit = await new Promise(resolve => duplicate.once('exit', resolve))
  expect(exit).toBe(1)
  expect((await fetch(`${admin}/healthz`)).status).toBe(200)
  const ledger = JSON.parse(await readFile(join(f.dataDir, 'restarts.json'), 'utf8'))
  expect(ledger).toMatchObject({ version: 1, restarts: 1 })
  expect(ledger.lastFailure).toMatch(/^[a-f0-9]{64}$/u)
  expect((await stat(join(f.dataDir, 'restarts.json'))).mode & 0o777).toBe(0o600)
  expect((await fetch(`${admin}/status`, { headers: { Origin: 'https://example.test' } })).status).toBe(403)
  expect((await fetch(`${admin}/drain`, { method: 'POST', headers: { 'x-latch-relay-admin': '1' } })).status).toBe(404)
  expect(JSON.parse(await requestPrivateAdmin(f.dataDir, '/drain'))).toEqual({ draining: true })
  await vi.waitFor(async () => expect((await (await fetch(`${admin}/status`)).json()).supervisor.state).toBe('drained'), { timeout: 3000 })
  expect(f.child.exitCode).toBeNull()
})
it('preserves corrupt restart state instead of accepting trailing data or resetting the ledger', async () => {
  const f = await fixture('corrupt')
  await vi.waitFor(() => expect(f.child.exitCode).toBe(1), { timeout: 3000 })
  expect(await readFile(join(f.dataDir, 'restarts.json'), 'utf8')).toBe(
    `${JSON.stringify({ version: 1, restarts: 1, lastFailure: 'a'.repeat(64), lastRestartAt: 1 })} trailing`,
  )
  expect(f.events).toEqual([])
})
it('keeps a maintenance drain held during crash backoff instead of letting a container restart reopen it', async () => {
  const f = await fixture('crash')
  await vi.waitFor(() => expect(f.events.some(event => event.alert)).toBe(true), { timeout: 3000, interval: 10 })
  expect(JSON.parse(await requestPrivateAdmin(f.dataDir, '/drain'))).toEqual({ draining: true })
  await new Promise(resolve => setTimeout(resolve, 1200))
  expect(f.child.exitCode).toBeNull()
  expect(f.events.some(event => event.started)).toBe(false)
  expect(JSON.parse(await requestPrivateAdmin(f.dataDir, '/status')).supervisor.state).toBe('drained')
})
it('replaces a heartbeating worker when its TLS dependency has died', async () => {
  const f = await fixture('dependency')
  await vi.waitFor(() => expect(f.events.filter(event => event.started).length).toBe(2), { timeout: 5000, interval: 50 })
  expect(f.events.find(event => event.alert)?.retryAfterMs).toBe(1000)
  const admin = `http://127.0.0.1:${f.events.find(event => event.started)!.adminPort}`
  expect((await fetch(`${admin}/healthz`)).status).toBe(200)
  expect(Number(await readFile(join(f.dataDir, 'starts'), 'utf8'))).toBe(2)
})
it('keeps independent health responsive while a real worker event loop is wedged, then replaces it after ten seconds', async () => {
  const f = await fixture('wedge')
  await vi.waitFor(() => expect(f.events.some(event => event.started)).toBe(true), { timeout: 3000 })
  const admin = `http://127.0.0.1:${f.events.find(event => event.started)!.adminPort}`
  await new Promise(resolve => setTimeout(resolve, 10500))
  const before = performance.now()
  const health = await fetch(`${admin}/healthz`, { signal: AbortSignal.timeout(1000) })
  expect(performance.now() - before).toBeLessThan(1000)
  expect(health.status).toBe(503)
  await vi.waitFor(() => expect(f.events.filter(event => event.started).length).toBe(2), { timeout: 4000, interval: 50 })
  expect((await fetch(`${admin}/healthz`)).status).toBe(200)
  expect(Number(await readFile(join(f.dataDir, 'starts'), 'utf8'))).toBe(2)
}, 20000)
it('runs the actual CLI worker with private TLS, independent admin, graceful empty drain and no default directory', async () => {
  const dataDir = await mkdtemp('/tmp/latch-relay-supervisor-cli-')
  roots.push(dataDir)
  const certificate = createTransportCertificate(Date.now(), 3600000, 'localhost')
  await writeFile(join(dataDir, 'certificate.pem'), certificate.cert, { mode: 0o600 })
  await writeFile(join(dataDir, 'key.pem'), certificate.key, { mode: 0o600 })
  await writeFile(
    join(dataDir, 'relay.json'),
    JSON.stringify({
      version: 1,
      host: '127.0.0.1',
      port: 0,
      adminPort: 0,
      relayId: 'a'.repeat(32),
      certificateFile: join(dataDir, 'certificate.pem'),
      keyFile: join(dataDir, 'key.pem'),
      openRegistration: true,
      gateway: { binary, maxHandshakes: 8, handshakesPerSecond: 100, handshakeBurst: 8, prefixFraction: 1 },
    }),
    { mode: 0o600 },
  )
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
    events: Array<Record<string, unknown>> = []
  const child = spawn(process.execPath, ['--disable-sigusr1', '--import', 'tsx', cli, 'start', '--data-dir', dataDir], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  let text = '',
    errors = ''
  child.stdout.on('data', (chunk: Buffer) => {
    text += chunk.toString()
    for (;;) {
      const end = text.indexOf('\n')
      if (end < 0) break
      events.push(JSON.parse(text.slice(0, end)))
      text = text.slice(end + 1)
    }
  })
  child.stderr.on('data', (chunk: Buffer) => {
    errors += chunk.toString()
  })
  await vi.waitFor(
    () =>
      expect(
        events.some(event => event.started),
        errors,
      ).toBe(true),
    { timeout: 5000, interval: 50 },
  )
  const admin = `http://127.0.0.1:${events.find(event => event.started)!.adminPort}`
  expect((await fetch(`${admin}/healthz`)).status).toBe(200)
  // Linux reads the relay's own cgroup, which counts socket memory; elsewhere only the process's resident size.
  expect((await (await fetch(`${admin}/status`)).json()).memory.includesSockets).toBe(process.platform === 'linux')
  await writeFile(join(dataDir, 'key.pem'), 'incomplete-renewal')
  expect((await run(process.execPath, ['--disable-sigusr1', '--import', 'tsx', cli, 'health', '--data-dir', dataDir])).stdout.trim()).toBe(
    '{}',
  )
  await expect(
    run(process.execPath, ['--disable-sigusr1', '--import', 'tsx', cli, 'reload-tls', '--data-dir', dataDir]),
  ).rejects.toMatchObject({ code: 1 })
  expect((await fetch(`${admin}/healthz`)).status).toBe(200)
  await writeFile(join(dataDir, 'key.pem'), certificate.key)

  child.kill('SIGTERM')
  await vi.waitFor(() => expect(child.exitCode, errors).toBe(0), { timeout: 5000, interval: 50 })
  expect(errors).toBe('')
})
