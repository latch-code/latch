import { networkInterfaces } from 'node:os'
import { z } from 'zod'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import type { NativeLinkInfo } from '@latch/protocol'
import type { AuditActor, AuditLog, StepupMethod } from './audit.ts'
import type { startNativeHost } from './native.ts'
import type { HostRelayController } from './relay/controller.ts'
import { selectAutoDirect } from './native-network.ts'
import type { NativeNetworkSnapshot } from './native-network-backend.ts'
import { RelayProfiles, relayProfileInput, nativeDirectSchema, type NativeDirect } from './relay/profiles.ts'

export function nativeAddresses(): NativeLinkInfo['addresses'] {
  return Object.entries(networkInterfaces())
    .flatMap(([name, list]) =>
      (list ?? [])
        .filter(
          item =>
            !item.internal
            && (/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)/u.test(item.address)
              || /^f[cd][a-f0-9]{2}:/iu.test(item.address)),
        )
        .map(item => ({ address: item.address, interface: name })),
    )
    .slice(0, 16)
}
const inputSchema = z.strictObject({
  requestId: z.uuid(),
  configHash: z.string().regex(/^[a-f0-9]{64}$/u),
  direct: nativeDirectSchema.nullable(),
  relays: z.array(relayProfileInput).max(4),
})
type NativeHost = Awaited<ReturnType<typeof startNativeHost>>

