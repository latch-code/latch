import { AgentAvatar } from '../agents/AgentAvatar.tsx'
import { MENTION_COPY, type AgentMentions } from '../agents/AgentMentions.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { useStableCallback } from '../hooks/useStableCallback.ts'
import { defineCopy, plural } from '../core/i18n.ts'
import { useFileMentions, type FileMentionChoice, type MentionMembers } from '../hooks/useFileMentions.tsx'
import type { AttachmentDraftController } from '../hooks/useAttachments.ts'
import type { MenuSection } from '../components/overlays.tsx'
import { AttachmentButton, AttachmentDrafts, pasteAttachments, dropAttachments } from './AttachmentDrafts.tsx'
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { AtSign, ListPlus, Slash } from 'lucide-react'
import type { PromptTemplate, SessionCommand, SessionSkill } from '@latch/protocol'
import type { PendingSubmission } from '../core/api.ts'
import type { FollowUpDefault, SendKey } from '../preferences.ts'
import { clientKind, useShortcutBindings } from '../core/shortcutBindings.ts'
import { followUpKeyLabels, followUpShortcuts, primarySendKeys, shortcutChordMatches } from '../workbenchShortcuts.ts'
import { useViewport } from '../breakpoints.ts'
import { escapeIsLeftover } from '../escapeGrace.ts'
import { SlashCommands, useSlashCommands, type SlashAction } from './SlashCommands.tsx'
import { promptLengthError } from './promptLength.ts'
import { latchActionOf } from './latchActions.ts'
import { PromptEditor, type PromptInput } from './PromptEditor.tsx'
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
  CloseGlyph,
  SendGlyph,
  DrawerStack,
  Kbd,
  Menu,
  type MenuTriggerProps,
} from '@latch/ui'

