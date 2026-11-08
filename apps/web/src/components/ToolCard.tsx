import { Fragment, memo, useId, useMemo, useRef, useState } from 'react'
import { ChevronRight, CircleDashed, CircleSlash, FileDiff as FileDiffIcon, FilePlus, RotateCcw, Scale, TimerOff, X } from 'lucide-react'
import type { Approval, FileDiff, Message, ToolDecision, ToolDetail } from '@latch/protocol'
import { previousState } from '../diff.ts'
import {
  blockedLine,
  blockedReason,
  decisionLine,
  diffStat,
  failureReason,
  hasDiffs,
  isReview,
  ranDespite,
  shownToolOutput,
  shownToolState,
  toolDuration,
  toolHeading,
  toolLabel,
  unrunOutcome,
  type ShownToolState,
} from '../conversation.ts'
import { useChangesLink } from '../conversation/changesLink.ts'
import { hostNow, useTicker } from '../core/hostClock.ts'
import { argumentView, formatDuration } from '../format.ts'
import { toolKind, toolKindIcons } from '../icons.tsx'
import { ArgumentList } from './ArgumentList.tsx'
import { DiffView, type DiffViewFile } from './DiffView.tsx'
import { FileChip, FileRootContext } from './FileChip.tsx'
import { toolFileTargets, useKnownFiles } from './FileReferences.tsx'
import { DecisionRecord, DecisionWords } from './DecisionRecord.tsx'
import { JUDGED_COPY } from '../core/securityCopy.ts'
import { Button, Collapse, ICON_STROKE, StatusGlyph, StatusWords, CopyButton } from '@latch/ui'
import { SyntaxLine, useHighlightedTokens } from '../preview/HighlightedCode.tsx'
import { useSeen } from '../preview/viewportGate.ts'
import { colouredRowCount, outputGrammar, readOutputLanguage, sourceView } from './toolOutputCode.ts'
import { VisibleText } from './VisibleText.tsx'

type ToolState = NonNullable<Message['state']>
/**
 * Words for the states a row names; a running or finished tool says it through its icon and duration instead. A call its
 * approval kept from running is not a failure: it reads by its record (「已拒绝 · 14:32」), never red, and so does one the
 * harness refused itself (拦下, who and why on the line under it). A failed row says why on the line under it.
 */
const stateWords: Partial<Record<ShownToolState, string>> = {
  cancelled: '已取消',
  rejected: '已拒绝',
  expired: '已过期',
  blocked: JUDGED_COPY.denied,
}

const sameDiffs = (a: FileDiff[] | undefined, b: FileDiff[] | undefined) =>
  a === b
  || (a?.length === b?.length
    && (a ?? []).every((diff, index) => {
      const other = b![index]!
      return (
        diff.path === other.path && diff.oldText === other.oldText && diff.newText === other.newText && diff.previous === other.previous
      )
    }))
const sameDecision = (a: ToolDecision | undefined, b: ToolDecision | undefined) =>
  a === b || (a?.outcome === b?.outcome && a?.at === b?.at && a?.via === b?.via)
const sameTool = (a: ToolDetail | undefined, b: ToolDetail | undefined) =>
  a === b
  || (a !== undefined
    && b !== undefined
    && a.kind === b.kind
    && a.title === b.title
    && a.toolTitle === b.toolTitle
    && a.input === b.input
    && a.output === b.output
    && a.locations?.join('\n') === b.locations?.join('\n')
    && sameDiffs(a.diffs, b.diffs)
    && sameDecision(a.decision, b.decision)
    && a.judged?.outcome === b.judged?.outcome
    && a.judged?.by === b.judged?.by
    && a.blocked?.by === b.blocked?.by
    && a.blocked?.source === b.blocked?.source
    && a.blocked?.reason === b.blocked?.reason)

/** How long the tool ran, ticking every second while it runs and frozen once it settles; nothing under a second. */
function ToolTime({ message, frozen }: { message: Message; frozen: boolean }) {
  useTicker(message.state === 'running' && !frozen ? 'second' : false)
  const duration = toolDuration(message, hostNow())
  const text = duration ? formatDuration(duration.ms, duration.live) : undefined
  if (!text) return null
  return <span className="process-time">{text}</span>
}

