import { Fragment, memo, useContext, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Camera, CircleDashed, FolderOpen, RotateCcw, TimerOff } from 'lucide-react'
import type { Approval, FileDiff, Message, ToolDecision, ToolDetail } from '@latch/protocol'
import { previousState } from '../diff.ts'
import {
  blockedLine,
  blockedReason,
  approvalCommand,
  commandLine,
  decisionLine,
  diffStat,
  failureReason,
  hasDiffs,
  isReview,
  ranDespite,
  rowKind,
  shownToolOutput,
  withoutToolCode,
  shownToolState,
  toolDuration,
  toolHeading,
  toolLabel,
  unrunOutcome,
  type CommandLine,
  type ShownToolState,
} from '../conversation.ts'
import { useChangesLink } from '../conversation/changesLink.ts'
import { hostNow, useTicker } from '../core/hostClock.ts'
import { argumentView, basename, formatDuration } from '../format.ts'
import { TerminalFillButton } from './TerminalFillButton.tsx'
import { PlanText } from '../composer/ApprovalDrawer.tsx'
import { ArgumentList } from './ArgumentList.tsx'
import { DiffView, type DiffViewFile } from './DiffView.tsx'
import { FileChip, FileRootContext, FileSession, type FileSessionInfo } from './FileChip.tsx'
import { toolFileTargets, useKnownFiles } from './FileReferences.tsx'
import { DecisionRecord, DecisionWords } from './DecisionRecord.tsx'
import { MessageAttachments } from './MessageAttachments.tsx'
import { JUDGED_COPY } from '../core/securityCopy.ts'
import {
  Button,
  Collapse,
  Hint,
  Icon,
  ICON_STROKE,
  StatusGlyph,
  StatusWords,
  CopyButton,
  useCopy,
  ChevronRightGlyph,
  BlockedGlyph,
  AlertGlyph,
  DiffGlyph,
  CloseGlyph,
  CheckGlyph,
  ChevronDownGlyph,
  ChevronUpGlyph,
  Tooltip,
  WarningGlyph,
} from '@latch/ui'
import { bypassesComputer } from '../conversation/computerBypass.ts'
import { SyntaxLine, useHighlightedTokens } from '../preview/HighlightedCode.tsx'
import { useSeen } from '../preview/viewportGate.ts'
import { colouredRowCount, outputGrammar, readOutputLanguage, sourceView } from './toolOutputCode.ts'
import { VisibleText } from './VisibleText.tsx'
import { stripAnsi } from '../conversation/ansi.ts'
import { AnsiText, ShellLine } from '../conversation/CommandText.tsx'
import { commandFolder, reportedFolder } from '../conversation/commandView.ts'
import { KindGlyph, type RowKind } from '../conversation/KindGlyph.tsx'
import { defineCopy, useLocale, formatNumber, plural } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    cancelled: '已取消',
    denied: '已拒绝',
    expired: '已过期',
    unknown: '结果未知',
    copyOutput: '复制输出',
    less: '收起',
    allLines: (count: number) => `展开全部 ${formatNumber(count)} 行`,
    copyRaw: (value1: string | number) => `复制原始命令：${value1}`,
    copiedRaw: '已复制原始命令',
    copyUnavailable: '复制不可用',
    done: '完成',
    failed: '失败',
    noOutput: '没有输出',
    copyCommand: '复制命令',
    outsideControl: '直接运行 Cua，没有经过「操控这台 Mac」的开关与记录',
    bypassedMac: '绕过操控这台 Mac',
    interruptedUnknown: '已中断 · 结果未知',
    interrupted: '已中断',
    screenshotTitle: '截图会发给模型服务',
    screenshotInfo: 'Agent 的截图作为工具结果交给模型服务；页面上的个人信息不会自动打码。',
    retry: '重试',
    open: '打开文件',
    openChanges: '在改动中打开',
  },
  {
    cancelled: 'Cancelled',
    denied: 'Denied',
    expired: 'Expired',
    unknown: 'Outcome unknown',
    copyOutput: 'Copy output',
    less: 'Show less',
    allLines: (count: number) => `Show all ${plural(count, { one: '{n} line', other: '{n} lines' })}`,
    copyRaw: (value1: string | number) => `Copy original command: ${value1}`,
    copiedRaw: 'Original command copied',
    copyUnavailable: 'Can’t copy',
    done: 'Done',
    failed: 'Failed',
    noOutput: 'No output',
    copyCommand: 'Copy command',
    outsideControl: 'Cua ran directly, outside the Control this Mac switch and activity log.',
    bypassedMac: 'Bypassed Control this Mac',
    interruptedUnknown: 'Interrupted · Outcome unknown',
    interrupted: 'Interrupted',
    screenshotTitle: 'Screenshots go to the model service',
    screenshotInfo:
      'Agent screenshots go to the model service as tool results. Personal information on the screen isn’t redacted automatically.',
    retry: 'Retry',
    open: 'Open file',
    openChanges: 'Open in Changes',
  },
)

