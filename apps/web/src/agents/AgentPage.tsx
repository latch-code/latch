import { useEffect, useRef, useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import {
  GENERAL_AGENT_ID,
  type AgentMemory,
  type CustomAgentList,
  type CustomAgentSummary,
  type HostCatalog,
  type TaskSummary,
  type WorktreeStart,
} from '@latch/protocol'
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Hint,
  IconButton,
  InlineNotice,
  Loading,
  StatusWord,
  Tabs,
  TextAreaField,
  type TabOption,
} from '@latch/ui'
import { Composer } from '../composer/Composer.tsx'
import { DraftHarnessControl } from '../composer/ModelControl.tsx'
import { FolderControl } from '../composer/FolderControl.tsx'
import { HarnessTile } from '../components/BrandTile.tsx'
import { ModelPicker, ProjectPicker } from '../components/Pickers.tsx'
import { SessionStatus, useLastConfirmed } from '../components/SessionStatus.tsx'
import { worktreeProject, type ComposerChoice } from '../composerChoice.ts'
import { relativeTime } from '../format.ts'
import { rowStatus } from '../sessions.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import type { MyAgentTab } from '../shell/routes.ts'
import { AgentForm, GeneralForm, TakesEffect, WriteNotice } from './AgentForm.tsx'
import {
  agentHarnesses,
  agentSessions,
  delegationChoice,
  delegationSubmission,
  dutyLine,
  GENERAL_NAME,
  runsWith,
  usesHostModels,
  worksIn,
} from './model.ts'
import { AgentTile, Availability } from './parts.tsx'
import { CarryResults } from './CarryResults.tsx'
import { SchedulesTab } from './Schedules.tsx'
import { carriedText } from './scheduleModel.ts'
import type { AgentDetailValue } from './useAgentData.ts'
import { writeFor, type AgentWrites } from './useAgentWrites.ts'

/** The facts under an Agent's name: how it runs, where it works, whether it can start now. */
function AgentFacts({
  catalog,
  agent,
  offline,
}: {
  catalog: HostCatalog | undefined
  agent: CustomAgentSummary | undefined
  offline: boolean
}) {
  const harness = agent && catalog?.harnesses.find(item => item.id === agent.harnessId)
  return (
    <dl className="agent-facts">
      <dt>执行方式</dt>
      <dd>
        {agent ? (
          <>
            {harness && <HarnessTile harness={harness} size={14} />}
            <span>{runsWith(catalog, agent)}</span>
          </>
        ) : (
          <span>每个会话自己选</span>
        )}
      </dd>
      {agent && (
        <>
          <dt>工作位置</dt>
          <dd>
            <span>{worksIn(catalog, agent.defaultProjectId)}</span>
          </dd>
          <dt>可用性</dt>
          <dd>
            <Availability available={agent.available} reason={agent.unavailableReason} offline={offline} />
          </dd>
        </>
      )}
    </dl>
  )
}

/** One row of 近期委托: the title, when, and its state in the words the session list uses. */
function RecentRow({ task, frozen, onOpen }: { task: TaskSummary; frozen: string | null; onOpen: (id: string) => void }) {
  const status = rowStatus(task, { frozen: frozen !== null })
  const time = relativeTime(task.updatedAt)
  return (
    <li>
      <button
        type="button"
        className="agent-recent-row"
        onClick={() => {
          onOpen(task.id)
        }}>
        <span className="agent-recent-text">
          <span className="agent-recent-title">
            {task.automationId && <Badge className="agent-run-tag">定时</Badge>}
            {task.title || '未命名会话'}
          </span>
          <time dateTime={task.updatedAt}>{time}</time>
        </span>
        <SessionStatus status={status} live={task.live} inWaitingShelf={false} time={frozen ?? ''} dateTime={task.updatedAt} />
      </button>
    </li>
  )
}

