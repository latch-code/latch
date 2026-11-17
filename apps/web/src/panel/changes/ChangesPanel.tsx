import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { FolderTree, Redo2, WrapText } from 'lucide-react'
import type { ChangedFile, ChangeList, Message, NotRestoredFile, ReviewNote, TaskSummary, TurnChanges } from '@latch/protocol'
import {
  Button,
  ConfirmDialog,
  Hint,
  ICON_STROKE,
  type IconComponent,
  IconButton,
  Menu,
  MenuFooterNote,
  Popover,
  SegmentedControl,
  Spinner,
  useLayerClose,
  type MenuSection,
  ChevronDownGlyph,
  ChevronRightGlyph,
  AlertGlyph,
  MoreGlyph,
  BranchGlyph,
  InfoGlyph,
  WarningGlyph,
  UndoGlyph,
  writeClipboard,
} from '@latch/ui'
import { escapeHiddenCharacters, VisibleText } from '../../components/VisibleText.tsx'
import { errorMessage, MessageError } from '../../core/api.ts'
import { sessionReadOnly } from '../../core/permissions.ts'
import { computerName, SETUP_COPY } from '../../core/securityCopy.ts'
import { setPreference, usePreferences } from '../../preferences.ts'
import { ChangesFile } from './ChangesFile.tsx'
import { editorLabel, openInEditor, useEditors } from '../../components/OpenInEditor.tsx'
import { readTreeFile } from '../../preview/treeFiles.ts'
import { fileRefusalText } from '../../core/securityCopy.ts'
import {
  baseLabel,
  canUndoFile,
  changeLines,
  compareFiles,
  droppedTurns,
  emptyState,
  fileId,
  KEPT_TURNS,
  layoutFor,
  LARGE_LIST,
  LIST_PAGE,
  missedFiles,
  missingTurnTitle,
  NOT_COVERED_WHY,
  offersBase,
  queryOf,
  SCOPE_NOTE,
  scopeAction,
  scopeLabel,
  statusLetter,
  treeOpensAlone,
  treeRows,
  treeWidth,
  turnNumbers,
  turnRow,
  undoWarning,
  WINDOW_TREE_FROM,
  writtenWords,
  type ChangeLine,
  type MissedFile,
  type ScopeAction,
  type ScopeChoice,
} from './model.ts'
import { useChanges, type ChangesActions, type ChangesResult } from './useChanges.ts'
import { useReviewNotes } from './useReviewNotes.ts'
import { noteTally, sameFile } from './notes.ts'
import { NoteCard, NotesFoot, type NoteWriting } from './ReviewNotes.tsx'
import { PARTIAL_NOTE } from '../../conversation/turnChanges.ts'
import { GitHistoryView, type HistoryMode } from './GitHistoryView.tsx'
import { StagingFeedback, StagingView } from './StagingView.tsx'
import { useStaging, type useStagingWrites } from './useStaging.ts'
import type { GitStagingView } from '@latch/protocol'
import { rowOf } from '../../components/overlays.tsx'

/** Where the conversation sends the person: a turn and, when it names one, a file of it. */
export interface ChangesTarget {
  turnId?: string
  /** 交付 opens a file in 未提交, the work tree against HEAD. */
  scope?: 'uncommitted'
  /** A line of the conversation does not always know which session folder its file is in. */
  file?: { root?: string; path: string }
  /** The same link pressed again goes there again. */
  nonce: number
}

export interface ChangesPanelProps {
  summary: TaskSummary
  messages: readonly Message[]
  /** The engine's name, for 「下一条消息会告诉 Codex」. */
  engine: string
  local: boolean
  canRun: boolean
  /** The device's data scope covers the session's folders; the routes refuse it otherwise. */
  canRead: boolean
  stagingWrites: ReturnType<typeof useStagingWrites>
  phone: boolean
  /** The Host's computer by the name it reports (`Snapshot.hostName`), for where to grant access. */
  hostName?: string
  /** No connection to the Host: what is on screen stays, and nothing can be written. */
  offline: boolean
  target?: ChangesTarget
  /** The Host keeps line feedback (`features.reviewNotes`). */
  reviewNotes?: boolean
  /** The snapshot's count revision of this session's notes: another device's write reads them again. */
  notesRevision?: number
  /** The Host queues a message for the next turn while one runs (`features.queue`), as the composer does. */
  canQueue?: boolean
  onOpenFile: (file: Pick<ChangedFile, 'root' | 'path'>) => void
  onOpenSession?: (sessionId: string) => void
  knownSession?: (sessionId: string) => boolean
  onToast: (text: string, tone?: 'ok' | 'error') => void
  /** What the tab says while another tab is showing. */
  onTotals?: (totals: ChangeList['totals'] | undefined) => void
  /** Opens 交付, from 未提交. */
  onDeliver?: () => void
  /** 「作为应用草稿」 for a session whose folder holds a page draft (`AppDraftEntry`). */
  appDraft?: ReactNode
  /**
   * The Host stages by line and reads history (`features.gitHunks`). Left out, the views are offered wherever 交付 is
   * (`onDeliver`): the page and its Host are one build.
   */
  gitHunks?: boolean
}

/** A Git view shown in place of a scope's list: the staging views, or one of the history views. */
type GitPane = { kind: 'staging'; view: GitStagingView } | { kind: 'history'; mode: HistoryMode; back?: GitPane }

