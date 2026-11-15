import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'

import type { Approval, ApprovalOption, FileDiff, Message } from '@latch/protocol'
import {
  Button,
  Hint,
  ICON_STROKE,
  Icon,
  IconButton,
  InlineNotice,
  Menu,
  type MenuItem,
  type MenuTriggerProps,
  ChevronLeftGlyph,
  ChevronRightGlyph,
  EditGlyph,
  LockGlyph,
  TerminalGlyph,
  Tooltip,
  WaitingGlyph,
  WarningGlyph,
} from '@latch/ui'
import { useViewport } from '../breakpoints.ts'
import { escapeIsLeftover } from '../escapeGrace.ts'
import { previousState } from '../diff.ts'
import { argumentView } from '../format.ts'
import { approvalCommand, diffStat, linesBelow, toolHeading, toolHeadingPath } from '../conversation.ts'
import type { ApprovalGate } from '../core/permissions.ts'
import { APPROVAL_COPY, APPROVAL_OPTION_LABELS, CONFIRMATION_COPY, RISK_CLAUSE } from '../core/securityCopy.ts'
import { ArgumentList } from '../components/ArgumentList.tsx'
import { DiffView, PREVIOUS_NOTES } from '../components/DiffView.tsx'
import { escapeHiddenCharacters, hasHiddenCharacters, VisibleText } from '../components/VisibleText.tsx'
import { cardTakesKeys, useArmed } from './useArmed.ts'

/**
 * A press on one of the card's choices. `retry`: the same choice sent again after an unknown outcome, with the note a
 * rejection carried, so it goes as it was and never waits for a note again.
 */
type DecideHandler = (approval: Approval, decision: 'allow' | 'reject', optionId: string | undefined, retry?: { note?: string }) => void

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
  /** Why the choice did not go through: a confirmation that did not pass (error) or could not start (warn). */
  failure?: { text: string; tone: 'error' | 'warn' }
}

/** Whether any text the approver reviews hides characters (see VisibleText). */
function approvalHidesText(approval: Approval, title: string, diffs: readonly FileDiff[]): boolean {
  return (
    [title, approval.toolName, approval.reason, approval.subagent, approval.tool?.input ?? approval.arguments].some(text =>
      hasHiddenCharacters(text),
    ) || diffs.some(diff => hasHiddenCharacters(diff.path) || hasHiddenCharacters(diff.newText) || hasHiddenCharacters(diff.oldText))
  )
}

/**
 * The command an approval asks about, whole. A long one scrolls in its own box so the choices stay in reach; while any
 * of it lies below what the box shows, the box fades out at its foot and a line under it counts the lines still to
 * read, measured from the box itself, so a command's last line is never out of sight without a word.
 */
function ApprovalCommand({ className, text }: { className: string; text: string }) {
  const box = useRef<HTMLSpanElement>(null)
  const [below, setBelow] = useState(0)
  useLayoutEffect(() => {
    const element = box.current
    if (!element) return undefined
    const measure = () => {
      setBelow(linesBelow(element, parseFloat(getComputedStyle(element).lineHeight)))
    }
    measure()
    const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : undefined
    resized?.observe(element)
    element.addEventListener('scroll', measure, { passive: true })
    return () => {
      resized?.disconnect()
      element.removeEventListener('scroll', measure)
    }
  }, [text])
  return (
    <span className="approval-command-box">
      <span ref={box} className={className} data-more={below > 0 ? '' : undefined} tabIndex={0}>
        <VisibleText text={text} />
      </span>
      {below > 0 && <span className="approval-more-lines">还有 {below} 行</span>}
    </span>
  )
}

const isAllow = (option: ApprovalOption) => option.kind.startsWith('allow')

/**
 * The words on an option: an agent's question shows the product's words for its kind, never the agent's own (which
 * may be in another language); every other request comes from the Host in the product's words already.
 */
