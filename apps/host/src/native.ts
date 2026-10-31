import { createServer, type Socket, type Server, type AddressInfo } from 'node:net'
import { createServer as createHttp2Server, type ServerHttp2Session } from 'node:http2'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { once } from 'node:events'
import { acceptNative, createTransportCertificate, validateNativeTlsBinary, RelayTunnel } from '@latch/link-client'
import { formatPairingPayload, hex, invitationSecret, type KnockBinding } from '@latch/link-wire'
import type { Device } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import type { DeviceStore, EnrollmentService } from './auth.ts'
import type { HostIdentity } from './identity.ts'
import { canonicalBindAddress, type ListenerContext } from './listeners.ts'

export interface NativeOpening {
  deviceId: string
  pairing: boolean
  listener: ListenerContext
  source: string
  localAddress?: string
  invitationHash?: string
  /** Set once this opening presented the keys of an enrollment. */
  enrollmentId?: string
  /** Pairing requests this connection sent that could not prove proximity. */
  gateRefusals?: number
  windowHash?: string
  controlUsed?: boolean
  bulkAttempted?: boolean
  bulk?: { handle: string; etag: string; requestId: string; windowHash: string; expiresAt: number }
  activateBulk?(): void
  close?(): Promise<void>
  signal?: AbortSignal
  guardTransportWrites?(check: () => boolean): void
  padding?: {
    activity(key: object, active: boolean): void
    protect(): void
    protectUntil(deadline: number): void
    guard(check: () => boolean): void
  }
}
export interface NativeHostOptions {
  tlsBinary: string
  identity: HostIdentity
  devices: DeviceStore
  enrollments: EnrollmentService
  bind?: { host: string; port: number }
  relayAvailable?(): boolean
  handler(req: IncomingMessage, res: ServerResponse, opening: NativeOpening): void | Promise<void>
}