function paneLabel(pane: GitPane, base: string | undefined): string {
  if (pane.kind === 'staging') return pane.view === 'unstaged' ? '未暂存' : '已暂存'
  return pane.mode.kind === 'commits' ? '提交' : pane.mode.kind === 'compare' ? `分支与 ${base ?? '主分支'}` : '文件历史'
}

/** Notes on files this scope does not list: they stay in reach with their original lines. */
function ApartNotes({ notes, writing }: { notes: ReviewNote[]; writing: NoteWriting | undefined }) {
  return (
    <section className="review-notes-apart" aria-label="不在这个范围的反馈">
      <p className="review-notes-apart-title">不在这个范围的反馈</p>
      {notes.map(note => (
        <NoteCard key={note.id} note={note} quote where={`${note.path} `} {...(writing ? { writing } : {})} />
      ))}
    </section>
  )
}

function Line({
  tone = 'plain',
  icon: Glyph,
  children,
  sub,
  detail,
  action,
}: {
  tone?: 'plain' | 'muted' | 'amber'
  icon?: IconComponent
  children: ReactNode
  /** A list under the line. */
  sub?: ReactNode
  /** A warning's fine print, behind ⓘ on the line: the line becomes an inline Hint. */
  detail?: string
  action?: ReactNode
}) {
  if (detail)
    return (
      <div className="changes-line" data-tone={tone}>
        <Hint inline {...(Glyph ? { lead: <Glyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} /> } : {})} label={children}>
          {detail}
        </Hint>
        {action}
      </div>
    )
  return (
    <div className="changes-line" data-tone={tone}>
      {Glyph && <Glyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />}
      <span className="changes-line-text">{children}</span>
      {action}
      {sub && <span className="changes-line-sub">{sub}</span>}
    </div>
  )
}

function Empty({ title, detail, children }: { title: string; detail?: string | undefined; children?: ReactNode }) {
  return (
    <div className="changes-empty">
      <div>
        <p className="changes-empty-title">{title}</p>
        {detail && <p className="changes-empty-detail">{detail}</p>}
        {children}
      </div>
    </div>
  )
}

export function MissedList({ files }: { files: readonly MissedFile[] }) {
  return (
    <div className="changes-missed">
      {files.map(file => (
        <div className="changes-missed-row" key={`${file.path}\n${file.why}`}>
          <code title={escapeHiddenCharacters(file.path)}>
            <VisibleText text={file.path} />
          </code>
          <span>{file.why}</span>
        </div>
      ))}
    </div>
  )
}

/** Only when something will be left, a word first: with nothing to warn about the press runs at once. */
function UndoTurn({ list, onUndo, busy }: { list: ChangeList; onUndo: () => void; busy: boolean }) {
  const warning = undoWarning(list)
  if (!warning.missed.length)
    return (
      <Button
        size="xs"
        variant="ghost"
        icon={UndoGlyph}
        loading={busy}
        loadingLabel="撤销中…"
        tooltip="写回这一轮开始时的内容"
        onClick={onUndo}>
        撤销本轮
      </Button>
    )
  return (
    <Popover
      label="撤销本轮"
      size="md"
      align="start"
      trigger={props => (
        <Button {...props} size="xs" variant="ghost" icon={UndoGlyph} loading={busy} loadingLabel="撤销中…">
          撤销本轮
        </Button>
      )}>
      <UndoWarning warning={warning} onUndo={onUndo} />
    </Popover>
  )
}

function UndoWarning({ warning, onUndo }: { warning: ReturnType<typeof undoWarning>; onUndo: () => void }) {
  const close = useLayerClose()
  return (
    <div className="changes-warning">
      <p className="changes-warning-title">撤销本轮</p>
      <p>{writtenWords(warning.restore, warning.remove)}</p>
      <p className="changes-warning-miss">
        <WarningGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
        不会恢复 {warning.missed.length} 个文件
      </p>
      <MissedList files={warning.missed} />
      <div className="changes-warning-actions">
        <Button size="sm" variant="ghost" onClick={close}>
          取消
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            close()
            onUndo()
          }}>
          撤销本轮
        </Button>
      </div>
    </div>
  )
}

function ScopeOptions({
  action,
  list,
  actions,
  busy,
  turnId,
  onDiscard,
}: {
  action: ScopeAction
  list: ChangeList | undefined
  actions: ChangesActions
  busy: string | undefined
  turnId: string | undefined
  onDiscard: () => void
}) {
  if (action.kind === 'why') return <span className="changes-why">{action.text}</span>
  if (action.kind === 'undo' && list && turnId)
    return (
      <UndoTurn
        list={list}
        busy={busy === 'undo'}
        onUndo={() => {
          void actions.undo(turnId)
        }}
      />
    )
  if (action.kind === 'redo' && turnId)
    return (
      <Button
        size="xs"
        variant="ghost"
        icon={Redo2}
        loading={busy === 'redo'}
        loadingLabel="恢复中…"
        onClick={() => {
          void actions.redo(turnId)
        }}>
        恢复
      </Button>
    )
  if (action.kind === 'discard')
    return (
      <Button size="xs" variant="ghost" icon={UndoGlyph} loading={busy === 'discard'} loadingLabel="撤销中…" onClick={onDiscard}>
        撤销未提交的改动…
      </Button>
    )
  return null
}