function optionLabel(option: ApprovalOption, gate: ApprovalGate): string {
  if (option.kind === 'allow_once') return APPROVAL_COPY.allow
  if (option.kind === 'allow_always') return APPROVAL_COPY.allowSession
  return gate.kind === 'advisory' && Object.hasOwn(APPROVAL_OPTION_LABELS, option.kind) ? APPROVAL_OPTION_LABELS[option.kind] : option.label
}

/** A phone's preview starts folded; a longer one would push the input off the screen. */
const FOLD_ROWS = 7
const FOLD_ROWS_PHONE = 6

/**
 * A heading can be whatever the tool wrote about itself, so a request starts unfolded unless what it does is a diff of a
 * routine write: anything risky, any agent's ask, and any call whose arguments or reason are the only true account of it.
 */
function opensUnfolded(input: { hidden: boolean; risky: boolean; advisory: boolean; diffs: number; hasDetail: boolean }): boolean {
  return input.hidden || input.risky || input.advisory || (input.diffs === 0 && input.hasDetail)
}

/** The two buttons a drawer shows (one reject, then allow once or the first allow) and the rest of the offered choices. */
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

const typingOutsideComposer = (target: EventTarget | null) =>
  target instanceof Element
  && target.closest('input, textarea, select, [contenteditable="true"], [role="menu"], [role="dialog"], .ui-popover') !== null
  && !target.closest('.composer textarea')

/** Closed Sheets retain their dialog node; only open layers take Esc for themselves. */
const layerOpen = () => document.querySelector(':popover-open:not([role="tooltip"]), dialog[open]') !== null

/** Whether an Esc pressed where focus is now would refuse: not from another field or layer, nor over written text. */
function escapeRefusesAt(target: EventTarget | null): boolean {
  if (typingOutsideComposer(target)) return false
  if (layerOpen()) return false
  return !(target instanceof HTMLTextAreaElement && target.value.trim())
}

/** Where ⌘⏎ is taken: inside the card, and never from a field or a menu in it. */
const takesKeysAt = (target: EventTarget | null) =>
  !(target instanceof Element && target.closest('input, textarea, [role="menu"], .ui-popover'))

/** Esc refuses once: never while another layer is open or text is being written, and never by a held key. */
function useEscapeRefuses(active: boolean, card: RefObject<HTMLElement | null>, refuse: () => void): void {
  useEffect(() => {
    if (!active) return undefined
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (!cardTakesKeys(card.current)) return
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented || event.isComposing) return
      if (escapeIsLeftover(event)) return
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      if (!escapeRefusesAt(event.target)) return
      event.preventDefault()
      refuse()
    }
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('keydown', keydown)
    }
  }, [active, card, refuse])
}

/**
 * Whether ⌘⏎ may press this allow: a plain allow once of an ordinary request (R1, or any request of an older Host).
 * Never a high-risk request and never an agent's ask, which the Host treats as high risk.
 */
export function allowsByKey(gate: Pick<ApprovalGate, 'kind'>, allow: Pick<ApprovalOption, 'kind'>): boolean {
  return allow.kind === 'allow_once' && (gate.kind === 'R1' || gate.kind === 'legacy')
}

/**
 * The key caps on 拒绝 and 允许: each only while its key would do that now. ⌘⏎ allows an ordinary request of Latch 内置
 * (or an older Host's) from inside the card, never from a field, and never a high-risk request or an agent's ask; Esc
 * refuses from anywhere but another field or layer, and not while a note to send with the rejection is being written.
 * A phone draws none (touch screens hide them in `Button` too).
 */
