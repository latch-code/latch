import { useEffect, useState } from 'react'
import { AlarmClock, CirclePause, Play } from 'lucide-react'
import type {
  Automation,
  AutomationDetail,
  AutomationRun,
  AutomationSummary,
  CustomAgentSummary,
  HarnessInfo,
  HostCatalog,
} from '@latch/protocol'
import {
  Button,
  ConfirmDialog,
  EmptyState,
  Hint,
  Icon,
  IconButton,
  Loading,
  SegmentedControl,
  StatusWord,
  SwitchRow,
  TextAreaField,
  TextField,
  ValuePicker,
  ChevronDownGlyph,
  AlertGlyph,
  BlockedGlyph,
  FolderGlyph,
  EditGlyph,
  PlusGlyph,
  TrashGlyph,
} from '@latch/ui'
import { ProjectPicker } from '../components/Pickers.tsx'
import { api, errorMessage, MessageError } from '../core/api.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { WriteNotice } from './AgentForm.tsx'
import { RUN_WORDS, scheduleWords } from './model.ts'
import {
  automationsVersion,
  inputLine,
  missedRuns,
  newScheduleDraft,
  runReason,
  scheduleBlock,
  scheduleCreate,
  scheduleDraftOf,
  schedulePatch,
  scheduleProblem,
  scheduleStatus,
  scheduleWhere,
  whenWords,
  type DetailRead,
  type ScheduleDraft,
} from './scheduleModel.ts'
import { writeFor, type AgentWrites } from './useAgentWrites.ts'
import { inputRows, type SchedulePrefill } from './activity.ts'
import { CONNECTION_COPY } from '../core/hostState.ts'
import { defineCopy, formatNumber, plural } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    noChanges: '没有改动',
    editSchedule: '编辑定时任务',
    createSchedule: '新建定时任务',
    name: '名称',
    time: '时间',
    repeat: '重复',
    weekday: '星期',
    timeOfDay: '几点',
    macTime: '这台 Mac 的时间',
    macTimeDetail: '按这台 Mac 当前的时区；Mac 关机或睡眠时错过的时间不补跑，需要时用「立即运行」。',
    workspace: '工作位置',
    home: '家',
    homeDetail: '这个 Agent 共用的工作文件夹',
    agentWrote: '它写的',
    external: '来自外部内容',
    eachInput: '每次的输入',
    instructions: '每次运行要做的事；要用的文件写出它在工作位置里的路径',
    newSessionEach: '每次都是新会话',
    newSessionDetail: '每次运行开一个新会话，把这段作为第一条消息发出，不带上一次的对话；运行在每个审批处停下等你。附加文件尚未实现。',
    notify: '结果出来时通知我',
    cancel: '取消',
    save: '保存',
    saveDisabled: '保存为关闭',
    create: '创建',
    noRun: '没有运行',
    runNow: '立即运行',
    onSchedule: '按时运行',
    edit: '编辑',
    delete: '删除',
    pause: '暂停',
    reenable: '重新开启',
    resume: '继续',
    history: '运行记录',
    reading: '正在读取',
    neverRun: '还没有运行',
    confirming: '正在确认上一项修改',
    cannotCreate: '现在不能新建或运行',
    viewOnly: '只能查看',
    manualOnly: '仅手动运行',
    startsSession: '按时开新会话',
    startDetail: '每次运行用这个 Agent 现在的定义开一个新会话，在选定的工作位置做保存的事；没有人看着时也在每个审批处停下。',
    newSchedule: '新建定时',
    noScheduled: '没有定时任务',
    schedules: '定时任务',
    deleteDetail: '之后不再按时运行，运行记录一并删除；已经开始的会话保留。',
    deleteFailed: '没有删除，原因见页面上的说明。',
    days: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
    kinds: { daily: '每天', weekdays: '工作日', weekly: '每周' },
    openRun: (time: string, status: string) => `${time} ${status}，打开会话`,
    next: (time: string) => `下次 ${time}`,
    last: (time: string, status: string) => `上次 ${time} ${status}`,
    missed: (count: number) => `错过 ${formatNumber(count)} 次`,
    historyOf: (name: string) => `${name} 的运行记录`,
    all: (count: number) => `全部（${formatNumber(count)}）`,
    confirmDelete: (name: string) => `删除「${name}」？`,
  },
  {
    noChanges: 'No changes',
    editSchedule: 'Edit scheduled task',
    createSchedule: 'New scheduled task',
    name: 'Name',
    time: 'Time',
    repeat: 'Repeat',
    weekday: 'Day of the week',
    timeOfDay: 'Time of day',
    macTime: 'This Mac’s time',
    macTimeDetail:
      'Schedules use this Mac’s current time zone. Runs missed while the Mac is asleep or off aren’t made up. Use Run now when needed.',
    workspace: 'Workspace',
    home: 'Home',
    homeDetail: 'This Agent’s shared working folder',
    agentWrote: 'Written by the Agent',
    external: 'From external content',
    eachInput: 'Input for each run',
    instructions: 'What each run should do. Include paths relative to the workspace for any files it needs.',
    newSessionEach: 'A new session for each run',
    newSessionDetail:
      'Each run starts a fresh session with these instructions as its first message. The run pauses for every approval. File attachments are not implemented yet.',
    notify: 'Notify me when the result is ready',
    cancel: 'Cancel',
    save: 'Save',
    saveDisabled: 'Save as disabled',
    create: 'Create',
    noRun: 'No run',
    runNow: 'Run now',
    onSchedule: 'Scheduled run',
    edit: 'Edit',
    delete: 'Delete',
    pause: 'Pause',
    reenable: 'Enable again',
    resume: 'Resume',
    history: 'Run history',
    reading: 'Loading',
    neverRun: 'No runs yet',
    confirming: 'Confirming the last change',
    cannotCreate: 'Creation and runs are unavailable',
    viewOnly: 'View only',
    manualOnly: 'Manual runs only',
    startsSession: 'Starts new sessions on schedule',
    startDetail:
      'Each run starts a new session with this Agent’s current definition and runs the saved instructions in the selected workspace. It pauses for every approval, including unattended runs.',
    newSchedule: 'New schedule',
    noScheduled: 'No scheduled tasks',
    schedules: 'Scheduled tasks',
    deleteDetail: 'This removes the schedule and its run history. Sessions that have already started are kept.',
    deleteFailed: 'Deletion failed. See the explanation on this page.',
    days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    kinds: { daily: 'Daily', weekdays: 'Weekdays', weekly: 'Weekly' },
    openRun: (time: string, status: string) => `${time} ${status}, open session`,
    next: (time: string) => `Next ${time}`,
    last: (time: string, status: string) => `Last ${time} ${status}`,
    missed: (count: number) => plural(count, { one: '{n} missed run', other: '{n} missed runs' }),
    historyOf: (name: string) => `Run history for ${name}`,
    all: (count: number) => `Show all (${formatNumber(count)})`,
    confirmDelete: (name: string) => `Delete “${name}”?`,
  },
)

