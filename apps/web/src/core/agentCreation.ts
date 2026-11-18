import { looksSecret, type CustomAgentCreate } from '@latch/protocol'
import { MessageError } from './api.ts'
import { markStorageDevice, storageDeviceCurrent, storageDeviceKey } from './deviceStorageScope.ts'
import { defineCopy } from './i18n.ts'

const COPY = defineCopy(
  {
    unsupportedBrowser: '这个浏览器无法协调多个窗口的创建请求，请使用支持此能力的浏览器。',
    notAllowed: '这台设备已不能创建 Agent。',
    pending: '先确认上一次创建的结果。',
    conflict: '同一个请求不能用于不同创建。',
    size: '创建请求太大，无法保留。',
  },
  {
    unsupportedBrowser: 'This browser can’t coordinate creation requests across windows. Use a browser that supports it.',
    notAllowed: 'This device can no longer create an Agent.',
    pending: 'Confirm the outcome of the last creation first.',
    conflict: 'The same request cannot create two different Agents.',
    size: 'The creation request is too large to keep.',
  },
)

const PREFIX = 'latch.agent-creation.'
const epochKey = (key: string) => `${key}.epoch`
const versions = new Map<string, number>()
const memory = new Map<string, { requestId: string; body: CustomAgentCreate }>()
const listeners = new Map<string, Set<() => void>>()
const requestId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/u.test(value)
const keyOf = (origin: string, device: string) => `${PREFIX}${origin}.${device}`
const announce = (key: string) => listeners.get(key)?.forEach(listener => listener())

export interface AgentCreationToken {
  readonly requestId: string
  /** Local identity of the exact stored record; never serialized or sent to the Host. */
  readonly record: object
}

export interface PendingAgentCreation {
  requestId: string
  unread?: true
  unavailable?: true
  token?: AgentCreationToken
  /** Absent after reloading a request whose private body was kept only in memory. */
  body?: CustomAgentCreate
}

function readBody(value: unknown, id: string): CustomAgentCreate | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const body = value as Record<string, unknown>
  if (
    body.requestId !== id
    || typeof body.name !== 'string'
    || typeof body.harnessId !== 'string'
    || typeof body.instructions !== 'string'
    || !Array.isArray(body.skills)
    || !body.skills.every(item => typeof item === 'string')
  )
    return undefined
  const raw = JSON.stringify(body)
  if (raw.length > 128_000 || looksSecret(raw)) return undefined
  // This body is only replayed at the fixed create endpoint; the Host remains its schema and authorization boundary.
  return body as unknown as CustomAgentCreate
}

