import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, Pencil, Plus, UsersRound } from 'lucide-react'
import type {
  AppSnapshot,
  PersonalAssistant,
  PersonalAssistantConfig,
  PersonalAssistantDetail,
  PersonalAssistantSummary,
  PersonalMemory,
  PersonalOverview,
  PluginInfo,
} from '@latch/protocol'
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Icon,
  IconButton,
  InlineNotice,
  Loading,
  Tabs,
  TextAreaField,
  TextField,
  ValuePicker,
} from '@latch/ui'
import { api, ApiError, inlineError, isUncertain, newRequestId } from '../core/api.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { relativeTime } from '../format.ts'
import { ModelPicker } from '../components/Pickers.tsx'
import { NavRow, SectionHeading, SettingsGroup } from '../settings/common.tsx'
import { useViewport } from '../breakpoints.ts'
import { useBackLayer } from '../hooks/backStack.ts'
import { deferredComponent } from '../components/DeferredContent.tsx'
import { emptyGroupDraft, groupPath, type GroupDraft, type RoutineDraft, type PersonalMutation as Mutation } from './model.ts'

const GroupPage = deferredComponent(async () => ({ default: (await import('./GroupPage.tsx')).GroupPage }), '助手群聊')
const RoutinePage = deferredComponent(async () => ({ default: (await import('./RoutinePage.tsx')).RoutinePage }), '定时任务')
type Area = 'assistants' | 'groups' | 'routines'

type Overview = PersonalOverview & { plugins?: Array<Pick<PluginInfo, 'id' | 'name' | 'description' | 'capabilities'>> }
const assistantPath = (id: string) => 'personal/assistants/' + encodeURIComponent(id)

