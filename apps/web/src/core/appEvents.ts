import type { AppDataEvent } from '@latch/protocol'

type Listener = (event: Pick<AppDataEvent, 'pluginId' | 'scope' | 'key' | 'version'>) => void
const listeners = new Set<Listener>()

/** SSE `app.data`: a plugin page's document changed. Only open page frames listen. */
export function onAppData(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Parses an `app.data` event of this Host instance and passes its whitelisted fields on. */
export function publishAppData(data: string, instanceId: string | undefined): void {
  try {
    const event = JSON.parse(data) as Partial<AppDataEvent>
    if (
      event.type !== 'app.data'
      || event.instanceId !== instanceId
      || typeof event.pluginId !== 'string'
      || typeof event.scope !== 'string'
      || typeof event.key !== 'string'
      || !Number.isSafeInteger(event.version)
    )
      return
    const change = { pluginId: event.pluginId, scope: event.scope, key: event.key, version: event.version! }
    for (const listener of listeners) listener(change)
  } catch {
    /* A malformed event changes nothing. */
  }
}
