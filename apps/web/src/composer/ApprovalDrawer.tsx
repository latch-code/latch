import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, Ellipsis, LockKeyhole, Shield } from 'lucide-react'
import type { Approval, ApprovalOption, FileDiff, Message } from '@latch/protocol'
import { Button, ICON_STROKE, IconButton, InlineNotice, Menu, type MenuItem, type MenuTriggerProps } from '@latch/ui'
import { useViewport } from '../breakpoints.ts'
import { escapeIsLeftover } from '../escapeGrace.ts'
import { previousState } from '../diff.ts'
import { argumentView } from '../format.ts'
import { diffStat, toolHeading } from '../conversation.ts'
import type { ApprovalGate } from '../core/permissions.ts'
import { APPROVAL_COPY, APPROVAL_OPTION_LABELS, CONFIRMATION_COPY, RISK_CLAUSE } from '../core/securityCopy.ts'
import { ArgumentList } from '../components/ArgumentList.tsx'
import { DiffView, PREVIOUS_NOTES } from '../components/DiffView.tsx'
import { hasHiddenCharacters, VisibleText } from '../components/VisibleText.tsx'
import { useArmed } from './useArmed.ts'

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
    [title, approval.toolName, approval.reason, approval.tool?.input ?? approval.arguments].some(text => hasHiddenCharacters(text))
    || diffs.some(diff => hasHiddenCharacters(diff.path) || hasHiddenCharacters(diff.newText) || hasHiddenCharacters(diff.oldText))
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

/** Esc refuses once: never while another layer is open or text is being written, and never by a held key. */
function useEscapeRefuses(active: boolean, refuse: () => void): void {
  useEffect(() => {
    if (!active) return undefined
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented || event.isComposing) return
      if (escapeIsLeftover(event)) return
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      if (typingOutsideComposer(event.target)) return
      if (document.querySelector(':popover-open:not([role="tooltip"]), dialog[open], .ui-sheet')) return
      const composer = event.target instanceof HTMLTextAreaElement ? event.target : null
      if (composer?.value.trim()) return
      event.preventDefault()
      refuse()
    }
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('keydown', keydown)
    }
  }, [active, refuse])
}

