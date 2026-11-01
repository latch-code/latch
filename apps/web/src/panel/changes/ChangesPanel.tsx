import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Ellipsis,
  FolderTree,
  GitBranch,
  Info,
  Redo2,
  TriangleAlert,
  Undo2,
  WrapText,
  type LucideIcon,
} from 'lucide-react'
import type { ChangedFile, ChangeList, FileMention, Message, NotRestoredFile, TaskSummary, TurnChanges } from '@latch/protocol'
import {
  Button,
  ConfirmDialog,
  ICON_STROKE,
  IconButton,
  Menu,
  MenuFooterNote,
  Popover,
  SegmentedControl,
  Spinner,
  useLayerClose,
  type MenuSection,
} from '@latch/ui'
import { escapeHiddenCharacters, VisibleText } from '../../components/VisibleText.tsx'
import { errorMessage } from '../../core/api.ts'
import { setPreference, usePreferences } from '../../preferences.ts'
import { ChangesFile } from './ChangesFile.tsx'
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

const DENIED_DETAIL = '这台设备没有查看项目文件的权限，所以读不到改动。在这台 Mac 的 Latch 桌面端查看。'

/** Where the conversation sends the person: a turn and, when it names one, a file of it. */
export interface ChangesTarget {
  turnId?: string
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
  /** The Host takes this session's input only from this computer. */
  localOnlySession: boolean
  /** The device's data scope covers the session's folders; the routes refuse it otherwise. */
  canRead: boolean
  phone: boolean
  /** No connection to the Host: what is on screen stays, and nothing can be written. */
  offline: boolean
  target?: ChangesTarget
  onComment?: (mention: FileMention, line: number, text: string) => void
  onOpenFile: (file: Pick<ChangedFile, 'root' | 'path'>) => void
  onOpenSession?: (sessionId: string) => void
  knownSession?: (sessionId: string) => boolean
  onToast: (text: string, tone?: 'ok' | 'error') => void
  /** What the tab says while another tab is showing. */
  onTotals?: (totals: ChangeList['totals'] | undefined) => void
}

