import { createContext, useContext, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronRight, Ellipsis, LockKeyhole } from 'lucide-react'
import type { Approval, ApprovalOption, ConfirmationTicket, FileDiff } from '@latch/protocol'
import {
  Button,
  ICON_STROKE,
  IconButton,
  InlineNotice,
  Kbd,
  Menu,
  StatusPill,
  StatusWord,
  type MenuItem,
  type MenuTriggerProps,
} from '@latch/ui'
import { useCoarsePointer, useViewport } from '../breakpoints.ts'
import { previousState } from '../diff.ts'
import { argumentView, relativeTime, type ArgumentView } from '../format.ts'
import type { ApprovalGate } from '../core/permissions.ts'
import { APPROVAL_COPY, APPROVAL_OPTION_LABELS, DECISION_COPY, CONFIRMATION_COPY } from '../core/securityCopy.ts'
import { ArgumentList } from './ArgumentList.tsx'
import { diffRows, DiffView, PREVIOUS_NOTES } from './DiffView.tsx'
import { ConfirmationDetails, SheetSentence } from './InlineConfirm.tsx'
import { hasHiddenCharacters, VisibleText } from './VisibleText.tsx'

/**
 * A press on one of the card's choices. `retry`: the same choice sent again after an unknown outcome, with the note a
 * rejection carried, so it goes as it was and never waits for a note again.
 */
export type DecideHandler = (
  approval: Approval,
  decision: 'allow' | 'reject',
  optionId: string | undefined,
  retry?: { note?: string },
) => void

/** A choice whose outcome is unknown (a timeout or a dropped connection): retrying sends it again with its requestId. */
interface UncertainChoice {
  decision: 'allow' | 'reject'
  optionId: string | undefined
  /** The note the rejection carried (「告诉 Agent 改做什么」). */
  note?: string
}

/** What this device's last choice on an approval is doing, when the card has to say more than its buttons do. */
export interface ApprovalStatus {
  /** The outcome is unknown; the card offers to send the same choice again. */
  uncertain?: UncertainChoice
  /** The pressed allow's local confirmation: open on this computer, or passed with the choice on its way. */
  confirming?: 'waiting' | 'sending'
  /** Its ticket (the sentence the system sheet shows and the details), and how to cancel it while it waits. */
  ticket?: ConfirmationTicket
  cancel?: () => void
  /** Why the choice did not go through: a confirmation that did not pass (error) or could not start (warn). */
  failure?: { text: string; tone: 'error' | 'warn' }
  /** 拒绝 was pressed and the composer asks what to do instead; the next 拒绝 sends the rejection. */
  noting?: true
}

/** The approvals this device's choices left in such a state, by approval id; the page provides them. */
export const ApprovalStatuses = createContext<ReadonlyMap<string, ApprovalStatus>>(new Map())

/** Whether any text the approver reviews hides characters (see VisibleText). */
export function approvalHidesText(approval: Approval, title: string, diffs: FileDiff[]): boolean {
  return (
    [title, approval.toolName, approval.reason, approval.tool?.input ?? approval.arguments].some(text => hasHiddenCharacters(text))
    || diffs.some(diff => hasHiddenCharacters(diff.path) || hasHiddenCharacters(diff.newText) || hasHiddenCharacters(diff.oldText))
  )
}

/**
 * The card's state in words: red 高风险 for a high-risk request, amber words after the shield for every other one while
 * it waits. Hidden characters turn an ordinary request's words into 需要核对; a high-risk or advisory request keeps its
 * own, since the kind of request decides what allowing means.
 */
export function ApprovalPill({ gate, hidden, className }: { gate: ApprovalGate; hidden: boolean; className?: string }) {
  if (gate.badge?.tone === 'err') {
    return (
      <StatusPill tone="err" className={className}>
        {gate.badge.label}
      </StatusPill>
    )
  }
  const label =
    hidden && (gate.kind === 'R1' || gate.kind === 'legacy') ? APPROVAL_COPY.check : (gate.badge?.label ?? APPROVAL_COPY.waiting)
  return (
    <StatusWord tone="waiting" className={className}>
      {label}
    </StatusWord>
  )
}

