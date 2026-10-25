import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:tls'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostStateEvent } from '@latch/protocol'
import { makeTestTls, type TestDevice } from '@latch/testkit'
import { BACKUP_EXCLUSION_ATTRIBUTE, BACKUP_EXCLUSION_VALUE, excludeFromBackup, type XattrRunner } from '../src/backup.ts'
import { HostConfig } from '../src/config.ts'
import { queryHostInfo } from '../src/host-state.ts'
import { HostLifecycle, RETRY_AFTER, STOP_REASON_TTL_MS } from '../src/lifecycle.ts'
import { startTestHost, type TestHost, type TestHostOptions } from './helpers/host.ts'

const run = promisify(execFile)
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function testHost(options: TestHostOptions = {}): Promise<TestHost> {
  const host = await startTestHost(options)
  cleanups.push(() => host.close())
  return host
}

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'latch-lifecycle-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

/** Reads an event stream until the test is done with it; `events` are the parsed host-state frames so far. */
async function hostStateStream(device: TestDevice) {
  const controller = new AbortController()
  const response = await device.request('events', { signal: controller.signal })
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const state = { text: '', done: false, events: [] as HostStateEvent[] }
  const reading = (async () => {
    for (;;) {
      const next = await reader.read()
      if (next.done) {
        state.done = true
        return
      }
      state.text += decoder.decode(next.value, { stream: true })
      state.events = [...state.text.matchAll(/event: host-state\ndata: (.*)\n\n/gu)].map(match => JSON.parse(match[1]!) as HostStateEvent)
    }
  })().catch(() => {})
  cleanups.push(async () => {
    controller.abort()
    await reading
  })
  return state
}

const hostState = (t: TestHost, body: unknown, listener: 'unix' | 'loopback-tcp' = 'unix') =>
  t.raw(listener, 'api/host/state', { method: 'POST', body })

