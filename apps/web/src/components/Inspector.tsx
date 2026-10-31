import { useContext, useEffect, useState, type ReactNode } from 'react'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Bot,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  Cpu,
  FileText,
  Eye,
  Folder,
  FolderOpen,
  FolderPlus,
  Gauge,
  Laptop,
  LockKeyhole,
  Shield,
  ShieldAlert,
  SlidersHorizontal,
  Timer,
} from 'lucide-react'
import {
  AGENT_PRESETS,
  type AgentSettings,
  type AppSnapshot,
  type Message,
  type ModelRef,
  type SessionConfigOption,
  type TaskDetail,
  type TaskSummary,
} from '@latch/protocol'
import { presetOf } from '../brands.ts'
import { findProvider, harnessName as harnessNameOf, sameModel, sessionHarness, usesDemoModel } from '../composerChoice.ts'
import { appliedDiffs, turnsOf } from '../conversation.ts'
import { api, errorMessage } from '../core/api.ts'
import { currentShell, revealLabel, shellFolders } from '../core/shell.ts'
import { projectOf } from '../sessions.ts'
import { folderAccessText, projectFolders, projectName } from '../projects.tsx'
import { parseDuration, parseTime, useTicker } from '../core/hostClock.ts'
import { diffLines } from '../diff.ts'
import { absoluteTime, basename, exactTokens, formatDuration, formatTokens, messageTime, tokenAmount, tokenLines } from '../format.ts'
import { HarnessTile, ProviderTile } from './BrandTile.tsx'
import { CodeRootNotice, codeRootWorkspace } from './CodeRootNotice.tsx'
import { InlineConfirm } from './InlineConfirm.tsx'
import { PlanList, planProgress } from './PlanCard.tsx'
import { modelFromKey, modelGroups, modelKey } from './pickerOptions.tsx'
import { MiddleText } from './ui.tsx'
import {
  Badge,
  Button,
  Collapse,
  ICON_STROKE,
  IconButton,
  InlineNotice,
  StatusPill,
  Tooltip,
  ValuePicker,
  type LucideIcon,
  CopyButton,
} from '@latch/ui'
import { VisibleText } from './VisibleText.tsx'
import { FileOpenContext } from '../preview/fileContext.ts'
import { fileHistories, type FileHistory } from '../preview/fileHistory.ts'

/** The blocks, in their order; each folds from its header and the choice is remembered on this device. */
export type InfoBlock = 'agent' | 'environment' | 'permission' | 'usage' | 'plan' | 'changes'

function Block({
  id,
  title,
  meta,
  collapsed,
  onToggle,
  children,
}: {
  id: InfoBlock
  title: string
  meta?: ReactNode
  collapsed: boolean
  onToggle: (id: InfoBlock, collapsed: boolean) => void
  children: ReactNode
}) {
  const open = !collapsed
  return (
    <section className="info-block" data-block={id} data-open={open ? '' : undefined} aria-label={title}>
      <header className="info-block-head">
        <button
          type="button"
          className="info-block-title"
          aria-expanded={open}
          onClick={() => {
            onToggle(id, open)
          }}>
          {title}
          <ChevronDown className="info-block-chevron" size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
        </button>
        {meta !== undefined && <span className="info-block-meta">{meta}</span>}
      </header>
      <Collapse
        open={open}
        onReveal={() => {
          onToggle(id, false)
        }}>
        <div className="info-block-body">{children}</div>
      </Collapse>
    </section>
  )
}

/** A row of a block: a 16px icon, the label in hint ink and the value in ink. */
function Row({
  icon: Icon,
  label,
  tone,
  two,
  children,
}: {
  icon: LucideIcon
  label: string
  tone?: 'warn'
  two?: boolean
  children: ReactNode
}) {
  return (
    <div className={`info-row ${two ? 'is-two' : ''}`}>
      <span className={`info-icon ${tone === 'warn' ? 'is-warn' : ''}`} aria-hidden="true">
        <Icon size={16} strokeWidth={ICON_STROKE[16]} />
      </span>
      <span className="info-key">{label}</span>
      <span className="info-value">{children}</span>
    </div>
  )
}

const MODE_CATEGORY = 'mode'

/**
 * The changes of the session's tools, one row per file: lines added and removed over every diff, and the last tool. A
 * diff counts once it was applied as far as the reports go: not while its call waits for an approval or in the queue,
 * nor when its approval kept the call from running (`appliedDiffs`).
 */
