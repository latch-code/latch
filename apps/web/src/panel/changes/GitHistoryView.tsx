import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { ChangedFile, FileChangeDetail, GitCommitDiff, GitCommitEntry, GitCommitFileDiff, GitHistory } from '@latch/protocol'
import { Button, Collapse, ICON_STROKE, ChevronLeftGlyph, ChevronRightGlyph, CommitGlyph } from '@latch/ui'
import { VisibleText } from '../../components/VisibleText.tsx'
import { api, ApiError, errorMessage } from '../../core/api.ts'
import { ChangesFile } from './ChangesFile.tsx'
import { fileId } from './model.ts'
import { commitRow, historyFile, historyTitle } from './staging.ts'
import { defineCopy, formatNumber, plural } from '../../core/i18n.ts'

const COPY = defineCopy(
  {
    more: (count: number) => `还有 ${formatNumber(count)} 个文件`,
    latest: (count: number) => `只显示最近 ${formatNumber(count)} 个提交`,
    reading: '正在读取…',
    noBase: '没有可以比较的基线',
    retry: '重试',
    noChanges: '没有改动的文件',
    commitPrefix: '提交 ',
    committed: '已提交的改动 · 不含未提交',
    back: '返回',
    commit: '提交',
    fileCommits: ' · 改过这个文件的提交',
    noFiles: '这台设备看不到会话文件',
    noFileCommits: '没有改过这个文件的提交',
    noCommits: '还没有提交',
  },
  {
    more: (count: number) => plural(count, { one: '{n} more file', other: '{n} more files' }),
    latest: (count: number) => plural(count, { one: 'Only the latest commit is shown', other: 'Only the latest {n} commits are shown' }),
    reading: 'Reading…',
    noBase: 'No comparison base available',
    retry: 'Retry',
    noChanges: 'No changed files',
    commitPrefix: 'Commit ',
    committed: 'Committed changes',
    back: 'Back',
    commit: 'Commit',
    fileCommits: ' · Commits that changed this file',
    noFiles: 'This device can’t see session files',
    noFileCommits: 'No commits changed this file',
    noCommits: 'No commits yet',
  },
)

/** 提交: the session's commits. 文件历史: the commits that changed one file. 分支与基线: HEAD against where it left main. */
export type HistoryMode = { kind: 'commits' } | { kind: 'file'; path: string } | { kind: 'compare' } | { kind: 'commit'; sha: string }

export interface GitHistoryViewProps {
  sessionId: string
  /** The session's primary folder, for opening a file. */
  root: string
  mode: HistoryMode
  layout: 'unified' | 'split'
  phone: boolean
  /** Read again when this changes. */
  poke: string
  offline: boolean
  onOpenFile: (file: Pick<ChangedFile, 'root' | 'path'>) => void
  /** Leaves a file's history for where it was opened from. */
  onBack?: () => void
  onHistory: (path: string) => void
}

type Read<T> = { kind: 'loading' } | { kind: 'ready'; value: T } | { kind: 'failed'; code: string; text: string }

function useRead<T>(path: string | undefined, poke: string, offline: boolean): [Read<T>, () => void] {
  const [read, setRead] = useState<Read<T>>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!path || offline) return undefined
    const controller = new AbortController()
    api<T>(path, { signal: controller.signal }).then(
      value => {
        if (!controller.signal.aborted) setRead({ kind: 'ready', value })
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return
        setRead(current =>
          current.kind === 'ready'
            ? current
            : { kind: 'failed', code: cause instanceof ApiError ? cause.code : '', text: errorMessage(cause) },
        )
      },
    )
    return () => {
      controller.abort()
    }
  }, [path, poke, offline, attempt])
  return [read, () => setAttempt(value => value + 1)]
}

/** What the diff list draws from one history file's answer; content the Host does not show keeps its reason. */
function detailOf(root: string, answer: GitCommitFileDiff): FileChangeDetail {
  const file: ChangedFile = {
    ...historyFile(root, answer.file),
    ...(answer.hidden === 'binary' || answer.hidden === 'link' ? { binary: true as const } : {}),
    ...(answer.hidden === 'large' ? { large: true as const } : {}),
    ...(answer.hidden === 'secret' ? { secret: true as const } : {}),
  }
  return { scope: 'base', file, ...(answer.hunks ? { hunks: answer.hunks } : {}) }
}

