import { escapeSecurityText } from '@latch/protocol'
import { api, auditFailed, ClientError } from './api.ts'
import { keyScopeOf, shownAddress } from './providerSetup.ts'
import { LIMIT_COPY } from './securityCopy.ts'

/**
 * What this page reads from `GET /policy` to say what the Host enforces. It is a statement, not the rule: the Host checks
 * every limit again on each request, whatever is shown here.
 */
export interface PolicyView {
  local: { maxLevel: string; allowL3: boolean }
  remote: { maxLevel: string; harnesses: string[] | null; workspaces: string[] | null }
  hostEgressAllow: string[]
  confirmedAddresses: string[]
}

const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')

function viewOf(body: unknown): PolicyView {
  const policy = (body as { policy?: Record<string, unknown> } | null)?.policy
  const local = policy?.local as Record<string, unknown> | undefined
  const remote = policy?.remote as Record<string, unknown> | undefined
  const addresses = policy?.confirmedAddresses ?? []
  if (
    typeof local?.maxLevel !== 'string'
    || typeof local.allowL3 !== 'boolean'
    || typeof remote?.maxLevel !== 'string'
    || !(remote.harnesses === null || stringList(remote.harnesses))
    || !(remote.workspaces === null || stringList(remote.workspaces))
    || !stringList(policy?.hostEgressAllow)
    || !stringList(addresses)
  )
    throw new ClientError('读不懂这台 Mac 返回的设置，请刷新后重试。', 'policy-unreadable')
  return {
    local: { maxLevel: local.maxLevel, allowL3: local.allowL3 },
    remote: { maxLevel: remote.maxLevel, harnesses: remote.harnesses, workspaces: remote.workspaces },
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

export interface LimitRow {
  id: string
  title: string
  description: string
}

const namesOf = (ids: readonly string[], known: ReadonlyArray<{ id: string; name: string }>): string => {
  const names = ids.flatMap(id => {
    const found = known.find(item => item.id === id)
    return found ? [escapeSecurityText(found.name)] : []
  })
  const missing = ids.length - names.length
  return [...names, ...(missing > 0 ? [LIMIT_COPY.unknownEntries(missing)] : [])].join('、')
}

/**
 * The limits that differ from a new Host's, in words. Defaults say nothing: `remote.allowRemoteStart` has its own row,
 * and a Host at its defaults shows no limits at all. A wider value is listed as well, since a person should see that too.
 */
export function limitRows(
  policy: Pick<PolicyView, 'local' | 'remote'>,
  catalog: { harnesses: ReadonlyArray<{ id: string; name: string }>; workspaces: ReadonlyArray<{ id: string; name: string }> },
): LimitRow[] {
  const rows: LimitRow[] = []
  const projects = catalog.workspaces.map(item => (item.id === 'default' ? { ...item, name: LIMIT_COPY.noProject } : item))
  if (!policy.local.allowL3) rows.push({ id: 'local-full', ...LIMIT_COPY.noFullAccess })
  // Sessions ask at L1 and nothing runs above it without full access, so L0 is the only level that refuses anything.
  if (policy.local.maxLevel === 'L0') rows.push({ id: 'local-level', ...LIMIT_COPY.localReadOnly })
  if (policy.remote.maxLevel === 'L0') rows.push({ id: 'remote-level', ...LIMIT_COPY.remoteReadOnly })
  const engines = policy.remote.harnesses
  if (engines === null) rows.push({ id: 'remote-engines', ...LIMIT_COPY.anyEngine })
  else if (engines.length === 0) rows.push({ id: 'remote-engines', ...LIMIT_COPY.noEngine })
  else if (engines.length !== 1 || engines[0] !== 'standard')
    rows.push({ id: 'remote-engines', ...LIMIT_COPY.someEngines(namesOf(engines, catalog.harnesses)) })
  const listed = policy.remote.workspaces
  if (listed?.length === 0) rows.push({ id: 'remote-projects', ...LIMIT_COPY.noProjects })
  else if (listed) rows.push({ id: 'remote-projects', ...LIMIT_COPY.someProjects(namesOf(listed, projects)) })
  return rows
}
