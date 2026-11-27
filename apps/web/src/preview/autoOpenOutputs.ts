import type { FileOpenTarget, TaskDetail } from '@latch/protocol'
const DOCUMENTS = new Set(['pptx', 'pdf', 'docx', 'xlsx', 'csv', 'html'])
export interface AutoOpened {
  first: FileOpenTarget
  offered: FileOpenTarget[]
}

/** Only a run this view watched can open a newly created document; loading history never does. */
export class AutoOpenOutputs {
  private sessionId: string | undefined
  private runId: string | undefined
  private seenRunning = false
  private consumed = false
  /** The first new document opens; any others from the turn wait in `offered`, with a dot on their tabs. */
  observe(detail: TaskDetail | null, options: { enabled: boolean; available: boolean; width: number }): AutoOpened | undefined {
    const sessionId = detail?.summary.id,
      runId = detail?.summary.runId
    if (this.sessionId !== sessionId || this.runId !== runId) {
      this.sessionId = sessionId
      this.runId = runId
      this.seenRunning = false
      this.consumed = false
    }
    if (!detail || !runId) return
    const active = detail.summary.status === 'running' || detail.summary.status === 'waiting-approval'
    if (active) {
      this.seenRunning = true
      return
    }
    if (!this.seenRunning || this.consumed) return
    if (
      !options.enabled
      || !options.available
      || !Number.isFinite(options.width)
      || options.width < 480
      || detail.summary.status !== 'idle'
    ) {
      this.consumed = true
      return
    }
    const messages = detail.messages.slice(
      Math.max(
        0,
        detail.messages.findLastIndex(message => message.role === 'user' && !message.steered),
      ),
    )
    const output = messages.findLast(message => message.outputs !== undefined || message.outputsPending || message.outputsUnavailable)
    if (!output || output.outputsPending || detail.fileChanges?.state === 'settling') return
    this.consumed = true
    const documents = (output.outputs ?? [])
      .filter(file => file.change === 'created' && file.kind && DOCUMENTS.has(file.kind))
      .map(file => ({ sessionId: detail.summary.id, reference: file.path, rootId: file.root }))
    const [first, ...offered] = documents
    return first ? { first, offered } : undefined
  }
}
