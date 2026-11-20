import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { Device, HostFeatures, NativePairingStatus } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { sha256Hex } from '@latch/core/node-kit'
import {
  nativeRecoverySecret,
  nativeRevocationInput,
  nativeVerificationText,
  nativeWindowSecret,
  type NativeLanAddress,
} from '@latch/link-wire'
import { nodeCrypto } from '@latch/link-client'
import { authFailure } from '../access.ts'
import { parseP256Spki, randomNonce, verifyP256 } from '../crypto.ts'
import { createRelayEgress, type LookupFunction } from '../egress.ts'
import { json, jsonBody, KIB, optionalJsonBody, safeDecode } from '../http-util.ts'
import type { HostIdentity } from '../identity.ts'
import type { ListenerContext } from '../listeners.ts'
import { NATIVE_BULK, startNativeHost, type NativeOpening } from '../native.ts'
import { NativeNetwork } from '../native-network.ts'
import { MacNetworkBackend, type NativeNetworkBackend } from '../native-network-backend.ts'
import { NativeNetworks } from '../native-networks.ts'
import { NativeSettings } from '../native-settings.ts'
import { NativePluginTransports } from '../native-transports.ts'
import type { HostAddressBooks } from '../relay/address-book.ts'
import { HostRelayController } from '../relay/controller.ts'
import type { HostRelayDirectory } from '../relay/directory.ts'
import { OFFICIAL_RELAYS, type OfficialRelay } from '../relay/official.ts'
import { relayKeyHash, relayNodeFields, relayProfileInput, relayUsable, type RelayProfiles } from '../relay/profiles.ts'
import { listRelayFiles, relayFileByName } from '../relay/relay-files.ts'
import { signatureSchema } from './devices.ts'
import { type Caller, type CallerRequest, type RouteContext, type RouteModule, type RouteRequest } from './registry.ts'

/** What the native routes need from the Host beyond the route context. */
export interface NativeRouteDeps {
  /** The Host's own options for the native entry, its network watcher, private relay roots and outbound lookups. */
  options: {
    native?: { host: string; port: number }
    nativeNetwork?: false | (() => Promise<NativeNetworkBackend>)
    nativeRelayCa?: string | Buffer
    egressLookup?: LookupFunction
    nativeNearby?: (opening: NativeOpening, gatewayHash: Uint8Array) => boolean | Promise<boolean>
    officialRelays?: readonly OfficialRelay[]
    /** HOME for the person's relay files (~/.latch/relays); `os.homedir()` when absent. */
    relayFilesHome?: string
  }
  identity: HostIdentity
  /** Process-level outbound entries, allowed beside the policy's. */
  egressExtra: readonly string[]
  relayProfiles: RelayProfiles
  relayDirectory: HostRelayDirectory
  addressBooks: HostAddressBooks
  revokedDiscoveryHash: () => string
  synchronizeDiscovery: () => Promise<void>
  /** Reuses read authorization before a relay connection can be narrowed to one large opaque file. */
  authorizeBulk: (caller: Caller, handle: string, etag: string) => Promise<{ size: number }>
}

/** What server.ts hands the native entry once its listeners are up. */
export interface NativeStart {
  handle: (req: IncomingMessage, res: ServerResponse, listener: ListenerContext) => Promise<void>
  fail: (res: ServerResponse, error: unknown, listener: ListenerContext) => void
  /** Registers what to close if the Host fails to start after this point. */
  cleanup: (dispose: () => void | Promise<void>) => void
}

export interface NativeRoutes extends RouteModule {
  /** The native connection a request came over. */
  opening(req: IncomingMessage): NativeOpening | undefined
  /** Until when the opening's App-open verification lets session bodies through; 0 without a current window. */
  verifiedUntil(opening: NativeOpening | undefined): number
  /** A device as clients see it, with its native state and verification window. */
  deviceView(device: Device, opening?: NativeOpening): Device
  enabled(): boolean
  port(): number | undefined
  /** The LAN addresses address books offer phones. */
  lan(): readonly NativeLanAddress[]
  /** The proximity gate for a phone's pairing request, on the socket it came over. */
  pairingNearby(opening: NativeOpening, gatewayHash: Uint8Array): Promise<string | false>
  /** Marks a network known, once a phone proven on it has paired. */
  rememberNetwork(networkHash: string): void
  /** Makes the network watcher look again, after a revocation or a discovery-key rotation. */
  invalidate(): void
  /** Lets the relay controller follow a change the Host announced. */
  reconcile(): void
  /** The region of the nearest connected official node, for the address book's hint. */
  nearestRelayRegion(): string | undefined
  /** Starts the native entry, plugin transports, relay controller, network watcher and settings. */
  start(host: NativeStart): Promise<void>
  /** Stops them, closing the relay directory between the plugin transports and the relay controller. */
  close(): Promise<void>
}