export function fileChanges(messages: Message[]): Array<{ path: string; added: number; removed: number; known: boolean; toolId: string }> {
  const files = new Map<string, { path: string; added: number; removed: number; known: boolean; toolId: string }>()
  for (const message of messages) {
    if (message.role !== 'tool') continue
    for (const diff of appliedDiffs(message)) {
      const view = diffLines(diff.oldText, diff.newText)
      const entry = files.get(diff.path) ?? { path: diff.path, added: 0, removed: 0, known: true, toolId: message.id }
      entry.added += view.added
      entry.removed += view.removed
      // A removal count is only known when the Host showed the previous text, as in the diff itself.
      entry.known &&= diff.previous === 'text'
      entry.toolId = message.id
      files.set(diff.path, entry)
    }
  }
  return [...files.values()]
}

function splitPath(path: string): { folder: string; name: string } {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at < 0 ? { folder: '', name: path } : { folder: path.slice(0, at + 1), name: path.slice(at + 1) }
}

/**
 * The command an added agent runs, for an administrator: the Host lists agent definitions only to admin devices, so
 * others never ask. It is read once per agent while the block is shown; a failed read leaves it out.
 */
function useAgentCommand(harnessId: string | undefined): AgentSettings | undefined {
  const [found, setFound] = useState<{ id: string; agent: AgentSettings } | null>(null)
  useEffect(() => {
    if (harnessId === undefined) return undefined
    let active = true
    void api<{ agents: AgentSettings[] }>('agents')
      .then(data => {
        const agent = data.agents.find(item => item.id === harnessId)
        if (active && agent) setFound({ id: harnessId, agent })
      })
      .catch(() => {
        /* The source line keeps ACP and the licence. */
      })
    return () => {
      active = false
    }
  }, [harnessId])
  return found !== null && found.id === harnessId ? found.agent : undefined
}

/** What the session's model and options are, and how this device may change them. */
export interface InfoControls {
  /** The model for the next prompt (a host-model harness); the switch applies from the next message. */
  model?: { value?: ModelRef; current?: ModelRef; onChange: (model: ModelRef | undefined) => void }
  /** The harness's own options (an agent's model and mode); a widening mode asks for a local confirmation. */
  config: SessionConfigOption[]
  busy: string | null
  onConfig: (configId: string, value: string) => void | Promise<void>
  /** Why this device sees the values but cannot change them. */
  locked?: string
}

/**
 * 会话信息: independent blocks, each a card that folds from its header. Agent (the harness, its model, its mode and how
 * the session talks to it), 环境 (the computer and the project), 权限 (who enforces the session's permissions, with the
 * facts behind it), 用量, 计划 and 变更 (the files the session's tools changed, each opening its tool in the
 * conversation). A block with nothing to show is left out.
 */
