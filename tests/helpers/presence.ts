import type { PresenceAvailability, PresenceBackend, PresenceOutcome, PresencePreview } from '../../src/host/presence.ts'

/**
 * Test-only presence backend. It is injected through `startServer({ presence })` / `PresenceService`; nothing under
 * src/ or scripts/ imports it.
 */
export interface TestPresence extends PresenceBackend {
  readonly kind: 'test'
  mode: 'approve' | 'deny' | 'manual' | 'unavailable'
  method: 'biometric' | 'password'
  readonly requests: Array<{ preview: PresencePreview; previewHash: string; requireBiometric: boolean }>
  /** Manual mode: settle the oldest waiting request. */
  approveNext(): void
  denyNext(): void
  timeoutNext(): void
  /** Resolves with the next request not yet returned by an earlier call (in arrival order). */
  waitForRequest(timeoutMs?: number): Promise<{ preview: PresencePreview; previewHash: string }>
}

interface Waiting {
  preview: PresencePreview
  previewHash: string
  resolve: (outcome: PresenceOutcome) => void
}

export function createTestPresence(options: { mode?: TestPresence['mode']; method?: 'biometric' | 'password' } = {}): TestPresence {
  const waiting: Waiting[] = []
  const listeners: Array<() => void> = []
  let cursor = 0

  const settleNext = (outcome: (item: Waiting) => PresenceOutcome) => {
    const item = waiting.shift()
    if (!item) throw new Error('test presence: no request is waiting')
    item.resolve(outcome(item))
  }

  const presence: TestPresence = {
    kind: 'test',
    mode: options.mode ?? 'approve',
    method: options.method ?? 'biometric',
    requests: [],

    async availability(): Promise<PresenceAvailability> {
      return presence.mode === 'unavailable'
        ? { status: 'unavailable', reason: 'disabled', message: '测试中的本机确认不可用' }
        : { status: 'available', backend: 'test' }
    },

    confirm({ preview, previewHash, requireBiometric, signal }) {
      presence.requests.push({ preview, previewHash, requireBiometric })
      for (const notify of listeners.splice(0)) notify()
      if (signal.aborted) return Promise.resolve({ result: 'cancelled' })
      switch (presence.mode) {
        case 'approve': return Promise.resolve({ result: 'approved', method: presence.method, nonce: preview.nonce, previewHash })
        case 'deny': return Promise.resolve({ result: 'denied' })
        case 'unavailable': return Promise.resolve({ result: 'error', message: '测试中的本机确认不可用' })
        case 'manual': break
      }
      return new Promise<PresenceOutcome>(resolve => {
        const item: Waiting = { preview, previewHash, resolve: outcome => { signal.removeEventListener('abort', onAbort); resolve(outcome) } }
        const onAbort = () => {
          const index = waiting.indexOf(item)
          if (index >= 0) waiting.splice(index, 1)
          resolve({ result: 'cancelled' })
        }
        signal.addEventListener('abort', onAbort, { once: true })
        waiting.push(item)
      })
    },

    approveNext() { settleNext(item => ({ result: 'approved', method: presence.method, nonce: item.preview.nonce, previewHash: item.previewHash })) },
    denyNext() { settleNext(() => ({ result: 'denied' })) },
    timeoutNext() { settleNext(() => ({ result: 'timeout' })) },

    waitForRequest(timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        let finished = false
        const take = () => {
          const request = presence.requests[cursor]
          if (!request) return false
          cursor += 1
          finished = true
          clearTimeout(timer)
          resolve({ preview: request.preview, previewHash: request.previewHash })
          return true
        }
        const timer = setTimeout(() => { finished = true; reject(new Error('test presence: no confirmation request arrived')) }, timeoutMs)
        if (take()) return
        const listen = () => { if (!finished && !take()) listeners.push(listen) }
        listeners.push(listen)
      })
    },
  }
  return presence
}
