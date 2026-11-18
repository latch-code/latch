import { useEffect, useRef, useState } from 'react'
import { EyeOff, ListFilter } from 'lucide-react'
import type {
  AppSnapshot,
  HistoryImportResult,
  HistoryList,
  HistoryPreview,
  HistoryPreviewMessage,
  HistoryRow,
  HostCatalog,
  WorkspaceInfo,
} from '@latch/protocol'
import {
  Button,
  CopyButton,
  EmptyState,
  ErrorState,
  Hint,
  Icon,
  IconButton,
  Loading,
  Modal,
  ModalHeader,
  Skeleton,
  ValuePicker,
  CheckGlyph,
  ChevronLeftGlyph,
  FolderOpenGlyph,
  HistoryGlyph,
  LockGlyph,
  RefreshGlyph,
  WarningGlyph,
} from '@latch/ui'
import { api } from '../core/api.ts'
import { computerName, HISTORY_COPY } from '../core/securityCopy.ts'
import { MarkTile } from '../components/BrandTile.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { useBackLayer } from '../hooks/backStack.ts'
import { basename, relativeTime } from '../format.ts'
import {
  historyEntry,
  importAttempt,
  importOutcome,
  importTargets,
  listFailure,
  listView,
  previewFailure,
  rowFolder,
  type HistoryEntry,
  type HistorySource,
  type ImportAttempt,
  type ImportOutcome,
  type ImportTarget,
  type ListState,
  type PreviewFailure,
} from './model.ts'
import { defineCopy, formatNumber, plural } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    back: '返回列表',
    mainFolder: '主文件夹里的会话',
    mainFolderDetail: '只列出在这个项目主文件夹（或它下面）开始的会话，不加载内容。',
    sourceModels: (value1: string) => `${value1} 只列出它当前模型服务下的会话。`,
    reading: (value1: string) => `正在读取 ${value1} 的会话…`,
    cannotList: '这个 Harness 不能列出已有会话',
    notDeclared: (value1: string) => `${value1} 没有声明列出与加载会话。`,
    signIn: (value1: string) => `${value1} 还没登录`,
    withCommand: '在这台 Mac 的终端里运行这条命令，登录后重试。',
    useOwnLogin: '按它自己的方式登录后重试。',
    copyLogin: '复制登录命令',
    retry: '重试',
    readFailed: '没有读到会话',
    also: '另有 ',
    otherFolders: ' 个在项目的其他文件夹里 · 尚未支持',
    extraFolders: ' 个带额外目录的会话未列出',
    noSessions: (value1: string) => `这个项目里没有 ${value1} 会话`,
    recent: '最近 ',
    sessionsSuffix: ' 个会话',
    sessionsFrom: (value1: string) => `${value1} 的会话`,
    imported: '已接入',
    recentOnly: '只读了最近的会话；更早的没有列出',
    failed: '失败',
    cancelled: '已取消',
    unfinished: '未完成',
    done: '完成',
    hiddenOutput: ' · 输出已隐藏',
    opening: (value1: string) => `${value1} 正在打开这个会话…`,
    previewAgain: '再看一次',
    openFailed: '没有打开这个会话',
    turns: (count: number) => `${formatNumber(count)} 轮`,
    hiddenTools: '工具输出和思考不显示',
    lastPrefix: '只显示最后 ',
    lastSuffix: ' 条对话和工具名称；像密钥的文字已替换。',
    listOrder: '会重新打开这个会话，在它自己的列表里可能排到前面。',
    maybeInUse: (value1: string) => `${value1} 不报告会话是否正在别处使用，Latch 看不出来。`,
    earlierHidden: '更早的消息没有显示',
    lastMessages: '最后的消息',
    unconfirmed: '结果未确认',
    expired: '预览已过期，请重新打开',
    reopen: '重新打开',
    importing: '正在接入',
    connect: '接入',
    continueWith: '继续用',
    rebuild: '按文字重建',
    rebuildTitle: '按文字重建，不是原样恢复',
    rebuildVisible: ' 只看到对话文字，看不到工具结果、思考和 ',
    rebuildDetail: '的压缩记录；文件以现在磁盘上的为准。第一条消息会把这段文字发给它用的模型服务。',
    native: '原样接入',
    nativeDetail: ' 带着它自己的完整记录继续；按 Latch 的默认权限继续，不沿用原会话的权限。',
  },
  {
    back: 'Back to list',
    mainFolder: 'Sessions in the main folder',
    mainFolderDetail: 'Lists sessions started in this project’s main folder or a subfolder. Session contents are not loaded.',
    sourceModels: (value1: string) => `${value1} lists sessions for its current model service only.`,
    reading: (value1: string) => `Reading sessions from ${value1}…`,
    cannotList: 'This Harness cannot list existing sessions',
    notDeclared: (value1: string) => `${value1} has not declared session listing and loading support.`,
    signIn: (value1: string) => `Sign in to ${value1}`,
    withCommand: 'Run this command in Terminal on this Mac. Sign in and try again.',
    useOwnLogin: 'Use its own sign-in method and try again.',
    copyLogin: 'Copy login command',
    retry: 'Retry',
    readFailed: 'Could not read sessions',
    also: 'Another ',
    otherFolders: ' are in other project folders · Support pending',
    extraFolders: ' sessions with extra folders are not listed',
    noSessions: (value1: string) => `No ${value1} sessions in this project`,
    recent: 'Recent ',
    sessionsSuffix: ' sessions',
    sessionsFrom: (value1: string) => `${value1} sessions`,
    imported: 'Imported',
    recentOnly: 'Only recent sessions were read. Older sessions are not listed.',
    failed: 'Failed',
    cancelled: 'Cancelled',
    unfinished: 'Unfinished',
    done: 'Done',
    hiddenOutput: ' · Output hidden',
    opening: (value1: string) => `${value1} is opening this session…`,
    previewAgain: 'Preview again',
    openFailed: 'Could not open this session',
    turns: (count: number) => `${plural(count, { one: '{n} turn', other: '{n} turns' })}`,
    hiddenTools: 'Tool output and reasoning are hidden',
    lastPrefix: 'Shows the last ',
    lastSuffix: ' messages and tool names. Text resembling secrets was replaced.',
    listOrder: 'Reopening the session can move it up in its original list.',
    maybeInUse: (value1: string) => `${value1} does not report whether the session is open elsewhere.`,
    earlierHidden: 'Earlier messages are not shown',
    lastMessages: 'Latest messages',
    unconfirmed: 'Outcome unconfirmed',
    expired: 'The preview expired. Open it again.',
    reopen: 'Reopen',
    importing: 'Importing',
    connect: 'Import',
    continueWith: 'Continue with',
    rebuild: 'Rebuild from text',
    rebuildTitle: 'Rebuild from text',
    rebuildVisible: ' receives the conversation text. Tool results, reasoning and the compacted history from ',
    rebuildDetail:
      ' are omitted. Files are read from disk as they are now. The first message sends the transcript to the new model service.',
    native: 'Import with full history',
    nativeDetail: ' continues with its full history and uses Latch’s default permissions.',
  },
)