/** Reads like the warning did: what was written, then one list with each reason beside its path. */
function Receipt({ result, engine }: { result: ChangesResult; engine: string }) {
  const [more, setMore] = useState(false)
  let told = false
  let title: string,
    words: string,
    notRestored: readonly NotRestoredFile[],
    notCovered: readonly string[] = [],
    skipped: number
  if (result.kind === 'turn') {
    const { receipt } = result
    title = receipt.action === 'undo' ? '已撤销本轮改动' : '已恢复本轮改动'
    words = writtenWords(receipt.restored, receipt.removed)
    told = receipt.noteNextTurn
    ;({ notRestored, skipped } = receipt)
    notCovered = receipt.notCovered
  } else {
    const { restored, removed } = result.result
    ;({ notRestored, skipped } = result.result)
    title = result.kind === 'uncommitted' ? '已撤销未提交的改动' : `已撤销 ${result.path}`
    words = restored + removed ? writtenWords(restored, removed) : '这个文件已经是这一轮开始时的内容。'
    told = restored + removed > 0 && result.result.noteNextTurn
  }
  const missed = missedFiles(notRestored, notCovered, skipped)
  const Glyph = result.kind === 'turn' && result.receipt.action === 'redo' ? Redo2 : UndoGlyph
  return (
    <div className="changes-receipt" role="status">
      <p className="changes-receipt-title">
        <Glyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
        <span>
          <VisibleText text={title} />
        </span>
      </p>
      <p>{words}</p>
      {told && <Hint label={`下一条消息会告诉 ${engine}`}>{`${engine} 的记忆不会被撤销。`}</Hint>}
      {missed.files.length + missed.more > 0 && (
        <>
          <p className="changes-receipt-key">没有恢复 {missed.files.length + missed.more} 个文件</p>
          <MissedList files={missed.files} />
          {missed.more > 0 && <p className="changes-receipt-more">另有 {missed.more} 个文件没有列出</p>}
        </>
      )}
      <button
        type="button"
        className="changes-receipt-scope"
        aria-expanded={more}
        onClick={() => {
          setMore(!more)
        }}>
        <ChevronRightGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
        撤销的范围
      </button>
      {more && <p>{SCOPE_NOTE}</p>}
    </div>
  )
}

function TreeRows({
  files,
  selected,
  rootNames,
  undoable,
  onSelect,
  onUndo,
}: {
  files: readonly ChangedFile[]
  selected: string | undefined
  rootNames: ReadonlyMap<string, string>
  undoable: (file: ChangedFile) => boolean
  onSelect: (file: ChangedFile) => void
  onUndo: (file: ChangedFile) => void
}) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  const rows = useMemo(() => treeRows(files, closed, rootNames), [files, closed, rootNames])
  const scroller = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ top: 0, height: 800 })
  const windowed = rows.length >= WINDOW_TREE_FROM
  const ROW = 24
  const first = windowed ? Math.max(0, Math.floor(view.top / ROW) - 20) : 0
  const last = windowed ? Math.min(rows.length, Math.ceil((view.top + view.height) / ROW) + 20) : rows.length
  return (
    <div
      ref={scroller}
      className="changes-tree"
      role="tree"
      aria-label="改动的文件"
      onScroll={event => {
        if (windowed) setView({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })
      }}>
      <div style={windowed ? { paddingTop: first * ROW, paddingBottom: (rows.length - last) * ROW } : undefined}>
        {rows.slice(first, last).map(row =>
          row.kind === 'folder' ? (
            <button
              type="button"
              key={row.id}
              role="treeitem"
              aria-expanded={row.open}
              className="changes-tree-row"
              style={{ paddingInlineStart: 6 + row.depth * 12 }}
              onClick={() => {
                const next = new Set(closed)
                if (row.open) next.add(row.id)
                else next.delete(row.id)
                setClosed(next)
              }}>
              <ChevronRightGlyph
                className="changes-chevron"
                data-open={row.open ? '' : undefined}
                size={12}
                nonScalingStroke
                strokeWidth={ICON_STROKE[12]}
                aria-hidden="true"
              />
              <span className="changes-tree-name" title={escapeHiddenCharacters(row.name)}>
                <VisibleText text={row.name} />
              </span>
            </button>
          ) : (
            <div key={row.id} className="changes-tree-file" data-selected={selected === row.id ? '' : undefined}>
              <button
                type="button"
                role="treeitem"
                aria-current={selected === row.id || undefined}
                className="changes-tree-row"
                style={{ paddingInlineStart: 6 + row.depth * 12 + 18 }}
                onClick={() => {
                  onSelect(row.file)
                }}>
                <span className="changes-tree-name" title={escapeHiddenCharacters(row.file.path)}>
                  <VisibleText text={row.name} />
                </span>
              </button>
              <span className="changes-tree-letter" data-status={statusLetter(row.file)}>
                {statusLetter(row.file)}
              </span>
              {undoable(row.file) && (
                <>
                  <IconButton
                    size="xs"
                    icon={UndoGlyph}
                    label={`撤销 ${row.file.path}`}
                    tooltip="撤销此文件"
                    className="changes-tree-undo"
                    onClick={() => {
                      onUndo(row.file)
                    }}
                  />
                  {/* Its one hover action as its context menu too. */}
                  <Menu
                    label={`${escapeHiddenCharacters(row.file.path)} 的操作`}
                    context={rowOf('.changes-tree-file')}
                    sections={[
                      {
                        id: 'undo',
                        items: [{ id: 'undo', label: '撤销此文件', icon: UndoGlyph, danger: true, onSelect: () => onUndo(row.file) }],
                      },
                    ]}
                  />
                </>
              )}
            </div>
          ),
        )}
      </div>
    </div>
  )
}

