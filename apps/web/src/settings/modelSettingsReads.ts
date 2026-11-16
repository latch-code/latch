import type { AppSnapshot, ModelSpend, ModelUsageSummary, UsageGroup, UsagePeriod, UsageSummary } from '@latch/protocol'
import { ApiError } from '../core/api.ts'
import { hostView, type DeviceAccess } from '../core/permissions.ts'
import type { ProvidersResponse } from '../core/providerSetup.ts'

/** The last successful reads stay in this one settings visit, even while a tab is unmounted. */
export class ModelSettingsReads {
  #providers: ProvidersResponse | undefined
  #providersVersion = 0
  #providerListeners = new Set<() => void>()
  #spend: ModelSpend | undefined
  #period: UsagePeriod = 'month'
  #group: UsageGroup = 'service'
  #days: 7 | 30 = 7
  readonly legacyUsage = new Map<7 | 30, UsageSummary>()
  readonly usage = new Map<`${UsagePeriod}:${UsageGroup}`, ModelUsageSummary>()

  constructor(readonly audience: string) {}

  get providersVersion() {
    return this.#providersVersion
  }

  readonly providers = () => this.#providers

  readonly subscribeProviderChanges = (listener: () => void) => {
    this.#providerListeners.add(listener)
    return () => {
      this.#providerListeners.delete(listener)
    }
  }

  /** A write reply confirms an operation. The current configuration comes from a subsequent GET. */
  providersChanged() {
    this.#providersVersion++
    for (const listener of this.#providerListeners) listener()
  }

  keepProviders(value: ProvidersResponse | undefined, fromVersion = this.#providersVersion) {
    if (fromVersion !== this.#providersVersion) return false
    this.#providersVersion++
    this.#providers = value
    return true
  }

  get spend() {
    return this.#spend
  }

  keepSpend(value: ModelSpend | undefined) {
    this.#spend = value
  }

  get period() {
    return this.#period
  }

  get group() {
    return this.#group
  }

  keepUsageChoice(period: UsagePeriod, group: UsageGroup) {
    this.#period = period
    this.#group = group
  }

  get days() {
    return this.#days
  }

  keepLegacyUsageChoice(days: 7 | 30) {
    this.#days = days
  }
}

/** These reads belong to the current settings visit and the authority that supplied its snapshot. */
export function settingsReadAudience(snapshot: AppSnapshot, access: DeviceAccess): string {
  return JSON.stringify([
    hostView(snapshot)?.hostId,
    snapshot.instanceId,
    snapshot.device.id,
    snapshot.device.dataScope,
    snapshot.device.status,
    access.legacy,
    access.local,
    access.admin,
    [...access.scopes].toSorted(),
    !!snapshot.catalog,
    snapshot.catalog?.features?.usage === true,
    snapshot.catalog?.features?.modelUsage === true,
    snapshot.catalog?.features?.providerUpdateTarget === true,
  ])
}

export const readDenied = (cause: unknown) => cause instanceof ApiError && (cause.status === 401 || cause.status === 403)