/** A private creation request, persisted before sending and never expired or retried automatically. */
export class AgentCreation {
  private readonly key: string
  private readonly epoch: string | null
  private readonly version: number
  private observed: string | undefined
  private identity: object = {}
  constructor(
    private readonly origin: string,
    private readonly device: string,
    private readonly allowed: boolean,
  ) {
    this.key = keyOf(origin, device)
    this.version = versions.get(this.key) ?? 0
    try {
      this.epoch = localStorage.getItem(epochKey(this.key))
    } catch {
      this.epoch = null
    }
  }
  current(): boolean {
    if (!this.allowed || this.version !== (versions.get(this.key) ?? 0)) return false
    try {
      return storageDeviceCurrent(this.origin, this.device) && localStorage.getItem(epochKey(this.key)) === this.epoch
    } catch {
      return false
    }
  }
  read(): PendingAgentCreation | null {
    if (!this.current()) return null
    let raw: string | null = null
    try {
      raw = localStorage.getItem(this.key)
      if (raw === null) {
        memory.delete(this.key)
        this.observed = undefined
        return null
      }
      const unread = () => ({ requestId: '无法读取', unread: true as const, token: this.token('无法读取', raw!) })
      if (raw.length > 128_000) return unread()
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return unread()
      const entry = parsed as Record<string, unknown>
      if (entry.version !== 1 || !requestId(entry.requestId)) return unread()
      const kept = memory.get(this.key)
      const body = kept?.requestId === entry.requestId ? kept.body : readBody(entry.body, entry.requestId)
      return { requestId: entry.requestId, token: this.token(entry.requestId, raw), ...(body ? { body } : {}) }
    } catch {
      return raw === null
        ? { requestId: '无法读取', unread: true, unavailable: true }
        : { requestId: '无法读取', unread: true, token: this.token('无法读取', raw) }
    }
  }
  private token(id: string, raw: string): AgentCreationToken {
    if (this.observed !== raw) {
      this.observed = raw
      this.identity = {}
    }
    return { requestId: id, record: this.identity }
  }
  subscribe(listener: () => void): () => void {
    const group = listeners.get(this.key) ?? new Set<() => void>()
    group.add(listener)
    listeners.set(this.key, group)
    const changed = (event: StorageEvent) => {
      if (event.key === this.key && event.oldValue !== event.newValue && event.newValue !== this.observed) this.observed = undefined
      if (event.key === null || [this.key, epochKey(this.key), storageDeviceKey(this.origin)].includes(event.key)) listener()
    }
    window.addEventListener('storage', changed)
    return () => {
      group.delete(listener)
      if (!group.size) listeners.delete(this.key)
      window.removeEventListener('storage', changed)
    }
  }
  /** The browser lock covers admission and the response, so another window cannot replace an in-flight request. */
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (!navigator.locks?.request) throw new MessageError(() => COPY.unsupportedBrowser)
    return navigator.locks.request(this.key, async () => {
      if (!this.current()) throw new MessageError(() => COPY.notAllowed)
      return work()
    })
  }
  begin(body: CustomAgentCreate): void {
    if (!this.current()) throw new MessageError(() => COPY.notAllowed)
    const pending = this.read()
    if (pending && pending.requestId !== body.requestId) throw new MessageError(() => COPY.pending)
    if (pending?.body && JSON.stringify(pending.body) !== JSON.stringify(body)) throw new MessageError(() => COPY.conflict)
    const raw = JSON.stringify(body)
    if (!requestId(body.requestId) || raw.length > 128_000) throw new MessageError(() => COPY.size)
    const retained = JSON.parse(raw) as CustomAgentCreate
    const safe = !looksSecret(raw)
    // A marker is required even for secret text: a reload must not silently forget an uncertain write.
    localStorage.setItem(this.key, JSON.stringify({ version: 1, requestId: body.requestId, ...(safe ? { body: retained } : {}) }))
    memory.set(this.key, { requestId: body.requestId, body: retained })
    announce(this.key)
  }
  finish(id: string): boolean {
    const pending = this.read()
    if (!this.current() || pending?.unavailable || pending?.requestId !== id) return false
    localStorage.removeItem(this.key)
    memory.delete(this.key)
    this.observed = undefined
    announce(this.key)
    return true
  }
  /** The decision belongs to the record the person saw before waiting for the cross-window lock. */
  abandon(expected: AgentCreationToken): boolean {
    const now = this.read()?.token
    return now?.record === expected.record && now.requestId === expected.requestId && this.finish(expected.requestId)
  }
}

/** Revocation makes old callbacks inert before attempting storage cleanup, including when the storage is full. */
export function forgetAgentCreations(origin: string, keep?: string): void {
  markStorageDevice(origin, keep)
  const prefix = `${PREFIX}${origin}.`
  const keys = new Set([...memory.keys(), ...listeners.keys()])
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (key?.startsWith(prefix) && !key.endsWith('.epoch')) keys.add(key)
    }
  } catch {
    /* The in-memory records still get revoked. */
  }
  for (const key of keys) if (key.startsWith(prefix) && key !== (keep ? keyOf(origin, keep) : undefined)) revoke(key)
  markStorageDevice(origin, keep)
}

export function forgetPrivateAgentCreation(origin: string, device: string): void {
  revoke(keyOf(origin, device))
}

function revoke(key: string): void {
  versions.set(key, (versions.get(key) ?? 0) + 1)
  memory.delete(key)
  try {
    localStorage.removeItem(key)
  } catch {
    /* Access is already revoked in this window. */
  }
  try {
    localStorage.setItem(epochKey(key), crypto.randomUUID())
  } catch {
    /* Blocked storage cannot restore the body. */
  }
  announce(key)
}