/**
 * Live output keeps its newest lines in view while it streams without writing a scroll position: the box is laid out
 * from its end (column-reverse), so it stays at the bottom until the reader scrolls up inside it, and stays where the
 * reader left it after that.
 */
function ToolOutput({ text, running, language }: { text: string; running: boolean; language?: string }) {
  const box = useRef<HTMLDivElement>(null)
  const seen = useSeen(box)
  return (
    <div ref={box} className={`tool-output-scroll ${running ? 'is-live' : ''}`}>
      <pre className="tool-pre tool-output">
        {language ? <SourceOutput text={text} language={language} enabled={seen} /> : <VisibleText text={text} />}
      </pre>
      {!running && <CopyButton text={text} label="复制输出" size="xs" className="tool-output-copy" />}
    </div>
  )
}

/**
 * A file's text as a read reported it: plain until its tokens arrive, and the same characters afterwards, so colour lands
 * without moving anything. An agent's line numbers and wrapper lines stay out of the grammar.
 */
function SourceOutput({ text, language, enabled }: { text: string; language: string; enabled: boolean }) {
  const view = useMemo(() => sourceView(text), [text])
  const grammar = useMemo(() => outputGrammar(text, language), [text, language])
  const tokens = useHighlightedTokens(view.body, grammar, enabled)
  return useMemo(() => {
    if (!tokens) return <VisibleText text={view.text} />
    const count = colouredRowCount(view.rows, tokens)
    const coloured = view.rows.slice(0, count)
    const rest = view.rows.slice(count)
    return (
      <>
        {coloured.map((row, index) => (
          <Fragment key={index}>
            {row.gutter && (
              <span className="syn-comment">
                <VisibleText text={row.gutter} />
              </span>
            )}
            <SyntaxLine text={row.text} tokens={row.line === undefined ? undefined : tokens[row.line]} />
            {index < view.rows.length - 1 && '\n'}
          </Fragment>
        ))}
        {rest.length > 0 && <VisibleText text={rest.map(row => row.gutter + row.text).join('\n')} />}
      </>
    )
  }, [tokens, view])
}

/**
 * One tool call as a work row: the kind's icon (a spinner while it runs, a red ✕ when it failed), what it does with its
 * object and the lines it changed, and its duration under the pointer. A failed row says why on one line, with 重试 when
 * this device may resend the turn. Opening a row shows what it did indented under its words: a file edit's short preview
 * (never while the right panel is open: there the row stays one line and selects its file in 改动), otherwise its
 * arguments and output. A pending approval is decided in the drawer above the composer; here the row only says what it is.
 */
