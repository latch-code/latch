import { useCallback, type ReactNode } from 'react'
import type { ScheduleResult, TaskDetail } from '@latch/protocol'
import { failureAction, FAILURE_ACTION_LABEL } from '../conversation/failureAction.ts'
import { placeByTime } from '../handoffs/model.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { Button } from '@latch/ui'
import { WriteNotice } from './AgentForm.tsx'
import { ResultCard } from './ResultCard.tsx'
import { useAgentWrites, writeFor, type AgentWrites } from './useAgentWrites.ts'
import { defineCopy, formatNumber, plural } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    scheduledResults: '定时结果',
    runNow: '立即运行',
    moreResults: (count: number) => `还有 ${formatNumber(count)} 条结果`,
  },
  {
    scheduledResults: 'Scheduled results',
    runNow: 'Run now',
    moreResults: (count: number) => plural(count, { one: '{n} more result', other: '{n} more results' }),
  },
)

type ResultShell = Pick<
  ShellState,
  | 'snapshot'
  | 'catalog'
  | 'connection'
  | 'access'
  | 'refresh'
  | 'choose'
  | 'openFile'
  | 'openSettings'
  | 'owner'
  | 'profileShown'
  | 'closeProfile'
  | 'openProfile'
>

/** Cards shown together in one place; the rest are in the profile's 动态. */
export const SHOWN_RESULTS = 3

/**
 * Cards in one place of the timeline, oldest first: the newest few, and 「还有 N 条结果」 that opens 动态, where every result
 * is listed, so a backlog of runs does not bury the conversation.
 */
export function ResultStack({
  shell,
  owner,
  results,
  writes,
  className,
}: {
  shell: ResultShell
  owner: string
  results: readonly ScheduleResult[]
  writes: AgentWrites
  className?: string
}) {
  const hidden = Math.max(0, results.length - SHOWN_RESULTS)
  return (
    <div className={className ? `schedule-results ${className}` : 'schedule-results'} aria-label={COPY.scheduledResults}>
      {hidden > 0 && (
        <Button size="xs" variant="ghost" className="schedule-results-more" onClick={() => shell.openProfile(owner)}>
          {COPY.moreResults(hidden)}
        </Button>
      )}
      {results.slice(hidden).map(result => (
        <ResultCardFor key={result.id} shell={shell} result={result} writes={writes} />
      ))}
    </div>
  )
}

/**
 * A failed run's one next step, chosen as the conversation chooses it from the failure's code: 重试 is 立即运行 of its
 * schedule, Harness and 模型服务 open 设置 on this Mac; anything else is in the run's own session (打开运行).
 */
function nextStepOf(shell: ResultShell, result: ScheduleResult, writes: AgentWrites) {
  if (result.outcome !== 'failed' && result.outcome !== 'interrupted') return undefined
  const action = failureAction(result.failure?.code)
  const offline = shell.connection === 'offline'
  if (action === 'retry') {
    const schedule = shell.snapshot.automations?.find(item => item.id === result.automationId)
    if (!schedule || !shell.access.scopes.has('run') || offline || schedule.state === 'running') return undefined
    const key = `automation:${schedule.id}:result:${result.id}`
    const state = writeFor(writes.state, key)
    return {
      label: COPY.runNow,
      busy: state !== null && 'phase' in state && state.phase === 'saving',
      run: () => void writes.run(key, `automations/${encodeURIComponent(schedule.id)}/run`, 'POST', {}),
      notice: <WriteNotice state={state} onRetry={() => void writes.retry()} />,
    }
  }
  if ((action === 'harness' || action === 'providers') && shell.owner)
    return { label: FAILURE_ACTION_LABEL[action], run: () => shell.openSettings(action === 'harness' ? 'engines' : 'providers') }
  return undefined
}

/** One card as this device may act on it: open the run, open its files, take a failure's next step. */
export function ResultCardFor({ shell, result, writes }: { shell: ResultShell; result: ScheduleResult; writes: AgentWrites }) {
  const run = result.sessionId && shell.snapshot.tasks.some(task => task.id === result.sessionId) ? result.sessionId : undefined
  const files = run && shell.catalog?.features?.filePreview === true && shell.snapshot.device.dataScope === 'all'
  return (
    <ResultCard
      result={result}
      {...(run ? { onOpenRun: () => shell.choose(run) } : {})}
      {...(files
        ? {
            onOpenFile: (file: { root: string; path: string }) => {
              // The file preview stands where the profile stands.
              if (shell.profileShown) shell.closeProfile()
              shell.openFile({ sessionId: run, reference: file.path, rootId: file.root })
            },
          }
        : {})}
      nextStep={nextStepOf(shell, result, writes)}
    />
  )
}

/** The result cards of an open topic of 我的 Agent, each where its run settled: what the Transcript's `placed` takes. */
export function useTopicResults(
  shell: ResultShell,
  detail: TaskDetail | null,
): ((turns: ReadonlyArray<{ key: string; at: number | undefined }>) => ReadonlyMap<string, ReactNode>) | undefined {
  const { refresh } = shell
  const writes = useAgentWrites(useCallback(() => void refresh(), [refresh]))
  const results = detail?.results ?? []
  const owner = results[0]?.owner
  if (!results.length || owner === undefined) return undefined
  return turns =>
    new Map(
      [...placeByTime(turns, results)].map(([key, items]) => [
        key,
        <ResultStack key={`results:${key}`} shell={shell} owner={owner} results={items} writes={writes} />,
      ]),
    )
}
