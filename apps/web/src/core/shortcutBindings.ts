import { useSyncExternalStore } from 'react'
import {
  SHORTCUTS_SCHEMA,
  effectiveShortcuts,
  type ShortcutAction,
  type ShortcutChord,
  type ShortcutClient,
  type ShortcutsDocument,
  type ShortcutsReceipt,
  type ShortcutsState,
} from '@latch/protocol'
import { api, ApiError, errorMessage, isUncertain, MessageError, newRequestId } from './api.ts'
import { currentShell } from './shell.ts'
import { defineCopy } from './i18n.ts'

const COPY = defineCopy(
  {
    missingReceipt: '没有收到这次快捷键修改的回执。',
    expired: '这次请求已无法重放，可以放弃等待。',
  },
  {
    missingReceipt: 'No receipt for this shortcut change.',
    expired: 'This request can’t be replayed. You can stop waiting.',
  },
)

/*
 * This device's key bindings (docs/CUSTOMIZATION.md#快捷键), as the Host keeps them for it. Until the Host answers, and
 * on a Host without the feature, every action has its default. A write whose answer did not come keeps its request, for
 * this Host and device, until it is retried with the same ID or given up.
 */

export type Bindings = Partial<Record<ShortcutAction, ShortcutChord>>
type Request = { kind: 'apply'; doc: ShortcutsDocument } | { kind: 'reset' }
type Pending = {
  request: Request & { requestId: string; baseRevision: number }
  sending: boolean
  unknown?: { retryable: boolean; text: string }
}
export type BindingWrite = { kind: 'done' | 'unknown' | 'busy' } | { kind: 'refused'; text: string }
export interface BindingsView {
  identity: string | null
  state: ShortcutsState
  pending: Pending | undefined
}

export const clientKind = (): ShortcutClient => (currentShell() !== null ? 'desktop' : 'browser')

async function send(request: Pending['request']): Promise<ShortcutsReceipt> {
  const { kind, ...body } = request
  const receipt = await api<ShortcutsReceipt>(kind === 'apply' ? 'shortcuts' : 'shortcuts/reset', { method: 'POST', body })
  if (receipt?.requestId !== request.requestId) throw new MessageError(() => COPY.missingReceipt)
  return receipt
}

export class ShortcutBindings {
  private view: BindingsView = { identity: null, state: { revision: 0, doc: null }, pending: undefined }
  private readonly pendings = new Map<string, Pending>()
  private readonly listeners = new Set<() => void>()
  private loading = 0

  constructor(
    private readonly sendRequest = send,
    private readonly read = (signal?: AbortSignal) => api<ShortcutsState>('shortcuts', signal ? { signal } : {}),
    private readonly client = clientKind,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  snapshot = (): BindingsView => this.view

  /** The bindings that apply here: the Host's document for this kind of client, else none (every default). */
  bindings(): Bindings {
    const doc = this.view.state.doc
    return doc && doc.client === this.client() ? doc.bindings : {}
  }

  effective(): Map<ShortcutAction, ShortcutChord> {
    return effectiveShortcuts(this.client(), this.bindings())
  }

  /** Reads this device's bindings from the Host it is now connected to; another Host or device starts from the defaults. */
  async load(identity: { hostId: string; deviceId: string } | null, enabled: boolean): Promise<void> {
    const key = identity ? JSON.stringify([identity.hostId, identity.deviceId]) : null
    if (key !== this.view.identity)
      this.set({ identity: key, state: { revision: 0, doc: null }, pending: key ? this.pendings.get(key) : undefined })
    if (!key || !enabled) return
    const ticket = ++this.loading
    try {
      const state = await this.read()
      if (ticket === this.loading && this.view.identity === key) this.set({ ...this.view, state })
    } catch {
      // The defaults stand until the next read.
    }
  }

  /** Saves `bindings` (only the actions moved off their defaults) as this device's document. */
  apply(bindings: Bindings): Promise<BindingWrite> {
    const doc: ShortcutsDocument = { schema: SHORTCUTS_SCHEMA, client: this.client(), bindings }
    return this.submit({ kind: 'apply', doc })
  }

  reset(): Promise<BindingWrite> {
    return this.submit({ kind: 'reset' })
  }

  retry(): Promise<BindingWrite> {
    const pending = this.view.pending
    if (!pending?.unknown?.retryable || pending.sending) return Promise.resolve({ kind: 'busy' })
    return this.send({ ...pending, sending: true })
  }

  abandon(): void {
    const pending = this.view.pending
    if (pending?.unknown && !pending.sending) this.setPending(undefined)
  }

  private submit(request: Request): Promise<BindingWrite> {
    if (!this.view.identity || this.view.pending) return Promise.resolve({ kind: 'busy' })
    return this.send({
      request: { ...structuredClone(request), requestId: newRequestId(), baseRevision: this.view.state.revision },
      sending: true,
    })
  }

  private async send(pending: Pending): Promise<BindingWrite> {
    const identity = this.view.identity
    this.setPending(pending)
    try {
      const receipt = await this.sendRequest(pending.request)
      if (this.view.identity === identity)
        this.set({ ...this.view, state: { revision: receipt.revision, doc: receipt.doc }, pending: undefined })
      if (identity) this.pendings.delete(identity)
      return { kind: 'done' }
    } catch (error) {
      const code = error instanceof ApiError ? error.code : undefined
      const definite = code === 'shortcuts-write-pending' || code === 'shortcuts-write-unavailable'
      const conflict = code === 'shortcuts-conflict' || code === 'request-id-reused'
      if (pending.unknown || (!definite && isUncertain(error))) {
        const text = conflict ? COPY.expired : errorMessage(error)
        if (this.view.identity === identity) this.setPending({ ...pending, sending: false, unknown: { retryable: !conflict, text } })
        return { kind: 'unknown' }
      }
      if (this.view.identity === identity) this.setPending(undefined)
      if (conflict) void this.load(this.identityOf(identity), true)
      return { kind: 'refused', text: errorMessage(error) }
    }
  }

  private identityOf(key: string | null): { hostId: string; deviceId: string } | null {
    if (!key) return null
    const [hostId, deviceId] = JSON.parse(key) as [string, string]
    return { hostId, deviceId }
  }

  private setPending(pending: Pending | undefined): void {
    const key = this.view.identity
    if (key) {
      if (pending) this.pendings.set(key, pending)
      else this.pendings.delete(key)
    }
    this.set({ ...this.view, pending })
  }

  private set(view: BindingsView): void {
    this.view = view
    for (const listener of this.listeners) listener()
  }
}

/** The page's one store. */
export const shortcutBindings = new ShortcutBindings()

/** Re-renders with every change of this device's bindings; what prints a shortcut calls it. */
export function useShortcutBindings(): BindingsView {
  return useSyncExternalStore(shortcutBindings.subscribe, shortcutBindings.snapshot, shortcutBindings.snapshot)
}