const isAllow = (option: ApprovalOption) => option.kind.startsWith('allow')
const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

/**
 * The words on an option: an agent's question shows the product's words for its kind, never the agent's own (which
 * may be in another language); every other request comes from the Host in the product's words already.
 */
function optionLabel(option: ApprovalOption, gate: ApprovalGate): string {
  return gate.kind === 'advisory' && Object.hasOwn(APPROVAL_OPTION_LABELS, option.kind) ? APPROVAL_OPTION_LABELS[option.kind] : option.label
}

/**
 * The rows a file of the preview shows before its fold bar, so the paper stays within PREVIEW_MAX: one fewer on phones,
 * where the fold bar is a 44 target.
 */
const FOLD_ROWS = 7
const FOLD_ROWS_PHONE = 6
/** The tallest preview a desktop opens by default. */
const PREVIEW_MAX = 240

const lineCount = (text: string) => text.split('\n').length

/**
 * Roughly how tall the preview's paper stands: 20 per line of code or text, 18 per argument name, 18 of padding per
 * paper; a file's header 34, its hash line 30 and the fold bar 28; 8 between papers. Several files show only their
 * headers until opened.
 */
function previewHeight(args: ArgumentView, covered: readonly string[], diffs: FileDiff[]): number {
  const papers: number[] = []
  if (args.kind === 'text') papers.push(18 + 20 * lineCount(args.text))
  if (args.kind === 'entries') {
    const shown = args.entries.filter(([, value]) => !covered.includes(value))
    if (shown.length > 0) papers.push(18 + shown.reduce((sum, [, value]) => sum + 18 + 20 * lineCount(value), 0))
  }
  for (const diff of diffs) {
    const rows = diffs.length === 1 ? diffRows(diff) : 0
    papers.push(34 + (rows > 0 ? 30 + 20 * Math.min(rows, FOLD_ROWS) + (rows > FOLD_ROWS ? 28 : 0) : 0))
  }
  return papers.reduce((sum, height) => sum + height, 0) + 8 * Math.max(0, papers.length - 1)
}

/** 「刚刚」, 「5 分钟前」, 「昨天」: when the request arrived. */
function requestedText(value: string): string {
  const text = relativeTime(value)
  return /(?:分钟|小时|天)$/u.test(text) ? `${text}前` : text
}

/**
 * The two buttons a card shows (one reject, then allow once or the first allow) and the rest of the offered choices,
 * which go behind ⋯ (更多选项 on phones): a card never shows more than two buttons.
 */
function approvalChoices(options: readonly ApprovalOption[]): {
  reject?: ApprovalOption
  allow?: ApprovalOption
  more: ApprovalOption[]
} {
  const rejects = options.filter(option => !isAllow(option))
  const allows = options.filter(isAllow)
  const reject = rejects.find(option => option.kind === 'reject_once') ?? rejects[0]
  const allow = allows.find(option => option.kind === 'allow_once') ?? allows[0]
  return {
    ...(reject ? { reject } : {}),
    ...(allow ? { allow } : {}),
    more: options.filter(option => option !== reject && option !== allow),
  }
}

/** What opens the other choices: ⋯ beside the buttons, or a whole-width 更多选项 under them on phones. */
const moreTrigger = (phone: boolean, running: boolean) =>
  function MoreTrigger(props: MenuTriggerProps) {
    return phone ? (
      <Button {...props} variant="ghost" size="lg" block className="approval-more" disabled={running}>
        {APPROVAL_COPY.moreSheet}
      </Button>
    ) : (
      <IconButton {...props} label={APPROVAL_COPY.more} icon={Ellipsis} className="approval-more" disabled={running} />
    )
  }