export interface ApprovalDrawerProps {
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
 * The request the session waits on, attached above the composer: amber words, what it does and to what, the pager, and
 * at most two buttons with the rest behind ⋯. A risky request is taller, with its reason on its own red line. Buttons arm
 * after 320ms, Enter does nothing, and Esc refuses once. A routine diff unfolds in place on request; everything else
 * starts unfolded (see `opensUnfolded`), and content that hides characters never offers the broadest choices. A device
 * that may not allow sees where it can, beside 拒绝.
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
}: {
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
  const tool = message?.tool ?? approval.tool
  const toolName = message?.toolName ?? approval.toolName
  // The tool's own title and its ID are what the approver weighs against each other, so the drawer always shows both.
  const action = toolHeading(tool, toolName)
  const diffs = tool?.diffs ?? approval.tool?.diffs ?? []
  const hidden = approvalHidesText(approval, action, diffs)
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
  const [open, setOpen] = useState(() =>
    opensUnfolded({
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
  const shortcut = primary && allow.kind === 'allow_once' && (gate.kind === 'R1' || gate.kind === 'legacy')
  // Content that may read as something else, or a choice in doubt, keeps the broadest choices out of reach.
  const offerMore = !hidden && uncertain === undefined
  useEscapeRefuses(armed && !running && reject !== undefined, () => {
    if (reject) choose(reject)
  })
  const keys = (event: KeyboardEvent<HTMLElement>) => {
    if (running || !armed || event.defaultPrevented) return
    if (event.target instanceof Element && event.target.closest('input, textarea, [role="menu"], .ui-popover')) return
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && shortcut && allow) {
      event.preventDefault()
      choose(allow)
    }
  }
  const previousNotes = (['unavailable', 'unknown'] as const)
    .filter(state => diffs.some(diff => previousState(diff) === state))
    .map(state => PREVIOUS_NOTES[state]!)
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
    ...(onStop ? [{ id: '~stop', label: APPROVAL_COPY.stopTurn, onSelect: onStop }] : []),
  ]
  const moreTrigger = (props: MenuTriggerProps) =>
    phone ? (
      <Button {...props} variant="ghost" size="lg" block className="approval-more" disabled={running}>
        {APPROVAL_COPY.moreSheet}
      </Button>
    ) : (
      <IconButton {...props} label={APPROVAL_COPY.more} icon={Ellipsis} className="approval-more" disabled={running} />
    )
  const moreMenu =
    menuItems.length > 0 ? (
      <Menu label={APPROVAL_COPY.more} align="end" side="top" sections={[{ id: 'more', items: menuItems }]} trigger={moreTrigger} />
    ) : null
  const button = (option: ApprovalOption, variant: 'primary' | 'outline', label: string): ReactNode => {
    const pressed = busy === option.id
    return (
      <Button
        key={option.id}
        variant={variant}
        size={phone ? 'lg' : 'sm'}
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
      data-risky={risky ? '' : undefined}
      data-approval-id={approval.id}
      data-risk={approval.advisory ? 'advisory' : approval.risk}
      data-arming={armed ? undefined : ''}
      aria-label="待批准操作"
      onKeyDown={keys}>
      <div className="approval-row">
        <div className="approval-what">
          <div className="approval-title">
            <Shield className="approval-shield" size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
            <span>{APPROVAL_COPY.waiting}</span>
            {total > 1 && (
              <span className="approval-pager">
                <IconButton
                  size="xs"
                  icon={ChevronLeft}
                  label="上一个"
                  disabled={position === 0}
                  onClick={() => {
                    onIndex(position - 1)
                  }}
                />
                <span>{APPROVAL_COPY.drawerCount(position + 1, total)}</span>
                <IconButton
                  size="xs"
                  icon={ChevronRight}
                  label="下一个"
                  disabled={position === total - 1}
                  onClick={() => {
                    onIndex(position + 1)
                  }}
                />
              </span>
            )}
          </div>
          <div className="approval-action">
            <span className="approval-object">
              <VisibleText text={action} />
            </span>
            {stat && (
              <span className="approval-stat">
                <span className="stat-add">+{stat.add}</span>
                {stat.del > 0 && <span className="stat-del"> −{stat.del}</span>}
              </span>
            )}
            {hasPreview && (
              <button
                type="button"
                className="approval-see"
                aria-expanded={open}
                aria-controls={previewId}
                onClick={() => {
                  setOpen(!open)
                }}>
                {open ? APPROVAL_COPY.hidePreview : diffs.length > 0 ? APPROVAL_COPY.viewChange : APPROVAL_COPY.viewDetail}
              </button>
            )}
          </div>
          {toolName && toolName !== action && (
            <code className="tool-card-name">
              <VisibleText text={toolName} />
            </code>
          )}
          {risky && <p className="approval-clause">{RISK_CLAUSE(approval.riskReason)}</p>}
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
          {gate.hint && (
            <p className="approval-hint">
              <LockKeyhole size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
              {gate.hint}
            </p>
          )}
        </div>
        <div className="approval-buttons" data-single={allow === undefined ? '' : undefined}>
          {reject && button(reject, 'outline', rejectLabel ?? optionLabel(reject, gate))}
          {allow && button(allow, primary ? 'primary' : 'outline', optionLabel(allow, gate))}
          {moreMenu}
        </div>
      </div>
      {hasPreview && (
        <div className="approval-preview" id={previewId} data-open={open ? '' : undefined}>
          <div className="approval-preview-inner" inert={!open}>
            {approval.reason && approval.reason !== action && (
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
          }>
          {APPROVAL_COPY.uncertain}
        </InlineNotice>
      )}
    </section>
  )
}
