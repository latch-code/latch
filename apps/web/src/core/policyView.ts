import { api, auditFailed, ClientError } from './api.ts'
import { keyScopeOf, shownAddress } from './providerSetup.ts'

/**
 * What this page reads from `GET /policy` to say what the Host enforces. It is a statement, not the rule: the Host checks
 * every limit again on each request, whatever is shown here.
 */
export interface PolicyView {
  hostEgressAllow: string[]
  confirmedAddresses: string[]
}

const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')

function viewOf(body: unknown): PolicyView {
  const policy = (body as { policy?: Record<string, unknown> } | null)?.policy
  const addresses = policy?.confirmedAddresses ?? []
  if (!stringList(policy?.hostEgressAllow) || !stringList(addresses))
    throw new ClientError('读不懂这台 Mac 返回的设置，请刷新后重试。', 'policy-unreadable')
  return {
    hostEgressAllow: policy.hostEgressAllow,
    confirmedAddresses: addresses,
  }
}

export async function readPolicy(): Promise<PolicyView> {
  return viewOf(await api<unknown>('policy'))
}

/** Taking an address or an allowance away is a tightening: the Host asks for no confirmation and applies it even when its record fails. */
export async function removeFromPolicy(input: { address?: string; allowance?: string }): Promise<{ auditFailed: boolean }> {
  let failed = false
  await api<unknown>('policy', {
    method: 'PATCH',
    body: {
      ...(input.address ? { confirmedAddresses: { remove: [input.address] } } : {}),
      ...(input.allowance ? { hostEgressAllow: { remove: [input.allowance] } } : {}),
    },
    onHeaders: headers => {
      failed = auditFailed(headers)
    },
  })
  return { auditFailed: failed }
}

const hostPortOf = (address: string): string | undefined => /^https?:\/\/([^/]+)/u.exec(address)?.[1]

export interface AddressRow {
  /** Exactly as the policy holds it, what a removal names. */
  address: string
  shown: string
  services: string[]
  /** The allowance that goes with it: its `host:port`, when no other confirmed address needs that too. */
  allowance?: string
}

/** Each confirmed address with the services at it, then allowances no confirmed address accounts for. */
export function addressRows(
  policy: Pick<PolicyView, 'confirmedAddresses' | 'hostEgressAllow'>,
  providers: ReadonlyArray<{ name: string; baseURL: string }>,
): { addresses: AddressRow[]; allowances: string[] } {
  const hostPorts = policy.confirmedAddresses.map(hostPortOf)
  const addresses = policy.confirmedAddresses.map((address, index) => {
    const hostPort = hostPorts[index]
    const shared = hostPorts.some((other, position) => position !== index && other === hostPort)
    return {
      address,
      shown: shownAddress(address),
      services: providers.filter(provider => keyScopeOf(provider.baseURL) === address).map(provider => provider.name),
      ...(hostPort && !shared && policy.hostEgressAllow.includes(hostPort) ? { allowance: hostPort } : {}),
    }
  })
  return { addresses, allowances: policy.hostEgressAllow.filter(entry => !hostPorts.includes(entry)) }
}
