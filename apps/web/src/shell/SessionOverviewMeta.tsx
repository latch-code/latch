import { useEffect, useState } from 'react'
import { CircleHelp, FolderGit2, Lightbulb } from 'lucide-react'
import type {
  AgentQuestion,
  Approval,
  HarnessInfo,
  PlanEntry,
  ProjectFolderBranches,
  SessionConfigOption,
  TaskDetail,
  TaskSummary,
  WorkProposalSummary,
  WorkspaceInfo,
} from '@latch/protocol'
import {
  Badge,
  BranchGlyph,
  Button,
  ChevronRightGlyph,
  CopyButton,
  Count,
  FolderGlyph,
  FolderOpenGlyph,
  Icon,
  IconButton,
  InlineNotice,
  ProjectGlyph,
  ShieldAlertGlyph,
  ShieldGlyph,
  StatusWord,
  Tooltip,
} from '@latch/ui'
import { CodeRootNotice, codeRootWorkspace } from '../components/CodeRootNotice.tsx'
import { BranchName } from '../components/MiddleEllipsis.tsx'
import { PlanList, planProgress } from '../components/PlanCard.tsx'
import { MiddleText } from '../components/ui.tsx'
import { escapeHiddenCharacters, VisibleText } from '../components/VisibleText.tsx'
import { pendingEntries, todoProposals } from '../board/proposals.ts'
import { harnessName, sessionHarness } from '../composerChoice.ts'
import { permissionTip, permissionView } from '../composer/permission.ts'
import { costClause, sessionTotals } from '../composer/sessionTotals.ts'
import { shownToolTitle } from '../conversation/toolTitles.ts'
import { api, errorMessage } from '../core/api.ts'
import { parseTime, useTicker } from '../core/hostClock.ts'
import { defineCopy, formatNumber, plural } from '../core/i18n.ts'
import { currentShell, revealLabel, shellFolders } from '../core/shell.ts'
import { absoluteTime, basename, formatDuration, formatTokens, messageTime, tokenAmount } from '../format.ts'
import { folderAccessText, projectFolders, projectName } from '../projects.tsx'
import { rowGateway, rowModel } from '../sessions.ts'
import { frozenFolders } from './SessionEnvironment.tsx'
import type { ShellState } from './useShellLayout.tsx'

const COPY = defineCopy(
  {
    attention: '等你处理',
    approvePlan: '批准计划',
    proposedTodo: '提议待办',
    proposedTodos: (count: number) => `提议 ${formatNumber(count)} 条待办`,
    cardSuggestion: '卡片建议',
    review: '待审阅',
    plan: '计划',
    planDone: (done: number, total: number) => `已完成 ${formatNumber(done)}/${formatNumber(total)}`,
    project: '项目',
    files: '文件',
    sessionFolder: '会话文件夹',
    worktree: '工作树',
    worktreeRemoved: '工作树已移除',
    folderCount: (count: number) => `${formatNumber(count)} 个文件夹`,
    missing: '找不到',
    removed: '已移出项目',
    missingFolder: '找不到这个文件夹，请同步后重试。',
    copyPath: (path: string) => `复制路径：${path}`,
    session: '会话',
    context: '上下文',
    model: '模型',
    harness: 'Harness',
    viaGateway: ' · 经 Latch 网关',
    permissions: '权限',
    permissionsChanged: '权限已变化',
    usage: '用量',
    input: '输入',
    output: '· 输出',
    cost: '费用',
    turns: '轮数',
    time: '用时',
    started: '开始于',
    readOnly: '该会话不再接受输入。',
  },
  {
    attention: 'Needs you',
    approvePlan: 'Approve plan',
    proposedTodo: 'Proposed task',
    proposedTodos: (count: number) => `${formatNumber(count)} proposed tasks`,
    cardSuggestion: 'Card suggestion',
    review: 'Review',
    plan: 'Plan',
    planDone: (done: number, total: number) => `${formatNumber(done)}/${formatNumber(total)} done`,
    project: 'Project',
    files: 'Files',
    sessionFolder: 'Session folder',
    worktree: 'Worktree',
    worktreeRemoved: 'Worktree removed',
    folderCount: (count: number) => plural(count, { one: '{n} folder', other: '{n} folders' }),
    missing: 'Missing',
    removed: 'Removed from project',
    missingFolder: 'Can’t find this folder. Sync and try again.',
    copyPath: (path: string) => `Copy path: ${path}`,
    session: 'Session',
    context: 'Context',
    model: 'Model',
    harness: 'Harness',
    viaGateway: ' · via Latch gateway',
    permissions: 'Permissions',
    permissionsChanged: 'Permissions changed',
    usage: 'Usage',
    input: 'Input',
    output: '· Output',
    cost: 'Cost',
    turns: 'Turns',
    time: 'Duration',
    started: 'Started',
    readOnly: 'This session no longer accepts input.',
  },
)