/**
 * 委托: the composer starts a real session of this Agent, with its defaults picked and each one changeable for this
 * session; under it, this Agent's sessions, each opening the normal conversation.
 */
function DelegateTab({ shell, agent, offline }: { shell: ShellState; agent: CustomAgentSummary; offline: boolean }) {
  const { snapshot, delegation, access, preferences, coarse, catalog } = shell
  const [draft, setDraft] = useState('')
  const [choice, setChoice] = useState<ComposerChoice>(() => delegationChoice(agent))
  // The start point picked in 新工作树 (HEAD or another one), sent as picked.
  const [worktree, setWorktree] = useState<WorktreeStart | undefined>(undefined)
  const [all, setAll] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  // A new definition from the Host starts the picks again from its defaults.
  useEffect(() => {
    setChoice(delegationChoice(agent))
  }, [agent.id, agent.revision])
  const frozen = useLastConfirmed(shell.connection, snapshot)
  if (!catalog) return null
  // Only Harnesses that can receive an Agent, and no pin from this page: the pin is the new session's.
  const agentCatalog: HostCatalog = {
    ...catalog,
    harnesses: agentHarnesses(catalog),
    ...(catalog.features ? { features: { ...catalog.features, pinnedDefaults: undefined } } : {}),
  }
  const harness = agentCatalog.harnesses.find(item => item.id === choice.harnessId)
  const mine = delegation.pending?.customAgentId === agent.id
  const pending = delegation.pending
  const refused = delegation.refused?.customAgentId === agent.id ? delegation.refused : null
  const project = worktreeProject(catalog, choice, false)
  const sessions = agentSessions(snapshot.tasks, agent.id)
  const shown = all ? sessions : sessions.slice(0, 6)
  const canStart = !offline && agent.available && harness !== undefined && access.scopes.has('run')
  const blockReason = offline
    ? 'Mac 不在线，恢复后再委托'
    : !access.scopes.has('run')
      ? '这台设备不能开始会话'
      : !agent.available
        ? (agent.unavailableReason ?? '现在不能委托')
        : !harness
          ? '先选 Harness'
          : undefined
  const send = async () => {
    if (!harness || !canStart) return
    const sessionId = await delegation.start(
      delegationSubmission({ agent, harness, choice, prompt: draft.trim(), worktree, inProject: project !== undefined }),
    )
    if (sessionId) {
      setDraft('')
      setWorktree(undefined)
    }
  }
  const locked = delegation.sending || pending !== null
  return (
    <div className="agent-delegate">
      <Composer
        textareaRef={input}
        variant="new"
        label="委托内容"
        placeholder={`交给${agent.name}一件事…`}
        draft={draft}
        onDraft={setDraft}
        pending={pending}
        {...(pending && !mine && pending.customAgentId
          ? {
              onOpenPending: () => {
                shell.openMyAgent({ id: pending.customAgentId!, tab: 'delegate' })
              },
            }
          : {})}
        sending={delegation.sending}
        error={refused ? `委托没开始：${refused.message}` : ''}
        onRetry={() => {
          void delegation.retry()
        }}
        canSend={canStart}
        {...(blockReason ? { blockReason } : {})}
        onSubmit={() => {
          void send()
        }}
        sendKey={preferences.sendKey}
        coarse={coarse}
        controls={
          <>
            <DraftHarnessControl
              catalog={agentCatalog}
              choice={choice}
              access={access}
              disabled={locked || offline}
              onChoice={patch => {
                setChoice(previous => ({ ...previous, ...patch }))
              }}
              onRead={shell.refresh}
            />
            {usesHostModels(harness) && (
              <ModelPicker
                catalog={catalog}
                value={choice.model}
                access={access}
                disabled={locked || offline}
                onChange={model => {
                  setChoice(previous => ({ ...previous, model: { providerId: model.providerId, model: model.model } }))
                }}
              />
            )}
          </>
        }
        below={
          <div className="agent-delegate-where">
            <ProjectPicker
              catalog={catalog}
              harness={harness}
              access={access}
              value={choice.workspaceId}
              disabled={locked || offline}
              onChange={workspaceId => {
                setChoice(previous => ({ ...previous, workspaceId }))
                setWorktree(undefined)
              }}
            />
            {project && <FolderControl project={project} worktree={worktree} onWorktree={setWorktree} disabled={locked || offline} />}
            <span className="agent-form-spacer" />
            <CarryResults
              sessions={sessions}
              disabled={locked}
              phone={shell.phone}
              onCarry={results => {
                setDraft(previous => carriedText(previous, results))
                requestAnimationFrame(() => {
                  input.current?.focus({ preventScroll: true })
                })
              }}
            />
            <Hint label="新会话" className="agent-delegate-new">
              按 Agent
              现在的定义开始一个新会话；带入的成果只是引用的文字，不接着原来的对话。要接着原来的对话，在近期委托里打开那个会话直接输入。
            </Hint>
          </div>
        }
      />
      <section className="agent-section" aria-label="近期委托">
        <header className="agent-section-head">
          <h3>近期委托</h3>
          {sessions.length > shown.length && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setAll(true)
              }}>
              全部（{sessions.length}）
            </Button>
          )}
        </header>
        {sessions.length === 0 ? (
          <EmptyState title="还没有委托" />
        ) : (
          <ul className="agent-recent">
            {shown.map(task => (
              <RecentRow key={task.id} task={task} frozen={frozen} onOpen={shell.choose} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

/** 记忆: what the person wrote for this Agent, to add, change and delete. */
function MemoryTab({
  owner,
  memories,
  writes,
  disabled,
  onReload,
}: {
  owner: string
  memories: AgentMemory[]
  writes: AgentWrites
  disabled: boolean
  onReload: () => void
}) {
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState('')
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [deleting, setDeleting] = useState<AgentMemory | null>(null)
  const base = `custom-agents/${encodeURIComponent(owner)}/memories`
  const locked = disabled || writes.saving || writes.held
  const added = writeFor(writes.state, 'memory:new')
  const add = async () => {
    if (!text.trim() || locked) return
    if (await writes.run(`memory:new`, base, 'POST', { content: text.trim() })) {
      setText('')
      setAdding(false)
    }
  }
  return (
    <div className="agent-memory">
      <div className="agent-memory-bar">
        <Hint label="只给这个 Agent">
          只有你能写，只有这个 Agent 会用，工具不会改写它。在这里删除只删 Latch 保存的这一条，不会抹掉上游服务里已有的记录。
        </Hint>
        <TakesEffect />
        <span className="agent-form-spacer" />
        {!adding && (
          <Button
            icon={Plus}
            disabled={locked}
            onClick={() => {
              setAdding(true)
            }}>
            添加
          </Button>
        )}
      </div>
      {adding && (
        <form
          className="agent-memory-edit"
          onSubmit={event => {
            event.preventDefault()
            void add()
          }}>
          <TextAreaField
            label="新记忆"
            value={text}
            rows={3}
            maxLength={4000}
            autoFocus
            disabled={locked}
            onChange={event => {
              setText(event.target.value)
            }}
          />
          <WriteNotice state={added} onRetry={() => void writes.retry().then(done => done && (setText(''), setAdding(false)))} />
          <div className="agent-form-actions">
            <span className="agent-form-spacer" />
            <Button
              disabled={writes.saving}
              onClick={() => {
                setAdding(false)
                setText('')
              }}>
              取消
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={locked || !text.trim()}
              loading={added !== null && 'phase' in added && added.phase === 'saving'}>
              保存
            </Button>
          </div>
        </form>
      )}
      {memories.length === 0 && !adding ? (
        <EmptyState title="还没有记忆" />
      ) : (
        <ul className="agent-memory-list" aria-label="记忆">
          {memories.map(memory => {
            const state = writeFor(writes.state, `memory:${memory.id}`)
            const saved = state !== null && 'phase' in state && state.phase === 'done' && state.write.method === 'PATCH'
            if (editing?.id === memory.id)
              return (
                <li key={memory.id}>
                  <form
                    className="agent-memory-edit"
                    onSubmit={event => {
                      event.preventDefault()
                      if (locked || !editing.text.trim()) return
                      void writes
                        .run(`memory:${memory.id}`, `${base}/${memory.id}`, 'PATCH', {
                          content: editing.text.trim(),
                          baseRevision: memory.revision,
                        })
                        .then(done => {
                          if (done) setEditing(null)
                        })
                    }}>
                    <TextAreaField
                      label="修改记忆"
                      value={editing.text}
                      rows={3}
                      maxLength={4000}
                      autoFocus
                      disabled={locked}
                      onChange={event => {
                        setEditing({ id: memory.id, text: event.target.value })
                      }}
                    />
                    <WriteNotice
                      state={state}
                      onRetry={() => void writes.retry().then(done => done && setEditing(null))}
                      onReload={() => {
                        setEditing(null)
                        writes.clear()
                        onReload()
                      }}
                    />
                    <div className="agent-form-actions">
                      <span className="agent-form-spacer" />
                      <Button
                        disabled={writes.saving}
                        onClick={() => {
                          setEditing(null)
                        }}>
                        取消
                      </Button>
                      <Button
                        type="submit"
                        variant="primary"
                        disabled={locked || !editing.text.trim() || editing.text.trim() === memory.content}>
                        保存
                      </Button>
                    </div>
                  </form>
                </li>
              )
            return (
              <li key={memory.id} className="agent-memory-row">
                <div className="agent-memory-text">
                  <p>{memory.content}</p>
                  <span className="agent-memory-meta">
                    {saved ? (
                      <StatusWord tone="done">已保存</StatusWord>
                    ) : (
                      <time dateTime={memory.updatedAt}>{relativeTime(memory.updatedAt)}</time>
                    )}
                  </span>
                  {state && 'kind' in state && <WriteNotice state={state} onRetry={() => void writes.retry()} onReload={onReload} />}
                </div>
                <IconButton
                  size="sm"
                  label="修改"
                  icon={Pencil}
                  disabled={locked}
                  onClick={() => {
                    writes.clear()
                    setEditing({ id: memory.id, text: memory.content })
                  }}
                />
                <IconButton
                  size="sm"
                  label="删除"
                  icon={Trash2}
                  disabled={locked}
                  onClick={() => {
                    setDeleting(memory)
                  }}
                />
              </li>
            )
          })}
        </ul>
      )}
      {deleting && (
        <ConfirmDialog
          title="删除这条记忆？"
          danger
          confirmLabel="删除"
          message="这个 Agent 之后不再收到它。已经开始的外部 Harness 会话里已发出的内容不会撤回。"
          onClose={() => {
            setDeleting(null)
          }}
          onConfirm={async () => {
            const done = await writes.run(`memory:${deleting.id}`, `${base}/${deleting.id}`, 'DELETE', {})
            if (done === undefined) throw new Error('没有删除，原因见页面上的说明。')
          }}
        />
      )}
    </div>
  )
}

/** An Agent's page: its name and duty, its facts, and the tabs 委托 · 记忆 · 定时 · 设置. */
export function AgentPage({
  shell,
  id,
  tab: chosen,
  value,
  loading,
  failed,
  plugins,
  writes,
  scheduleWrites,
  offline,
  onTab,
  onReload,
  onDeleted,
}: {
  shell: ShellState
  id: string
  tab?: MyAgentTab | undefined
  value: AgentDetailValue | undefined
  loading: boolean
  failed?: string | undefined
  plugins: CustomAgentList['plugins']
  writes: AgentWrites
  /** Kept above the tabs, so a schedule write whose result is unknown survives switching tabs. */
  scheduleWrites: AgentWrites
  offline: boolean
  onTab: (tab: MyAgentTab) => void
  onReload: () => void
  onDeleted: () => void
}) {
  const { snapshot, catalog } = shell
  const general = id === GENERAL_AGENT_ID
  const summary = general
    ? undefined
    : value?.kind === 'custom'
      ? value.detail.agent
      : snapshot.customAgents?.find(agent => agent.id === id)
  const schedulesOn = catalog?.features?.automations === true
  // Absent from the snapshot while the Host confirms a write: the tab says so rather than showing none.
  const automations = snapshot.automations?.filter(item => (general ? item.customAgentId === undefined : item.customAgentId === id))
  const tabs: Array<TabOption<MyAgentTab>> = [
    ...(general ? [] : [{ value: 'delegate' as const, label: '委托', controls: 'agent-tab-panel' }]),
    { value: 'memory', label: '记忆', controls: 'agent-tab-panel' },
    ...(schedulesOn ? [{ value: 'schedules' as const, label: '定时', controls: 'agent-tab-panel' }] : []),
    { value: 'settings', label: '设置', controls: 'agent-tab-panel' },
  ]
  const tab = tabs.find(option => option.value === chosen)?.value ?? tabs[0]!.value
  const name = general ? GENERAL_NAME : (summary?.name ?? '')
  const duty = general ? '没选别的 Agent 的会话都带上它' : dutyLine(value?.kind === 'custom' ? value.detail.agent : (summary ?? {}))
  const held = offline || writes.held
  const memories = value?.detail.memories ?? []
  const glyph = summary?.glyph
  return (
    <div className="agent-page">
      <header className="agent-head">
        <AgentTile glyph={glyph} size={40} />
        <div className="agent-head-text">
          <h1>
            {name}
            {general && <span className="agent-builtin">内置</span>}
          </h1>
          {duty && <p>{duty}</p>}
        </div>
      </header>
      <AgentFacts catalog={catalog} agent={summary} offline={offline} />
      <Tabs label={`${name} 的页面`} value={tab} options={tabs} onValueChange={onTab} className="agent-tabs" />
      <div id="agent-tab-panel" role="tabpanel" className="agent-tab-panel">
        {failed && !value && (
          <InlineNotice tone="error" title="读取失败" action={<Button onClick={onReload}>重试</Button>}>
            {failed}
          </InlineNotice>
        )}
        {loading && !value && tab !== 'delegate' && <Loading label="正在读取" />}
        {tab === 'delegate' && summary && <DelegateTab shell={shell} agent={summary} offline={offline} />}
        {tab === 'memory' && value && (
          <MemoryTab key={id} owner={id} memories={memories} writes={writes} disabled={held} onReload={onReload} />
        )}
        {tab === 'schedules' && schedulesOn && (
          <SchedulesTab
            catalog={catalog}
            access={shell.access}
            agentId={general ? undefined : id}
            agent={summary}
            automations={automations}
            writes={scheduleWrites}
            offline={offline}
            onOpenSession={shell.choose}
            onReload={onReload}
          />
        )}
        {tab === 'settings' && value && catalog && value.kind === 'custom' && (
          <AgentForm
            catalog={catalog}
            access={shell.access}
            agent={value.detail.agent}
            plugins={plugins}
            writes={writes}
            disabled={held}
            onSaved={() => {
              onReload()
            }}
            onDeleted={onDeleted}
            onReload={() => {
              writes.clear()
              onReload()
            }}
            {...(shell.owner ? { onManageProviders: shell.manageProviders } : {})}
          />
        )}
        {tab === 'settings' && value && catalog && value.kind === 'general' && (
          <GeneralForm catalog={catalog} detail={value.detail} writes={writes} disabled={held} onReload={onReload} />
        )}
      </div>
    </div>
  )
}
