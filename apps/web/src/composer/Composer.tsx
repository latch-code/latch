import { defineCopy, plural } from '../core/i18n.ts'
import { useFileMentions, type FileMentionChoice } from '../hooks/useFileMentions.tsx'
import type { AttachmentDraftController } from '../hooks/useAttachments.ts'
import type { MenuSection } from '../components/overlays.tsx'
import { AttachmentButton, AttachmentDrafts, pasteAttachments, dropAttachments } from './AttachmentDrafts.tsx'
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { CornerDownRight, ListPlus, Slash } from 'lucide-react'
import { escapeSecurityText, type PromptTemplate, type SessionCommand, type SessionSkill } from '@latch/protocol'
import type { PendingSubmission } from '../core/api.ts'
import type { SendKey } from '../preferences.ts'
import { escapeIsLeftover } from '../escapeGrace.ts'
import { SlashCommands, useSlashCommands, type SlashAction } from './SlashCommands.tsx'
import { latchActionOf } from './latchActions.ts'
import { deleteText, PromptMirrorText, usePromptMarks } from './PromptMarks.tsx'
import {
  Button,
  IconButton,
  Collapse,
  EASING,
  ICON_STROKE,
  Hint,
  InlineNotice,
  MOTION,
  Spinner,
  Swap,
  Tooltip,
  useLiveChange,
  LockGlyph,
  SendGlyph,
  DrawerStack,
} from '@latch/ui'

const COPY = defineCopy(
  {
    actionUnavailable: '这个动作在当前页面不可用',
    waitForSubmit: '等待这次提交完成',
    writeFirst: '输入内容后发送',
    sendAfterTurn: '本轮完成后发送',
    insertCommand: '插入命令',
    cancelSend: '取消发送',
    steerHint: '加到正在运行的这一轮',
    steerLabel: '追加到本轮',
    steer: '追加',
    queue: '排队',
    queueSend: '排队发送',
    runAction: '运行动作',
    send: '发送',
    otherPending: '另一个会话有消息未确认送达',
    pending: '未确认送达',
    noAnswer: '没有收到电脑的答复',
    unknownStart:
      '重试沿用同一请求，电脑已经收到的不会再开一个会话。放弃这次提交只在这台设备上放下它，文字回到输入框；电脑如果其实已经收到，那个会话会出现在列表里，再发送会开始另一个会话，可能另建一个工作树。',
    unknownMessage:
      '重试沿用同一请求，电脑已经收到的不会再算一次。放弃这次提交只在这台设备上放下它，文字回到输入框，附件和文件引用要重新添加；电脑如果其实已经收到，它会出现在会话里，再发送就是第二条消息。',
    open: '打开',
    retrySubmission: '重试这次提交',
    checking: '核对中…',
    discardSubmission: '放弃这次提交',
    stopping: '正在停止…',
    stop: '停止',
    unknown: '结果未知',
    check: '核对',
    retryRequest: '重试同一请求',
    discardResult: '放弃这次结果',
    unconfirmed: '尚未确认',
    retry: '重试',
    attachments: (count: number) => `${count} 个附件`,
    checkDetails: (harness: string) =>
      `核对会先结束这个会话的 ${harness} 进程，再让它重新打开会话、报告现在的设置；不会再发送一次修改。会话运行中、等你处理或子 Agent 可能还在运行时不核对。`,
  },
  {
    actionUnavailable: 'This action is unavailable here',
    waitForSubmit: 'Wait for this submission',
    writeFirst: 'Enter a message to send',
    sendAfterTurn: 'Send after this turn',
    insertCommand: 'Insert command',
    cancelSend: 'Cancel send',
    steerHint: 'Add to the running turn',
    steerLabel: 'Add to this turn',
    steer: 'Add',
    queue: 'Queue',
    queueSend: 'Queue message',
    runAction: 'Run action',
    send: 'Send',
    otherPending: 'Another session has an unconfirmed message',
    pending: 'Delivery unconfirmed',
    noAnswer: 'No response from the computer',
    unknownStart:
      'Retry uses the same request. If the computer already received it, there will be only one session. Discarding returns the text to this device’s input. If the request already arrived, the original session will appear in the list. Sending again starts a separate session and may create another worktree.',
    unknownMessage:
      'Retry uses the same request. If the computer already received it, there will be only one message. Discarding returns the text to this device’s input. Add any attachments and file references again. If the original message appears in the session, sending again creates a second message.',
    open: 'Open',
    retrySubmission: 'Retry submission',
    checking: 'Checking…',
    discardSubmission: 'Discard submission',
    stopping: 'Stopping…',
    stop: 'Stop',
    unknown: 'Outcome unknown',
    check: 'Check',
    retryRequest: 'Retry same request',
    discardResult: 'Discard outcome',
    unconfirmed: 'Unconfirmed',
    retry: 'Retry',
    attachments: (count: number) => plural(count, { one: '{n} attachment', other: '{n} attachments' }),
    checkDetails: (harness: string) =>
      `Check restarts ${harness} for this session to read its current settings. It will not resend the change. Wait until the session and its sub-agents are idle.`,
  },
)

