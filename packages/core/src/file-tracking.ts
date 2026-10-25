import { isFileChange, type Message, type TaskDetail } from '@latch/protocol'
import type { FileTrackingHandle, FileTrackingInput, FileTrackingResult, ProjectFolder } from '@latch/sdk'

type Record = { sessionId: string; runId: string; result: FileTrackingResult; handle?: FileTrackingHandle; state: 'watching' | 'settling' }
/** Bounds the optional projection even when a third-party driver service returns malformed data. */
function checked(value: FileTrackingResult): FileTrackingResult {
  if (!value || !Array.isArray(value.files)) return { files: [], unavailable: true }
  const files = value.files.slice(0, 1000).filter(isFileChange)
  return {
    files: structuredClone(files),
    ...(value.truncated || value.files.length > 1000 || files.length !== value.files.length ? { truncated: true } : {}),
    ...(value.unavailable ? { unavailable: true } : {}),
  }
}
export function recordFileOutputs(message: Message, result: FileTrackingResult, pending = false): void {
  message.outputs = structuredClone(result.files)
  if (result.truncated) message.outputsTruncated = true
  else delete message.outputsTruncated
  if (result.unavailable) message.outputsUnavailable = true
  else delete message.outputsUnavailable
  if (pending) message.outputsPending = true
  else delete message.outputsPending
}
/** Keeps observation independent of run completion. The caller alone commits messages and run state. */
interface TrackingOptions {
  track?: (input: FileTrackingInput) => Promise<FileTrackingHandle>
  current(sessionId: string, runId: string): boolean
  notify(sessionId: string): void
}
export class RunFileTracking {
  private readonly options: TrackingOptions
  private readonly records = new Map<string, Record>()
  private readonly setups = new Set<Promise<void>>()
  private readonly settlements = new Set<Promise<void>>()
  private stopped = false
  constructor(options: TrackingOptions) {
    this.options = options
  }

  async start(sessionId: string, runId: string, folders: readonly ProjectFolder[]): Promise<void> {
    if (!this.options.track || this.stopped) return
    const record: Record = { sessionId, runId, result: { files: [] }, state: 'watching' }
    this.records.set(runId, record)
    const setup = (async () => {
      try {
        record.handle = await this.options.track!({
          sessionId,
          runId,
          folders,
          onChange: result => {
            if (this.stopped || !this.options.current(sessionId, runId)) return
            record.result = checked(result)
            this.options.notify(sessionId)
          },
        })
        if (this.stopped || !this.options.current(sessionId, runId)) record.handle.dispose()
      } catch {
        record.result = { files: [], unavailable: true }
      }
    })()
    this.setups.add(setup)
    try {
      await setup
    } finally {
      this.setups.delete(setup)
    }
  }
  projection(sessionId: string, runId: string | undefined): TaskDetail['fileChanges'] {
    const record = runId === undefined ? undefined : this.records.get(runId)
    if (!record || record.sessionId !== sessionId) return undefined
    return structuredClone({ runId: record.runId, ...record.result, state: record.state })
  }
  capture(runId: string): FileTrackingResult | undefined {
    return this.records.get(runId)?.result
  }
  finish(runId: string, save: (result: FileTrackingResult) => Promise<void>): void {
    const record = this.records.get(runId)
    if (!record || record.state === 'settling') return
    record.state = 'settling'
    const work = (async () => {
      let result: FileTrackingResult
      try {
        result = record.handle ? checked(await record.handle.finish()) : record.result
      } catch {
        result = { ...record.result, truncated: true, unavailable: true }
      }
      await save(result)
    })().finally(() => {
      this.records.delete(runId)
      this.settlements.delete(work)
      if (!this.stopped && this.options.current(record.sessionId, runId)) this.options.notify(record.sessionId)
    })
    this.settlements.add(work)
    void work.catch(() => {})
  }
  dispose(sessionId?: string): void {
    for (const record of this.records.values()) if (sessionId === undefined || record.sessionId === sessionId) record.handle?.dispose()
  }
  async close(): Promise<void> {
    this.stopped = true
    this.dispose()
    await Promise.allSettled([...this.setups])
    this.dispose()
    await Promise.allSettled([...this.settlements])
    this.records.clear()
  }
}