describe('host state announcements', () => {
  it('records a stop reason for a while and announces sleep and wake at once', () => {
    let clock = Date.parse('2026-10-25T12:00:00.000Z')
    const lifecycle = new HostLifecycle('instance', () => clock)
    expect(lifecycle.stopping()).toEqual({
      type: 'host-state',
      instanceId: 'instance',
      state: 'stopping',
      reason: 'shutdown',
      retryAfter: RETRY_AFTER.shutdown,
      at: '2026-10-25T12:00:00.000Z',
    })
    expect(lifecycle.report({ state: 'stopping', reason: 'update' })).toBeUndefined()
    expect(lifecycle.stopping()).toMatchObject({ reason: 'update', retryAfter: RETRY_AFTER.update })
    expect(lifecycle.report({ state: 'stopping', reason: 'restart', retryAfter: 5 })).toBeUndefined()
    expect(lifecycle.stopping()).toMatchObject({ reason: 'restart', retryAfter: 5 })
    clock += STOP_REASON_TTL_MS
    expect(lifecycle.stopping()).toMatchObject({ reason: 'shutdown', retryAfter: RETRY_AFTER.shutdown })
    expect(lifecycle.report({ state: 'sleeping' })).toEqual({
      type: 'host-state',
      instanceId: 'instance',
      state: 'sleeping',
      reason: 'sleep',
      retryAfter: RETRY_AFTER.sleep,
      at: new Date(clock).toISOString(),
    })
    expect(lifecycle.report({ state: 'awake' })).toEqual({
      type: 'host-state',
      instanceId: 'instance',
      state: 'awake',
      at: new Date(clock).toISOString(),
    })
  })

  it('takes reports only on host.sock and sends sleep, wake and the stop with its reason to every open stream', async () => {
    const t = await testHost()
    const phone = await t.enroll({ listener: 'loopback-tcp', scopes: ['view'] })
    const stream = await hostStateStream(phone)
    await expect.poll(() => stream.text).toContain('event: refresh')

    // Off host.sock the route does not exist, and a report that does not have the documented shape is refused.
    expect((await hostState(t, { state: 'sleeping' }, 'loopback-tcp')).status).toBe(404)
    expect((await phone.request('host/state', { method: 'POST', body: { state: 'sleeping' } })).status).toBe(404)
    expect((await hostState(t, { state: 'stopping', reason: 'sleep' })).status).toBe(400)
    expect((await hostState(t, { state: 'stopping', reason: 'restart', retryAfter: 0 })).status).toBe(400)
    expect((await hostState(t, { state: 'sleeping', extra: true })).status).toBe(400)
    expect((await t.raw('unix', 'api/host/state')).status).toBe(405)
    expect(stream.events).toEqual([])

    expect((await hostState(t, { state: 'sleeping' })).status).toBe(200)
    await expect.poll(() => stream.events.length).toBe(1)
    expect(stream.events[0]).toMatchObject({ state: 'sleeping', reason: 'sleep', retryAfter: 10, instanceId: t.host.instanceId })
    const refreshes = stream.text.split('event: refresh').length
    expect((await hostState(t, { state: 'awake' })).status).toBe(200)
    await expect.poll(() => stream.events.length).toBe(2)
    expect(stream.events[1]).toMatchObject({ state: 'awake', instanceId: t.host.instanceId })
    expect(stream.events[1]!.reason).toBeUndefined()
    // Clients resynchronize after a wake.
    await expect.poll(() => stream.text.split('event: refresh').length).toBeGreaterThan(refreshes)

    // A reason reported ahead is announced when the Host stops, as the last frame of the stream.
    expect((await hostState(t, { state: 'stopping', reason: 'restart' })).status).toBe(200)
    expect(stream.events).toHaveLength(2)
    await t.host.close()
    await expect.poll(() => stream.done).toBe(true)
    expect(stream.events.at(-1)).toMatchObject({ state: 'stopping', reason: 'restart', retryAfter: 2, instanceId: t.host.instanceId })
    expect(stream.text.trimEnd().endsWith(`data: ${JSON.stringify(stream.events.at(-1))}`)).toBe(true)
  })

  it('announces a plain shutdown when nobody said why the Host stops', async () => {
    const t = await testHost()
    const desktop = await t.enroll()
    const stream = await hostStateStream(desktop)
    await expect.poll(() => stream.text).toContain('event: refresh')
    await t.host.close()
    await expect.poll(() => stream.done).toBe(true)
    expect(stream.events).toEqual([expect.objectContaining({ state: 'stopping', reason: 'shutdown', retryAfter: 15 })])
  })

  it('reports running sessions and waiting approvals apart in host-info', async () => {
    const t = await testHost()
    expect(await queryHostInfo(t.host.socketPath)).toMatchObject({ activeSessions: 0, activity: { running: 0, waiting: 0 } })
    const running = await t.host.bridge.createTask({ prompt: '运行 30 秒长任务', requestId: randomUUID() })
    cleanups.push(async () => {
      await t.host.bridge.cancel(running.sessionId)
    })
    await expect.poll(async () => (await t.host.bridge.detail(running.sessionId)).summary.status).toBe('running')
    const waiting = await t.host.bridge.createTask({ prompt: '生成需要审批的报告', requestId: randomUUID() })
    cleanups.push(async () => {
      await t.host.bridge.cancel(waiting.sessionId)
    })
    await expect.poll(async () => (await t.host.bridge.detail(waiting.sessionId)).summary.status).toBe('waiting-approval')
    expect(await queryHostInfo(t.host.socketPath)).toMatchObject({ activeSessions: 2, activity: { running: 1, waiting: 1 } })
  })
})

