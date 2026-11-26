import { useMemo, type ReactNode } from 'react'
import { readsProjectFiles, type FileChange, type Message, type TaskSummary } from '@latch/protocol'
import {
  Button,
  Count,
  DiffGlyph,
  Icon,
  BranchGlyph,
  PullRequestGlyph,
  LockGlyph,
  WarningGlyph,
  Tooltip,
  type IconComponent,
} from '@latch/ui'
import { overviewAgents } from './overviewAgents.ts'
import { OverviewAgentSection } from './OverviewAgentSection.tsx'
import { OverviewPendingSection, OverviewPlanSection, OverviewProjectSection, OverviewSessionSection } from './SessionOverviewMeta.tsx'
import { switchWorkView } from '../preferences.ts'
import { BranchName } from '../components/MiddleEllipsis.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { turnsOf } from '../conversation.ts'
import { projectOf } from '../sessions.ts'
import { deliveryChecks, useWorkbenchDelivery } from './useWorkbenchEvidence.ts'
import type { ShellState } from './useShellLayout.tsx'
import { currentLocale, defineCopy, plural } from '../core/i18n.ts'
import { describeFailure } from '../core/securityCopy.ts'

const COPY = defineCopy(
  {
    last: (time: string) => `上次 ${time}`,
    conflictsAction: '查看冲突',
    gitStatus: '查看 Git 状态',
    commit: (count: number) => `提交 ${count} 个文件…`,
    push: '推送提交…',
    pullRequest: '查看 PR',
    openPR: '开 PR…',
    changes: '这次改动',
    sessionChanges: '本会话改动',
    all: '全部',
    changesDenied: '这台设备不能读取项目改动',
    loading: '正在读取…',
    added: '新增',
    deleted: '删除',
    modified: '修改',
    changesFailed: '读不到本轮改动',
    checking: '正在核对…',
    partial: '只列出部分',
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
    last: (time: string) => `Last: ${time}`,
    conflictsAction: 'View conflicts',
    gitStatus: 'View Git status',
    commit: (count: number) => plural(count, { one: 'Commit {n} file…', other: 'Commit {n} files…' }),
    push: 'Push commits…',
    pullRequest: 'View PR',
    openPR: 'Open PR…',
    changes: 'Changes',
    sessionChanges: 'Session changes',
    all: 'All',
    changesDenied: 'This device can’t read project changes',
    loading: 'Loading…',
    added: 'Added',
    deleted: 'Deleted',
    modified: 'Modified',
    changesFailed: 'Can’t read changes from this turn',
    checking: 'Checking…',
    partial: 'Partial list',
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

const clock = (at: string) => new Date(at).toLocaleTimeString(currentLocale(), { hour: '2-digit', minute: '2-digit' })

/** Earlier turns' recorded file outputs, newest touch first, used when the latest turn was a pure reply or question. */
function sessionOutputs(messages: readonly Message[]): FileChange[] {
  const byKey = new Map<string, { first: FileChange['change']; latest: FileChange }>()
  for (const message of messages) {
    for (const file of message.outputs ?? []) {
      const key = `${file.root}:${file.path}`
      const previous = byKey.get(key)
      byKey.delete(key)
      byKey.set(key, { first: previous ? previous.first : file.change, latest: file })
    }
  }
  return [...byKey.values()]
    .toReversed()
    .map(({ first, latest }) => (first === 'created' && latest.change === 'modified' ? { ...latest, change: 'created' as const } : latest))
}

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

/** The session's participants, pending decisions, live plan, file changes, delivery state, and project/session facts. */
export function SessionOverview({ shell, summary }: { shell: ShellState; summary: TaskSummary }) {
  const connected = shell.connection === 'connected'
  const canReadChanges = shell.canViewChanges && readsProjectFiles(shell.snapshot.device.dataScope)
  const detail = shell.current?.summary.id === summary.id ? shell.current : null
  const panelActive =
    shell.route.entry === 'sessions' && !shell.route.start && !shell.board && (shell.pageMode ? shell.infoPage : shell.columnOpen)
  const roster = useMemo(
    () => overviewAgents(summary.id, shell.snapshot.teams, detail?.messages ?? [], detail?.approvals ?? []),
    [summary.id, shell.snapshot.teams, detail?.messages, detail?.approvals],
  )
  const showConversation = () => {
    switchWorkView('chat')
    if (shell.placement?.kind === 'sheet') shell.closePanel()
    else if (shell.pageMode) shell.closeInfoPage()
  }
  const agentSection = {
    connected,
    harnesses: shell.catalog?.harnesses ?? [],
    actions: {
      openSession: (id: string) => shell.choose(id, showConversation),
      reveal: (id: string) => {
        if (shell.revealContextRow(summary.id, 'subagent', id)) showConversation()
      },
      review: (id: string) => {
        shell.selectApproval(id)
        showConversation()
      },
    },
  }
  const approvals = useMemo(
    () => (detail ? detail.approvals : shell.snapshot.approvals.filter(approval => approval.sessionId === summary.id)),
    [detail, shell.snapshot.approvals, summary.id],
  )
  const proposals = useMemo(
    () => (shell.snapshot.workProposals ?? []).filter(proposal => proposal.from.sessionId === summary.id),
    [shell.snapshot.workProposals, summary.id],
  )
  const turn = detail ? turnsOf(detail.messages).at(-1) : undefined
  const messages = turn?.replies ?? []
  const changes = detail?.fileChanges?.files ?? messages.flatMap(message => message.outputs ?? [])
  const turnDistinct = [...new Map(changes.map(file => [`${file.root}:${file.path}`, file])).values()]
  const unavailable = detail?.fileChanges?.unavailable || messages.some(message => message.outputsUnavailable)
  const pending = detail?.fileChanges?.state === 'settling' || messages.some(message => message.outputsPending)
  const truncated = detail?.fileChanges?.truncated || messages.some(message => message.outputsTruncated)
  const earlierDistinct = useMemo(
    () => (detail && turnDistinct.length === 0 && !unavailable && !pending && !truncated ? sessionOutputs(detail.messages) : []),
    [detail, pending, truncated, turnDistinct.length, unavailable],
  )
  const usingSessionScope = turnDistinct.length === 0 && earlierDistinct.length > 0
  const distinct = usingSessionScope ? earlierDistinct : turnDistinct
  const evidence = useWorkbenchDelivery(shell.snapshot, shell.connection, panelActive, [summary.id])
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
  const showChanges = !canReadChanges || !detail || unavailable || pending || truncated || distinct.length > 0
  // A folder without Git has nothing to deliver, and what this device may not read is already said once above.
  const showDelivery =
    readsProjectFiles(shell.snapshot.device.dataScope) && (!shell.canDeliver || !!failure || entry?.notApplicable !== 'not-repository')
  const project = shell.catalog ? projectOf(summary, shell.catalog.workspaces) : undefined
  const canReadBranches =
    connected
    && shell.catalog?.features?.projectFolderBranches === true
    && shell.access.scopes.has('view')
    && readsProjectFiles(shell.snapshot.device.dataScope)
  const activeRun = connected && (summary.status === 'running' || summary.status === 'waiting-approval')

  return (
    <div className="session-overview">
      <OverviewAgentSection team rows={roster.members} {...agentSection} />
      <OverviewAgentSection rows={roster.children} {...agentSection} />
      <OverviewPendingSection
        approvals={approvals}
        questions={detail?.questions ?? []}
        proposals={proposals}
        onApproval={id => {
          shell.selectApproval(id)
          showConversation()
        }}
        onQuestion={id => {
          showConversation()
          requestAnimationFrame(() =>
            document.querySelector<HTMLElement>(`.workspace-view [data-question-id="${CSS.escape(id)}"] button:not(:disabled)`)?.focus({
              preventScroll: true,
            }),
          )
        }}
        onProposal={messageId => {
          if (messageId) shell.revealContextRow(summary.id, 'turn', messageId)
          showConversation()
        }}
      />
      {detail?.plan && detail.plan.length > 0 && <OverviewPlanSection plan={detail.plan} active={activeRun} />}
      {showChanges && (
        <Section
          title={usingSessionScope ? COPY.sessionChanges : COPY.changes}
          {...(canReadChanges && detail && !unavailable && !pending ? { count: distinct.length } : {})}
          {...(distinct.length > 0
            ? {
                action: (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      shell.openChangesTab(
                        usingSessionScope ? { scope: 'session' } : turn?.user?.turnId ? { turnId: turn.user.turnId } : undefined,
                      )
                    }>
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
                        ...(usingSessionScope ? { scope: 'session' as const } : turn?.user?.turnId ? { turnId: turn.user.turnId } : {}),
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
      <OverviewProjectSection
        summary={summary}
        project={project}
        shell={shell}
        active={panelActive}
        canReadBranches={canReadBranches}
        deliveryShown={showDelivery}
      />
      <OverviewSessionSection
        summary={summary}
        detail={detail}
        harness={shell.topHarness}
        shell={shell}
        canOpenContext={shell.panelAvailable('context')}
      />
    </div>
  )
}
