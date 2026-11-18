import { createHmac, randomBytes } from 'node:crypto'
import { connect, type TLSSocket } from 'node:tls'
import {
  decodeMessage,
  encodeFrame,
  encodeMessage,
  holder,
  issuePass,
  makeProof,
  routeKey,
  UTC_DAY,
  verifyEdgeChallenge,
  WebSocketParser,
  type RelayMessage,
} from '@latch/link-wire'
import { nodeCrypto, RelayClosed, RelayControl, type RelayEndpoint } from '@latch/link-client'

/**
 * The operator's acceptance run against a freshly deployed edge relay (before any Mac uses it): it checks what only the
 * real platform can show. Every item answers pass, fail or skipped with a short reason; nothing secret is returned, and
 * the registration token and admin token stay in memory.
 *
 * - healthz: the Worker answers 200 without waking a node object.
 * - admin: the admin routes are 404 without the token and with a wrong one; with it they report each shard's start time.
 *   Only a 200 with the operator's token proves the node is theirs: without it every later item is skipped.
 * - wrong key: a client expecting another relay key refuses the node before sending anything that depends on it, and a
 *   Host with a wrong registration token is refused.
 * - register: a Host with the relay file registers a route (the positive control).
 * - cover: an unauthenticated client gets about three seconds of 4 KiB-bucket cover, exact frames, then is closed.
 * - unauthenticated: N sockets that never read nor authenticate are all refused or closed by the node, the object is
 *   not reset (same start time) and it still registers a Host afterwards.
 * - oversized: four unauthenticated 8 MiB messages are refused, health still answers and the object is not reset. It
 *   does not cover the platform's 32 MiB message limit.
 * Its routes are derived per relay and day from the admin token, so repeated runs reuse them.
 * - slow reader: a joined phone that stops reading while the Host streams is closed by the node, and the object is not
 *   reset. A pass needs the runtime to report the backlog; otherwise only the per-socket send budget bounds it.
 */
export interface AcceptanceInput {
  url: URL
  relayId: Uint8Array
  relayKey: Uint8Array
  shard: number
  registrationToken?: Uint8Array
  adminToken?: string
  sockets: number
  slowSeconds: number
  /** Bytes per second the Host streams to the slow reader; below the node's per-socket send budget. */
  slowRate: number
}
export interface AcceptanceOptions {
  /** Tests only: a private CA and a fixed dial address for the local fixture. */
  ca?: string
  address?: string
  progress?(name: string): void
}
export interface AcceptanceItem {
  name: string
  result: 'pass' | 'fail' | 'skipped'
  detail: string
}

