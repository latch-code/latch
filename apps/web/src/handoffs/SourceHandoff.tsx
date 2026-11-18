import { useEffect, useRef, useState } from 'react'
import { MessageSquareQuote, TextQuote } from 'lucide-react'
import { readsProjectFiles, type Handoff, type HandoffCreate, type HandoffList, type HostCatalog, type Message } from '@latch/protocol'
import {
  Button,
  Hint,
  ICON_STROKE,
  Icon,
  IconButton,
  InlineNotice,
  Modal,
  ModalHeader,
  SegmentedControl,
  StatusWord,
  TextAreaField,
  ValuePicker,
  EnterGlyph,
  FileGlyph,
  PlusGlyph,
  CloseGlyph,
  ChevronRightGlyph,
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
  replyGroup,
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
import { CONNECTION_COPY } from '../core/hostState.ts'
import { defineCopy, formatList, formatNumber, plural } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    unreadable: '读不到',
    sendNamed: (value1: string | number) => `交给「${value1}」`,
    sendExisting: '交给已有会话',
    sendProject: (value1: string | number) => `交给 ${value1}`,
    sendNew: '交给新会话',
    missing: 'Mac 上还没有这次交接；重试同一请求不会多建一个会话。',
    handoffToCode: '交给代码任务',
    send: '交给',
    newSession: '新会话',
    existingSession: '已有会话',
    noTargets: '没有可以交给的会话',
    project: '项目',
    readOnly: '只读',
    location: '位置',
    session: '会话',
    chooseSession: '选择会话',
    untitled: '未命名会话',
    materials: '材料',
    repliesCount: (count: number) => plural(count, { other: 'Agent 的回复 {n} 条' }),
    openSession: (name: string) => `打开「${name}」`,
    changedNames: (names: string[]) => names.map(name => `「${name}」`).join(''),
    removeReplies: '去掉 Agent 的回复',
    addFile: '添加文件',
    noMaterials: '没有选中的材料',
    requirements: '要求',
    returnLabel: '回传',
    returnScope: '回传范围',
    failed: '没有交接',
    viewOnly: '这台设备只能查看，不能开始会话',
    useCurrent: '用现在的版本',
    changed: (value1: string | number) => `${value1}在选定之后变化了`,
    unknown: '交接结果未知',
    unknownDetail: '已发出，Mac 没有回答；重试不会多建一个会话。',
    offline: 'Mac 不在线',
    afterReconnect: ' · 恢复后再交',
    retrySame: '重试同一请求',
    check: '查询',
    cancel: '取消',
    sending: '正在交接…',
    version: (value1: string | number) => `版本 ${value1}`,
    changedBadge: '已变化',
    removeMaterial: (value1: string | number) => `去掉 ${value1}`,
    decision: (value1: string | number) => `决定 ${value1}`,
    removeDecision: (value1: string | number) => `去掉决定 ${value1}`,
    decisions: '已定的决定',
    handoff: '交接',
    codeSession: '代码会话',
    withdraw: '撤回',
    retry: '重试',
    collapse: '收起',
    unknownCompact: '已发出，Mac 没有回答；重试不会多建一个会话',
  },
  {
    unreadable: "Couldn't read",
    sendNamed: (value1: string | number) => `Hand off to “${value1}”`,
    sendExisting: 'Hand off to existing session',
    sendProject: (value1: string | number) => `Hand off to ${value1}`,
    sendNew: 'Hand off to new session',
    missing: "The Mac has no record of this handoff. Retrying the same request won't create a duplicate session.",
    handoffToCode: 'Hand off to code session',
    send: 'Hand off',
    newSession: 'New session',
    existingSession: 'Existing session',
    noTargets: 'No sessions available for handoff',
    project: 'Project',
    readOnly: 'Read only',
    location: 'Location',
    session: 'Session',
    chooseSession: 'Choose a session',
    untitled: 'Untitled session',
    materials: 'Materials',
    repliesCount: (count: number) => plural(count, { one: '{n} Agent reply', other: '{n} Agent replies' }),
    openSession: (name: string) => `Open “${name}”`,
    changedNames: (names: string[]) => formatList(names.map(name => `“${name}”`)),
    removeReplies: 'Remove Agent replies',
    addFile: 'Add file',
    noMaterials: 'No materials selected',
    requirements: 'Requirements',
    returnLabel: 'Return',
    returnScope: 'What to return',
    failed: 'Handoff failed',
    viewOnly: 'This device can view sessions only.',
    useCurrent: 'Use current versions',
    changed: (value1: string | number) => `${value1} changed after selection`,
    unknown: 'Handoff outcome unknown',
    unknownDetail: "The Mac hasn't responded. Retrying won't create a duplicate session.",
    offline: 'Mac offline',
    afterReconnect: ' · Try again when connected',
    retrySame: 'Retry same request',
    check: 'Check status',
    cancel: 'Cancel',
    sending: 'Handing off…',
    version: (value1: string | number) => `Version ${value1}`,
    changedBadge: 'Changed',
    removeMaterial: (value1: string | number) => `Remove ${value1}`,
    decision: (value1: string | number) => `Decision ${value1}`,
    removeDecision: (value1: string | number) => `Remove decision ${value1}`,
    decisions: 'Decisions made',
    handoff: 'Handoff',
    codeSession: 'Code session',
    withdraw: 'Withdraw',
    retry: 'Retry',
    collapse: 'Show less',
    unknownCompact: "The Mac hasn't responded. Retrying won't create a duplicate session",
  },
)

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
  const [repliesOpen, setRepliesOpen] = useState(false)
  const busy = useRef(false)
  /** The messages the card was opened from: closing it puts the keys back on their action. */
  const from = useRef<string[]>([])
  const pins = useRef(new AbortController())
  useEffect(() => () => pins.current.abort(), [])

  /** Pins each new chip to its version: a message by its text, a file by its bytes. */
  const pin = (next: MaterialChip[], messages: readonly Message[]) => {
    if (!sourceId) return
    const signal = pins.current.signal
    for (const chip of next) {
      if (chip.kind === 'text' || chip.hash) continue
      const settle = (patch: { hash?: string; problem?: () => string }) => {
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
        (cause: unknown) => settle({ problem: () => (cause instanceof Error ? cause.message : COPY.unreadable) }),
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
      setRepliesOpen(false)
    }
    setOpen(true)
    from.current = request.messageIds
    // The keys go to 要求, the one field every handoff reads; a phone sheet settles its own focus first.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.handoff-dialog textarea')?.focus({ preventScroll: true })),
    )
    onTaken()
    // Only a new request opens or adds; the rest is read at that moment.
  }, [request?.nonce])

  if (!current || !catalog?.features?.handoffs || !sourceId) return null
  const close = () => {
    setOpen(false)
    const id = from.current[0]
    const row = id ? document.querySelector(`.transcript [data-message-id="${CSS.escape(id)}"]`) : null
    const action =
      row?.querySelector<HTMLElement>('[data-handoff-action]') ?? row?.closest('.turn')?.querySelector<HTMLElement>('[data-turn-actions]')
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
        ? COPY.sendNamed(messageLine(chosenSession.title || COPY.untitled, 12))
        : COPY.sendExisting
      : project
        ? COPY.sendProject(project.name || basename(project.path))
        : COPY.sendNew

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
        get message() {
          return outcome.message
        },
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
      } else
        setFailure({
          kind: 'unknown',
          get message() {
            return COPY.missing
          },
        })
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
  const replies = replyGroup(chips, failure?.chips)
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
        <Modal
          label={COPY.handoffToCode}
          variant={shell.phone ? 'sheet' : 'dialog'}
          size="lg"
          dismissible={!sending}
          onClose={close}
          className="handoff-dialog">
          <ModalHeader
            title={COPY.handoffToCode}
            {...(shell.phone
              ? {}
              : { leading: <EnterGlyph size={16} nonScalingStroke strokeWidth={ICON_STROKE[16]} aria-hidden="true" /> })}
            actions={
              <SegmentedControl<Target>
                label={COPY.send}
                size="xs"
                value={target}
                disabled={locked}
                onValueChange={setTarget}
                options={[
                  { value: 'new-session', label: COPY.newSession },
                  { value: 'session', label: COPY.existingSession, ...(targets.length ? {} : { disabled: true, title: COPY.noTargets }) },
                ]}
              />
            }
            {...(sending ? {} : { onClose: close })}
          />
          <div className="ui-modal-body handoff-body">
            <dl className="handoff-fields">
              {target === 'new-session' ? (
                <>
                  <dt>{COPY.project}</dt>
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
                    {!canRun && <StatusWord tone="failed">{COPY.readOnly}</StatusWord>}
                  </dd>
                  {worktreeOffer && (
                    <>
                      <dt>{COPY.location}</dt>
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
                  <dt>{COPY.session}</dt>
                  <dd>
                    <ValuePicker
                      label={COPY.existingSession}
                      placeholder={COPY.chooseSession}
                      value={sessionId}
                      disabled={locked}
                      width="sm"
                      menuChevron
                      options={targets.slice(0, 50).map(task => ({ value: task.id, label: messageLine(task.title || COPY.untitled, 48) }))}
                      onValueChange={setSessionId}
                    />
                  </dd>
                </>
              )}
              <dt>{COPY.materials}</dt>
              <dd className="handoff-chips">
                {chips.map(chip => {
                  const single = (
                    <Chip
                      key={chip.key}
                      chip={chip}
                      changed={failure?.chips?.includes(chip.key) === true}
                      disabled={locked}
                      onRemove={() => {
                        setChips(list => list.filter(item => item.key !== chip.key))
                      }}
                    />
                  )
                  if (!replies?.keys.has(chip.key)) return single
                  if (chips.find(item => replies.keys.has(item.key)) !== chip) return null
                  const expanded = repliesOpen || replies.open
                  return (
                    <div key="replies" className="handoff-replies">
                      <span className="handoff-chip" data-state={replies.pinning ? 'pinning' : undefined}>
                        <button
                          type="button"
                          className="handoff-replies-toggle"
                          aria-expanded={expanded}
                          disabled={replies.open}
                          onClick={() => setRepliesOpen(!repliesOpen)}>
                          <MessageSquareQuote size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
                          <span className="handoff-chip-text">{COPY.repliesCount(replies.keys.size)}</span>
                          <Icon icon={ChevronRightGlyph} size={12} />
                        </button>
                        <IconButton
                          label={COPY.removeReplies}
                          icon={CloseGlyph}
                          size="xs"
                          disabled={locked}
                          onClick={() => {
                            setChips(list => list.filter(item => !replies.keys.has(item.key)))
                          }}
                        />
                      </span>
                      {expanded && (
                        <div className="handoff-replies-list">
                          {chips
                            .filter(item => replies.keys.has(item.key))
                            .map(item => (
                              <Chip
                                key={item.key}
                                chip={item}
                                changed={failure?.chips?.includes(item.key) === true}
                                disabled={locked}
                                onRemove={() => {
                                  setChips(list => list.filter(entry => entry.key !== item.key))
                                }}
                              />
                            ))}
                        </div>
                      )}
                    </div>
                  )
                })}
                {addable.length > 0 && (
                  <Menu
                    label={COPY.addFile}
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
                    trigger={props => <IconButton {...props} label={COPY.addFile} icon={PlusGlyph} size="xs" disabled={locked} />}
                  />
                )}
                {chips.length === 0 && addable.length === 0 && <span className="handoff-muted">{COPY.noMaterials}</span>}
              </dd>
            </dl>
            <TextAreaField
              className="handoff-requirements"
              label={COPY.requirements}
              rows={3}
              data-autofocus=""
              value={requirements}
              disabled={locked}
              onChange={event => {
                setRequirements(event.target.value)
              }}
            />
            <Decisions decisions={decisions} disabled={locked} onChange={setDecisions} />
            <div className="handoff-scope">
              <span className="handoff-label">{COPY.returnLabel}</span>
              <SegmentedControl
                label={COPY.returnScope}
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
              <InlineNotice tone="error" title={COPY.failed}>
                {COPY.viewOnly}
              </InlineNotice>
            )}
            {failure?.kind === 'denied' && (
              <InlineNotice tone="error" title={COPY.failed}>
                {failure.message}
              </InlineNotice>
            )}
            {failure?.kind === 'refused' && (
              <InlineNotice
                tone="error"
                title={COPY.failed}
                action={
                  failure.chips?.length ? (
                    <Button size="xs" onClick={repin}>
                      {COPY.useCurrent}
                    </Button>
                  ) : undefined
                }>
                {failure.chips?.length ? COPY.changed(COPY.changedNames(namedChips(chips, failure.items).map(chipLabel))) : failure.message}
              </InlineNotice>
            )}
            {unknown && (
              <InlineNotice tone="warn" title={COPY.unknown}>
                {failure?.message ?? COPY.unknownDetail}
              </InlineNotice>
            )}
            {offline && (
              <p className="handoff-offline">
                {connection === 'offline' ? CONNECTION_COPY.offline : COPY.offline}
                {COPY.afterReconnect}
              </p>
            )}
          </div>
          <footer className="ui-modal-footer handoff-foot">
            {problem && !unknown && <span className="handoff-muted">{problem}</span>}
            <span className="handoff-spacer" />
            {unknown ? (
              <>
                <Button disabled={sending || offline} onClick={() => void send(unknown)}>
                  {COPY.retrySame}
                </Button>
                <Button variant="primary" disabled={sending || offline} onClick={() => void query()}>
                  {COPY.check}
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
                  {COPY.cancel}
                </Button>
                <Button
                  variant="primary"
                  icon={EnterGlyph}
                  disabled={Boolean(problem) || offline || !canRun || sending}
                  pending={sending}
                  onClick={submit}>
                  {sending ? COPY.sending : destination}
                </Button>
              </>
            )}
          </footer>
        </Modal>
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
      title={chip.kind !== 'text' && chip.hash ? COPY.version(chip.hash.slice(0, 12)) : undefined}>
      <Glyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
      <span className={chip.kind === 'file' ? 'handoff-chip-text is-mono' : 'handoff-chip-text'}>
        <VisibleText text={label} />
      </span>
      {changed && <span className="handoff-chip-note">{COPY.changedBadge}</span>}
      {!changed && chip.kind !== 'text' && chip.problem && (
        <span className="handoff-chip-note">{typeof chip.problem === 'function' ? chip.problem() : chip.problem}</span>
      )}
      <IconButton label={COPY.removeMaterial(label)} icon={CloseGlyph} size="xs" disabled={disabled} onClick={onRemove} />
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
            aria-label={COPY.decision(formatNumber(index + 1))}
            value={value}
            maxLength={1000}
            disabled={disabled}
            onChange={event => {
              onChange(decisions.map((item, at) => (at === index ? event.target.value : item)))
            }}
          />
          <IconButton
            label={COPY.removeDecision(formatNumber(index + 1))}
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
          {COPY.decisions}
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
    <section className="handoff-status" role="group" aria-label={COPY.handoff} data-status={handoff.status}>
      <div className="handoff-status-line">
        <EnterGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
        <span className="handoff-status-title">{COPY.handoff}</span>
        <StatusWord tone={words.tone}>{words.words}</StatusWord>
        {handoff.status === 'started' && handoff.targetSessionId && (
          <Button size="xs" variant="ghost" onClick={() => shell.choose(handoff.targetSessionId!)}>
            <VisibleText text={COPY.openSession(target?.title || COPY.codeSession)} />
          </Button>
        )}
        <span className="handoff-spacer" />
        {handoff.status === 'start-unknown' && (
          <>
            {again && (
              <Button size="xs" disabled={locked} onClick={() => void onSend(again)}>
                {COPY.retrySame}
              </Button>
            )}
            <Button size="xs" variant="primary" disabled={busy || offline} onClick={() => void query()}>
              {COPY.check}
            </Button>
          </>
        )}
        {handoff.status === 'start-failed' && (
          <>
            <Button size="xs" disabled={locked} onClick={() => void withdraw()}>
              {COPY.withdraw}
            </Button>
            {fresh && (
              <Button size="xs" variant="primary" disabled={locked} onClick={() => void onSend(fresh)}>
                {COPY.retry}
              </Button>
            )}
          </>
        )}
        {onDismiss && handoff.status === 'started' && <IconButton label={COPY.collapse} icon={CloseGlyph} size="xs" onClick={onDismiss} />}
      </div>
      {handoff.status === 'start-unknown' && (
        <p className="handoff-status-note">
          {COPY.unknownCompact}
          {handoff.failure ? ` · ${handoff.failure.message}` : ''}
        </p>
      )}
      {handoff.status === 'start-failed' && handoff.failure && <p className="handoff-status-note is-failed">{handoff.failure.message}</p>}
      {note && <p className={note.kind === 'unknown' ? 'handoff-status-note' : 'handoff-status-note is-failed'}>{note.message}</p>}
    </section>
  )
}
