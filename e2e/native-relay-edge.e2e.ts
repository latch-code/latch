import { createServer, type Server } from 'node:https'
import { createHash, createPrivateKey, generateKeyPairSync, sign, webcrypto } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { Duplex } from 'node:stream'
import { once } from 'node:events'
import { connect, type AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication } from '@playwright/test'
import { afterEach, expect, it, vi } from 'vitest'
import { encodeFrame, invitationCode, parsePairingPayload, WebSocketParser } from '@latch/link-wire'
import { createTransportCertificate, nodeCrypto, openNativeHttp, verifyAddressBook } from '@latch/link-client'
import { acceptKey } from '@latch/link-client/websocket'
import { openRelay } from '@latch/link-client'
import { createEdgeWorker } from '@latch/relay-edge/edge'
import { EdgeNode } from '@latch/relay-edge/node'
import type { EdgeEnv, EdgePlatform, EdgeRequest, EdgeResponse, EdgeSubtle, EdgeWebSocket } from '@latch/relay-edge/platform'
import type { NativeLinkInfo } from '@latch/protocol'
import { startRelay } from '@latch/relay'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { openEntry } from './helpers/layout.ts'

/**
 * The edge protocol fixture uses real TLS and WebSocket framing over a local Workers adapter. The desktop exercises
 * the production import flow with a Linux relay and rejects a Workers relay file.
 */
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run()
})

