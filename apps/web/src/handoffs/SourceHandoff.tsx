import { useEffect, useMemo, useRef, useState } from 'react'
import { MessageSquareQuote, TextQuote } from 'lucide-react'
import { readsProjectFiles, type Handoff, type HandoffCreate, type HandoffList, type HostCatalog, type Message } from '@latch/protocol'
import {
  Button,
  Hint,
  ICON_STROKE,
  IconButton,
  InlineNotice,
  SegmentedControl,
  StatusWord,
  TextAreaField,
  ValuePicker,
  EnterGlyph,
  FileGlyph,
  PlusGlyph,
  CloseGlyph,
} from '@latch/ui'
import { api, newRequestId } from '../core/api.ts'
import { DraftHarnessControl } from '../composer/ModelControl.tsx'
import { FolderControl, HEAD_START } from '../composer/FolderControl.tsx'
import { ModelPicker, ProjectPicker } from '../components/Pickers.tsx'
import { Menu } from '../components/overlays.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { projectFor, readChoice, resolveChoice, worktreeProject, type ComposerChoice } from '../composerChoice.ts'
import { delegationMode, usesHostModels } from '../agents/model.ts'
import { basename } from '../format.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import {
  RETURN_SCOPES,
  SCOPE_FACTS,
  SCOPE_LINES,
  chipKey,
  chipLabel,
  createBody,
  fileName,
  formProblem,
  initialChips,
  materialsOf,
  messageLine,
  namedChips,
  retryBody,
  sessionFiles,
  sessionTargets,
  sha256Hex,
  statusWords,
  writeFailure,
  type HandoffForm,
  type MaterialChip,
  type WriteFailure,
} from './model.ts'
import { fileHash, unansweredCreate, type SessionHandoffs } from './useHandoffs.ts'

/** 交给代码任务… from a message: which messages, and the text selected in them at the time. */
export interface HandoffRequest {
  nonce: number
  sessionId: string
  messageIds: string[]
  text?: string
}

type Target = 'new-session' | 'session'

/** The card's form, started from the device's last new-session choice in the source session's project. */
function startChoice(catalog: HostCatalog, deviceId: string, projectId: string | undefined): ComposerChoice {
  const choice = resolveChoice(catalog, readChoice(deviceId))
  return { ...choice, mode: 'agent', ...(projectId && projectId !== 'default' ? { workspaceId: projectId } : {}) }
}

/**
 * The source side of a handoff, above the composer: the card that hands chosen material to a code session, and the state
 * of each handoff from this session that is not settled yet. Nothing is shown as started until the Host says so.
 */