/** The bound of a listing (500 sessions or 20 seconds) and of a load (60 seconds), each with the process's start. */
const LIST_TIMEOUT = 45_000
const PREVIEW_TIMEOUT = 90_000
const IMPORT_TIMEOUT = 90_000

/**
 * Under the new session's input: 「接入已有会话」 when the project has a Harness that lists its sessions. A device that may
 * not see private sessions sees it locked, with where that is opened.
 */
function HistoryEntryButton({ entry, computer, onOpen }: { entry: HistoryEntry; computer: string; onOpen: () => void }) {
  if (entry.kind === 'hidden') return null
  if (entry.kind === 'locked')
    return (
      <div className="history-entry" data-locked="">
        <Hint lead={<Icon icon={LockGlyph} size={12} />} label={HISTORY_COPY.entry}>
          {HISTORY_COPY.locked(computer)}
        </Hint>
      </div>
    )
  return (
    <div className="history-entry">
      <Button variant="ghost" size="sm" icon={HistoryGlyph} onClick={onOpen}>
        {HISTORY_COPY.entry}
      </Button>
    </div>
  )
}

/** The entry and, once pressed, the dialog, for the project the new session is in. */
export function HistoryImportEntry({
  snapshot,
  workspaceId,
  phone,
  onOpen,
  showCount = false,
}: {
  snapshot: AppSnapshot
  workspaceId: string | undefined
  phone: boolean
  onOpen: (taskId: string) => void
  showCount?: boolean
}) {
  const [open, setOpen] = useState(false)
  const entry = historyEntry(snapshot, workspaceId)
  const project = snapshot.catalog?.workspaces.find(item => item.id === workspaceId)
  return (
    <>
      <HistoryEntryButton entry={entry} computer={computerName(snapshot.hostName)} onOpen={() => setOpen(true)} />
      {open && entry.kind === 'open' && project && snapshot.catalog && (
        <HistoryImportDialog
          phone={phone}
          catalog={snapshot.catalog}
          project={project}
          sources={entry.sources}
          showCount={showCount}
          onClose={() => setOpen(false)}
          onOpen={taskId => {
            setOpen(false)
            onOpen(taskId)
          }}
        />
      )}
    </>
  )
}

