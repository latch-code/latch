import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TLSSocket } from 'node:tls'
import { certificateProofText, type HostIdentity } from '../identity.ts'
import { z } from 'zod'
import {
  isLocalListener,
  isNativeListener,
  LISTENER_LABELS,
  SCOPE_LABELS,
  type CurrentDevice,
  type DataScope,
  type Device,
  type DeviceScope,
  type EnrollmentView,
  type ListenerClass,
  type PresenceSubject,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { sha256Hex } from '@latch/core/node-kit'
import {
  CLEARED_LEGACY_COOKIE,
  authFailure,
  clearedCredentialCookie,
  credentialCookie,
  isSocketTransport,
  presentedCredential,
} from '../access.ts'
import type { StepupMethod } from '../audit.ts'
import type { ConnectionContext, DeviceScopeBase } from '../auth.ts'
import { codeOf, json, jsonBody, optionalJsonBody, safeDecode } from '../http-util.ts'
import type { ListenerContext, ValidatedTls } from '../listeners.ts'
import type { NativeOpening } from '../native.ts'
import type { HostAddressBooks } from '../relay/address-book.ts'
import {
  BASE_RETRIES,
  type Caller,
  type CallerRequest,
  type PreviewLine,
  type RouteContext,
  type RouteModule,
  type RouteRequest,
} from './registry.ts'

export const RENEW_INTERVAL_MS = 24 * 60 * 60 * 1000
const MAX_ISSUED_INVITATIONS = 256
const MAX_GATE_REFUSALS = 8
export const UNIX_ADDRESS = '本机 host.sock'
const PAIRING_LABELS = { lpc: '本机确认', offline: '离线连接码', invitation: '配对邀请', migration: '旧版本迁移' } as const

const deviceNameSchema = z.object({ name: z.string().trim().min(1).max(80) })
const scopeSchema = z.enum(['view', 'run', 'approve:standard', 'approve:elevated', 'admin', 'secrets'])
const enrollmentSchema = z.object({
  publicKey: z.string().min(1).max(1024),
  /** Empty only when re-confirming a legacy browser, which keeps its old name. */
  name: z.string().trim().max(80).default(''),
  scopes: z.array(scopeSchema).max(6).optional(),
  dataScope: z.enum(['work', 'all']).optional(),
  invitation: z.string().min(1).max(64).optional(),
  gatewayHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  offlineCode: z.string().min(1).max(64).optional(),
  native: z
    .object({ certificate: z.string().min(1).max(8192), verificationKey: z.string().min(1).max(256) })
    .strict()
    .optional(),
})
const invitationOfferSchema = z.object({ invitation: z.string().min(1).max(64) })
const certificateProofSchema = z.strictObject({ nonce: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/u) })
export const signatureSchema = z.object({ signature: z.string().min(1).max(256) })
const renewSchema = z.object({ nonce: z.string().min(1).max(128), signature: z.string().min(1).max(256) })
const deviceScopesSchema = z
  .object({ scopes: z.array(scopeSchema).max(6).optional(), dataScope: z.enum(['work', 'all']).optional() })
  .refine(value => value.scopes !== undefined || value.dataScope !== undefined, '没有要修改的内容')
export const invitationSchema = z.object({
  scopes: z.array(scopeSchema).max(6).optional(),
  /** `tls` (default): a phone or another computer; `loopback`: a browser on this computer. */
  target: z.enum(['tls', 'loopback']).optional(),
})

/** What the device routes need from the Host beyond the route context. */
export interface DeviceRouteDeps {
  /**
   * The Host's authentication of a request. `renewal` admits devices whose credential is due for renewal (only the
   * renewal routes pass it); host.sock without a credential is anonymous.
   */
  authenticate: (req: IncomingMessage, listener: ListenerContext, connection: ConnectionContext, renewal?: boolean) => Promise<Caller>
  /** The HTTPS entry, when the Host serves one. */
  tls: ValidatedTls | undefined
  loopbackOrigin: () => string
  tlsOrigin: () => string | undefined
  addressBooks: HostAddressBooks
  /** Ends every event stream whose credential is no longer accepted. */
  endDisallowedStreams: () => void
  /** A device as clients see it, with the state of its native connection. */
  deviceView: (device: Device) => Device
  /** The proximity gate for a phone's pairing request. */
  pairingNearby: (opening: NativeOpening, gatewayHash: Uint8Array) => Promise<string | false>
  /** A phone proven on this network has paired. */
  rememberNetwork: (networkHash: string) => void
  /** Signs `POST /host-proof`. */
  identity: Pick<HostIdentity, 'publicKeySpki' | 'sign'>
  /** This computer's name, which a newly paired phone shows. */
  hostName: () => string
}