export function SourceHandoffDock({
  shell,
  request,
  onTaken,
  handoffs,
}: {
  shell: ShellState
  request: HandoffRequest | null
  /** The request has opened the card; it is not taken again when the session is opened again. */
  onTaken: () => void
  handoffs: SessionHandoffs
}) {
  const { current, catalog, access, snapshot, connection, choose } = shell
  const sourceId = current?.summary.id
  const offline = connection === 'offline' || connection === 'reconnecting'
  const canRun = access.scopes.has('run')
  const files = readsProjectFiles(snapshot.device.dataScope)
  const [open, setOpen] = useState(false)
  const [chips, setChips] = useState<MaterialChip[]>([])
  const [target, setTarget] = useState<Target>('new-session')
  const [choice, setChoice] = useState<ComposerChoice>({ mode: 'agent' })
  const [worktree, setWorktree] = useState(false)
  const [sessionId, setSessionId] = useState<string>()
  const [requirements, setRequirements] = useState('')
  const [decisions, setDecisions] = useState<string[]>([])
  const [scope, setScope] = useState<Handoff['returnScope']>('summary-and-evidence')
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<(WriteFailure & { chips?: string[] }) | null>(null)
  const [unknown, setUnknown] = useState<HandoffCreate | undefined>(() => (sourceId ? unansweredCreate.get(sourceId) : undefined))
  const [shownId, setShownId] = useState<string>()
  const busy = useRef(false)
  /** The messages the card was opened from: closing it puts the keys back on their action. */
  const from = useRef<string[]>([])
  const card = useRef<HTMLElement>(null)
  const pins = useRef(new AbortController())
  useEffect(() => () => pins.current.abort(), [])

  /** Pins each new chip to its version: a message by its text, a file by its bytes. */
  const pin = (next: MaterialChip[], messages: readonly Message[]) => {
    if (!sourceId) return
    const signal = pins.current.signal
    for (const chip of next) {
      if (chip.kind === 'text' || chip.hash) continue
      const settle = (patch: { hash?: string; problem?: string }) => {
        if (signal.aborted) return
        setChips(list =>
          list.map((item): MaterialChip => {
            if (item.key !== chip.key || item.kind === 'text') return item
            const { hash: _hash, problem: _problem, ...rest } = item
            return { ...rest, ...patch } as MaterialChip
          }),
        )
      }
      const hashing =
        chip.kind === 'message'
          ? sha256Hex(messages.find(message => message.id === chip.messageId)?.text ?? '')
          : fileHash(sourceId, chip.file, signal)
      void hashing.then(
        hash => settle({ hash }),
        (cause: unknown) => settle({ problem: cause instanceof Error ? cause.message : '读不到' }),
      )
    }
  }

  // A message action opens the card with what was chosen; another one adds to what is there.
  useEffect(() => {
    if (!request || !current || !catalog || request.sessionId !== current.summary.id) return
    const fresh = initialChips(current.messages, request.messageIds, request.text, files)
    setChips(list => {
      const merged = open ? [...list, ...fresh.filter(chip => !list.some(item => item.key === chip.key))] : fresh
      pin(merged, current.messages)
      return merged
    })
    if (!open) {
      setChoice(startChoice(catalog, snapshot.device.id, projectFor(catalog, current.summary)))
      setWorktree(false)
      setTarget('new-session')
      setSessionId(undefined)
      setRequirements(request.text?.trim() ?? '')
      setDecisions([])
      setScope('summary-and-evidence')
      setFailure(null)
    }
    setOpen(true)
    from.current = request.messageIds
    // The keys go to 要求, the one field every handoff reads.
    requestAnimationFrame(() => card.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true }))
    onTaken()
    // Only a new request opens or adds; the rest is read at that moment.
  }, [request?.nonce])

  if (!current || !catalog?.features?.handoffs || !sourceId) return null
  const close = () => {
    setOpen(false)
    const id = from.current[0]
    const row = id ? document.querySelector(`.transcript [data-message-id="${CSS.escape(id)}"]`) : null
    const action =
      row?.querySelector<HTMLElement>('button[aria-label="交给代码任务…"]')
      ?? row?.closest('.turn')?.querySelector<HTMLElement>('button[aria-label="这一轮的更多操作"]')
    action?.focus({ preventScroll: true })
  }
  const source = current.summary
  const harness = catalog.harnesses.find(item => item.id === choice.harnessId)
  const project = catalog.workspaces.find(item => item.id === choice.workspaceId && item.id !== 'default')
  const worktreeOffer = worktreeProject(catalog, choice, false)
  const targets = sessionTargets(snapshot.tasks, source)
  const chosenSession = targets.find(task => task.id === sessionId)
  const form: HandoffForm = {
    target:
      target === 'session'
        ? { kind: 'session', ...(sessionId ? { sessionId } : {}) }
        : {
            kind: 'new-session',
            ...(choice.workspaceId ? { projectId: choice.workspaceId } : {}),
            ...(choice.harnessId ? { harnessId: choice.harnessId } : {}),
            mode: delegationMode(harness, 'agent'),
            ...(usesHostModels(harness) && choice.model
              ? { model: { providerId: choice.model.providerId, model: choice.model.model } }
              : {}),
            worktree: worktree && worktreeOffer !== undefined,
          },
    requirements,
    decisions,
    returnScope: scope,
  }
  const problem = formProblem(form, chips)
  const locked = sending || unknown !== undefined
  const destination =
    target === 'session'
      ? chosenSession
        ? `交给「${messageLine(chosenSession.title || '未命名会话', 12)}」`
        : '交给已有会话'
      : project
        ? `交给 ${project.name || basename(project.path)}`
        : '交给新会话'

  const send = async (body: HandoffCreate) => {
    if (busy.current) return
    busy.current = true
    setSending(true)
    setFailure(null)
    unansweredCreate.set(sourceId, body)
    setUnknown(undefined)
    try {
      const handoff = await api<Handoff>('handoffs', { method: 'POST', body, timeoutMs: 60_000 })
      unansweredCreate.set(sourceId, undefined)
      handoffs.merge(handoff)
      setShownId(handoff.id)
      setOpen(false)
      setChips([])
    } catch (error) {
      const outcome = writeFailure(error)
      if (outcome.kind === 'unknown') setUnknown(body)
      else unansweredCreate.set(sourceId, undefined)
      setFailure({
        ...outcome,
        ...(outcome.kind === 'refused' && outcome.code === 'handoff-material-changed'
          ? { chips: namedChips(chips, outcome.items).map(chip => chip.key) }
          : {}),
      })
    } finally {
      busy.current = false
      setSending(false)
    }
  }
  const submit = () => {
    if (problem || locked || offline || !canRun) return
    const pinned = materialsOf(chips)
    if ('problem' in pinned) return
    void send(createBody(newRequestId(), sourceId, form, pinned.materials))
  }
  /** Looks for the unanswered request among this session's handoffs; nothing is sent. */
  const query = async () => {
    if (!unknown) return
    try {
      const { handoffs: list } = await api<HandoffList>(`handoffs?sessionId=${encodeURIComponent(sourceId)}`)
      const found = list.find(item => item.requestId === unknown.requestId)
      if (found) {
        unansweredCreate.set(sourceId, undefined)
        setUnknown(undefined)
        setFailure(null)
        handoffs.merge(found)
        setShownId(found.id)
        setOpen(false)
        setChips([])
      } else setFailure({ kind: 'unknown', message: 'Mac 上还没有这次交接；重试同一请求不会多建一个会话。' })
    } catch (error) {
      setFailure(writeFailure(error))
    }
  }
  const repin = () => {
    const named = new Set(failure?.chips ?? [])
    const next = chips.map(chip => (named.has(chip.key) && chip.kind !== 'text' ? { ...chip, hash: undefined, problem: undefined } : chip))
    setChips(next)
    setFailure(null)
    pin(next, current.messages)
  }

  const unsettled = handoffs.handoffs.filter(
    item =>
      item.sourceSessionId === sourceId
      && (item.status === 'starting' || item.status === 'start-unknown' || item.status === 'start-failed' || item.id === shownId)
      && item.status !== 'withdrawn',
  )
  const addable = files ? sessionFiles(current.messages).filter(file => !chips.some(chip => chip.key === chipKey.file(file))) : []

  return (
    <>
      {unsettled.map(item => (
        <HandoffStatus
          key={item.id}
          handoff={item}
          shell={shell}
          offline={offline}
          onSend={send}
          sending={sending}
          onChanged={handoffs.merge}
          onReload={handoffs.reload}
          {...(item.id === shownId ? { onDismiss: () => setShownId(undefined) } : {})}
        />
      ))}
      {open && (
        <section
          ref={card}
          className="handoff-card"
          role="group"
          aria-label="交给代码任务"
          onKeyDown={event => {
            // A menu or picker inside takes its own Escape first.
            if (event.key !== 'Escape' || event.defaultPrevented || sending) return
            event.stopPropagation()
            close()
          }}>
          <header className="handoff-card-head">
            <EnterGlyph size={16} nonScalingStroke strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
            <h3>交给代码任务</h3>
            <span className="handoff-spacer" />
            <SegmentedControl<Target>
              label="交给"
              size="xs"
              value={target}
              disabled={locked}
              onValueChange={setTarget}
              options={[
                { value: 'new-session', label: '新会话' },
                { value: 'session', label: '已有会话', ...(targets.length ? {} : { disabled: true, title: '没有可以交给的会话' }) },
              ]}
            />
            <IconButton
              label="关闭"
              icon={CloseGlyph}
              size="xs"
              disabled={sending}
              onClick={() => {
                close()
              }}
            />
          </header>
          <dl className="handoff-fields">
            {target === 'new-session' ? (
              <>
                <dt>项目</dt>
                <dd>
                  <ProjectPicker
                    catalog={catalog}
                    harness={harness}
                    access={access}
                    value={choice.workspaceId}
                    disabled={locked}
                    onChange={workspaceId => {
                      setChoice(previous => ({ ...previous, workspaceId }))
                      setWorktree(false)
                    }}
                  />
                  {!canRun && <StatusWord tone="failed">只读</StatusWord>}
                </dd>
                {worktreeOffer && (
                  <>
                    <dt>位置</dt>
                    <dd>
                      <FolderControl
                        project={worktreeOffer}
                        worktree={worktree ? HEAD_START : undefined}
                        onWorktree={start => {
                          setWorktree(start !== undefined)
                        }}
                        disabled={locked}
                      />
                    </dd>
                  </>
                )}
                <dt>Harness</dt>
                <dd>
                  <DraftHarnessControl
                    catalog={catalog}
                    choice={choice}
                    access={access}
                    disabled={locked}
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
                      disabled={locked}
                      onChange={model => {
                        setChoice(previous => ({ ...previous, model: { providerId: model.providerId, model: model.model } }))
                      }}
                    />
                  )}
                </dd>
              </>
            ) : (
              <>
                <dt>会话</dt>
                <dd>
                  <ValuePicker
                    label="已有会话"
                    placeholder="选择会话"
                    value={sessionId}
                    disabled={locked}
                    width="sm"
                    menuChevron
                    options={targets.slice(0, 50).map(task => ({ value: task.id, label: messageLine(task.title || '未命名会话', 48) }))}
                    onValueChange={setSessionId}
                  />
                </dd>
              </>
            )}
            <dt>材料</dt>
            <dd className="handoff-chips">
              {chips.map(chip => (
                <Chip
                  key={chip.key}
                  chip={chip}
                  changed={failure?.chips?.includes(chip.key) === true}
                  disabled={locked}
                  onRemove={() => {
                    setChips(list => list.filter(item => item.key !== chip.key))
                  }}
                />
              ))}
              {addable.length > 0 && (
                <Menu
                  label="添加文件"
                  sections={[
                    {
                      id: 'files',
                      items: addable.slice(0, 50).map(file => ({
                        id: chipKey.file(file),
                        label: fileName(file),
                        description: file.path,
                        onSelect: () => {
                          const chip: MaterialChip = { key: chipKey.file(file), kind: 'file', file }
                          setChips(list => [...list, chip])
                          pin([chip], current.messages)
                        },
                      })),
                    },
                  ]}
                  trigger={props => <IconButton {...props} label="添加文件" icon={PlusGlyph} size="xs" disabled={locked} />}
                />
              )}
              {chips.length === 0 && addable.length === 0 && <span className="handoff-muted">没有选中的材料</span>}
            </dd>
          </dl>
          <TextAreaField
            className="handoff-requirements"
            label="要求"
            rows={3}
            value={requirements}
            disabled={locked}
            onChange={event => {
              setRequirements(event.target.value)
            }}
          />
          <Decisions decisions={decisions} disabled={locked} onChange={setDecisions} />
          <div className="handoff-scope">
            <span className="handoff-label">回传</span>
            <SegmentedControl
              label="回传范围"
              size="xs"
              value={scope}
              disabled={locked}
              onValueChange={setScope}
              options={RETURN_SCOPES.map(item => ({ value: item.value, label: item.label }))}
            />
            <Hint lead={<EnterGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} />} label={SCOPE_LINES[scope]}>
              {SCOPE_FACTS[scope]}
            </Hint>
          </div>
          {!canRun && (
            <InlineNotice tone="error" title="没有交接">
              这台设备只能查看，不能开始会话
            </InlineNotice>
          )}
          {failure?.kind === 'denied' && (
            <InlineNotice tone="error" title="没有交接">
              {failure.message}
            </InlineNotice>
          )}
          {failure?.kind === 'refused' && (
            <InlineNotice
              tone="error"
              title="没有交接"
              action={
                failure.chips?.length ? (
                  <Button size="xs" onClick={repin}>
                    用现在的版本
                  </Button>
                ) : undefined
              }>
              {failure.chips?.length
                ? `${namedChips(chips, failure.items)
                    .map(chip => `「${chipLabel(chip)}」`)
                    .join('')}在选定之后变化了`
                : failure.message}
            </InlineNotice>
          )}
          {unknown && (
            <InlineNotice tone="warn" title="交接结果未知">
              {failure?.message ?? '已发出，Mac 没有回答；重试不会多建一个会话。'}
            </InlineNotice>
          )}
          {offline && <p className="handoff-offline">Mac 不在线 · 恢复后再交</p>}
          <footer className="handoff-card-foot">
            {problem && !unknown && <span className="handoff-muted">{problem}</span>}
            <span className="handoff-spacer" />
            {unknown ? (
              <>
                <Button disabled={sending || offline} onClick={() => void send(unknown)}>
                  重试同一请求
                </Button>
                <Button variant="primary" disabled={sending || offline} onClick={() => void query()}>
                  查询
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
                  disabled={sending}
                  onClick={() => {
                    close()
                  }}>
                  取消
                </Button>
                <Button
                  variant="primary"
                  icon={EnterGlyph}
                  disabled={Boolean(problem) || offline || !canRun || sending}
                  pending={sending}
                  onClick={submit}>
                  {sending ? '正在交接…' : destination}
                </Button>
              </>
            )}
          </footer>
        </section>
      )}
    </>
  )
}