type Level = { kind: 'list' } | { kind: 'preview'; row: HistoryRow }

type PreviewState = { kind: 'loading' } | { kind: 'ready'; preview: HistoryPreview } | { kind: 'failed'; failure: PreviewFailure }

type ImportState = { kind: 'idle' } | { kind: 'sending' } | Exclude<ImportOutcome, { kind: 'open' }>

/**
 * 接入已有会话: the project's sessions a Harness had before Latch, newest first; a row opens a read-only preview of its last
 * messages, and 接入 brings it in, continued by the same Harness or rebuilt as text in another. A dialog on wider screens,
 * pages pushed one over the other on a phone.
 */
function HistoryImportDialog({
  phone,
  catalog,
  project,
  sources,
  showCount,
  onClose,
  onOpen,
}: {
  phone: boolean
  catalog: HostCatalog
  project: WorkspaceInfo
  sources: HistorySource[]
  showCount: boolean
  onClose: () => void
  /** A session brought in now or before: open it. */
  onOpen: (taskId: string) => void
}) {
  const [sourceId, setSourceId] = useState(sources[0]!.harnessId)
  const source = sources.find(item => item.harnessId === sourceId) ?? sources[0]!
  const [level, setLevel] = useState<Level>({ kind: 'list' })
  const [list, setList] = useState<ListState>({ kind: 'loading' })
  const [listNonce, setListNonce] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const lastRow = useRef<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setList({ kind: 'loading' })
    api<HistoryList>('history/list', {
      method: 'POST',
      body: { projectId: project.id, harnessId: sourceId },
      timeoutMs: LIST_TIMEOUT,
      signal: controller.signal,
    }).then(
      found => {
        if (!controller.signal.aborted) setList({ kind: 'ready', list: found })
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setList(listFailure(error))
      },
    )
    return () => controller.abort()
  }, [project.id, sourceId, listNonce])

  const back = () => {
    setLevel({ kind: 'list' })
    // Handles live ten minutes: a list read again after a long preview stays usable.
    requestAnimationFrame(() => {
      const row = lastRow.current && listRef.current?.querySelector<HTMLElement>(`[data-handle="${CSS.escape(lastRow.current)}"]`)
      ;(row || listRef.current?.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true })
    })
  }
  useBackLayer(phone, onClose)
  useBackLayer(phone && level.kind === 'preview', back)

  const title = level.kind === 'preview' ? level.row.title : HISTORY_COPY.entry
  return (
    <Modal
      label={HISTORY_COPY.entry}
      variant={phone ? 'page' : 'dialog'}
      size="xl"
      className="history-dialog"
      onClose={() => {
        if (level.kind === 'preview') back()
        else onClose()
      }}>
      <ModalHeader
        title={<VisibleText text={title} />}
        onClose={onClose}
        leading={level.kind === 'preview' ? <IconButton label={COPY.back} icon={ChevronLeftGlyph} onClick={back} /> : undefined}
      />
      {level.kind === 'list' ? (
        <div className="history-level" ref={listRef} data-level="list">
          <ScopeLine project={project} sources={sources} source={source} onSource={setSourceId} />
          <ListBody
            state={list}
            source={source}
            project={project}
            catalog={catalog}
            showCount={showCount}
            onRetry={() => setListNonce(nonce => nonce + 1)}
            onRow={row => {
              lastRow.current = row.handle
              if (row.importedTaskId) onOpen(row.importedTaskId)
              else setLevel({ kind: 'preview', row })
            }}
          />
        </div>
      ) : (
        <PreviewLevel
          key={level.row.handle}
          row={level.row}
          source={source}
          catalog={catalog}
          onOpen={onOpen}
          onExpired={() => {
            setLevel({ kind: 'list' })
            setListNonce(nonce => nonce + 1)
          }}
        />
      )}
    </Modal>
  )
}

