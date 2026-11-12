import type { AppDataEvent, AppUpdatedEvent } from '@latch/protocol'

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

const updated = new Set<(pluginId: string) => void>()

/** SSE `app.updated`: a plugin's pages were applied, rolled back, turned on or off, or removed. */
export function onAppUpdated(listener: (pluginId: string) => void): () => void {
  updated.add(listener)
  return () => {
    updated.delete(listener)
  }
}

/** Parses an `app.updated` event of this Host instance; true when it was one, so the caller reads the snapshot again. */
export function publishAppUpdated(data: string, instanceId: string | undefined): boolean {
  try {
    const event = JSON.parse(data) as Partial<AppUpdatedEvent>
    if (event.type !== 'app.updated' || event.instanceId !== instanceId || typeof event.pluginId !== 'string') return false
    for (const listener of updated) listener(event.pluginId)
    return true
  } catch {
    return false
  }
}