/** A chip of 材料: what it is, its pinned version while one is being fixed, and ✕. */
function Chip({ chip, changed, disabled, onRemove }: { chip: MaterialChip; changed: boolean; disabled: boolean; onRemove: () => void }) {
  const Glyph = chip.kind === 'text' ? TextQuote : chip.kind === 'message' ? MessageSquareQuote : FileGlyph
  const label = chipLabel(chip)
  const state = chip.kind === 'text' ? undefined : chip.problem ? 'failed' : chip.hash ? undefined : 'pinning'
  return (
    <span
      className="handoff-chip"
      data-state={changed ? 'changed' : state}
      title={chip.kind !== 'text' && chip.hash ? `版本 ${chip.hash.slice(0, 12)}` : undefined}>
      <Glyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
      <span className={chip.kind === 'file' ? 'handoff-chip-text is-mono' : 'handoff-chip-text'}>
        <VisibleText text={label} />
      </span>
      {changed && <span className="handoff-chip-note">已变化</span>}
      {!changed && chip.kind !== 'text' && chip.problem && <span className="handoff-chip-note">{chip.problem}</span>}
      <IconButton label={`去掉 ${label}`} icon={CloseGlyph} size="xs" disabled={disabled} onClick={onRemove} />
    </span>
  )
}

