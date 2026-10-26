import type { HostView } from '@latch/protocol'
import type { DeviceAccess } from './permissions.ts'

export interface ProviderAbilities {
  keys: boolean
  confirm: boolean
  offline: boolean
  presenceBroken?: string
}

/** Display-only capabilities shared by the inline form and settings; Host authorization stays authoritative. */
export function providerAbilities(
  access: Pick<DeviceAccess, 'legacy' | 'local'>,
  presence: HostView['presence'] | undefined,
): ProviderAbilities {
  const desktop = access.legacy || access.local
  const broken =
    presence?.status === 'unavailable'
    && (presence.reason === 'helper-missing' || presence.reason === 'helper-signature' || presence.reason === 'cdhash-mismatch')
  return {
    keys: desktop,
    confirm: desktop && presence?.status !== 'unavailable',
    offline: !access.legacy && access.local && presence?.status === 'unavailable',
    ...(broken && presence.message ? { presenceBroken: presence.message } : {}),
  }
}