type ToolState = NonNullable<Message['state']>
/**
 * Words for the states a row names; a running or finished tool says it through its icon and duration instead. A call its
 * approval kept from running is not a failure: it reads by its record (「已拒绝 · 14:32」), never red, and so does one the
 * harness refused itself (拦下, who and why on the line under it). A failed row says why on the line under it.
 */
const stateWords: Partial<Record<ShownToolState, string>> = {
  get cancelled() {
    return COPY.cancelled
  },
  get rejected() {
    return COPY.denied
  },
  get expired() {
    return COPY.expired
  },
  get blocked() {
    return JUDGED_COPY.denied
  },
  get unknown() {
    return COPY.unknown
  },
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
const sameActions = (a: ToolDetail['actions'], b: ToolDetail['actions']) =>
  a === b
  || (a?.length === b?.length
    && (a ?? []).every(
      (action, index) => action.kind === b![index]!.kind && action.path === b![index]!.path && action.query === b![index]!.query,
    ))
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
    && sameActions(a.actions, b.actions)
    && sameDiffs(a.diffs, b.diffs)
    && sameDecision(a.decision, b.decision)
    && a.judged?.outcome === b.judged?.outcome
    && a.judged?.by === b.judged?.by
    && a.blocked?.by === b.blocked?.by
    && a.blocked?.source === b.blocked?.source
    && a.blocked?.reason === b.blocked?.reason)

const PATH_KEYS = ['path', 'file', 'file_path', 'filePath']
/** How many of a command's last lines its block shows while it is folded: screen lines, because none of them wraps. */
export const COMMAND_TAIL_LINES = 5
/** A tail line is one screen line and fades out at the block's edge, so the page holds no more of it than could show. */
const TAIL_LINE_CHARS = 400

/**
 * The whole path behind a row whose object is a file's name, so the row can show where it is: the folder quieter than the
 * name. Inside one of the session's folders it is written from there; a row whose object is not a file has none.
 */
export function rowPath(
  tool: ToolDetail | undefined,
  object: string,
  session: Pick<FileSessionInfo, 'folder' | 'folders'> | undefined,
): { folder: string; name: string } | undefined {
  const diffs = tool?.diffs ?? []
  let input: string | undefined
  const view = argumentView(tool?.input)
  if (view.kind === 'entries')
    input = view.entries.find(([key, value]) => PATH_KEYS.includes(key) && value.trim() && !value.includes('\n'))?.[1]
  const acted = tool?.actions?.length === 1 ? tool.actions[0]!.path?.replace(/[\\/]+$/u, '') : undefined
  const candidates = [diffs.length === 1 ? diffs[0]!.path : undefined, tool?.locations?.[0], input, acted]
  for (const path of candidates) {
    if (!path) continue
    const name = basename(path)
    // A new file's object carries its length after its name: 「a.ts · 42 行」.
    if (object !== name && !object.startsWith(`${name} · `)) continue
    const roots = [session?.folder, ...(session?.folders ?? []).map(folder => folder.path)].filter((root): root is string => !!root)
    const root = roots.find(root => path.startsWith(root.endsWith('/') ? root : `${root}/`))
    const shown = root ? path.slice(root.length).replace(/^[\\/]+/u, '') : path
    const cut = Math.max(shown.lastIndexOf('/'), shown.lastIndexOf('\\')) + 1
    return { folder: shown.slice(0, cut), name: object }
  }
  return undefined
}

