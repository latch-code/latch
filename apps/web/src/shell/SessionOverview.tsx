import type { ReactNode } from 'react'
import { readsProjectFiles, type TaskSummary } from '@latch/protocol'
import {
  Button,
  Count,
  DiffGlyph,
  Icon,
  StatusWord,
  TerminalGlyph,
  BranchGlyph,
  PullRequestGlyph,
  LockGlyph,
  WarningGlyph,
  Tooltip,
  type IconComponent,
  type StatusTone,
} from '@latch/ui'
import { BranchName } from '../components/MiddleEllipsis.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { toolLabel, turnsOf } from '../conversation.ts'
import { deliveryChecks, useWorkbenchDelivery } from './useWorkbenchEvidence.ts'
import type { ShellState } from './useShellLayout.tsx'
import { currentLocale, defineCopy, plural } from '../core/i18n.ts'
import { describeFailure } from '../core/securityCopy.ts'

const COPY = defineCopy(
  {
    completed: '已完成',
    failed: '失败',
    stopped: '已停止',
    running: '运行中',
    attention: '等你处理',
    queued: '已排队',
    last: (time: string) => `上次 ${time}`,
    conflictsAction: '查看冲突',
    gitStatus: '查看 Git 状态',
    commit: (count: number) => `提交 ${count} 个文件…`,
    push: '推送提交…',
    pullRequest: '查看 PR',
    openPR: '开 PR…',
    noChanges: '本轮未记录文件改动',
    changes: '这次改动',
    all: '全部',
    changesDenied: '这台设备不能读取项目改动',
    loading: '正在读取…',
    added: '新增',
    deleted: '删除',
    modified: '修改',
    changesFailed: '读不到本轮改动',
    checking: '正在核对…',
    partial: '只列出部分',
    checks: '检查',
    unknown: '结果未知',
    notReported: '未报告结果',
    delivery: '交付',
    deliveryDenied: '这台设备不能交付',
    retry: '重试',
    view: '查看',
    deliveryFailed: '读不到交付状态',
    conflicts: (count: number) => `${count} 个冲突`,
    pendingGit: 'Git 操作未结束',
    uncommitted: (count: number) => `${count} 个文件未提交`,
    unpushed: (count: number) => `${count} 个提交未推送`,
    committed: '已全部提交',
    branch: '分支',
    pullRequestFailed: '读不到 PR',
    notLoaded: '还没读取',
  },
  {
    completed: 'Completed',
    failed: 'Failed',
    stopped: 'Stopped',
    running: 'Running',
    attention: 'Needs you',
    queued: 'Queued',
    last: (time: string) => `Last: ${time}`,
    conflictsAction: 'View conflicts',
    gitStatus: 'View Git status',
    commit: (count: number) => plural(count, { one: 'Commit {n} file…', other: 'Commit {n} files…' }),
    push: 'Push commits…',
    pullRequest: 'View PR',
    openPR: 'Open PR…',
    noChanges: 'No file changes recorded this turn',
    changes: 'Changes',
    all: 'All',
    changesDenied: 'This device can’t read project changes',
    loading: 'Loading…',
    added: 'Added',
    deleted: 'Deleted',
    modified: 'Modified',
    changesFailed: 'Can’t read changes from this turn',
    checking: 'Checking…',
    partial: 'Partial list',
    checks: 'Checks',
    unknown: 'Outcome unknown',
    notReported: 'No result reported',
    delivery: 'Delivery',
    deliveryDenied: 'This device can’t deliver changes',
    retry: 'Retry',
    view: 'View',
    deliveryFailed: 'Can’t read delivery status',
    conflicts: (count: number) => plural(count, { one: '{n} conflict', other: '{n} conflicts' }),
    pendingGit: 'Git operation in progress',
    uncommitted: (count: number) => plural(count, { one: '{n} file to commit', other: '{n} files to commit' }),
    unpushed: (count: number) => plural(count, { one: '{n} commit to push', other: '{n} commits to push' }),
    committed: 'All committed',
    branch: 'Branch',
    pullRequestFailed: 'Can’t read PR',
    notLoaded: 'Not loaded',
  },
)

/** A command finishing is evidence about that command, never an invented test or CI count. */
const commandWords = {
  get completed() {
    return COPY.completed
  },
  get failed() {
    return COPY.failed
  },
  get cancelled() {
    return COPY.stopped
  },
  get running() {
    return COPY.running
  },
  get 'awaiting-approval'() {
    return COPY.attention
  },
  get queued() {
    return COPY.queued
  },
} as const

const clock = (at: string) => new Date(at).toLocaleTimeString(currentLocale(), { hour: '2-digit', minute: '2-digit' })

