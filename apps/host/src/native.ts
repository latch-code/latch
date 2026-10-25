import { createServer, type Socket, type Server, type AddressInfo } from 'node:net'
import { createServer as createHttp2Server } from 'node:http2'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { once } from 'node:events'
import { acceptNative, createTransportCertificate } from '@latch/link-client'
import { hex, type KnockBinding } from '@latch/link-wire'
import type { Device, DeviceScope } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import type { DeviceStore, EnrollmentService } from './auth.ts'
import type { HostIdentity } from './identity.ts'
import { canonicalBindAddress, type ListenerContext } from './listeners.ts'

export interface NativeOpening {
  deviceId: string
  pairing: boolean
  listener: ListenerContext
  source: string
  invitationHash?: string
  enrollmentId?: string
  windowHash?: string
}
export interface NativeHostOptions {
  identity: HostIdentity
  devices: DeviceStore
  enrollments: EnrollmentService
  bind?: { host: string; port: number }
  allowUnavailableBind?: boolean
  relayAvailable?(): boolean
  relayInvites?(id: string, expiresAt: string): Promise<unknown[]>
  handler(req: IncomingMessage, res: ServerResponse, opening: NativeOpening): void
}

export async function startNativeHost(options: NativeHostOptions) {
  const origin = `https://native-${options.identity.hostId}.invalid`
  const sockets = new Map<Duplex, { id?: string; knockId?: string; relayId?: string; opened: number }>(),
    replay = new Map<string, number>()
  let certificate = createTransportCertificate(),
    rotatedAt = Date.now(),
    closing = false
  let server: Server | undefined, bind: NativeHostOptions['bind']
  const retired = new Map<Server, Promise<void>>()
  const staging = new Set<Server>(),
    stopped = new AbortController()
  const accept = async (stream: Duplex, binding: KnockBinding, source: string, expectedDeviceId?: string): Promise<void> => {
    if (closing || sockets.size >= 64) {
      stream.destroy()
      return
    }
    const state = { opened: Date.now(), ...(binding.path === 'relay' ? { relayId: hex(binding.relayId!) } : {}) } as {
      id?: string
      knockId?: string
      relayId?: string
      opened: number
    }
    sockets.set(stream, state)
    stream.once('close', () => sockets.delete(stream))
    stream.on('error', () => {})
    try {
      if (Date.now() - rotatedAt > 30 * 60_000) {
        certificate = createTransportCertificate()
        rotatedAt = Date.now()
      }
      const all = [...options.devices.nativeCandidates(), ...options.enrollments.nativeInvitations()]
      const candidates = expectedDeviceId === undefined ? all : all.filter(item => item.id === expectedDeviceId)
      const accepted = await acceptNative(stream, binding, {
        identity: options.identity,
        certificate,
        devices: () => candidates,
        replay,
        onKnock(id) {
          const related = [...sockets].filter(([socket, item]) => socket !== stream && !socket.destroyed && item.knockId === id)
          const pending = related.filter(([, item]) => !item.id).sort((a, b) => a[1].opened - b[1].opened)
          let total = related.length
          while (pending.length >= 2 || total >= 4) {
            const oldest = pending.shift()
            if (!oldest) throw new Error('Native device connection limit')
            oldest[0].destroy()
            total--
          }
          state.knockId = id
        },
        isActive: id => [...options.devices.nativeCandidates(), ...options.enrollments.nativeInvitations()].some(item => item.id === id),
      })
      const candidate = candidates.find(item => item.id === accepted.deviceId)!
      const opening: NativeOpening = {
        deviceId: accepted.deviceId,
        pairing: accepted.pairing,
        source,
        listener: { listener: binding.path === 'direct' ? 'native-direct' : 'native-relay', origin },
        ...(candidate.kind === 'pairing'
          ? {
              invitationHash: Buffer.from(candidate.knockKey).toString('hex'),
              ...('enrollmentId' in candidate && candidate.enrollmentId ? { enrollmentId: candidate.enrollmentId as string } : {}),
            }
          : {}),
      }
      state.id = accepted.deviceId
      const h2 = createHttp2Server(
        { maxSessionMemory: 1, settings: { maxConcurrentStreams: 8, maxHeaderListSize: 8192, initialWindowSize: 32_768 } },
        (request, response) => {
          options.handler(request as unknown as IncomingMessage, response as unknown as ServerResponse, opening)
        },
      )
      h2.on('sessionError', () => accepted.socket.destroy())
      h2.setTimeout(120_000, () => accepted.socket.destroy())
      h2.emit('connection', accepted.socket)
    } catch {
      stream.destroy()
    }
  }
  options.devices.onRevoked(id => {
    for (const [socket, state] of sockets) if (state.id === id) socket.destroy()
  })
  async function prepareBind(next: NativeHostOptions['bind']) {
    if (closing) throw new AppError(503, 'host-stopping', 'Host 正在停止')
    if (next?.host === bind?.host && next?.port === bind?.port) return { commit() {}, async cancel() {} }
    let active = false,
      settled = false
    const prepared = next
      ? createServer((socket: Socket) => {
          if (active) void accept(socket, { path: 'direct' }, socket.remoteAddress ?? '直连')
          else socket.destroy()
        })
      : undefined
    if (prepared && next) {
      staging.add(prepared)
      prepared.maxConnections = 64
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
  if (options.bind) {
    try {
      ;(await prepareBind(options.bind)).commit()
    } catch (error) {
      if (!options.allowUnavailableBind) throw error
    }
  }
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
    async invite(input: { inviter?: Device; scopes?: DeviceScope[] }, actor: Parameters<EnrollmentService['createInvitation']>[1]) {
      if (!server && !options.relayAvailable?.()) throw new AppError(409, 'native-not-configured', '尚未配置原生设备连接入口')
      const invitation = await options.enrollments.createInvitation(
        { ...input, listener: server ? 'native-direct' : 'native-relay', origin },
        actor,
      )
      const payload = {
        v: 1,
        rootSpki: options.identity.publicKeySpki.toString('base64url'),
        invitation: invitation.code,
        direct: server && bind ? [{ host: canonicalBindAddress(bind.host), port: (server.address() as AddressInfo).port }] : [],
        relays: options.relayInvites ? await options.relayInvites(invitation.id, invitation.expiresAt) : [],
        expiresAt: invitation.expiresAt,
      }
      return {
        id: invitation.id,
        payload: `LATCHPAIR1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`,
        expiresAt: invitation.expiresAt,
        scopes: invitation.scopes,
      }
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
      stopped.abort()
      for (const stream of sockets.keys()) stream.destroy()
      await Promise.allSettled([
        ...retired.values(),
        ...[...staging, ...(server ? [server] : [])].map(item => new Promise<void>(resolve => item.close(() => resolve()))),
      ])
    },
  }
}