export function Inspector({
  snapshot,
  summary,
  detail,
  local,
  admin = false,
  controls,
  collapsed,
  onToggleBlock,
  onReveal,
  onNewProject,
  onProjectsChanged,
  onEditProject,
  onSource,
}: {
  snapshot: AppSnapshot
  summary: TaskSummary
  detail: TaskDetail | null
  /** This page runs in the desktop shell on the Host's own computer. */
  local: boolean
  /** This device administers the Host: the Agent block names the command an added agent runs. */
  admin?: boolean
  controls?: InfoControls
  collapsed: ReadonlySet<string>
  onToggleBlock: (id: InfoBlock, collapsed: boolean) => void
  onReveal: (messageId: string) => void
  /** Where this device can make a project: the way out of a start directory inside Latch's program directory. */
  onNewProject?: () => void
  onProjectsChanged?: () => void
  onEditProject?: (id: string) => void
  onSource?: (sessionId: string) => void
}) {
  const [factsOpen, setFactsOpen] = useState(false)
  const openFile = useContext(FileOpenContext)
  const [savingProject, setSavingProject] = useState(false)
  const [folderError, setFolderError] = useState('')
  useEffect(() => {
    setFolderError('')
  }, [summary.id])
  const now = useTicker('minute')
  const catalog = snapshot.catalog
  const harness = sessionHarness(catalog, summary)
  const project = catalog ? projectOf(summary, catalog.workspaces) : undefined
  const frozenFolders = summary.folders?.length ? summary.folders : summary.cwd ? [{ id: 'default', path: summary.cwd }] : []
  const folderShell = local && admin ? shellFolders() : null
  const allFolders = harness?.projectFolders?.access === 'all'
  const saveSessionProject =
    folderShell?.saveSessionFolder && summary.sessionFolder && !project
      ? async () => {
          setSavingProject(true)
          setFolderError('')
          try {
            const result = await folderShell.saveSessionFolder!(summary.id)
            if (result.status === 'added') {
              onProjectsChanged?.()
              const id = result.added[0]?.workspaceId
              if (id) onEditProject?.(id)
              if (result.refused.length) setFolderError('没有保存这个会话的文件夹，请在项目设置中重试。')
            } else if (result.status === 'busy') setFolderError('另一个系统对话框还没结束。')
            else if (result.status === 'failed') setFolderError('没有保存这个会话的文件夹，请同步后重试。')
          } catch (cause) {
            setFolderError(errorMessage(cause))
          } finally {
            setSavingProject(false)
          }
        }
      : undefined
  const harnessName = harness ? harnessNameOf(harness) : (snapshot.harness?.name ?? 'Latch')
  const own = detail?.summary.id === summary.id ? detail : null
  const permission = own?.permission
  const level = permission?.level ?? summary.level
  const drift = summary.permissionDrift || permission?.drift
  const preset =
    harness?.source === 'acp' ? presetOf(harness.id, Object.fromEntries(AGENT_PRESETS.map(item => [item.id, item]))) : undefined
  const license = AGENT_PRESETS.find(item => item.id === preset)?.license
  const definition = useAgentCommand(admin && harness?.source === 'acp' ? harness.id : undefined)
  const commandLine = definition ? [definition.command, ...definition.args].join(' ') : undefined
  // The built-in harness's name already says where it comes from, so it has no source line.
  const source =
    harness?.source === 'acp' ? (
      <>
        ACP
        {definition && (
          <>
            {' · '}
            <Tooltip content={commandLine}>
              <code className="info-who-command" tabIndex={0}>
                {basename(definition.command)}
              </code>
            </Tooltip>
          </>
        )}
        {license && ` · ${license}`}
      </>
    ) : harness?.source === 'plugin' ? (
      '插件'
    ) : undefined
  const config = controls?.config ?? own?.config ?? []
  const modeOption = config.find(option => option.category === MODE_CATEGORY || option.id === MODE_CATEGORY)
  const modelOption = config.find(option => option.category === 'model')
  const otherOptions = config.filter(option => option !== modeOption && option !== modelOption)
  const locked = controls?.locked
  const busy = controls?.busy ?? null
  const optionPicker = (option: SessionConfigOption) =>
    controls && !locked ? (
      <ValuePicker
        label={option.name}
        size="xs"
        bleed="both"
        chevron="hover"
        width={280}
        value={option.currentValue}
        disabled={busy !== null}
        options={option.options.map(item => ({ value: item.value, label: item.name, description: item.description }))}
        onValueChange={value => controls.onConfig(option.id, value)}
      />
    ) : (
      (option.options.find(item => item.value === option.currentValue)?.name ?? option.currentValue)
    )
  const hostModels = harness?.models === 'host' && (catalog?.providers.length ?? 0) > 0
  const modelControl = controls?.model
  const provider = findProvider(catalog, summary.providerId)
  let modelValue: ReactNode
  if (modelOption) modelValue = optionPicker(modelOption)
  else if (hostModels && modelControl && !locked && catalog) {
    const groups = modelGroups(catalog)
    const value = modelControl.value ?? modelControl.current
    modelValue = (
      <ValuePicker
        label="模型"
        size="xs"
        bleed="both"
        chevron="hover"
        searchable
        width={320}
        value={value ? modelKey(value) : undefined}
        groups={groups}
        leading={provider && value ? <ProviderTile provider={provider} size={16} /> : undefined}
        onValueChange={key => {
          const next = modelFromKey(key)
          modelControl.onChange(sameModel(next, modelControl.current) ? undefined : next)
        }}
      />
    )
  } else if (summary.model) modelValue = summary.model
  else if (harness?.models === 'agent') modelValue = '由 Agent 管理'
  else if (usesDemoModel(snapshot, summary.harnessId, summary.providerId)) modelValue = '演示模型'
  else modelValue = '默认模型'
  const pendingModel =
    modelControl?.value && modelControl.current && !sameModel(modelControl.value, modelControl.current) ? modelControl.value : undefined

  // 用量
  const usage = summary.usage
  const report = own?.usageReport
  const turns = own ? turnsOf(own.messages) : []
  const timed = turns.flatMap(turn => {
    const active = parseDuration(turn.user?.turn?.activeMs)
    return active === undefined || turn.user?.turn?.endedAt === undefined ? [] : [active]
  })
  const worked = timed.length ? formatDuration(timed.reduce((sum, value) => sum + value, 0)) : undefined
  const created = parseTime(summary.createdAt)
  const agentReported = harness?.source === 'acp'
  const [inputLine, outputLine] = usage ? tokenLines(usage) : []
  const contextRatio =
    typeof report?.contextUsed === 'number' && typeof report.contextSize === 'number' && report.contextSize > 0
      ? Math.min(1, report.contextUsed / report.contextSize)
      : undefined

  // 计划 and 变更
  const plan = own?.plan ?? []
  const progress = planProgress(plan)
  const histories = own && catalog?.features?.filePreview && openFile ? fileHistories(own) : []
  const changes: Array<{
    path: string
    root?: string
    added: number
    removed: number
    known: boolean
    toolId: string
    history?: FileHistory
  }> = histories.map(history => {
    let added = 0,
      removed = 0,
      known = true
    for (const entry of history.entries) {
      const view = diffLines(entry.diff.oldText, entry.diff.newText)
      added += view.added
      removed += view.removed
      known &&= entry.diff.previous === 'text'
    }
    return { path: history.path, root: history.root, added, removed, known, toolId: history.entries.at(-1)!.toolId, history }
  })
  if (own)
    changes.push(
      ...fileChanges(own.messages).filter(
        change =>
          !histories.some(history => history.entries.some(entry => entry.toolId === change.toolId && entry.diff.path === change.path)),
      ),
    )

  const facts = permission
    ? [
        permission.enforcer === 'LATCH' ? 'Latch 在执行有风险的工具调用前询问' : 'Latch 不限制该 Harness 的执行范围',
        ...(permission.verifiedDefinition === undefined ? [] : [permission.verifiedDefinition ? '已验证的预设' : '未验证的定义']),
        ...(permission.readback === undefined
          ? []
          : [
              permission.readback === 'mode'
                ? `权限模式可读回${permission.expectedMode ? `（${permission.expectedMode}）` : ''}`
                : '无法读回权限模式',
            ]),
        ...(permission.approvals === 'none' ? ['不请求审批'] : []),
        ...permission.notes,
      ]
    : []
  const block = (id: InfoBlock) => ({ id, collapsed: collapsed.has(id), onToggle: onToggleBlock })
  const codeRoot = summary.cwd ? codeRootWorkspace(catalog?.workspaces, { path: summary.cwd }) : undefined

  return (
    <div className="inspector">
      <Block {...block('agent')} title="Agent">
        <div className="info-who">
          <HarnessTile harness={harness ? { id: harness.id, source: harness.source } : { id: 'standard', source: 'builtin' }} size={24} />
          <span className="info-who-text">
            <span className="info-who-name">{harnessName}</span>
            {source !== undefined && <span className="info-who-source">{source}</span>}
          </span>
        </div>
        <Row icon={Cpu} label="模型">
          {modelValue}
        </Row>
        {pendingModel && modelControl && (
          <p className="info-note info-note-pending">
            <span>下一条消息起使用 {pendingModel.model}</span>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                modelControl.onChange(undefined)
              }}>
              撤销切换
            </Button>
          </p>
        )}
        {modeOption && (
          <Row icon={SlidersHorizontal} label="模式">
            {optionPicker(modeOption)}
          </Row>
        )}
        <Row icon={Bot} label="方式">
          {summary.mode === 'chat' ? '只对话' : 'Agent'}
        </Row>
        {otherOptions.map(option => (
          <Row key={option.id} icon={SlidersHorizontal} label={option.name}>
            {optionPicker(option)}
          </Row>
        ))}
        {locked && (config.length > 0 || hostModels) && (
          <p className="info-note">
            <LockKeyhole size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
            {locked}
          </p>
        )}
        {/* A wider mode is confirmed here, under the option that asked for it, also when the composer changed it; a folded
            block leaves it to the composer. */}
        <InlineConfirm active={busy !== null && !collapsed.has('agent')} rank={1} className="info-confirm" />
      </Block>

      <Block {...block('environment')} title="环境">
        <Row icon={Laptop} label="电脑">
          <span className="info-text">{snapshot.hostName}</span>
          {local && <Badge>本机</Badge>}
        </Row>
        {summary.forkOf && (
          <Row icon={Folder} label="分叉自">
            <Button
              aria-label="返回来源会话"
              size="xs"
              variant="ghost"
              disabled={!onSource}
              onClick={() => onSource?.(summary.forkOf!.taskId)}>
              「<VisibleText text={summary.forkOf.title} />」
            </Button>
          </Row>
        )}
        {summary.mode !== 'chat' && project && (
          <Row icon={Folder} label="项目">
            <span className="info-text">
              <VisibleText text={projectName(project)} />
            </span>
          </Row>
        )}
        {summary.mode !== 'chat'
          && frozenFolders.map((folder, index) => {
            const currentFolder = project
              ? projectFolders(project).find(item => item.id === folder.id && item.path === folder.path)
              : undefined
            const removed = project !== undefined && summary.folders !== undefined && currentFolder === undefined
            const missing = currentFolder?.unavailable
            return (
              <Row
                key={folder.id}
                icon={Folder}
                label={project ? (index === 0 ? '主文件夹' : '文件夹') : summary.sessionFolder ? '这个会话的文件夹' : '启动目录'}
                two>
                <span className="info-path" data-unused={index > 0 && !allFolders ? '' : undefined}>
                  <span className="info-path-name">
                    <VisibleText text={basename(folder.path)} />
                    {index === 0 && summary.branch && (
                      <Badge>
                        <VisibleText text={summary.branch} />
                      </Badge>
                    )}
                    {missing ? <Badge tone="warn">找不到</Badge> : removed ? <Badge>已移出项目</Badge> : null}
                  </span>
                  <span className="info-path-line">
                    <MiddleText text={folder.path} className="info-path-full" />
                    {folderShell && project && currentFolder && !missing && (
                      <IconButton
                        label={revealLabel(currentShell()?.platform)}
                        icon={FolderOpen}
                        size="xs"
                        onClick={() => {
                          void folderShell
                            .reveal(project.id, currentFolder.id)
                            .then(result => {
                              if (result.status === 'failed') setFolderError('找不到这个文件夹，请同步后重试。')
                            })
                            .catch(cause => setFolderError(errorMessage(cause)))
                        }}
                      />
                    )}
                    <CopyButton text={folder.path} label="复制路径" size="xs" />
                  </span>
                </span>
              </Row>
            )
          })}
        {summary.mode !== 'chat' && frozenFolders.length > 1 && harness && !allFolders && (
          <p className="info-note">
            {harness.name}：{folderAccessText(harness, frozenFolders.length)}
          </p>
        )}
        {saveSessionProject && (
          <Button
            variant="ghost"
            size="xs"
            icon={FolderPlus}
            loading={savingProject}
            onClick={() => {
              void saveSessionProject()
            }}>
            存为项目…
          </Button>
        )}
        {folderError && <InlineNotice tone="error">{folderError}</InlineNotice>}
        {codeRoot && <CodeRootNotice workspace={codeRoot} className="info-code-root" {...(onNewProject ? { onNewProject } : {})} />}
      </Block>

      {level && (
        <Block {...block('permission')} title="权限">
          <Row icon={level === 'L3' ? ShieldAlert : Shield} tone={level === 'L3' ? 'warn' : undefined} label="级别">
            <span className="info-text">{level === 'L3' ? '完全访问' : '逐项询问'}</span>
            {drift && <StatusPill tone="err">权限模式已变化</StatusPill>}
          </Row>
          {facts.length > 0 && (
            <>
              <button
                type="button"
                className="info-disclosure"
                aria-expanded={factsOpen}
                onClick={() => {
                  setFactsOpen(!factsOpen)
                }}>
                <span className="info-icon" aria-hidden="true">
                  <ChevronRight className="info-disclosure-chevron" size={12} strokeWidth={ICON_STROKE[12]} />
                </span>
                权限说明
              </button>
              <Collapse
                open={factsOpen}
                onReveal={() => {
                  setFactsOpen(true)
                }}>
                <ul className="inspector-facts">
                  {facts.map(fact => (
                    <li key={fact}>{fact}</li>
                  ))}
                </ul>
              </Collapse>
            </>
          )}
        </Block>
      )}

      {(usage || worked || created !== undefined || report) && (
        <Block {...block('usage')} title="用量">
          {usage && (
            <Row icon={ArrowDownToLine} label="输入">
              <Tooltip content={agentReported ? `${inputLine}，由 Agent 报告` : inputLine}>
                <span className="info-number" tabIndex={0}>
                  {tokenAmount(usage.inputTokens)}
                </span>
              </Tooltip>
            </Row>
          )}
          {usage && (
            <Row icon={ArrowUpFromLine} label="输出">
              <Tooltip content={agentReported ? `${outputLine}，由 Agent 报告` : outputLine}>
                <span className="info-number" tabIndex={0}>
                  {tokenAmount(usage.outputTokens)}
                </span>
              </Tooltip>
            </Row>
          )}
          {typeof report?.contextUsed === 'number' && (
            <Row icon={Gauge} label="上下文" two={contextRatio !== undefined}>
              <span className="info-meter">
                <Tooltip
                  content={`Agent 报告当前上下文已用 ${exactTokens(report.contextUsed)}${typeof report.contextSize === 'number' ? ` / ${exactTokens(report.contextSize)}` : ''} tokens`}>
                  <span className={`info-number ${contextRatio !== undefined && contextRatio >= 0.8 ? 'is-warn' : ''}`} tabIndex={0}>
                    {typeof report.contextSize === 'number'
                      ? `${formatTokens(report.contextUsed)} / ${tokenAmount(report.contextSize)}`
                      : tokenAmount(report.contextUsed)}
                    {contextRatio !== undefined && contextRatio >= 0.8 && ' · 接近上限'}
                  </span>
                </Tooltip>
                {contextRatio !== undefined && (
                  <span className={`info-track ${contextRatio >= 0.8 ? 'is-warn' : ''}`} aria-hidden="true">
                    <i style={{ transform: `scaleX(${contextRatio})` }} />
                  </span>
                )}
              </span>
            </Row>
          )}
          {report?.cost && (
            <Row icon={CircleDollarSign} label="费用" two>
              <span className="info-path">
                <span className="info-number">
                  {report.cost.amount > 0 && report.cost.amount < 0.01
                    ? '<$0.01'
                    : new Intl.NumberFormat('zh-CN', { style: 'currency', currency: report.cost.currency }).format(report.cost.amount)}
                </span>
                <span className="info-caption">由 Agent 报告，不是账单</span>
              </span>
            </Row>
          )}
          {worked && (
            <Row icon={Timer} label="用时">
              <span className="info-number">
                {worked} · {timed.length} 轮
              </span>
            </Row>
          )}
          {created !== undefined && (
            <Row icon={CalendarClock} label="开始于">
              <Tooltip content={absoluteTime(created)}>
                <time className="info-number" dateTime={new Date(created).toISOString()} tabIndex={0}>
                  {messageTime(created, now)}
                </time>
              </Tooltip>
            </Row>
          )}
        </Block>
      )}

      {plan.length > 0 && (
        <Block {...block('plan')} title="计划" meta={`${progress.done}/${progress.total}`}>
          <PlanList plan={plan} active={summary.status === 'running' || summary.status === 'waiting-approval'} />
        </Block>
      )}

      {changes.length > 0 && (
        <Block {...block('changes')} title="变更" meta={`${changes.length} 个文件`}>
          <ul className="info-changes">
            {changes.map(change => {
              const { folder, name } = splitPath(change.path)
              return (
                <li key={`${change.root ?? ''}\n${change.path}`}>
                  <button
                    type="button"
                    className="info-change"
                    title={change.path}
                    onClick={() => {
                      if (change.history && openFile) openFile(change.history.target)
                      else onReveal(change.toolId)
                    }}>
                    <span className="info-icon" aria-hidden="true">
                      <FileText size={14} strokeWidth={ICON_STROKE[14]} />
                    </span>
                    <span className="info-change-path">
                      {(folder || change.root) && (
                        <span className="info-change-folder">
                          <VisibleText text={`${change.root ? `${change.history?.folder ?? change.root} / ` : ''}${folder}`} />
                        </span>
                      )}
                      <VisibleText text={name} />
                    </span>
                    <span className={change.added ? 'diff-stat-add' : 'diff-stat-zero'}>+{change.added}</span>
                    {change.known && <span className={change.removed ? 'diff-stat-remove' : 'diff-stat-zero'}>−{change.removed}</span>}
                  </button>
                  {change.history && openFile && (
                    <IconButton
                      className="info-change-preview"
                      size="xs"
                      label={`预览文件：${change.path}`}
                      icon={Eye}
                      onClick={() => openFile({ ...change.history!.target, view: 'preview' })}
                    />
                  )}
                </li>
              )
            })}
          </ul>
        </Block>
      )}
    </div>
  )
}