export function approvalKeyCaps(input: {
  phone: boolean
  /** ⌘⏎ would allow: an armed, idle card whose plain allow is its one clear action (`shortcut`). */
  shortcut: boolean
  /** Esc would refuse: armed, idle, with a reject option. */
  escapes: boolean
  /** Focus is inside the card and not in a field or menu of it. */
  inCard: boolean
  /** Focus is where an Esc refuses. */
  escapeRefuses: boolean
  rejectLabel?: string | undefined
}): { allow?: string[]; reject?: string[] } {
  if (input.phone) return {}
  return {
    ...(input.shortcut && input.inCard ? { allow: ['mod', 'enter'] } : {}),
    ...(input.escapes && input.escapeRefuses && input.rejectLabel !== APPROVAL_COPY.rejectAndSend ? { reject: ['esc'] } : {}),
  }
}

/**
 * Where focus is, for the key caps: a cap is drawn only on a button its key presses at this moment. Read again whenever
 * focus moves or text is typed, from the same tests the key handlers use, so a cap and its key cannot disagree.
 */
function useKeyPlaces(card: RefObject<HTMLElement | null>): { inCard: boolean; escapeRefuses: boolean; numeric: boolean } {
  const [places, setPlaces] = useState({ inCard: false, escapeRefuses: false, numeric: false })
  useEffect(() => {
    const read = () => {
      const active = document.activeElement
      const inCard = card.current?.contains(active) === true && cardTakesKeys(card.current, active) && takesKeysAt(active)
      const escapeRefuses = escapeRefusesAt(active)
      const numeric =
        cardTakesKeys(card.current, active)
        && !(
          active instanceof Element
          && active.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], .ui-popover')
        )
      setPlaces(places =>
        places.inCard === inCard && places.escapeRefuses === escapeRefuses && places.numeric === numeric
          ? places
          : { inCard, escapeRefuses, numeric },
      )
    }
    read()
    const events = ['focusin', 'focusout', 'input', 'toggle'] as const
    for (const name of events) document.addEventListener(name, read, true)
    return () => {
      for (const name of events) document.removeEventListener(name, read, true)
    }
  }, [card])
  return places
}

export interface ApprovalDrawerProps {
  /** Independent workbench cards show their evidence and only take keys while focused. */
  presentation?: 'workbench' | 'conversation'
  emphasis?: boolean
  numberKeys?: boolean
  context?: ReactNode
  /** A personal Agent's name; its actual tool title and parameters stay visible. */
  requester?: string
  approvals: readonly Approval[]
  /** The tool rows of the transcript, for the words of what a request does. */
  messages: readonly Message[]
  /** Which request shows; the owner keeps it, since the composer writes to the same one. */
  index: number
  onIndex: (index: number) => void
  gateFor: (approval: Approval) => ApprovalGate
  busy: ReadonlyMap<string, string>
  statuses: ReadonlyMap<string, ApprovalStatus>
  onDecide: DecideHandler
  /** The word on 拒绝: it changes when typing would send what to do instead. */
  rejectLabel?: string | undefined
  onStop?: (() => void) | undefined
}

/**
 * The request the session waits on, joined to the composer and as wide as it: its title is what it asks to do, after
 * the amber glyph of its kind (a pencil for a write, a terminal for a command), with 查看改动 and the pager under it, and
 * 更多 · 拒绝 · 允许 beside it; a card on the workbench or in a conversation keeps the tool's ID behind the title's
 * tooltip, and folds its preview from 更多. A risky request
 * adds its red reason and the Host's sentence on a line of their own, an agent's ask the line that it is only advisory.
 * Buttons arm after 320ms, Enter does nothing, Esc refuses once and ⌘⏎ allows an ordinary request from inside the card;
 * a key's cap is drawn only while that key would do it. A routine diff unfolds in place on request; everything else
 * starts unfolded (see `opensUnfolded`), and content that hides characters never offers the broadest choices. A device
 * that may not allow sees why, under the request.
 */