/**
 * The decision under a tool card that waits for the person: the agent's reason and when it asked, the notes that
 * change what allowing means (a full-access question, hidden characters, previous content the reviewer cannot see),
 * the preview (arguments and diff, on paper), one sentence on what allowing does, and at most two buttons with the
 * rest behind ⋯. A device that may not allow sees why, next to 拒绝. While a choice is sent only that button runs; an
 * allow that needs the local confirmation keeps its words while the line under the preview says what to do on this
 * computer, and a confirmation that did not pass returns the buttons with the reason in the card. An unknown outcome
 * offers to retry the same choice.
 */
function ApprovalPanel({
  approval,
  gate,
  title,
  diffs,
  hidden,
  busy,
  onDecide,
}: {
  approval: Approval
  gate: ApprovalGate
  title: string
  diffs: FileDiff[]
  hidden: boolean
  busy: string | undefined
  onDecide: DecideHandler
}) {
  const phone = useViewport() === 'phone'
  const coarse = useCoarsePointer()
  const status = useContext(ApprovalStatuses).get(approval.id)
  const running = busy !== undefined
  const uncertain = running ? undefined : status?.uncertain
  const failure = running ? undefined : status?.failure
  const previewId = useId()
  const args = argumentView(approval.tool?.input ?? approval.arguments)
  const hasPreview = args.kind !== 'empty' || diffs.length > 0
  // What the diff shows in full is not repeated as an argument: the file's path and its new text.
  const covered = diffs.flatMap(diff => [diff.path, diff.newText])
  // A desktop shows the preview when it fits in PREVIEW_MAX; phones start with it folded. Content that hides
  // characters is always shown.
  const [open, setOpen] = useState(() => hidden || (!phone && previewHeight(args, covered, diffs) <= PREVIEW_MAX))
  const { reject, allow, more } = approvalChoices(gate.options)
  const choose = (option: ApprovalOption) => {
    onDecide(approval, isAllow(option) ? 'allow' : 'reject', gate.explicit ? option.id : undefined)
  }
  // Allowing an ordinary step is the card's one blue action; a high-risk, hidden-character or confirmed allow is not,
  // and neither is any button while 重试 is the card's one clear action.
  const primary = allow !== undefined && !hidden && !gate.confirms && gate.kind !== 'R2' && uncertain === undefined
  const shortcut = primary && allow.kind === 'allow_once' && (gate.kind === 'R1' || gate.kind === 'legacy')
  // Content that may read as something else, or a choice in doubt, keeps the broadest choices out of reach.
  const offerMore = more.length > 0 && !hidden && uncertain === undefined
  const previousNotes = (['unavailable', 'unknown'] as const)
    .filter(state => diffs.some(diff => previousState(diff) === state))
    .map(state => PREVIOUS_NOTES[state]!)
  const footnote =
    status?.noting && !running
      ? DECISION_COPY.noteCard
      : status?.confirming === 'waiting'
        ? CONFIRMATION_COPY.waitingShell
        : status?.confirming === 'sending'
          ? APPROVAL_COPY.confirmedLocal
          : allow === undefined
            ? undefined
            : gate.confirms
              ? APPROVAL_COPY.localNote
              : gate.kind === 'R1' && allow.kind === 'allow_once'
                ? APPROVAL_COPY.onceNote
                : undefined
  const uncertainOption =
    uncertain && (gate.options.find(option => option.id === uncertain.optionId) ?? (uncertain.decision === 'allow' ? allow : reject))
  const keys = (event: KeyboardEvent<HTMLElement>) => {
    if (running || event.defaultPrevented) return
    if (event.target instanceof Element && event.target.closest('input, textarea, [role="menu"], .ui-popover')) return
    if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey && reject) {
      event.preventDefault()
      choose(reject)
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && shortcut && allow) {
      event.preventDefault()
      choose(allow)
    }
  }
  const menuItems: MenuItem[] = more.map(option => ({
    id: option.id,
    label: optionLabel(option, gate),
    ...(option.kind === 'allow_always' ? { description: APPROVAL_COPY.alwaysNote } : {}),
    ...(running ? { disabledReason: APPROVAL_COPY.moreBusy } : {}),
    onSelect: () => {
      choose(option)
    },
  }))
  const moreMenu = offerMore ? (
    <Menu
      label={APPROVAL_COPY.more}
      align="end"
      side="top"
      sections={[{ id: 'more', items: menuItems }]}
      trigger={moreTrigger(phone, running)}
    />
  ) : null
  const button = (option: ApprovalOption, variant: 'primary' | 'secondary') => {
    const pressed = busy === option.id
    const local = gate.confirms === true && isAllow(option)
    const label = optionLabel(option, gate)
    // The running spinner takes the lock's place, so the button keeps its words and its width while the line under
    // the preview says what to do. An agent's own words for its option stay in the tooltip.
    return (
      <Button
        key={option.id}
        variant={variant}
        size={phone ? 'lg' : 'sm'}
        icon={local ? LockKeyhole : undefined}
        tooltip={local ? APPROVAL_COPY.allowLocalTooltip : label === option.label ? undefined : option.label}
        loading={pressed}
        disabled={running && !pressed}
        onClick={() => {
          choose(option)
        }}>
        {label}
      </Button>
    )
  }
  return (
    <section className="approval-panel" data-secure="" aria-label="待批准操作" onKeyDown={keys}>
      <div className="approval-notes">
        {approval.reason && approval.reason !== title && (
          <p className="approval-reason">
            <VisibleText text={approval.reason} />
          </p>
        )}
        <p className="approval-meta">
          <time dateTime={approval.requestedAt}>{requestedText(approval.requestedAt)}</time>
        </p>
        {gate.note && <p className="approval-note">{gate.note}</p>}
        {hidden && (
          <p className="approval-warning" role="note">
            {APPROVAL_COPY.hiddenCharacters}
          </p>
        )}
        {previousNotes.map(note => (
          <p key={note} className="approval-warning" role="note">
            {note}
          </p>
        ))}
      </div>
      {/* A call without arguments says so in place: there is nothing to unfold. */}
      {!hasPreview && (
        <div className="approval-preview" data-open="">
          <div className="approval-preview-inner">
            <ArgumentList text={approval.tool?.input ?? approval.arguments} />
          </div>
        </div>
      )}
      {hasPreview && (
        <>
          <button
            type="button"
            className="approval-toggle"
            aria-expanded={open}
            aria-controls={previewId}
            onClick={() => {
              setOpen(!open)
            }}>
            <ChevronRight className="chevron" size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
            {open ? (diffs.length > 0 ? '收起预览' : '收起参数') : diffs.length > 0 ? '查看预览' : '查看参数'}
          </button>
          <div className="approval-preview" id={previewId} data-open={open ? '' : undefined}>
            <div className="approval-preview-inner" inert={!open}>
              <ArgumentList text={approval.tool?.input ?? approval.arguments} covered={covered} quiet={diffs.length > 0} />
              <DiffView diffs={diffs} fold={phone ? FOLD_ROWS_PHONE : FOLD_ROWS} />
            </div>
          </div>
        </>
      )}
      {footnote && (
        <p className="approval-footnote" aria-live="polite" data-confirming={status?.confirming}>
          <span>{footnote}</span>
          {status?.confirming === 'waiting' && status.cancel && (
            <Button size="xs" variant="link" className="approval-confirm-cancel" onClick={status.cancel}>
              {CONFIRMATION_COPY.cancel}
            </Button>
          )}
        </p>
      )}
      {/* While Touch ID waits: the sentence the system sheet shows, and the Host's facts behind it. */}
      {status?.confirming && status.ticket && (
        <div className="approval-confirm">
          {status.ticket.reason && <SheetSentence reason={status.ticket.reason} />}
          <ConfirmationDetails ticket={status.ticket} />
        </div>
      )}
      {failure && (
        <InlineNotice tone={failure.tone} className="approval-failure">
          {failure.text}
        </InlineNotice>
      )}
      {uncertain && uncertainOption && (
        <InlineNotice
          tone="error"
          className="approval-uncertain"
          title={APPROVAL_COPY.uncertainTitle(optionLabel(uncertainOption, gate))}
          action={
            <Button
              size="xs"
              onClick={() => {
                onDecide(approval, uncertain.decision, uncertain.optionId, uncertain.note === undefined ? {} : { note: uncertain.note })
              }}>
              {APPROVAL_COPY.retry}
            </Button>
          }>
          {APPROVAL_COPY.uncertain}
        </InlineNotice>
      )}
      <footer className="approval-actions" data-single={allow === undefined ? '' : undefined}>
        {gate.hint ? (
          <p className="approval-hint">
            <LockKeyhole size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
            {gate.hint}
          </p>
        ) : (
          !coarse
          && !phone
          && !running
          && reject && (
            <p className="approval-keys" aria-hidden="true">
              <Kbd>Esc</Kbd> {optionLabel(reject, gate)}
              {shortcut && allow && (
                <>
                  {' · '}
                  <Kbd>{isMac() ? '⌘⏎' : 'Ctrl ⏎'}</Kbd> {optionLabel(allow, gate)}
                </>
              )}
            </p>
          )
        )}
        {!phone && moreMenu}
        <div className="approval-buttons">
          {reject && button(reject, 'secondary')}
          {allow && button(allow, primary ? 'primary' : 'secondary')}
        </div>
        {phone && moreMenu}
      </footer>
    </section>
  )
}