/**
 * What a running session's input needs to know. What the run is doing and for how long is said in the conversation (the
 * latest turn's status line), so the input has no running label.
 */
export interface RunState {
  id?: string
  cancel: 'idle' | 'cancelling' | 'uncertain'
  onCancel: () => void
}

/**
 * A session config change whose outcome is unknown, said in the bar on top of the input: what was asked for, when,
 * 结果未知, 核对 and 重试同一请求. Neither sends the change again on its own.
 */
export interface ConfigUnknownState {
  /** 「模型 opencode/Beam Free」 */
  what: string
  /** Whose process 核对 restarts. */
  harness: string
  at: number
  checking: boolean
  onCheck: () => void
  onRetry: () => void
  /** Only after 核对 could not settle it. */
  onAbandon?: () => void
}

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
/** Eight lines of body text plus padding; the transcript keeps the remaining height. */
const MAX_TEXTAREA = 232

function sizeComposerInput(element: HTMLTextAreaElement | null) {
  if (!element?.clientWidth) return
  const from = element.style.height
  element.style.transition = 'none'
  element.style.height = 'auto'
  const border = element.offsetHeight - element.clientHeight
  const next = `${Math.min(element.scrollHeight + border, MAX_TEXTAREA)}px`
  element.style.height = from
  if (from && from !== next) element.getBoundingClientRect()
  element.style.removeProperty('transition')
  element.style.height = next
}

/**
 * The message input, on the new-session page and docked under a conversation, with its drawers joined above the card
 * and the status line as its last row. It starts one line high. The input stays editable while a run is active so the next message can be drafted; a Host that supports queues
 * accepts the next input for later. Its ring turns line-strong with focus inside, never blue. The send slot is a neutral
 * ink key, never blue: an arrow (a soft fill while there is nothing to send, still focusable with its reason as its
 * tooltip), 追加 while a run that takes more text is active and there is text, 排队 while another run is, or the stop
 * circle, which is never red and steps back while an
 * approval waits. A device that may only watch sees a dashed, sunken frame with a lock and the reason instead of the
 * input; the drawers and the stop button stay.
 */
