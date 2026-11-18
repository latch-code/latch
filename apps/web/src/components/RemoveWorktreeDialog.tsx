import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { WorktreeInventory, WorktreeRemoval } from '@latch/protocol'
import { Button, Checkbox, Hint, InlineNotice, Modal, ModalHeader, Spinner, StatusWord } from '@latch/ui'
import { ApiError, api, errorMessage, isUncertain, newRequestId } from '../core/api.ts'
import { VisibleText } from '../components/VisibleText.tsx'
import { useViewport } from '../breakpoints.ts'
import { defineCopy, formatNumber, plural } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    ignoredCount: (count: number) => `${formatNumber(count)} 个被忽略的文件`,
    exampleStart: '（例如 ',
    exampleEnd: '）',
    folderCount: (count: number) => `${formatNumber(count)} 个`,
    turnBusy: 'Agent 正在这个工作树里运行，这一轮结束后再移除',
    deliveryBusy: '交付操作进行中，结束后再移除',
    terminalBusy: '这个会话还有打开的终端，关闭后再移除',
    starting: '正在用它开始会话',
    removing: '正在移除',
    branchDeleted: '已移除工作树和分支',
    branchKept: (value1: string | number) => `已移除工作树 · 分支 ${value1} 已保留`,
    removed: '已移除工作树',
    staged: (count: number) => `已暂存 ${formatNumber(count)}`,
    unstaged: (count: number) => `未暂存 ${formatNumber(count)}`,
    untracked: (count: number) => `未跟踪 ${formatNumber(count)}`,
    ahead: (count: number, value2: string) => `${formatNumber(count)} 个提交未推送到 ${value2}`,
    pushed: (value1: string | number) => `已推送到 ${value1}`,
    unpushed: (count: number) => `${formatNumber(count)} 个提交从未推送`,
    noNewCommits: '没有新提交',
    uncommitted: '未提交',
    none: '没有',
    ignored: '被忽略',
    commits: '提交',
    branch: '分支',
    detached: '分离 HEAD',
    keep: '保留',
    mergedDelete: '已合并，会删除',
    emptyDelete: '没有新提交，会删除',
    branchExternal: '不是 Latch 新建的分支，不删除。',
    merged: (value1: string | number) => `提交都已在 ${value1} 上。`,
    noOwnCommits: '没有自己的提交，删除不丢提交。',
    notMerged: '没有找到它已合并的证据。',
    unknown: '还不知道是否已移除。重试会发送同一个请求。',
    heading: (value1: string | number) => `移除「${value1}」的工作树`,
    retry: '重试',
    loading: '正在读取工作树',
    nestedRepo: ' 是另一个 Git 仓库，先在终端里移走它',
    tooMany: ' 里文件太多，无法检查，先在终端里删除或移走它',
    submoduleData: (value1: string | number) => `子模块仓库留在 ${value1}，确认其中的提交已推送后在终端里删除它`,
    deinit: (count: number) => `有 ${formatNumber(count)} 个已检出的子模块，先在终端里运行 git submodule deinit --all`,
    discardBoth: (uncommitted: number, ignored: number) =>
      `丢弃 ${formatNumber(uncommitted)} 个未提交的文件和 ${formatNumber(ignored)} 个被忽略的文件`,
    discardChanges: (count: number) => `丢弃 ${formatNumber(count)} 个未提交的文件`,
    discardIgnored: (count: number) => `丢弃 ${formatNumber(count)} 个被忽略的文件`,
    irreversible: '这些文件会被删除，无法恢复。',
    retrySame: '重试同一请求',
    remove: '移除工作树',
    cancel: '取消',
  },
  {
    ignoredCount: (count: number) => plural(count, { one: '{n} ignored file', other: '{n} ignored files' }),
    exampleStart: ' (e.g. ',
    exampleEnd: ')',
    folderCount: (count: number) => plural(count, { one: '{n} file', other: '{n} files' }),
    turnBusy: 'The agent is running in this worktree. Remove it after this turn.',
    deliveryBusy: 'Delivery is in progress. Remove the worktree when it ends.',
    terminalBusy: 'This session has an open terminal. Close it first.',
    starting: 'Starting a session here',
    removing: 'Removing',
    branchDeleted: 'Worktree and branch removed',
    branchKept: (value1: string | number) => `Worktree removed · Branch ${value1} kept`,
    removed: 'Worktree removed',
    staged: (count: number) => `${formatNumber(count)} staged`,
    unstaged: (count: number) => `${formatNumber(count)} unstaged`,
    untracked: (count: number) => `${formatNumber(count)} untracked`,
    ahead: (count: number, value2: string) =>
      `${plural(count, { one: '{n} commit hasn’t', other: '{n} commits haven’t' })} been pushed to ${value2}`,
    pushed: (value1: string | number) => `Pushed to ${value1}`,
    unpushed: (count: number) => `${plural(count, { one: '{n} commit has', other: '{n} commits have' })} never been pushed`,
    noNewCommits: 'No new commits',
    uncommitted: 'Uncommitted',
    none: 'None',
    ignored: 'Ignored',
    commits: 'Commits',
    branch: 'Branch',
    detached: 'Detached HEAD',
    keep: 'Keep',
    mergedDelete: 'Merged · Will be deleted',
    emptyDelete: 'No new commits · Will be deleted',
    branchExternal: 'Latch didn’t create this branch. It will be kept.',
    merged: (value1: string | number) => `All commits are already on ${value1}.`,
    noOwnCommits: 'Deleting this branch won’t lose any commits.',
    notMerged: 'No evidence that this branch has been merged.',
    unknown: 'Removal outcome unknown. Retrying sends the same request.',
    heading: (value1: string | number) => `Remove the worktree for “${value1}”`,
    retry: 'Retry',
    loading: 'Reading worktree',
    nestedRepo: ' is another Git repository. Move it out in Terminal first.',
    tooMany: ' has too many files to inspect. Delete it or move it in Terminal first.',
    submoduleData: (value1: string | number) =>
      `The submodule repository stays at ${value1}. Confirm its commits have been pushed before deleting it in Terminal.`,
    deinit: (count: number) =>
      `${plural(count, { one: '{n} submodule is', other: '{n} submodules are' })} checked out. Run git submodule deinit --all in Terminal first.`,
    discardBoth: (uncommitted: number, ignored: number) =>
      `Discard ${formatNumber(uncommitted)} uncommitted files and ${formatNumber(ignored)} ignored files`,
    discardChanges: (count: number) => `Discard ${formatNumber(count)} uncommitted files`,
    discardIgnored: (count: number) => `Discard ${formatNumber(count)} ignored files`,
    irreversible: 'These files will be deleted permanently.',
    retrySame: 'Retry same request',
    remove: 'Remove worktree',
    cancel: 'Cancel',
  },
)

