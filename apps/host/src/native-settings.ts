import type { NativeLinkInfo } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import type { startNativeHost } from './native.ts'
import type { HostRelayController } from './relay/controller.ts'
import { selectAutoDirect } from './native-network.ts'
import type { NativeNetworkSnapshot } from './native-network-backend.ts'
import { relayNodeFields, type RelayProfiles, type NativeDirect, type PendingRelay, type RelayProfileInput } from './relay/profiles.ts'
import type { AuditActor, AuditLog, StepupMethod } from './audit.ts'
import type { HostRelayDirectory } from './relay/directory.ts'

type NativeHost = Awaited<ReturnType<typeof startNativeHost>>
type RelayAddition = { base: string; input: RelayProfileInput; request: Omit<PendingRelay, 'profile'> }

/**
 * The phone-access lifecycle. The LAN listener binds a physical private address by itself and is open while the pairing
 * sheet has a QR out or a phone can use it; nothing turns it on but that. A listener fixed by the Host's start options
 * stays as it was started. The Host never returns relay registration keys or route seeds.
 */
export class NativeSettings {
  private changes = Promise.resolve()
  private opening = 0
  private lastPort = 0
  private adding = false
  constructor(
    private readonly options: {
      profiles: RelayProfiles
      native: NativeHost
      controller: HostRelayController
      audit: AuditLog
      directory?: HostRelayDirectory
      managedDirect?: { host: string; port: number }
      /** A QR is out, or a phone it let in has not finished. */
      pairing(): boolean
      /** A paired phone exists, or a removed one has yet to read its tombstone. */
      reachable(): boolean
      changed?(): void
      resolveDirect?(direct: NativeDirect, current: NativeDirect | null): Promise<NativeDirect | undefined>
    },
  ) {}
  info(deviceId?: string): NativeLinkInfo {
    const statuses = this.options.controller.status(),
      state = this.options.profiles.snapshot()
    return {
      version: 1,
      enabled: this.options.native.enabled,
      directManaged: Boolean(this.options.managedDirect),
      listening: this.options.native.direct,
      directory: Boolean(state.directory),
      official: {
        deployed: state.profiles.some(item => item.builtIn),
        enabled: !state.officialOff,
        ownFirst: Boolean(state.ownFirst),
        nodes: state.profiles
          .filter(item => item.builtIn)
          .map(item => {
            const status = statuses.find(value => value.relayId === item.relayId)
            return {
              relayId: item.relayId,
              region: item.region ?? '',
              status: status?.status ?? (state.officialOff ? 'off' : 'connecting'),
            }
          }),
      },
      ...(state.pendingRelay && deviceId
        ? {
            pendingRelay: {
              requestId: state.pendingRelay.requestId,
              url: state.pendingRelay.profile.url,
              canRetry: state.pendingRelay.deviceId === deviceId,
            },
          }
        : {}),
      relays: state.profiles
        .filter(item => !item.builtIn)
        .map(item => {
          const status = statuses.find(value => value.relayId === item.relayId)
          return {
            relayId: item.relayId,
            url: item.url,
            kind: item.kind ?? 'self',
            status: status?.status ?? 'connecting',
            ...(status?.retryAt === undefined ? {} : { retryAt: status.retryAt }),
            ...(status?.connectedAt === undefined ? {} : { connectedAt: status.connectedAt }),
          }
        }),
    }
  }
  /** Whether the listener should be open now. */
  wanted(): boolean {
    return this.opening > 0 || this.options.pairing() || this.options.reachable()
  }
  /** Whether the network watcher has anything to do for the lifecycle. */
  following(): boolean {
    return !this.options.managedDirect && (this.wanted() || this.options.native.direct !== null)
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.changes.then(operation)
    this.changes = result.then(
      () => {},
      () => {},
    )
    return result
  }
  private logical(): NativeDirect {
    return { host: 'auto', port: this.lastPort || this.options.profiles.snapshot().direct?.port || 0 }
  }
  private async bind(target: NativeDirect | undefined, current: () => boolean): Promise<void> {
    const before = this.options.native.direct
    // The remembered port may be taken by now; another port costs phones nothing, they find this Mac again.
    const prepared = await this.options.native.prepareBind(target).catch(error => {
      if (!target?.port || (error as { code?: unknown }).code !== 'native-listener-unavailable') throw error
      return this.options.native.prepareBind({ ...target, port: 0 })
    })
    if (!current()) {
      await prepared.cancel()
      return
    }
    prepared.commit()
    const bound = this.options.native.direct
    if (bound) this.lastPort = bound.port
    if (canonicalJson(before) !== canonicalJson(bound)) this.options.changed?.()
  }
  /** The network watcher's turn: follow the network and the lifecycle. */
  syncNetwork(snapshot: NativeNetworkSnapshot, current: () => boolean): Promise<void> {
    return this.serial(async () => {
      if (this.options.managedDirect || !current()) return
      await this.bind(this.wanted() ? selectAutoDirect(snapshot, this.logical(), this.options.native.direct) : undefined, current)
    })
  }
  /** Closes the listener once nobody wants it, whatever state the network component is in. */
  release(): Promise<void> {
    return this.serial(async () => {
      if (!this.options.managedDirect && !this.wanted() && this.options.native.direct) await this.bind(undefined, () => true)
    })
  }
  planRelay(requestId: string, deviceId: string, submitted?: RelayProfileInput): RelayAddition | undefined {
    const { profiles } = this.options
    const receipt = profiles.relayReceipt(requestId)
    const pending = profiles.snapshot().pendingRelay
    const requestHash = submitted === undefined ? undefined : sha256Hex(canonicalJson(submitted))
    if (receipt) {
      if (requestHash !== undefined && receipt.requestHash !== requestHash) throw this.relayConflict()
      if (receipt.cancelled) throw new AppError(409, 'native-relay-cancelled', '这次中继添加已放弃。')
      return undefined
    }
    if (pending) {
      if (pending.requestId !== requestId) throw new AppError(409, 'native-relay-pending', '请先继续或放弃未确认的中继。')
      if (pending.deviceId !== deviceId) throw new AppError(403, 'native-relay-owner', '请使用开始添加的设备继续。')
      if (requestHash !== undefined && pending.requestHash !== requestHash) throw this.relayConflict()
      const { registrationKey } = pending.profile
      return {
        base: profiles.configHash(),
        input: { ...relayNodeFields(pending.profile), ...(registrationKey ? { registrationKey } : {}) },
        request: { requestId, deviceId, requestHash: pending.requestHash },
      }
    }
    if (submitted === undefined || requestHash === undefined) throw new AppError(404, 'native-relay-request-missing', '没有找到这次添加。')
    profiles.assertNewRelay(submitted)
    return { base: profiles.configHash(), input: submitted, request: { requestId, deviceId, requestHash } }
  }
  private relayConflict(): AppError {
    return new AppError(409, 'request-conflict', '同一个请求标识不能用于不同的中继配置。')
  }
  async settleRelayWrite(): Promise<void> {
    const { profiles, directory } = this.options
    const hadDirectory = Boolean(profiles.snapshot().directory)
    if (!(await profiles.settleWrite())) return
    if (hadDirectory && !profiles.snapshot().directory) await directory?.configure()
    this.options.controller.reconcile()
    this.options.changed?.()
  }
  async addRelay(plan: RelayAddition, actor: AuditActor, stepup: StepupMethod, authorize: () => void): Promise<void> {
    if (this.adding) throw new AppError(409, 'native-relay-pending', '正在验证这次中继，请稍后继续。')
    const { profiles, controller, audit } = this.options
    this.adding = true
    try {
      authorize()
      await audit.append({
        action: 'native.relay.add.requested',
        actor,
        stepup,
        detail: { base: plan.base, profile: plan.request.requestHash },
      })
      const pending = await profiles.reserveRelay(plan.input, plan.request, plan.base, authorize)
      const current = () => {
        authorize()
        if (profiles.snapshot().pendingRelay?.requestId !== pending.requestId)
          throw new AppError(409, 'native-relay-cancelled', '这次中继添加已放弃。')
        if (profiles.configHash() !== plan.base) throw new AppError(409, 'native-config-changed', '手机连接配置已变化，请刷新后重试。')
      }
      const proof = await controller.verify(pending.profile, current).catch((error: unknown) => {
        if (error instanceof AppError) throw error
        throw new AppError(503, 'native-relay-unconfirmed', '无法确认中继可用。请核对地址、证书和注册令牌，再继续原请求或放弃。')
      })
      controller.rememberVerifiedRegistration(pending.profile, proof)
      await profiles.installRelay(pending, plan.base, () => {
        current()
        if (!proof.permitted()) throw new AppError(403, 'native-relay-egress', '当前的出站规则不允许连接这个中继。')
      })
      controller.reconcile()
      this.options.changed?.()
    } finally {
      this.adding = false
    }
  }
  async cancelRelay(requestId: string, actor: AuditActor, authorize: () => void, auditFailed?: () => void): Promise<{ audited: boolean }> {
    const { profiles, controller } = this.options
    const { cancelled, audited } = await profiles.cancelRelay(requestId, authorize, profile =>
      this.recordLowering({ action: 'native.relay.add.abandoned', actor, detail: { profile } }, auditFailed),
    )
    if (cancelled) controller.cancelVerification()
    return { audited }
  }
  removeRelay(relayId: string, actor: AuditActor, authorize: () => void, auditFailed?: () => void): Promise<{ audited: boolean }> {
    return this.lower(actor, { relayId }, authorize, auditFailed)
  }
  /** The official relay switch. Off only removes an observer; on restores the default. Both are audited. */
  setOfficial(
    change: { enabled?: boolean; ownFirst?: boolean },
    actor: AuditActor,
    authorize: () => void,
    auditFailed?: () => void,
  ): Promise<{ audited: boolean }> {
    return this.serial(async () => {
      const result = await this.options.profiles.setOfficial(change, authorize, detail =>
        this.recordLowering(
          { action: 'native.config.changed', actor, detail: { ...detail, lowering: change.enabled === false, direct: false } },
          auditFailed,
        ),
      )
      this.options.changed?.()
      this.options.controller.reconcile()
      return result
    })
  }
  removeDirectory(actor: AuditActor, authorize: () => void, auditFailed?: () => void): Promise<{ audited: boolean }> {
    return this.lower(actor, { directory: true }, authorize, auditFailed)
  }
  private lower(
    actor: AuditActor,
    target: { relayId: string } | { directory: true },
    authorize: () => void,
    auditFailed?: () => void,
  ): Promise<{ audited: boolean }> {
    return this.serial(async () => {
      const result = await this.options.profiles.removeObserver(target, authorize, detail =>
        this.recordLowering({ action: 'native.config.changed', actor, detail: { ...detail, lowering: true, direct: false } }, auditFailed),
      )
      if ('directory' in target) await this.options.directory?.configure()
      this.options.changed?.()
      this.options.controller.reconcile()
      return result
    })
  }
  private async recordLowering(entry: Parameters<AuditLog['append']>[0], auditFailed?: () => void): Promise<boolean> {
    try {
      await this.options.audit.append(entry)
      return true
    } catch {
      // Leave a trace before replacement can become visible, and never hold a reduction back on audit failure.
      auditFailed?.()
      return false
    }
  }
  /** Runs `issue` with the listener open, the sheet's first act: it fails with the reason when there is no network. */
  async whileOpen<T>(issue: () => Promise<T>): Promise<T> {
    if (this.options.managedDirect) return issue()
    this.opening++
    try {
      await this.serial(async () => {
        if (!this.options.resolveDirect) throw new AppError(409, 'native-no-lan', '这台 Mac 没有连接 Wi‑Fi 或有线网络。')
        const target = await this.options.resolveDirect(this.logical(), this.options.native.direct)
        if (!target) throw new AppError(409, 'native-no-lan', '这台 Mac 没有连接 Wi‑Fi 或有线网络。')
        await this.bind(target, () => true)
      })
      return await issue()
    } finally {
      this.opening--
    }
  }
}