/** 决定: what is already settled, one per line; optional. */
function Decisions({ decisions, disabled, onChange }: { decisions: string[]; disabled: boolean; onChange: (next: string[]) => void }) {
  return (
    <div className="handoff-decisions">
      {decisions.map((value, index) => (
        <div className="handoff-decision" key={index}>
          <span className="handoff-decision-n">{index + 1}</span>
          <input
            className="ui-input"
            aria-label={`决定 ${index + 1}`}
            value={value}
            maxLength={1000}
            disabled={disabled}
            onChange={event => {
              onChange(decisions.map((item, at) => (at === index ? event.target.value : item)))
            }}
          />
          <IconButton
            label={`去掉决定 ${index + 1}`}
            icon={CloseGlyph}
            size="xs"
            disabled={disabled}
            onClick={() => {
              onChange(decisions.filter((_, at) => at !== index))
            }}
          />
        </div>
      ))}
      {decisions.length < 16 && (
        <Button
          size="xs"
          variant="ghost"
          icon={PlusGlyph}
          disabled={disabled}
          onClick={() => {
            onChange([...decisions, ''])
          }}>
          已定的决定
        </Button>
      )}
    </div>
  )
}

/**
 * One handoff from this session that is not settled, or was just started from this page: started with a way to the
 * target; unknown with 查询 (a read) and 重试同一请求; failed with its reason, 重试 (a new request) and 撤回.
 */