function LineFor({
  line,
  onOpenSession,
  knownSession,
  onRefresh,
}: {
  line: ChangeLine
  onOpenSession?: ((id: string) => void) | undefined
  knownSession?: ((id: string) => boolean) | undefined
  onRefresh: () => void
}) {
  switch (line.kind) {
    case 'running':
      return (
        <button type="button" className="changes-line changes-line-button" data-tone="muted" title="点按刷新" onClick={onRefresh}>
          <Spinner size={12} />
          <span className="changes-line-text">运行中 · 点按刷新</span>
        </button>
      )
    case 'interrupted':
      return (
        <Line tone="muted" icon={AlertGlyph}>
          这一轮中断了 · 对比到此刻
        </Line>
      )
    case 'partial':
      return (
        <Line tone="amber" icon={WarningGlyph} detail={PARTIAL_NOTE.detail}>
          {PARTIAL_NOTE.label}
        </Line>
      )
    case 'conflict':
      return (
        <Line tone="amber" icon={WarningGlyph}>
          {line.text}
        </Line>
      )
    case 'other-session': {
      const other = line.sessions.find(id => knownSession?.(id) ?? false)
      return (
        <Line
          tone="amber"
          icon={WarningGlyph}
          action={
            other && onOpenSession ? (
              <Button
                size="xs"
                variant="link"
                onClick={() => {
                  onOpenSession(other)
                }}>
                查看
              </Button>
            ) : undefined
          }>
          另一个会话也在改这里
        </Line>
      )
    }
    case 'not-git':
      return (
        <Line tone="muted" icon={InfoGlyph}>
          <VisibleText text={line.names.join('、')} /> 不是仓库顶层，未提交的不列出
        </Line>
      )
    case 'base':
      return (
        <Line tone="muted" icon={BranchGlyph}>
          {line.branch ? (
            <>
              <VisibleText text={line.branch} /> 与 {line.base ?? '主分支'} 的分叉点比较
            </>
          ) : (
            `与 ${line.base ?? '主分支'} 的分叉点比较`
          )}
        </Line>
      )
  }
}

function FilesRestricted({ hostName }: { hostName: string | undefined }) {
  return <Empty title="这台设备看不到会话文件夹里的文件" detail={SETUP_COPY.filesNeedScope(computerName(hostName))} />
}

/** The right panel's 改动 tab: what this session changed, who changed it, and taking it back. */
export function ChangesPanel(props: ChangesPanelProps) {
  if (!props.canRead)
    return (
      <div className="changes-panel">
        <FilesRestricted hostName={props.hostName} />
      </div>
    )
  return <ReadableChanges key={props.summary.id} {...props} />
}