export async function startNativeHost(options: NativeHostOptions) {
  const origin = `https://native-${options.identity.hostId}.invalid`
  const cooldowns = new Map<string, number>()
  const bulkSlots = new Map<string, object>(),
    bulkSettlements = new Set<Promise<void>>()
  const sockets = new Map<
      Duplex,
      {
        id?: string
        knockId?: string
        relayId?: string
        opened: number
        source: string
        revoked?: boolean
        padding?: NativeOpening['padding']
      }
    >(),
    replay = new Map<string, number>()
  let certificate = createTransportCertificate(),
    rotatedAt = Date.now(),
    closing = false
  let server: Server | undefined, bind: NativeHostOptions['bind']
  const retired = new Map<Server, Promise<void>>()
  const authenticating = new Set<Promise<void>>(),
    helpers = new Set<Promise<void>>()
  const sessions = new Set<ServerHttp2Session>(),
    requests = new Set<Promise<void>>()
  const staging = new Set<Server>(),
    stopped = new AbortController()
  const acceptOnce = async (
    stream: Duplex,
    binding: KnockBinding,
    source: string,
    expectedDeviceId?: string,
    localAddress?: string,
  ): Promise<void> => {
    if (closing) {
      stream.destroy()
      return
    }
    if (sockets.size >= 64 || authenticating.size + helpers.size >= 64) {
      // While a QR is live, connections that have not even knocked must not keep the real phone out. They go oldest first.
      const idle =
        binding.path === 'direct' && options.enrollments.nativeInvitations().length > 0
          ? [...sockets].filter(([, item]) => !item.knockId && !item.id).toSorted((a, b) => a[1].opened - b[1].opened)[0]
          : undefined
      if (!idle || helpers.size >= 64) {
        stream.destroy()
        return
      }
      sockets.delete(idle[0])
      idle[0].destroy()
    }
    const state = { opened: Date.now(), source, ...(binding.path === 'relay' ? { relayId: hex(binding.relayId!) } : {}) } as {
      id?: string
      knockId?: string
      relayId?: string
      opened: number
      source: string
      revoked?: boolean
      padding?: NativeOpening['padding']
    }
    sockets.set(stream, state)
    stream.once('close', () => sockets.delete(stream))
    stream.on('error', () => {})
    try {
      if (Date.now() - rotatedAt > 30 * 60_000) {
        certificate = createTransportCertificate()
        rotatedAt = Date.now()
      }
      // Only the direct listener opens for a pairing QR: a relay or carrier path never reaches an enrollment.
      const pairable = () => (binding.path === 'direct' ? options.enrollments.nativeInvitations() : [])
      const all = [...options.devices.nativeTransportCandidates(), ...pairable()]
      const candidates = expectedDeviceId === undefined ? all : all.filter(item => item.id === expectedDeviceId)
      const accepted = await acceptNative(stream, binding, {
        tlsBinary: options.tlsBinary,
        identity: options.identity,
        certificate,
        devices: () => candidates,
        replay,
        onKnock(id) {
          if (options.devices.get(id)?.status === 'revoked') {
            if ([...sockets].filter(([peer, item]) => !peer.destroyed && item.revoked).length >= 2)
              throw new Error('Native tombstone connection limit')
            state.revoked = true
            const timer = setTimeout(() => stream.destroy(), 5000)
            timer.unref()
            stream.once('close', () => clearTimeout(timer))
          }
          const related = [...sockets].filter(([socket, item]) => socket !== stream && !socket.destroyed && item.knockId === id)
          const pending = related.filter(([, item]) => !item.id).sort((a, b) => a[1].opened - b[1].opened)
          let total = related.length
          if (candidates.find(item => item.id === id)?.kind === 'pairing') {
            // A live QR never refuses a knock, or its holder could keep the real phone from presenting it. A peer loses its
            // own oldest socket first, so one holder flooding knocks closes only what it opened.
            const oldestFirst = related.toSorted((a, b) => a[1].opened - b[1].opened)
            const evict = (list: typeof related) => {
              const victim = list.find(([, item]) => item.source === source) ?? list[0]
              if (!victim) return
              victim[0].destroy()
              list.splice(list.indexOf(victim), 1)
              const at = oldestFirst.indexOf(victim)
              if (at >= 0) oldestFirst.splice(at, 1)
              total--
            }
            while (pending.length >= 2) evict(pending)
            while (total >= 4) evict(oldestFirst)
          } else
            while (pending.length >= 2 || total >= 4) {
              const oldest = pending.shift()
              if (!oldest) throw new Error('Native device connection limit')
              oldest[0].destroy()
              total--
            }
          state.knockId = id
        },
        isActive: id => [...options.devices.nativeTransportCandidates(), ...pairable()].some(item => item.id === id),
      })
      if (closing || stream.destroyed || accepted.socket.destroyed) {
        accepted.socket.destroy()
        stream.destroy()
        await accepted.closed
        return
      }
      helpers.add(accepted.closed)
      void accepted.closed.finally(() => helpers.delete(accepted.closed))
      const candidate = candidates.find(item => item.id === accepted.deviceId)!
      const rawClosed = new Promise<void>(resolve => {
          if (stream.closed) resolve()
          else stream.once('close', resolve)
        }),
        settled = Promise.all([accepted.closed, rawClosed]).then(() => {})
      const disconnected = new AbortController()
      stream.once('close', () => disconnected.abort())
      accepted.socket.once('close', () => disconnected.abort())
      if (stream.destroyed || accepted.socket.destroyed) disconnected.abort()
      for (const [id, deadline] of cooldowns) if (deadline <= performance.now()) cooldowns.delete(id)
      state.padding = accepted.padding
      const cooldown = cooldowns.get(accepted.deviceId)
      if (cooldown !== undefined) accepted.padding?.protectUntil(cooldown)
      const opening: NativeOpening = {
        signal: disconnected.signal,
        ...(stream instanceof RelayTunnel ? { guardTransportWrites: (check: () => boolean) => stream.guardWrites(check) } : {}),
        async close() {
          disconnected.abort()
          stream.destroy()
          await settled
        },
        activateBulk() {
          if (binding.path !== 'relay' || accepted.pairing || !accepted.padding || bulkSlots.has(accepted.deviceId))
            throw new AppError(409, 'native-bulk-busy', '文件连接正在准备，请稍后重试')
          const lease = {}
          bulkSlots.set(accepted.deviceId, lease)
          bulkSettlements.add(settled)
          const timer = setTimeout(() => stream.destroy(), 60_000)
          timer.unref()
          void settled.finally(() => {
            clearTimeout(timer)
            bulkSettlements.delete(settled)
            if (bulkSlots.get(accepted.deviceId) === lease) bulkSlots.delete(accepted.deviceId)
          })
          accepted.padding.enableBulk()
        },
        ...(accepted.padding ? { padding: accepted.padding } : {}),
        deviceId: accepted.deviceId,
        pairing: accepted.pairing,
        source,
        ...(localAddress ? { localAddress } : {}),
        listener: { listener: binding.path === 'direct' ? 'native-direct' : 'native-relay', origin },
        ...(candidate.kind === 'pairing' ? { invitationHash: Buffer.from(candidate.knockKey).toString('hex') } : {}),
      }
      state.id = accepted.deviceId
      const h2 = createHttp2Server(
        {
          maxSessionMemory: 1,
          settings: { headerTableSize: 0, maxConcurrentStreams: 8, maxHeaderListSize: 8192, initialWindowSize: 32_768 },
        },
        (request, response) => {
          if (request.method === 'GET' || request.method === 'HEAD') {
            // Node otherwise resets unread request streams after finishing a response, racing queued END_STREAM frames.
            request.on('data', () => accepted.socket.destroy())
            request.resume()
          }
          if (
            !accepted.pairing
            && request.method === 'POST'
            && /\/(?:cancel|approve|deny|reject|decision)$|\/approvals\//u.test(request.url ?? '')
          ) {
            const deadline = performance.now() + 15000
            cooldowns.set(accepted.deviceId, deadline)
            for (const item of sockets.values()) if (item.id === accepted.deviceId) item.padding?.protectUntil(deadline)
          }
          const handled = Promise.resolve().then(() =>
            options.handler(request as unknown as IncomingMessage, response as unknown as ServerResponse, opening),
          )
          // File readers own descriptors after socket teardown; execution requests settle with the Harness shutdown instead.
          if (
            (request.method === 'GET' || request.method === 'HEAD')
            && /^\/link\/api\/files\/[A-Za-z0-9_-]{22}(?:\/meta)?(?:\?|$)/u.test(request.url ?? '')
          )
            requests.add(handled)
          void handled.finally(() => requests.delete(handled)).catch(() => accepted.socket.destroy())
        },
      )
      h2.on('session', session => {
        sessions.add(session)
        const close = () => session.destroy()
        stream.once('close', close)
        accepted.socket.once('close', close)
        session.once('close', () => {
          sessions.delete(session)
          stream.off('close', close)
          accepted.socket.off('close', close)
        })
      })
      h2.on('sessionError', () => accepted.socket.destroy())
      h2.setTimeout(120_000, () => accepted.socket.destroy())
      h2.emit('connection', accepted.socket)
    } catch {
      stream.destroy()
    }
  }
  const accept = (
    stream: Duplex,
    binding: KnockBinding,
    source: string,
    expectedDeviceId?: string,
    localAddress?: string,
  ): Promise<void> => {
    const operation = acceptOnce(stream, binding, source, expectedDeviceId, localAddress)
    authenticating.add(operation)
    void operation.finally(() => authenticating.delete(operation)).catch(() => {})
    return operation
  }
  async function ensureTransport(): Promise<void> {
    try {
      await validateNativeTlsBinary(options.tlsBinary)
    } catch {
      throw new AppError(503, 'native-component-unavailable', '手机连接组件不可用，请更新并重新构建 Latch 后重试')
    }
  }
  options.devices.onRevoked(id => {
    for (const [socket, state] of sockets) if (state.id === id || state.knockId === id) socket.destroy()
  })
  async function prepareBind(next: NativeHostOptions['bind']) {
    if (closing) throw new AppError(503, 'host-stopping', 'Host 正在停止')
    if (next?.host === bind?.host && (next?.port === bind?.port || (server && next?.port === (server.address() as AddressInfo).port)))
      return { commit() {}, async cancel() {} }
    if (next) await ensureTransport()
    let active = false,
      settled = false
    const prepared = next
      ? createServer((socket: Socket) => {
          if (active) void accept(socket, { path: 'direct' }, socket.remoteAddress ?? '直连', undefined, socket.localAddress)
          else socket.destroy()
        })
      : undefined
    if (prepared && next) {
      staging.add(prepared)
      // Above the gate in `acceptOnce`, which decides who gives way while a QR is live.
      prepared.maxConnections = 96
      try {
        prepared.listen(next.port, canonicalBindAddress(next.host))
        await once(prepared, 'listening', { signal: stopped.signal })
      } catch {
        staging.delete(prepared)
        prepared.close(() => {})
        throw new AppError(409, 'native-listener-unavailable', '无法启用这个地址，请确认网络和端口后重试')
      }
    }
    return {
      commit() {
        if (settled) return
        if (closing) throw new AppError(503, 'host-stopping', 'Host 正在停止')
        settled = true
        active = true
        if (prepared) staging.delete(prepared)
        const previous = server
        server = prepared
        bind = next ? { ...next } : undefined
        if (previous) {
          const done = new Promise<void>(resolve =>
            previous.close(() => {
              retired.delete(previous)
              resolve()
            }),
          )
          retired.set(previous, done)
        }
        if (!next) for (const [stream, state] of sockets) if (!state.relayId) stream.destroy()
      },
      async cancel() {
        if (settled) return
        settled = true
        if (prepared) staging.delete(prepared)
        if (prepared) await new Promise<void>(resolve => prepared.close(() => resolve()))
      },
    }
  }
  if (options.bind) (await prepareBind(options.bind)).commit()
  return {
    origin,
    get enabled(): boolean {
      return Boolean(server || options.relayAvailable?.())
    },
    get port(): number | undefined {
      return server ? (server.address() as AddressInfo).port : undefined
    },
    get direct(): { host: string; port: number } | null {
      return server && bind ? { host: bind.host, port: (server.address() as AddressInfo).port } : null
    },
    prepareBind,
    ensureTransport,
    async invite(input: { inviter?: Device }, actor: Parameters<EnrollmentService['createInvitation']>[1]) {
      if (!server || !bind) throw new AppError(409, 'native-no-lan', '这台 Mac 没有连接 Wi‑Fi 或有线网络。')
      await ensureTransport()
      const host = canonicalBindAddress(bind.host).replace(/^\[|\]$/gu, '')
      if (host.includes('%')) throw new AppError(409, 'native-no-lan', '这台 Mac 没有连接 Wi‑Fi 或有线网络。')
      const lan = [{ address: host, port: (server.address() as AddressInfo).port }]
      const invitation = await options.enrollments.createInvitation({ ...input, listener: 'native-direct', origin }, actor)
      return {
        id: invitation.id,
        payload: formatPairingPayload({
          rootSpki: options.identity.publicKeySpki,
          secret: invitationSecret(invitation.code),
          expiresAt: Math.floor(Date.parse(invitation.expiresAt) / 1000),
          lan,
        }),
        expiresAt: invitation.expiresAt,
      }
    },
    acceptCarrier(stream: Duplex, binding: KnockBinding): Promise<void> {
      if (closing || binding.path !== 'carrier' || (!server && !options.relayAvailable?.())) {
        stream.destroy()
        return Promise.reject(new Error('Native carrier unavailable'))
      }
      return accept(stream, binding, '插件连接')
    },
    acceptRelay(stream: Duplex, binding: KnockBinding, expectedDeviceId?: string): Promise<void> {
      if (binding.path !== 'relay') {
        stream.destroy()
        return Promise.reject(new Error('Invalid native relay binding'))
      }
      return accept(stream, binding, '中继路径', expectedDeviceId)
    },
    closeRelay(relayId: Uint8Array): void {
      const key = hex(relayId)
      for (const [stream, item] of sockets) if (item.relayId === key) stream.destroy()
    },
    async close(): Promise<void> {
      closing = true
      cooldowns.clear()
      stopped.abort()
      for (const stream of sockets.keys()) stream.destroy()
      await Promise.all(
        [...sessions].map(
          session =>
            new Promise<void>(resolve => {
              session.once('close', resolve)
              session.destroy()
            }),
        ),
      )
      await Promise.allSettled([
        ...authenticating,
        ...helpers,
        ...bulkSettlements,
        ...retired.values(),
        ...[...staging, ...(server ? [server] : [])].map(item => new Promise<void>(resolve => item.close(() => resolve()))),
      ])
      await Promise.allSettled(requests)
    },
  }
}