const KINDS = ['daily', 'weekdays', 'weekly'] as const
const SHOWN_RUNS = 5
/** Prefills already put in a form: a profile keeps its prefill, but it opens the form only once. */
const usedPrefills = new WeakSet<SchedulePrefill>()

/** Each automation's detail (its input and its runs), read again whenever the snapshot says one changed. */
function useAutomationDetails(automations: readonly AutomationSummary[]) {
  const version = automationsVersion(automations)
  const [reads, setReads] = useState<ReadonlyMap<string, DetailRead>>(new Map())
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    for (const { id } of automations)
      api<AutomationDetail>(`automations/${encodeURIComponent(id)}`, { signal: controller.signal })
        .then(detail => {
          setReads(previous => new Map(previous).set(id, { state: 'ready', detail }))
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return
          setReads(previous => {
            const shown = previous.get(id)
            // A read that fails keeps what it showed, as the Agent pages do.
            if (shown?.state === 'ready') return previous
            return new Map(previous).set(id, { state: 'failed', message: errorMessage(error) })
          })
        })
    return () => {
      controller.abort()
    }
    // The version names every field the reads depend on.
  }, [version, attempt])
  return {
    read: (id: string): DetailRead => reads.get(id) ?? { state: 'loading' },
    reload: () => {
      setAttempt(value => value + 1)
    },
  }
}