export function Composer({
  textareaRef,
  commands,
  skills,
  skillsTruncated,
  commandSource,
  historyScope,
  onCreateTemplate,
  templates,
  actions,
  showSlashButton = true,
  variant,
  label,
  placeholder,
  draft,
  onDraft,
  pending,
  pendingInTranscript = false,
  onOpenPending,
  sending,
  error,
  errorActions,
  pendingReason,
  onRetry,
  onAbandon,
  abandoning = false,
  abandonHeld,
  pendingNote,
  canSend,
  blockReason,
  onSubmit,
  sendKey,
  coarse,
  controls,
  trailing,
  run,
  configUnknown,
  readOnly,
  readOnlyReason,
  answer,
  meta,
  usage,
  drawers,
  stepBack = false,
  below,
  vitals,
  vitalsLead,
  status,
  inline = false,
  confirmation,
  over,
  queueable = false,
  steerable = false,
  queueTray,
  attachments,
  attachmentMenu,
  fileMentions,
  lastPrompt,
}: {
  queueable?: boolean
  /** The running turn takes more text: what is written goes into it, and the slot says 追加 instead of 排队. */
  steerable?: boolean
  queueTray?: ReactNode
  fileMentions?: FileMentionChoice
  lastPrompt?: string
  attachments?: AttachmentDraftController
  /** Related actions share the attachment button's menu, so a personal topic has one ＋. */
  attachmentMenu?: MenuSection[]
  templates?: PromptTemplate[]
  commands?: SessionCommand[]
  skills?: SessionSkill[]
  skillsTruncated?: boolean
  commandSource?: { name: string; media?: ReactNode; firstTurn?: boolean; previousSession?: boolean; awaitingSession?: boolean }
  historyScope?: { deviceId: string; harnessId?: string }
  onCreateTemplate?: () => void
  /** What Latch itself does from the slash menu in this session. */
  actions?: SlashAction[]
  /** The optional insertion shortcut; typing slash commands uses the same sender either way. */
  showSlashButton?: boolean
  textareaRef: RefObject<HTMLTextAreaElement | null>
  variant: 'new' | 'session'
  label: string
  placeholder: string
  draft: string
  onDraft: (value: string) => void
  pending: PendingSubmission | null
  /** The new-session transcript already shows this submission. Keep the retry actions below it. */
  pendingInTranscript?: boolean
  /** The pending submission belongs to another session or to 新会话: this input is held for it, and this opens it. */
  onOpenPending?: () => void
  sending: boolean
  error: string
  /** The refusal's own next steps (换个模型, 打开设置 › Harness, 重试…), beside the reason. */
  errorActions?: ReadonlyArray<{ label: string; run: () => void }>
  /** Why the pending submission is still unconfirmed after the last try, in the short wording of an inline error. */
  pendingReason?: string
  onRetry: () => void
  /** 放弃这次提交: this device stops waiting for it; its text becomes a draft again. */
  onAbandon?: () => void
  /** The session is read before the submission is let go. */
  abandoning?: boolean
  /** Why 放弃这次提交 is not offered now: another window of this device is retrying it. */
  abandonHeld?: string
  /** What else the session holds with the same text (a queue item, perhaps another device's); 放弃 stays. */
  pendingNote?: string
  canSend: boolean
  blockReason?: string
  onSubmit: () => void
  sendKey: SendKey
  coarse: boolean
  /**
   * The line under the text, after 「+」 and the slash button: the Harness, and the one entry (模型 · 思考 · 权限), which
   * the toolbar draws at the line's end beside send.
   */
  controls: ReactNode
  /** The trailing controls, such as a phone's 「⋯」. */
  trailing?: ReactNode
  run?: RunState
  configUnknown?: ConfigUnknownState
  /** This device may watch, reject and cancel but not type: the text replaces the input. */
  readOnly?: string
  /** Why it only reads, behind the label's Hint. */
  readOnlyReason?: string
  /**
   * The input answers what a drawer waits on, so what is written goes there and not to the queue. `reject`: an approval;
   * the slot stays the stop circle, and Enter sends only with text. `question`: with text the slot is send; with none it
   * stays the stop circle, since nothing else stops a run that waits on a question.
   */
  answer?: { kind: 'reject' | 'question'; onSubmit: () => void }
  /** The footer's right side, before send: 「⋯」. */
  meta?: ReactNode
  /**
   * The limit of what runs it (a Harness's window, a service's budget), last before the entry and send. On a phone it
   * stands at the end of the line under the input, so it is always in sight and never moves a control of the input.
   */
  usage?: ReactNode
  /** Attached above the card: the approval, question, queue and notice drawers. */
  drawers?: ReactNode
  /** The stop circle gives way to what a drawer asks. */
  stepBack?: boolean
  /** Under the input, outside its frame: the captions of a new session. */
  below?: ReactNode
  /** The last line, under everything: what an open session has done and used (`VitalsStrip`). */
  vitals?: ReactNode
  /** At the start of that last line, the vitals at its end (its own row without them): an open session's own entry (the Codex team). */
  vitalsLead?: ReactNode
  /** The frame's last row: where a new session will work and which way its model goes (`ComposerStatus`). */
  status?: ReactNode
  /** A phone: the same line with touch-sized targets and no slash button; a long model name gives way first. */
  inline?: boolean
  /** Shown above the input. */
  confirmation?: ReactNode
  /** Over the drawers and the input, in reading order before them: a phone's place of a new session. */
  over?: ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const commandAnchor = useRef<HTMLFormElement>(null)
  const [slashCaret, setSlashCaret] = useState<{ draft: string; at: number }>()
  const [slashSendRevision, refreshSlashSend] = useState(0)
  const slashToSend = useRef<string | undefined>(undefined)
  const slashSelection = useRef<{ draft: string; start: number; end: number } | undefined>(undefined)
  const commandMirror = useRef<HTMLDivElement>(null)
  const commandHead = /^([/／][^\s/／]+)([ \t]+)([\s\S]*)$/u.exec(draft)
  const commandName = commandHead?.[1]?.slice(1)
  const commandDefinition = actions?.find(action => action.name === commandName) ?? commands?.find(command => command.name === commandName)
  const commandChip = commandHead && commandDefinition ? commandHead[1]! : undefined
  const argumentHint = commandChip && !commandHead?.[3]?.trim() ? commandDefinition?.inputHint : undefined
  const mentions = useFileMentions(draft, onDraft, textareaRef, fileMentions, commandAnchor)
  const marks = usePromptMarks({ draft, catalogue: { commands, skills, actions }, textareaRef, mirrorRef: commandMirror })
  // The input grows with its content a line at a time, up to eight lines, its height moving over 120ms (composer.css).
  // Measuring needs the height let go for a moment; it is put back without a transition, so the move then starts from
  // the height the input had and not from the measurement.
  // A phone lays the input out in another row (`inline`), which is another element: crossing that width with words in
  // the input must measure the new element and watch it, or it stays one line high whatever it holds.
  useLayoutEffect(() => {
    sizeComposerInput(textareaRef.current)
  }, [draft, textareaRef, inline])
  useLayoutEffect(() => {
    const element = textareaRef.current
    if (!element) return undefined
    let width = -1
    let alive = true
    const measure = () => {
      if (alive) sizeComposerInput(element)
    }
    const observer = new ResizeObserver(entries => {
      const next = entries[0]?.contentRect.width
      // Height changes are our own output; observing those would create a resize feedback loop.
      if (next !== undefined && next !== width) {
        width = next
        measure()
      }
    })
    observer.observe(element)
    void document.fonts.ready.then(measure)
    document.fonts.addEventListener('loadingdone', measure)
    return () => {
      alive = false
      observer.disconnect()
      document.fonts.removeEventListener('loadingdone', measure)
    }
  }, [textareaRef, readOnly, inline])

  const locked = sending || pending !== null || attachments?.preparing === true
  // One unconfirmed write per device: nothing else is sent meanwhile, but only the input that holds its text is held.
  const textLocked = sending || (pending !== null && onOpenPending === undefined) || attachments?.preparing === true
  const empty = draft.trim().length === 0 && !attachments?.items.length
  const typedAction = answer === undefined ? latchActionOf(draft) : undefined
  const queueDraft =
    !!run
    && (queueable || steerable)
    && !empty
    && !attachments?.items.length
    && !fileMentions?.refs.length
    && answer === undefined
    && typedAction === undefined
    && readOnly === undefined
  const localAction = typedAction && actions?.find(action => action.name === typedAction.name)
  const actionBlock = typedAction ? (localAction?.unavailable ?? (!localAction?.run ? COPY.actionUnavailable : undefined)) : undefined
  const sendable =
    !locked
    && readOnly === undefined
    && (answer !== undefined ? !empty : typedAction ? !actionBlock : canSend && !empty && (!run || queueDraft))
  const submit = () => {
    if (answer) answer.onSubmit()
    else if (typedAction) {
      if (!actionBlock) localAction?.run?.(typedAction.argument)
    } else onSubmit()
  }
  useLayoutEffect(() => {
    const selection = slashSelection.current
    const input = textareaRef.current
    slashSelection.current = undefined
    if (selection && selection.draft === draft && input) {
      input.setSelectionRange(selection.start, selection.end)
      setSlashCaret({ draft, at: selection.end })
    }
    const command = slashToSend.current
    if (command === undefined) return
    // Consume before invoking the existing sender, including Strict Mode's repeated layout effects.
    slashToSend.current = undefined
    if (
      draft === command
      && sendable
      && !run
      && !answer
      && input?.getClientRects().length
      && !input.closest('[inert], [hidden], [aria-hidden="true"]')
    )
      submit()
  }, [draft, sendable, submit, textareaRef, slashSendRevision, run, answer])
  const escapeAt = useRef({ at: 0, run: run?.id })
  const slash = useSlashCommands({
    draft,
    caret: slashCaret?.draft === draft ? slashCaret.at : draft.length,
    commands,
    skills,
    skillsTruncated,
    templates,
    harnessName: commandSource?.name,
    harnessMedia: commandSource?.media,
    running: !!run,
    firstTurn: commandSource?.firstTurn,
    session: commands !== undefined && !commandSource?.previousSession,
    previousSession: commandSource?.previousSession,
    awaitingSession: commandSource?.awaitingSession,
    ...(historyScope ? { historyScope } : {}),
    ...(actions ? { actions } : {}),
    enabled: !locked && readOnly === undefined && answer === undefined,
    onDraft: (value, selection) => {
      slashSelection.current = selection ? { draft: value, ...selection } : undefined
      onDraft(value)
      textareaRef.current?.focus({ preventScroll: true })
    },
    onCommand: value => {
      if (answer || locked || readOnly !== undefined || !canSend || run) return
      slashToSend.current = value
      onDraft(value)
      refreshSlashSend(revision => revision + 1)
    },
  })
  const keydown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slash.keydown(event)) return
    // Hidden while a submission is held: its keys are the input's again.
    if (!locked && readOnly === undefined && mentions.keydown(event)) return
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (
      event.key === 'Backspace'
      && commandChip
      && event.currentTarget.selectionStart === event.currentTarget.selectionEnd
      && [commandChip.length, commandChip.length + 1].includes(event.currentTarget.selectionStart)
    ) {
      event.preventDefault()
      deleteText(event.currentTarget, 0, commandChip.length + (commandHead?.[2]?.length ?? 0))
      return
    }
    if (marks.keydown(event)) return
    if (event.key === 'Escape' && escapeIsLeftover(event)) return
    // Esc belongs to the approval drawer while one waits (it refuses once), or to the text just written.
    if (event.key === 'Escape' && answer?.kind === 'reject') return
    if (event.key === 'Escape' && run?.cancel === 'idle') {
      const now = performance.now()
      if (escapeAt.current.at && escapeAt.current.run === run.id && now - escapeAt.current.at <= 500) {
        event.preventDefault()
        run.onCancel()
        escapeAt.current = { at: 0, run: run.id }
      } else escapeAt.current = { at: now, run: run.id }
      return
    }
    escapeAt.current.at = 0
    if (
      event.key === 'ArrowUp'
      && !draft
      && lastPrompt
      && !locked
      && readOnly === undefined
      && !event.altKey
      && !event.ctrlKey
      && !event.metaKey
      && !event.shiftKey
    ) {
      event.preventDefault()
      onDraft(lastPrompt)
      return
    }
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return
    const explicit = event.metaKey || event.ctrlKey
    if (!explicit && (event.shiftKey || event.altKey || coarse || sendKey !== 'enter')) return
    event.preventDefault()
    if (sendable) submit()
  }
  const shortcut = sendKey === 'enter' && !coarse ? 'Enter' : `${isMac() ? '⌘' : 'Ctrl'} Enter`
  const sendTip =
    actionBlock
    ?? blockReason
    ?? (locked ? COPY.waitForSubmit : empty ? COPY.writeFirst : queueDraft && !steerable ? COPY.sendAfterTurn : undefined)

  // The slot's control swaps in (from 90%, fading in) when the page sees it change: a run starting or ending.
  const answering = answer?.kind === 'question' && !empty
  const choosing = typedAction !== undefined
  const slot =
    answering || choosing ? 'send' : run && !queueDraft ? 'stop' : queueDraft ? 'queue' : readOnly !== undefined ? 'none' : 'send'
  useLiveChange(slot, (_previous, live) => {
    const element = box.current?.querySelector<HTMLElement>('.composer-slot > *')
    if (live && element)
      element.animate(
        [
          { opacity: 0, transform: 'scale(0.9)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: MOTION.micro, easing: EASING.micro },
      )
  })

  const textarea = (
    <textarea
      ref={textareaRef}
      aria-label={label}
      aria-autocomplete={slash.open || mentions.open ? 'list' : undefined}
      aria-controls={slash.open ? slash.id : mentions.open ? mentions.listId : undefined}
      aria-activedescendant={
        slash.open && slash.options[slash.active] ? slash.id + '-' + slash.active : !slash.open ? mentions.activeId : undefined
      }
      placeholder={placeholder}
      value={draft}
      rows={1}
      disabled={textLocked}
      onChange={event => {
        mentions.setCaret(event.target.selectionStart)
        setSlashCaret({ draft: event.target.value, at: event.target.selectionStart })
        onDraft(event.target.value)
      }}
      onKeyDown={keydown}
      {...marks.inputProps}
      onSelect={event => {
        mentions.setCaret(event.currentTarget.selectionStart)
        setSlashCaret({ draft: event.currentTarget.value, at: event.currentTarget.selectionStart })
      }}
      onScroll={event => {
        if (commandMirror.current) commandMirror.current.scrollTop = event.currentTarget.scrollTop
      }}
      onPaste={attachments ? event => pasteAttachments(event, attachments) : undefined}
    />
  )
  // The prompt glyph says where to tell it what to do; the phone's sheet is a page of its own and has none.
  const input =
    readOnly !== undefined ? (
      readOnlyReason ? (
        <div className="composer-readonly" role="note" data-lock="">
          <Hint inline lead={<LockGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} />} label={readOnly}>
            {readOnlyReason}
          </Hint>
        </div>
      ) : (
        <p className="composer-readonly" role="note" data-lock="">
          <LockGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
          <span>{readOnly}</span>
        </p>
      )
    ) : (
      <div className="composer-input" data-marks={marks.shown ? '' : undefined}>
        {(commandChip || marks.shown) && (
          <div ref={commandMirror} className="composer-command-mirror" aria-hidden="true">
            {marks.shown ? (
              <PromptMirrorText
                text={draft}
                marks={marks.marks}
                hint={argumentHint ? <span className="composer-command-hint">{escapeSecurityText(argumentHint)}</span> : undefined}
              />
            ) : (
              <>
                <span className="composer-command-chip">{commandChip}</span>
                {draft.slice(commandChip!.length)}
                {argumentHint && <span className="composer-command-hint">{escapeSecurityText(argumentHint)}</span>}
              </>
            )}
          </div>
        )}
        {textarea}
      </div>
    )
  const slashButton = showSlashButton && readOnly === undefined && (
    <IconButton
      className="composer-slash-button"
      label={COPY.insertCommand}
      icon={Slash}
      disabled={locked || answer !== undefined}
      onClick={() => {
        const input = textareaRef.current
        const start = input?.selectionStart ?? draft.length
        const end = input?.selectionEnd ?? start
        const before = draft.slice(0, start)
        const insert = before && !/\s$/u.test(before) ? ' /' : '/'
        const value = before + insert + draft.slice(end)
        slashSelection.current = { draft: value, start: start + insert.length, end: start + insert.length }
        slash.reopen()
        onDraft(value)
        input?.focus({ preventScroll: true })
      }}
    />
  )
  const action = (
    <div className="composer-slot" data-queue-draft={queueDraft ? '' : undefined}>
      {/* Touch has no Esc: stop stays beside 排队 and an answer's send there. */}
      {(queueDraft || answering || choosing) && run && coarse && <StopButton run={run} stepBack={stepBack} />}
      {attachments?.preparing ? (
        <Button size="sm" onClick={attachments.cancel}>
          <Spinner size={14} />
          {COPY.cancelSend}
        </Button>
      ) : run && !queueDraft && !answering && !choosing ? (
        <StopButton run={run} stepBack={stepBack} />
      ) : queueDraft && steerable ? (
        <Tooltip content={sendTip ?? COPY.steerHint} shortcut={sendTip === undefined ? shortcut : undefined}>
          <button
            type="submit"
            className="send-button queue-button"
            aria-label={COPY.steerLabel}
            aria-disabled={!sendable || undefined}
            onClick={event => {
              if (!sendable) event.preventDefault()
            }}>
            <CornerDownRight size={16} nonScalingStroke strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
            {COPY.steer}
          </button>
        </Tooltip>
      ) : queueDraft ? (
        <Tooltip content={sendTip ?? COPY.queue} shortcut={sendTip === undefined ? shortcut : undefined} describe={sendTip !== undefined}>
          <button
            type="submit"
            className="send-button queue-button"
            aria-label={COPY.queueSend}
            aria-disabled={!sendable || undefined}
            onClick={event => {
              if (!sendable) event.preventDefault()
            }}>
            <ListPlus size={16} nonScalingStroke strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
            {COPY.queue}
          </button>
        </Tooltip>
      ) : readOnly !== undefined ? null : (
        <Tooltip
          content={sendTip ?? (choosing ? COPY.runAction : COPY.send)}
          shortcut={sendTip === undefined ? shortcut : undefined}
          describe={sendTip !== undefined}>
          <button
            type="submit"
            className="send-button"
            aria-label={choosing ? COPY.runAction : COPY.send}
            aria-disabled={!sendable || undefined}
            aria-busy={sending || undefined}
            onClick={event => {
              if (!sendable) event.preventDefault()
            }}>
            <Swap value={sending ? 'sending' : 'idle'}>
              {sending ? <Spinner size={14} /> : <SendGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />}
            </Swap>
          </button>
        </Tooltip>
      )}
    </div>
  )

  const add = attachments && <AttachmentButton controller={attachments} disabled={locked} sections={attachmentMenu} />
  const fields = (
    <>
      <RunBar run={run} />
      <ConfigUnknownBar state={configUnknown} />
      {actionBlock && <InlineNotice>{actionBlock}</InlineNotice>}
      {queueTray}
      {!locked && readOnly === undefined && mentions.menu}
      {attachments && (
        <AttachmentDrafts controller={attachments} locked={locked} onRestore={text => onDraft(draft ? `${draft}\n${text}` : text)} />
      )}
      <SlashCommands menu={slash} anchorRef={commandAnchor} onCreateTemplate={onCreateTemplate} />
    </>
  )
  return (
    <div className={`composer-stack composer-${variant}`} ref={box}>
      {error && (
        <InlineNotice
          tone="error"
          {...(errorActions?.length
            ? {
                action: (
                  <>
                    {errorActions.map(item => (
                      <Button key={item.label} size="xs" variant="secondary" onClick={item.run}>
                        {item.label}
                      </Button>
                    ))}
                  </>
                ),
              }
            : {})}>
          {error}
        </InlineNotice>
      )}
      {confirmation}
      {over}
      {pending !== null && !sending && (
        <div className="pending-submission" data-tint="warn" role="status">
          <div className="pending-submission-text">
            <strong>{onOpenPending ? COPY.otherPending : COPY.pending}</strong>
            {!pendingInTranscript && <p>{pending.prompt || COPY.attachments(pending.attachmentIds?.length ?? 0)}</p>}
            <Hint inline className="pending-submission-reason" label={pendingReason || COPY.noAnswer}>
              {pending.sessionId === undefined ? COPY.unknownStart : COPY.unknownMessage}
            </Hint>
          </div>
          <div className="pending-submission-actions">
            {pendingNote && <span className="pending-submission-held">{pendingNote}</span>}
            {onOpenPending ? (
              <Button onClick={onOpenPending}>{COPY.open}</Button>
            ) : (
              <Button disabled={abandoning} onClick={onRetry}>
                {COPY.retrySubmission}
              </Button>
            )}
            {onAbandon
              && (abandonHeld ? (
                <span className="pending-submission-held">{abandonHeld}</span>
              ) : (
                <Button variant="ghost" loading={abandoning} loadingLabel={COPY.checking} disabled={sending} onClick={onAbandon}>
                  {COPY.discardSubmission}
                </Button>
              ))}
          </div>
        </div>
      )}
      <DrawerStack className="composer-drawers">{drawers}</DrawerStack>
      <form
        ref={commandAnchor}
        hidden={pendingInTranscript}
        className={`composer ${run ? 'is-running' : ''}`}
        data-inline={inline ? '' : undefined}
        data-variant={readOnly !== undefined ? 'read-only' : undefined}
        onDragOver={
          attachments
            ? event => {
                if ([...event.dataTransfer.types].includes('Files')) event.preventDefault()
              }
            : undefined
        }
        onDrop={attachments ? event => dropAttachments(event, attachments) : undefined}
        onSubmit={event => {
          event.preventDefault()
          if (sendable) submit()
        }}>
        {fields}
        {input}
        {/* The text, then one line: 「+」, slash and the Harness at its start; the one entry, 「⋯」 and send at its end. */}
        <div className="composer-toolbar">
          <div className="composer-controls">
            {add}
            {!inline && slashButton}
            {controls}
            {trailing}
            {!inline && usage}
          </div>
          <div className="composer-end">
            {meta && <div className="composer-meta">{meta}</div>}
            {action}
          </div>
        </div>
        {status}
      </form>
      {below}
      {/* A phone's line has no room to share: the limit stands at the end of the line under the input instead. */}
      {inline && usage ? (
        <div className="composer-foot" data-usage="">
          {vitalsLead}
          {vitals}
          {usage}
        </div>
      ) : vitals && vitalsLead ? (
        <div className="composer-foot">
          {vitalsLead}
          {vitals}
        </div>
      ) : (
        <>
          {vitalsLead}
          {vitals}
        </>
      )}
    </div>
  )
}