/** A session's worktree, or a leftover of a project (one no session owns), by its folder name. */
export type WorktreeTarget = { kind: 'session'; sessionId: string } | { kind: 'leftover'; projectId: string; name: string }

function endpoint(target: WorktreeTarget): string {
  return target.kind === 'session'
    ? `tasks/${encodeURIComponent(target.sessionId)}/worktree`
    : `workspaces/${encodeURIComponent(target.projectId)}/worktrees/${encodeURIComponent(target.name)}`
}

const BUSY: Record<NonNullable<WorktreeInventory['busy']>, string> = {
  get turn() {
    return COPY.turnBusy
  },
  get delivery() {
    return COPY.deliveryBusy
  },
  get terminal() {
    return COPY.terminalBusy
  },
  get starting() {
    return COPY.starting
  },
  get removing() {
    return COPY.removing
  },
}

/** What happened, in a few words, for the toast after it is gone. */
export function removalWords(result: WorktreeRemoval): string {
  if (result.branch === 'deleted') return COPY.branchDeleted
  if (result.branch === 'kept') return COPY.branchKept(result.branchName ?? '')
  return COPY.removed
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="worktree-facts-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function Facts({ facts }: { facts: WorktreeInventory }) {
  const counts = [
    facts.staged ? COPY.staged(facts.staged) : '',
    facts.unstaged ? COPY.unstaged(facts.unstaged) : '',
    facts.untracked ? COPY.untracked(facts.untracked) : '',
  ].filter(Boolean)
  const stat = facts.insertions !== undefined && (facts.insertions || facts.deletions) ? `+${facts.insertions} −${facts.deletions}` : ''
  const commits =
    facts.upstream !== undefined
      ? facts.ahead
        ? { tone: 'warn' as const, text: COPY.ahead(facts.ahead, facts.upstream) }
        : { tone: 'neutral' as const, text: COPY.pushed(facts.upstream) }
      : facts.unpushed
        ? { tone: 'warn' as const, text: COPY.unpushed(facts.unpushed) }
        : { tone: 'neutral' as const, text: COPY.noNewCommits }
  return (
    <dl className="worktree-facts">
      <Line label={COPY.uncommitted}>
        {facts.files ? (
          <StatusWord tone="warn">
            {counts.join(' · ')}
            {stat && <span className="worktree-facts-stat">{stat}</span>}
          </StatusWord>
        ) : (
          COPY.none
        )}
      </Line>
      {facts.ignored > 0 && (
        <Line label={COPY.ignored}>
          <StatusWord tone="warn">
            {COPY.ignoredCount(facts.ignored)}
            {!facts.ignoredFolders?.length && facts.ignoredExample && (
              <>
                {COPY.exampleStart}
                <VisibleText text={facts.ignoredExample} />
                {COPY.exampleEnd}
              </>
            )}
          </StatusWord>
          {facts.ignoredFolders?.map(folder => (
            <span key={folder.path} className="worktree-facts-stat">
              <VisibleText text={folder.path} /> {COPY.folderCount(folder.files)}
            </span>
          ))}
        </Line>
      )}
      <Line label={COPY.commits}>{commits.tone === 'warn' ? <StatusWord tone="warn">{commits.text}</StatusWord> : commits.text}</Line>
      <Line label={COPY.branch}>
        {facts.branch ? <VisibleText text={facts.branch} /> : COPY.detached}
        <Hint
          inline
          label={
            !facts.ownBranch
              ? COPY.keep
              : facts.merged?.into === 'default'
                ? COPY.mergedDelete
                : facts.merged
                  ? COPY.emptyDelete
                  : COPY.keep
          }>
          {!facts.ownBranch
            ? COPY.branchExternal
            : facts.merged?.into === 'default'
              ? COPY.merged(facts.merged.ref)
              : facts.merged
                ? COPY.noOwnCommits
                : COPY.notMerged}
        </Hint>
      </Line>
    </dl>
  )
}