/** A command's last lines, as its folded block shows them, each cut to what one line can show; trailing blank lines say nothing. */
export function commandTail(output: string, lines = COMMAND_TAIL_LINES): string {
  const all = stripAnsi(output).replace(/\s+$/u, '').split(/\n/u)
  return all
    .slice(-lines)
    .map(line => (line.length > TAIL_LINE_CHARS ? line.slice(0, TAIL_LINE_CHARS) : line))
    .join('\n')
}

/** How long the tool ran, ticking every second while it runs and frozen once it settles; nothing under a second. */
function ToolTime({ message, frozen }: { message: Message; frozen: boolean }) {
  useTicker(message.state === 'running' && !frozen ? 'second' : false)
  const duration = toolDuration(message, hostNow())
  const text = duration ? formatDuration(duration.ms, duration.live) : undefined
  if (!text) return null
  return <span className="process-time">{text}</span>
}

/** The lines an output shows before 展开全部: about a dozen, so a long one never pushes the answer away. */
const OUTPUT_LINES = 12

/**
 * Live output keeps its newest lines in view while it streams without writing a scroll position: the box is laid out
 * from its end (column-reverse), so it stays at the bottom until the reader scrolls up inside it, and stays where the
 * reader left it after that. Settled, a long output shows its first dozen lines and opens whole; all of it stays in
 * the page, to be found and selected. A command's terminal colours are kept, and its copy is the text without them.
 */
