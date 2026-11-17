import { AsyncLocalStorage } from 'node:async_hooks'

interface PromptIdentity {
  method: 'create' | 'prompt' | 'steer'
  requestId: string
  sessionId?: string
}

interface PromptSource extends PromptIdentity {
  text: string
  beforeSteer?: (runId: string) => ((couldBeInjected: boolean) => void) | undefined
}

const sources = new AsyncLocalStorage<PromptSource>()

/** Host-only provenance, before notes or history are added. It never joins an RPC, receipt, or persisted prompt. */
export function withHarnessPromptSource<T>(source: PromptSource, run: () => T): T {
  return sources.run({ ...source }, run)
}

/** Only the outbound steer can change the run's authority. Its saved receipt does not invoke this callback. */
export function beginHarnessSteer(sessionId: string, requestId: string, runId: string): ((couldBeInjected: boolean) => void) | undefined {
  const source = sources.getStore()
  if (source?.method !== 'steer' || source.requestId !== requestId || source.sessionId !== sessionId) return undefined
  return source.beforeSteer?.(runId)
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
