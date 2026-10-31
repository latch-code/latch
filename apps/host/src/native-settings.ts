import type { NativeLinkInfo } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson } from '@latch/core/node-kit'
import type { startNativeHost } from './native.ts'
import type { HostRelayController } from './relay/controller.ts'
import { selectAutoDirect } from './native-network.ts'
import type { NativeNetworkSnapshot } from './native-network-backend.ts'
import type { RelayProfiles, NativeDirect } from './relay/profiles.ts'
import type { AuditActor, AuditLog } from './audit.ts'
import type { HostRelayDirectory } from './relay/directory.ts'

type NativeHost = Awaited<ReturnType<typeof startNativeHost>>

/**
 * The phone-access lifecycle. The LAN listener binds a physical private address by itself and is open while the pairing
 * sheet has a QR out or a phone can use it; nothing turns it on but that. A listener fixed by the Host's start options
 * stays as it was started. The renderer never receives transport secrets.
 */
export class NativeSettings {
  private changes = Promise.resolve()
  private opening = 0
  private lastPort = 0
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
  info(): NativeLinkInfo {
    const statuses = this.options.controller.status(),
      state = this.options.profiles.snapshot()
    return {
      version: 1,
      enabled: this.options.native.enabled,
      directManaged: Boolean(this.options.managedDirect),
      listening: this.options.native.direct,
      directory: Boolean(state.directory),
      relays: state.profiles
        .filter(item => !item.builtIn)
        .map(item => {
          const status = statuses.find(value => value.relayId === item.relayId)
          return {
            relayId: item.relayId,
            url: item.url,
            status: status?.status ?? 'connecting',
            ...(status?.retryAt === undefined ? {} : { retryAt: status.retryAt }),
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
  /** Saved custom relays and the address directory have no form until relay links exist; taking one away stays possible. */
  removeRelay(relayId: string, actor: AuditActor): Promise<{ audited: boolean }> {
    return this.lower(actor, input => input.filter(item => item.relayId !== relayId))
  }
  removeDirectory(actor: AuditActor): Promise<{ audited: boolean }> {
    return this.lower(actor, input => input, null)
  }
  private lower(
    actor: AuditActor,
    edit: (custom: Array<{ relayId: string; url: string; spkiHash: string }>) => Array<{ relayId: string; url: string; spkiHash: string }>,
    directory?: null,
  ): Promise<{ audited: boolean }> {
    return this.serial(async () => {
      const state = this.options.profiles.snapshot(),
        before = this.options.profiles.configHash(),
        custom = state.profiles.filter(item => !item.builtIn).map(({ relayId, url, spkiHash }) => ({ relayId, url, spkiHash })),
        kept = edit(custom)
      await this.options.profiles.configure(state.direct ?? null, kept, undefined, undefined, directory)
      if (directory === null) await this.options.directory?.configure()
      this.options.changed?.()
      this.options.controller.reconcile()
      let audited = true
      // A removal only takes an observer away, so a failed record does not stop it.
      await this.options.audit
        .append({
          action: 'native.config.changed',
          actor,
          detail: { before, after: this.options.profiles.configHash(), lowering: true, direct: false, relayCount: kept.length },
        })
        .catch(() => {
          audited = false
        })
      return { audited }
    })
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