/** The personal namespace is loaded only while this private page is visible. No roles or memories enter local storage. */
export function PersonalPage({
  snapshot,
  access,
  refreshHint,
  canStart,
  open = true,
  area: entryArea = 'assistants',
  initialGroupId,
  onGroupSession,
  onClose,
  onChanged,
  onSession,
  onStart,
}: {
  snapshot: AppSnapshot
  access: DeviceAccess
  refreshHint: number
  canStart: boolean
  open?: boolean
  /** Which entry shows the page: 个人助手 with its groups, or 定时任务 alone. */
  area?: 'assistants' | 'routines'
  initialGroupId?: string
  onGroupSession?: (sessionId: string, groupId: string) => void
  onClose: () => void
  onChanged: () => void
  onSession: (id: string) => void
  onStart: (assistant: PersonalAssistantSummary) => void
}) {
  const allowed = snapshot.device.dataScope === 'all' && access.scopes.has('view')
  const writable = allowed && access.scopes.has('run')
  const groupsEnabled = snapshot.catalog?.features?.personalGroups === true
  const routinesEnabled = snapshot.catalog?.features?.personalRoutines === true
  const [chosenArea, setArea] = useState<'assistants' | 'groups'>(initialGroupId && groupsEnabled ? 'groups' : 'assistants')
  const area: Area = entryArea === 'routines' && routinesEnabled ? 'routines' : chosenArea
  const phone = useViewport() === 'phone'
  const [groupId, setGroupId] = useState<string | null>(initialGroupId ?? null)
  const [routineId, setRoutineId] = useState<string | null>(null)
  const [groupDrafts, setGroupDrafts] = useState<Record<string, GroupDraft>>({})
  const [routineDrafts, setRoutineDrafts] = useState<Record<string, RoutineDraft>>({})
  const [overview, setOverview] = useState<Overview | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<PersonalAssistantDetail | null>(null)
  const [tab, setTab] = useState<'sessions' | 'memories'>('sessions')
  const [editing, setEditing] = useState<PersonalAssistant | 'new' | null>(null)
  const [memory, setMemory] = useState<PersonalMemory | 'new' | null>(null)
  const [memoryText, setMemoryText] = useState('')
  const [deleting, setDeleting] = useState<{ kind: 'assistant' | 'memory'; id: string; name: string } | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<Mutation | null>(null)
  const [busy, setBusy] = useState(false)
  const [cancelPending, setCancelPending] = useState<{ groupId: string; turnId: string; requestId: string } | null>(null)
  const [cancelBusy, setCancelBusy] = useState(false)
  const [cancelError, setCancelError] = useState('')
  const [sessionLimit, setSessionLimit] = useState(40)
  const request = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const live = useRef(true)
  const busyRef = useRef(false)
  const pendingRef = useRef<Mutation | null>(null)
  const cancelBusyRef = useRef(false)
  const cancelPendingRef = useRef<typeof cancelPending>(null)
  const privateEpoch = useRef(0)
  const visible = useRef(open)
  visible.current = open
  const permitted = useRef(allowed)
  permitted.current = allowed
  const areaRef = useRef(area)
  areaRef.current = area
  const groupRef = useRef(groupId)
  groupRef.current = groupId
  const routineRef = useRef(routineId)
  routineRef.current = routineId
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const changedRef = useRef(onChanged)
  changedRef.current = onChanged
  const reload = async (id = selectedRef.current) => {
    if (!visible.current || !permitted.current) return
    request.current?.abort()
    const controller = new AbortController(),
      ticket = ++generation.current
    request.current = controller
    try {
      const [next, nextDetail] = await Promise.all([
        api<Overview>('personal', { signal: controller.signal }),
        areaRef.current === 'assistants' && id
          ? api<PersonalAssistantDetail>(assistantPath(id), { signal: controller.signal })
          : Promise.resolve(null),
      ])
      if (!live.current || !visible.current || !permitted.current || ticket !== generation.current) return
      setOverview(next)
      setDetail(nextDetail)
    } catch (cause) {
      if (live.current && visible.current && permitted.current && ticket === generation.current && !controller.signal.aborted) throw cause
    }
  }
  const clearPrivate = () => {
    privateEpoch.current++
    generation.current++
    request.current?.abort()
    setOverview(null)
    setDetail(null)
    setEditing(null)
    setMemory(null)
    setMemoryText('')
    setError('')
    setGroupDrafts({})
    setRoutineDrafts({})
    setGroupId(null)
    setRoutineId(null)
    pendingRef.current = null
    busyRef.current = false
    setPending(null)
    setBusy(false)
    cancelPendingRef.current = null
    cancelBusyRef.current = false
    setCancelPending(null)
    setCancelBusy(false)
    setCancelError('')
  }
  const readError = (cause: unknown) => {
    if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) {
      clearPrivate()
      changedRef.current()
    }
    if (live.current && !(cause instanceof DOMException && cause.name === 'AbortError')) setError(inlineError(cause))
  }
  useEffect(() => {
    live.current = allowed
    if (!allowed) clearPrivate()
    return () => {
      live.current = false
      privateEpoch.current++
      generation.current++
      request.current?.abort()
    }
  }, [allowed])
  useEffect(() => {
    if (!allowed || !open) {
      request.current?.abort()
      generation.current++
      setOverview(null)
      setDetail(null)
      return
    }
    void reload().catch(readError)
    return () => {
      generation.current++
      request.current?.abort()
    }
  }, [allowed, open, selected, area])
  useEffect(() => {
    if (open && groupsEnabled && initialGroupId) {
      setArea('groups')
      setGroupId(initialGroupId)
    }
  }, [open, initialGroupId, groupsEnabled])
  useEffect(() => {
    if ((area === 'groups' && !groupsEnabled) || (area === 'routines' && !routinesEnabled)) setArea('assistants')
  }, [area, groupsEnabled, routinesEnabled])
  useEffect(() => {
    if (!allowed || !open || !overview) return
    const timer = setTimeout(() => {
      if (document.hidden || busyRef.current) return
      void reload().catch(() => {})
    }, 320)
    return () => clearTimeout(timer)
  }, [refreshHint, open])
  useEffect(() => {
    const visible = () => {
      if (allowed && open && !document.hidden && !busyRef.current) void reload().catch(readError)
    }
    document.addEventListener('visibilitychange', visible)
    return () => document.removeEventListener('visibilitychange', visible)
  }, [allowed, open])
  const mutate = async (change: Mutation, retry = false) => {
    if (
      !writable
      || !live.current
      || !visible.current
      || busyRef.current
      || cancelBusyRef.current
      || cancelPendingRef.current !== null
      || (pendingRef.current !== null && (!retry || change !== pendingRef.current))
    )
      return
    const exact = retry ? change : { ...change, options: { ...change.options, body: structuredClone(change.options.body) } }
    const epoch = privateEpoch.current
    busyRef.current = true
    setBusy(true)
    pendingRef.current = exact
    setPending(exact)
    setError('')
    try {
      const value = await api<Record<string, unknown>>(exact.path, exact.options)
      if (!live.current || !permitted.current || epoch !== privateEpoch.current) return
      pendingRef.current = null
      setPending(null)
      exact.after?.(value)
      changedRef.current()
      await reload().catch(readError)
    } catch (cause) {
      if (!live.current || !permitted.current || epoch !== privateEpoch.current) return
      if (!isUncertain(cause)) {
        pendingRef.current = null
        setPending(null)
      }
      setError(inlineError(cause))
    } finally {
      if (epoch === privateEpoch.current) {
        busyRef.current = false
        if (live.current) setBusy(false)
      }
    }
  }
  const cancelGroup = async (id: string, turnId: string, retry = false) => {
    if (!access.scopes.has('view') || !live.current || cancelBusyRef.current || (!retry && cancelPendingRef.current)) return
    const exact = retry ? cancelPendingRef.current : { groupId: id, turnId, requestId: newRequestId() }
    if (!exact) return
    const epoch = privateEpoch.current
    cancelBusyRef.current = true
    setCancelBusy(true)
    cancelPendingRef.current = exact
    setCancelPending(exact)
    setCancelError('')
    try {
      await api(groupPath(exact.groupId) + '/cancel', { method: 'POST', body: { requestId: exact.requestId, turnId: exact.turnId } })
      if (!live.current || epoch !== privateEpoch.current) return
      cancelPendingRef.current = null
      setCancelPending(null)
      changedRef.current()
      await reload().catch(readError)
    } catch (cause) {
      if (!live.current || epoch !== privateEpoch.current) return
      if (!isUncertain(cause)) {
        cancelPendingRef.current = null
        setCancelPending(null)
      }
      setCancelError(inlineError(cause))
    } finally {
      if (epoch === privateEpoch.current) {
        cancelBusyRef.current = false
        if (live.current) setCancelBusy(false)
      }
    }
  }
  const locked = busy || pending !== null || cancelBusy || cancelPending !== null
  const feedback = (
    <>
      {error && !pending && (
        <InlineNotice tone="error">
          {error}
          {!pending && !busy && (
            <Button
              onClick={() => {
                setError('')
                void reload().catch(cause => setError(inlineError(cause)))
              }}>
              重新同步
            </Button>
          )}
        </InlineNotice>
      )}
      {pending && !busy && (
        <InlineNotice tone="warn">
          结果尚未确认，内容已保留。
          <Button
            disabled={!writable}
            onClick={() => {
              void mutate(pending, true)
            }}>
            重试同一请求
          </Button>
        </InlineNotice>
      )}
      {cancelError && (
        <InlineNotice tone={cancelPending ? 'warn' : 'error'}>
          {cancelPending ? '停止结果尚未确认。' : cancelError}
          {cancelPending && !cancelBusy && (
            <Button onClick={() => void cancelGroup(cancelPending.groupId, cancelPending.turnId, true)}>重试原停止请求</Button>
          )}
        </InlineNotice>
      )}
      {cancelBusy && <Loading label="正在等待本轮真实停止…" />}
    </>
  )
  const active = detail?.assistant.id === selected ? detail : null
  const memoryPath = active ? assistantPath(active.assistant.id) + '/memories' : ''
  const choose = (id: string | null) => {
    setSelected(id)
    setDetail(null)
    setTab('sessions')
    setSessionLimit(40)
    setError('')
  }
  const groupKey = groupId ?? 'new'
  const routineKey = routineId ?? 'new'
  const groupDraft = groupDrafts[groupKey] ?? emptyGroupDraft()
  const routineDraft = routineDrafts[routineKey] ?? {}
  const back =
    area === 'groups' && groupId
      ? () => setGroupId(null)
      : area === 'routines' && routineId
        ? () => setRoutineId(null)
        : area === 'assistants' && selected
          ? () => choose(null)
          : onClose
  useEffect(() => {
    if (!overview) return
    const groups = new Set((overview.groups ?? []).map(item => item.id)),
      routines = new Set((overview.routines ?? []).map(item => item.id))
    setGroupDrafts(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => id === 'new' || groups.has(id))))
    setRoutineDrafts(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => id === 'new' || routines.has(id))))
  }, [overview])
  const nested =
    (area === 'groups' && groupId !== null) || (area === 'routines' && routineId !== null) || (area === 'assistants' && selected !== null)
  useBackLayer(phone && open && !nested, onClose)
  if (!open) return null
  return (
    <section aria-label="个人助手" className="personal-page">
      {(phone || nested) && (
        <header className="personal-bar">
          <Button variant="ghost" icon={ChevronLeft} onClick={back}>
            {area === 'groups' && groupId
              ? '所有群聊'
              : area === 'routines' && routineId
                ? '所有定时任务'
                : area === 'assistants' && selected
                  ? '所有助手'
                  : '设置'}
          </Button>
        </header>
      )}
      <div className="personal-scroll">
        <div className="personal-content">
          {allowed && groupsEnabled && area !== 'routines' && (
            <Tabs
              label="个人助手内容"
              value={chosenArea}
              options={[
                { value: 'assistants', label: '助手' },
                { value: 'groups', label: '群聊' },
              ]}
              onValueChange={setArea}
            />
          )}
          {allowed && overview && ((area === 'groups' && !groupDraft.editor) || (area === 'routines' && !routineDraft.editor)) && feedback}
          {!allowed ? (
            <EmptyState title="在电脑上允许个人助手访问" description="允许后，这台设备就能查看助手、记忆和日常对话。" />
          ) : !overview ? (
            <>
              {feedback}
              {!error && <Loading label="正在读取个人助手…" />}
            </>
          ) : area === 'groups' && groupsEnabled ? (
            <GroupPage
              groups={overview.groups ?? []}
              assistants={overview.assistants}
              groupId={groupId}
              draft={groupDraft}
              onDraft={update => setGroupDrafts(previous => ({ ...previous, [groupKey]: update(previous[groupKey] ?? emptyGroupDraft()) }))}
              onSelect={id => {
                if (areaRef.current === 'groups' && groupRef.current === groupId) setGroupId(id)
              }}
              writable={writable}
              locked={locked}
              canStart={canStart}
              cancelLocked={cancelBusy || cancelPending !== null}
              feedback={groupDraft.editor ? feedback : null}
              refreshHint={refreshHint}
              onMutate={change => mutate(change)}
              onCancel={cancelGroup}
              onSession={(id, group) => (onGroupSession ? onGroupSession(id, group) : onSession(id))}
              onDenied={readError}
            />
          ) : area === 'routines' && routinesEnabled ? (
            <RoutinePage
              routines={overview.routines ?? []}
              assistants={overview.assistants}
              routineId={routineId}
              draft={routineDraft}
              onDraft={update => setRoutineDrafts(previous => ({ ...previous, [routineKey]: update(previous[routineKey] ?? {}) }))}
              onSelect={id => {
                if (areaRef.current === 'routines' && routineRef.current === routineId) setRoutineId(id)
              }}
              local={access.local}
              writable={writable}
              locked={locked}
              feedback={routineDraft.editor ? feedback : null}
              onMutate={change => mutate(change)}
              onSession={onSession}
            />
          ) : !selected ? (
            <>
              <SectionHeading
                title="你的个人助手"
                description="按你的习惯思考、整理和完成工作，电脑和手机接着聊。"
                action={
                  writable && (
                    <Button icon={Plus} disabled={locked} onClick={() => setEditing('new')}>
                      创建助手
                    </Button>
                  )
                }
              />
              {feedback}
              {overview.assistants.length === 0 ? (
                <EmptyState title="从一位了解你的助手开始" description="给它一个名字和职责。你可以随时添加记忆，或为它选择自己的插件。" />
              ) : (
                <div className="personal-assistants">
                  {overview.assistants.map(assistant => (
                    <button key={assistant.id} type="button" className="personal-assistant" onClick={() => choose(assistant.id)}>
                      <span className="personal-avatar">
                        <Icon icon={UsersRound} size={20} />
                      </span>
                      <span>
                        <strong>{assistant.name}</strong>
                        <span className="personal-role">{assistant.role || '一起梳理想法，完成日常工作。'}</span>
                        <span className="personal-facts">
                          {assistant.sessionCount} 段对话 · {assistant.memoryCount} 条记忆
                        </span>
                        {assistant.unavailableReason && <span className="personal-unavailable">{assistant.unavailableReason}</span>}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : !active ? (
            <>
              {feedback}
              {!error && <Loading label="正在读取助手…" />}
            </>
          ) : (
            <>
              <SectionHeading
                title={active.assistant.name}
                description={active.assistant.role || '和你的助手开始一段对话。'}
                action={
                  writable && (
                    <div className="personal-actions">
                      <Button icon={Pencil} disabled={locked} onClick={() => setEditing(active.assistant)}>
                        编辑
                      </Button>
                      <Button
                        variant="primary"
                        icon={Plus}
                        disabled={locked || !active.assistant.available || !canStart}
                        title={!canStart ? '先确认上一条提交的结果，再开始新的对话。' : undefined}
                        onClick={() => onStart(active.assistant)}>
                        新对话
                      </Button>
                    </div>
                  )
                }
              />
              {active.assistant.unavailableReason && (
                <InlineNotice tone="warn">
                  {active.assistant.unavailableReason}
                  {writable && <Button onClick={() => setEditing(active.assistant)}>检查配置</Button>}
                </InlineNotice>
              )}
              {!editing && !memory && feedback}
              <Tabs
                label="助手内容"
                value={tab}
                options={[
                  { value: 'sessions', label: '对话' },
                  { value: 'memories', label: '记忆' },
                ]}
                onValueChange={setTab}
              />
              {tab === 'sessions' ? (
                <SettingsGroup caption="每段对话独立保存，职责与记忆由这个助手使用。" captionIcon={null}>
                  {active.sessions.length === 0 ? (
                    <p className="personal-empty">还没有对话，写下今天想做的事。</p>
                  ) : (
                    active.sessions
                      .slice(0, sessionLimit)
                      .map(session => (
                        <NavRow
                          key={session.id}
                          title={session.title || '未命名对话'}
                          description={session.status === 'failed' ? '执行失败，可以打开查看原因。' : undefined}
                          value={relativeTime(session.updatedAt)}
                          onClick={() => onSession(session.id)}
                        />
                      ))
                  )}
                  {active.sessions.length > sessionLimit && (
                    <Button variant="ghost" onClick={() => setSessionLimit(limit => limit + 40)}>
                      显示更早的对话
                    </Button>
                  )}
                </SettingsGroup>
              ) : (
                <>
                  <div className="personal-memory-heading">
                    <p>你明确保存的信息，只用于这位助手。</p>
                    {writable && (
                      <Button
                        icon={Plus}
                        disabled={locked}
                        onClick={() => {
                          setMemory('new')
                          setMemoryText('')
                        }}>
                        添加记忆
                      </Button>
                    )}
                  </div>
                  <div className="personal-memories">
                    {active.memories.length === 0 ? (
                      <p className="personal-empty">还没有保存记忆。可以记录偏好、背景或需要长期记住的约定。</p>
                    ) : (
                      active.memories.map(item => (
                        <article className="personal-memory" key={item.id}>
                          <p>{item.content}</p>
                          {writable && (
                            <div className="personal-actions">
                              <Button
                                variant="ghost"
                                disabled={locked}
                                onClick={() => {
                                  setMemory(item)
                                  setMemoryText(item.content)
                                }}>
                                编辑
                              </Button>
                              <Button
                                variant="ghost"
                                disabled={locked}
                                onClick={() => setDeleting({ kind: 'memory', id: item.id, name: '这条记忆' })}>
                                删除
                              </Button>
                            </div>
                          )}
                        </article>
                      ))
                    )}
                  </div>
                </>
              )}
              {writable && (
                <div className="personal-delete">
                  <Button
                    variant="ghost"
                    disabled={locked}
                    onClick={() => setDeleting({ kind: 'assistant', id: active.assistant.id, name: active.assistant.name })}>
                    删除助手
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {editing && allowed && area === 'assistants' && (
        <AssistantEditor
          snapshot={snapshot}
          access={access}
          assistant={editing === 'new' ? undefined : editing}
          plugins={overview?.plugins ?? []}
          locked={locked}
          feedback={feedback}
          onClose={() => {
            if (!locked) setEditing(null)
          }}
          onSave={config => {
            const existing = editing === 'new' ? undefined : editing
            void mutate({
              path: existing ? assistantPath(existing.id) : 'personal/assistants',
              options: {
                method: existing ? 'PATCH' : 'POST',
                body: {
                  ...config,
                  requestId: newRequestId(),
                  ...(existing ? { baseRevision: existing.revision, model: config.model ?? null } : {}),
                },
              },
              after: value => {
                setEditing(null)
                if (typeof value.id === 'string') {
                  setSelected(value.id)
                  selectedRef.current = value.id
                }
              },
            })
          }}
        />
      )}
      <Dialog
        open={memory !== null && allowed && area === 'assistants'}
        title={memory === 'new' ? '添加记忆' : '编辑记忆'}
        size="form"
        onClose={() => {
          if (!locked) {
            setMemory(null)
            setMemoryText('')
          }
        }}
        footer={
          <Button
            variant="primary"
            disabled={locked || !memoryText.trim()}
            loading={busy}
            onClick={() => {
              if (!memory || !active) return
              void mutate({
                path: memoryPath + (memory === 'new' ? '' : '/' + encodeURIComponent(memory.id)),
                options: {
                  method: memory === 'new' ? 'POST' : 'PATCH',
                  body: { requestId: newRequestId(), content: memoryText, ...(memory === 'new' ? {} : { baseRevision: memory.revision }) },
                },
                after: () => {
                  setMemory(null)
                  setMemoryText('')
                },
              })
            }}>
            保存记忆
          </Button>
        }>
        <div className="settings-form">
          <TextAreaField
            label="记忆内容"
            value={memoryText}
            rows={7}
            maxLength={4000}
            disabled={locked}
            hint="例如：我喜欢先看到结论，再看依据。保存后可随时修改或删除。"
            onChange={event => setMemoryText(event.target.value)}
          />
          {feedback}
        </div>
      </Dialog>
      {deleting && allowed && area === 'assistants' && (
        <ConfirmDialog
          title={deleting.kind === 'assistant' ? '删除这位助手？' : '删除这条记忆？'}
          message={'删除「' + deleting.name + '」后无法恢复。'}
          confirmLabel="删除"
          danger
          onClose={() => {
            if (!busy) setDeleting(null)
          }}
          onConfirm={async () => {
            const target = deleting
            await mutate({
              path: target.kind === 'assistant' ? assistantPath(target.id) : memoryPath + '/' + encodeURIComponent(target.id),
              options: { method: 'DELETE', body: { requestId: newRequestId() } },
              after: () => {
                setDeleting(null)
                if (target.kind === 'assistant') {
                  choose(null)
                  selectedRef.current = null
                }
              },
            })
          }}
        />
      )}
    </section>
  )
}

function AssistantEditor({
  snapshot,
  access,
  assistant,
  plugins,
  locked,
  feedback,
  onClose,
  onSave,
}: {
  snapshot: AppSnapshot
  access: DeviceAccess
  assistant?: PersonalAssistant
  plugins: NonNullable<Overview['plugins']>
  locked: boolean
  feedback: import('react').ReactNode
  onClose: () => void
  onSave: (config: PersonalAssistantConfig) => void
}) {
  const catalog = snapshot.catalog
  const [config, setConfig] = useState<PersonalAssistantConfig>(() =>
    assistant
      ? {
          name: assistant.name,
          role: assistant.role,
          harnessId: assistant.harnessId,
          mode: assistant.mode,
          pluginIds: [...assistant.pluginIds],
          ...(assistant.model ? { model: assistant.model } : {}),
        }
      : {
          name: '我的助手',
          role: '',
          harnessId: 'standard',
          mode: 'chat',
          pluginIds: [],
          ...(catalog?.defaults.model ? { model: catalog.defaults.model } : {}),
        },
  )
  const harnesses = catalog?.harnesses.filter(item => item.agentContext === 'private') ?? []
  const harness = harnesses.find(item => item.id === config.harnessId)
  return (
    <Dialog
      open
      title={assistant ? '编辑助手' : '创建助手'}
      size="wide"
      onClose={onClose}
      footer={
        <>
          <Button disabled={locked} onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={locked || !config.name.trim() || !harness} onClick={() => onSave(config)}>
            保存助手
          </Button>
        </>
      }>
      <div className="settings-form">
        <fieldset disabled={locked} className="personal-editor-fields">
          <TextField
            label="名字"
            value={config.name}
            maxLength={80}
            placeholder="例如：日常助理"
            onChange={event => setConfig({ ...config, name: event.target.value })}
          />
          <TextAreaField
            label="职责"
            value={config.role}
            maxLength={2000}
            rows={4}
            placeholder="希望它怎样帮助你，按什么方式工作？"
            onChange={event => setConfig({ ...config, role: event.target.value })}
          />
          {harnesses.length === 0 && <InlineNotice tone="warn">电脑上还没有支持个人助手私有上下文的执行方式。</InlineNotice>}
          <div className="personal-actions">
            <ValuePicker
              label="执行方式"
              value={config.harnessId}
              groups={[{ id: 'harnesses', options: harnesses.map(item => ({ value: item.id, label: item.name })) }]}
              onValueChange={id => {
                const next = harnesses.find(item => item.id === id)
                setConfig({
                  ...config,
                  harnessId: id,
                  mode: next?.modes.includes(config.mode) ? config.mode : (next?.modes[0] ?? 'chat'),
                  ...(next?.models !== 'host' ? { model: undefined } : {}),
                })
              }}
            />
            <ValuePicker
              label="工作方式"
              value={config.mode}
              groups={[
                {
                  id: 'modes',
                  options: (harness?.modes ?? []).map(mode => ({ value: mode, label: mode === 'chat' ? '只对话' : '执行任务' })),
                },
              ]}
              onValueChange={mode => setConfig({ ...config, mode: mode === 'chat' ? 'chat' : 'agent' })}
            />
            {catalog && harness?.models === 'host' && (
              <ModelPicker catalog={catalog} access={access} value={config.model} onChange={model => setConfig({ ...config, model })} />
            )}
          </div>
          <section className="personal-plugin-options">
            <h3>插件</h3>
            <p>选择这位助手可以使用的技能、工具与界面。</p>
            {plugins.length === 0 && <p>电脑上暂时没有可选择的插件。</p>}
            {plugins.map(plugin => (
              <Checkbox
                key={plugin.id}
                label={plugin.name}
                description={plugin.description}
                checked={config.pluginIds.includes(plugin.id)}
                onChange={event =>
                  setConfig({
                    ...config,
                    pluginIds: event.target.checked ? [...config.pluginIds, plugin.id] : config.pluginIds.filter(id => id !== plugin.id),
                  })
                }
              />
            ))}
            {config.pluginIds
              .filter(id => !plugins.some(plugin => plugin.id === id))
              .map(id => (
                <Checkbox
                  key={id}
                  label={id}
                  description="插件已不可用，取消勾选后重新保存。"
                  checked
                  onChange={() => setConfig({ ...config, pluginIds: config.pluginIds.filter(item => item !== id) })}
                />
              ))}
          </section>
        </fieldset>
        {feedback}
      </div>
    </Dialog>
  )
}