export const ToolCard = memo(
  function ToolCard({
    message,
    approval,
    onRetry,
    frozen = false,
  }: {
    message: Message | null
    approval?: Approval
    /** Resends the turn; present when this device may, on the latest turn. */
    onRetry?: () => void
    /** Nothing is known to move: the connection is down, so the row stops spinning and ticking. */
    frozen?: boolean
  }) {
    const bodyId = useId()
    const link = useChangesLink()
    const state: ToolState = message?.state ?? (approval ? 'awaiting-approval' : 'completed')
    const facts = message ? { ...message, state } : undefined
    // What the row says: a call its approval kept from running reads by how the approval ended. A call that started
    // keeps its own state whatever its record says (an agent's ask is advisory).
    const shown: ShownToolState = facts ? shownToolState(facts) : state
    const unrun = facts ? unrunOutcome(facts) : undefined
    const contradicted = facts ? ranDespite(facts) : undefined
    const decision = message?.tool?.decision
    const tool = message?.tool ?? approval?.tool
    const toolName = message?.toolName ?? approval?.toolName ?? ''
    const title = toolHeading(tool, toolName)
    const label = toolLabel({ tool, toolName, state })
    const kind = toolKind({ tool, toolName })
    const diffs = tool?.diffs ?? approval?.tool?.diffs ?? []
    // While a call runs its plain-text form is still its input; only what it reported is output.
    const output = state === 'running' ? (tool?.output ?? '') : facts ? shownToolOutput(facts) : ''
    const language = state === 'completed' && message ? readOutputLanguage(message) : undefined
    const running = state === 'running' && !frozen
    const [choice, setChoice] = useState<boolean | null>(null)
    // The diff of a call its approval kept from running, or the harness refused, is no evidence of a change.
    const applied = !approval && message !== null && hasDiffs(message) && unrun === undefined && shown !== 'blocked'
    const newFile = applied && diffs.length === 1 && previousState(diffs[0]!) === 'none'
    // A new file says its length in its words; its added lines would only repeat that.
    const stat = useMemo(() => (applied && !newFile ? diffStat(tool) : undefined), [applied, newFile, tool])
    // A command that streams output shows its tail while it runs and folds when it settles, unless the reader chose.
    const open = approval ? false : (choice ?? (running && kind === 'execute' && output.length > 0))
    const panelEdit = applied && link?.panelOpen === true
    const selected = panelEdit && diffs.some(diff => diff.path === link.selected?.path)
    const showOutput = message !== null && state !== 'awaiting-approval' && state !== 'queued'
    // In the desktop app, the files a finished tool read or wrote become path chips once the Host says they are files.
    const input = argumentView(tool?.input)
    const folder = input.kind === 'entries' ? input.entries.find(([key]) => key === 'folder')?.[1] : undefined
    const rootId = folder && /^[A-Za-z0-9_-]{1,32}$/u.test(folder) ? folder : undefined
    const files = useKnownFiles(message ? toolFileTargets(message) : [], state === 'completed' || state === 'failed', rootId)
    const failed = shown === 'failed'
    const block = shown === 'blocked' ? tool?.blocked : undefined
    const wholeReason = block ? blockedReason(block) : undefined
    const judged = tool?.judged
    const review = isReview(tool)
    // A judgement's words, once its call settled: the review's verdict, or that the call ran without an ask.
    const judgedWords =
      judged && (state === 'completed' || state === 'failed') && !(state === 'failed' && judged.outcome === 'unasked')
        ? JUDGED_COPY[judged.outcome]
        : undefined
    const KindIcon = newFile ? FilePlus : review ? Scale : toolKindIcons[kind]
    const glyph = failed ? (
      <X className="process-failed" size={12} strokeWidth={ICON_STROKE[12]} />
    ) : shown === 'cancelled' || shown === 'rejected' || shown === 'blocked' ? (
      <CircleSlash size={16} strokeWidth={ICON_STROKE[16]} />
    ) : shown === 'expired' ? (
      <TimerOff size={16} strokeWidth={ICON_STROKE[16]} />
    ) : state === 'queued' ? (
      <CircleDashed size={16} strokeWidth={ICON_STROKE[16]} />
    ) : (
      <KindIcon size={16} strokeWidth={ICON_STROKE[16]} />
    )
    const openInChanges = (diff: DiffViewFile) => {
      link?.open({ path: diff.path, ...(rootId ? { root: rootId } : {}) })
    }
    // The row's tooltip: the call's full heading when the row shortens it, a titled tool's ID, and an allowance's record.
    const tooltip = [
      title !== label.object ? title : undefined,
      tool?.toolTitle && toolName && toolName !== label.object ? toolName : undefined,
      decision?.outcome === 'allowed' ? decisionLine(decision, 0).full : undefined,
      block
        ? block.source === 'model'
          ? JUDGED_COPY.reviewNote(block.by)
          : JUDGED_COPY.ruleNote(block.by)
        : judged
          ? review
            ? JUDGED_COPY.reviewNote(judged.by)
            : JUDGED_COPY.unaskedNote(judged.by)
          : undefined,
    ]
      .filter(Boolean)
      .join('\n')
    // A state change the page saw happen: the spinner and the result icon cross-fade and the new words fade in.
    const heading = (
      <>
        <StatusGlyph className="tool-card-icon process-slot" running={running} state={shown}>
          {glyph}
        </StatusGlyph>
        <StatusWords state={label.verb ? 'row' : 'title'} className="process-label">
          {label.verb && <span className="process-verb">{label.verb}</span>}
          <span className={label.mono ? 'process-object is-mono' : 'process-object'}>
            <VisibleText text={label.object} />
          </span>
        </StatusWords>
        {stat && (
          <span className="process-stat">
            <span className="stat-add">+{stat.add}</span> <span className="stat-del">−{stat.del}</span>
          </span>
        )}
      </>
    )
    const stateSlot = (
      <StatusWords state={shown} className={`tool-card-state state-${shown}`}>
        {state === 'awaiting-approval' ? null : decision
          && (unrun || (decision.outcome === 'allowed' && (state === 'completed' || state === 'running'))) ? (
          <DecisionWords decision={decision} />
        ) : (
          (stateWords[shown] ?? judgedWords)
        )}
      </StatusWords>
    )
    const hasDetails = !panelEdit
    return (
      <FileRootContext.Provider value={rootId}>
        <article
          className={`tool-card tool-${shown}`}
          data-kind={newFile ? 'new' : kind}
          data-open={open && hasDetails ? '' : undefined}
          data-selected={selected ? '' : undefined}
          {...(message ? { 'data-message-id': message.id } : {})}>
          <div className="tool-tray">
            <button
              type="button"
              className="tool-card-header"
              aria-expanded={hasDetails ? open : undefined}
              aria-controls={hasDetails ? bodyId : undefined}
              title={tooltip || undefined}
              onClick={() => {
                if (panelEdit) openInChanges(diffs[0]!)
                else setChoice(!open)
              }}>
              {heading}
              {hasDetails && <ChevronRight className="process-chevron" size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />}
              <span className="process-fill" />
              <span className="process-end">
                {stateSlot}
                {message && <ToolTime message={message} frozen={frozen} />}
              </span>
            </button>
            {block && (
              <p className="tool-block-line">
                <VisibleText text={blockedLine(block)} />
              </p>
            )}
            {failed && (
              <p className="tool-failure">
                <VisibleText text={failureReason(message ?? { text: '' })} />
                {onRetry && (
                  <Button size="xs" variant="ghost" icon={RotateCcw} onClick={onRetry}>
                    重试
                  </Button>
                )}
              </p>
            )}
            {hasDetails && (
              <Collapse
                id={bodyId}
                open={open}
                lazy
                onReveal={() => {
                  setChoice(true)
                }}>
                <div className="tool-card-body">
                  {applied && link && (
                    <DiffView
                      diffs={diffs}
                      mode="compact"
                      fileActions={diff => (
                        <Button
                          size="xs"
                          variant="ghost"
                          icon={FileDiffIcon}
                          onClick={() => {
                            openInChanges(diff)
                          }}>
                          {previousState(diff) === 'none' ? '打开文件' : '在改动中打开'}
                        </Button>
                      )}
                    />
                  )}
                  {applied && !link && <DiffView diffs={diffs} mode="compact" />}
                  {!applied && files.length > 0 && (
                    <p className="tool-files">
                      {files.map(path => (
                        <FileChip key={path} path={path} />
                      ))}
                    </p>
                  )}
                  {wholeReason && (
                    <p className="tool-block-reason">
                      <VisibleText text={wholeReason} />
                    </p>
                  )}
                  {/* A review's input is the agent's whole event, its status still the one it began with: its own words say it. */}
                  {review ? (
                    <p className="muted-line">{JUDGED_COPY.reviewNote(judged!.by)}</p>
                  ) : (
                    !applied && <ArgumentList text={tool?.input} covered={[label.object]} quiet />
                  )}
                  {showOutput
                    && !applied
                    && (output ? (
                      <ToolOutput text={output} running={running} language={language} />
                    ) : (
                      !running && <p className="muted-line">没有输出</p>
                    ))}
                </div>
              </Collapse>
            )}
          </div>
          {/* A call the agent reports as run after it was not allowed: one line under the row says so. */}
          {contradicted && <DecisionRecord decision={contradicted} />}
        </article>
      </FileRootContext.Provider>
    )
  },
  (a, b) =>
    a.approval === b.approval
    && a.onRetry === b.onRetry
    && a.frozen === b.frozen
    && (a.message === b.message
      || (a.message !== null
        && b.message !== null
        && a.message.id === b.message.id
        && a.message.text === b.message.text
        && a.message.state === b.message.state
        && a.message.toolName === b.message.toolName
        && a.message.createdAt === b.message.createdAt
        && a.message.startedAt === b.message.startedAt
        && a.message.completedAt === b.message.completedAt
        && sameTool(a.message.tool, b.message.tool))),
)