const COPY = defineCopy(
  {
    actionUnavailable: '这个动作在当前页面不可用',
    choosePeer: '先选择收件人',
    peerBusy: '忙碌',
    peerUnavailable: '不可用',
    waitForSubmit: '等待这次提交完成',
    writeFirst: '输入内容后发送',
    sendAfterTurn: '本轮完成后发送',
    insertCommand: '插入命令',
    cancelSend: '取消发送',
    steerHint: '追加到正在运行的这一轮',
    sendNow: '立即发送',
    queue: '排队',
    queueSend: '排队发送',
    deliveryMenu: '选择发送方式',
    unassigned: '未设置',
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
    choosePeer: 'Choose a recipient first',
    peerBusy: 'Busy',
    peerUnavailable: 'Unavailable',
    waitForSubmit: 'Wait for this submission',
    writeFirst: 'Enter a message to send',
    sendAfterTurn: 'Send after this turn',
    insertCommand: 'Insert command',
    cancelSend: 'Cancel send',
    steerHint: 'Add to the running turn',
    sendNow: 'Send now',
    queue: 'Queue',
    queueSend: 'Queue message',
    deliveryMenu: 'Choose how to send',
    unassigned: 'Not set',
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

/**
 * The message input, on the new-session page and docked under a conversation, with its drawers joined above the card
 * and the status line as its last row. It starts one line high. The input stays editable while a run is active so the next message can be drafted; a Host that supports queues
 * accepts the next input for later. Its ring turns line-strong with focus inside, never blue. The send slot is a neutral
 * ink key, never blue: an arrow (a soft fill while there is nothing to send, still focusable with its reason as its
 * tooltip), the chosen delivery action while a run can take the draft, or the stop
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
  onQueue,
  followUpDefault = 'steer',
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
  agentMentions,
  members,
  lastPrompt,
}: {
  queueable?: boolean
  /** The running turn can take this draft immediately. */
  steerable?: boolean
  queueTray?: ReactNode
  agentMentions?: AgentMentions | undefined
  fileMentions?: FileMentionChoice
  /**
   * The open session leads a team: its members after `@`, their chips drawn as marks, and, while the draft names any,
   * what sending does instead (a round to them, never this session): whether it can go, and why not.
   */
  members?: {
    mention: MentionMembers
    marks: ReadonlyArray<{ token: string; name: string; title: string; media?: ReactNode }>
    round?: { ready: boolean; reason?: string }
    sending: boolean
    sendLabel: string
  }
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
  textareaRef: RefObject<PromptInput | null>
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
  onQueue?: () => void
  followUpDefault?: FollowUpDefault
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
  const [completion, setCompletion] = useState<{ draft: string; at: number | null }>()
  const completionCaret = completion?.draft === draft ? completion.at : null
  const [slashSendRevision, refreshSlashSend] = useState(0)
  const slashToSend = useRef<string | undefined>(undefined)
  const commandHead = /^([/／][^\s/／]+)([ \t]+)([\s\S]*)$/u.exec(draft)
  const commandName = commandHead?.[1]?.slice(1)
  const commandDefinition = actions?.find(action => action.name === commandName) ?? commands?.find(command => command.name === commandName)
  const commandChip = commandHead && commandDefinition ? commandHead[1]! : undefined
  const argumentHint = commandChip && !commandHead?.[3]?.trim() ? commandDefinition?.inputHint : undefined
  /**
   * What the @ and slash menus put in the draft: an edit in the input, so it is one step of its undo and the caret lands
   * where the menu says. Without a mounted input it is a plain draft change.
   */
  const editDraft = (value: string, selection?: { start: number; end: number }) => {
    const input = textareaRef.current
    if (input && !input.disabled) input.edit(value, selection)
    else onDraft(value)
  }
  const phone = useViewport() === 'phone'
  const peers = agentMentions?.source && agentMentions.canRun && !answer ? agentMentions : undefined
  const addressed = !!peers?.targetId
  const recipient = peers?.target
  const peerMenu: MentionMembers | undefined =
    peers && !addressed
      ? {
          label: MENTION_COPY.group,
          empty: MENTION_COPY.empty,
          owner: peers.source,
          onChoose: peers.select,
          items: peers.targets.map(target => ({
            id: target.id,
            token: '@' + target.name,
            name: target.name,
            title: target.description,
            media: <AgentAvatar avatar={target.avatar} size={28} still />,
            description: target.description,
            source: target.disabled ? (
              <Tooltip content={target.disabled}>
                <span className="composer-peer-status">{target.disabled === MENTION_COPY.busy ? COPY.peerBusy : COPY.peerUnavailable}</span>
              </Tooltip>
            ) : undefined,
            ...(target.disabled ? { disabled: target.disabled } : {}),
          })),
        }
      : undefined
  const mentions = useFileMentions(
    draft,
    completionCaret,
    editDraft,
    textareaRef,
    fileMentions,
    commandAnchor,
    peerMenu ?? members?.mention,
  )
  const peerHeld = peers?.attempt?.state === 'unknown' || peers?.attempt?.state === 'sending'
  const peerBlock = !addressed
    ? undefined
    : !recipient
      ? MENTION_COPY.unavailable
      : (recipient.disabled
        ?? (attachments?.items.length || fileMentions?.refs.length
          ? MENTION_COPY.textOnly
          : !draft.trim()
            ? MENTION_COPY.write
            : undefined))
  const peerLabel = MENTION_COPY.send(recipient?.name ?? 'Agent')
  const clearPeerDraft = useStableCallback((source: string | undefined, text: string) => {
    if (source && source === peers?.source && text.trim() === draft.trim()) onDraft('')
  })
  useLayoutEffect(() => {
    const delivered = peers?.takeDelivered()
    if (delivered) clearPeerDraft(delivered.source, delivered.body.text)
  })
  const sendPeer = async (retry: boolean) => {
    if (!peers) return
    const text = retry ? peers.attempt?.request.body.text : draft
    if (text && (await (retry ? peers.retry() : peers.send(text)))) clearPeerDraft(peers.source, text)
  }

  const roundSending = members?.sending === true
  const locked = sending || roundSending || peerHeld || pending !== null || attachments?.preparing === true
  // One unconfirmed write per device: nothing else is sent meanwhile, but only the input that holds its text is held.
  const textLocked =
    sending || roundSending || peerHeld || (pending !== null && onOpenPending === undefined) || attachments?.preparing === true
  const empty = draft.trim().length === 0 && !attachments?.items.length
  const typedAction = !addressed && answer === undefined ? latchActionOf(draft) : undefined
  // Members named in the draft: it goes to them as a round, whether or not this session is at work.
  const round = answer === undefined && typedAction === undefined ? members?.round : undefined
  const rounding = round !== undefined || addressed
  const lengthError = !rounding && !typedAction && !answer && readOnly === undefined ? promptLengthError(draft) : undefined
  const queueDraft =
    !rounding
    && !!run
    && (queueable || steerable)
    && !empty
    && !fileMentions?.refs.length
    && answer === undefined
    && typedAction === undefined
    && readOnly === undefined
  const localAction = typedAction && actions?.find(action => action.name === typedAction.name)
  const actionBlock = typedAction ? (localAction?.unavailable ?? (!localAction?.run ? COPY.actionUnavailable : undefined)) : undefined
  const sendable =
    !locked
    && !lengthError
    && !mentions.pickingPerson
    && readOnly === undefined
    && (answer !== undefined
      ? !empty
      : typedAction
        ? !actionBlock
        : addressed
          ? !!peers?.online && !peerBlock
          : round
            ? canSend && round.ready
            : canSend && !empty && (!run || queueDraft))
  const chooseDelivery = queueDraft && queueable && steerable && !!onQueue
  const defaultQueue = !steerable || (chooseDelivery && followUpDefault === 'queue')
  useShortcutBindings()
  const desktop = clientKind() === 'desktop'
  const chords = queueDraft && followUpShortcuts(followUpDefault, desktop)
  const submit = () => {
    if (answer) answer.onSubmit()
    else if (typedAction) {
      if (!actionBlock) localAction?.run?.(typedAction.argument)
    } else if (addressed) void sendPeer(false)
    else if (chooseDelivery && defaultQueue) onQueue()
    else onSubmit()
  }
  useLayoutEffect(() => {
    const input = textareaRef.current
    const command = slashToSend.current
    if (command === undefined) return
    // Consume before invoking the existing sender, including Strict Mode's repeated layout effects.
    slashToSend.current = undefined
    if (
      draft === command
      && sendable
      && !run
      && !answer
      && input?.element.getClientRects().length
      && !input.element.closest('[inert], [hidden], [aria-hidden="true"]')
    )
      submit()
  }, [draft, sendable, submit, textareaRef, slashSendRevision, run, answer])
  const escapeAt = useRef({ at: 0, run: run?.id })
  const slash = useSlashCommands({
    draft,
    caret: completionCaret,
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
    enabled: !addressed && !locked && readOnly === undefined && answer === undefined,
    onDraft: (value, selection) => {
      editDraft(value, selection)
      textareaRef.current?.focus({ preventScroll: true })
    },
    onCommand: value => {
      if (answer || locked || readOnly !== undefined || !canSend || run) return
      slashToSend.current = value
      onDraft(value)
      refreshSlashSend(revision => revision + 1)
    },
  })
  /** The input's keys before its own: the menus, then the command's Backspace, Esc, ↑ and the send keys. */
  const keydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.getModifierState('AltGraph')) return
    if (slash.keydown(event)) return
    // Hidden while a submission is held: its keys are the input's again.
    if (!locked && readOnly === undefined && mentions.keydown(event)) return
    const input = textareaRef.current
    // Backspace after a command and the space that follows it takes both, so the draft does not start with a space.
    if (
      event.key === 'Backspace'
      && commandChip
      && commandHead?.[2]
      && input
      && input.selectionStart === input.selectionEnd
      && [commandChip.length, commandChip.length + 1].includes(input.selectionStart)
      && !event.altKey
      && !event.ctrlKey
      && !event.metaKey
      && !event.shiftKey
    ) {
      event.preventDefault()
      input.edit(draft.slice(commandChip.length + commandHead[2].length), { start: 0, end: 0 })
      return
    }
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
    if (variant === 'session' && chords && sendable && !slash.open && !mentions.open && !(event.metaKey && event.ctrlKey)) {
      const stroke = {
        key: event.key,
        code: event.code,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        typing: true,
      }
      const named = (['steer', 'queue'] as const).find(action => shortcutChordMatches(stroke, chords[action]))
      if (named) {
        if (!event.repeat) {
          if (named === 'steer' && steerable) onSubmit()
          if (named === 'queue' && queueable) onQueue?.()
        }
        event.preventDefault()
        return
      }
    }
    if (event.key !== 'Enter' || event.altKey || event.shiftKey || (event.metaKey && event.ctrlKey)) return
    const explicit = event.metaKey || event.ctrlKey
    if (!explicit && (coarse || sendKey !== 'enter')) return
    event.preventDefault()
    if (sendable && !event.repeat) submit()
  }
  const shortcut = primarySendKeys(sendKey, coarse)
  const sendTip =
    actionBlock
    ?? lengthError
    ?? (mentions.pickingPerson ? COPY.choosePeer : undefined)
    ?? peerBlock
    ?? (addressed ? undefined : blockReason)
    ?? round?.reason
    ?? (locked ? COPY.waitForSubmit : empty ? COPY.writeFirst : queueDraft && !steerable ? COPY.sendAfterTurn : undefined)

  // The slot's control swaps in (from 90%, fading in) when the page sees it change: a run starting or ending.
  const answering = answer?.kind === 'question' && !empty
  const choosing = typedAction !== undefined
  const slot =
    answering || choosing || rounding
      ? 'send'
      : run && !queueDraft
        ? 'stop'
        : queueDraft
          ? 'queue'
          : readOnly !== undefined
            ? 'none'
            : 'send'
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

  const catalogue = { commands, skills, actions, members: members?.marks }
  const editor = (
    <PromptEditor
      inputRef={textareaRef}
      value={draft}
      onChange={(value, caret) => {
        setCompletion({ draft: value, at: caret })
        onDraft(value)
      }}
      onCaret={(at, value) => setCompletion({ draft: value, at })}
      catalogue={catalogue}
      refs={fileMentions?.refs}
      hint={argumentHint}
      attributes={{
        label,
        autocomplete: slash.open || mentions.open ? 'list' : undefined,
        controls: slash.open ? slash.id : mentions.open ? mentions.listId : undefined,
        activeDescendant:
          slash.open && slash.options[slash.active] ? slash.id + '-' + slash.active : !slash.open ? mentions.activeId : undefined,
      }}
      placeholder={addressed ? peerLabel : peers?.targets.length ? MENTION_COPY.placeholder : placeholder}
      disabled={textLocked}
      onKeyDown={event => {
        keydown(event)
        return event.defaultPrevented
      }}
      onPaste={event => {
        if (!attachments || !event.clipboardData) return false
        pasteAttachments(event, attachments)
        return event.defaultPrevented
      }}
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
      <div className="composer-input">{editor}</div>
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
        slash.reopen()
        editDraft(value, { start: start + insert.length, end: start + insert.length })
        input?.focus({ preventScroll: true })
      }}
    />
  )
  const action = (
    <div className="composer-slot" data-queue-draft={queueDraft ? '' : undefined}>
      {/* Touch has no Esc: stop stays beside 排队 and an answer's send there. */}
      {(queueDraft || answering || choosing || rounding) && run && coarse && <StopButton run={run} stepBack={stepBack} />}
      {attachments?.preparing ? (
        <Button size="sm" onClick={attachments.cancel}>
          <Spinner size={14} />
          {COPY.cancelSend}
        </Button>
      ) : run && !queueDraft && !answering && !choosing && !rounding ? (
        <StopButton run={run} stepBack={stepBack} />
      ) : chords ? (
        <FollowUpButton
          defaultQueue={defaultQueue}
          sendable={sendable}
          coarse={coarse}
          tip={sendTip}
          shortcut={shortcut}
          chords={chords}
          desktop={desktop}
          choices={chooseDelivery ? { queue: onQueue, steer: onSubmit } : undefined}
        />
      ) : readOnly !== undefined ? null : (
        <Tooltip
          content={sendTip ?? (choosing ? COPY.runAction : addressed ? peerLabel : rounding ? members!.sendLabel : COPY.send)}
          shortcut={sendTip === undefined ? shortcut : undefined}
          describe={sendTip !== undefined}>
          <button
            type="submit"
            className="send-button"
            aria-label={choosing ? COPY.runAction : addressed ? peerLabel : rounding ? members!.sendLabel : COPY.send}
            aria-disabled={!sendable || undefined}
            aria-busy={sending || roundSending || undefined}
            onClick={event => {
              if (!sendable) event.preventDefault()
            }}>
            <Swap value={sending || roundSending ? 'sending' : 'idle'}>
              {sending || roundSending ? (
                <Spinner size={14} />
              ) : (
                <SendGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
              )}
            </Swap>
          </button>
        </Tooltip>
      )}
    </div>
  )

  const peerAction = peerMenu?.items.length ? mentions.openPeople : undefined
  const recipientChip = addressed && (
    <span className="agent-mention-chip composer-peer-chip">
      <AgentAvatar avatar={recipient?.avatar ?? 'general'} size={20} still />
      <VisibleText text={peerLabel} />
      <IconButton
        icon={CloseGlyph}
        size="xs"
        label={MENTION_COPY.remove}
        disabled={peerHeld}
        onClick={() => {
          peers?.select()
          textareaRef.current?.focus({ preventScroll: true })
        }}
      />
    </span>
  )
  const peerPickerButton = !phone && peerAction && readOnly === undefined && (
    <Button
      variant="ghost"
      size="sm"
      icon={AtSign}
      className="composer-peer-trigger"
      aria-haspopup="listbox"
      aria-expanded={mentions.open}
      aria-controls={mentions.open ? mentions.listId : undefined}
      shortcut="@"
      tooltip={MENTION_COPY.contact}
      disabled={locked}
      onClick={peerAction}>
      {MENTION_COPY.contact}
    </Button>
  )
  const sections: MenuSection[] = [
    ...(phone && peerAction ? [{ id: 'agent', items: [{ id: 'contact-agent', label: MENTION_COPY.contact, onSelect: peerAction }] }] : []),
    ...(attachmentMenu ?? []),
  ]
  const add = attachments ? (
    <AttachmentButton controller={attachments} disabled={locked} sections={sections.length || attachmentMenu ? sections : undefined} />
  ) : null
  const fields = (
    <>
      <RunBar run={run} />
      <ConfigUnknownBar state={configUnknown} />
      {actionBlock && <InlineNotice>{actionBlock}</InlineNotice>}
      {lengthError && <InlineNotice>{lengthError}</InlineNotice>}
      {queueTray}
      {!locked && readOnly === undefined && mentions.menu}
      {attachments && (
        <AttachmentDrafts
          controller={attachments}
          locked={locked}
          onRestore={text => {
            const input = textareaRef.current
            if (!input?.insertText(text)) return false
            // The dialog must close before focus can return to the editor.
            requestAnimationFrame(() => {
              if (textareaRef.current === input && !input.disabled) input.focus({ preventScroll: true })
            })
            return true
          }}
        />
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
      {peers?.attempt && peers.attempt.state !== 'sending' && (
        <InlineNotice
          tone={peers.attempt.state === 'unknown' ? 'warn' : 'error'}
          title={peers.attempt.state === 'unknown' ? MENTION_COPY.unknown : undefined}
          action={
            peers.attempt.state === 'unknown' ? (
              <>
                <Button size="xs" disabled={!peers.online || !peers.attempt.request.body.text} onClick={() => void sendPeer(true)}>
                  {MENTION_COPY.retry}
                </Button>
                <Button size="xs" onClick={peers.abandon}>
                  {MENTION_COPY.abandon}
                </Button>
              </>
            ) : undefined
          }>
          {peers.attempt.reason}
        </InlineNotice>
      )}
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
        {addressed && (phone || (peerBlock && draft.trim())) && (
          <div className="agent-mention-address">
            {phone && recipientChip}
            {peerBlock && draft.trim() && <span>{peerBlock}</span>}
          </div>
        )}
        {input}
        {/* The text, then one line: 「+」, slash and the Harness at its start; the one entry, 「⋯」 and send at its end. */}
        <div className="composer-toolbar">
          <div className="composer-controls">
            {add}
            {peerPickerButton}
            {!phone && recipientChip}
            {!inline && slashButton}
            {controls}
            {trailing}
          </div>
          <div className="composer-end">
            {meta && <div className="composer-meta">{meta}</div>}
            {action}
          </div>
        </div>
        {status}
      </form>
      {below}
      {/* The limit is not a choice: it stands at the end of the line under the input, with what the session used. */}
      {usage ? (
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

function FollowUpButton({
  defaultQueue,
  sendable,
  coarse,
  tip,
  shortcut,
  chords,
  desktop,
  choices,
}: {
  defaultQueue: boolean
  sendable: boolean
  coarse: boolean
  tip: string | undefined
  shortcut: string
  chords: ReturnType<typeof followUpShortcuts>
  desktop: boolean
  choices: { queue(): void; steer(): void } | undefined
}) {
  const Glyph = defaultQueue ? ListPlus : SendGlyph
  const button = (menu?: MenuTriggerProps) => (
    <button
      {...menu}
      type="submit"
      className="send-button queue-button"
      aria-label={defaultQueue ? COPY.queueSend : COPY.sendNow}
      aria-keyshortcuts={menu ? 'ArrowDown' : undefined}
      aria-disabled={!sendable || undefined}
      onClick={event => {
        if (!sendable) {
          event.preventDefault()
          return
        }
        if (!menu) return
        const touch = 'pointerType' in event.nativeEvent ? event.nativeEvent.pointerType === 'touch' : coarse
        if (event.detail !== 0 && touch) {
          event.preventDefault()
          menu.onClick()
        } else if (menu['aria-expanded']) menu.onClick()
      }}>
      <Glyph size={16} nonScalingStroke strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
      {defaultQueue ? COPY.queue : COPY.sendNow}
    </button>
  )
  if (!choices || !sendable)
    return (
      <Tooltip content={tip ?? (defaultQueue ? COPY.sendAfterTurn : COPY.steerHint)} shortcut={sendable ? shortcut : undefined}>
        {button()}
      </Tooltip>
    )
  const keys = (action: FollowUpDefault) => {
    const primary = action === (defaultQueue ? 'queue' : 'steer') ? shortcut : null
    const labels = followUpKeyLabels(primary, chords[action], desktop)
    return labels.length ? <Kbd>{labels.join(' / ')}</Kbd> : COPY.unassigned
  }
  return (
    <Menu
      previewOnHover
      label={COPY.deliveryMenu}
      side="top"
      align="end"
      size="sm"
      trigger={button}
      sections={[
        {
          id: 'delivery',
          items: [
            {
              id: 'steer',
              label: COPY.sendNow,
              description: COPY.steerHint,
              icon: SendGlyph,
              meta: keys('steer'),
              onSelect: choices.steer,
            },
            {
              id: 'queue',
              label: COPY.queueSend,
              description: COPY.sendAfterTurn,
              icon: ListPlus,
              meta: keys('queue'),
              onSelect: choices.queue,
            },
          ],
        },
      ]}
    />
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