describe('keeping key material out of Time Machine', () => {
  it('marks each existing file or directory once, skips links and missing paths, and never throws', async () => {
    const directory = await temporaryDirectory()
    const file = join(directory, 'providers.json')
    await writeFile(file, '{}')
    await mkdir(join(directory, 'auth'))
    await symlink(file, join(directory, 'link.json'))
    const marked = new Set<string>()
    const calls: string[][] = []
    const runner: XattrRunner = async args => {
      calls.push([...args])
      const path = args.at(-1)!
      if (args[0] === '-p') {
        if (!marked.has(path)) throw new Error('No such xattr')
        return {
          stdout:
            '62 70 6C 69 73 74 30 30 5F 10 11 63 6F 6D 2E 61\n70 70 6C 65 2E 62 61 63 6B 75 70 64 08 00 00 00\n00 00 00 01 01 00 00 00 00 00 00 00 01 00 00 00\n00 00 00 00 00 00 00 00 00 00 00 00 1C\n',
        }
      }
      marked.add(path)
      return { stdout: '' }
    }
    const paths = [join(directory, 'auth'), file, join(directory, 'link.json'), join(directory, 'missing')]
    expect(await excludeFromBackup(paths, { run: runner, platform: 'darwin' })).toEqual([join(directory, 'auth'), file])
    // `-s`: a path swapped for a symbolic link after the check gets the attribute itself, not what the link names.
    expect(calls).toContainEqual(['-w', '-s', '-x', BACKUP_EXCLUSION_ATTRIBUTE, BACKUP_EXCLUSION_VALUE, file])
    expect(calls.every(call => call[1] === '-s')).toBe(true)
    expect(calls.some(call => call.includes(join(directory, 'link.json')) || call.includes(join(directory, 'missing')))).toBe(false)
    // Idempotent: what already carries the exclusion is only read.
    calls.length = 0
    expect(await excludeFromBackup(paths, { run: runner, platform: 'darwin' })).toEqual([])
    expect(calls.every(call => call[0] === '-p')).toBe(true)
    // Elsewhere there is no Time Machine; a failing write is logged.
    expect(await excludeFromBackup(paths, { run: runner, platform: 'linux' })).toEqual([])
    const lines: string[] = []
    const failing: XattrRunner = async args => {
      throw new Error(args[0] === '-p' ? 'No such xattr' : 'Operation not permitted')
    }
    expect(await excludeFromBackup([file], { run: failing, platform: 'darwin', log: text => lines.push(text) })).toEqual([])
    expect(lines).toEqual([`无法把 ${file} 排除在时间机器备份之外：Operation not permitted`])
  })

  it.runIf(process.platform === 'darwin')(
    'excludes auth/, identity/, providers.json and settings.json of a running Host, and every one written later',
    async () => {
      const t = await testHost()
      const attribute = async (path: string) =>
        await run('/usr/bin/xattr', ['-p', '-x', BACKUP_EXCLUSION_ATTRIBUTE, path])
          .then(({ stdout }) => stdout.replace(/\s+/gu, '').toLowerCase())
          .catch(() => '')
      expect(await attribute(join(t.dataDir, 'auth'))).toBe(BACKUP_EXCLUSION_VALUE)
      expect(await attribute(join(t.dataDir, 'identity'))).toBe(BACKUP_EXCLUSION_VALUE)
      // Sessions and the audit log are backed up as usual.
      expect(await attribute(join(t.dataDir, 'audit'))).toBe('')

      const config = await HostConfig.open(t.dataDir)
      for (const key of ['sk-first', 'sk-second']) {
        await config.updateProviders(draft => {
          draft.splice(0, draft.length, {
            id: 'lab',
            name: 'Lab',
            kind: 'openai-compatible',
            baseURL: 'https://models.example.test/v1',
            apiKey: key,
            keyOrigin: 'https://models.example.test:443',
            keyPath: '/v1',
            enabled: true,
            models: ['m'],
            defaultModel: 'm',
          })
        })
        // Each save replaces the file; the new one carries the exclusion from the start.
        expect(await attribute(join(t.dataDir, 'providers.json'))).toBe(BACKUP_EXCLUSION_VALUE)
      }
      // Agent definitions carry environment values (often API keys), so settings.json stays out as well.
      for (const value of ['first', 'second']) {
        await config.updateSettings(draft => {
          draft.agents.splice(0, draft.agents.length, {
            id: 'lab-agent',
            name: 'Lab Agent',
            command: '/usr/bin/true',
            args: [],
            env: { LAB_API_KEY: value },
            enabled: false,
          })
        })
        expect(await attribute(join(t.dataDir, 'settings.json'))).toBe(BACKUP_EXCLUSION_VALUE)
      }
    },
  )
})

/** A certificate for another host name with its 0600 key. */
async function otherHostTls(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const certPath = join(directory, 'cert.pem')
  const keyPath = join(directory, 'key.pem')
  await run(
    '/usr/bin/openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '30',
      '-subj',
      '/CN=other.localhost',
      '-addext',
      'subjectAltName=DNS:other.localhost',
    ],
    { env: { PATH: '/usr/bin:/bin' } },
  )
  await chmod(keyPath, 0o600)
  return { certPath, keyPath }
}

