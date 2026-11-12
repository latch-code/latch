import { useRef, useState } from 'react'
import { History } from 'lucide-react'
import type { HistoryImportResult, HostCatalog, TaskSummary } from '@latch/protocol'
import { Button, Icon, Modal, ModalHeader } from '@latch/ui'
import { api } from '../core/api.ts'
import { VisibleText } from '../components/VisibleText.tsx'
import { TargetChoice } from './HistoryImport.tsx'
import { importAttempt, importOutcome, rebuildTargets, type ImportAttempt, type ImportOutcome } from './model.ts'

const IMPORT_TIMEOUT = 90_000

type RebuildState = { kind: 'idle' } | { kind: 'sending' } | Exclude<ImportOutcome, { kind: 'open' }>

/**
 * 按文字重建 for a session brought in as it was whose Harness no longer has it (`harness-session-lost`): the Harness to
 * continue in, said as a text rebuild, and one request (`fromTaskId`) whose retry reuses its `requestId`. The new session
 * waits for the first message, as an import does.
 */
export function RebuildLostDialog({
  phone,
  catalog,
  summary,
  sourceLabel,
  onClose,
  onOpen,
}: {
  phone: boolean
  catalog: HostCatalog
  summary: Pick<TaskSummary, 'id' | 'title' | 'harnessId'>
  sourceLabel: string
  onClose: () => void
  onOpen: (taskId: string) => void
}) {
  const targets = rebuildTargets(catalog, summary.harnessId)
  const [targetId, setTargetId] = useState(targets[0]?.harnessId)
  const target = targets.find(item => item.harnessId === targetId) ?? targets[0]
  const [state, setState] = useState<RebuildState>({ kind: 'idle' })
  const attempt = useRef<ImportAttempt | null>(null)
  const busy = state.kind === 'sending'

  const send = async () => {
    if (!target) return
    const sent = importAttempt(attempt.current, summary.id, target.harnessId)
    attempt.current = sent
    setState({ kind: 'sending' })
    try {
      const result = await api<HistoryImportResult>('history/imports', {
        method: 'POST',
        body: { requestId: sent.requestId, fromTaskId: summary.id, harnessId: sent.harnessId },
        timeoutMs: IMPORT_TIMEOUT,
      })
      onOpen(result.taskId)
    } catch (error) {
      const outcome = importOutcome(error)
      if (outcome.kind === 'open') {
        onOpen(outcome.taskId)
        return
      }
      if (outcome.kind !== 'unknown') attempt.current = null
      setState(outcome)
    }
  }

  return (
    <Modal label="按文字重建" variant={phone ? 'sheet' : 'dialog'} className="history-rebuild" dismissible={!busy} onClose={onClose}>
      <ModalHeader title="按文字重建" onClose={onClose} />
      <div className="history-rebuild-body">
        <p className="history-rebuild-from">
          <Icon icon={History} size={14} />
          <span>
            从「
            <VisibleText text={summary.title || '未命名会话'} />
            」的对话文字开始一个新会话；这个会话留着，只能查看。
          </span>
        </p>
        {target ? (
          <TargetChoice
            targets={targets}
            target={target}
            sourceLabel={sourceLabel}
            disabled={busy}
            onChange={value => {
              setTargetId(value)
              setState({ kind: 'idle' })
            }}
          />
        ) : (
          <p className="history-result" data-tint="err" role="alert">
            没有能按文字重建的 Harness
          </p>
        )}
      </div>
      <footer className="history-footer">
        <div className="history-actions">
          {state.kind === 'unknown' && (
            <span className="history-result" data-tint="warn" role="status">
              结果未确认
            </span>
          )}
          {(state.kind === 'failed' || state.kind === 'busy' || state.kind === 'expired') && (
            <span className="history-result" data-tint="err" role="alert">
              {state.kind === 'failed' ? state.message : '这个会话现在不能重建'}
            </span>
          )}
          <Button variant="primary" loading={busy} disabled={!target} onClick={() => void send()}>
            {busy ? '正在重建' : state.kind === 'unknown' ? '重试' : '按文字重建'}
          </Button>
        </div>
      </footer>
    </Modal>
  )
}