/** The files of one commit, or of the comparison: read-only rows that open into their lines. */
function TreeFiles({
  base,
  query,
  root,
  only,
  layout,
  phone,
  poke,
  offline,
  onOpenFile,
  onHistory,
}: Pick<GitHistoryViewProps, 'root' | 'layout' | 'phone' | 'poke' | 'offline' | 'onOpenFile' | 'onHistory'> & {
  /** `…/git/history/<sha>` or `…/git/compare`. */
  base: string
  query: string
  /** A file's history shows that one file of each commit, opened. */
  only?: string
}) {
  const [read, retry] = useRead<GitCommitDiff>(only === undefined ? base : undefined, `${poke}:${query}`, offline)
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set(only === undefined ? [] : [fileId({ root, path: only })]))
  const readFile = useCallback(
    async (file: Pick<ChangedFile, 'root' | 'path'>, signal: AbortSignal) =>
      detailOf(root, await api<GitCommitFileDiff>(`${base}?${new URLSearchParams({ path: file.path }).toString()}`, { signal })),
    [base, root],
  )
  const row = (file: ChangedFile) => {
    const id = fileId(file)
    return (
      <ChangesFile
        key={id}
        file={file}
        open={opened.has(id)}
        selected={false}
        undone={false}
        layout={layout}
        revision={0}
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
        {...(only === undefined
          ? {
              onHistory: () => {
                onHistory(file.path)
              },
            }
          : {})}
      />
    )
  }
  if (only !== undefined) return row({ root, path: only, status: 'M' })
  if (read.kind === 'loading') return <p className="changes-body-note">{COPY.reading}</p>
  if (read.kind === 'failed')
    return (
      <p className="changes-body-note">
        {read.code === 'git-no-base' ? COPY.noBase : read.text}
        {read.code !== 'git-no-base' && (
          <Button size="xs" variant="ghost" onClick={retry}>
            {COPY.retry}
          </Button>
        )}
      </p>
    )
  const diff = read.value
  if (!diff.files.length) return <p className="changes-body-note">{COPY.noChanges}</p>
  return (
    <>
      {diff.files.map(file => row(historyFile(root, file)))}
      {diff.more ? <p className="changes-body-note">{COPY.more(diff.more)}</p> : null}
    </>
  )
}

function CommitRow({
  commit,
  open,
  onToggle,
  children,
}: {
  commit: GitCommitEntry
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  const row = commitRow(commit)
  return (
    <section className="history-commit" data-open={open ? '' : undefined}>
      <button type="button" className="history-commit-head" aria-expanded={open} onClick={onToggle}>
        <ChevronRightGlyph className="changes-chevron" size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
        <CommitGlyph size={14} nonScalingStroke strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
        <span className="history-commit-subject">
          <VisibleText text={row.label} />
        </span>
        <span className="changes-note">{row.meta}</span>
      </button>
      <Collapse open={open} lazy>
        <div className="history-commit-body">{open && children}</div>
      </Collapse>
    </section>
  )
}

/** The history views: read-only, each list read from the Host when it is opened and bounded there. */
export function GitHistoryView(props: GitHistoryViewProps) {
  const { sessionId, mode, poke, offline, onBack } = props
  const base = `tasks/${encodeURIComponent(sessionId)}/git`
  const listPath =
    mode.kind === 'compare' || mode.kind === 'commit'
      ? undefined
      : mode.kind === 'file'
        ? `${base}/history?${new URLSearchParams({ path: mode.path }).toString()}`
        : `${base}/history`
  const [read, retry] = useRead<GitHistory>(listPath, poke, offline)
  const [opened, setOpened] = useState<string>()
  const shared = {
    root: props.root,
    layout: props.layout,
    phone: props.phone,
    poke,
    offline,
    onOpenFile: props.onOpenFile,
    onHistory: props.onHistory,
  }
  if (mode.kind === 'commit')
    return (
      <div className="changes-body">
        <div className="changes-list">
          <div className="changes-line" data-tone="muted">
            <span className="changes-line-text">
              {COPY.commitPrefix}
              <code>{mode.sha.slice(0, 7)}</code>
            </span>
          </div>
          <TreeFiles key={mode.sha} {...shared} base={`${base}/history/${mode.sha}`} query={mode.sha} />
        </div>
      </div>
    )
  if (mode.kind === 'compare')
    return (
      <div className="changes-body">
        <div className="changes-list">
          <div className="changes-line" data-tone="muted">
            <span className="changes-line-text">{COPY.committed}</span>
          </div>
          <TreeFiles {...shared} base={`${base}/compare`} query="compare" />
        </div>
      </div>
    )
  return (
    <div className="changes-body">
      <div className="changes-list">
        <div className="changes-line" data-tone="muted">
          {mode.kind === 'file' && onBack && (
            <Button size="xs" variant="ghost" icon={ChevronLeftGlyph} onClick={onBack}>
              {COPY.back}
            </Button>
          )}
          <span className="changes-line-text">
            {mode.kind === 'file' ? <VisibleText text={mode.path} /> : read.kind === 'ready' ? historyTitle(read.value) : COPY.commit}
            {mode.kind === 'file' ? COPY.fileCommits : ''}
          </span>
        </div>
        {read.kind === 'loading' ? (
          <p className="changes-body-note">{COPY.reading}</p>
        ) : read.kind === 'failed' ? (
          <p className="changes-body-note">
            {read.code === 'file-scope' ? COPY.noFiles : read.text}
            <Button size="xs" variant="ghost" onClick={retry}>
              {COPY.retry}
            </Button>
          </p>
        ) : read.value.commits.length === 0 ? (
          <p className="changes-body-note">{mode.kind === 'file' ? COPY.noFileCommits : COPY.noCommits}</p>
        ) : (
          <>
            {read.value.commits.map(commit => (
              <CommitRow
                key={commit.sha}
                commit={commit}
                open={opened === commit.sha}
                onToggle={() => {
                  setOpened(opened === commit.sha ? undefined : commit.sha)
                }}>
                <TreeFiles
                  {...shared}
                  base={`${base}/history/${commit.sha}`}
                  query={commit.sha}
                  {...(mode.kind === 'file' ? { only: mode.path } : {})}
                />
              </CommitRow>
            ))}
            {read.value.more && <p className="changes-body-note">{COPY.latest(read.value.commits.length)}</p>}
          </>
        )}
      </div>
    </div>
  )
}
