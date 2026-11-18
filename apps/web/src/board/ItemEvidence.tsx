import type { TaskSummary, WorkbenchDeliveryEntry } from '@latch/protocol'
import { Button, DiffGlyph, StatusWord, type StatusTone } from '@latch/ui'
import { GitPullRequest } from 'lucide-react'
import { defineCopy, formatNumber } from '../core/i18n.ts'
import { deliveryChecks } from '../shell/useWorkbenchEvidence.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'

const COPY = defineCopy(
  {
    noChecks: '没有检查结果',
    waitingVersion: '检查版本待核对',
    outdated: '检查对应旧提交',
    uncommitted: (count: number) => `未提交改动 ${formatNumber(count)}`,
    changes: '改动',
    lineNotes: '行级反馈',
    pr: (number: number) => `PR #${number} · 审阅与检查`,
    delivery: '交付',
  },
  {
    noChecks: 'No check results',
    waitingVersion: 'Check commit unverified',
    outdated: 'Checks are for a different commit',
    uncommitted: (count: number) => `Uncommitted changes ${formatNumber(count)}`,
    changes: 'Changes',
    lineNotes: 'Line comments',
    pr: (number: number) => `PR #${number} · Reviews and checks`,
    delivery: 'Delivery',
  },
)

/** Current checks require both repository and PR evidence for the same commit. */
function itemCheck(entry: WorkbenchDeliveryEntry): { text: string; tone: StatusTone } | undefined {
  const pr = entry.pr?.pr
  if (!pr) return entry.prError ? { text: entry.prError.message, tone: 'failed' } : undefined
  if (!entry.pr?.checks.length) return { text: COPY.noChecks, tone: 'neutral' }
  if (!pr.headSha || !entry.state?.head) return { text: COPY.waitingVersion, tone: 'neutral' }
  if (pr.headSha !== entry.state.head) return { text: COPY.outdated, tone: 'warn' }
  const text = deliveryChecks(entry)
  if (text === undefined) return undefined
  const failed = entry.prError || (pr.state !== 'merged' && !pr.draft && entry.pr.checks.some(check => check.state === 'fail'))
  return { text, tone: failed ? 'failed' : 'neutral' }
}

export function itemCheckWords(entry: WorkbenchDeliveryEntry): string | undefined {
  return itemCheck(entry)?.text
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
  const checks = entry ? itemCheck(entry) : undefined
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
          {entry?.state?.files ? COPY.uncommitted(entry.state.files) : COPY.changes}
        </Button>
      )}
      {changes && notes && (
        <Button size="xs" variant="ghost" onClick={() => shell.openWorkItemSession(itemId, { sessionId: task.id, panel: 'changes' })}>
          {COPY.lineNotes}
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
          {pr ? COPY.pr(pr.number) : COPY.delivery}
        </Button>
      )}
      {entry && checks && (
        <StatusWord tone={checks.tone}>
          {pr?.headSha && <code title={pr.headSha}>{pr.headSha.slice(0, 7)} </code>}
          {checks.text}
        </StatusWord>
      )}
      {entry?.error && !entry.prError && <StatusWord tone="failed">{entry.error.message}</StatusWord>}
    </div>
  )
}