/** 新建 / 编辑: the name, when, the work location (always chosen by hand), what each run receives, and notify. */
function ScheduleForm({
  catalog,
  harness,
  access,
  base,
  editing,
  manualOnly,
  proposal,
  writes,
  writeKey,
  disabled,
  onSave,
  onCancel,
  onReload,
}: {
  catalog: HostCatalog
  harness: HarnessInfo | undefined
  access: DeviceAccess
  base: ScheduleDraft
  editing: boolean
  manualOnly: boolean
  /** Filled in from the Agent's proposal: its input is what the Agent wrote, read whole before saving. */
  proposal?: { external: boolean } | undefined
  writes: AgentWrites
  writeKey: string
  disabled: boolean
  onSave: (draft: ScheduleDraft) => void
  onCancel: () => void
  onReload: () => void
}) {
  const [draft, setDraft] = useState(base)
  const problem = scheduleProblem(draft) ?? (editing && Object.keys(schedulePatch(base, draft)).length === 0 ? COPY.noChanges : undefined)
  const state = writeFor(writes.state, writeKey)
  const locked = disabled || writes.saving || writes.held
  const set = (patch: Partial<ScheduleDraft>) => {
    setDraft(previous => ({ ...previous, ...patch }))
  }
  return (
    <form
      className="agent-schedule-form"
      aria-label={editing ? COPY.editSchedule : COPY.createSchedule}
      onSubmit={event => {
        event.preventDefault()
        if (!problem && !locked) onSave(draft)
      }}>
      <TextField
        label={COPY.name}
        value={draft.name}
        maxLength={80}
        autoFocus
        disabled={locked}
        onChange={event => {
          set({ name: event.target.value })
        }}
      />
      <div className="agent-schedule-when" role="group" aria-label={COPY.time}>
        <SegmentedControl
          label={COPY.repeat}
          value={draft.kind}
          options={KINDS.map(value => ({ value, label: COPY.kinds[value] }))}
          disabled={locked}
          onValueChange={kind => {
            set({ kind })
          }}
        />
        {draft.kind === 'weekly' && (
          <ValuePicker
            label={COPY.weekday}
            value={String(draft.day)}
            options={COPY.days.map((label, day) => ({ value: String(day), label }))}
            disabled={locked}
            onValueChange={day => {
              set({ day: Number(day) })
            }}
          />
        )}
        <TextField
          type="time"
          label={COPY.timeOfDay}
          className="agent-schedule-time"
          value={draft.time}
          required
          disabled={locked}
          onChange={event => {
            set({ time: event.target.value })
          }}
        />
        <Hint label={COPY.macTime}>{COPY.macTimeDetail}</Hint>
      </div>
      <div className="agent-schedule-where">
        <span className="agent-schedule-label">{COPY.workspace}</span>
        <ProjectPicker
          catalog={catalog}
          defaultLocation={{ label: COPY.home, description: COPY.homeDetail }}
          harness={harness}
          access={access}
          value={draft.location}
          disabled={locked}
          onChange={location => {
            set({ location })
          }}
        />
      </div>
      {proposal && (
        <p className="agent-schedule-from">
          <span>{COPY.agentWrote}</span>
          {proposal.external && <StatusWord tone="warn">{COPY.external}</StatusWord>}
        </p>
      )}
      <TextAreaField
        label={COPY.eachInput}
        value={draft.prompt}
        rows={proposal ? inputRows(draft.prompt) : 4}
        maxLength={16_000}
        disabled={locked}
        placeholder={COPY.instructions}
        onChange={event => {
          set({ prompt: event.target.value })
        }}
      />
      <Hint label={COPY.newSessionEach}>{COPY.newSessionDetail}</Hint>
      <SwitchRow
        title={COPY.notify}
        checked={draft.notify}
        disabled={locked}
        onCheckedChange={notify => {
          set({ notify })
        }}
      />
      <WriteNotice state={state} onRetry={() => void writes.retry()} onReload={onReload} />
      <div className="agent-form-actions">
        {problem && !locked && <span className="agent-form-problem">{problem}</span>}
        <span className="agent-form-spacer" />
        <Button disabled={writes.saving} onClick={onCancel}>
          {COPY.cancel}
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={locked || problem !== undefined}
          loading={state !== null && 'phase' in state && state.phase === 'saving'}>
          {editing ? COPY.save : manualOnly ? COPY.saveDisabled : COPY.create}
        </Button>
      </div>
    </form>
  )
}