function HandoffStatus({
  handoff,
  shell,
  offline,
  sending,
  onSend,
  onChanged,
  onReload,
  onDismiss,
}: {
  handoff: Handoff
  shell: ShellState
  offline: boolean
  sending: boolean
  onSend: (body: HandoffCreate) => Promise<void>
  onChanged: (handoff: Handoff) => void
  onReload: () => Promise<void>
  onDismiss?: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<WriteFailure | null>(null)
  const withdrawId = useRef<string | undefined>(undefined)
  const target = shell.snapshot.tasks.find(task => task.id === handoff.targetSessionId)
  const words = statusWords(handoff)
  const canRun = shell.access.scopes.has('run')
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setNote(null)
    try {
      await action()
    } catch (error) {
      setNote(writeFailure(error))
    } finally {
      setBusy(false)
    }
  }
  const query = () =>
    run(async () => {
      onChanged(await api<Handoff>(`handoffs/${encodeURIComponent(handoff.id)}`))
    })
  const withdraw = () =>
    run(async () => {
      withdrawId.current ??= newRequestId()
      try {
        onChanged(
          await api<Handoff>(`handoffs/${encodeURIComponent(handoff.id)}/withdraw`, {
            method: 'POST',
            body: { requestId: withdrawId.current },
          }),
        )
        withdrawId.current = undefined
      } catch (error) {
        if (writeFailure(error).kind !== 'unknown') withdrawId.current = undefined
        await onReload()
        throw error
      }
    })
  const again = retryBody(handoff)
  const fresh = retryBody(handoff, newRequestId())
  const locked = busy || sending || offline || !canRun
  return (
    <section className="handoff-status" role="group" aria-label="交接" data-status={handoff.status}>
      <div className="handoff-status-line">
        <EnterGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
        <span className="handoff-status-title">交接</span>
        <StatusWord tone={words.tone}>{words.words}</StatusWord>
        {handoff.status === 'started' && handoff.targetSessionId && (
          <Button size="xs" variant="ghost" onClick={() => shell.choose(handoff.targetSessionId!)}>
            打开「
            <VisibleText text={target?.title || '代码会话'} />」
          </Button>
        )}
        <span className="handoff-spacer" />
        {handoff.status === 'start-unknown' && (
          <>
            {again && (
              <Button size="xs" disabled={locked} onClick={() => void onSend(again)}>
                重试同一请求
              </Button>
            )}
            <Button size="xs" variant="primary" disabled={busy || offline} onClick={() => void query()}>
              查询
            </Button>
          </>
        )}
        {handoff.status === 'start-failed' && (
          <>
            <Button size="xs" disabled={locked} onClick={() => void withdraw()}>
              撤回
            </Button>
            {fresh && (
              <Button size="xs" variant="primary" disabled={locked} onClick={() => void onSend(fresh)}>
                重试
              </Button>
            )}
          </>
        )}
        {onDismiss && handoff.status === 'started' && <IconButton label="收起" icon={CloseGlyph} size="xs" onClick={onDismiss} />}
      </div>
      {handoff.status === 'start-unknown' && (
        <p className="handoff-status-note">
          已发出，Mac 没有回答；重试不会多建一个会话{handoff.failure ? ` · ${handoff.failure.message}` : ''}
        </p>
      )}
      {handoff.status === 'start-failed' && handoff.failure && <p className="handoff-status-note is-failed">{handoff.failure.message}</p>}
      {note && <p className={note.kind === 'unknown' ? 'handoff-status-note' : 'handoff-status-note is-failed'}>{note.message}</p>}
    </section>
  )
}