class Response implements EdgeResponse {
  constructor(
    readonly status: number,
    readonly body?: string,
    readonly socket?: ServerSide,
  ) {}
  text() {
    return Promise.resolve(this.body ?? '')
  }
}
/** The node's half of a WebSocket; `deliver` and `shut` are bound to the TLS socket once upgraded. */
class ServerSide implements EdgeWebSocket {
  deliver: (payload: Uint8Array, written: () => void) => void = (_payload, written) => written()
  shut: (code: number) => void = () => {}
  private closed = false
  bufferedAmount = 0
  binaryType: EdgeWebSocket['binaryType'] = 'blob'
  private readonly listeners = new Map<string, Array<(event: { data: unknown }) => void>>()
  accept() {}
  send(data: ArrayBuffer | Uint8Array) {
    if (this.closed) throw new Error('closed')
    const payload = new Uint8Array(data instanceof Uint8Array ? data : data)
    this.bufferedAmount += payload.length
    this.deliver(payload, () => (this.bufferedAmount -= payload.length))
  }
  close(code?: number) {
    if (this.closed) return
    this.closed = true
    this.shut(code ?? 1000)
  }
  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  emit(type: string, event: { data: unknown } = { data: undefined }) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

async function edgeRelay(seed: Uint8Array, relayId: string, token: Uint8Array) {
  const certificate = createTransportCertificate(Date.now(), 3_600_000, 'localhost')
  const platform: EdgePlatform = {
    subtle: webcrypto.subtle as unknown as EdgeSubtle,
    random: size => webcrypto.getRandomValues(new Uint8Array(size)),
    now: () => Date.now(),
    respond: (status, body) => new Response(status, body),
    pair: () => {
      const server = new ServerSide()
      return [server, server]
    },
    upgrade: client => new Response(101, undefined, client as ServerSide),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: handle => clearInterval(handle as NodeJS.Timeout),
  }
  const nodes = new Map<string, EdgeNode>()
  const request = (url: string, method: string, headers: Record<string, string>): EdgeRequest => {
    const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
    return { method, url, headers: { get: name => lower.get(name.toLowerCase()) ?? null }, arrayBuffer: async () => new ArrayBuffer(0) }
  }
  const env: EdgeEnv = {
    NODE_HOSTS: 'localhost',
    LOCATION_HINT: 'apac-ne',
    RELAY_ID: relayId,
    RELAY_SIGNING_SEED: Buffer.from(seed).toString('hex'),
    REGISTRATION_TOKEN: Buffer.from(token).toString('hex'),
    NODE: {
      idFromName: name => name,
      get: id => ({
        fetch: async (url, init) => {
          let node = nodes.get(id as string)
          if (!node) {
            const database = new DatabaseSync(':memory:')
            node = new EdgeNode(
              {
                storage: {
                  sql: {
                    exec: (query, ...bindings) => {
                      const statement = database.prepare(query)
                      const rows = /^\s*select/iu.test(query)
                        ? (statement.all(...bindings) as Array<Record<string, unknown>>)
                        : (statement.run(...bindings), [])
                      return { toArray: () => rows }
                    },
                  },
                  setAlarm: async () => {},
                },
                blockConcurrencyWhile: callback => callback(),
              },
              env,
              platform,
            )
            await Promise.resolve()
            nodes.set(id as string, node)
          }
          return node.fetch(request(url, init.method, init.headers))
        },
      }),
    },
  }
  const worker = createEdgeWorker(platform)
  const connections = new Set<Duplex>()
  // Two origins of the same node: two listeners in front of one Worker and its node objects.
  const servers: Server[] = [0, 1].map(() =>
    createServer({ cert: certificate.cert, key: certificate.key, minVersion: 'TLSv1.3', ALPNProtocols: ['http/1.1'] }),
  )
  const upgrade = (incoming: import('node:http').IncomingMessage, raw: Duplex, head: Buffer) => {
    connections.add(raw)
    raw.once('close', () => connections.delete(raw))
    const headers: Record<string, string> = { 'cf-connecting-ip': '127.0.0.1' }
    for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers[name] = value
    void worker.fetch(request(`https://localhost${incoming.url}`, incoming.method ?? 'GET', headers), env).then(response => {
      const socket = (response as Response).socket
      if (response.status !== 101 || !socket) {
        raw.end(`HTTP/1.1 ${response.status} Refused\r\nContent-Length: 0\r\n\r\n`)
        return
      }
      raw.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(String(incoming.headers['sec-websocket-key']))}\r\nSec-WebSocket-Protocol: latch-relay.2\r\n\r\n`,
      )
      const parser = new WebSocketParser(true)
      socket.deliver = (payload, written) => {
        if (!raw.destroyed) raw.write(encodeFrame({ opcode: 2, payload }), written)
      }
      socket.shut = code => {
        if (!raw.destroyed) raw.end(encodeFrame({ opcode: 8, payload: Uint8Array.of(code >> 8, code & 255) }))
      }
      const feed = (chunk: Buffer) => {
        try {
          for (const frame of parser.feed(chunk)) {
            if (frame.opcode === 2) {
              const data = frame.payload.buffer.slice(frame.payload.byteOffset, frame.payload.byteOffset + frame.payload.byteLength)
              socket.emit('message', { data })
            } else if (frame.opcode === 9) raw.write(encodeFrame({ opcode: 10, payload: frame.payload }))
            else if (frame.opcode === 8) raw.destroy()
          }
        } catch {
          raw.destroy()
        }
      }
      if (head.length) feed(head)
      raw.on('data', feed)
      raw.on('close', () => socket.emit('close'))
      raw.on('error', () => {})
    })
  }
  for (const server of servers) {
    server.on('upgrade', upgrade)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
  }
  cleanup.push(async () => {
    for (const node of nodes.values()) node.dispose()
    for (const connection of connections) connection.destroy()
    for (const server of servers) {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
  })
  const ports = servers.map(server => (server.address() as AddressInfo).port)
  /** Routes registered on the node objects: live, test and departed alike. */
  const routes = () => [...nodes.values()].reduce((sum, node) => sum + Number(node.status().routes ?? 0), 0)
  const controls = () => [...nodes.values()].reduce((sum, node) => sum + Number(node.status().controls ?? 0), 0)
  return { port: ports[0]!, second: ports[1]!, certificate, routes, controls }
}

async function phoneAddressBook(host: TestHost) {
  host.presence.mode = 'approve'
  const desktop = await host.enroll({ listener: 'unix' })
  const { invitation } = await desktop.json<{ invitation: { payload: string } }>('native/pairings', { method: 'POST', body: {} })
  const { rootSpki, secret } = parsePairingPayload(invitation.payload)
  const code = invitationCode(secret)
  const socket = connect(host.host.nativePort!, '127.0.0.1')
  socket.on('error', () => {})
  const pairing = await openNativeHttp(
    socket,
    { path: 'direct' },
    { rootSpki, knockKey: createHash('sha256').update(code).digest(), pairing: true },
  )
  try {
    const device = createTransportCertificate()
    const verification = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey
    const created = await pairing.request('POST', '/link/api/enrollments', {
      name: '中继测试手机',
      publicKey: device.spki.toString('base64url'),
      invitation: code,
      gatewayHash: '0'.repeat(64),
      native: { certificate: device.cert, verificationKey: verification.export({ type: 'spki', format: 'der' }).toString('base64url') },
    })
    expect(created.status).toBe(202)
    const { enrollment } = created.body as { enrollment: { id: string; nonce: string } }
    await vi.waitFor(async () => {
      const status = await pairing.request('GET', `/link/api/enrollments/${enrollment.id}`)
      expect(status.body).toMatchObject({ enrollment: { status: 'approved' } })
    })
    const signature = sign('sha256', Buffer.from(`latch-enroll-v1\n${host.host.hostId}\n${enrollment.id}\n${enrollment.nonce}`), {
      key: createPrivateKey(device.key),
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url')
    const prepared = await pairing.request('POST', `/link/api/enrollments/${enrollment.id}/prepare`, { signature })
    expect(prepared.status).toBe(200)
    const { deviceId, addressBook } = prepared.body as { deviceId: string; addressBook: string }
    return verifyAddressBook(addressBook, rootSpki, { hostId: host.host.hostId, deviceId })
  } finally {
    pairing.close()
  }
}

it('closes the winning edge origin when its exact lease is revoked', async () => {
  const seed = nodeCrypto.random(32),
    token = nodeCrypto.random(32),
    relayId = Buffer.from(nodeCrypto.random(16)).toString('hex')
  const relay = await edgeRelay(seed, relayId, token)
  const first = createServer({ cert: relay.certificate.cert, key: relay.certificate.key })
  const pending = new Set<Duplex>()
  first.on('secureConnection', socket => {
    pending.add(socket)
    socket.once('close', () => pending.delete(socket))
  })
  first.listen(0, '127.0.0.1')
  await once(first, 'listening')
  cleanup.push(async () => {
    for (const socket of pending) socket.destroy()
    await new Promise(resolve => first.close(resolve))
  })
  const a = new URL(`https://localhost:${(first.address() as AddressInfo).port}/`)
  const b = new URL(`https://localhost:${relay.port}/`)
  const aRevoked = new AbortController()
  const bRevoked = new AbortController()
  const releases: string[] = []
  const path = await openRelay(
    {
      url: a,
      extraUrls: [b],
      relayId: Buffer.from(relayId, 'hex'),
      edge: { relayKey: await nodeCrypto.publicKey(seed), shard: 0 },
      profile: 'outer-pad-v2',
      ca: relay.certificate.cert,
      resolveAddress: async url => {
        const revoked = (url.origin === a.origin ? aRevoked : bRevoked).signal
        return {
          origin: url.origin,
          address: '127.0.0.1',
          revoked,
          permitted: () => !revoked.aborted,
          release: () => {
            releases.push(url.origin)
          },
        }
      },
    },
    'data',
  )
  expect(path.permitted()).toBe(true)
  bRevoked.abort()
  await path.peer.closed
  expect(path.permitted()).toBe(false)
  expect(aRevoked.signal.aborted).toBe(false)
  await vi.waitFor(() => expect(releases.sort()).toEqual([a.origin, b.origin].sort()))
}, 60_000)

it('adds a Workers relay from its file in the real Host, tests it, signs both addresses, refuses another key and removes it', async () => {
  const seed = nodeCrypto.random(32),
    token = nodeCrypto.random(32),
    relayId = Buffer.from(nodeCrypto.random(16)).toString('hex')
  const relay = await edgeRelay(seed, relayId, token)
  const host = await startTestHost({
    native: { host: '127.0.0.1', port: 0 },
    nativeRelayCa: relay.certificate.cert,
    egressAllow: [`localhost:${relay.port}`, `localhost:${relay.second}`],
    egressLookup: (_hostname, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]),
  })
  cleanup.push(() => host.close())
  host.presence.mode = 'approve'
  const desktop = await host.enroll({ listener: 'unix' })
  const relayKey = Buffer.from(await nodeCrypto.publicKey(seed)).toString('hex')
  const keyHash = createHash('sha256').update(Buffer.from(relayKey, 'hex')).digest('hex').slice(0, 8)
  const file = {
    relayId,
    url: `https://localhost:${relay.port}/`,
    kind: 'edge' as const,
    relayKey,
    extraUrls: [`https://localhost:${relay.second}/`],
    registrationKey: `lrt1.${Buffer.from(token).toString('base64url')}`,
  }

  // A file naming another relay key: the node's signature does not match, nothing is saved.
  const other = Buffer.from(await nodeCrypto.publicKey(nodeCrypto.random(32))).toString('hex')
  const refusedId = crypto.randomUUID()
  const mismatch = await desktop.confirmed('native/relays', {
    method: 'POST',
    body: { requestId: refusedId, profile: { ...file, relayKey: other } },
  })
  expect(await mismatch.json()).toMatchObject({ error: 'native-relay-key-mismatch' })
  expect((await desktop.json<NativeLinkInfo>('native/info')).relays).toEqual([])
  // The refused addition stays pending until it is given up.
  expect((await desktop.request(`native/relay-requests/${refusedId}`, { method: 'DELETE' })).ok).toBe(true)

  const before = host.presence.requests.length
  const added = await desktop.confirmed('native/relays', { method: 'POST', body: { requestId: crypto.randomUUID(), profile: file } })
  expect(added.ok).toBe(true)
  const confirmation = host.presence.requests[before]!
  expect(confirmation.preview.subject).toMatchObject({ form: 'relay.add', slots: { count: '2', hash: keyHash } })
  expect(JSON.stringify(confirmation.preview)).not.toContain(file.registrationKey)
  const info = await desktop.json<NativeLinkInfo>('native/info')
  expect(info.edgeRelayAvailable).toBe(true)
  expect(info.relays).toMatchObject([{ relayId, kind: 'edge', addresses: 2, keyHash }])
  await expect.poll(async () => (await desktop.json<NativeLinkInfo>('native/info')).relays[0]?.status).toBe('connected')

  // 测试 twice: one test route for the day, re-registered, never a new route per test.
  const live = relay.routes()
  for (let run = 0; run < 2; run++) {
    const tested = await desktop.json<{ reached: string; failure?: string }>(`native/relays/${relayId}/test`, { method: 'POST', body: {} })
    expect(tested).toMatchObject({ reached: 'registered' })
    expect(tested.failure).toBeUndefined()
  }
  expect(relay.routes()).toBe(live + 1)

  const book = await phoneAddressBook(host)
  expect(book.relays).toHaveLength(1)
  const entry = book.relays[0]!
  expect(Buffer.from(entry.relayId).toString('hex')).toBe(relayId)
  expect(Buffer.from(entry.edge!.relayKey).toString('hex')).toBe(relayKey)
  expect([entry.url, ...(entry.extraUrls ?? [])]).toEqual([file.url, ...file.extraUrls])

  expect((await desktop.request(`native/relays/${relayId}`, { method: 'DELETE' })).ok).toBe(true)
  expect((await desktop.json<NativeLinkInfo>('native/info')).relays).toEqual([])
  // No longer dialed: its live control connection is closed.
  await expect.poll(() => relay.controls()).toBe(0)
}, 90_000)

it.skipIf(latchEnv(process.env, 'ELECTRON_E2E') !== '1' || process.platform !== 'darwin')(
  'imports through the real desktop and Host, confirms locally, and retries a lost success with the identical request',
  async () => {
    const token = nodeCrypto.random(32),
      relayId = Buffer.from(nodeCrypto.random(16)).toString('hex')
    const certificate = createTransportCertificate(Date.now(), 3_600_000, 'localhost')
    const relay = await startRelay({
      host: '127.0.0.1',
      port: 0,
      cert: certificate.cert,
      key: certificate.key,
      relayId: Buffer.from(relayId, 'hex'),
      registrationToken: token,
      gateway: {
        binary: resolve('dist/relay/latch-relay-tls'),
        maxHandshakes: 8,
        handshakesPerSecond: 100,
        handshakeBurst: 8,
        prefixFraction: 1,
      },
    })
    cleanup.push(() => relay.close())
    const host = await startTestHost({
      native: { host: '127.0.0.1', port: 0 },
      nativeRelayCa: certificate.cert,
      egressAllow: [`localhost:${relay.port}`],
      egressLookup: (_hostname, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]),
      hostName: '中继测试电脑',
      uiDir: resolve(latchEnv(process.env, 'E2E_UI_DIR') ?? 'dist/web'),
    })
    cleanup.push(() => host.close())
    const root = await mkdtemp(join(tmpdir(), 'lt-relay-ui-'))
    const shots = resolve(process.env.LATCH_RELAY_SHOTS ?? 'test-results/native-relay-edge')
    let application: ElectronApplication | undefined
    try {
      await mkdir(shots, { recursive: true })
      await writeHostState(host.dataDir, {
        version: 2,
        pid: process.pid,
        hostId: host.host.hostId,
        instanceId: host.host.instanceId,
        socketPath: host.host.socketPath,
        loopbackOrigin: host.host.loopbackOrigin,
        tlsOrigin: null,
        startedAt: host.host.startedAt,
        dataDir: host.dataDir,
      })
      application = await _electron.launch({
        args: [
          resolve('apps/desktop/src/main.cjs'),
          `--latch-host-state=${join(host.dataDir, 'host.json')}`,
          `--latch-user-data=${join(root, 'electron')}`,
          '--use-mock-keychain',
        ],
        cwd: process.cwd(),
        env: Object.fromEntries(
          Object.entries(desktopShellEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
        timeout: 30_000,
      })
      const page = await application.firstWindow()
      page.setDefaultTimeout(20_000)
      await page.getByRole('button', { name: '继续', exact: true }).click()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      host.presence.mode = 'manual'
      await openEntry(page, '连接转发')
      const profile = {
        relayId,
        url: `https://localhost:${relay.port}/`,
        spkiHash: createHash('sha256').update(certificate.spki).digest('hex'),
        registrationKey: `lrt1.${Buffer.from(token).toString('base64url')}`,
      }
      await page.getByRole('button', { name: '添加转发服务', exact: true }).click()
      const sheet = page.locator('.relay-add-dialog')
      expect(await sheet.getByRole('button', { name: /Cloudflare Workers/u }).getAttribute('aria-disabled')).toBe('true')
      await sheet.getByRole('button', { name: '已有配置文件', exact: true }).click()
      await sheet
        .getByTestId('relay-file')
        .setInputFiles({ name: 'relay.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ version: 1, profile })) })
      await sheet.getByText('已包含', { exact: true }).waitFor()
      const capture = async (stage: string) => {
        for (const [width, height] of [
          [390, 844],
          [768, 1024],
          [1440, 900],
        ] as const)
          for (const colorScheme of ['light', 'dark'] as const) {
            await application!.evaluate(
              ({ BrowserWindow }, { width, height }) => {
                const window = BrowserWindow.getAllWindows()[0]!
                window.setMinimumSize(320, 400)
                window.setContentSize(width, height)
              },
              { width, height },
            )
            await page.waitForFunction(width => innerWidth === width, width)
            await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
            await page.waitForFunction(() => {
              const dialog = document.querySelector('.relay-add-dialog:modal')
              return (
                dialog
                && getComputedStyle(dialog).opacity === '1'
                && dialog
                  .getAnimations({ subtree: true })
                  .every(animation => animation.playState !== 'running' || animation.effect?.getComputedTiming().iterations === Infinity)
              )
            })
            await page.evaluate(async () => {
              await document.fonts.ready
            })
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
            const surface = sheet.locator('.ui-dialog-surface, .ui-sheet-surface')
            expect(await surface.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
            expect((await sheet.innerText()).includes(profile.registrationKey)).toBe(false)
            await page.screenshot({ path: join(shots, `${stage}--${width}--${colorScheme}.png`), animations: 'disabled', scale: 'css' })
          }
      }
      await capture('import-check')
      // Every request reaches the real Host. Only one successful response is lost after the Host has completed it.
      await page.evaluate(() => {
        const base = window.fetch.bind(window)
        let lose = true
        const requests: Array<{ requestId: string; keys: string[] }> = []
        Reflect.set(window, 'relayImportRequests', requests)
        window.fetch = async (input, init) => {
          const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.href
          const addition = url.endsWith('/link/api/native/relays') && init?.method === 'POST'
          if (addition) {
            const body = JSON.parse(String(init?.body)) as { requestId: string }
            requests.push({ requestId: body.requestId, keys: Object.keys(body).sort() })
          }
          const response = await base(input, init)
          if (addition && lose && response.ok) {
            lose = false
            throw new TypeError('Lost relay addition response')
          }
          return response
        }
      })
      await sheet.getByRole('button', { name: '确认并连接', exact: true }).click()
      const confirmation = await host.presence.waitForRequest()
      const keyHash = profile.spkiHash.slice(0, 8)
      expect(confirmation.preview.subject).toMatchObject({
        form: 'relay.add',
        slots: { count: '1', target: `localhost:${relay.port}`, hash: keyHash },
      })
      expect(JSON.stringify(confirmation.preview).includes(profile.registrationKey)).toBe(false)
      await sheet.getByText('在系统窗口中确认', { exact: true }).waitFor()
      expect(await sheet.getByText('这台 Mac 已签发', { exact: true }).count()).toBe(0)
      await capture('import-waiting')
      await sheet.getByText('在系统窗口中确认', { exact: true }).waitFor()
      host.presence.approveNext()
      await sheet.getByRole('button', { name: '重试', exact: true }).waitFor()
      await sheet.getByText('添加结果待确认', { exact: true }).waitFor()
      expect(await sheet.getByText('这台 Mac 已签发', { exact: true }).count()).toBe(0)
      await capture('import-unknown')
      // Closing the dialog does not discard an unknown request or its original profile.
      await sheet.getByRole('button', { name: '关闭', exact: true }).click()
      await page.getByRole('button', { name: '添加转发服务', exact: true }).click()
      await sheet.getByRole('button', { name: '重试', exact: true }).click()
      await sheet.getByRole('button', { name: '完成', exact: true }).waitFor()
      expect(host.presence.requests).toHaveLength(1)
      const requests = (await page.evaluate(() => Reflect.get(window, 'relayImportRequests'))) as Array<{
        requestId: string
        keys: string[]
      }>
      expect(requests.length).toBeGreaterThanOrEqual(3)
      expect(new Set(requests.map(request => request.requestId)).size).toBe(1)
      expect(requests.every(request => request.keys.join(',') === 'profile,requestId')).toBe(true)
      const saved = JSON.parse(await readFile(join(host.dataDir, 'native', 'relays.json'), 'utf8')) as {
        profiles: Array<{ relayId: string }>
        configReceipts: Array<{ requestId: string }>
      }
      expect(saved.profiles.map(profile => profile.relayId)).toEqual([relayId])
      expect(saved.configReceipts.filter(receipt => receipt.requestId === requests[0]!.requestId)).toHaveLength(1)
      await capture('import-connected')
      await expect
        .poll(async () => {
          const response = await host.raw('unix', 'api/native/info')
          return ((await response.json()) as NativeLinkInfo).relays[0]?.status
        })
        .toBe('connected')
      const book = await phoneAddressBook(host)
      expect(book.relays.map(node => ({ relayId: Buffer.from(node.relayId).toString('hex'), url: node.url }))).toEqual([
        { relayId, url: profile.url },
      ])
      expect(Buffer.from(book.relays[0]!.spkiHash).toString('hex')).toBe(profile.spkiHash)
      await sheet.getByText('这台 Mac 已签发', { exact: true }).waitFor()
      await capture('import-issued')
      await sheet.getByRole('button', { name: '完成', exact: true }).click()
    } finally {
      await application?.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  120_000,
)