function ReadableChanges({
  summary,
  messages,
  engine,
  local,
  canRun,
  phone,
  hostName,
  offline,
  target,
  reviewNotes = false,
  notesRevision = 0,
  canQueue = false,
  onOpenFile,
  onOpenSession,
  knownSession,
  onToast,
  onTotals,
  onDeliver,
  appDraft,
  gitHunks = onDeliver !== undefined,
  stagingWrites,
}: ChangesPanelProps) {
  const preferences = usePreferences()
  const [git, setGit] = useState<GitPane>()
  const [choice, setChoice] = useState<ScopeChoice>(
    target?.turnId
      ? { kind: 'turn', turnId: target.turnId }
      : target?.scope === 'uncommitted'
        ? { kind: 'uncommitted' }
        : { kind: 'latest' },
  )
  const { list, turns, running, failure, busy, actionError, result, undoneFiles, revision, reload, actions, readFile } = useChanges(
    summary,
    choice,
    offline,
  )
  const stagingView = git?.kind === 'staging'
  const staging = useStaging(summary.id, `${summary.status}:${summary.runId ?? ''}:${revision}`, offline, stagingView, stagingWrites)
  const stagingPending = staging.busy !== undefined || staging.unknown !== undefined
  const review = useReviewNotes(summary.id, {
    enabled: reviewNotes,
    revision: notesRevision,
    poke: `${summary.status}:${summary.runId ?? ''}`,
    offline,
  })
  const [askClear, setAskClear] = useState(false)
  const [askUndoFile, setAskUndoFile] = useState<ChangedFile>()
  const editors = useEditors()
  const editorText = local ? editorLabel(editors) : undefined
  const [editorError, setEditorError] = useState('')
  /** The Host resolves the row's file for this device first, so main is handed only what the Host checked. */
  const openEditor = async (file: ChangedFile) => {
    setEditorError('')
    try {
      const meta = await readTreeFile(
        { kind: 'session', sessionId: summary.id },
        { root: file.root, path: file.path },
        new AbortController().signal,
      )
      if (meta.actions.editor !== true) throw new MessageError(fileRefusalText(meta.refused?.editor ?? 'file-type-refused'))
      const result = await openInEditor(summary.id, { handle: meta.handle })
      if (result.status === 'refused' || result.status === 'failed') throw new MessageError(fileRefusalText(result.code))
      if (result.status === 'busy') throw new MessageError('上一个文件操作还没有完成，请稍后重试。')
    } catch (cause) {
      setEditorError(errorMessage(cause))
    }
  }
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = useState<string>()
  const [limit, setLimit] = useState(LIST_PAGE)
  const [base, setBase] = useState<string>()
  const [discard, setDiscard] = useState<{ warning: string; planHash: string; removes: string[]; missed: MissedFile[] }>()
  const pickScope = (next: ScopeChoice) => {
    setGit(undefined)
    setChoice(next)
  }
  const numbers = useMemo(() => turnNumbers(messages), [messages])
  const panel = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(660)
  useLayoutEffect(() => {
    const element = panel.current
    if (!element) return undefined
    setWidth(element.clientWidth || 660)
    if (typeof ResizeObserver !== 'function') return undefined
    const observer = new ResizeObserver(() => {
      setWidth(element.clientWidth || 660)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [])
  useEffect(() => {
    if (list?.base) setBase(list.base)
  }, [list?.base])
  useEffect(() => {
    onTotals?.(list?.totals)
  }, [list?.totals, onTotals])
  // A link from the conversation goes to its turn and file, and the file opens.
  useEffect(() => {
    if (!target) return
    setGit(undefined)
    if (target.turnId) setChoice({ kind: 'turn', turnId: target.turnId })
    else if (target.scope === 'uncommitted') setChoice({ kind: 'uncommitted' })
  }, [target?.nonce])

  const files = useMemo(() => (list ? list.files.toSorted(compareFiles) : []), [list])
  // Nothing opened yet: the first file with content opens, so a short turn reads at once. A long list waits for a press.
  const seeded = useRef<string | undefined>(undefined)
  const seedKey = JSON.stringify([choice, list?.turnId])
  useEffect(() => {
    if (!list || seeded.current === seedKey) return
    seeded.current = seedKey
    const first =
      files.length < LARGE_LIST ? files.find(file => !file.secret && !file.notRetained && !file.large && !file.binary) : undefined
    setOpened(previous => (previous.size === 0 && first ? new Set([fileId(first)]) : previous))
  }, [list, files, seedKey])
  useEffect(() => {
    setLimit(LIST_PAGE)
  }, [seedKey])

  const shownTurnId = list?.turnId
  const turn: TurnChanges | undefined =
    choice.kind === 'latest' ? turns.at(-1) : choice.kind === 'turn' ? turns.find(item => item.turnId === choice.turnId) : undefined
  const rights = { canRun: canRun && !stagingPending, local, active: running, offline, readOnly: sessionReadOnly(summary) !== undefined }
  const action = scopeAction(list, turn, rights)
  const label = git ? paneLabel(git, base) : scopeLabel(choice, numbers, base)
  const rootNames = useMemo(() => {
    const names = new Map<string, string>()
    for (const folder of summary.folders ?? []) names.set(folder.id, folder.path.split('/').at(-1) || folder.id)
    return names
  }, [summary.folders])
  const lines = changeLines(list, turn, id => rootNames.get(id) ?? id, summary.branch, running && choice.kind !== 'turn')
  const empty = emptyState(list)

  const treeOn = !git && !phone && (preferences.diffTree ?? treeOpensAlone(files.length, width)) && files.length > 0
  const treeW = treeOn ? treeWidth(width) : 0
  const layout = phone ? 'unified' : layoutFor(preferences.diffMode, width - treeW)
  const narrow = width < 520
  const canArrange = !stagingView && !phone
  const modes = [
    { value: 'auto', label: '自动' },
    { value: 'stacked', label: '上下' },
    { value: 'split', label: '左右' },
  ] as const

  const listRef = useRef<HTMLDivElement>(null)
  const reveal = (file: Pick<ChangedFile, 'root' | 'path'>) => {
    const id = fileId(file)
    setSelected(id)
    setOpened(previous => new Set(previous).add(id))
    const at = files.findIndex(item => fileId(item) === id)
    if (at >= limit) setLimit(at + LIST_PAGE)
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-file="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start' })
    })
  }
  // Once per press of a link: a later refresh of the list must not pull the reader back to the file.
  const revealed = useRef<number>(undefined)
  useEffect(() => {
    const wanted = target?.file
    if (!wanted || revealed.current === target.nonce) return
    const file = list?.files.find(item => item.path === wanted.path && (wanted.root === undefined || item.root === wanted.root))
    if (!file) return
    revealed.current = target.nonce
    reveal(file)
  }, [target?.nonce, list])

  const canUndoRow = (file: ChangedFile) => canUndoFile(action, file) && !undoneFiles.has(fileId(file))
  const askDiscard = () => {
    actions.previewDiscard().then(
      preview => {
        setDiscard({
          warning: preview.warning,
          planHash: preview.planHash,
          removes: preview.removes.map(file => file.path),
          missed: missedFiles(preview.notRestored, []).files,
        })
      },
      (cause: unknown) => {
        onToast(errorMessage(cause), 'error')
        void reload()
      },
    )
  }
  const copyPatch = () => {
    actions.patch().then(
      async patch => {
        if (!patch.text) {
          onToast(patch.omitted ? `这 ${patch.omitted} 个文件不能进入补丁` : '没有可以复制的改动')
          return
        }
        await writeClipboard(patch.text)
        const left = patch.omitted ? `，${patch.omitted} 个文件没有进入补丁` : ''
        onToast(patch.truncated ? `已复制补丁的前一部分：补丁太大${left}` : `已复制补丁${left}`, 'ok')
      },
      (cause: unknown) => {
        onToast(errorMessage(cause), 'error')
      },
    )
  }

  const keptTurns: MenuSection = {
    id: 'turns',
    label: '保留的轮次',
    items: turns.toReversed().map(item => {
      const row = turnRow(item, numbers)
      return {
        id: `turn:${item.turnId}`,
        label: row.label,
        meta: row.meta,
        checked: !git && (choice.kind === 'turn' ? choice.turnId === item.turnId : choice.kind === 'latest' && item === turns.at(-1)),
        onSelect: () => {
          setGit(undefined)
          setChoice(item === turns.at(-1) ? { kind: 'latest' } : { kind: 'turn', turnId: item.turnId })
        },
      }
    }),
  }
  const others: MenuSection = {
    id: 'scopes',
    items: [
      { id: 'session', label: '这个会话', checked: !git && choice.kind === 'session', onSelect: () => pickScope({ kind: 'session' }) },
      {
        id: 'uncommitted',
        label: '未提交',
        meta: '和 HEAD 比较',
        checked: !git && choice.kind === 'uncommitted',
        onSelect: () => pickScope({ kind: 'uncommitted' }),
      },
      ...(offersBase(summary.branch)
        ? [
            {
              id: 'base',
              label: baseLabel(base),
              meta: '从分叉点开始',
              checked: !git && choice.kind === 'base',
              onSelect: () => pickScope({ kind: 'base' }),
            },
          ]
        : []),
    ],
  }
  const gitViews: MenuSection = {
    id: 'git',
    label: 'Git',
    items: [
      {
        id: 'unstaged',
        label: '未暂存',
        meta: '按行暂存',
        checked: git?.kind === 'staging' && git.view === 'unstaged',
        onSelect: () => setGit({ kind: 'staging', view: 'unstaged' }),
      },
      {
        id: 'staged',
        label: '已暂存',
        meta: '和 HEAD 比较',
        checked: git?.kind === 'staging' && git.view === 'staged',
        onSelect: () => setGit({ kind: 'staging', view: 'staged' }),
      },
      {
        id: 'commits',
        label: '提交',
        meta: '这个分支的',
        checked: git?.kind === 'history' && git.mode.kind === 'commits',
        onSelect: () => setGit({ kind: 'history', mode: { kind: 'commits' } }),
      },
      ...(offersBase(summary.branch)
        ? [
            {
              id: 'compare',
              label: `分支与 ${base ?? '主分支'}`,
              meta: '已提交的改动',
              checked: git?.kind === 'history' && git.mode.kind === 'compare',
              onSelect: () => setGit({ kind: 'history', mode: { kind: 'compare' } }),
            },
          ]
        : []),
    ],
  }
  const primaryRoot = summary.folders?.[0]?.id ?? 'default'
  const fileHistory = (path: string) => {
    setGit(current => ({ kind: 'history', mode: { kind: 'file', path }, ...(current ? { back: current } : {}) }))
  }
  const readOnly = sessionReadOnly(summary) !== undefined
  const stagingWhy = offline ? '不在线' : !canRun || readOnly ? '只读' : running ? 'Agent 正在改这个文件夹' : undefined
  const dropped = droppedTurns(numbers, turns)
  const kept = review.notes ?? []
  const writing: NoteWriting | undefined =
    reviewNotes && canRun && !offline && summary.personal === undefined ? { actions: review.actions, busy: review.busy } : undefined
  const tally = noteTally(kept)
  const anchorScope = queryOf(choice).scope
  const anchor = list && !list.unavailable ? { scope: anchorScope, ...(list.turnId ? { turnId: list.turnId } : {}) } : undefined
  const apart = kept.filter(note => !files.some(file => sameFile(note, file)))
  const undone = list?.undone && !(result?.kind === 'turn' && result.receipt.turnId === list.turnId)

  // The HTTP refusal can reach the page before the device snapshot that revoked the scope.
  if (failure?.kind === 'denied' || staging.read.kind === 'denied')
    return (
      <div ref={panel} className="changes-panel">
        <FilesRestricted hostName={hostName} />
      </div>
    )

  return (
    <div
      ref={panel}
      className="changes-panel"
      data-undone={list?.undone ? '' : undefined}
      data-phone={phone ? '' : undefined}
      data-wrap={preferences.diffWrap ? '' : undefined}>
      {appDraft}
      <div className="changes-scope-row">
        <Menu
          label="改动范围"
          size="sm"
          selection
          align="start"
          sections={[...(turns.length ? [keptTurns] : []), others, ...(gitHunks ? [gitViews] : [])]}
          footer={
            dropped > 0 ? <MenuFooterNote icon={InfoGlyph}>{`还有 ${dropped} 轮 · 只保留最近 ${KEPT_TURNS} 轮`}</MenuFooterNote> : undefined
          }
          trigger={props => (
            <button {...props} type="button" className="changes-scope-button">
              <span>{label}</span>
              <ChevronDownGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
            </button>
          )}
        />
        {!git && list && !list.unavailable && list.files.length > 0 && (
          <span className="changes-stat changes-stat-total">
            <span className="changes-add">+{list.totals.add}</span>
            <span className="changes-del">−{list.totals.del}</span>
          </span>
        )}
        {!git && !stagingPending && (
          <span className="changes-scope-action">
            <ScopeOptions action={action} list={list} actions={actions} busy={busy} turnId={shownTurnId} onDiscard={askDiscard} />
          </span>
        )}
        {(git ? git.kind === 'staging' : choice.kind === 'uncommitted') && onDeliver && (
          <Button size="xs" variant="ghost" onClick={onDeliver}>
            去交付
          </Button>
        )}
        <span className="changes-scope-space" />
        {!narrow && canArrange && (
          <SegmentedControl
            label="排列"
            size="xs"
            value={preferences.diffMode}
            options={modes}
            onValueChange={value => {
              setPreference('diffMode', value)
            }}
          />
        )}
        <IconButton
          size="xs"
          icon={WrapText}
          label="自动换行"
          pressed={preferences.diffWrap}
          onClick={() => {
            setPreference('diffWrap', !preferences.diffWrap)
          }}
        />
        {!git && !phone && (
          <IconButton
            size="xs"
            icon={FolderTree}
            label="文件树"
            pressed={treeOn}
            onClick={() => {
              setPreference('diffTree', !treeOn)
            }}
          />
        )}
        {(!git || (narrow && canArrange)) && (
          <Menu
            label="更多"
            align="end"
            sections={[
              ...(narrow && canArrange
                ? [
                    {
                      id: 'modes',
                      items: modes.map(mode => ({
                        id: mode.value,
                        label: mode.label,
                        checked: preferences.diffMode === mode.value,
                        onSelect: () => {
                          setPreference('diffMode', mode.value)
                        },
                      })),
                    },
                  ]
                : []),
              ...(!git ? [{ id: 'copy', items: [{ id: 'patch', label: '复制补丁', onSelect: copyPatch }] }] : []),
            ]}
            trigger={menu => <IconButton {...menu} size="xs" icon={MoreGlyph} label="更多" />}
          />
        )}
      </div>
      <StagingFeedback staging={staging} offline={offline} />
      {git?.kind === 'staging' ? (
        <StagingView
          staging={staging}
          view={git.view}
          onView={view => {
            setGit({ kind: 'staging', view })
          }}
          canWrite={stagingWhy === undefined}
          {...(stagingWhy ? { whyNot: stagingWhy } : {})}
          onOpenFile={path => {
            onOpenFile({ root: primaryRoot, path })
          }}
          onHistory={fileHistory}
        />
      ) : git ? (
        <GitHistoryView
          sessionId={summary.id}
          root={primaryRoot}
          mode={git.mode}
          layout={layout}
          phone={phone}
          poke={`${summary.status}:${summary.runId ?? ''}`}
          offline={offline}
          onOpenFile={onOpenFile}
          onHistory={fileHistory}
          {...(git.back
            ? {
                onBack: () => {
                  setGit(git.back)
                },
              }
            : {})}
        />
      ) : (
        <>
          {result && <Receipt result={result} engine={engine} />}
          {(actionError || editorError) && (
            <Line tone="amber" icon={WarningGlyph}>
              {actionError || editorError}
            </Line>
          )}
          {undone && (
            <>
              <Line icon={UndoGlyph}>已撤销本轮改动{turn?.notePending ? ` · 下一条消息会告诉 ${engine}` : ''}</Line>
              {!!list.notCovered?.length && (
                <Line tone="muted" sub={<MissedList files={list.notCovered.map(path => ({ path, why: NOT_COVERED_WHY }))} />}>
                  {list.notCovered.length} 个文件不在撤销范围
                </Line>
              )}
            </>
          )}
          {failure?.kind === 'failed' && list && (
            <button
              type="button"
              className="changes-line changes-line-button"
              data-tone="muted"
              title="点按刷新"
              onClick={() => {
                void reload()
              }}>
              <AlertGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
              <span className="changes-line-text">没有刷新成功 · 这是上次的列表</span>
            </button>
          )}
          {lines.map(line => (
            <LineFor
              key={line.kind}
              line={line}
              onOpenSession={onOpenSession}
              knownSession={knownSession}
              onRefresh={() => {
                void reload()
              }}
            />
          ))}
          {failure?.kind === 'turn-gone' ? (
            <Empty title={missingTurnTitle(choice, numbers, turns)} />
          ) : failure && !list ? (
            <Empty title="读不到改动" detail={failure.text}>
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  void reload()
                }}>
                重试
              </Button>
            </Empty>
          ) : !list ? (
            <Empty title="正在读取…" />
          ) : empty ? (
            <Empty title={empty.title} detail={empty.detail}>
              {empty.retry && (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    void reload()
                  }}>
                  重试
                </Button>
              )}
            </Empty>
          ) : (
            <div className="changes-body">
              {treeOn && (
                <TreeRows
                  files={files}
                  selected={selected}
                  rootNames={rootNames}
                  undoable={canUndoRow}
                  onSelect={reveal}
                  onUndo={setAskUndoFile}
                />
              )}
              <div ref={listRef} className="changes-list" data-undone={list.undone ? '' : undefined}>
                {files.slice(0, limit).map(file => {
                  const id = fileId(file)
                  return (
                    <div key={id} data-file={id}>
                      <ChangesFile
                        file={file}
                        open={opened.has(id)}
                        selected={selected === id}
                        undone={undoneFiles.has(id)}
                        layout={layout}
                        revision={revision}
                        read={readFile}
                        twoLines={phone}
                        onToggle={() => {
                          const next = new Set(opened)
                          if (next.has(id)) next.delete(id)
                          else next.add(id)
                          setOpened(next)
                        }}
                        onOpenFile={() => {
                          onOpenFile(file)
                        }}
                        {...(editorText ? { editor: { label: editorText, run: () => void openEditor(file) } } : {})}
                        {...(gitHunks
                        && file.root === primaryRoot
                        && (choice.kind === 'uncommitted' || choice.kind === 'base')
                        && file.status !== 'A'
                          ? {
                              onHistory: () => {
                                fileHistory(file.path)
                              },
                            }
                          : {})}
                        {...(canUndoRow(file)
                          ? {
                              onUndo: () => {
                                setAskUndoFile(file)
                              },
                            }
                          : {})}
                        {...(reviewNotes
                          ? {
                              notes: {
                                notes: kept.filter(note => sameFile(note, file)),
                                ...(anchor ? { anchor } : {}),
                                ...(writing ? { writing } : {}),
                              },
                            }
                          : {})}
                      />
                    </div>
                  )
                })}
                {files.length > limit && (
                  <button
                    type="button"
                    className="diff-more"
                    onClick={() => {
                      setLimit(limit + LIST_PAGE)
                    }}>
                    再显示 {Math.min(LIST_PAGE, files.length - limit)} 个文件
                  </button>
                )}
                {apart.length > 0 && <ApartNotes notes={apart} writing={writing} />}
              </div>
            </div>
          )}
          {list && empty && apart.length > 0 && (
            <div className="changes-list">
              <ApartNotes notes={apart} writing={writing} />
            </div>
          )}
        </>
      )}
      {!git && reviewNotes && review.readError && !review.notes && (
        <Line tone="muted" icon={AlertGlyph}>
          读不到反馈 · {review.readError}
        </Line>
      )}
      {!git && reviewNotes && (
        <NotesFoot
          notes={{
            ready: tally.ready.length,
            sending: tally.sending.length,
            sent: tally.sent,
            queued: tally.queued,
            toReview: tally.toReview,
          }}
          running={running}
          canQueue={canQueue}
          offline={offline}
          {...(hostName ? { hostName } : {})}
          {...(writing
            ? {
                writing: {
                  ...writing,
                  send: () => {
                    void review.actions.send(
                      tally.ready.map(note => note.id),
                      running && canQueue,
                    )
                  },
                  retry: () => {
                    void review.actions.retrySend()
                  },
                  abandon: () => {
                    void review.actions.abandonSend()
                  },
                },
              }
            : {})}
          unknown={review.unknownSend !== undefined && !review.busy}
          {...(review.error ? { error: review.error } : {})}
          onClear={() => {
            setAskClear(true)
          }}
        />
      )}
      {askClear && (
        <ConfirmDialog
          title={`清空 ${tally.ready.length} 条待发反馈？`}
          confirmLabel="清空"
          danger
          message="这些反馈还没有发出，清空后不能恢复。"
          onConfirm={async () => {
            for (const note of tally.ready) await review.actions.remove(note.id)
          }}
          onClose={() => {
            setAskClear(false)
          }}
        />
      )}
      {askUndoFile && (
        <ConfirmDialog
          title="撤销此文件？"
          danger
          confirmLabel="撤销此文件"
          message={
            <div className="changes-discard">
              <p>
                {askUndoFile.status === 'A'
                  ? '这个文件是这一轮新建的，撤销会删除它。这一步不能恢复。'
                  : '写回这一轮开始时的内容。这一步不能恢复。'}
              </p>
              <div className="changes-missed">
                <div className="changes-missed-row">
                  <code title={escapeHiddenCharacters(askUndoFile.path)}>
                    <VisibleText text={askUndoFile.path} />
                  </code>
                </div>
              </div>
            </div>
          }
          onConfirm={async () => {
            if (shownTurnId) await actions.undoFile(shownTurnId, askUndoFile)
          }}
          onClose={() => {
            setAskUndoFile(undefined)
          }}
        />
      )}
      {discard && (
        <ConfirmDialog
          title="撤销未提交的改动？"
          danger
          confirmLabel="撤销改动"
          message={
            <div className="changes-discard">
              <p>{discard.warning}</p>
              {discard.removes.length > 0 && (
                <>
                  <p className="changes-receipt-key">会删除</p>
                  <div className="changes-missed">
                    {discard.removes.map(path => (
                      <div className="changes-missed-row" key={path}>
                        <code title={escapeHiddenCharacters(path)}>
                          <VisibleText text={path} />
                        </code>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {discard.missed.length > 0 && (
                <>
                  <p className="changes-receipt-key">不会改动</p>
                  <MissedList files={discard.missed} />
                </>
              )}
            </div>
          }
          onConfirm={() => actions.discard(discard.planHash)}
          onClose={() => {
            setDiscard(undefined)
          }}
        />
      )}
    </div>
  )
}