/** Enrollment, credential renewal, devices and their scopes, and browser and HTTPS pairing invitations. */
export function createDeviceRoutes(context: RouteContext, deps: DeviceRouteDeps): RouteModule {
  const { devices, enrollments, hub, hostId8, limits, now, refresh, actorOf, requireLocal, recheck, confirm, serial } = context
  const requireDevice: RouteContext['requireDevice'] = context.requireDevice
  const requireScope: RouteContext['requireScope'] = context.requireScope
  const { addressBooks, tls } = deps

  /**
   * Hashes of invitation codes this Host handed out, with their expiry and the listener they are for; only these, on
   * that listener, get their own enrollment budget.
   */
  const issuedInvitations = new Map<string, { expiresAt: number; listener: ListenerClass }>()
  function pruneInvitations(): void {
    const current = now()
    for (const [hash, issued] of issuedInvitations) if (issued.expiresAt < current) issuedInvitations.delete(hash)
  }
  function invitationIssued(hash: string, listener: ListenerClass): boolean {
    pruneInvitations()
    return issuedInvitations.get(hash)?.listener === listener
  }

  function setCredentialCookie(
    res: ServerResponse,
    caller: Pick<Caller, 'connection'>,
    device: Device,
    credential: string,
    extra: string[] = [],
  ): void {
    res.setHeader('set-cookie', [
      credentialCookie(caller.connection.listener, hostId8, credential, Date.parse(device.credentialExpiresAt), now()),
      ...extra,
    ])
  }

  async function handleEnrollment({ req, res, listener, connection, opening, path, method }: RouteRequest): Promise<boolean> {
    if ((path === '/link/api/login' || path === '/link/api/pair') && method === 'POST') {
      throw new AppError(410, 'login-removed', '启动令牌登录已移除，请在本机确认这台设备')
    }
    if (path === '/link/api/enrollment-info' && method === 'GET') {
      let legacyName: string | undefined
      const presented = presentedCredential(req, listener, hostId8)
      if (listener.listener === 'loopback-tcp' && presented?.kind === 'legacy-cookie') {
        const outcome = await devices.authenticate(presented, connection)
        if (!outcome.ok && outcome.code === 'legacy-reconfirm') legacyName = outcome.legacyName
      }
      const info = await enrollments.info(connection, legacyName)
      json(res, isLocalListener(connection.listener) ? { ...info, hostName: deps.hostName().replace(/\.local$/u, '') } : info)
      return true
    }
    if (path === '/link/api/host-proof' && method === 'POST') {
      // A desktop app that saw a new certificate at this Host's HTTPS address asks the Host to prove it serves it: a
      // signature by the Host's identity key (whose hash is the hostId) over the certificate this connection uses.
      if (listener.listener !== 'lan-tls' && listener.listener !== 'tailnet-tls') throw new AppError(404, 'not-found', '接口不存在')
      limits.certificateProof.take(connection.remoteAddress)
      const input = certificateProofSchema.parse(await jsonBody(req))
      const certificate = (req.socket as TLSSocket).getCertificate?.()
      const fingerprint = certificate && 'fingerprint256' in certificate ? certificate.fingerprint256 : undefined
      if (typeof fingerprint !== 'string') throw new AppError(404, 'not-found', '接口不存在')
      json(res, {
        publicKey: deps.identity.publicKeySpki.toString('base64url'),
        signature: deps.identity
          .sign(Buffer.from(certificateProofText(context.hostId, input.nonce, fingerprint), 'utf8'))
          .toString('base64url'),
      })
      return true
    }
    if (path === '/link/api/enrollment-invitation' && method === 'POST') {
      if (isNativeListener(listener.listener)) throw authFailure('unauthorized')
      limits.enrollmentPoll.take(`${listener.listener}:invitation`)
      const input = invitationOfferSchema.parse(await jsonBody(req))
      json(res, enrollments.invitationOffer(input.invitation, connection))
      return true
    }
    if (path === '/link/api/enrollments' && method === 'POST') {
      const local = isLocalListener(listener.listener)
      if (local) limits.enrollmentCreate.take(listener.listener)
      const input = enrollmentSchema.parse(await jsonBody(req))
      const native = opening
      if (
        isNativeListener(listener.listener)
        && (!native?.pairing || !input.invitation || sha256Hex(input.invitation) !== native.invitationHash)
      )
        throw authFailure('unauthorized')
      // Off host.sock only an invitation can succeed. Each one this Host issued gets its own budget on its listener, so
      // other requests cannot use up an invited device's; every other attempt, with or without a code, shares one budget
      // per listener and adds no keys.
      // A phone's QR is proven by its knock and answers to its own budget, inside the enrollment service: what one holder
      // of a QR spends must not stop another phone from presenting it.
      const invitationHash = !local && input.invitation !== undefined ? sha256Hex(input.invitation) : undefined
      const issued = invitationHash !== undefined && invitationIssued(invitationHash, listener.listener)
      if (!local && !isNativeListener(listener.listener))
        limits.enrollmentCreate.take(issued ? `${listener.listener}:invitation:${invitationHash}` : `${listener.listener}:uninvited`)
      const request = {
        publicKey: input.publicKey,
        name: input.name,
        ...(input.scopes ? { scopes: input.scopes } : {}),
        ...(input.dataScope ? { dataScope: input.dataScope } : {}),
        ...(input.invitation ? { invitation: input.invitation } : {}),
        ...(input.offlineCode ? { offlineCode: input.offlineCode } : {}),
        ...(input.native ? { native: input.native } : {}),
        ...(input.gatewayHash ? { gatewayHash: input.gatewayHash } : {}),
      }
      const presented = presentedCredential(req, listener, hostId8)
      const legacy = presented?.kind === 'legacy-cookie' ? presented : undefined
      let enrollment: EnrollmentView
      try {
        enrollment = await enrollments.create(
          request,
          connection,
          legacy,
          native?.pairing
            ? {
                async nearby(gatewayHash) {
                  const proof = await deps.pairingNearby(native, gatewayHash)
                  // Refusals cost only the connection asking; one that keeps asking loses it.
                  if (proof === false && (native.gateRefusals = (native.gateRefusals ?? 0) + 1) >= MAX_GATE_REFUSALS) void native.close?.()
                  return proof
                },
                budget: () => limits.enrollmentCreate.take(`native:${native.invitationHash}`),
                auditFailed: () => res.setHeader('x-latch-audit', 'failed'),
              }
            : undefined,
        )
      } catch (error) {
        if (issued && codeOf(error) === 'invitation-invalid') issuedInvitations.delete(invitationHash)
        throw error
      }
      // Single use: later attempts with this code share the per-listener budget.
      if (issued) issuedInvitations.delete(invitationHash)
      if (native) native.enrollmentId = enrollment.id
      json(res, { enrollment }, 202)
      return true
    }
    const enrollment = path.match(/^\/link\/api\/enrollments\/([^/]+)(\/(?:prepare|complete))?$/)
    if (!enrollment) return false
    const id = safeDecode(enrollment[1]!)
    if (isNativeListener(listener.listener) && opening?.enrollmentId !== id) throw authFailure('unauthorized')
    if (id.length > 64) throw new AppError(404, 'enrollment-not-found', '找不到这个连接请求')
    if (method === 'GET' && !enrollment[2]) {
      limits.enrollmentPoll.take(id)
      json(res, { enrollment: enrollments.status(id, connection) })
      return true
    }
    if (method === 'DELETE' && !enrollment[2]) {
      enrollments.cancel(id, connection)
      json(res, { cancelled: true })
      return true
    }
    if (method === 'POST' && enrollment[2] === '/prepare') {
      if (!isNativeListener(listener.listener)) throw authFailure('unauthorized')
      limits.enrollmentPoll.take(id)
      const input = signatureSchema.strict().parse(await jsonBody(req))
      const deviceId = enrollments.prepareNative(id, input.signature, connection)
      const addressBook = await addressBooks.issue(deviceId)
      if (enrollments.prepareNative(id, input.signature, connection) !== deviceId) throw authFailure('unauthorized')
      json(res, { deviceId, addressBook, hostName: deps.hostName() })
      return true
    }
    if (method === 'POST' && enrollment[2] === '/complete') {
      limits.enrollmentPoll.take(id)
      const input = signatureSchema.parse(await jsonBody(req))
      const presented = presentedCredential(req, listener, hostId8)
      const { device, credential, network } = await enrollments.complete(id, input.signature, connection)
      if (network) deps.rememberNetwork(network)
      refresh()
      if (isNativeListener(listener.listener)) {
        json(res, { device })
        return true
      }
      if (isSocketTransport(listener.listener)) {
        json(res, { device, credential })
        return true
      }
      setCredentialCookie(res, { connection }, device, credential, presented?.kind === 'legacy-cookie' ? [CLEARED_LEGACY_COOKIE] : [])
      json(res, { device })
      return true
    }
    return false
  }

  async function handleCredentials(req: IncomingMessage, res: ServerResponse, caller: Caller, path: string): Promise<void> {
    requireDevice(caller)
    if (path === '/link/api/credentials/challenge') {
      const challenge = devices.challenge(caller.device.id, caller.credentialHash)
      json(res, { nonce: challenge.nonce, expiresAt: new Date(challenge.expiresAt).toISOString() })
      return
    }
    const input = renewSchema.parse(await jsonBody(req))
    const { device, credential } = await devices.renew({
      deviceId: caller.device.id,
      nonce: input.nonce,
      signature: input.signature,
      connection: caller.connection,
      ...(caller.credentialHash ? { credentialHash: caller.credentialHash } : {}),
    })
    const renewed: CurrentDevice = { ...device, current: true, renewAfter: new Date(now() + RENEW_INTERVAL_MS).toISOString() }
    refresh()
    if (isSocketTransport(caller.connection.listener)) {
      json(res, { device: renewed, credential })
      return
    }
    setCredentialCookie(res, caller, device, credential)
    json(res, { device: renewed })
  }

  /** Revokes and reports whether the device store's audit record was written (it never blocks a revocation). */
  async function revokeDevice(res: ServerResponse, caller: Caller, id: string, reason: 'manual' | 'self') {
    const result = await devices.revoke(id, reason, actorOf(caller))
    if (!result.audited) res.setHeader('x-latch-audit', 'failed')
    deps.endDisallowedStreams()
    refresh()
    return result
  }

  function grantBase(device: Device): DeviceScopeBase {
    return { scopes: [...device.scopes].sort(), dataScope: device.dataScope, status: device.status }
  }

  /** Host-derived facts come first: the name is chosen by the device itself and can imitate another. */
  function grantLines(target: Device, added: DeviceScope[], removed: DeviceScope[], dataScope: DataScope): PreviewLine[] {
    const label = (list: DeviceScope[]) => (list.length ? list.map(scope => SCOPE_LABELS[scope]).join('、') : '无')
    const origin = isSocketTransport(target.listener)
      ? UNIX_ADDRESS
      : target.listener === 'loopback-tcp'
        ? deps.loopbackOrigin()
        : (deps.tlsOrigin() ?? '')
    const inviter = target.pairedBy.deviceId ? devices.get(target.pairedBy.deviceId) : undefined
    return [
      { label: '连接方式', value: `${LISTENER_LABELS[target.listener]} · ${origin}` },
      {
        label: '配对方式',
        value: inviter ? `${PAIRING_LABELS[target.pairedBy.method]}（邀请设备：${inviter.name}）` : PAIRING_LABELS[target.pairedBy.method],
      },
      { label: '当前状态', value: target.status === 'review' ? '待复核（邀请设备已被撤销）' : '正常' },
      { label: '设备名称', value: target.name },
      { label: '设备指纹', value: target.fingerprint },
      { label: '新增权限', value: label(added) },
      { label: '移除权限', value: label(removed) },
      { label: '数据范围', value: dataScope === 'all' ? '全部' : '工作' },
    ]
  }

  /** What the system sheet names for a raise: the added rights, all data, and a restored review. */
  function grantSubject(target: Device, added: DeviceScope[], dataScope: DataScope): PresenceSubject {
    const change = [
      ...(target.status === 'review' ? ['恢复正常使用'] : []),
      ...added.map(scope => SCOPE_LABELS[scope]),
      ...(dataScope === 'all' && target.dataScope !== 'all' ? ['查看全部数据'] : []),
    ]
    return { form: 'device.grant', slots: { device: target.name, change: change.join('、') || '恢复正常使用' } }
  }

  /** Every device but the desktop app gets a locality warning; a loopback one may be a forwarded peer. */
  function grantWarnings(target: Device, added: DeviceScope[]): string[] {
    const where = isLocalListener(target.listener)
      ? []
      : target.listener === 'loopback-tcp'
        ? ['该设备经回环端口连接，也可能是转发进来的连接，不能据此认定它在这台电脑上。']
        : ['该设备通过网络连接，不在这台电脑上。']
    return [
      ...where,
      ...(target.status === 'review' ? ['该设备的邀请设备已被撤销；确认后它将恢复正常使用。'] : []),
      ...(added.includes('admin') ? ['确认后该设备可以管理此 Host：模型服务、插件、项目和其他设备。'] : []),
    ]
  }

  async function handleDevices({ req, res, caller, path, method }: CallerRequest): Promise<boolean> {
    if (path === '/link/api/devices/current') {
      requireScope(caller, 'view')
      if (method === 'PATCH') {
        const input = deviceNameSchema.parse(await jsonBody(req))
        recheck(caller)
        const device = await devices.rename(caller.device.id, input.name, actorOf(caller))
        refresh()
        json(res, { device })
        return true
      }
      if (method === 'DELETE') {
        limits.classC.take(caller.device.id)
        await revokeDevice(res, caller, caller.device.id, 'self')
        if (!isSocketTransport(caller.connection.listener))
          res.setHeader('set-cookie', clearedCredentialCookie(caller.connection.listener, hostId8))
        json(res, { revoked: true })
        return true
      }
      return false
    }
    if (path === '/link/api/devices' && method === 'GET') {
      if (caller.device) requireScope(caller, 'admin')
      json(res, { devices: devices.list().map(item => deps.deviceView(item)) })
      return true
    }
    const match = path.match(/^\/link\/api\/devices\/([^/]+)$/)
    const renamed = path.match(/^\/link\/api\/devices\/([^/]+)\/name$/)
    if (renamed && method === 'PATCH') {
      requireLocal(caller)
      requireScope(caller, 'admin')
      const id = safeDecode(renamed[1]!)
      const input = deviceNameSchema.parse(await jsonBody(req))
      recheck(caller, 'admin')
      const target = devices.get(id)
      if (!target || target.status === 'revoked' || target.status === 'legacy-pending')
        throw new AppError(404, 'device-not-found', '找不到该设备')
      const device = await devices.rename(id, input.name, actorOf(caller))
      refresh()
      json(res, { device })
      return true
    }
    if (match && method === 'DELETE') {
      if (caller.device) requireScope(caller, 'admin')
      else limits.anonymousRevoke.take()
      const id = safeDecode(match[1]!)
      if (caller.device && id === caller.device.id) throw new AppError(409, 'current-device', '请使用「撤销此设备」撤销当前设备')
      if (!devices.get(id)) throw new AppError(404, 'device-not-found', '找不到该设备')
      const result = await revokeDevice(res, caller, id, 'manual')
      json(res, { revoked: true, cascaded: result.cascaded.length })
      return true
    }
    if (match && method === 'PATCH') {
      requireScope(caller, 'admin')
      const id = safeDecode(match[1]!)
      const input = deviceScopesSchema.parse(await jsonBody(req))
      recheck(caller, 'admin')
      const target = devices.get(id)
      if (!target || target.status === 'revoked' || target.status === 'legacy-pending')
        throw new AppError(404, 'device-not-found', '找不到该设备')
      const scopes = [...new Set<DeviceScope>(['view', ...(input.scopes ?? target.scopes)])].sort()
      const dataScope: DataScope = input.dataScope ?? target.dataScope
      if (!isLocalListener(target.listener) && scopes.includes('secrets')) {
        throw new AppError(400, 'scope-not-grantable', '该权限在此连接方式下不可授予')
      }
      const added = scopes.filter(scope => !target.scopes.includes(scope))
      const removed = target.scopes.filter(scope => !scopes.includes(scope))
      const raising =
        added.length > 0
        || (dataScope === 'all' && target.dataScope !== 'all')
        || (target.status === 'review' && scopes.some(scope => scope !== 'view'))
      const base = grantBase(target)
      let stepup: StepupMethod = 'none'
      if (raising) {
        requireLocal(caller)
        // The preview shows a change against `base`, so the confirmation binds it too.
        stepup = await confirm(
          req,
          caller,
          'device.grant',
          { deviceId: id, scopes, dataScope, base },
          grantSubject(target, added, dataScope),
          grantLines(target, added, removed, dataScope),
          grantWarnings(target, added),
        )
      }
      const { device, audited } = await serial(caller, 'admin', async () => {
        // The store compares the base inside its own queue, where revocation cascades also run (409 device-changed).
        if (raising) return devices.changeScopes(id, { scopes, dataScope }, actorOf(caller), stepup, grantBase(target))
        // A reduction applies to the current record, so a concurrent change is narrowed further, never undone.
        for (let attempt = 1; ; attempt++) {
          const current = devices.get(id)
          if (!current || current.status === 'revoked' || current.status === 'legacy-pending')
            throw new AppError(404, 'device-not-found', '找不到该设备')
          const kept = current.scopes.filter(scope => scopes.includes(scope))
          try {
            return await devices.changeScopes(
              id,
              { scopes: kept, dataScope: dataScope === 'work' ? 'work' : current.dataScope },
              actorOf(caller),
              'none',
              grantBase(current),
            )
          } catch (error) {
            if (attempt >= BASE_RETRIES || codeOf(error) !== 'device-changed') throw error
          }
        }
      })
      if (!audited) res.setHeader('x-latch-audit', 'failed')
      deps.endDisallowedStreams()
      refresh()
      json(res, { device })
      return true
    }
    if (path === '/link/api/enrollments' && method === 'GET') {
      // The pairing panel compares fingerprints on this computer, so only the desktop's admins see who is waiting; it
      // also says which full-access sessions a new pairing has to wait for (they refuse device.enroll).
      requireLocal(caller)
      requireScope(caller, 'admin')
      json(res, { enrollments: enrollments.waiting(), blockingTasks: (await hub.unsandboxedTasks()).slice(0, 8) })
      return true
    }
    if (path === '/link/api/pairings' && method === 'POST') {
      requireLocal(caller)
      if (caller.device) requireScope(caller, 'admin')
      const input = invitationSchema.parse(await optionalJsonBody(req))
      recheck(caller, 'admin')
      // `loopback`: a browser on this computer, which the desktop app opens with the invitation in the fragment.
      const tlsOrigin = deps.tlsOrigin()
      const target: { listener: ListenerClass; origin: string } | undefined =
        input.target === 'loopback'
          ? { listener: 'loopback-tcp', origin: deps.loopbackOrigin() }
          : tls && tlsOrigin
            ? { listener: tls.listener, origin: tlsOrigin }
            : undefined
      if (!target) throw new AppError(409, 'tls-not-configured', '尚未配置 HTTPS 入口，无法生成手机配对码')
      const invitation = await enrollments.createInvitation(
        { ...(caller.device ? { inviter: caller.device } : {}), ...(input.scopes ? { scopes: input.scopes } : {}), ...target },
        actorOf(caller),
      )
      pruneInvitations()
      // The enrollment service caps live invitations; this bound only keeps the map small if that cap ever changes.
      if (issuedInvitations.size >= MAX_ISSUED_INVITATIONS) issuedInvitations.delete(issuedInvitations.keys().next().value!)
      issuedInvitations.set(sha256Hex(invitation.code), { expiresAt: Date.parse(invitation.expiresAt), listener: target.listener })
      json(res, { invitation }, 201)
      return true
    }
    return false
  }

  return {
    async unauthenticated(request) {
      if (await handleEnrollment(request)) return true
      const { req, res, listener, connection, path, method } = request
      if (path === '/link/api/credentials/challenge' || path === '/link/api/credentials/renew') {
        if (method !== 'POST') throw new AppError(404, 'not-found', '接口不存在')
        const caller = await deps.authenticate(req, listener, connection, true)
        if (!caller.device) throw authFailure('unauthorized')
        await handleCredentials(req, res, caller, path)
        return true
      }
      return false
    },
    route: handleDevices,
  }
}