/**
 * One row of the summary, the same for every section: a 14px glyph, what it is about, then its state (an icon and a
 * short word), a time and at most one action, all on one line.
 */
function Row({
  icon,
  tone,
  children,
  state,
  time,
  action,
}: {
  icon: IconComponent
  tone?: 'warn'
  children: ReactNode
  state?: ReactNode
  time?: string
  action?: ReactNode
}) {
  return (
    <li className="session-overview-row" data-tone={tone}>
      <Icon icon={icon} size={14} className="session-overview-glyph" />
      <span className="session-overview-text">{children}</span>
      {state}
      {time && <span className="session-overview-time">{time}</span>}
      {action}
    </li>
  )
}

function Section({ title, count, action, children }: { title: string; count?: number; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="session-overview-section" aria-label={title}>
      <header>
        <h3>{title}</h3>
        {count !== undefined && <Count value={count} />}
        {action}
      </header>
      <ul>{children}</ul>
    </section>
  )
}

/** The latest turn's observed changes and commands, followed by the separately observed repository state. */
export function SessionOverview({ shell, summary }: { shell: ShellState; summary: TaskSummary }) {
  const connected = shell.connection === 'connected'
  const canReadChanges = shell.canViewChanges && readsProjectFiles(shell.snapshot.device.dataScope)
  const detail = shell.current?.summary.id === summary.id ? shell.current : null
  const turn = detail ? turnsOf(detail.messages).at(-1) : undefined
  const messages = turn?.replies ?? []
  const tools = messages.filter(message => message.role === 'tool')
  const commands = tools.filter(message => message.tool?.kind === 'execute')
  const changes = detail?.fileChanges?.files ?? messages.flatMap(message => message.outputs ?? [])
  const distinct = [...new Map(changes.map(file => [`${file.root}:${file.path}`, file])).values()]
  const unavailable = detail?.fileChanges?.unavailable || messages.some(message => message.outputsUnavailable)
  const pending = detail?.fileChanges?.state === 'settling' || messages.some(message => message.outputsPending)
  const truncated = detail?.fileChanges?.truncated || messages.some(message => message.outputsTruncated)
  const evidence = useWorkbenchDelivery(
    shell.snapshot,
    shell.connection,
    shell.route.entry === 'sessions' && !shell.route.start && !shell.board && (shell.pageMode ? shell.infoPage : shell.columnOpen),
    [summary.id],
  )
  const entry = evidence.entries.get(summary.id)
  const state = entry?.state
  const pr = entry?.pr?.pr
  const checks = entry ? deliveryChecks(entry) : undefined
  const failure = evidence.error ?? (entry?.error && describeFailure(0, entry.error.code, { host: entry.error.message }))
  // While the connection is lost, what is shown is what was last seen, and says when.
  const seen = !connected && entry ? COPY.last(clock(entry.observedAt)) : undefined
  const next = state?.conflicted
    ? COPY.conflictsAction
    : state?.gitOperation
      ? COPY.gitStatus
      : state?.files
        ? COPY.commit(state.files)
        : state?.ahead
          ? COPY.push
          : pr
            ? COPY.pullRequest
            : COPY.openPR
  const deliver = (label: string) => (
    <Button size="xs" variant="ghost" onClick={() => shell.showSurface({ kind: 'delivery' })}>
      {label}
    </Button>
  )
  // A section with nothing to show draws nothing; with all three empty the panel is one quiet word.
  const showChanges = !canReadChanges || !detail || unavailable || pending || truncated || distinct.length > 0
  const showChecks = commands.length > 0
  // A folder without Git has nothing to deliver, and what this device may not read is already said once above.
  const showDelivery =
    readsProjectFiles(shell.snapshot.device.dataScope) && (!shell.canDeliver || !!failure || entry?.notApplicable !== 'not-repository')
  if (!showChanges && !showChecks && !showDelivery)
    return (
      <div className="session-overview">
        <p className="session-overview-empty">{COPY.noChanges}</p>
      </div>
    )
  return (
    <div className="session-overview">
      {showChanges && (
        <Section
          title={COPY.changes}
          {...(canReadChanges && detail && !unavailable && !pending ? { count: distinct.length } : {})}
          {...(distinct.length > 0
            ? {
                action: (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => shell.openChangesTab(turn?.user?.turnId ? { turnId: turn.user.turnId } : undefined)}>
                    {COPY.all}
                  </Button>
                ),
              }
            : {})}>
          {!canReadChanges ? (
            <Row icon={LockGlyph}>{COPY.changesDenied}</Row>
          ) : !detail ? (
            <Row icon={DiffGlyph}>{COPY.loading}</Row>
          ) : (
            <>
              {distinct.slice(0, 6).map(file => (
                <Row
                  key={`${file.root}:${file.path}`}
                  icon={DiffGlyph}
                  state={
                    <span className="session-overview-word">
                      {file.change === 'created' ? COPY.added : file.change === 'deleted' ? COPY.deleted : COPY.modified}
                    </span>
                  }>
                  <button
                    type="button"
                    className="session-overview-link"
                    onClick={() =>
                      shell.openChangesTab({
                        file: { root: file.root, path: file.path },
                        ...(turn?.user?.turnId ? { turnId: turn.user.turnId } : {}),
                      })
                    }>
                    <VisibleText text={file.path} />
                  </button>
                </Row>
              ))}
              {unavailable ? (
                <Row icon={WarningGlyph} tone="warn">
                  {COPY.changesFailed}
                </Row>
              ) : pending ? (
                <Row icon={DiffGlyph}>{COPY.checking}</Row>
              ) : null}
              {truncated && <Row icon={DiffGlyph}>{COPY.partial}</Row>}
            </>
          )}
        </Section>
      )}
      {showChecks && (
        <Section title={COPY.checks}>
          {commands.map(message => {
            // The row's own words, as the transcript says them; the tool's ID only behind hover. A finished command is
            // not a passed test: its word stays neutral, without a check.
            const label = toolLabel(message)
            const words = label.mono || !label.verb ? label.object : `${label.verb} ${label.object}`
            const tone: StatusTone = message.interrupted
              ? 'warn'
              : message.state === 'failed'
                ? 'failed'
                : message.state === 'running'
                  ? 'running'
                  : message.state === 'awaiting-approval'
                    ? 'waiting'
                    : 'neutral'
            return (
              <Row
                key={message.id}
                icon={TerminalGlyph}
                state={
                  // A lost connection stops the spinner where it is: the run was last seen running, not seen now.
                  <StatusWord tone={tone} data-stale={tone === 'running' && !connected ? '' : undefined}>
                    {message.interrupted ? COPY.unknown : message.state ? commandWords[message.state] : COPY.notReported}
                  </StatusWord>
                }
                {...(tone === 'running' && seen ? { time: seen } : {})}>
                <Tooltip content={message.toolName && message.toolName !== words ? message.toolName : undefined}>
                  <code tabIndex={message.toolName && message.toolName !== words ? 0 : undefined}>
                    <VisibleText text={words} />
                  </code>
                </Tooltip>
              </Row>
            )
          })}
        </Section>
      )}
      {showDelivery && (
        <Section title={COPY.delivery} {...(state && !failure && shell.canDeliver ? { action: deliver(next) } : {})}>
          {!shell.canDeliver ? (
            <Row icon={LockGlyph}>{COPY.deliveryDenied}</Row>
          ) : failure ? (
            <Row
              icon={WarningGlyph}
              tone="warn"
              {...(seen ? { time: seen } : {})}
              action={
                connected ? (
                  <Button size="xs" variant="ghost" onClick={evidence.refresh}>
                    {COPY.retry}
                  </Button>
                ) : (
                  deliver(COPY.view)
                )
              }>
              <Tooltip content={failure}>
                <span tabIndex={0}>{COPY.deliveryFailed}</span>
              </Tooltip>
            </Row>
          ) : state ? (
            <>
              <Row
                icon={BranchGlyph}
                state={
                  <span className="session-overview-word">
                    {state.conflicted
                      ? COPY.conflicts(state.conflicted)
                      : state.gitOperation
                        ? COPY.pendingGit
                        : state.files
                          ? COPY.uncommitted(state.files)
                          : state.ahead > 0
                            ? COPY.unpushed(state.ahead)
                            : COPY.committed}
                  </span>
                }
                {...(seen ? { time: seen } : {})}>
                {state.branch ? <BranchName branch={state.branch} title /> : COPY.branch}
                {pr?.base && (
                  <span className="session-overview-base">
                    {' → '}
                    <VisibleText text={pr.base} />
                  </span>
                )}
              </Row>
              {pr && (
                <Row icon={PullRequestGlyph} {...(checks ? { state: <span className="session-overview-word">{checks}</span> } : {})}>
                  #{pr.number} <VisibleText text={pr.title} />
                </Row>
              )}
              {entry?.prError && (
                <Row icon={WarningGlyph} tone="warn">
                  <Tooltip content={checks}>
                    <span tabIndex={0}>{COPY.pullRequestFailed}</span>
                  </Tooltip>
                </Row>
              )}
            </>
          ) : (
            <Row icon={BranchGlyph} action={deliver(COPY.view)}>
              {evidence.loading ? COPY.loading : COPY.notLoaded}
            </Row>
          )}
        </Section>
      )}
    </div>
  )
}