function Line({
  tone = 'plain',
  icon: Glyph,
  children,
  sub,
  action,
}: {
  tone?: 'plain' | 'muted' | 'amber'
  icon?: LucideIcon
  children: ReactNode
  sub?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="changes-line" data-tone={tone}>
      {Glyph && <Glyph size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />}
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

function MissedList({ files }: { files: readonly MissedFile[] }) {
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
        icon={Undo2}
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
      width={360}
      align="start"
      trigger={props => (
        <Button {...props} size="xs" variant="ghost" icon={Undo2} loading={busy} loadingLabel="撤销中…">
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
      <p>{writtenWords(warning.restore, warning.remove)}这些文件没再改动时可以恢复。</p>
      <p className="changes-warning-miss">
        <TriangleAlert size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
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
      <Button size="xs" variant="ghost" icon={Undo2} loading={busy === 'discard'} loadingLabel="撤销中…" onClick={onDiscard}>
        撤销未提交的改动…
      </Button>
    )
  return null
}

/** Reads like the warning did: what was written, then one list with each reason beside its path. */
function Receipt({ result, engine }: { result: ChangesResult; engine: string }) {
  const [more, setMore] = useState(false)
  const note = (next: boolean) => (next ? `下一条消息会告诉 ${engine}，它的记忆不会被撤销。` : '')
  let title: string,
    words: string,
    notRestored: readonly NotRestoredFile[],
    notCovered: readonly string[] = [],
    skipped: number
  if (result.kind === 'turn') {
    const { receipt } = result
    title = receipt.action === 'undo' ? '已撤销本轮改动' : '已恢复本轮改动'
    words = writtenWords(receipt.restored, receipt.removed) + note(receipt.noteNextTurn)
    ;({ notRestored, skipped } = receipt)
    notCovered = receipt.notCovered
  } else {
    const { restored, removed } = result.result
    ;({ notRestored, skipped } = result.result)
    title = result.kind === 'uncommitted' ? '已撤销未提交的改动' : `已撤销 ${result.path}`
    words = restored + removed ? writtenWords(restored, removed) + note(result.result.noteNextTurn) : '这个文件已经是这一轮开始时的内容。'
  }
  const missed = missedFiles(notRestored, notCovered, skipped)
  const Glyph = result.kind === 'turn' && result.receipt.action === 'redo' ? Redo2 : Undo2
  return (
    <div className="changes-receipt" role="status">
      <p className="changes-receipt-title">
        <Glyph size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
        <span>
          <VisibleText text={title} />
        </span>
      </p>
      <p>{words}</p>
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
        <ChevronRight size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
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
              <ChevronRight
                className="changes-chevron"
                data-open={row.open ? '' : undefined}
                size={12}
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
                <IconButton
                  size="xs"
                  icon={Undo2}
                  label={`撤销 ${row.file.path}`}
                  tooltip="撤销此文件"
                  className="changes-tree-undo"
                  onClick={() => {
                    onUndo(row.file)
                  }}
                />
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
          <span className="changes-line-text">运行中 · 列表停在上次刷新，这一轮结束后更新</span>
        </button>
      )
    case 'interrupted':
      return (
        <Line tone="muted" icon={CircleAlert}>
          这一轮中断了 · 列表是它开始时和此刻的比较
        </Line>
      )
    case 'partial':
      return (
        <Line tone="amber" icon={TriangleAlert} sub="超过 5 万项、32 层或 10 秒。可能还有没列出的文件，撤销也碰不到它们。">
          记录不完整：文件夹太大
        </Line>
      )
    case 'conflict':
      return (
        <Line tone="amber" icon={TriangleAlert}>
          {line.text}
        </Line>
      )
    case 'other-session': {
      const other = line.sessions.find(id => knownSession?.(id) ?? false)
      return (
        <Line
          tone="amber"
          icon={TriangleAlert}
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
          这期间另一个会话也在这个文件夹工作，归属可能不准
        </Line>
      )
    }
    case 'not-git':
      return (
        <Line tone="muted" icon={Info}>
          <VisibleText text={line.names.join('、')} /> 不是 Git 仓库的顶层，这里没有列出它的未提交改动
        </Line>
      )
    case 'base':
      return (
        <Line tone="muted" icon={GitBranch}>
          {line.branch ? (
            <>
              <VisibleText text={line.branch} /> 与 {line.base ?? '主分支'} 的分叉点比较
            </>
          ) : (
            `与 ${line.base ?? '主分支'} 的分叉点比较`
          )}
        </Line>
      )
    case 'large':
      return <Line tone="muted">文件很多：先显示列表，点开再读单个文件</Line>
  }
}

/** The right panel's 改动 tab: what this session changed, who changed it, and taking it back. */
export function ChangesPanel(props: ChangesPanelProps) {
  if (!props.canRead)
    return (
      <div className="changes-panel">
        <Empty title="这台设备看不到会话文件夹里的文件" detail={DENIED_DETAIL} />
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
  localOnlySession,
  phone,
  offline,
  target,
  onComment,
  onOpenFile,
  onOpenSession,
  knownSession,
  onToast,
  onTotals,
}: ChangesPanelProps) {
  const preferences = usePreferences()
  const [choice, setChoice] = useState<ScopeChoice>(target?.turnId ? { kind: 'turn', turnId: target.turnId } : { kind: 'latest' })
  const { list, turns, running, failure, busy, actionError, result, undoneFiles, revision, reload, actions, readFile } = useChanges(
    summary,
    choice,
    offline,
  )
  const [askUndoFile, setAskUndoFile] = useState<ChangedFile>()
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = useState<string>()
  const [limit, setLimit] = useState(LIST_PAGE)
  const [base, setBase] = useState<string>()
  const [discard, setDiscard] = useState<{ warning: string; planHash: string; removes: string[]; missed: MissedFile[] }>()
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
    if (target.turnId) setChoice({ kind: 'turn', turnId: target.turnId })
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
  const rights = { canRun, local, localOnlySession, active: running, offline }
  const action = scopeAction(list, turn, rights)
  const label = scopeLabel(choice, numbers, base)
  const rootNames = useMemo(() => {
    const names = new Map<string, string>()
    for (const folder of summary.folders ?? []) names.set(folder.id, folder.path.split('/').at(-1) || folder.id)
    return names
  }, [summary.folders])
  const lines = changeLines(list, turn, id => rootNames.get(id) ?? id, summary.branch, running && choice.kind !== 'turn')
  const empty = emptyState(list)

  const treeOn = !phone && (preferences.diffTree ?? treeOpensAlone(files.length, width)) && files.length > 0
  const treeW = treeOn ? treeWidth(width) : 0
  const layout = phone ? 'unified' : layoutFor(preferences.diffMode, width - treeW)
  const narrow = width < 520
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
        await navigator.clipboard.writeText(patch.text)
        const left = patch.omitted ? `，${patch.omitted} 个文件没有进入补丁` : ''
        onToast(patch.truncated ? `已复制补丁的前一部分：补丁太大${left}` : `已复制补丁${left}`, 'ok')
      },
      (cause: unknown) => {
        onToast(errorMessage(cause), 'error')
      },
    )
  }

  const kept: MenuSection = {
    id: 'turns',
    label: '保留的轮次',
    items: turns.toReversed().map(item => {
      const row = turnRow(item, numbers)
      return {
        id: `turn:${item.turnId}`,
        label: row.label,
        meta: row.meta,
        checked: choice.kind === 'turn' ? choice.turnId === item.turnId : choice.kind === 'latest' && item === turns.at(-1),
        onSelect: () => {
          setChoice(item === turns.at(-1) ? { kind: 'latest' } : { kind: 'turn', turnId: item.turnId })
        },
      }
    }),
  }
  const others: MenuSection = {
    id: 'scopes',
    items: [
      { id: 'session', label: '这个会话', checked: choice.kind === 'session', onSelect: () => setChoice({ kind: 'session' }) },
      {
        id: 'uncommitted',
        label: '未提交',
        meta: '和 HEAD 比较',
        checked: choice.kind === 'uncommitted',
        onSelect: () => setChoice({ kind: 'uncommitted' }),
      },
      ...(offersBase(summary.branch)
        ? [
            {
              id: 'base',
              label: baseLabel(base),
              meta: '从分叉点开始',
              checked: choice.kind === 'base',
              onSelect: () => setChoice({ kind: 'base' }),
            },
          ]
        : []),
    ],
  }
  const dropped = droppedTurns(numbers, turns)
  const undone = list?.undone && !(result?.kind === 'turn' && result.receipt.turnId === list.turnId)

  return (
    <div
      ref={panel}
      className="changes-panel"
      data-undone={list?.undone ? '' : undefined}
      data-phone={phone ? '' : undefined}
      data-wrap={preferences.diffWrap ? '' : undefined}>
      <div className="changes-scope-row">
        <Menu
          label="改动范围"
          width={288}
          selection
          align="start"
          sections={[...(turns.length ? [kept] : []), others]}
          footer={
            dropped > 0 ? <MenuFooterNote icon={Info}>{`还有 ${dropped} 轮 · 只保留最近 ${KEPT_TURNS} 轮`}</MenuFooterNote> : undefined
          }
          trigger={props => (
            <button {...props} type="button" className="changes-scope-button">
              <span>{label}</span>
              <ChevronDown size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
            </button>
          )}
        />
        {list && !list.unavailable && list.files.length > 0 && (
          <span className="changes-stat changes-stat-total">
            <span className="changes-add">+{list.totals.add}</span>
            <span className="changes-del">−{list.totals.del}</span>
          </span>
        )}
        <span className="changes-scope-action">
          <ScopeOptions action={action} list={list} actions={actions} busy={busy} turnId={shownTurnId} onDiscard={askDiscard} />
        </span>
        <span className="changes-scope-space" />
        {!narrow && !phone && (
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
        {!phone && (
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
        <Menu
          label="更多"
          align="end"
          sections={[
            ...(narrow && !phone
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
            { id: 'copy', items: [{ id: 'patch', label: '复制补丁', onSelect: copyPatch }] },
          ]}
          trigger={menu => <IconButton {...menu} size="xs" icon={Ellipsis} label="更多" />}
        />
      </div>
      {result && <Receipt result={result} engine={engine} />}
      {actionError && (
        <Line tone="amber" icon={TriangleAlert}>
          {actionError}
        </Line>
      )}
      {undone && (
        <>
          <Line icon={Undo2}>已撤销本轮改动{turn?.notePending ? ` · 下一条消息会告诉 ${engine}` : ''}</Line>
          {!!list.notCovered?.length && (
            <Line tone="muted" sub={<MissedList files={list.notCovered.map(path => ({ path, why: NOT_COVERED_WHY }))} />}>
              不在撤销范围内 {list.notCovered.length} 个文件
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
          <CircleAlert size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
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
      ) : failure?.kind === 'denied' ? (
        <Empty title="这台设备看不到会话文件夹里的文件" detail={DENIED_DETAIL} />
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
                    {...(canUndoRow(file)
                      ? {
                          onUndo: () => {
                            setAskUndoFile(file)
                          },
                        }
                      : {})}
                    {...(onComment ? { onComment } : {})}
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
          </div>
        </div>
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