/** The SHA-256 fingerprint of the certificate a new TLS connection to the HTTPS entry gets. */
function servedFingerprint(t: TestHost): Promise<string> {
  const port = Number(new URL(t.host.tlsOrigin!).port)
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port, servername: 'latch-test.localhost', rejectUnauthorized: false }, () => {
      const fingerprint = socket.getPeerX509Certificate()?.fingerprint256 ?? ''
      socket.destroy()
      resolve(fingerprint)
    })
    socket.once('error', reject)
  })
}

async function fingerprintOf(path: string) {
  const { X509Certificate } = await import('node:crypto')
  return new X509Certificate(await readFile(path)).fingerprint256
}

/** Replaces a file the way renewal tools do: a new file renamed over the old one. */
async function replace(target: string, source: string, mode = 0o600) {
  const temporary = `${target}.${randomUUID()}.new`
  await copyFile(source, temporary)
  await chmod(temporary, mode)
  await rename(temporary, target)
}

describe('HTTPS certificate reload', () => {
  it('switches to a renewed pair without a restart, and keeps the current one when a new pair does not check out', async () => {
    const lines: string[] = []
    const t = await testHost({ tls: true, log: text => lines.push(text) })
    const tlsDir = join(t.root, 'tls')
    const original = await fingerprintOf(join(tlsDir, 'cert.pem'))
    expect(await servedFingerprint(t)).toBe(original)

    const renewed = await makeTestTls(join(t.root, 'renewed'))
    await replace(join(tlsDir, 'key.pem'), renewed.keyPath)
    await replace(join(tlsDir, 'cert.pem'), renewed.certPath, 0o644)
    const next = await fingerprintOf(renewed.certPath)
    await vi.waitFor(async () => expect(await servedFingerprint(t)).toBe(next), { timeout: 15_000, interval: 250 })
    expect(lines.filter(line => line.startsWith('已重新加载 HTTPS 证书，有效期至 '))).toHaveLength(1)

    // A key that is not this certificate's: refused, logged once with the reason, and the renewed pair stays in use.
    const stranger = await makeTestTls(join(t.root, 'stranger'))
    await replace(join(tlsDir, 'key.pem'), stranger.keyPath)
    await vi.waitFor(() => expect(lines.some(line => line.startsWith('HTTPS 证书没有重新加载：'))).toBe(true), {
      timeout: 15_000,
      interval: 250,
    })
    expect(lines.at(-1)).toBe('HTTPS 证书没有重新加载：证书与私钥不匹配，或无法用于 HTTPS。继续使用原来的证书。')
    expect(await servedFingerprint(t)).toBe(next)

    // A certificate for another host name, with its own key.
    const other = await otherHostTls(join(t.root, 'other'))
    await replace(join(tlsDir, 'key.pem'), other.keyPath)
    await replace(join(tlsDir, 'cert.pem'), other.certPath, 0o644)
    await vi.waitFor(() => expect(lines.at(-1)).toContain('不匹配。继续使用原来的证书。'), { timeout: 15_000, interval: 250 })
    expect(lines.at(-1)).toBe(
      `HTTPS 证书没有重新加载：HTTPS 证书与公开地址 ${new URL(t.host.tlsOrigin!).host} 不匹配。继续使用原来的证书。`,
    )
    expect(await servedFingerprint(t)).toBe(next)

    // A key others can read, even with its own certificate: the startup rules apply to a reload too.
    const exposed = await makeTestTls(join(t.root, 'exposed'))
    await replace(join(tlsDir, 'cert.pem'), exposed.certPath, 0o644)
    await replace(join(tlsDir, 'key.pem'), exposed.keyPath, 0o644)
    await vi.waitFor(
      () =>
        expect(lines.at(-1)).toBe(
          'HTTPS 证书没有重新加载：HTTPS 私钥 必须是仅本用户可读的文件（0600），且不能位于工作区内。继续使用原来的证书。',
        ),
      { timeout: 15_000, interval: 250 },
    )
    expect(await servedFingerprint(t)).toBe(next)
    expect((await lstat(join(tlsDir, 'key.pem'))).mode & 0o777).toBe(0o644)
    const rejections = lines.filter(line => line.startsWith('HTTPS 证书没有重新加载：'))
    expect(new Set(rejections).size).toBe(rejections.length)
  }, 60_000)
})
