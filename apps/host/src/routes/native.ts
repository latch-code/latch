import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import type { Device, HostFeatures } from '@latch/protocol'
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
import type { StepupMethod } from '../audit.ts'
import { parseP256Spki, randomNonce, verifyP256 } from '../crypto.ts'
import { createRelayEgress, type LookupFunction } from '../egress.ts'
import { json, jsonBody, optionalJsonBody } from '../http-util.ts'
import type { HostIdentity } from '../identity.ts'
import type { ListenerContext } from '../listeners.ts'
import { startNativeHost, type NativeOpening } from '../native.ts'
import { NativeNetwork } from '../native-network.ts'
import { MacNetworkBackend, type NativeNetworkBackend } from '../native-network-backend.ts'
import { NativeNetworks } from '../native-networks.ts'
import { NativeSettings, nativeAddresses } from '../native-settings.ts'
import { NativePluginTransports } from '../native-transports.ts'
import type { HostAddressBooks } from '../relay/address-book.ts'
import { HostRelayController } from '../relay/controller.ts'
import type { HostRelayDirectory } from '../relay/directory.ts'
import type { RelayProfiles } from '../relay/profiles.ts'
import { invitationSchema, signatureSchema } from './devices.ts'
import { CONFIG_BODY_LIMIT, type Caller, type CallerRequest, type RouteContext, type RouteModule, type RouteRequest } from './registry.ts'