function approvalTitle(approval: Approval): string {
  const base =
    approval.plan !== undefined
      ? COPY.approvePlan
      : approval.tool?.toolTitle
        ? shownToolTitle(approval.tool.toolTitle, approval.toolName)
        : approval.tool?.title || approval.reason || approval.toolName
  return approval.subagent ? `${base} · ${approval.subagent}` : base
}

function proposalTitle(proposal: WorkProposalSummary): string {
  if (proposal.kind === 'todo' && proposal.entries) {
    const entries = pendingEntries({ ...proposal, kind: 'todo', entries: proposal.entries })
    return proposal.goal || entries[0]?.title || (entries.length > 1 ? COPY.proposedTodos(entries.length) : COPY.proposedTodo)
  }
  return proposal.change?.title || proposal.change?.note || COPY.cardSuggestion
}

/** Pending approvals, questions and board proposals of this session, each opening where it is answered. */
export function OverviewPendingSection({
  approvals,
  questions,
  proposals,
  onApproval,
  onQuestion,
  onProposal,
}: {
  approvals: readonly Approval[]
  questions: readonly AgentQuestion[]
  proposals: readonly WorkProposalSummary[]
  onApproval: (id: string) => void
  onQuestion: (id: string) => void
  onProposal: (messageId: string | undefined) => void
}) {
  const todos = todoProposals(proposals)
  const changes = proposals.filter(row => row.kind === 'change' && row.change?.state === 'pending')
  const listedProposals = [...todos, ...changes]
  const total = approvals.length + questions.length + listedProposals.length
  if (total === 0) return null
  return (
    <section className="session-overview-section" aria-label={COPY.attention}>
      <header>
        <h3>{COPY.attention}</h3>
        <Count value={total} />
      </header>
      <ul>
        {approvals.map(approval => (
          <li key={`approval:${approval.id}`} className="session-overview-row" data-tone="warn">
            <Icon icon={approval.risk === 'R2' ? ShieldAlertGlyph : ShieldGlyph} size={14} className="session-overview-glyph" />
            <span className="session-overview-text">
              <button type="button" className="session-overview-link" onClick={() => onApproval(approval.id)}>
                <VisibleText text={approvalTitle(approval)} />
              </button>
            </span>
            <StatusWord tone="waiting">{COPY.attention}</StatusWord>
          </li>
        ))}
        {questions.map(question => (
          <li key={`question:${question.id}`} className="session-overview-row" data-tone="warn">
            <Icon icon={CircleHelp} size={14} className="session-overview-glyph" />
            <span className="session-overview-text">
              <button type="button" className="session-overview-link" onClick={() => onQuestion(question.id)}>
                <VisibleText text={question.questions[0]?.label || question.prompt} />
              </button>
            </span>
            <StatusWord tone="waiting">{COPY.attention}</StatusWord>
          </li>
        ))}
        {listedProposals.map(proposal => (
          <li key={`proposal:${proposal.id}`} className="session-overview-row">
            <Icon icon={Lightbulb} size={14} className="session-overview-glyph" />
            <span className="session-overview-text">
              <button type="button" className="session-overview-link" onClick={() => onProposal(proposal.from.messageId)}>
                <VisibleText text={proposalTitle(proposal)} />
              </button>
            </span>
            <span className="session-overview-word">{COPY.review}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The agent's reported plan, kept open beside the conversation so its steps remain visible as the chat scrolls. */
export function OverviewPlanSection({ plan, active }: { plan: PlanEntry[]; active: boolean }) {
  const [open, setOpen] = useState(true)
  if (!plan.length) return null
  const { done, total } = planProgress(plan)
  return (
    <section className="session-overview-section overview-plan" aria-label={COPY.plan}>
      <h3>
        <button type="button" className="overview-agents-heading" aria-expanded={open} onClick={() => setOpen(!open)}>
          {COPY.plan}
          <Count value={total} />
          <span className="overview-agents-activity">{COPY.planDone(done, total)}</span>
          <Icon icon={ChevronRightGlyph} size={12} />
        </button>
      </h3>
      {open && <PlanList plan={plan} active={active} />}
    </section>
  )
}

/** The project and frozen folders this session runs in, with per-folder branches for multi-folder projects. */
export function OverviewProjectSection({
  summary,
  project,
  shell,
  active,
  canReadBranches,
  deliveryShown,
}: {
  summary: TaskSummary
  project: WorkspaceInfo | undefined
  shell: ShellState
  active: boolean
  canReadBranches: boolean
  deliveryShown: boolean
}) {
  const [error, setError] = useState('')
  const [branches, setBranches] = useState<ProjectFolderBranches>()
  const folders = frozenFolders(summary)
  const catalog = shell.catalog
  const harness = sessionHarness(catalog, summary)
  const folderShell = shell.access.local && shell.access.admin ? shellFolders() : null
  const allFolders = harness?.projectFolders?.access === 'all'
  const codeRoot = summary.cwd ? codeRootWorkspace(catalog?.workspaces, { path: summary.cwd }) : undefined
  const readMultiBranches = active && canReadBranches && project !== undefined && folders.length > 1

  useEffect(() => {
    if (!readMultiBranches || !project) return undefined
    let pending: AbortController | undefined
    const read = () => {
      pending?.abort()
      if (document.hidden) return
      const controller = new AbortController()
      pending = controller
      void api<ProjectFolderBranches>(`workspaces/${encodeURIComponent(project.id)}/folder-branches`, { signal: controller.signal })
        .then(reply => {
          if (!controller.signal.aborted) setBranches(reply)
        })
        .catch(() => {
          if (!controller.signal.aborted) setBranches(undefined)
        })
    }
    read()
    const timer = window.setInterval(read, 30_000)
    document.addEventListener('visibilitychange', read)
    return () => {
      pending?.abort()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', read)
    }
  }, [project?.id, readMultiBranches])

  if (summary.mode === 'chat' || (!project && folders.length === 0)) return null
  const projectState = summary.worktree
    ? summary.worktree.removed
      ? COPY.worktreeRemoved
      : COPY.worktree
    : folders.length > 1
      ? COPY.folderCount(folders.length)
      : undefined
  return (
    <section className="session-overview-section" aria-label={COPY.project}>
      <header>
        <h3>{COPY.project}</h3>
        {shell.canBrowseFiles && (
          <Button size="xs" variant="ghost" onClick={() => shell.showSurface({ kind: 'files' })}>
            {COPY.files}
          </Button>
        )}
      </header>
      <ul>
        {(project || summary.worktree) && (
          <li className="session-overview-row">
            <Icon icon={summary.worktree ? FolderGit2 : ProjectGlyph} size={14} className="session-overview-glyph" />
            <span className="session-overview-text">{project ? <VisibleText text={projectName(project)} /> : COPY.sessionFolder}</span>
            {projectState && <span className="session-overview-word">{projectState}</span>}
          </li>
        )}
        {folders.map((folder, index) => {
          const known = project ? projectFolders(project).find(item => item.id === folder.id && item.path === folder.path) : undefined
          const removed = project !== undefined && summary.folders !== undefined && known === undefined
          const unused = index > 0 && !allFolders
          const folderBranch =
            folders.length > 1
              ? branches?.folders.find(item => item.id === folder.id && item.path === folder.path)?.branch
              : !deliveryShown
                ? summary.branch
                : undefined
          return (
            <li key={folder.id} className="session-overview-row session-overview-folder" data-unused={unused ? '' : undefined}>
              <Icon icon={FolderGlyph} size={14} className="session-overview-glyph" />
              <Tooltip content={<VisibleText text={folder.path} />}>
                <code className="session-overview-path" tabIndex={0}>
                  <MiddleText text={folder.path} />
                </code>
              </Tooltip>
              {known?.unavailable ? (
                <Badge tone="warn">{COPY.missing}</Badge>
              ) : removed ? (
                <Badge>{COPY.removed}</Badge>
              ) : folderBranch ? (
                <span className="session-overview-branch">
                  <Icon icon={BranchGlyph} size={12} />
                  <BranchName branch={folderBranch} title />
                </span>
              ) : null}
              <span className="session-overview-folder-actions">
                {folderShell && project && known && !known.unavailable && (
                  <IconButton
                    size="xs"
                    label={revealLabel(currentShell()?.platform)}
                    icon={FolderOpenGlyph}
                    onClick={() => {
                      void folderShell
                        .reveal(project.id, known.id)
                        .then(result => {
                          if (result.status === 'failed') setError(COPY.missingFolder)
                        })
                        .catch(cause => {
                          setError(errorMessage(cause))
                        })
                    }}
                  />
                )}
                <CopyButton text={folder.path} label={COPY.copyPath(basename(folder.path))} size="xs" />
              </span>
            </li>
          )
        })}
      </ul>
      {folders.length > 1 && harness && !allFolders && (
        <p className="session-overview-note">
          {harness.capabilities.display.label}：{folderAccessText(harness, folders.length)}
        </p>
      )}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {codeRoot && <CodeRootNotice workspace={codeRoot} />}
    </section>
  )
}

/** The session's runtime configuration, permission mode, context window share, and accumulated usage. */
export function OverviewSessionSection({
  summary,
  detail,
  harness,
  shell,
  canOpenContext,
}: {
  summary: TaskSummary
  detail: TaskDetail | null
  harness: HarnessInfo | undefined
  shell: ShellState
  canOpenContext: boolean
}) {
  const now = useTicker('minute')
  const totals = sessionTotals({ summary, detail, harness })
  const created = parseTime(summary.createdAt)
  const model = rowModel(summary)
  const gateway = rowGateway(summary)
  const harnessLabel = harness ? harnessName(harness) : undefined
  const perm = permissionView({
    harness,
    mode: summary.mode,
    ...(detail?.permission ? { permission: detail.permission } : {}),
    config: detail?.config ?? [],
    access: { legacy: shell.access.legacy, local: shell.access.local, scopes: shell.access.scopes },
  })
  const tip = perm ? permissionTip(perm) : undefined
  const lockedConfig: readonly SessionConfigOption[] =
    shell.gate.kind !== 'open' && detail?.summary.id === summary.id ? (detail.config ?? []) : []
  const contextText = totals.context
    ? totals.context.size !== undefined
      ? `${formatTokens(totals.context.used)} / ${tokenAmount(totals.context.size)}${totals.context.percent !== undefined ? `（${totals.context.percent}%）` : ''}`
      : tokenAmount(totals.context.used)
    : undefined

  return (
    <section className="session-overview-section" aria-label={COPY.session}>
      <header>
        <h3>{COPY.session}</h3>
        {canOpenContext && (
          <Button size="xs" variant="ghost" onClick={() => shell.showSurface({ kind: 'context' })}>
            {COPY.context}
          </Button>
        )}
      </header>
      <div className="session-overview-facts">
        {(harnessLabel || model) && (
          <div className="crumb-row">
            <span className="crumb-label">{model ? COPY.model : COPY.harness}</span>
            <div className="crumb-value">
              <span>
                {[harnessLabel, model].filter(Boolean).join(' · ')}
                {gateway && <span className="session-overview-base">{COPY.viaGateway}</span>}
              </span>
            </div>
          </div>
        )}
        {(summary.permissionDrift || perm) && (
          <div className="crumb-row">
            <span className="crumb-label">{COPY.permissions}</span>
            <div className="crumb-value">
              <Tooltip content={summary.permissionDrift ? undefined : tip}>
                <span tabIndex={!summary.permissionDrift && tip ? 0 : undefined}>
                  <StatusWord tone={summary.permissionDrift ? 'failed' : perm?.amber ? 'warn' : 'neutral'}>
                    {summary.permissionDrift ? COPY.permissionsChanged : escapeHiddenCharacters(perm!.label)}
                  </StatusWord>
                </span>
              </Tooltip>
            </div>
          </div>
        )}
        {contextText && (
          <div className="crumb-row">
            <span className="crumb-label">{COPY.context}</span>
            <div className="crumb-value">
              {canOpenContext ? (
                <button type="button" className="session-overview-link" onClick={() => shell.showSurface({ kind: 'context' })}>
                  {contextText}
                </button>
              ) : (
                <span>{contextText}</span>
              )}
            </div>
          </div>
        )}
        {totals.time && (
          <div className="crumb-row">
            <span className="crumb-label">{formatDuration(totals.time.ms) === undefined ? COPY.turns : COPY.time}</span>
            <div className="crumb-value">{totals.time.text}</div>
          </div>
        )}
        {totals.tokens && (
          <div className="crumb-row">
            <span className="crumb-label">{COPY.usage}</span>
            <div className="crumb-value">
              <span>
                {COPY.input} {tokenAmount(totals.tokens.usage.inputTokens)} {COPY.output} {tokenAmount(totals.tokens.usage.outputTokens)}
              </span>
            </div>
          </div>
        )}
        {totals.cost && (
          <div className="crumb-row">
            <span className="crumb-label">{COPY.cost}</span>
            <div className="crumb-value">
              {totals.cost.text} · {costClause(totals.cost.reporter)}
            </div>
          </div>
        )}
        {created !== undefined && (
          <div className="crumb-row">
            <span className="crumb-label">{COPY.started}</span>
            <div className="crumb-value">
              <Tooltip content={absoluteTime(created)}>
                <time dateTime={new Date(created).toISOString()} tabIndex={0}>
                  {messageTime(created, now)}
                </time>
              </Tooltip>
            </div>
          </div>
        )}
        {lockedConfig.map(option => (
          <div key={option.id} className="crumb-row">
            <span className="crumb-label">{escapeHiddenCharacters(option.name)}</span>
            <div className="crumb-value">
              {escapeHiddenCharacters(option.options.find(item => item.value === option.currentValue)?.name ?? option.currentValue)}
            </div>
          </div>
        ))}
        {lockedConfig.length > 0 && (
          <p className="session-overview-note">{shell.gate.kind === 'read-only' ? shell.gate.text : COPY.readOnly}</p>
        )}
      </div>
    </section>
  )
}