export function ApprovalDrawer({
  approvals,
  messages,
  index,
  onIndex,
  gateFor,
  busy,
  statuses,
  onDecide,
  rejectLabel,
  onStop,
  presentation,
  emphasis = true,
  numberKeys = false,
  context,
  requester,
}: ApprovalDrawerProps) {
  const approval = approvals[Math.min(index, approvals.length - 1)]
  if (!approval) return null
  const message = messages.find(item => item.id === `tool:${approval.toolCallId}`) ?? null
  return (
    <ApprovalPanel
      key={approval.id}
      approval={approval}
      message={message}
      position={Math.min(index, approvals.length - 1)}
      total={approvals.length}
      onIndex={onIndex}
      gate={gateFor(approval)}
      busy={busy.get(approval.id)}
      status={statuses.get(approval.id)}
      onDecide={onDecide}
      rejectLabel={rejectLabel}
      onStop={onStop}
      presentation={presentation}
      emphasis={emphasis}
      numberKeys={numberKeys}
      context={context}
      requester={requester}
    />
  )
}

function ApprovalPanel({
  approval,
  message,
  position,
  total,
  onIndex,
  gate,
  busy,
  status,
  onDecide,
  rejectLabel,
  onStop,
  presentation,
  emphasis,
  numberKeys,
  context,
  requester,
}: {
  presentation?: 'workbench' | 'conversation'
  emphasis: boolean
  numberKeys: boolean
  context?: ReactNode
  requester?: string | undefined
  approval: Approval
  message: Message | null
  position: number
  total: number
  onIndex: (index: number) => void
  gate: ApprovalGate
  busy: string | undefined
  status: ApprovalStatus | undefined
  onDecide: DecideHandler
  rejectLabel?: string | undefined
  onStop?: (() => void) | undefined
}) {
  const phone = useViewport() === 'phone'
  const armed = useArmed(approval.id)
  const card = useRef<HTMLElement>(null)
  const places = useKeyPlaces(card)
  const tool = message?.tool ?? approval.tool
  const toolName = message?.toolName ?? approval.toolName
  // The tool's own title and ID both remain available to the approver.
  const action = toolHeading(tool, toolName)
  // A command is read whole before it is allowed: the one a shell wrapper carries, uncut, with the wrapper named under
  // it. Only where the call's own heading is that command; an agent's description of it stays as the agent wrote it.
  const reported = tool?.kind === 'execute' ? approvalCommand(tool, approval.arguments) : undefined
  // A long heading arrives cut with a marker at its end; its first 500 characters are the command's own.
  const command = reported?.reported.startsWith(action.slice(0, 500)) ? reported : undefined
  const what = command?.command ?? action
  const diffs = tool?.diffs ?? approval.tool?.diffs ?? []
  const path = diffs.length === 1 ? diffs[0]?.path : tool?.locations?.[0]
  const file = path?.split(/[\\/]/u).at(-1)
  const headingPath = toolHeadingPath(tool)
  const fileInHeading =
    diffs.length === 1
    && !!path
    && what === action
    && (headingPath === path
      || (!tool?.toolTitle
        && (tool?.title === path || (toolName === 'write_file' && (tool?.title === `写入 ${path}` || tool?.title === `写入文件 ${path}`)))))
  const heading = requester
    ? `${requester} ${tool?.kind === 'execute' ? '想运行一条命令' : tool?.kind === 'edit' && file ? `想改 ${file}` : `想执行：${action}`}`
    : what
  const hidden = approvalHidesText(approval, action, diffs)
  const quietReason =
    presentation
    && approval.risk === 'R1'
    && !approval.advisory
    && !hidden
    && approval.reason === '该工具可能修改项目文件或产生外部副作用，需要你确认本次操作。'
  // Against a previous file nobody could read, a count of removed lines would be made up.
  const stat = diffs.some(diff => ['unavailable', 'unknown'].includes(previousState(diff))) ? undefined : diffStat(tool)
  const running = busy !== undefined
  const uncertain = running ? undefined : status?.uncertain
  const failure = running ? undefined : status?.failure
  const previewId = useId()
  const args = argumentView(approval.tool?.input ?? approval.arguments)
  const hasDetail = args.kind !== 'empty' || (!!approval.reason && approval.reason !== action)
  const hasPreview = hasDetail || diffs.length > 0
  const covered = diffs.flatMap(diff => [diff.path, diff.newText])
  const risky = gate.kind === 'R2'
  // A high-risk request's sentence is the Host's own; it stands beside the red reason, word for word.
  const riskSentence = risky && approval.reason && approval.reason !== action ? approval.reason : undefined
  const [open, setOpen] = useState(
    () =>
      presentation !== undefined
      || opensUnfolded({
        hidden,
        risky: risky || approval.risk === 'R2',
        advisory: approval.advisory === true,
        diffs: diffs.length,
        hasDetail,
      }),
  )
  const { reject, allow, more } = approvalChoices(gate.options)
  const choose = (option: ApprovalOption) => {
    onDecide(approval, isAllow(option) ? 'allow' : 'reject', gate.explicit ? option.id : undefined)
  }
  // A risky request's allow is still the drawer's one clear action; hidden characters take that away.
  const primary = allow !== undefined && !hidden && uncertain === undefined
  const shortcut = primary && allowsByKey(gate, allow)
  const numbered = numberKeys && shortcut && armed && !running
  useEffect(() => {
    if (!numbered) return
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (!cardTakesKeys(card.current, event.target) || event.defaultPrevented || event.repeat || event.isComposing) return
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      if (
        event.target instanceof Element
        && event.target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], .ui-popover')
      )
        return
      const option = event.key === '1' ? reject : event.key === '2' ? allow : undefined
      if (!option) return
      event.preventDefault()
      choose(option)
    }
    document.addEventListener('keydown', keydown)
    return () => document.removeEventListener('keydown', keydown)
  }, [numbered, reject, allow, approval, gate, onDecide])
  // Content that may read as something else, or a choice in doubt, keeps the broadest choices out of reach.
  const offerMore = !hidden && uncertain === undefined
  // ⌘⏎ allows only while the card is ready, and Esc refuses only then.
  const escapes = armed && !running && reject !== undefined && (presentation !== 'workbench' || places.inCard)
  useEscapeRefuses(escapes, card, () => {
    if (reject) choose(reject)
  })
  const caps = approvalKeyCaps({ phone, shortcut: shortcut && armed && !running, escapes, ...places, rejectLabel })
  const keys = (event: KeyboardEvent<HTMLElement>) => {
    if (running || !armed || event.defaultPrevented) return
    if (!cardTakesKeys(card.current, event.target)) return
    if (!takesKeysAt(event.target)) return
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && shortcut && allow) {
      event.preventDefault()
      choose(allow)
    }
  }
  const previousNotes = (['unavailable', 'unknown'] as const)
    .filter(state => diffs.some(diff => previousState(diff) === state))
    .map(state => PREVIOUS_NOTES[state]!)
  // Read the already projected diff as a document for an ordinary one-file edit. Requests with additional safety
  // information retain the ordinary card and its complete preview.
  const documentReview =
    presentation === 'workbench'
    && requester === undefined
    && approval.risk === 'R1'
    && gate.kind === 'R1'
    && !approval.advisory
    && !hidden
    && !uncertain
    && !gate.note
    && tool?.kind === 'edit'
    && diffs.length === 1
    && previousNotes.length === 0
  const uncertainOption =
    uncertain && (gate.options.find(option => option.id === uncertain.optionId) ?? (uncertain.decision === 'allow' ? allow : reject))
  const menuItems: MenuItem[] = [
    ...(offerMore
      ? more.map(option => ({
          id: option.id,
          label: optionLabel(option, gate),
          ...(running ? { disabledReason: APPROVAL_COPY.moreBusy } : {}),
          onSelect: () => {
            choose(option)
          },
        }))
      : []),
    ...(hasPreview && open ? [{ id: '~fold', label: APPROVAL_COPY.hidePreview, onSelect: () => setOpen(false) }] : []),
    ...(onStop ? [{ id: '~stop', label: APPROVAL_COPY.stopTurn, onSelect: onStop }] : []),
  ]
  const toolId = presentation && toolName && toolName !== action ? toolName : undefined
  // A work-scope device receives the location without the diff.
  const singleWriteTarget =
    headingPath !== undefined
    && (tool?.locations?.length ?? 0) <= 1
    && (fileInHeading || (diffs.length === 0 && tool?.locations?.[0] === headingPath))
  // A phone can read the known file tool in 更多 when the complete action is visible and the menu is available.
  const toolInMenu =
    presentation === 'workbench'
    && phone
    && quietReason
    && offerMore
    && !running
    && toolId === 'write_file'
    && tool?.kind === 'edit'
    && singleWriteTarget
    && action === `写入文件 ${headingPath}`
    && menuItems.length > 0
  // The glyph says what kind of decision this is; any other tool's request takes the mark of waiting.
  const kindIcon = tool?.kind === 'execute' ? TerminalGlyph : tool?.kind === 'edit' || diffs.length > 0 ? EditGlyph : WaitingGlyph
  // One name at every width: a button with its chevron on a desk, a full row that opens a sheet on a phone.
  const moreTrigger = (props: MenuTriggerProps) => (
    <Button {...props} variant="ghost" size={phone ? 'lg' : 'md'} menu block={phone} className="approval-more" disabled={running}>
      {APPROVAL_COPY.moreChoices}
    </Button>
  )
  const moreMenu =
    menuItems.length > 0 ? (
      <Menu
        label={APPROVAL_COPY.moreChoices}
        align="end"
        side="top"
        {...(toolInMenu ? { header: { title: toolId } } : {})}
        sections={[{ id: 'more', items: menuItems }]}
        trigger={moreTrigger}
      />
    ) : null
  const button = (option: ApprovalOption, variant: 'primary' | 'outline', label: string, keys: string[] | undefined): ReactNode => {
    const pressed = busy === option.id
    return (
      <Button
        key={option.id}
        variant={variant === 'primary' && !emphasis ? 'outline' : variant}
        size={phone ? 'lg' : 'md'}
        keys={keys}
        showKeys={false}
        tooltip={label === option.label ? undefined : option.label}
        loading={pressed}
        disabled={!armed || (running && !pressed)}
        onClick={() => {
          choose(option)
        }}>
        {label}
      </Button>
    )
  }
  return (
    <section
      className="composer-drawer approval-panel"
      data-secure=""
      data-presentation={presentation}
      data-document-review={documentReview && open ? '' : undefined}
      data-single-file={fileInHeading ? '' : undefined}
      data-risky={risky ? '' : undefined}
      data-approval-id={approval.id}
      data-risk={approval.advisory ? 'advisory' : approval.risk}
      data-arming={armed ? undefined : ''}
      aria-label="待批准操作"
      ref={card}
      onKeyDown={keys}>
      <div className="approval-row">
        <div className="approval-what">
          <div className="approval-title">
            <span className="approval-kind" aria-hidden="true">
              <Icon icon={kindIcon} size={16} />
            </span>
            <Tooltip content={toolId && escapeHiddenCharacters(toolId)}>
              {command && !requester ? (
                <ApprovalCommand className="approval-object is-command" text={heading} />
              ) : (
                <span className="approval-object">
                  <VisibleText text={heading} />
                </span>
              )}
            </Tooltip>
            {stat && (
              <span className="approval-stat">
                <span className="stat-add">+{stat.add}</span>
                {stat.del > 0 && <span className="stat-del"> −{stat.del}</span>}
              </span>
            )}
            {toolId && !toolInMenu && (
              <code className="workbench-tool-name">
                <VisibleText text={toolId} />
              </code>
            )}
          </div>
          <div className="approval-meta">
            {requester
              && heading !== what
              && (command ? (
                <ApprovalCommand className="approval-command" text={what} />
              ) : (
                <span>
                  <VisibleText text={what} />
                </span>
              ))}
            {command?.shell && <span className="approval-shell">经 {command.shell}</span>}
            {context}
            {!presentation && toolName && toolName !== action && (
              <code className="tool-card-name">
                <VisibleText text={toolName} />
              </code>
            )}
            {approval.subagent && (
              <span className="approval-subagent">
                子 Agent · <VisibleText text={approval.subagent} />
              </span>
            )}
            {hasPreview && !open && (
              <Button
                variant="outline"
                size="xs"
                className="approval-see"
                aria-expanded={false}
                aria-controls={previewId}
                onClick={() => {
                  setOpen(true)
                }}>
                {diffs.length > 0 ? APPROVAL_COPY.viewChange : APPROVAL_COPY.viewDetail}
              </Button>
            )}
            {total > 1 && (
              <span className="approval-pager">
                <IconButton
                  size="xs"
                  icon={ChevronLeftGlyph}
                  label="上一个"
                  disabled={position === 0}
                  onClick={() => {
                    onIndex(position - 1)
                  }}
                />
                <span>{APPROVAL_COPY.drawerCount(position + 1, total)}</span>
                <IconButton
                  size="xs"
                  icon={ChevronRightGlyph}
                  label="下一个"
                  disabled={position === total - 1}
                  onClick={() => {
                    onIndex(position + 1)
                  }}
                />
              </span>
            )}
          </div>
        </div>
        <div className="approval-buttons" data-single={allow === undefined ? '' : undefined}>
          {moreMenu}
          {reject
            && button(
              reject,
              'outline',
              rejectLabel ?? optionLabel(reject, gate),
              numbered ? (!phone && places.numeric ? ['1'] : undefined) : caps.reject,
            )}
          {allow
            && button(
              allow,
              primary ? 'primary' : 'outline',
              optionLabel(allow, gate),
              numbered ? (!phone && places.numeric ? ['2'] : undefined) : caps.allow,
            )}
        </div>
      </div>
      {(risky || gate.note || hidden || previousNotes.length > 0 || gate.hint) && (
        <div className="approval-notes">
          {risky && (
            <div className="approval-clause">
              <span className="approval-clause-reason">{RISK_CLAUSE(approval.riskReason)}</span>
              {/* The short fact stays in sight; the Host's own sentence is one press away. */}
              {riskSentence ? (
                <Hint className="approval-clause-sentence" lead={<span />} label={APPROVAL_COPY.confirmEachTime}>
                  <VisibleText text={riskSentence} />
                </Hint>
              ) : (
                <span className="approval-clause-sentence">{APPROVAL_COPY.confirmEachTime}</span>
              )}
            </div>
          )}
          {gate.note && (
            <Hint className="approval-note" lead={<Icon icon={WarningGlyph} size={12} />} label={gate.note.label}>
              {gate.note.detail}
            </Hint>
          )}
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
          {gate.hint && (
            <p className="approval-hint">
              <LockGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
              {gate.hint}
            </p>
          )}
        </div>
      )}
      {hasPreview && (
        <div className="approval-preview" id={previewId} data-open={open ? '' : undefined}>
          <div className="approval-preview-inner" inert={!open}>
            {documentReview && (
              <div className="approval-document-header">
                {fileInHeading && path && (
                  <code>
                    <VisibleText text={path} />
                  </code>
                )}
                <span>拟议改动</span>
              </div>
            )}
            {!quietReason && approval.reason && approval.reason !== action && approval.reason !== riskSentence && (
              <p className="approval-reason">
                <VisibleText text={approval.reason} />
              </p>
            )}
            <ArgumentList text={approval.tool?.input ?? approval.arguments} covered={covered} quiet={diffs.length > 0} />
            <DiffView diffs={diffs} fold={phone ? FOLD_ROWS_PHONE : FOLD_ROWS} />
          </div>
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
          }
        />
      )}
    </section>
  )
}