/**
 * Stop, in the send slot while a run is active: a dark circle with a small square, stepping back to a neutral fill while
 * an approval waits. While the stop is being confirmed it turns and takes no presses. When its outcome is unknown it
 * stays the square and stops again when pressed; the bar above says so, with 重试, once.
 */
function StopButton({ run, stepBack }: { run: RunState; stepBack: boolean }) {
  const cancelling = run.cancel === 'cancelling'
  return (
    <Tooltip content={cancelling ? COPY.stopping : COPY.stop} shortcut={cancelling ? undefined : 'Esc Esc'} describe={false}>
      <button
        type="button"
        className="send-button stop-button"
        data-step-back={stepBack ? '' : undefined}
        aria-label={COPY.stop}
        aria-disabled={cancelling || undefined}
        aria-busy={cancelling || undefined}
        onClick={() => {
          if (!cancelling) run.onCancel()
        }}>
        <Swap value={cancelling ? 'cancelling' : 'idle'}>
          {cancelling ? <Spinner size={14} /> : <span className="stop-glyph" aria-hidden="true" />}
        </Swap>
      </button>
    </Tooltip>
  )
}

const clock = (at: number) => new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

/** The same bar while a config change's outcome is unknown; the controls keep showing the value the Host confirmed. */
function ConfigUnknownBar({ state }: { state?: ConfigUnknownState | undefined }) {
  return (
    <Collapse open={state !== undefined} className="run-bar-collapse">
      {state && (
        <div className="run-bar" data-config-unknown="">
          <span className="run-bar-what">
            <span className="run-bar-object">{state.what}</span>
            <span className="run-bar-dot" aria-hidden="true">
              ·
            </span>
            <time className="run-bar-dot" dateTime={new Date(state.at).toISOString()}>
              {clock(state.at)}
            </time>
            <span className="run-bar-dot" aria-hidden="true">
              ·
            </span>
            <span role="status" className="run-bar-status" data-lock="">
              {state.checking ? COPY.checking : COPY.unknown}
            </span>
            <span className="run-bar-dot" aria-hidden="true">
              ·
            </span>
            {/* What 核对 does is the button's tooltip: the bar keeps its one line. */}
            <Tooltip content={COPY.checkDetails(state.harness)}>
              <button type="button" className="run-bar-action" disabled={state.checking} onClick={state.onCheck}>
                {COPY.check}
              </button>
            </Tooltip>
            <span className="run-bar-dot" aria-hidden="true">
              ·
            </span>
            <button type="button" className="run-bar-action" disabled={state.checking} onClick={state.onRetry}>
              {COPY.retryRequest}
            </button>
            {state.onAbandon && (
              <>
                <span className="run-bar-dot" aria-hidden="true">
                  ·
                </span>
                <button type="button" className="run-bar-action" disabled={state.checking} onClick={state.onAbandon}>
                  {COPY.discardResult}
                </button>
              </>
            )}
          </span>
        </div>
      )}
    </Collapse>
  )
}

/**
 * The bar on top of the input while a stop's outcome is unknown: 尚未确认 with 重试. With nothing to say it folds away (its
 * height animates with the disclosure, which the reading position follows as a resize).
 */
function RunBar({ run }: { run?: RunState }) {
  return (
    <Collapse open={run?.cancel === 'uncertain'} className="run-bar-collapse">
      <div className="run-bar">
        <span className="run-bar-what">
          <span role="status" className="run-bar-status">
            <span className="sr-only">{COPY.stop}</span>
            {COPY.unconfirmed}
          </span>
          <span className="run-bar-dot" aria-hidden="true">
            ·
          </span>
          <button type="button" className="run-bar-action" onClick={run?.onCancel}>
            {COPY.retry}
          </button>
        </span>
      </div>
    </Collapse>
  )
}