/**
 * 移除工作树: what is there first (uncommitted counts with a short diffstat, commits not pushed), then the removal. With
 * uncommitted files it asks to discard exactly that many, and says they cannot be restored. A request that may have
 * reached the Host is retried with the same request ID.
 */
export function RemoveWorktreeDialog({
  target,
  title,
  onClose,
  onRemoved,
}: {
  target: WorktreeTarget
  /** Whose worktree, for the heading: the session's title or the folder name. */
  title: string
  onClose: () => void
  onRemoved: (result: WorktreeRemoval) => void
}) {
  const phone = useViewport() === 'phone'
  const [facts, setFacts] = useState<WorktreeInventory | null>(null)
  const [loadError, setLoadError] = useState('')
  const [discard, setDiscard] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const request = useRef<{ id: string; discard: number | undefined; digest: string; deleteBranch: boolean } | null>(null)
  const path = endpoint(target)

  const load = () => {
    void api<WorktreeInventory>(path).then(
      reply => {
        setFacts(reply)
        setLoadError('')
        setDiscard(false)
      },
      (cause: unknown) => {
        setLoadError(errorMessage(cause))
      },
    )
  }
  useEffect(load, [path])

  const remove = async () => {
    if (!facts) return
    // The same request until the Host answers it; a retry after an unknown result repeats it exactly.
    request.current ??= {
      id: newRequestId(),
      discard: facts.files + facts.ignored || undefined,
      digest: facts.digest,
      // Only what the dialog showed: a branch it said is kept is never deleted.
      deleteBranch: facts.ownBranch && facts.merged !== undefined,
    }
    setBusy(true)
    setError('')
    try {
      const result = await api<WorktreeRemoval>(`${path}/remove`, {
        method: 'POST',
        body: {
          requestId: request.current.id,
          ...(request.current.discard ? { discard: request.current.discard, digest: request.current.digest } : {}),
          ...(request.current.deleteBranch ? { deleteBranch: true } : {}),
        },
      })
      onRemoved(result)
      onClose()
    } catch (cause) {
      setBusy(false)
      if (cause instanceof ApiError && cause.code === 'worktree-removed') {
        onRemoved({ removed: true, discarded: 0, branch: 'none' })
        onClose()
        return
      }
      const unknown = isUncertain(cause)
      setUncertain(unknown)
      if (!unknown) request.current = null
      setError(unknown ? COPY.unknown : errorMessage(cause))
      // What is there changed since it was read: read it again, and ask again.
      if (cause instanceof ApiError && (cause.code === 'worktree-dirty' || cause.code === 'worktree-changed')) load()
    }
  }

  const blocked =
    facts?.busy !== undefined
    || facts?.nested !== undefined
    || facts?.tooLarge !== undefined
    || !!facts?.submodules
    || facts?.submoduleData !== undefined
  const discarded = facts ? facts.files + facts.ignored : 0
  const ready = facts !== null && !blocked && (discarded === 0 || discard || uncertain)
  const close = () => {
    if (!busy) onClose()
  }
  const heading = COPY.heading(title)
  const body = (
    <div className="worktree-remove">
      {facts === null ? (
        loadError ? (
          <InlineNotice
            tone="error"
            action={
              <Button
                size="xs"
                onClick={() => {
                  setLoadError('')
                  load()
                }}>
                {COPY.retry}
              </Button>
            }>
            {loadError}
          </InlineNotice>
        ) : (
          <Spinner size={14} label={COPY.loading} />
        )
      ) : (
        <>
          <Facts facts={facts} />
          {facts.busy && <InlineNotice tone="warn">{BUSY[facts.busy]}</InlineNotice>}
          {facts.nested !== undefined && (
            <InlineNotice tone="warn">
              <VisibleText text={facts.nested} />
              {COPY.nestedRepo}
            </InlineNotice>
          )}
          {facts.tooLarge !== undefined && (
            <InlineNotice tone="warn">
              <VisibleText text={facts.tooLarge} />
              {COPY.tooMany}
            </InlineNotice>
          )}
          {facts.submoduleData && <InlineNotice tone="warn">{COPY.submoduleData(facts.submoduleData.path)}</InlineNotice>}
          {!!facts.submodules && <InlineNotice tone="warn">{COPY.deinit(facts.submodules)}</InlineNotice>}
          {discarded > 0 && !blocked && (
            <Checkbox
              className="worktree-remove-discard"
              checked={discard || uncertain}
              disabled={busy || uncertain}
              onChange={event => {
                setDiscard(event.currentTarget.checked)
              }}
              label={
                facts.files && facts.ignored
                  ? COPY.discardBoth(facts.files, facts.ignored)
                  : facts.files
                    ? COPY.discardChanges(facts.files)
                    : COPY.discardIgnored(facts.ignored)
              }
              description={COPY.irreversible}
            />
          )}
        </>
      )}
      {error && <InlineNotice tone={uncertain ? 'warn' : 'error'}>{error}</InlineNotice>}
    </div>
  )
  const action = (
    <Button
      size="md"
      variant="destroy"
      disabled={!ready || busy}
      loading={busy}
      onClick={() => {
        void remove()
      }}>
      {uncertain ? COPY.retrySame : COPY.remove}
    </Button>
  )
  // A phone shows the same modal as a sheet: the answers stay in the footer; its close button only dismisses.
  return (
    <Modal label={heading} variant={phone ? 'sheet' : 'dialog'} dismissible={!busy} onClose={close} className="confirm-dialog">
      <ModalHeader title={heading} onClose={close} />
      <div className="ui-modal-body">{body}</div>
      <footer className="ui-modal-footer">
        <Button size="md" disabled={busy} onClick={onClose}>
          {COPY.cancel}
        </Button>
        {action}
      </footer>
    </Modal>
  )
}
