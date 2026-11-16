import type { TaskSummary } from '@latch/protocol'
import { Button, Count, DiffGlyph, Icon, InlineNotice, StatusWord, TerminalGlyph, BranchGlyph, PullRequestGlyph } from '@latch/ui'
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

/** The latest turn's observed changes and commands, followed by the separately observed repository state. */
export function SessionOverview({ shell, summary }: { shell: ShellState; summary: TaskSummary }) {
  const connected = shell.connection === 'connected'
  const canReadChanges = shell.canViewChanges && shell.snapshot.device.dataScope === 'all'
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
    shell.route.entry === 'sessions'
      && !shell.route.overview
      && !shell.route.allSessions
      && (shell.pageMode ? shell.infoPage : shell.columnOpen),
    [summary.id],
  )
  const entry = evidence.entries.get(summary.id)
  const state = entry?.state
  const pr = entry?.pr?.pr
  const checks = entry ? deliveryChecks(entry) : undefined
  const stage = state?.files ? 0 : state?.ahead ? 1 : pr ? 3 : 2
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
  // A section with nothing to show draws no heading; with all three empty the panel is one quiet line.
  const showChanges = !canReadChanges || !detail || unavailable || pending || truncated || distinct.length > 0
  const showChecks = commands.length > 0
  // A folder without Git has nothing to deliver, and what this device may not read is already said once above.
  const showDelivery =
    shell.snapshot.device.dataScope === 'all'
    && (!shell.canDeliver || !!evidence.error || !!entry?.error || entry?.notApplicable !== 'not-repository')
  if (!showChanges && !showChecks && !showDelivery)
    return (
      <div className="session-overview">
        <p className="session-overview-empty">还没有改动</p>
      </div>
    )
  return (
    <div className="session-overview">
      {showChanges && (
        <section className="session-overview-section">
          <header>
            <h3>这次改动</h3>
            {canReadChanges && detail && !unavailable && !pending && <Count value={distinct.length} />}
          </header>
          {!canReadChanges ? (
            <p>这台设备不能读取项目改动</p>
          ) : !detail ? (
            <p>正在读取会话…</p>
          ) : (
            <>
              {distinct.length > 0 && (
                <ul className="session-overview-files">
                  {distinct.slice(0, 6).map(file => {
                    return (
                      <li key={`${file.root}:${file.path}`}>
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={DiffGlyph}
                          onClick={() =>
                            shell.openChangesTab({
                              file: { root: file.root, path: file.path },
                              ...(turn?.user?.turnId ? { turnId: turn.user.turnId } : {}),
                            })
                          }>
                          <VisibleText text={file.path} />
                        </Button>
                        <span>{file.change === 'created' ? '新增' : file.change === 'deleted' ? '删除' : '修改'}</span>
                      </li>
                    )
                  })}
                </ul>
              )}
              {unavailable ? <p>本轮文件改动暂时读不到</p> : pending ? <p>正在核对文件改动…</p> : null}
              {truncated && <p>这里只显示部分改动</p>}
              {distinct.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => shell.openChangesTab(turn?.user?.turnId ? { turnId: turn.user.turnId } : undefined)}>
                  查看全部改动
                </Button>
              )}
            </>
          )}
        </section>
      )}
      {showChecks && (
        <section className="session-overview-section">
          <header>
            <h3>检查</h3>
          </header>
          <ul className="session-overview-checks">
            {commands.map(message => {
              // The row's own words, as the transcript says them; the tool's ID only behind hover.
              const label = toolLabel(message)
              const words = label.mono || !label.verb ? label.object : `${label.verb} ${label.object}`
              return (
                <li key={message.id}>
                  <Icon icon={TerminalGlyph} size={14} />
                  <code title={message.toolName && message.toolName !== words ? message.toolName : undefined}>
                    <VisibleText text={words} />
                  </code>
                  <StatusWord
                    tone={message.state === 'failed' ? 'failed' : message.state === 'running' && connected ? 'running' : 'neutral'}
                    data-lock={message.interrupted ? '' : undefined}>
                    {message.interrupted ? '结果未知' : message.state ? commandWords[message.state] : '未报告结果'}
                  </StatusWord>
                </li>
              )
            })}
          </ul>
        </section>
      )}
      {showDelivery && (
        <section className="session-overview-section">
          <header>
            <h3>交付</h3>
            {pr && <Icon icon={PullRequestGlyph} size={16} />}
          </header>
          {!shell.canDeliver ? (
            <p>这台设备不能进行交付</p>
          ) : (
            <>
              {evidence.error || entry?.error ? (
                <InlineNotice tone="warn">{evidence.error ?? entry?.error?.message}</InlineNotice>
              ) : state ? (
                <>
                  {state.branch && (
                    <div className="session-overview-branch">
                      <Icon icon={BranchGlyph} size={14} />
                      <VisibleText text={state.branch} />
                      {pr?.base && (
                        <>
                          <span>→</span>
                          <VisibleText text={pr.base} />
                        </>
                      )}
                    </div>
                  )}
                  <ol className="session-overview-steps" aria-label="交付步骤">
                    {['提交', '推送', '开 PR'].map((label, index) => (
                      <li key={label} aria-current={index === stage ? 'step' : undefined}>
                        {label}
                      </li>
                    ))}
                  </ol>
                  <p>
                    {state.conflicted
                      ? `${state.conflicted} 个文件有冲突`
                      : state.gitOperation
                        ? 'Git 操作尚未结束'
                        : state.files
                          ? `目录未提交 ${state.files} 个文件`
                          : state.ahead > 0
                            ? `${state.ahead} 个提交未推送`
                            : '目录没有未提交的改动'}
                  </p>
                </>
              ) : (
                <p>{evidence.loading ? '正在读取目录…' : '尚未读取目录状态'}</p>
              )}
              {pr && (
                <p className="session-overview-pr">
                  #{pr.number} <VisibleText text={pr.title} />
                </p>
              )}
              {checks && <p>{checks}</p>}
              {entry?.prError && <InlineNotice tone="warn">{entry.prError.message}</InlineNotice>}
              <Button size="sm" onClick={() => shell.showSurface({ kind: 'delivery' })}>
                {state ? next : '查看交付'}
              </Button>
              {!connected && entry && (
                <p>上次状态 {new Date(entry.observedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</p>
              )}
            </>
          )}
        </section>
      )}
    </div>
  )
}
