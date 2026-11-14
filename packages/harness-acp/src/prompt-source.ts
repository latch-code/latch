import { AsyncLocalStorage } from 'node:async_hooks'

interface PromptIdentity {
  method: 'create' | 'prompt' | 'steer'
  requestId: string
  sessionId?: string
}

const sources = new AsyncLocalStorage<PromptIdentity & { text: string }>()

/** Host-only provenance, before notes or history are added. It never joins an RPC, receipt, or persisted prompt. */
export function withHarnessPromptSource<T>(source: PromptIdentity & { text: string }, run: () => T): T {
  return sources.run({ ...source }, run)
}

/** Missing or unrelated provenance is unknown; the complete model prompt is never a substitute. */
export function harnessPromptSource(identity: PromptIdentity, prompt: string): string | undefined {
  const source = sources.getStore()
  return source?.method === identity.method
    && source.requestId === identity.requestId
    && source.sessionId === identity.sessionId
    && prompt.endsWith(source.text)
    ? source.text
    : undefined
}
