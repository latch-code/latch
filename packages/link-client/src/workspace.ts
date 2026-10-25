import { createPublicKey, randomBytes, X509Certificate } from 'node:crypto'
import { connect, isIP } from 'node:net'
import { once } from 'node:events'
import { z } from 'zod'
import { decodePass, equal, nativeRecoverySecret, nativeVerificationText, routeId } from '@latch/link-wire'
import { nodeCrypto } from './crypto.ts'
import { NativeHttpClient, openNativeHttp } from './http2.ts'
import { PathManager, type PathCandidate } from './paths.ts'
import { connectRelayTunnel, type RelayEndpoint } from './tunnel.ts'
import { renewDeviceCertificate } from './certificate.ts'
import { NativeReconnect, type NativeReconnectOptions } from './reconnect.ts'

export interface NativeIdentity {
  hostId: string
  deviceId: string
  rootSpki: Uint8Array
  knockKey: Uint8Array
  certificate: string
  key: string
}
export interface NativeCheckpoint {
  instanceId: string
  revision: number
  value: unknown
}
export interface NativeEvent {
  type: 'refresh' | 'tasks-invalidated' | 'task-state' | 'host-state'
  value: Record<string, unknown>
}
export type NativePath =
  | { id: string; kind: 'direct'; address: string; port: number }
  | { id: string; kind: 'relay'; endpoint: RelayEndpoint; pass: Uint8Array; holderKey: Uint8Array }
interface WindowReceipt {
  appOpenId: string
  windowToken: string
  verifiedUntil: number
}
type HttpResponse = Awaited<ReturnType<NativeHttpClient['request']>>
function object(value: unknown): Record<string, unknown> {
  return parse(z.record(z.string(), z.unknown()), value)
}
function parse<Output>(schema: z.ZodType<Output>, value: unknown): Output {
  const result = schema.safeParse(value)
  if (!result.success) throw new Error('Invalid native Host response')
  return result.data
}
function receipt(response: HttpResponse, appOpenId: string): WindowReceipt {
  if (response.status !== 200) throw new Error('Native verification not accepted')
  const value = parse(
    z.strictObject({ windowToken: z.string().regex(/^lnw1\.[A-Za-z0-9_-]{43}$/u), verifiedUntil: z.iso.datetime() }),
    response.body,
  )
  const verifiedUntil = Date.parse(value.verifiedUntil)
  if (!Number.isFinite(verifiedUntil)) throw new Error('Invalid native Host response')
  return { appOpenId, windowToken: value.windowToken, verifiedUntil }
}
function connectionOptions(identity: NativeIdentity): NativeIdentity {
  try {
    const certificate = new X509Certificate(identity.certificate)
    if (
      !certificate.publicKey
        .export({ type: 'spki', format: 'der' })
        .equals(createPublicKey(identity.key).export({ type: 'spki', format: 'der' }))
    )
      throw new Error('Native connection key mismatch')
    return {
      ...identity,
      rootSpki: Buffer.from(identity.rootSpki),
      knockKey: Buffer.from(identity.knockKey),
      certificate:
        Date.parse(certificate.validTo) - Date.now() < 300_000 || Date.parse(certificate.validFrom) > Date.now()
          ? renewDeviceCertificate(identity.key).cert
          : identity.certificate,
    }
  } catch {
    throw new Error('Invalid native connection identity')
  }
}