/** What the native routes need from the Host beyond the route context. */
export interface NativeRouteDeps {
  /** The Host's own options for the native entry, its network watcher, private relay roots and outbound lookups. */
  options: {
    native?: { host: string; port: number }
    nativeNetwork?: false | (() => Promise<NativeNetworkBackend>)
    nativeRelayCa?: string | Buffer
    egressLookup?: LookupFunction
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
  /** Makes the network watcher look again, after a revocation or a discovery-key rotation. */
  invalidate(): void
  /** Lets the relay controller follow a change the Host announced. */
  reconcile(): void
  /** Starts the native entry, plugin transports, relay controller, network watcher and settings. */
  start(host: NativeStart): Promise<void>
  /** Stops them, closing the relay directory between the plugin transports and the relay controller. */
  close(): Promise<void>
}

/**
 * The phone connection: native openings and their verification windows, revocation notices, bulk transfers, address
 * books, the input pause, the native entry's settings and invitations, and the relay wiring.
 */
export function createNativeRoutes(context: RouteContext, deps: NativeRouteDeps): NativeRoutes {
  const { hostId, dataDir, codeRoot, now, audit, policy, devices, enrollments, plugins: registry, closing, refresh, actorOf } = context
  const { requireLocal, recheck, confirm, serial } = context
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
        const expiresAt = Math.min(nativeVerifiedUntil(nativeOpening), now() + 60_000)
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
        nativeOpening.activateBulk()
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
      const cancel =
        method === 'POST'
        && (/^\/link\/api\/tasks\/[^/]+\/cancel$/u.test(path) || /^\/link\/api\/personal\/groups\/grp_[a-f0-9-]{36}\/cancel$/u.test(path))
      const reject = method === 'POST' && /^\/link\/api\/approvals\/[^/]+$/u.test(path)
      caller.nativeWindowExempt =
        (path === '/link/api/snapshot' && method === 'GET') || cancel || (path === '/link/api/native/input/pause' && method === 'POST')
      if (nativeVerifiedUntil(nativeOpening) <= now() && !caller.nativeWindowExempt && !reject)
        throw new AppError(403, 'native-verification-required', '请先在手机上完成身份验证')
      if (path.startsWith('/link/api/credentials/')) throw new AppError(403, 'native-credential-route', '原生身份不使用浏览器凭据续期')
    }
    return false
  }

  async function handleNative({ req, res, caller, path, method }: CallerRequest): Promise<boolean> {
    if (path === '/link/api/native/input/pause' && method === 'POST') {
      if (caller.device) requireScope(caller, 'view')
      else requireLocal(caller)
      z.strictObject({}).parse(await optionalJsonBody(req))
      const result = await devices.setNativeInputsPaused(true, actorOf(caller), 'none')
      if (!result.audited) res.setHeader('x-latch-audit', 'failed')
      refresh()
      json(res, { paused: true })
      return true
    }
    if (path === '/link/api/native/input/resume' && method === 'POST') {
      requireLocal(caller)
      requireScope(caller, 'admin')
      z.strictObject({}).parse(await optionalJsonBody(req))
      const stepup = await confirm(req, caller, 'policy.change', { nativeInputPaused: false }, { form: 'policy.native-input', slots: {} }, [
        { label: '手机输入', value: '恢复所有已登记原生手机的输入权限' },
      ])
      recheck(caller, 'admin')
      await devices.setNativeInputsPaused(false, actorOf(caller), stepup)
      refresh()
      json(res, { paused: false })
      return true
    }
    if (path === '/link/api/native/info' && method === 'GET') {
      requireLocal(caller)
      if (caller.device) requireScope(caller, 'admin')
      if (!nativeSettings) throw new AppError(503, 'native-not-ready', '手机连接服务正在准备')
      json(res, { ...nativeSettings.info(), ...(nativeHost?.port !== undefined ? { port: nativeHost.port } : {}) })
      return true
    }
    if (path === '/link/api/native/config' && method === 'PUT') {
      requireLocal(caller)
      requireScope(caller, 'admin')
      if (!nativeSettings) throw new AppError(503, 'native-not-ready', '手机连接服务正在准备')
      const settings = nativeSettings,
        input = await jsonBody(req, CONFIG_BODY_LIMIT)
      recheck(caller, 'admin')
      if (settings.alreadyApplied(input)) {
        json(res, settings.info())
        return true
      }
      const plan = settings.plan(input)
      let stepup: StepupMethod = 'none'
      if (!plan.lowering) {
        const direct = plan.input.direct
        stepup = await confirm(
          req,
          caller,
          'policy.change',
          { baseHash: plan.baseHash, afterHash: plan.afterHash, requestHash: plan.requestHash },
          {
            form: 'policy.native-link',
            slots: {
              direct: `${plan.directoryChanged ? (plan.directory ? `地址目录 ${plan.directory.mirrors.length} 个镜像；` : '关闭地址目录；') : ''}${direct ? `局域网直连 ${direct.host}:${direct.port || '自动端口'}` : '关闭局域网直连'}`,
              count: String(plan.input.relays.length),
            },
          },
          [
            { label: '局域网直连', value: direct ? `${direct.host}:${direct.port || '自动端口'}` : '关闭' },
            ...plan.input.relays.flatMap(node => [
              { label: '自建中继', value: node.url },
              { label: '节点身份', value: node.relayId },
              { label: 'TLS 公钥指纹', value: node.spkiHash },
              {
                label: '登记密钥',
                value: node.registrationKey === null ? '不使用' : node.registrationKey ? '已填写（不显示）' : '保持原设置',
              },
            ]),
            ...(plan.directory
              ? [
                  ...plan.directory.anchors.map(value => ({ label: '地址发布根公钥', value })),
                  ...plan.directory.mirrors.map(value => ({ label: '地址镜像', value })),
                ]
              : []),
          ],
          ['中继与网络服务商可看到 IP、连接时间和数据量；正文仍由 Host 身份与端到端连接保护。'],
        )
      }
      const result = await serial(caller, 'admin', () => settings.apply(plan, actorOf(caller), stepup, () => recheck(caller, 'admin')))
      if (!result.audited) res.setHeader('x-latch-audit', 'failed')
      refresh()
      json(res, settings.info())
      return true
    }
    if (path === '/link/api/native/pairings' && method === 'POST') {
      requireLocal(caller)
      if (caller.device) requireScope(caller, 'admin')
      if (!nativeHost) throw new AppError(409, 'native-not-configured', '尚未配置原生设备连接入口')
      const input = invitationSchema.extend({ dataScope: z.enum(['work', 'all']).optional() }).parse(await optionalJsonBody(req))
      recheck(caller, 'admin')
      const invitation = await nativeHost.invite(
        {
          ...(caller.device ? { inviter: caller.device } : {}),
          ...(input.scopes ? { scopes: input.scopes } : {}),
          ...(input.dataScope ? { dataScope: input.dataScope } : {}),
        },
        actorOf(caller),
      )
      json(res, { invitation }, 201)
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
      bind:
        options.native
        ?? (nativeAddresses().some(item => item.address === relayProfiles.snapshot().direct?.host)
          ? (relayProfiles.snapshot().direct ?? undefined)
          : undefined),
      allowUnavailableBind: !options.native,
      relayAvailable: () => relayProfiles.snapshot().profiles.length > 0,
      relayInvites: (id, expiresAt) => relayController?.invitation(id, expiresAt) ?? Promise.resolve([]),
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
    relayController = new HostRelayController({
      profiles: relayProfiles,
      devices,
      enrollments,
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
        automatic: () => !options.native && relayProfiles.snapshot().direct?.host === 'auto',
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
      directory: relayDirectory,
      audit,
      managedDirect: options.native,
      inputsPaused: () => devices.nativeInputsPaused(),
      changed: () => nativeNetwork?.invalidate(),
      resolveDirect: direct => {
        if (!nativeNetwork) throw new AppError(503, 'native-network-unavailable', '手机连接组件不可用，请更新并重新构建 Latch 后重试')
        return nativeNetwork.resolveDirect(direct, native.direct)
      },
    })
  }

  return {
    screen,
    unauthenticated,
    authenticated,
    route: handleNative,
    features: (): HostFeatures => ({ nativeBulk: true, nativeBulkStream: true, nativePairingScope: true }),
    opening: req => nativeRequests.get(req),
    verifiedUntil: nativeVerifiedUntil,
    deviceView: nativeDeviceView,
    enabled: () => nativeHost?.enabled ?? false,
    port: () => nativeHost?.port,
    lan: () => nativeNetwork?.lan() ?? [],
    invalidate: () => nativeNetwork?.invalidate(),
    reconcile: () => relayController?.reconcile(),
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