/**
 * The phone connection: native openings and their verification windows, revocation notices, bulk transfers, address
 * books, the phone-access lifecycle and pairing QRs, and the relay wiring.
 */
export function createNativeRoutes(context: RouteContext, deps: NativeRouteDeps): NativeRoutes {
  const { hostId, dataDir, codeRoot, now, audit, policy, devices, enrollments, plugins: registry, closing, refresh, actorOf } = context
  const { requireLocal, recheck } = context
  const requireScope: RouteContext['requireScope'] = context.requireScope
  const { options, identity, egressExtra, relayProfiles, relayDirectory, addressBooks, revokedDiscoveryHash, authorizeBulk } = deps
  const synchronizeNativeDiscovery = deps.synchronizeDiscovery

  let nativeNetwork: NativeNetwork | undefined
  let nativeHost: Awaited<ReturnType<typeof startNativeHost>> | undefined
  let nativePluginTransports: NativePluginTransports | undefined
  let relayController: HostRelayController | undefined
  let nativeSettings: NativeSettings | undefined
  const nativeRequests = new WeakMap<IncomingMessage, NativeOpening>()
  const nativeChallenges = new WeakMap<NativeOpening, { nonce: string; appOpenId: string; expiresAt: number; generation: number }>()
  const nativeGenerations = new Map<string, number>()
  const nativeWindows = new Map<
    string,
    { deviceId: string; appOpenId: string; expiresAt: number; generation: number; recoveryHash: string }
  >()
  const nativeWindowIssuer = randomBytes(32)
  let nativeGeneration = 0
  devices.onRevoked(id => {
    nativeGenerations.delete(id)
    for (const [hash, window] of nativeWindows) if (window.deviceId === id) nativeWindows.delete(hash)
  })
  function nativeVerifiedUntil(opening: NativeOpening | undefined): number {
    const window = opening?.windowHash ? nativeWindows.get(opening.windowHash) : undefined
    return window && window.deviceId === opening!.deviceId && window.generation === nativeGenerations.get(window.deviceId)
      ? window.expiresAt
      : 0
  }

  function nativeDeviceView(device: Device, opening?: NativeOpening): Device {
    const state = devices.nativeStatus(device.id)
    if (!state) return device
    const expiresAt = opening
      ? nativeVerifiedUntil(opening)
      : Math.max(
          0,
          ...[...nativeWindows.values()]
            .filter(
              window => window.deviceId === device.id && window.generation === nativeGenerations.get(device.id) && window.expiresAt > now(),
            )
            .map(window => window.expiresAt),
        )
    return { ...device, native: { ...state, ...(expiresAt ? { bodyVerifiedUntil: new Date(expiresAt).toISOString() } : {}) } }
  }

  /**
   * Before any route: a bulk connection carries only its file, a revoked phone reads only its revocation, and a pairing
   * opening only enrolls.
   */
  async function screen({ res, req, connection, opening: nativeOpening, path, method }: RouteRequest): Promise<boolean> {
    if (nativeOpening && !nativeOpening.pairing) {
      const revocation =
        (path === '/link/api/native/revocation' && method === 'GET') || (path === '/link/api/native/revocation/ack' && method === 'POST')
      const resume = path === '/link/api/native/verification/resume' && method === 'POST'
      if (nativeOpening.bulk) {
        const bulk = nativeOpening.bulk
        const file = path === `/link/api/files/${bulk.handle}` && (method === 'GET' || method === 'HEAD')
        const range = typeof req.headers.range === 'string' ? /^bytes=(\d+)-(\d+)$/u.exec(req.headers.range) : undefined
        if (
          !revocation
          && !resume
          && !(
            file
            && req.headers['if-range'] === undefined
            && req.headers['if-match'] === bulk.etag
            && (method === 'HEAD'
              || (range
                && Number.isSafeInteger(Number(range[1]))
                && Number.isSafeInteger(Number(range[2]))
                && Number(range[2]) >= Number(range[1])
                && Number(range[2]) - Number(range[1]) < 1_048_576))
          )
        ) {
          await nativeOpening.close?.()
          return true
        }
        if (
          !revocation
          && (bulk.windowHash !== nativeOpening.windowHash || bulk.expiresAt <= now() || nativeVerifiedUntil(nativeOpening) <= now())
        ) {
          await nativeOpening.close?.()
          return true
        }
      } else if (!revocation && !resume && !(path === '/link/api/native/bulk' && method === 'POST')) {
        // A business request permanently prevents repurposing this connection, even when it later fails.
        nativeOpening.controlUsed = true
      }
    }
    if (nativeOpening && !nativeOpening.pairing) {
      const revoked = devices.nativeRevocations().find(item => item.id === nativeOpening.deviceId)
      if (revoked) {
        const statement = nativeRevocationInput(hostId, revoked.id, revoked.revokedAt),
          hash = sha256Hex(statement)
        if (path === '/link/api/native/revocation' && method === 'GET') {
          json(res, {
            revocation: {
              hostId,
              deviceId: revoked.id,
              revokedAt: revoked.revokedAt,
              signature: Buffer.from(identity.sign(statement)).toString('base64url'),
            },
          })
          return true
        }
        if (path === '/link/api/native/revocation/ack' && method === 'POST') {
          const input = z
            .strictObject({ requestId: z.uuid(), tombstoneHash: z.string().regex(/^[a-f0-9]{64}$/u) })
            .parse(await jsonBody(req))
          if (input.tombstoneHash !== hash) throw authFailure('unauthorized')
          await devices.acknowledgeNativeRevocation(revoked.id, revoked.revokedAt)
          json(res, { acknowledged: true })
          return true
        }
        throw authFailure('device-revoked')
      }
      if (path === '/link/api/native/revocation' && method === 'GET') {
        if (!devices.authenticateNative(nativeOpening.deviceId).ok) throw authFailure('unauthorized')
        json(res, { revocation: null })
        return true
      }
    }
    if (path === '/link/api/native/pairing' && method === 'GET') {
      if (!nativeOpening?.pairing) throw authFailure('unauthorized')
      json(res, { enrollment: nativeOpening.enrollmentId ? enrollments.nativeStatus(nativeOpening.enrollmentId, connection) : null })
      return true
    }
    if (
      nativeOpening?.pairing
      && !(
        path === '/link/api/enrollment-info'
        || (path === '/link/api/enrollments' && method === 'POST')
        || (nativeOpening.enrollmentId && path.startsWith(`/link/api/enrollments/${nativeOpening.enrollmentId}`))
      )
    )
      throw authFailure('unauthorized')
    return false
  }

  async function unauthenticated({ opening: nativeOpening, path }: RouteRequest): Promise<boolean> {
    if (nativeOpening && path.startsWith('/link/api/credentials/'))
      throw new AppError(403, 'native-credential-route', '原生身份不使用浏览器凭据续期')
    return false
  }

  /** After authentication: bulk transfers, address books, proximity, the verification window and its gate. */
  async function authenticated({ req, res, listener, opening: nativeOpening, caller, path, method }: CallerRequest): Promise<boolean> {
    if (path === '/link/api/native/bulk' && method === 'POST') {
      if (!nativeOpening || nativeOpening.pairing) throw authFailure('unauthorized')
      try {
        if (nativeOpening.listener.listener !== 'native-relay' || nativeOpening.controlUsed || nativeOpening.bulkAttempted)
          throw new AppError(409, 'native-bulk-unavailable', '请重新打开这个文件')
        nativeOpening.bulkAttempted = true
        requireScope(caller, 'view')
        recheck(caller, 'view')
        const windowHash = nativeOpening.windowHash
        const expiresAt = Math.min(nativeVerifiedUntil(nativeOpening), now() + NATIVE_BULK.maximumMs)
        if (!windowHash || expiresAt <= now()) throw new AppError(403, 'native-verification-required', '请先在手机上完成身份验证')
        const input = z
          .strictObject({
            handle: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
            etag: z.string().regex(/^"[a-f0-9]{32}"$/u),
            requestId: z.uuid(),
          })
          .parse(await jsonBody(req))
        const { size } = await authorizeBulk(caller, input.handle, input.etag)
        recheck(caller, 'view')
        if (nativeOpening.controlUsed || nativeOpening.windowHash !== windowHash || expiresAt <= now())
          throw new AppError(409, 'native-bulk-unavailable', '请重新打开这个文件')
        if (!nativeOpening.activateBulk) throw new AppError(503, 'native-bulk-unavailable', '文件连接暂时不可用')
        nativeOpening.activateBulk(expiresAt - now())
        nativeOpening.bulk = { ...input, windowHash, expiresAt }
        json(res, { size, expiresAt: new Date(expiresAt).toISOString() })
        return true
      } catch {
        await nativeOpening.close?.()
        return true
      }
    }
    if (path === '/link/api/native/address-book' && method === 'POST') {
      if (!nativeOpening || nativeOpening.pairing) throw authFailure('unauthorized')
      requireScope(caller, 'view')
      recheck(caller, 'view')
      z.strictObject({}).parse(await optionalJsonBody(req))
      const addressBook = await addressBooks.issue(caller.device!.id)
      recheck(caller, 'view')
      json(res, { addressBook })
      return true
    }
    if (nativeOpening && !nativeOpening.pairing) {
      if (path === '/link/api/native/proximity' && method === 'POST') {
        requireScope(caller, 'view')
        recheck(caller, 'view')
        const input = z.strictObject({ gatewayHash: z.string().regex(/^[a-f0-9]{64}$/u) }).parse(await jsonBody(req))
        const nearby =
          (await nativeNetwork?.nearby(nativeOpening, Buffer.from(input.gatewayHash, 'hex'), () => recheck(caller, 'view'))) ?? false
        recheck(caller, 'view')
        json(res, { nearby })
        return true
      }
      if (path === '/link/api/native/verification/challenge' && method === 'POST') {
        const input = z
          .object({ appOpenId: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/u) })
          .strict()
          .parse(await jsonBody(req))
        if (nativeGeneration >= Number.MAX_SAFE_INTEGER) throw new AppError(503, 'native-generation-exhausted', '请重启 Host 后重新验证')
        const challenge = { nonce: randomNonce(), appOpenId: input.appOpenId, expiresAt: now() + 60_000, generation: ++nativeGeneration }
        nativeGenerations.set(nativeOpening.deviceId, challenge.generation)
        nativeChallenges.set(nativeOpening, challenge)
        json(res, challenge)
        return true
      }
      if (path === '/link/api/native/verification' && method === 'POST') {
        const input = signatureSchema.parse(await jsonBody(req)),
          challenge = nativeChallenges.get(nativeOpening)
        nativeChallenges.delete(nativeOpening)
        const key = devices.nativeVerificationKey(nativeOpening.deviceId)
        if (
          !challenge
          || challenge.expiresAt < now()
          || challenge.generation !== nativeGenerations.get(nativeOpening.deviceId)
          || !key
          || !verifyP256(
            parseP256Spki(key).key,
            nativeVerificationText(hostId, nativeOpening.deviceId, challenge.nonce, challenge.expiresAt, challenge.appOpenId),
            input.signature,
          )
        )
          throw new AppError(403, 'native-verification-invalid', '手机身份验证已过期或签名无效')
        const verifiedUntil = await devices.markNativeVerified(nativeOpening.deviceId, listener.listener)
        if (!devices.authenticateNative(nativeOpening.deviceId).ok) throw authFailure('device-revoked')
        if (challenge.generation !== nativeGenerations.get(nativeOpening.deviceId))
          throw new AppError(409, 'native-verification-superseded', '此验证已被更新的 App 打开代次替换')
        for (const [hash, window] of nativeWindows)
          if (window.expiresAt <= now() || window.deviceId === nativeOpening.deviceId) nativeWindows.delete(hash)
        const statement = nativeVerificationText(hostId, nativeOpening.deviceId, challenge.nonce, challenge.expiresAt, challenge.appOpenId)
        const recoveryToken = `lnp1.${Buffer.from(await nativeRecoverySecret(nodeCrypto, statement, Buffer.from(input.signature, 'base64url'))).toString('base64url')}`
        const recoveryHash = sha256Hex(recoveryToken)
        const windowToken = `lnw1.${Buffer.from(await nativeWindowSecret(nodeCrypto, nativeWindowIssuer, Buffer.from(recoveryHash, 'hex'))).toString('base64url')}`
        // Even platform crypto adapters may yield; never install a window after a newer opening or revocation.
        if (
          !devices.authenticateNative(nativeOpening.deviceId).ok
          || challenge.generation !== nativeGenerations.get(nativeOpening.deviceId)
        )
          throw new AppError(409, 'native-verification-superseded', '此验证已被更新的 App 打开代次替换')
        const hash = sha256Hex(windowToken)
        nativeWindows.set(hash, {
          deviceId: nativeOpening.deviceId,
          appOpenId: challenge.appOpenId,
          expiresAt: verifiedUntil,
          generation: challenge.generation,
          recoveryHash,
        })
        nativeOpening.windowHash = hash
        json(res, { verifiedUntil: new Date(verifiedUntil).toISOString(), windowToken })
        return true
      }
      if (path === '/link/api/native/verification/recover' && method === 'POST') {
        const input = z
          .strictObject({
            appOpenId: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/u),
            proofReceipt: z.string().regex(/^lnp1\.[A-Za-z0-9_-]{43}$/u),
          })
          .parse(await jsonBody(req))
        const recoveryHash = sha256Hex(input.proofReceipt)
        const found = [...nativeWindows.entries()].find(
          ([, window]) =>
            window.deviceId === nativeOpening.deviceId && window.recoveryHash === recoveryHash && window.appOpenId === input.appOpenId,
        )
        if (!found || found[1].expiresAt <= now() || found[1].generation !== nativeGenerations.get(nativeOpening.deviceId))
          throw new AppError(403, 'native-verification-invalid', '验证窗口已失效，请重新验证')
        const [hash, window] = found
        const windowToken = `lnw1.${Buffer.from(await nativeWindowSecret(nodeCrypto, nativeWindowIssuer, Buffer.from(recoveryHash, 'hex'))).toString('base64url')}`
        if (
          !devices.authenticateNative(nativeOpening.deviceId).ok
          || window.expiresAt <= now()
          || window.generation !== nativeGenerations.get(nativeOpening.deviceId)
          || nativeWindows.get(hash) !== window
        )
          throw new AppError(403, 'native-verification-invalid', '验证窗口已失效，请重新验证')
        nativeOpening.windowHash = hash
        json(res, { verifiedUntil: new Date(window.expiresAt).toISOString(), windowToken })
        return true
      }
      if (path === '/link/api/native/verification/resume' && method === 'POST') {
        const input = z
          .strictObject({
            appOpenId: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/u),
            windowToken: z.string().regex(/^lnw1\.[A-Za-z0-9_-]{43}$/u),
          })
          .parse(await jsonBody(req))
        const hash = sha256Hex(input.windowToken),
          window = nativeWindows.get(hash)
        if (
          !window
          || (nativeOpening.bulk && nativeOpening.bulk.windowHash !== hash)
          || window.deviceId !== nativeOpening.deviceId
          || window.appOpenId !== input.appOpenId
          || window.expiresAt <= now()
          || window.generation !== nativeGenerations.get(nativeOpening.deviceId)
        )
          throw new AppError(403, 'native-verification-invalid', '验证窗口已失效，请重新验证')
        nativeOpening.windowHash = hash
        json(res, { verifiedUntil: new Date(window.expiresAt).toISOString() })
        return true
      }
      const cancel = method === 'POST' && /^\/link\/api\/tasks\/[^/]+\/cancel$/u.test(path)
      const reject = method === 'POST' && /^\/link\/api\/approvals\/[^/]+$/u.test(path)
      caller.nativeWindowExempt =
        (path === '/link/api/snapshot' && method === 'GET') || cancel || (path === '/link/api/devices/current' && method === 'DELETE')
      if (nativeVerifiedUntil(nativeOpening) <= now() && !caller.nativeWindowExempt && !reject)
        throw new AppError(403, 'native-verification-required', '请先在手机上完成身份验证')
      if (path.startsWith('/link/api/credentials/')) throw new AppError(403, 'native-credential-route', '原生身份不使用浏览器凭据续期')
    }
    return false
  }

  async function handleNative({ req, res, caller, path, method }: CallerRequest): Promise<boolean> {
    if (path === '/link/api/native/info' && method === 'GET') {
      // Any admin device may read the relay state; changing it stays with this Mac's local administrator.
      if (caller.device) requireScope(caller, 'admin')
      else requireLocal(caller)
      if (!nativeSettings) throw new AppError(503, 'native-not-ready', '手机连接服务正在准备')
      await nativeSettings.settleRelayWrite()
      if (caller.device) recheck(caller, 'admin')
      json(res, nativeSettings.info(caller.device?.id))
      return true
    }
    if (path === '/link/api/native/pairings' && method === 'POST') {
      // A device with 管理此 Host, never an anonymous process on this Mac: a QR with no sheet open skips the question that
      // follows Touch ID, and closing the sheet ends a pairing.
      requireLocal(caller)
      requireScope(caller, 'admin')
      if (!nativeHost || !nativeSettings) throw new AppError(503, 'native-not-ready', '手机连接服务正在准备')
      const host = nativeHost
      // No pairing can complete during full access, so nothing opens for it either.
      await enrollments.assertCanPair()
      z.strictObject({}).parse(await optionalJsonBody(req))
      recheck(caller, 'admin')
      const invitation = await nativeSettings.whileOpen(() => host.invite({ inviter: caller.device }, actorOf(caller)))
      nativeNetwork?.reconcile()
      json(res, { invitation: { ...invitation, ...(nativeNetwork?.cable() ? { cable: true } : {}) } }, 201)
      return true
    }
    const rejected = /^\/link\/api\/native\/pairings\/([^/]+)\/device$/u.exec(path)
    if (rejected && method === 'DELETE') {
      requireLocal(caller)
      requireScope(caller, 'admin')
      const result = await enrollments.rejectNativePairing(safeDecode(rejected[1]!), actorOf(caller))
      if (!result.audited) res.setHeader('x-latch-audit', 'failed')
      nativeNetwork?.reconcile()
      refresh()
      json(res, { removed: true })
      return true
    }
    if (path === '/link/api/native/relay-files' && method === 'GET') {
      // The person's own relay files, for this Mac's local administrator alone: names, addresses and key hashes.
      requireLocal(caller)
      requireScope(caller, 'admin')
      const known = new Set(relayProfiles.snapshot().profiles.map(item => item.relayId))
      const files = await listRelayFiles(known, options.relayFilesHome)
      recheck(caller, 'admin')
      json(res, { files })
      return true
    }
    if (path === '/link/api/native/relays' && method === 'POST') {
      requireLocal(caller)
      requireScope(caller, 'admin')
      if (!nativeSettings) throw new AppError(503, 'native-not-ready', '手机连接服务正在准备')
      const settings = nativeSettings
      const body = z
        .strictObject({ requestId: z.uuid(), profile: relayProfileInput.optional(), file: z.string().max(64).optional() })
        .refine(value => value.profile === undefined || value.file === undefined)
        .parse(await jsonBody(req, 4 * KIB))
      const { requestId } = body
      // A file is named, never sent: the Host reads `~/.latch/relays/<name>.json` itself, so its token stays off the page.
      const profile = body.file === undefined ? body.profile : await relayFileByName(body.file, options.relayFilesHome)
      if (body.file !== undefined && !profile)
        throw new AppError(400, 'native-relay-file-invalid', '这个配置文件不在 ~/.latch/relays，或不是转发服务导出的连接配置。')
      const current = () => {
        if (closing()) throw new AppError(503, 'host-closing', '电脑正在停止，请稍后查询原请求。')
        recheck(caller, 'admin')
      }
      await settings.settleRelayWrite()
      current()
      const plan = settings.planRelay(requestId, caller.device.id, profile)
      if (plan) {
        const url = new URL(plan.input.url)
        const target = `${url.hostname}:${url.port || 443}`
        const stepup = await context.confirm(
          req,
          caller,
          'policy.change',
          { base: plan.base, requestId, profile: plan.request.requestHash },
          // The system sheet names the first address, how many the Host will dial and the key's short hash.
          {
            form: 'relay.add',
            slots: {
              target,
              count: String(1 + ('extraUrls' in plan.input ? (plan.input.extraUrls?.length ?? 0) : 0)),
              hash: relayKeyHash(relayNodeFields(plan.input)),
            },
          },
          [
            { label: '自己的中继', value: plan.input.url },
            ...('extraUrls' in plan.input && plan.input.extraUrls
              ? plan.input.extraUrls.map(value => ({ label: '同一中继的其他地址', value }))
              : []),
            { label: '中继标识', value: plan.input.relayId },
            'relayKey' in plan.input
              ? { label: '中继公钥', value: plan.input.relayKey }
              : { label: '证书公钥 SHA-256', value: plan.input.spkiHash },
            { label: '密钥短哈希', value: relayKeyHash(relayNodeFields(plan.input)) },
          ],
          [],
          target,
        )
        await settings.addRelay(plan, actorOf(caller), stepup, current)
        refresh()
      }
      current()
      json(res, settings.info(caller.device.id), plan ? 201 : 200)
      return true
    }
    const auditFailed = () => res.setHeader('x-latch-audit', 'failed')
    const addRequest = /^\/link\/api\/native\/relay-requests\/([^/]+)$/u.exec(path)
    if (addRequest && method === 'DELETE') {
      requireLocal(caller)
      requireScope(caller, 'admin')
      if (!nativeSettings) throw new AppError(503, 'native-not-ready', '手机连接服务正在准备')
      const id = z.uuid().parse(addRequest[1])
      await nativeSettings.settleRelayWrite()
      const result = await nativeSettings.cancelRelay(id, actorOf(caller), () => recheck(caller, 'admin'), auditFailed)
      if (!result.audited) res.setHeader('x-latch-audit', 'failed')
      recheck(caller, 'admin')
      json(res, nativeSettings.info(caller.device.id))
      return true
    }
    if (path === '/link/api/native/official-relay' && method === 'PUT') {
      requireLocal(caller)
      requireScope(caller, 'admin')
      if (!nativeSettings) throw new AppError(503, 'native-not-ready', '手机连接服务正在准备')
      const change = z
        .strictObject({ enabled: z.boolean().optional(), ownFirst: z.boolean().optional() })
        .refine(value => value.enabled !== undefined || value.ownFirst !== undefined)
        .parse(await jsonBody(req, KIB))
      const authorize = () => recheck(caller, 'admin')
      await nativeSettings.settleRelayWrite()
      const result = await nativeSettings.setOfficial(change, actorOf(caller), authorize, auditFailed)
      if (!result.audited) res.setHeader('x-latch-audit', 'failed')
      refresh()
      authorize()
      json(res, nativeSettings.info(caller.device.id))
      return true
    }
    const relayAction = /^\/link\/api\/native\/relays\/([a-f0-9]{32})(\/test)?$/u.exec(path)
    if (relayAction && ((relayAction[2] && method === 'POST') || (!relayAction[2] && method === 'PATCH'))) {
      if (!nativeSettings) throw new AppError(503, 'native-not-ready', '手机连接服务正在准备')
      if (relayAction[2]) {
        // A test uses the saved registration credential: record its execution before any outbound work.
        if (caller.device) requireScope(caller, 'admin')
        requireLocal(caller)
        const authorize = () => {
          if (closing()) throw new AppError(503, 'host-closing', '电脑正在停止，请稍后再试。')
          if (caller.device) recheck(caller, 'admin')
        }
        json(res, await nativeSettings.testRelay(relayAction[1]!, actorOf(caller), authorize))
        return true
      }
      requireLocal(caller)
      requireScope(caller, 'admin')
      const { disabled } = z.strictObject({ disabled: z.boolean() }).parse(await jsonBody(req, KIB))
      const authorize = () => recheck(caller, 'admin')
      await nativeSettings.settleRelayWrite()
      const result = await nativeSettings.setDisabled(relayAction[1]!, disabled, actorOf(caller), authorize, auditFailed)
      if (!result.audited) res.setHeader('x-latch-audit', 'failed')
      refresh()
      authorize()
      json(res, nativeSettings.info(caller.device.id))
      return true
    }
    const relay = /^\/link\/api\/native\/relays\/([a-f0-9]{32})$/u.exec(path)
    if ((relay || path === '/link/api/native/directory') && method === 'DELETE') {
      requireLocal(caller)
      requireScope(caller, 'admin')
      if (!nativeSettings) throw new AppError(503, 'native-not-ready', '手机连接服务正在准备')
      const authorize = () => recheck(caller, 'admin')
      const result = relay
        ? await nativeSettings.removeRelay(relay[1]!, actorOf(caller), authorize, auditFailed)
        : await nativeSettings.removeDirectory(actorOf(caller), authorize, auditFailed)
      if (!result.audited) res.setHeader('x-latch-audit', 'failed')
      refresh()
      authorize()
      json(res, nativeSettings.info(caller.device.id))
      return true
    }
    const pairing = /^\/link\/api\/native\/pairings\/([^/]+)$/u.exec(path)
    if (pairing && (method === 'GET' || method === 'DELETE')) {
      requireLocal(caller)
      requireScope(caller, 'admin')
      const id = safeDecode(pairing[1]!)
      if (method === 'GET') {
        const status: NativePairingStatus = enrollments.nativePairingStatus(id),
          access = nativeNetwork?.localNetwork()
        json(res, access && access !== 'allowed' ? { ...status, localNetwork: access } : status)
        return true
      }
      enrollments.revokeNativeInvitation(id)
      nativeNetwork?.reconcile()
      refresh()
      json(res, { revoked: true })
      return true
    }
    return false
  }

  async function start({ handle, fail, cleanup }: NativeStart): Promise<void> {
    nativeHost = await startNativeHost({
      tlsBinary: join(codeRoot, 'dist/native/latch-native-tls'),
      identity,
      devices,
      enrollments,
      ...(options.native ? { bind: options.native } : {}),
      relayAvailable: () => {
        const state = relayProfiles.snapshot()
        return state.profiles.some(
          profile => relayUsable(profile) && (!profile.builtIn || (devices.nativeReachable() && !state.officialOff)),
        )
      },
      handler(req, res, opening) {
        const permitted = () =>
          (!opening.windowHash || nativeVerifiedUntil(opening) > now()) && (!opening.bulk || opening.bulk.expiresAt > now())
        opening.padding?.guard(permitted)
        opening.guardTransportWrites?.(permitted)
        nativeRequests.set(req, opening)
        return handle(req, res, opening.listener).catch(async error => {
          if (opening.bulkAttempted || opening.bulk) await opening.close?.()
          else fail(res, error, opening.listener)
        })
      },
    })
    const native = nativeHost
    cleanup(() => native.close())
    nativePluginTransports = new NativePluginTransports({
      registry,
      enabled: () => !closing() && native.enabled,
      accept: (stream, binding) => native.acceptCarrier(stream, binding),
    })
    const pluginTransports = nativePluginTransports
    cleanup(() => pluginTransports.close())
    await pluginTransports.sync()
    await relayProfiles.syncOfficial(options.officialRelays ?? OFFICIAL_RELAYS)
    relayController = new HostRelayController({
      profiles: relayProfiles,
      devices,
      audit,
      resolve: createRelayEgress({
        allow: () => [...policy.get().hostEgressAllow, ...egressExtra],
        ...(options.egressLookup ? { lookup: options.egressLookup } : {}),
      }),
      directory: relayDirectory,
      resolvePublic: (url, address) =>
        createRelayEgress({
          allow: () => [],
          lookup: (_host, _options, callback) => callback(null, [{ address, family: address.includes(':') ? 6 : 4 }]),
        })(url),
      accept: (stream, binding, expected) => native.acceptRelay(stream, binding, expected),
      closePaths: id => native.closeRelay(id),
      ...(options.nativeRelayCa ? { ca: options.nativeRelayCa } : {}),
    })
    const controller = relayController
    cleanup(() => controller.close())
    if (options.nativeNetwork !== false && (process.platform === 'darwin' || options.nativeNetwork)) {
      nativeNetwork = new NativeNetwork({
        profiles: relayProfiles,
        networks: await NativeNetworks.open(dataDir),
        audit,
        backend: options.nativeNetwork || (() => MacNetworkBackend.open(join(codeRoot, 'dist/native/latch-network'))),
        direct: () => native.direct,
        automatic: () => nativeSettings?.following() ?? false,
        release: () => nativeSettings?.release() ?? Promise.resolve(),
        rebind: snapshot =>
          nativeSettings?.syncNetwork(snapshot, () => !closing() && nativeNetwork?.currentEpoch() === snapshot.epoch) ?? Promise.resolve(),
        pairing: () => enrollments.nativeInvitations().length > 0,
        discoveryReady: () => relayProfiles.snapshot().discoveryRevocationsHash === revokedDiscoveryHash(),
        synchronizeDiscovery: synchronizeNativeDiscovery,
        now,
      })
      const network = nativeNetwork
      cleanup(() => network.close())
    }
    nativeSettings = new NativeSettings({
      profiles: relayProfiles,
      native,
      controller,
      audit,
      directory: relayDirectory,
      ...(options.native ? { managedDirect: options.native } : {}),
      pairing: () => enrollments.nativePairingOpen(),
      reachable: () => devices.nativeReachable(),
      bookIssuedAt: relayId => addressBooks.bookIssuedAt(relayId),
      // The relay setup scripts exist only in a source checkout; a packaged app ships without apps/.
      sourceCheckout: existsSync(join(codeRoot, 'apps/relay/src/cli.ts')),
      changed: () => nativeNetwork?.invalidate(),
      localNetwork: () => nativeNetwork?.localNetwork(),
      resolveDirect: async (direct, current) => {
        if (!nativeNetwork) throw new AppError(409, 'native-no-lan', '这台 Mac 没有连接 Wi‑Fi 或有线网络。')
        return nativeNetwork.resolveDirect(direct, current)
      },
    })
    nativeNetwork?.reconcile()
  }

  return {
    screen,
    unauthenticated,
    authenticated,
    route: handleNative,
    features: (): HostFeatures => ({ nativeBulk: true, nativeBulkStream: true, pairingV3: true }),
    opening: req => nativeRequests.get(req),
    verifiedUntil: nativeVerifiedUntil,
    deviceView: nativeDeviceView,
    enabled: () => nativeHost?.enabled ?? false,
    port: () => nativeHost?.port,
    lan: () => nativeNetwork?.lan() ?? [],
    async pairingNearby(opening, gatewayHash) {
      if (opening.listener.listener !== 'native-direct' || !opening.pairing) return false
      if (options.nativeNearby) return (await options.nativeNearby(opening, gatewayHash)) ? '' : false
      return nativeNetwork?.pairingNearby(opening, gatewayHash) ?? false
    },
    rememberNetwork(networkHash) {
      void nativeNetwork?.remember(networkHash).catch(() => {})
    },
    invalidate: () => nativeNetwork?.invalidate(),
    reconcile: () => relayController?.reconcile(),
    nearestRelayRegion: () => relayController?.nearestRegion(),
    start,
    async close() {
      await nativeNetwork?.close()
      await nativePluginTransports?.close()
      await relayDirectory.close()
      await relayController?.close()
      await nativeHost?.close()
    },
  }
}