/** Only addresses approved for the current network should be supplied; this function never resolves a hostname. */
export function nativeDirectCandidate(
  id: string,
  address: string,
  port: number,
  identity: NativeIdentity,
): PathCandidate<NativeHttpClient> {
  if (!isIP(address) || !Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError('Invalid native direct endpoint')
  const options = connectionOptions(identity)
  return {
    id,
    kind: 'direct',
    async connect(signal) {
      const raw = connect({ host: address, port })
      raw.on('error', () => {})
      const abort = () => raw.destroy()
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      try {
        const client = await openNativeHttp(raw, { path: 'direct' }, options)
        if (signal.aborted) {
          client.close()
          throw new Error('Native path cancelled')
        }
        return client
      } catch {
        raw.destroy()
        throw new Error('Native path setup failed')
      } finally {
        signal.removeEventListener('abort', abort)
      }
    },
  }
}

export function nativeRelayCandidate(
  path: Extract<NativePath, { kind: 'relay' }>,
  identity: NativeIdentity,
): PathCandidate<NativeHttpClient> {
  const pass = decodePass(path.pass)
  if (!equal(pass.relayId, path.endpoint.relayId)) throw new RangeError('Native relay identity mismatch')
  const options = connectionOptions(identity)
  return {
    id: path.id,
    kind: 'relay',
    async connect(signal) {
      const stream = await connectRelayTunnel({ ...path.endpoint, pass: path.pass, holderKey: path.holderKey, signal })
      const abort = () => stream.destroy()
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      try {
        const client = await openNativeHttp(
          stream,
          { path: 'relay', relayId: pass.relayId, routeId: await routeId(nodeCrypto, pass.routePub) },
          options,
        )
        if (signal.aborted) {
          client.close()
          throw new Error('Native path cancelled')
        }
        return client
      } catch {
        stream.destroy()
        throw new Error('Native path setup failed')
      } finally {
        signal.removeEventListener('abort', abort)
      }
    },
  }
}

/** A single App opening owns path installation, checkpoint ordering and in-memory verification receipts. */
export class NativeWorkspace {
  private readonly paths: PathManager<NativeHttpClient>
  private readonly hostId: string
  private readonly deviceId: string
  private readonly identity: NativeIdentity
  private readonly appOpenId: string
  private checkpointValue?: NativeCheckpoint
  private window?: WindowReceipt
  private windowClient?: NativeHttpClient
  private proofReceipt?: string
  private verifying?: Promise<'verified' | 'unknown'>
  private stopped = false
  private reconnecting?: NativeReconnect
  constructor(
    identity: NativeIdentity,
    options: {
      appOpenId?: string
      path?: ConstructorParameters<typeof PathManager<NativeHttpClient>>[0]
    } = {},
  ) {
    this.appOpenId = options.appOpenId ?? randomBytes(16).toString('base64url')
    // The shared statement validator also bounds all identity components before any network request.
    nativeVerificationText(identity.hostId, identity.deviceId, 'validation-nonce', 0, this.appOpenId)
    this.hostId = identity.hostId
    this.deviceId = identity.deviceId
    this.identity = { ...identity, rootSpki: Buffer.from(identity.rootSpki), knockKey: Buffer.from(identity.knockKey) }
    this.paths = new PathManager(options.path)
  }
  checkpoint(): NativeCheckpoint | undefined {
    return this.checkpointValue
  }
  bodyVerifiedUntil(): number {
    return this.windowClient === this.paths.current()?.connection ? (this.window?.verifiedUntil ?? 0) : 0
  }
  networkChanged(): void {
    this.paths.networkChanged()
    this.reconnecting?.wake()
  }
  reconnect(candidates: () => readonly NativePath[], options: NativeReconnectOptions = {}): NativeReconnect {
    if (this.stopped) throw new Error('Native workspace closed')
    if (this.reconnecting && !this.reconnecting.isStopped()) return this.reconnecting
    const owner = new NativeReconnect(
      {
        migrate: () => this.migrate(candidates()),
        current: () => this.paths.current()?.connection,
        cancelPending: () => this.paths.cancelPending(),
      },
      options,
    )
    this.reconnecting = owner
    void owner.done
      .finally(() => {
        if (this.reconnecting === owner) this.reconnecting = undefined
      })
      .catch(() => {})
    return owner
  }
  close(): void {
    this.stopped = true
    this.reconnecting?.stop()
    this.paths.close()
    this.window = undefined
    this.windowClient = undefined
    this.proofReceipt = undefined
    this.checkpointValue = undefined
  }
  private client(): NativeHttpClient {
    const current = this.paths.current()
    if (this.stopped || !current) throw new Error('Native workspace disconnected')
    return current.connection
  }
  private parseCheckpoint(response: HttpResponse): NativeCheckpoint {
    if (response.status !== 200) throw new Error('Native snapshot unavailable')
    const value = parse(
      z.looseObject({
        instanceId: z.string().min(1).max(128),
        revision: z.int().nonnegative(),
        device: z.looseObject({ id: z.literal(this.deviceId) }),
      }),
      response.body,
    )
    const checkpoint = { instanceId: value.instanceId, revision: value.revision, value: response.body }
    if (this.checkpointValue?.instanceId === checkpoint.instanceId && this.checkpointValue.revision > checkpoint.revision)
      throw new Error('Obsolete native Host checkpoint')
    return checkpoint
  }
  private async recover(client: NativeHttpClient, proof: string): Promise<WindowReceipt | undefined> {
    const response = await client.request('POST', '/link/api/native/verification/recover', {
      appOpenId: this.appOpenId,
      proofReceipt: proof,
    })
    return response.status === 403 ? undefined : receipt(response, this.appOpenId)
  }
  async migrate(paths: readonly NativePath[]): Promise<'connected' | 'unchanged' | 'superseded'> {
    if (paths.length > 8) throw new RangeError('Invalid native path count')
    const candidates = paths.map(path =>
      path.kind === 'direct'
        ? nativeDirectCandidate(path.id, path.address, path.port, this.identity)
        : nativeRelayCandidate(path, this.identity),
    )
    const savedWindow = this.window,
      proof = this.proofReceipt
    const installed = await this.paths.migrate(candidates, async client => {
      let restored: WindowReceipt | undefined
      if (savedWindow) {
        const response = await client.request('POST', '/link/api/native/verification/resume', {
          appOpenId: this.appOpenId,
          windowToken: savedWindow.windowToken,
        })
        if (response.status === 200) {
          const value = object(response.body)
          if (value.verifiedUntil !== new Date(savedWindow.verifiedUntil).toISOString()) throw new Error('Native window deadline changed')
          restored = savedWindow
        } else if (response.status !== 403) throw new Error('Native window resume failed')
      } else if (proof) restored = await this.recover(client, proof)
      return { checkpoint: this.parseCheckpoint(await client.request('GET', '/link/api/snapshot')), restored }
    })
    if (installed.kind !== 'installed') return installed.kind
    if (!this.paths.isCurrent(installed)) return 'superseded'
    // A refresh on the old path may have completed while the new path was being prepared.
    const next = installed.snapshot.checkpoint
    if (this.checkpointValue?.instanceId !== next.instanceId || this.checkpointValue.revision <= next.revision) this.checkpointValue = next
    if (this.window === savedWindow && this.proofReceipt === proof) {
      this.window = installed.snapshot.restored
      this.windowClient = this.window ? installed.connection : undefined
    }
    return 'connected'
  }
  async refresh(): Promise<boolean> {
    const client = this.client(),
      response = await client.request('GET', '/link/api/snapshot')
    if (this.paths.current()?.connection !== client) return false
    this.checkpointValue = this.parseCheckpoint(response)
    return true
  }
  request(...input: Parameters<NativeHttpClient['request']>): ReturnType<NativeHttpClient['request']> {
    // Writes are never retried here. The caller retains the original requestId until Host settlement.
    return this.client().request(...input)
  }
  async *events(sessionId?: string): AsyncGenerator<NativeEvent> {
    if (sessionId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/u.test(sessionId)) throw new RangeError('Invalid native session id')
    const client = this.client(),
      stream = client.events(`/link/api/events${sessionId ? `?sessionId=${sessionId}` : ''}`)
    try {
      const [headers] = await once(stream, 'response', { signal: AbortSignal.timeout(15_000) })
      if (headers[':status'] !== 200 || !String(headers['content-type']).startsWith('text/event-stream'))
        throw new Error('Native event stream unavailable')
      const decoder = new TextDecoder('utf-8', { fatal: true })
      let pending = ''
      for await (const chunk of stream) {
        if (this.paths.current()?.connection !== client) return
        pending += decoder.decode(chunk as Uint8Array, { stream: true })
        if (Buffer.byteLength(pending) > 2_097_152) throw new Error('Native event buffer limit')
        for (;;) {
          const boundary = /\r?\n\r?\n/u.exec(pending)
          if (!boundary) break
          const frame = pending.slice(0, boundary.index)
          pending = pending.slice(boundary.index + boundary[0].length)
          if (Buffer.byteLength(frame) > 1_048_576) throw new Error('Native event size limit')
          const lines = frame.split(/\r?\n/u)
          if (lines.length > 128) throw new Error('Native event field limit')
          const event = lines
            .find(line => line.startsWith('event:'))
            ?.slice(6)
            .trim()
          if (!event || !['refresh', 'tasks-invalidated', 'task-state', 'host-state'].includes(event)) continue
          const value = object(
            JSON.parse(
              lines
                .filter(line => line.startsWith('data:'))
                .map(line => line.slice(5).trimStart())
                .join('\n'),
            ) as unknown,
          )
          if (value.type !== event || value.instanceId !== this.checkpointValue?.instanceId) continue
          if (
            event !== 'host-state'
            && (typeof value.revision !== 'number'
              || !Number.isSafeInteger(value.revision)
              || value.revision < (this.checkpointValue?.revision ?? 0))
          )
            continue
          if (event === 'task-state' && value.sessionId !== sessionId) continue
          if (this.paths.current()?.connection !== client) return
          yield { type: event as NativeEvent['type'], value }
        }
      }
      decoder.decode()
    } catch {
      if (this.paths.current()?.connection === client) throw new Error('Native event stream ended; resume from a Host checkpoint')
    } finally {
      stream.close()
    }
  }
  verify(signStatement: (statement: string) => Promise<Uint8Array>): Promise<'verified' | 'unknown'> {
    if (this.verifying) return this.verifying
    const pending = this.verifyOnce(signStatement)
    this.verifying = pending
    void pending
      .finally(() => {
        if (this.verifying === pending) this.verifying = undefined
      })
      .catch(() => {})
    return pending
  }
  private async verifyOnce(signStatement: (statement: string) => Promise<Uint8Array>): Promise<'verified' | 'unknown'> {
    const client = this.client()
    // A pending proof is retried as a recovery operation, without asking the platform to authenticate again.
    if (this.proofReceipt) {
      if (this.windowClient === client && this.window && this.window.verifiedUntil > Date.now()) return 'verified'
      const recovered = await this.recover(client, this.proofReceipt)
      if (this.stopped) throw new Error('Native workspace closed')
      if (recovered) {
        this.window = recovered
        this.windowClient = client
        return 'verified'
      }
      return 'unknown'
    }
    const response = await client.request('POST', '/link/api/native/verification/challenge', { appOpenId: this.appOpenId })
    if (response.status !== 200) throw new Error('Native verification challenge unavailable')
    const challenge = parse(
      z.strictObject({
        nonce: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/u),
        expiresAt: z.int().nonnegative(),
        appOpenId: z.literal(this.appOpenId),
        generation: z.int().positive().optional(),
      }),
      response.body,
    )
    if (challenge.expiresAt < Date.now() || challenge.expiresAt > Date.now() + 65_000)
      throw new Error('Native verification challenge outside its time window')
    const statement = nativeVerificationText(this.hostId, this.deviceId, challenge.nonce, challenge.expiresAt, this.appOpenId)
    const signature = await signStatement(statement)
    const proof = `lnp1.${Buffer.from(await nativeRecoverySecret(nodeCrypto, statement, signature)).toString('base64url')}`
    if (this.stopped) throw new Error('Native workspace closed')
    this.proofReceipt = proof
    this.window = undefined
    this.windowClient = undefined
    let verified: WindowReceipt
    try {
      verified = receipt(
        await client.request('POST', '/link/api/native/verification', { signature: Buffer.from(signature).toString('base64url') }),
        this.appOpenId,
      )
    } catch {
      // Transport failure and an explicit rejection both keep the original proof until an owner chooses a fresh opening.
      return 'unknown'
    }
    if (this.stopped) throw new Error('Native workspace closed')
    this.window = verified
    this.windowClient = client
    return 'verified'
  }
}