/** Which project, and which Harness lists it: the scope of every row below. */
function ScopeLine({
  project,
  sources,
  source,
  onSource,
}: {
  project: WorkspaceInfo
  sources: HistorySource[]
  source: HistorySource
  onSource: (harnessId: string) => void
}) {
  return (
    <div className="history-scope">
      <span className="history-scope-project">
        <Icon icon={FolderOpenGlyph} size={14} />
        <VisibleText text={project.name} />
      </span>
      {sources.length > 1 ? (
        <ValuePicker
          label="Harness"
          value={source.harnessId}
          options={sources.map(item => ({ value: item.harnessId, label: item.label, media: <MarkTile mark={item.mark} size={20} /> }))}
          leading={<MarkTile mark={source.mark} size={16} />}
          onValueChange={onSource}
        />
      ) : (
        <span className="history-scope-harness">
          <MarkTile mark={source.mark} size={16} />
          {source.label}
        </span>
      )}
      <Hint lead={<Icon icon={ListFilter} size={12} />} label={COPY.mainFolder}>
        {COPY.mainFolderDetail}
        {/* Codex's own listing is of its current model provider; no other Harness that lists has such a limit. */}
        {source.mark === 'codex' && COPY.sourceModels(source.label)}
      </Hint>
    </div>
  )
}

