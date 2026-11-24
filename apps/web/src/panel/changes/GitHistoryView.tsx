import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  containsSecret,
  type BranchListing,
  type ChangedFile,
  type FileChangeDetail,
  type GitCommitDiff,
  type GitCommitEntry,
  type GitCommitFileDiff,
  type GitHistory,
} from '@latch/protocol'
import { Button, Collapse, Dialog, ICON_STROKE, SearchField, ChevronLeftGlyph, ChevronRightGlyph, CommitGlyph } from '@latch/ui'
import { VisibleText } from '../../components/VisibleText.tsx'
import { api, ApiError, errorMessage, MessageError } from '../../core/api.ts'
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
    baseline: '选择比较基线',
    searchBase: '搜索分支、提交，或粘贴完整提交号',
    branches: '本地分支',
    changesMoved: '比较两端的提交已改变。请重新打开基线比较。',
    compareTyped: '使用输入的分支或提交',
    ends: '比较的提交',
    auto: '自动（分叉点）',
    compare: '比较',
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
    baseline: 'Choose comparison base',
    searchBase: 'Search branches or commits, or paste a full commit ID',
    branches: 'Local branches',
    changesMoved: 'The compared commits changed. Reopen the comparison.',
    compareTyped: 'Use this branch or commit',
    ends: 'Compared commits',
    auto: 'Automatic (fork point)',
    compare: 'Compare',
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
  canChooseComparisonBase: boolean
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
          current.kind === 'ready' && !(cause instanceof ApiError && cause.status < 500)
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
  reference,
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
  reference?: string
  /** A file's history shows that one file of each commit, opened. */
  only?: string
}) {
  const [read, retry] = useRead<GitCommitDiff>(
    only === undefined ? base + (reference ? '?' + new URLSearchParams({ base: reference }).toString() : '') : undefined,
    `${poke}:${query}`,
    offline,
  )
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set(only === undefined ? [] : [fileId({ root, path: only })]))
  const tip = read.kind === 'ready' ? read.value.sha : undefined
  const parent = read.kind === 'ready' ? read.value.parent : undefined
  const readFile = useCallback(
    async (file: Pick<ChangedFile, 'root' | 'path'>, signal: AbortSignal) => {
      const params = new URLSearchParams({ path: file.path, ...(reference ? { base: reference } : {}) })
      const answer = await api<GitCommitFileDiff>(`${base}?${params}`, { signal })
      if (tip && (answer.sha !== tip || answer.parent !== parent)) throw new MessageError(COPY.changesMoved)
      return detailOf(root, answer)
    },
    [base, root, reference, tip, parent],
  )
  const row = (file: ChangedFile) => {
    const id = fileId(file)
    return (
      <ChangesFile
        key={JSON.stringify([tip, parent, id])}
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
  return (
    <>
      {diff.base && diff.parent && (
        <div className="changes-line compare-ends" aria-label={COPY.ends}>
          <code title={diff.parent}>{diff.parent.slice(0, 9)}</code>
          <span aria-hidden="true">→</span>
          <code title={diff.sha}>HEAD · {diff.sha.slice(0, 9)}</code>
        </div>
      )}
      {!diff.files.length && <p className="changes-body-note">{COPY.noChanges}</p>}
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

function ComparePicker({ base, close, choose }: { base: string; close(): void; choose(value: string): void }) {
  const [query, setQuery] = useState('')
  const [branches, retryBranches] = useRead<BranchListing>(base + '/compare-branches', '', false)
  const [commits, retryCommits] = useRead<GitHistory>(base + '/history', '', false)
  const typed = query.trim()
  const matches = (text: string) => text.toLowerCase().includes(typed.toLowerCase())
  const names = branches.kind === 'ready' ? branches.value.branches.filter(item => matches(item.name)).slice(0, 20) : []
  const recent =
    commits.kind === 'ready' ? commits.value.commits.filter(item => matches(item.sha) || matches(item.subject ?? '')).slice(0, 12) : []
  const selectTyped =
    typed && !containsSecret(typed) && !names.some(item => item.name === typed) && !recent.some(item => item.sha === typed)
  const failure = branches.kind === 'failed' ? branches.text : commits.kind === 'failed' ? commits.text : undefined
  return (
    <Dialog open onClose={close} title={COPY.baseline}>
      <div className="compare-pick">
        <SearchField
          label={COPY.searchBase}
          value={query}
          maxLength={200}
          onValueChange={setQuery}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing && typed && !containsSecret(typed)) {
              event.preventDefault()
              choose(typed)
            }
          }}
        />
        <div className="compare-options">
          <Button size="sm" variant="ghost" onClick={() => choose('')}>
            {COPY.auto}
          </Button>
          {selectTyped && (
            <Button size="sm" variant="outline" onClick={() => choose(typed)}>
              {COPY.compareTyped}
            </Button>
          )}
          {failure && (
            <p role="status">
              {failure}{' '}
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  retryBranches()
                  retryCommits()
                }}>
                {COPY.retry}
              </Button>
            </p>
          )}
          {(branches.kind === 'loading' || commits.kind === 'loading') && <p role="status">{COPY.reading}</p>}
          {!!names.length && <h3>{COPY.branches}</h3>}
          {names.map(branch => (
            <button type="button" key={branch.name} onClick={() => choose(branch.name)}>
              <VisibleText text={branch.name} />
            </button>
          ))}
          {!!recent.length && <h3>{COPY.commit}</h3>}
          {recent.map(item => (
            <button type="button" key={item.sha} onClick={() => choose(item.sha)}>
              <code>{item.sha.slice(0, 9)}</code>
              <VisibleText text={item.subject ?? ''} />
            </button>
          ))}
        </div>
      </div>
    </Dialog>
  )
}

/** The history views: read-only, each list read from the Host when it is opened and bounded there. */
export function GitHistoryView(props: GitHistoryViewProps) {
  const { sessionId, mode, poke, offline, onBack, canChooseComparisonBase } = props
  const base = `tasks/${encodeURIComponent(sessionId)}/git`
  const listPath =
    mode.kind === 'compare' || mode.kind === 'commit'
      ? undefined
      : mode.kind === 'file'
        ? `${base}/history?${new URLSearchParams({ path: mode.path }).toString()}`
        : `${base}/history`
  const [read, retry] = useRead<GitHistory>(listPath, poke, offline)
  const [opened, setOpened] = useState<string>()
  const [reference, setReference] = useState('')
  const [choosingBase, setChoosingBase] = useState(false)
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
          {canChooseComparisonBase && (
            <div className="changes-line">
              <Button
                size="xs"
                variant="outline"
                aria-label={COPY.baseline}
                icon={CommitGlyph}
                disabled={offline}
                onClick={() => setChoosingBase(true)}>
                {reference ? <VisibleText text={reference} /> : COPY.auto}
              </Button>
            </div>
          )}
          {canChooseComparisonBase && choosingBase && !offline && (
            <ComparePicker
              key={sessionId}
              base={base}
              close={() => setChoosingBase(false)}
              choose={value => {
                setReference(value)
                setChoosingBase(false)
              }}
            />
          )}
          <TreeFiles key={reference} {...shared} reference={reference} base={`${base}/compare`} query={reference} />
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