function ToolOutput({ text, running, language, flush = false }: { text: string; running: boolean; language?: string; flush?: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const seen = useSeen(box)
  const id = useId()
  const [expanded, setExpanded] = useState(false)
  const plain = useMemo(() => stripAnsi(text), [text])
  const lines = useMemo(() => plain.replace(/\n+$/u, '').split('\n').length, [plain])
  const long = !running && lines > OUTPUT_LINES
  return (
    <div className={`tool-output-box${flush ? ' is-flush' : ''}`}>
      <div ref={box} id={id} className={`tool-output-scroll${running ? ' is-live' : ''}${long && !expanded ? ' is-capped' : ''}`}>
        <pre className="tool-pre tool-output">
          {language ? <SourceOutput text={text} language={language} enabled={seen} /> : <AnsiText text={text} />}
        </pre>
        {!running && <CopyButton text={plain} label={COPY.copyOutput} size="xs" className="tool-output-copy" />}
      </div>
      {long && (
        <button
          type="button"
          className="tool-output-more"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => {
            setExpanded(!expanded)
          }}>
          {expanded ? COPY.less : COPY.allLines(lines)}
          {expanded ? (
            <ChevronUpGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
          ) : (
            <ChevronDownGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
          )}
        </button>
      )}
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

/** The wrapper a command came in, by its program's name; pressing it copies the line exactly as the agent reported it. */
function ShellTag({ shell, reported }: { shell: string; reported: string }) {
  const { state, copy } = useCopy()
  return (
    <button
      type="button"
      className="command-shell"
      title={reported}
      aria-label={COPY.copyRaw(reported)}
      onClick={() => {
        void copy(reported)
      }}>
      {state === 'copied' ? COPY.copiedRaw : state === 'failed' ? COPY.copyUnavailable : shell.split('/').at(-1)}
    </button>
  )
}

const sessionRoots = (session: Pick<FileSessionInfo, 'folder' | 'folders'> | undefined): string[] =>
  [session?.folder, ...(session?.folders ?? []).map(folder => folder.path)].filter((root): root is string => !!root)

/**
 * What a command did, on one surface the way a terminal shows it: the folder when it is not the project's, the command the
 * agent meant (a shell wrapper's quoting undone) coloured as shell, its output in its own colours, and at its foot how it
 * ended (how long it took stays on the row), with copy and 填入终端. A wrapper it came in is named there; the reported line copies whole.
 * The `$` line is drawn only when the row above could not show the command whole: cut short, or on several lines.
 */
function CommandEvidence({
  line,
  showLine,
  folder,
  state,
  settled,
  running,
  output,
}: {
  line: CommandLine
  showLine: boolean
  folder: string | undefined
  state: ShownToolState
  settled: boolean
  running: boolean
  output: string | undefined
}) {
  const ended =
    state === 'completed' ? (
      <span className="command-ended is-ok">
        <CheckGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
        {COPY.done}
      </span>
    ) : state === 'failed' ? (
      <span className="command-ended is-failed">
        <CloseGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
        {COPY.failed}
      </span>
    ) : null
  return (
    <div className="command-evidence">
      {folder && (
        <p className="command-folder" title={folder}>
          <FolderOpen size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
          <VisibleText text={folder} />
        </p>
      )}
      {showLine && (
        <pre className="command-line" title={line.shell ? line.reported : undefined}>
          <span className="command-dollar" aria-hidden="true">
            ${' '}
          </span>
          <ShellLine command={line.command} wraps />
        </pre>
      )}
      {output !== undefined
        && (output ? <ToolOutput text={output} running={running} flush /> : !running && <p className="command-empty">{COPY.noOutput}</p>)}
      {settled && (
        <div className="command-foot">
          {ended}
          {line.shell && <ShellTag shell={line.shell} reported={line.reported} />}
          <span className="process-fill" />
          <CopyButton text={line.command} label={COPY.copyCommand} size="xs" />
          <TerminalFillButton command={line.command} />
        </div>
      )}
    </div>
  )
}

/**
 * One tool call as a work row on the turn's rail: its kind's glyph, the verb, the object (a file's path in mono with its
 * folder quieter than its name), the lines it changed, and at the row's end its state (a spinner while it runs, a red ✕
 * when it failed) and its duration under the pointer. A command whose command line is known shows the command a shell
 * wrapper carried, coloured as shell (the reported line in its tooltip). Settled, it is a row like any other and its
 * output opens with it. While it runs, and once it failed or its result is unknown, it is a block: the last lines of the
 * output the tool reported under it, none wrapped, with a block caret only while it still runs and a red rail on its
 * left when it failed. A failed row says why on one line, with 重试 when this device may resend the turn. Opening a row
 * shows what it did under its words: a file edit's short preview (never while the right panel is open: there the row
 * stays one line and selects its file in 改动), a command's evidence, otherwise its arguments and whole output. A
 * pending approval is decided in the drawer above the composer; here the row only says what it is.
 */
export const ToolCard = memo(
  function ToolCard({
    message,
    approval,
    onRetry,
    frozen = false,
    inline = false,
  }: {
    message: Message | null
    approval?: Approval
    /** Resends the turn; present when this device may, on the latest turn. */
    onRetry?: () => void
    /** Nothing is known to move: the connection is down, so the row stops spinning and ticking. */
    frozen?: boolean
    /** A step of a subagent: a command stays a row there, under its name, and is not a block of its own. */
    inline?: boolean
  }) {
    useLocale()
    const bodyId = useId()
    const link = useChangesLink()
    const session = useContext(FileSession)
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
    // A command its Harness classified as reads, listings or searches is drawn as one of those rows.
    const kind = rowKind({ tool, toolName, state })
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
    const open = approval ? false : (choice ?? false)
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
    // A command whose command line is known: a block with its last lines in view while it runs or after it went wrong,
    // one row once it settled.
    const command = kind === 'execute' && label.mono && label.verb !== undefined && !review && !inline
    const line = kind === 'execute' && label.mono && label.verb !== undefined ? commandLine(tool) : undefined
    const object = label.object
    // What an opened command shows: its line, or a command on several lines whole, as its approval card would.
    const evidence = review ? undefined : (line ?? (kind === 'execute' ? approvalCommand(tool) : undefined))
    // Whether the row shows the command whole: it is the row's object, on one line, and not cut at the row's end.
    const objectRef = useRef<HTMLSpanElement>(null)
    const [cut, setCut] = useState(false)
    const headed = evidence !== undefined && object === evidence.command && !evidence.command.includes('\n')
    useLayoutEffect(() => {
      const element = objectRef.current
      if (!open || !headed || !element) return undefined
      const measure = () => {
        setCut(element.scrollWidth > element.clientWidth + 1)
      }
      measure()
      const observer = new ResizeObserver(measure)
      observer.observe(element)
      return () => {
        observer.disconnect()
      }
    }, [open, headed, object])
    const well = command && (state === 'running' || shown === 'failed' || shown === 'interrupted' || shown === 'unknown')
    // A judgement's words, once its call settled: the review's verdict, or that the call ran without an ask.
    const judgedWords =
      judged && (state === 'completed' || state === 'failed') && !(state === 'failed' && judged.outcome === 'unasked')
        ? JUDGED_COPY[judged.outcome]
        : undefined
    // The verb says the kind; the glyph at the row's end says only a state the words do not already make plain.
    const glyph = failed ? (
      <CloseGlyph className="process-failed" size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} />
    ) : shown === 'interrupted' || shown === 'unknown' ? (
      <AlertGlyph className="process-unknown" size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} />
    ) : shown === 'cancelled' || shown === 'rejected' || shown === 'blocked' ? (
      <BlockedGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} />
    ) : shown === 'expired' ? (
      <TimerOff size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} />
    ) : state === 'queued' ? (
      <CircleDashed size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} />
    ) : null
    const openInChanges = (diff: DiffViewFile) => {
      link?.open({ path: diff.path, ...(rootId ? { root: rootId } : {}) })
    }
    // The row's tooltip: the call's full heading when the row shortens it, a titled tool's ID, and an allowance's record.
    const tooltip = [
      title !== label.object ? title : undefined,
      line && line.reported !== title && line.reported !== object ? line.reported : undefined,
      tool?.toolTitle && toolName && toolName !== label.object ? toolName : undefined,
      decision?.outcome === 'allowed' ? decisionLine(decision, 0).full : undefined,
    ]
      .filter(Boolean)
      .join('\n')
    // Who decided a call no person was asked about: a few words in the opened row, the whole note behind ⓘ.
    const judgedNote = block
      ? block.source === 'model'
        ? JUDGED_COPY.reviewBrief(block.by)
        : JUDGED_COPY.ruleBrief(block.by)
      : judged && (review || judgedWords)
        ? review
          ? JUDGED_COPY.reviewBrief(judged.by)
          : JUDGED_COPY.unaskedBrief(judged.by)
        : undefined
    const path = label.mono ? undefined : rowPath(tool, label.object, session)
    // A state change the page saw happen: the spinner and the result icon cross-fade and the new words fade in.
    const glyphKind: RowKind = review ? 'other' : newFile ? 'new' : applied ? 'edit' : kind
    const heading = (
      <>
        <KindGlyph kind={glyphKind} />
        <StatusWords state={label.verb ? 'row' : 'title'} className="process-label">
          <span className={command ? 'process-verb sr-only' : 'process-verb'}>{label.verb}</span>
          {path ? (
            <span className="process-object is-path">
              {path.folder && (
                <span className="process-folder">
                  <VisibleText text={path.folder} />
                </span>
              )}
              <span className="process-name">
                <VisibleText text={path.name} />
              </span>
            </span>
          ) : (
            <span ref={objectRef} className={label.mono ? 'process-object is-mono' : 'process-object'}>
              {line && object === line.command ? <ShellLine command={object} /> : <VisibleText text={object} />}
            </span>
          )}
        </StatusWords>
        {stat && (
          <span className="process-stat">
            <span className="stat-add">+{stat.add}</span> <span className="stat-del">−{stat.del}</span>
          </span>
        )}
        {kind === 'execute' && bypassesComputer(evidence?.command ?? object) && (
          <Tooltip content={COPY.outsideControl}>
            <span className="process-bypass" data-computer-bypass="" tabIndex={0} aria-label={COPY.bypassedMac}>
              <Icon icon={WarningGlyph} size={12} />
            </span>
          </Tooltip>
        )}
      </>
    )
    const stateSlot = (
      <StatusWords
        state={shown}
        className={`tool-card-state state-${shown}`}
        // A result that is unknown looks the same under every customisation (tokens.css).
        data-lock={shown === 'unknown' || shown === 'interrupted' ? '' : undefined}>
        {/* An allowance is on record in the row's tooltip; the slot says only a call its approval kept from running. */}
        {state === 'awaiting-approval' ? null : decision && unrun ? (
          <DecisionWords decision={decision} />
        ) : (
          (stateWords[shown]
          ?? (shown === 'interrupted' ? (state === 'failed' ? COPY.interruptedUnknown : COPY.interrupted) : undefined)
          ?? judgedWords)
        )}
      </StatusWords>
    )
    const hasDetails = !panelEdit
    // Only what the tool itself reported is output: a command's plain-text form is not.
    const tail = well && !open && tool?.output ? commandTail(withoutToolCode(tool.output)) : ''
    // The tail shows the last lines; the reason is the first one that says something, which a long output scrolls off.
    const reason = failed ? failureReason(message ?? { text: '' }) : ''
    const reasonInTail = tail !== '' && reason !== '' && tail.includes(reason)
    return (
      <FileRootContext.Provider value={rootId}>
        <article
          className={`tool-card tool-${shown}${command ? ' is-command' : ''}${well ? ' is-block' : ''}`}
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
              {hasDetails && (
                <ChevronRightGlyph
                  className="process-chevron"
                  size={12}
                  nonScalingStroke
                  strokeWidth={ICON_STROKE[12]}
                  aria-hidden="true"
                />
              )}
              <span className="process-fill" />
              <span className="process-end">
                <StatusGlyph className="tool-card-icon" running={running} state={shown}>
                  {glyph}
                </StatusGlyph>
                {stateSlot}
                {message && <ToolTime message={message} frozen={frozen} />}
              </span>
            </button>
            {/* The folded tail repeats the output the opened body holds whole, so find and readers take it from there. */}
            {tail && (
              <pre className="command-tail" aria-hidden="true">
                <VisibleText text={tail} />
                {running && <span className="command-caret" />}
              </pre>
            )}
            {/* A tool's pictures (the browser's screenshots): opened as attachments are, on any device that may read the session. */}
            {message?.attachments?.length ? (
              <div className="tool-images">
                <MessageAttachments attachments={message.attachments} />
                <Hint className="tool-images-note" lead={<Icon icon={Camera} size={12} />} label={COPY.screenshotTitle}>
                  {COPY.screenshotInfo}
                </Hint>
              </div>
            ) : null}
            {block && (
              <p className="tool-block-line">
                <VisibleText text={blockedLine(block)} />
              </p>
            )}
            {/* Where the tail already shows the reason, the failure line is only 重试. */}
            {failed && !(reasonInTail && !onRetry) && (
              <p className="tool-failure">
                {!reasonInTail && <VisibleText text={reason} />}
                {onRetry && (
                  <Button size="xs" variant="ghost" icon={RotateCcw} onClick={onRetry}>
                    {COPY.retry}
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
                  {evidence && (
                    <CommandEvidence
                      line={evidence}
                      showLine={!headed || cut}
                      folder={commandFolder(reportedFolder(tool?.input), sessionRoots(session))}
                      state={shown}
                      settled={state !== 'awaiting-approval' && state !== 'queued'}
                      running={running}
                      output={showOutput ? output : undefined}
                    />
                  )}
                  {applied && link && (
                    <DiffView
                      diffs={diffs}
                      mode="compact"
                      fileActions={diff => (
                        <Button
                          size="xs"
                          variant="ghost"
                          icon={DiffGlyph}
                          onClick={() => {
                            openInChanges(diff)
                          }}>
                          {previousState(diff) === 'none' ? COPY.open : COPY.openChanges}
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
                  {judgedNote && (
                    <Hint inline className="tool-judged-note" label={judgedNote.label}>
                      {judgedNote.detail}
                    </Hint>
                  )}
                  {/* A review's input is the agent's whole event, its status still the one it began with: its own words say it. */}
                  {/* A command shown without its wrapper keeps the reported line here, whole. */}
                  {/* What else a call was given; a command's line and folder are shown above. */}
                  {tool?.plan && <PlanText text={tool.plan} />}
                  {!review && !applied && (
                    <ArgumentList
                      text={tool?.input}
                      covered={[
                        ...(evidence ? [evidence.reported, reportedFolder(tool?.input) ?? ''] : [label.object]),
                        ...(tool?.plan ? [tool.plan] : []),
                      ]}
                      quiet
                    />
                  )}
                  {showOutput
                    && !applied
                    && !evidence
                    && (output ? (
                      <ToolOutput text={output} running={running} language={language} />
                    ) : (
                      !running && <p className="muted-line">{COPY.noOutput}</p>
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
    && a.inline === b.inline
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
        && a.message.attachments === b.message.attachments
        && sameTool(a.message.tool, b.message.tool))),
)