/** Durable settings and the listening socket commit together. The renderer never receives transport secrets. */
export class NativeSettings {
  private changes = Promise.resolve()
  constructor(
    private readonly options: {
      profiles: RelayProfiles
      native: NativeHost
      controller: HostRelayController
      audit: AuditLog
      managedDirect?: { host: string; port: number }
      inputsPaused(): boolean
      changed?(): void
      resolveDirect?(direct: NativeDirect | null): Promise<NativeDirect | undefined>
    },
  ) {}
  info(): NativeLinkInfo {
    const state = this.options.profiles.snapshot(),
      statuses = this.options.controller.status()
    return {
      version: 1,
      configHash: this.options.profiles.configHash(),
      enabled: this.options.native.enabled,
      direct: this.options.managedDirect ?? state.direct ?? null,
      listening: this.options.native.direct,
      directManaged: Boolean(this.options.managedDirect),
      addresses: nativeAddresses(),
      inputsPaused: this.options.inputsPaused(),
      relays: state.profiles.map(item => {
        const status = statuses.find(value => value.relayId === item.relayId)
        return {
          relayId: item.relayId,
          url: item.url,
          spkiHash: item.spkiHash,
          hasRegistrationKey: Boolean(item.registrationKey),
          status: status?.status ?? 'connecting',
          ...(status?.retryAt === undefined ? {} : { retryAt: status.retryAt }),
        }
      }),
    }
  }
  alreadyApplied(raw: unknown): boolean {
    const input = inputSchema.parse(raw),
      receipt = this.options.profiles.configReceipt(input.requestId)
    if (!receipt) return false
    if (receipt !== sha256Hex(canonicalJson(input))) throw new AppError(409, 'request-id-conflict', '这个请求编号已用于其他手机连接配置')
    return true
  }
  plan(raw: unknown) {
    const input = inputSchema.parse(raw),
      state = this.options.profiles.snapshot(),
      baseHash = this.options.profiles.configHash()
    if (input.configHash !== baseHash) throw new AppError(409, 'native-config-changed', '手机连接配置已变化，请刷新后重试')
    if (new Set(input.relays.map(item => item.relayId)).size !== input.relays.length)
      throw new AppError(400, 'native-relay-duplicate', '每个中继节点只能添加一次')
    const direct = this.options.managedDirect ? (state.direct ?? null) : input.direct
    if (this.options.managedDirect && canonicalJson(input.direct) !== canonicalJson(this.options.managedDirect))
      throw new AppError(409, 'native-managed', '直连入口由启动参数管理，请停止 Host 后修改启动参数')
    if (!this.options.managedDirect && direct && direct.host !== 'auto' && !nativeAddresses().some(item => item.address === direct.host))
      throw new AppError(400, 'native-address-unavailable', '请选择这台电脑当前的局域网地址')
    const lowering =
      (direct === null || canonicalJson(direct) === canonicalJson(state.direct ?? null))
      && input.relays.every(item => {
        const old = state.profiles.find(value => value.relayId === item.relayId)
        return (
          old
          && item.url === old.url
          && item.spkiHash === old.spkiHash
          && (item.registrationKey === undefined || item.registrationKey === null || item.registrationKey === old.registrationKey)
        )
      })
    const afterHash = sha256Hex(canonicalJson({ direct, relays: input.relays }))
    return { input, direct, baseHash, afterHash, lowering, requestHash: sha256Hex(canonicalJson(input)) }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.changes.then(operation)
    this.changes = result.then(
      () => {},
      () => {},
    )
    return result
  }
  syncNetwork(snapshot: NativeNetworkSnapshot, current: () => boolean): Promise<void> {
    return this.serial(async () => {
      const config = this.options.profiles.snapshot().direct
      if (this.options.managedDirect || config?.host !== 'auto' || !current()) return
      const hash = this.options.profiles.configHash(),
        before = this.options.native.direct
      const prepared = await this.options.native.prepareBind(selectAutoDirect(snapshot, config, before))
      if (!current() || this.options.profiles.configHash() !== hash) {
        await prepared.cancel()
        return
      }
      prepared.commit()
      if (canonicalJson(before) !== canonicalJson(this.options.native.direct)) this.options.changed?.()
    })
  }
  apply(
    plan: ReturnType<NativeSettings['plan']>,
    actor: AuditActor,
    stepup: StepupMethod,
    recheck: () => void,
  ): Promise<{ audited: boolean }> {
    return this.serial(() => this.applyNow(plan, actor, stepup, recheck))
  }
  private async applyNow(
    plan: ReturnType<NativeSettings['plan']>,
    actor: AuditActor,
    stepup: StepupMethod,
    recheck: () => void,
  ): Promise<{ audited: boolean }> {
    recheck()
    if (this.alreadyApplied(plan.input)) return { audited: true }
    if (!plan.lowering && stepup === 'none') throw new AppError(403, 'stepup-required', '需要在 Mac 确认手机连接配置')
    if (this.options.profiles.configHash() !== plan.baseHash)
      throw new AppError(409, 'native-config-changed', '手机连接配置已变化，请刷新后重试')
    recheck()
    let sequence: number | undefined,
      audited = true
    try {
      sequence = (
        await this.options.audit.append({
          action: 'native.config.changed',
          actor,
          stepup,
          detail: {
            before: plan.baseHash,
            after: plan.afterHash,
            lowering: plan.lowering,
            direct: Boolean(plan.direct),
            relayCount: plan.input.relays.length,
          },
        })
      ).seq
    } catch (error) {
      if (!plan.lowering) throw error
      audited = false
    }
    let prepared: Awaited<ReturnType<NativeHost['prepareBind']>> | undefined
    try {
      if (!plan.lowering && (plan.input.relays.length || plan.direct)) await this.options.native.ensureTransport()
      const logical = this.options.managedDirect ?? plan.direct
      let actual = logical ?? undefined
      if (logical?.host === 'auto') {
        if (plan.lowering) actual = this.options.native.direct ?? undefined
        else {
          if (!this.options.resolveDirect)
            throw new AppError(503, 'native-network-unavailable', '手机连接组件不可用，请更新并重新构建 Latch 后重试')
          actual = await this.options.resolveDirect(logical)
        }
      }
      prepared = await this.options.native.prepareBind(actual)
      recheck()
      await this.options.profiles.configure(plan.direct, plan.input.relays, plan.baseHash, {
        requestId: plan.input.requestId,
        requestHash: plan.requestHash,
      })
      prepared.commit()
      this.options.changed?.()
      this.options.controller.reconcile()
      return { audited }
    } catch (error) {
      await prepared?.cancel()
      if (sequence !== undefined)
        await this.options.audit.append({ action: 'action.failed', actor, detail: { refSeq: sequence } }).catch(() => {})
      throw error
    }
  }
}