/** One run: when, why it did not run (from the Host's record), its state, and its session when there is one. */
function RunRow({ run, onOpen }: { run: AutomationRun; onOpen: (id: string) => void }) {
  const reason = runReason(run)
  const body = (
    <>
      <span className="agent-recent-text">
        <span className="agent-recent-title">{whenWords(run.at)}</span>
        <span className="agent-schedule-meta">{reason ? COPY.noRun : run.trigger === 'manual' ? COPY.runNow : COPY.onSchedule}</span>
      </span>
      {reason ? (
        <Hint label={RUN_WORDS[run.state]} lead={<Icon icon={BlockedGlyph} size={12} />}>
          {reason}
        </Hint>
      ) : (
        <StatusWord
          tone={
            run.state === 'running'
              ? 'running'
              : run.state === 'waiting'
                ? 'waiting'
                : run.state === 'completed'
                  ? 'done'
                  : run.state === 'failed'
                    ? 'failed'
                    : run.state === 'unknown'
                      ? 'warn'
                      : 'neutral'
          }>
          {RUN_WORDS[run.state]}
        </StatusWord>
      )}
    </>
  )
  return (
    <li>
      {run.sessionId ? (
        <button
          type="button"
          className="agent-recent-row"
          aria-label={COPY.openRun(whenWords(run.at), RUN_WORDS[run.state])}
          onClick={() => {
            onOpen(run.sessionId!)
          }}>
          {body}
        </button>
      ) : (
        <div className="agent-schedule-row">{body}</div>
      )}
    </li>
  )
}

/** One automation: what, when, where and with what input; its state; its actions; and its runs, unfolded on request. */
function ScheduleCard({
  catalog,
  automation,
  read,
  writes,
  block,
  runBlock,
  canRun,
  expanded,
  onExpand,
  onEdit,
  onDelete,
  onEnable,
  onRun,
  onOpen,
  onReload,
}: {
  catalog: HostCatalog | undefined
  automation: AutomationSummary
  read: DetailRead
  writes: AgentWrites
  /** Why a background grant cannot be enabled; manual execution is checked separately. */
  block: string | undefined
  runBlock: string | undefined
  canRun: boolean
  expanded: boolean
  onExpand: (open: boolean) => void
  onEdit: (automation: Automation) => void
  onDelete: () => void
  onEnable: (enabled: boolean) => void
  onRun: () => void
  onOpen: (id: string) => void
  onReload: () => void
}) {
  const status = scheduleStatus(automation)
  const detail = read.state === 'ready' ? read.detail : undefined
  const runs = detail?.runs ?? []
  const missed = missedRuns(runs)
  const [all, setAll] = useState(false)
  const shown = all ? runs : runs.slice(0, SHOWN_RUNS)
  const state = writeFor(writes.state, `automation:${automation.id}`)
  const locked = writes.saving || writes.held
  const running = automation.state === 'running'
  const on = automation.enabled
  return (
    <li className="agent-schedule" aria-label={automation.name}>
      <div className="agent-schedule-main">
        <span className="agent-schedule-icon" aria-hidden="true">
          <Icon icon={AlarmClock} size={16} />
        </span>
        <div className="agent-schedule-text">
          <span className="agent-recent-title">{automation.name}</span>
          <span className="agent-schedule-meta">
            {scheduleWords(automation.schedule)}
            {automation.nextRunAt && on ? ` · ${COPY.next(whenWords(automation.nextRunAt))}` : ''}
            {automation.lastRun ? ` · ${COPY.last(whenWords(automation.lastRun.at), RUN_WORDS[automation.lastRun.state])}` : ''}
          </span>
          <span className="agent-schedule-meta agent-schedule-uses">
            <Icon icon={FolderGlyph} size={12} />
            <span>{scheduleWhere(catalog, automation)}</span>
            {detail && (
              <>
                <span aria-hidden="true">·</span>
                <span className="agent-schedule-input" title={detail.automation.prompt}>
                  {inputLine(detail.automation.prompt)}
                </span>
              </>
            )}
          </span>
        </div>
        <span className="agent-schedule-state">
          {missed.length > 0 && (
            <Hint className="agent-schedule-missed" label={COPY.missed(missed.length)} lead={<Icon icon={AlertGlyph} size={12} />}>
              {missed.map(run => `${whenWords(run.at)}：${runReason(run)}`).join(' ')}
            </Hint>
          )}
          {status.reason ? (
            <Hint className="agent-schedule-paused" label={status.label} lead={<Icon icon={CirclePause} size={12} />}>
              {status.reason}
            </Hint>
          ) : (
            <StatusWord tone={status.tone}>{status.label}</StatusWord>
          )}
        </span>
      </div>
      {canRun && (
        <div className="agent-schedule-actions">
          <IconButton
            size="sm"
            label={COPY.edit}
            icon={EditGlyph}
            disabled={locked || running || !detail}
            onClick={() => {
              if (detail) onEdit(detail.automation)
            }}
          />
          <IconButton size="sm" label={COPY.delete} icon={TrashGlyph} disabled={locked || running} onClick={onDelete} />
          <span className="agent-form-spacer" />
          {on ? (
            <Button
              variant="ghost"
              disabled={locked}
              onClick={() => {
                onEnable(false)
              }}>
              {COPY.pause}
            </Button>
          ) : (
            <Button
              variant="ghost"
              disabled={locked || block !== undefined}
              onClick={() => {
                onEnable(true)
              }}>
              {automation.state === 'paused' ? COPY.reenable : COPY.resume}
            </Button>
          )}
          <Button icon={Play} disabled={locked || running || runBlock !== undefined} onClick={onRun}>
            {COPY.runNow}
          </Button>
        </div>
      )}
      <WriteNotice state={state} onRetry={() => void writes.retry()} onReload={onReload} />
      <div className="agent-schedule-runs">
        <button
          type="button"
          className="agent-schedule-fold"
          aria-expanded={expanded}
          onClick={() => {
            onExpand(!expanded)
          }}>
          <span>{COPY.history}</span>
          {detail && <span className="agent-schedule-count">{runs.length}</span>}
          <Icon icon={ChevronDownGlyph} size={14} className="agent-schedule-chevron" />
        </button>
        {expanded
          && (read.state === 'loading' ? (
            <Loading label={COPY.reading} />
          ) : read.state === 'failed' ? (
            <p className="agent-form-empty">{read.message}</p>
          ) : runs.length === 0 ? (
            <p className="agent-form-empty">{COPY.neverRun}</p>
          ) : (
            <>
              <ul className="agent-recent" aria-label={COPY.historyOf(automation.name)}>
                {shown.map(run => (
                  <RunRow key={`${run.at}:${run.trigger}:${run.state}`} run={run} onOpen={onOpen} />
                ))}
              </ul>
              {runs.length > shown.length && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setAll(true)
                  }}>
                  {COPY.all(runs.length)}
                </Button>
              )}
            </>
          ))}
      </div>
    </li>
  )
}