const PROTOCOL = 'latch-relay.2'
/** The size of each oversized unauthenticated message: 8 MiB, four of them, 32 MiB of upload in all. */
export const OVERSIZED_BYTES = 8 * 1024 * 1024
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function dial(input: AcceptanceInput, options: AcceptanceOptions): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const host = input.url.hostname.replace(/^\[|\]$/gu, '')
    const socket = connect({
      host: options.address ?? host,
      port: Number(input.url.port || 443),
      ...(/^[0-9.:]+$/u.test(host) ? {} : { servername: host }),
      ...(options.ca ? { ca: options.ca } : {}),
      ALPNProtocols: ['http/1.1'],
      minVersion: 'TLSv1.3',
    })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('connect timeout'))
    }, 10_000)
    socket.once('secureConnect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

/** One HTTP/1.1 request over its own TLS connection: status and a body of at most 64 KiB. */
async function http(
  input: AcceptanceInput,
  options: AcceptanceOptions,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const socket = await dial(input, options)
  const lines = [`${method} ${path} HTTP/1.1`, `Host: ${input.url.host}`, 'Connection: close', 'Content-Length: 0']
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`)
  socket.write(`${lines.join('\r\n')}\r\n\r\n`)
  const chunks: Buffer[] = []
  let size = 0
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => socket.destroy(), 10_000)
    socket.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 65_536) socket.destroy()
      else chunks.push(chunk)
    })
    socket.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.on('error', () => {})
  })
  const text = Buffer.concat(chunks).toString('utf8')
  const status = Number(/^HTTP\/1\.1 ([0-9]{3})/u.exec(text)?.[1] ?? 0)
  const head = text.indexOf('\r\n\r\n')
  let body = head < 0 ? '' : text.slice(head + 4)
  if (/\r\ntransfer-encoding: *chunked/iu.test(text.slice(0, head))) {
    let out = ''
    for (let rest = body; ;) {
      const line = rest.indexOf('\r\n'),
        length = Number.parseInt(rest.slice(0, line), 16)
      if (!(length > 0)) break
      out += rest.slice(line + 2, line + 2 + length)
      rest = rest.slice(line + 4 + length)
    }
    body = out
  }
  return { status, body }
}

/** A client-role WebSocket written by hand, so that it can stop reading at the TCP level. */
class RawClient {
  readonly frames: Array<{ at: number; message?: RelayMessage; bytes: number }> = []
  closedAt?: number
  closeCode?: number
  private readonly parser = new WebSocketParser(false)
  private waiters: Array<() => void> = []
  readonly socket: TLSSocket
  private readonly started: number
  private constructor(socket: TLSSocket, started: number) {
    this.socket = socket
    this.started = started
  }
  static async open(input: AcceptanceInput, options: AcceptanceOptions): Promise<RawClient | number> {
    const socket = await dial(input, options)
    const key = randomBytes(16).toString('base64')
    socket.write(
      `GET /v1/c/${input.shard} HTTP/1.1\r\nHost: ${input.url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: ${PROTOCOL}\r\n\r\n`,
    )
    const head = await new Promise<{ status: number; rest: Buffer }>(resolve => {
      let pending = Buffer.alloc(0)
      const timer = setTimeout(() => done(0), 10_000)
      const done = (status: number, rest = Buffer.alloc(0)) => {
        clearTimeout(timer)
        socket.off('data', onData)
        resolve({ status, rest })
      }
      const onData = (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk])
        const end = pending.indexOf('\r\n\r\n')
        if (end < 0) {
          if (pending.length > 16_384) done(0)
          return
        }
        const text = pending.subarray(0, end).toString('latin1')
        const status = Number(/^HTTP\/1\.1 ([0-9]{3})/u.exec(text)?.[1] ?? 0)
        const protocol = /\r\nsec-websocket-protocol: *([^\r]*)/iu.exec(text)?.[1]
        done(status === 101 && protocol === PROTOCOL ? 101 : status || 1, pending.subarray(end + 4))
      }
      socket.on('data', onData)
      socket.once('close', () => done(0))
      socket.on('error', () => {})
    })
    if (head.status !== 101) {
      socket.destroy()
      return head.status
    }
    const client = new RawClient(socket, Date.now())
    socket.on('data', (chunk: Buffer) => client.feed(chunk))
    socket.once('close', () => {
      client.closedAt ??= Date.now() - client.started
      client.wake()
    })
    if (head.rest.length) client.feed(head.rest)
    return client
  }
  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter()
  }
  private feed(chunk: Buffer): void {
    let frames
    try {
      frames = this.parser.feed(chunk)
    } catch {
      this.closeCode = -1
      this.socket.destroy()
      return
    }
    for (const frame of frames) {
      if (frame.opcode === 9) this.write(10, frame.payload)
      else if (frame.opcode === 8) {
        this.closeCode = frame.payload.length >= 2 ? (frame.payload[0]! << 8) | frame.payload[1]! : 1005
        this.closedAt = Date.now() - this.started
        this.socket.end()
      } else if (frame.opcode === 2) {
        let message: RelayMessage | undefined
        try {
          message = decodeMessage(frame.payload, 2)
        } catch {
          message = undefined
        }
        this.frames.push({ at: Date.now() - this.started, ...(message ? { message } : {}), bytes: frame.payload.length })
      }
    }
    this.wake()
  }
  private write(opcode: 2 | 8 | 9 | 10, payload: Uint8Array): void {
    if (!this.socket.destroyed) this.socket.write(encodeFrame({ opcode, payload }, randomBytes(4)))
  }
  send(message: RelayMessage): void {
    this.write(2, encodeMessage(message, 2))
  }
  /** One binary frame of any size (the shared encoder stops at the protocol's 64 KiB); the platform assembles it. */
  raw(payload: Uint8Array): void {
    if (this.socket.destroyed) return
    const mask = randomBytes(4),
      header = Buffer.alloc(14)
    header[0] = 0x82
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
    mask.copy(header, 10)
    const body = Buffer.from(payload)
    for (let index = 0; index < body.length; index++) body[index] = body[index]! ^ mask[index % 4]!
    this.socket.write(Buffer.concat([header, body]))
  }
  /** The next message that is not PAD, or undefined after `ms`. */
  async next(ms: number, skip = 0): Promise<RelayMessage | undefined> {
    const deadline = Date.now() + ms
    for (;;) {
      const real = this.frames.filter(frame => frame.message && frame.message.type !== 'pad')
      if (real.length > skip) return real[skip]!.message
      if (this.closedAt !== undefined || Date.now() >= deadline) return undefined
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, Math.max(1, deadline - Date.now()))
        this.waiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }
  async closed(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms
    while (this.closedAt === undefined && Date.now() < deadline) await sleep(50)
    return this.closedAt !== undefined
  }
  close(): void {
    this.socket.destroy()
  }
}

export async function runAcceptance(input: AcceptanceInput, options: AcceptanceOptions = {}): Promise<AcceptanceItem[]> {
  const items: AcceptanceItem[] = []
  const record = (name: string, result: AcceptanceItem['result'], detail: string) => {
    items.push({ name, result, detail })
    options.progress?.(name)
  }
  const attempt = async (name: string, run: () => Promise<void>) => {
    try {
      await run()
    } catch (error) {
      // Only the error's class of failure, never its text: it could carry an address.
      record(name, 'fail', error instanceof RelayClosed ? `连接被关闭（${error.closeCode}）` : '未完成')
    }
  }
  const endpoint = (relayKey = input.relayKey): RelayEndpoint => ({
    url: input.url,
    relayId: input.relayId,
    edge: { relayKey, shard: input.shard },
    profile: 'outer-pad-v2',
    ...(options.ca ? { ca: options.ca } : {}),
    ...(options.address ? { resolveAddress: async () => options.address! } : {}),
  })
  const admin = async (): Promise<{ status: number; startedAt?: number[]; shards?: Array<Record<string, unknown>> }> => {
    if (!input.adminToken) return { status: 0 }
    const response = await http(input, options, 'GET', '/admin/status', { Authorization: `Bearer ${input.adminToken}` })
    if (response.status !== 200) return { status: response.status }
    const shards = (JSON.parse(response.body) as { shards: Array<Record<string, unknown>> }).shards
    return { status: 200, shards, startedAt: shards.map(shard => Number(shard.startedAt)) }
  }
  const sameObjects = (before?: number[], after?: number[]) =>
    Boolean(before && after && before.length === after.length && before.every((value, index) => value === after[index] && value > 0))

  await attempt('healthz', async () => {
    const response = await http(input, options, 'GET', '/healthz')
    record('healthz', response.status === 200 && response.body === 'ok\n' ? 'pass' : 'fail', `HTTP ${response.status}`)
  })

  let baseline: number[] | undefined
  let owned = false
  await attempt('admin', async () => {
    const none = await http(input, options, 'GET', '/admin/status')
    const wrong = await http(input, options, 'GET', '/admin/status', { Authorization: `Bearer ${randomBytes(32).toString('hex')}` })
    const hidden = none.status === 404 && wrong.status === 404
    const status = await admin()
    baseline = status.startedAt
    // Only a node that accepts this admin token is the operator's own: nothing below runs against any other.
    owned = status.status === 200 && Boolean(baseline?.every(value => value > 0))
    record(
      'admin',
      hidden && owned ? 'pass' : 'fail',
      `无令牌 ${none.status}，错误令牌 ${wrong.status}，正确令牌 ${input.adminToken ? status.status : '缺少'}`,
    )
  })
  const LOAD = ['wrong-key', 'register', 'cover', 'unauthenticated', 'oversized', 'slow-reader']
  if (!owned) {
    for (const name of LOAD) record(name, 'skipped', '管理令牌没有得到 200：不能确认这是你自己的中继，没有继续')
    return items
  }
  const adminKey = input.adminToken!
  const day = Math.floor(Date.now() / 1000 / UTC_DAY)
  // The run's routes are derived per relay and day, so repeated runs reuse them instead of leaving new 24-hour routes.
  const routeSeed = (label: string) => createHmac('sha256', adminKey).update(`latch-relay-accept-v1:${label}:${day}`).digest()

  await attempt('wrong-key', async () => {
    let identity = false
    try {
      ;(await RelayControl.connect(endpoint(nodeCrypto.random(32)))).close()
    } catch (error) {
      identity = error instanceof Error && error.message === 'Relay identity rejected'
    }
    let token: boolean | undefined
    if (input.registrationToken) {
      const control = await RelayControl.connect({ ...endpoint(), registrationToken: nodeCrypto.random(32) })
      try {
        await control.register({ routeKey: await routeKey(nodeCrypto, routeSeed('refused'), input.relayId, day), day, alternate: false })
        token = false
      } catch (error) {
        token = error instanceof RelayClosed && error.closeCode === 4100
      } finally {
        control.close()
      }
    }
    record(
      'wrong-key',
      identity && token !== false ? 'pass' : 'fail',
      `另一把中继密钥${identity ? '被拒绝' : '未被拒绝'}；${token === undefined ? '开放登记，未测注册令牌' : token ? '错误注册令牌被拒绝' : '错误注册令牌未被拒绝'}`,
    )
  })

  // The Host side of the slow-reader test: one route, kept open.
  const seed = routeSeed('host'),
    key = await routeKey(nodeCrypto, seed, input.relayId, day)
  let control: RelayControl | undefined
  await attempt('register', async () => {
    control = await RelayControl.connect({
      ...endpoint(),
      ...(input.registrationToken ? { registrationToken: input.registrationToken } : {}),
    })
    await control.register({ routeKey: key, day, alternate: false })
    record('register', 'pass', `往返 ${Math.round(control.roundTripMs)} ms`)
  })

  await attempt('cover', async () => {
    const client = await RawClient.open(input, options)
    if (typeof client === 'number') return record('cover', 'fail', `升级被拒绝（${client}）`)
    try {
      const clientNonce = nodeCrypto.random(32)
      client.send({ type: 'edge-hello', clientNonce })
      const challenge = await client.next(5000)
      const signed =
        challenge?.type === 'edge-challenge'
        && (await verifyEdgeChallenge(
          nodeCrypto,
          input.relayKey,
          {
            relayId: input.relayId,
            role: 'client',
            clientNonce,
            relayNonce: challenge.nonce,
            timeMs: challenge.timeMs,
            requiresToken: challenge.requiresToken,
          },
          challenge.signature,
        ))
      // Never authenticating, the socket is closed by the node after its three-second window.
      const closed = await client.closed(8000)
      const pads = client.frames.filter(frame => frame.message?.type === 'pad')
      const cover = client.frames.filter(frame => frame.at <= 3600).reduce((sum, frame) => sum + frame.bytes + 4, 0)
      const late = client.frames.filter(frame => frame.at > 4500).length
      const exact = client.frames.every(frame => frame.message !== undefined)
      // 75 ticks of 4 KiB on the 40 ms grid; network jitter only moves frames, it adds none.
      const expected = 75 * 4096
      const ok = signed && closed && exact && late === 0 && pads.length > 0 && cover >= expected * 0.5 && cover <= expected * 1.1
      record(
        'cover',
        ok ? 'pass' : 'fail',
        `${signed ? '签名相符' : '签名不符'}，填充 ${pads.length} 帧、约 ${Math.round(cover / 1024)} KiB，${exact ? '帧完整' : '有无法解析的帧'}，${closed ? `${(client.closedAt! / 1000).toFixed(1)} s 后关闭` : '未关闭'}`,
      )
    } finally {
      client.close()
    }
  })

  const sockets = async () => ((await admin()).shards ?? []).reduce((sum, shard) => sum + Number(shard.sockets ?? 0), 0)
  await attempt('unauthenticated', async () => {
    const before = await sockets()
    const opened = await Promise.all(Array.from({ length: input.sockets }, () => RawClient.open(input, options).catch(() => 0)))
    const clients = opened.filter((value): value is RawClient => typeof value !== 'number')
    const refused = opened.length - clients.length
    // None ever reads or authenticates; the node must refuse or close every one of them by itself.
    for (const client of clients) client.socket.pause()
    await sleep(6000)
    const left = (await sockets()) - before
    for (const client of clients) client.close()
    await sleep(1000)
    const after = await admin()
    let registered = false
    try {
      const fresh = await RelayControl.connect({
        ...endpoint(),
        ...(input.registrationToken ? { registrationToken: input.registrationToken } : {}),
      })
      await fresh.register({ routeKey: await routeKey(nodeCrypto, routeSeed('fresh'), input.relayId, day), day, alternate: false })
      fresh.close()
      registered = true
    } catch {
      registered = false
    }
    const kept = sameObjects(baseline, after.startedAt)
    record(
      'unauthenticated',
      registered && kept && left <= 0 ? 'pass' : 'fail',
      `${input.sockets} 个未认证连接：${refused} 个被拒绝，${left <= 0 ? '其余都被节点关闭' : `${left} 个 6 s 后仍未关闭`}；${kept ? '节点对象未重置' : '节点对象已重置'}；之后${registered ? '仍可登记' : '无法登记'}`,
    )
  })

  await attempt('oversized', async () => {
    // A few unauthenticated messages far above the relay's 64 KiB limit, each assembled by the platform before the node
    // can refuse it. Kept to what an operator's own uplink sends in seconds; the platform's 32 MiB maximum is not tried.
    const count = 4,
      size = OVERSIZED_BYTES
    const clients = (await Promise.all(Array.from({ length: count }, () => RawClient.open(input, options).catch(() => 0)))).filter(
      (value): value is RawClient => typeof value !== 'number',
    )
    for (const client of clients) client.raw(new Uint8Array(size).fill(1))
    const closed = await Promise.all(clients.map(client => client.closed(15_000)))
    for (const client of clients) client.close()
    const health = await http(input, options, 'GET', '/healthz')
    const after = await admin()
    const kept = sameObjects(baseline, after.startedAt)
    record(
      'oversized',
      health.status === 200 && kept && closed.every(Boolean) ? 'pass' : 'fail',
      `${clients.length} 条 ${size / 1024 / 1024} MiB 的未认证消息：${closed.every(Boolean) ? '连接被关闭' : '有连接未关闭'}，健康检查 ${health.status}，${kept ? '节点对象未重置' : '节点对象已重置'}；不代表 32 MiB 的情况`,
    )
  })

  await attempt('slow-reader', async () => {
    if (!control) return record('slow-reader', 'skipped', '登记没有成功')
    const device = await holder(nodeCrypto, seed, input.relayId, Uint8Array.of(1), day)
    const pass = await issuePass(nodeCrypto, key, {
      pairing: false,
      relayId: input.relayId,
      day,
      notBefore: day * UTC_DAY,
      notAfter: (day + 1) * UTC_DAY,
      routePub: await nodeCrypto.publicKey(key),
      holderPub: await nodeCrypto.publicKey(device.seed),
      tag: device.tag,
    })
    const accepted = control.accept()
    // Left pending on an early return; control.close() rejects it at the end.
    accepted.catch(() => {})
    const client = await RawClient.open(input, options)
    if (typeof client === 'number') return record('slow-reader', 'fail', `升级被拒绝（${client}）`)
    try {
      client.send({ type: 'edge-hello', clientNonce: nodeCrypto.random(32) })
      const challenge = await client.next(5000)
      if (challenge?.type !== 'edge-challenge') return record('slow-reader', 'fail', '没有收到挑战')
      client.send({ type: 'bound-admit', proof: await makeProof(nodeCrypto, device.seed, pass, challenge.timeMs, challenge.nonce) })
      const setup = await Promise.race([accepted, sleep(10_000).then(() => undefined)])
      if (!setup) return record('slow-reader', 'fail', '没有接合')
      setup.finishSetup()
      const spliced = await client.next(5000, 2)
      if (spliced?.type !== 'spliced') return record('slow-reader', 'fail', '没有接合')
      // The phone stops reading at the TCP level; the Host streams at a steady rate below the node's send budget.
      client.socket.pause()
      let ended = false
      setup.stream.once('close', () => {
        ended = true
      })
      setup.stream.on('error', () => {})
      const chunk = Buffer.alloc(16_000, 7),
        perTick = Math.max(1, Math.round(input.slowRate / 10 / chunk.length))
      const started = Date.now()
      let sent = 0,
        backlog = 0
      while (!ended && Date.now() - started < input.slowSeconds * 1000) {
        for (let index = 0; index < perTick && !ended; index++) {
          setup.stream.write(chunk)
          sent += chunk.length
        }
        await sleep(100)
        if (input.adminToken && (Date.now() - started) % 1000 < 100) {
          const status = await admin().catch(() => undefined)
          for (const shard of status?.shards ?? [])
            backlog = Math.max(backlog, Number((shard.buffered as { backlog?: number } | undefined)?.backlog ?? 0))
        }
      }
      const seconds = ((Date.now() - started) / 1000).toFixed(1)
      setup.stream.destroy()
      const after = await admin()
      const kept = input.adminToken ? sameObjects(baseline, after.startedAt) : undefined
      record(
        'slow-reader',
        ended && kept !== false ? 'pass' : 'fail',
        `${ended ? `${seconds} s 后节点关闭了不读的手机` : `${seconds} s 内没有关闭（平台未报告积压，只有发送速率上限）`}；已发 ${Math.round(sent / 1024)} KiB${input.adminToken ? `，报告的最大积压 ${Math.round(backlog / 1024)} KiB；${kept ? '节点对象未重置' : '节点对象已重置'}` : ''}`,
      )
    } finally {
      client.close()
    }
  })
  control?.close()
  return items
}
