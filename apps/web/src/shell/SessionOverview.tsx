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
import { VisibleText } from '../components/VisibleText.tsx'
import { toolLabel, turnsOf } from '../conversation.ts'
import { deliveryChecks, useWorkbenchDelivery } from './useWorkbenchEvidence.ts'
import type { ShellState } from './useShellLayout.tsx'

/** A command finishing is evidence about that command, never an invented test or CI count. */
const commandWords = {
  completed: '已完成',
  failed: '失败',
  cancelled: '已停止',
  running: '运行中',
  'awaiting-approval': '等你处理',
  queued: '已排队',
} as const

const clock = (at: string) => new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

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
  const failure = evidence.error ?? entry?.error?.message
  // While the connection is lost, what is shown is what was last seen, and says when.
  const seen = !connected && entry ? `上次 ${clock(entry.observedAt)}` : undefined
  const next = state?.conflicted
    ? '查看冲突'
    : state?.gitOperation
      ? '查看 Git 状态'
      : state?.files
        ? `提交 ${state.files} 个文件…`
        : state?.ahead
          ? '推送提交…'
          : pr
            ? '查看 PR'
            : '开 PR…'
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
        <p className="session-overview-empty">本轮未记录文件改动</p>
      </div>
    )
  return (
    <div className="session-overview">
      {showChanges && (
        <Section
          title="这次改动"
          {...(canReadChanges && detail && !unavailable && !pending ? { count: distinct.length } : {})}
          {...(distinct.length > 0
            ? {
                action: (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => shell.openChangesTab(turn?.user?.turnId ? { turnId: turn.user.turnId } : undefined)}>
                    全部
                  </Button>
                ),
              }
            : {})}>
          {!canReadChanges ? (
            <Row icon={LockGlyph}>这台设备不能读取项目改动</Row>
          ) : !detail ? (
            <Row icon={DiffGlyph}>正在读取…</Row>
          ) : (
            <>
              {distinct.slice(0, 6).map(file => (
                <Row
                  key={`${file.root}:${file.path}`}
                  icon={DiffGlyph}
                  state={
                    <span className="session-overview-word">
                      {file.change === 'created' ? '新增' : file.change === 'deleted' ? '删除' : '修改'}
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
                  读不到本轮改动
                </Row>
              ) : pending ? (
                <Row icon={DiffGlyph}>正在核对…</Row>
              ) : null}
              {truncated && <Row icon={DiffGlyph}>只列出部分</Row>}
            </>
          )}
        </Section>
      )}
      {showChecks && (
        <Section title="检查">
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
                    {message.interrupted ? '结果未知' : message.state ? commandWords[message.state] : '未报告结果'}
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
        <Section title="交付" {...(state && !failure && shell.canDeliver ? { action: deliver(next) } : {})}>
          {!shell.canDeliver ? (
            <Row icon={LockGlyph}>这台设备不能交付</Row>
          ) : failure ? (
            <Row
              icon={WarningGlyph}
              tone="warn"
              {...(seen ? { time: seen } : {})}
              action={
                connected ? (
                  <Button size="xs" variant="ghost" onClick={evidence.refresh}>
                    重试
                  </Button>
                ) : (
                  deliver('查看')
                )
              }>
              <Tooltip content={failure}>
                <span tabIndex={0}>读不到交付状态</span>
              </Tooltip>
            </Row>
          ) : state ? (
            <>
              <Row
                icon={BranchGlyph}
                state={
                  <span className="session-overview-word">
                    {state.conflicted
                      ? `${state.conflicted} 个冲突`
                      : state.gitOperation
                        ? 'Git 操作未结束'
                        : state.files
                          ? `${state.files} 个文件未提交`
                          : state.ahead > 0
                            ? `${state.ahead} 个提交未推送`
                            : '已全部提交'}
                  </span>
                }
                {...(seen ? { time: seen } : {})}>
                {state.branch ? <VisibleText text={state.branch} /> : '分支'}
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
                  <Tooltip content={entry.prError.message}>
                    <span tabIndex={0}>读不到 PR</span>
                  </Tooltip>
                </Row>
              )}
            </>
          ) : (
            <Row icon={BranchGlyph} action={deliver('查看')}>
              {evidence.loading ? '正在读取…' : '还没读取'}
            </Row>
          )}
        </Section>
      )}
    </div>
  )
}