/**
 * 定时: this Agent's automations (通用's: those that name no Agent). New and edit, 立即运行, 暂停 / 继续 and 删除, each
 * with a requestId and a kept request when its result is unknown; a device or Agent that cannot is told why.
 */
export function SchedulesTab({
  catalog,
  access,
  agentId,
  agent,
  automations,
  writes,
  offline,
  onOpenSession,
  onReload,
  prefill,
  nonce,
}: {
  catalog: HostCatalog | undefined
  access: DeviceAccess
  /** Absent for 通用. */
  agentId: string | undefined
  agent: CustomAgentSummary | undefined
  /** Absent while the Host is confirming a write and leaves them out of the snapshot. */
  automations: AutomationSummary[] | undefined
  writes: AgentWrites
  offline: boolean
  onOpenSession: (id: string) => void
  onReload: () => void
  /** A schedule proposal to open the new-schedule form with; saving it marks the proposal. */
  prefill?: SchedulePrefill | undefined
  /** Changes when the same prefill is asked for again. */
  nonce?: number
}) {
  const [form, setForm] = useState<{ base: ScheduleDraft; automation?: Automation; proposalId?: string; external?: boolean } | null>(null)
  // Each 打开 on a proposal fills the form once; coming back to this list later does not open it again.
  useEffect(() => {
    if (!prefill || usedPrefills.has(prefill)) return
    usedPrefills.add(prefill)
    writes.clear()
    setForm({ base: prefill.draft, proposalId: prefill.proposalId, external: prefill.external })
  }, [prefill, nonce, writes.clear])
  const [deleting, setDeleting] = useState<AutomationSummary | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const details = useAutomationDetails(automations ?? [])
  const canRun = access.scopes.has('run')
  const block = scheduleBlock({ offline, canRun, agent })
  const runBlock = scheduleBlock({ offline, canRun, agent, trigger: 'manual' })
  const harness = catalog?.harnesses.find(item => item.id === (agent?.harnessId ?? catalog.defaults.harnessId))
  const reload = () => {
    writes.clear()
    details.reload()
    onReload()
  }
  if (!automations) return <Loading label={COPY.confirming} />
  const writeKey = form?.automation ? `automation:${form.automation.id}` : 'automation:new'
  const save = async (draft: ScheduleDraft) => {
    const done = form?.automation
      ? await writes.run(`automation:${form.automation.id}`, `automations/${encodeURIComponent(form.automation.id)}`, 'PATCH', {
          ...schedulePatch(form.base, draft),
          baseRevision: form.automation.revision,
        })
      : await writes.run('automation:new', 'automations', 'POST', {
          ...scheduleCreate(draft, agentId),
          ...(block !== undefined ? { enabled: false } : {}),
          ...(form?.proposalId ? { proposalId: form.proposalId } : {}),
        })
    if (done !== undefined) setForm(null)
  }
  // The first automation shows its runs from the start; the others unfold on request.
  const isExpanded = (id: string) => (expanded.has(id) ? true : expanded.has(`-${id}`) ? false : automations[0]?.id === id)
  return (
    <div className="agent-schedules">
      <div className="agent-memory-bar">
        {block ? (
          <Hint
            label={
              runBlock ? (canRun && !offline ? COPY.cannotCreate : offline ? CONNECTION_COPY.offline : COPY.viewOnly) : COPY.manualOnly
            }>
            {block}
          </Hint>
        ) : (
          <Hint label={COPY.startsSession}>{COPY.startDetail}</Hint>
        )}
        <span className="agent-form-spacer" />
        {canRun && !form && (
          <Button
            icon={PlusGlyph}
            disabled={runBlock !== undefined || writes.saving || writes.held || !catalog}
            onClick={() => {
              writes.clear()
              setForm({ base: newScheduleDraft() })
            }}>
            {COPY.newSchedule}
          </Button>
        )}
      </div>
      {form && catalog && (
        <ScheduleForm
          key={form.automation?.id ?? form.proposalId ?? 'new'}
          catalog={catalog}
          harness={harness}
          access={access}
          base={form.base}
          editing={form.automation !== undefined}
          manualOnly={block !== undefined}
          proposal={form.proposalId ? { external: form.external === true } : undefined}
          writes={writes}
          writeKey={writeKey}
          disabled={offline || (!form.automation && runBlock !== undefined)}
          onSave={draft => void save(draft)}
          onCancel={() => {
            writes.clear()
            setForm(null)
          }}
          onReload={() => {
            setForm(null)
            reload()
          }}
        />
      )}
      {automations.length === 0 && !form ? (
        <EmptyState title={COPY.noScheduled} />
      ) : (
        <ul className="agent-schedule-list" aria-label={COPY.schedules}>
          {automations.map(automation => (
            <ScheduleCard
              key={automation.id}
              catalog={catalog}
              automation={automation}
              read={details.read(automation.id)}
              writes={writes}
              block={block}
              runBlock={runBlock}
              canRun={canRun}
              expanded={isExpanded(automation.id)}
              onExpand={open => {
                setExpanded(previous => {
                  const next = new Set([...previous].filter(key => key !== automation.id && key !== `-${automation.id}`))
                  next.add(open ? automation.id : `-${automation.id}`)
                  return next
                })
              }}
              onEdit={value => {
                writes.clear()
                setForm({ base: scheduleDraftOf(value), automation: value })
              }}
              onDelete={() => {
                setDeleting(automation)
              }}
              onEnable={enabled => {
                void writes.run(`automation:${automation.id}`, `automations/${encodeURIComponent(automation.id)}/enabled`, 'POST', {
                  enabled,
                  baseRevision: automation.revision,
                })
              }}
              onRun={() => {
                void writes.run(`automation:${automation.id}`, `automations/${encodeURIComponent(automation.id)}/run`, 'POST', {})
              }}
              onOpen={onOpenSession}
              onReload={reload}
            />
          ))}
        </ul>
      )}
      {deleting && (
        <ConfirmDialog
          title={COPY.confirmDelete(deleting.name)}
          danger
          confirmLabel={COPY.delete}
          message={COPY.deleteDetail}
          onClose={() => {
            setDeleting(null)
          }}
          onConfirm={async () => {
            const done = await writes.run(`automation:${deleting.id}`, `automations/${encodeURIComponent(deleting.id)}`, 'DELETE', {})
            if (done === undefined) throw new MessageError(COPY.deleteFailed)
          }}
        />
      )}
    </div>
  )
}