/**
 * Keeps the decision on screen while it folds away after the Host settled it (the approval left the snapshot): the
 * slot closes by its height over 180ms as its content fades, and the copy goes once those transitions end (at once
 * when none run). The folding copy takes no input.
 */
export function ApprovalSlot(props: {
  approval: Approval | undefined
  gate: ApprovalGate | undefined
  title: string
  diffs: FileDiff[]
  hidden: boolean
  busy: string | undefined
  onDecide: DecideHandler
}) {
  const slot = useRef<HTMLDivElement>(null)
  const [last, setLast] = useState<{ approval: Approval; gate: ApprovalGate } | null>(null)
  const current = props.approval && props.gate ? { approval: props.approval, gate: props.gate } : null
  if (current && last?.approval !== current.approval) setLast(current)
  const leaving = current === null && last !== null
  useEffect(() => {
    if (!leaving) return undefined
    const element = slot.current
    let active = true
    const drop = () => {
      if (active) setLast(null)
    }
    // getAnimations flushes the style change, so the folding transitions exist by now; with none, the copy goes now.
    const folding = element?.getAnimations() ?? []
    if (element === null || folding.length === 0) {
      drop()
      return undefined
    }
    const ended = (event: TransitionEvent) => {
      if (event.target === element && event.propertyName === 'grid-template-rows') drop()
    }
    element.addEventListener('transitionend', ended)
    element.addEventListener('transitioncancel', ended)
    void Promise.all(folding.map(animation => animation.finished)).then(drop, drop)
    return () => {
      active = false
      element.removeEventListener('transitionend', ended)
      element.removeEventListener('transitioncancel', ended)
    }
  }, [leaving])
  const shown = current ?? last
  if (shown === null) return null
  return (
    <div ref={slot} className="approval-slot" data-leaving={leaving ? '' : undefined} inert={leaving}>
      <div className="approval-slot-inner">
        <ApprovalPanel {...props} approval={shown.approval} gate={shown.gate} busy={leaving ? undefined : props.busy} />
      </div>
    </div>
  )
}
