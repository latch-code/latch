import type { FileOpenTarget, TaskDetail } from '@latch/protocol'
const DOCUMENTS = new Set(['pptx', 'pdf', 'docx', 'xlsx', 'csv', 'html'])
/** Only a run this view watched can open a newly created document; loading history never does. */
export class AutoOpenOutputs {
  private sessionId: string | undefined
  private runId: string | undefined
  private seenRunning = false
  private consumed = false
  observe(detail: TaskDetail | null, options: { enabled: boolean; visible: boolean; width: number }): FileOpenTarget | undefined {
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
      || !options.visible
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
        detail.messages.findLastIndex(message => message.role === 'user'),
      ),
    )
    const output = messages.findLast(message => message.outputs !== undefined || message.outputsPending || message.outputsUnavailable)
    if (!output || output.outputsPending || detail.fileChanges?.state === 'settling') return
    this.consumed = true
    const document = output.outputs?.find(file => file.change === 'created' && file.kind && DOCUMENTS.has(file.kind))
    return document ? { sessionId: detail.summary.id, reference: document.path, rootId: document.root } : undefined
  }
}