function ListBody({
  state,
  source,
  project,
  catalog,
  showCount,
  onRetry,
  onRow,
}: {
  state: ListState
  source: HistorySource
  project: WorkspaceInfo
  catalog: HostCatalog
  showCount: boolean
  onRetry: () => void
  onRow: (row: HistoryRow) => void
}) {
  const view = listView(state)
  const now = new Date()
  if (view.kind === 'loading')
    return (
      <div className="history-list" aria-busy="true">
        <Loading label={COPY.reading(source.label)} />
        {[0, 1, 2].map(index => (
          <div key={index} className="history-row-skeleton">
            <Skeleton width="60%" />
            <Skeleton width={56} height={12} />
          </div>
        ))}
      </div>
    )
  if (view.kind === 'not-supported')
    return <EmptyState className="history-state" title={COPY.cannotList} description={COPY.notDeclared(source.label)} />
  if (view.kind === 'login') {
    const login = catalog.harnesses.find(harness => harness.id === source.harnessId)?.login
    return (
      <EmptyState
        className="history-state"
        title={COPY.signIn(source.label)}
        description={login?.command ? COPY.withCommand : COPY.useOwnLogin}
        action={
          <div className="history-login">
            {login?.command && (
              <span className="history-login-command">
                <code>{login.command}</code>
                <CopyButton text={login.command} label={COPY.copyLogin} size="xs" />
              </span>
            )}
            <Button size="sm" icon={RefreshGlyph} onClick={onRetry}>
              {COPY.retry}
            </Button>
          </div>
        }
      />
    )
  }
  if (view.kind === 'failed')
    return (
      <ErrorState
        className="history-state"
        title={COPY.readFailed}
        description={view.message}
        actions={
          <Button size="sm" icon={RefreshGlyph} onClick={onRetry}>
            {COPY.retry}
          </Button>
        }
      />
    )
  const others = view.otherFolders > 0 && (
    <p className="history-others">
      {COPY.also}
      <span className="history-count">{view.otherFolders}</span>
      {COPY.otherFolders}
    </p>
  )
  const withheld = view.withheld !== undefined && (
    <p className="history-others" data-withheld="">
      {COPY.also}
      <span className="history-count">{view.withheld}</span>
      {COPY.extraFolders}
    </p>
  )
  if (view.kind === 'empty')
    return (
      <div className="history-list">
        <EmptyState className="history-state" title={COPY.noSessions(source.label)} />
        {others}
        {withheld}
      </div>
    )
  const primary = basename(project.folders?.[0]?.path ?? project.path)
  return (
    <div className="history-list">
      {showCount && (
        <p className="history-others">
          {view.truncated ? COPY.recent : ''}
          {view.rows.length}
          {COPY.sessionsSuffix}
        </p>
      )}
      <ul aria-label={COPY.sessionsFrom(source.label)}>
        {view.rows.map(row => (
          <li key={row.handle}>
            <button
              type="button"
              className="history-row"
              data-handle={row.handle}
              data-imported={row.importedTaskId ? '' : undefined}
              onClick={() => onRow(row)}>
              <span className="history-row-title">
                <VisibleText text={row.title} />
              </span>
              <span className="history-row-meta">
                {row.importedTaskId && (
                  <span className="history-row-imported">
                    <Icon icon={CheckGlyph} size={12} />
                    {COPY.imported}
                  </span>
                )}
                <span className="history-row-folder">
                  <VisibleText text={rowFolder(row) ?? primary} />
                </span>
                {row.updatedAt && <time dateTime={row.updatedAt}>{relativeTime(row.updatedAt, now)}</time>}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {view.truncated && <p className="history-others">{COPY.recentOnly}</p>}
      {others}
      {withheld}
    </div>
  )
}

/** One message of the preview: words as the Host gave them, a tool by its title and state only. */
function PreviewMessage({ message }: { message: HistoryPreviewMessage }) {
  if (message.role === 'tool')
    return (
      <li className="history-message" data-role="tool">
        <span className="history-tool-title">
          <VisibleText text={message.text} />
        </span>
        <span className="history-tool-state">
          {message.status === 'failed'
            ? COPY.failed
            : message.status === 'cancelled'
              ? COPY.cancelled
              : message.status === 'running'
                ? COPY.unfinished
                : COPY.done}
          {COPY.hiddenOutput}
        </span>
      </li>
    )
  return (
    <li className="history-message" data-role={message.role}>
      <p>
        <VisibleText text={message.text} />
        {message.clipped && <span className="history-clipped"> …</span>}
      </p>
    </li>
  )
}

function PreviewLevel({
  row,
  source,
  catalog,
  onOpen,
  onExpired,
}: {
  row: HistoryRow
  source: HistorySource
  catalog: HostCatalog
  onOpen: (taskId: string) => void
  onExpired: () => void
}) {
  const [state, setState] = useState<PreviewState>({ kind: 'loading' })
  const [nonce, setNonce] = useState(0)
  const targets = importTargets(catalog, source.harnessId)
  const [targetId, setTargetId] = useState(source.harnessId)
  const target = targets.find(item => item.harnessId === targetId) ?? targets[0]
  const [importing, setImporting] = useState<ImportState>({ kind: 'idle' })
  const attempt = useRef<ImportAttempt | null>(null)
  const imported = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    let opened: string | undefined
    setState({ kind: 'loading' })
    api<HistoryPreview>('history/previews', {
      method: 'POST',
      body: { handle: row.handle },
      timeoutMs: PREVIEW_TIMEOUT,
      signal: controller.signal,
    }).then(
      preview => {
        opened = preview.previewId
        if (controller.signal.aborted) close(preview.previewId)
        else setState({ kind: 'ready', preview })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        const failure = previewFailure(error)
        if (failure.kind === 'expired') onExpired()
        else setState({ kind: 'failed', failure })
      },
    )
    return () => {
      controller.abort()
      // The Host holds the session open while a preview lasts; an import closes it there itself.
      if (opened && !imported.current) close(opened)
    }
  }, [row.handle, nonce])

  const send = async (previewId: string) => {
    if (!target) return
    const sent = importAttempt(attempt.current, previewId, target.harnessId)
    attempt.current = sent
    setImporting({ kind: 'sending' })
    try {
      const result = await api<HistoryImportResult>('history/imports', {
        method: 'POST',
        body: { requestId: sent.requestId, previewId: sent.source, harnessId: sent.harnessId },
        timeoutMs: IMPORT_TIMEOUT,
      })
      imported.current = true
      onOpen(result.taskId)
    } catch (error) {
      const outcome = importOutcome(error)
      if (outcome.kind === 'open') {
        // Brought in by another request: the Host left this preview open, so leaving closes it.
        onOpen(outcome.taskId)
        return
      }
      // Only an unanswered request is sent again as it was; anything the Host refused starts afresh.
      if (outcome.kind !== 'unknown') attempt.current = null
      setImporting(outcome)
    }
  }

  if (state.kind === 'loading')
    return (
      <div className="history-level" data-level="preview" aria-busy="true">
        <div className="history-preview">
          <Loading label={COPY.opening(source.label)} />
        </div>
      </div>
    )
  if (state.kind === 'failed')
    return (
      <div className="history-level" data-level="preview">
        <div className="history-preview">
          {state.failure.kind === 'busy' ? (
            <div className="history-busy" role="alert">
              <Icon icon={WarningGlyph} size={20} />
              <strong>{HISTORY_COPY.busy}</strong>
              <p>{HISTORY_COPY.busyDetail(source.label)}</p>
              <Button size="sm" icon={RefreshGlyph} onClick={() => setNonce(value => value + 1)}>
                {COPY.previewAgain}
              </Button>
            </div>
          ) : (
            <ErrorState
              className="history-state"
              title={COPY.openFailed}
              description={state.failure.kind === 'failed' ? state.failure.message : ''}
              actions={
                <Button size="sm" icon={RefreshGlyph} onClick={() => setNonce(value => value + 1)}>
                  {COPY.retry}
                </Button>
              }
            />
          )}
        </div>
      </div>
    )
  const { preview } = state
  const busy = importing.kind === 'sending'
  return (
    <div className="history-level" data-level="preview">
      <div className="history-preview">
        <div className="history-preview-meta">
          <span>{[preview.model, COPY.turns(preview.turns)].filter(Boolean).join(' · ')}</span>
          <Hint lead={<Icon icon={EyeOff} size={12} />} label={COPY.hiddenTools}>
            {COPY.lastPrefix}
            {preview.messages.length}
            {COPY.lastSuffix}
            {source.label} {COPY.listOrder}
            {preview.useUnknown && COPY.maybeInUse(source.label)}
          </Hint>
        </div>
        {preview.truncated && <p className="history-others">{COPY.earlierHidden}</p>}
        <ol className="history-messages" aria-label={COPY.lastMessages}>
          {preview.messages.map((message, index) => (
            <PreviewMessage key={index} message={message} />
          ))}
        </ol>
      </div>
      <footer className="history-footer">
        <TargetChoice
          targets={targets}
          target={target}
          sourceLabel={source.label}
          disabled={busy}
          onChange={value => {
            setTargetId(value)
            setImporting({ kind: 'idle' })
          }}
        />
        <div className="history-actions">
          {importing.kind === 'unknown' && (
            <span className="history-result" data-tint="warn" role="status">
              {COPY.unconfirmed}
            </span>
          )}
          {(importing.kind === 'failed' || importing.kind === 'busy' || importing.kind === 'expired') && (
            <span className="history-result" data-tint="err" role="alert">
              {importing.kind === 'busy' ? HISTORY_COPY.busy : importing.kind === 'expired' ? COPY.expired : importing.message}
            </span>
          )}
          {importing.kind === 'expired' ? (
            <Button variant="primary" icon={RefreshGlyph} onClick={onExpired}>
              {COPY.reopen}
            </Button>
          ) : (
            <Button variant="primary" loading={busy} disabled={!target} onClick={() => void send(preview.previewId)}>
              {busy ? COPY.importing : importing.kind === 'unknown' ? COPY.retry : COPY.connect}
            </Button>
          )}
        </div>
      </footer>
    </div>
  )
}

/**
 * 继续用: the Harness the session continues in, and what that means. The source itself continues it as it was; any other
 * is a text rebuild, said in amber.
 */
export function TargetChoice({
  targets,
  target,
  sourceLabel,
  disabled,
  onChange,
}: {
  targets: ImportTarget[]
  target: ImportTarget | undefined
  sourceLabel: string
  disabled: boolean
  onChange: (harnessId: string) => void
}) {
  return (
    <>
      <div className="history-target">
        <span className="history-target-label">{COPY.continueWith}</span>
        {targets.length > 1 ? (
          <ValuePicker
            label={COPY.continueWith}
            value={target?.harnessId}
            disabled={disabled}
            options={targets.map(item => ({
              value: item.harnessId,
              label: item.label,
              media: <MarkTile mark={item.mark} size={20} />,
              ...(item.mode === 'text' ? { description: COPY.rebuild } : {}),
            }))}
            leading={<MarkTile mark={target?.mark} size={16} />}
            side="top"
            onValueChange={onChange}
          />
        ) : (
          <span className="history-scope-harness">
            <MarkTile mark={target?.mark} size={16} />
            {target?.label}
          </span>
        )}
      </div>
      {target?.mode === 'text' ? (
        <div className="history-mode" data-tint="warn">
          <Hint lead={<Icon icon={WarningGlyph} size={12} />} label={COPY.rebuildTitle}>
            {target.label}
            {COPY.rebuildVisible}
            {sourceLabel} {COPY.rebuildDetail}
          </Hint>
        </div>
      ) : (
        <div className="history-mode">
          <Hint lead={<Icon icon={HistoryGlyph} size={12} />} label={COPY.native}>
            {sourceLabel}
            {COPY.nativeDetail}
          </Hint>
        </div>
      )}
    </>
  )
}

function close(previewId: string): void {
  void api(`history/previews/${previewId}`, { method: 'DELETE' }).catch(() => {})
}
