import type { TaskSummary, WorkbenchDeliveryEntry } from '@latch/protocol'
import { Button, DiffGlyph, StatusWord } from '@latch/ui'
import { GitPullRequest } from 'lucide-react'
import { deliveryChecks } from '../shell/useWorkbenchEvidence.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'

/** Current checks require both repository and PR evidence for the same commit. */
export function itemCheckWords(entry: WorkbenchDeliveryEntry): string | undefined {
  const pr = entry.pr?.pr
  if (!pr) return entry.prError?.message
  if (!entry.pr?.checks.length) return '没有检查结果'
  if (!pr.headSha || !entry.state?.head) return '检查版本待核对'
  if (pr.headSha !== entry.state.head) return '检查对应旧提交'
  return deliveryChecks(entry)
}

/** These links open the existing authorized session panels and the precise commit shown here. */
export function ItemEvidence({
  itemId,
  shell,
  task,
  entry,
}: {
  itemId: string
  shell: ShellState
  task: TaskSummary
  entry?: WorkbenchDeliveryEntry | undefined
}) {
  if (task.mode === 'chat') return null
  const head = entry?.state?.head
  const pr = entry?.pr?.pr
  const checks = entry ? itemCheckWords(entry) : undefined
  const changes = shell.catalog?.features?.changes === true
  const delivery = shell.catalog?.features?.gitDelivery === true && !entry?.notApplicable
  const notes =
    shell.snapshot.device.dataScope === 'all'
    && shell.snapshot.reviewNotes?.some(row => row.sessionId === task.id && row.pending + row.sent + row.claimed + row.reviewed > 0)
  if (!changes && !delivery) return null
  return (
    <div className="item-evidence">
      {changes && (
        <Button
          size="xs"
          variant="ghost"
          icon={DiffGlyph}
          onClick={() => shell.openWorkItemSession(itemId, { sessionId: task.id, panel: 'changes' })}>
          {entry?.state?.files ? `未提交改动 ${entry.state.files}` : '改动'}
        </Button>
      )}
      {changes && notes && (
        <Button size="xs" variant="ghost" onClick={() => shell.openWorkItemSession(itemId, { sessionId: task.id, panel: 'changes' })}>
          行级反馈
        </Button>
      )}
      {changes && head && shell.catalog?.features?.gitHunks && (
        <Button
          size="xs"
          variant="ghost"
          title={head}
          onClick={() => shell.openWorkItemSession(itemId, { sessionId: task.id, panel: 'changes', commitSha: head })}>
          <code>HEAD {head.slice(0, 7)}</code>
        </Button>
      )}
      {delivery && (
        <Button
          size="xs"
          variant="ghost"
          icon={GitPullRequest}
          onClick={() =>
            shell.openWorkItemSession(itemId, { sessionId: task.id, panel: 'delivery', ...(pr ? { pullRequest: true } : {}) })
          }>
          {pr ? `PR #${pr.number} · 审阅与检查` : '交付'}
        </Button>
      )}
      {entry && checks && (
        <StatusWord tone={checks.includes('失败') ? 'failed' : checks.includes('旧提交') ? 'warn' : 'neutral'}>
          {pr?.headSha && <code title={pr.headSha}>{pr.headSha.slice(0, 7)} </code>}
          {checks}
        </StatusWord>
      )}
      {entry?.error && !entry.prError && <StatusWord tone="failed">{entry.error.message}</StatusWord>}
    </div>
  )
}
