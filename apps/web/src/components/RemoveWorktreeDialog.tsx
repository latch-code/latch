import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { WorktreeInventory, WorktreeRemoval } from '@latch/protocol'
import { Button, Checkbox, Hint, InlineNotice, Modal, ModalHeader, Spinner, StatusWord } from '@latch/ui'
import { ApiError, api, errorMessage, isUncertain, newRequestId } from '../core/api.ts'
import { VisibleText } from '../components/VisibleText.tsx'
import { useViewport } from '../breakpoints.ts'

/** A session's worktree, or a leftover of a project (one no session owns), by its folder name. */
export type WorktreeTarget = { kind: 'session'; sessionId: string } | { kind: 'leftover'; projectId: string; name: string }

function endpoint(target: WorktreeTarget): string {
  return target.kind === 'session'
    ? `tasks/${encodeURIComponent(target.sessionId)}/worktree`
    : `workspaces/${encodeURIComponent(target.projectId)}/worktrees/${encodeURIComponent(target.name)}`
}

const BUSY: Record<NonNullable<WorktreeInventory['busy']>, string> = {
  turn: 'Agent 正在这个工作树里运行，这一轮结束后再移除',
  delivery: '交付操作进行中，结束后再移除',
  terminal: '这个会话还有打开的终端，关闭后再移除',
  starting: '正在用它开始会话',
  removing: '正在移除',
}

/** What happened, in a few words, for the toast after it is gone. */
export function removalWords(result: WorktreeRemoval): string {
  if (result.branch === 'deleted') return '已移除工作树和分支'
  if (result.branch === 'kept') return `已移除工作树 · 分支 ${result.branchName ?? ''} 已保留`
  return '已移除工作树'
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
    facts.staged ? `已暂存 ${facts.staged}` : '',
    facts.unstaged ? `未暂存 ${facts.unstaged}` : '',
    facts.untracked ? `未跟踪 ${facts.untracked}` : '',
  ].filter(Boolean)
  const stat = facts.insertions !== undefined && (facts.insertions || facts.deletions) ? `+${facts.insertions} −${facts.deletions}` : ''
  const commits =
    facts.upstream !== undefined
      ? facts.ahead
        ? { tone: 'warn' as const, text: `${facts.ahead} 个提交未推送到 ${facts.upstream}` }
        : { tone: 'neutral' as const, text: `已推送到 ${facts.upstream}` }
      : facts.unpushed
        ? { tone: 'warn' as const, text: `${facts.unpushed} 个提交从未推送` }
        : { tone: 'neutral' as const, text: '没有新提交' }
  return (
    <dl className="worktree-facts">
      <Line label="未提交">
        {facts.files ? (
          <StatusWord tone="warn">
            {counts.join(' · ')}
            {stat && <span className="worktree-facts-stat">{stat}</span>}
          </StatusWord>
        ) : (
          '没有'
        )}
      </Line>
      {facts.ignored > 0 && (
        <Line label="被忽略">
          <StatusWord tone="warn">
            {facts.ignored} 个被忽略的文件
            {!facts.ignoredFolders?.length && facts.ignoredExample && (
              <>
                （例如 <VisibleText text={facts.ignoredExample} />）
              </>
            )}
          </StatusWord>
          {facts.ignoredFolders?.map(folder => (
            <span key={folder.path} className="worktree-facts-stat">
              <VisibleText text={folder.path} /> {folder.files} 个
            </span>
          ))}
        </Line>
      )}
      <Line label="提交">{commits.tone === 'warn' ? <StatusWord tone="warn">{commits.text}</StatusWord> : commits.text}</Line>
      <Line label="分支">
        {facts.branch ? <VisibleText text={facts.branch} /> : '分离 HEAD'}
        <Hint
          label={
            !facts.ownBranch ? '保留' : facts.merged?.into === 'default' ? '已合并，会删除' : facts.merged ? '没有新提交，会删除' : '保留'
          }>
          {!facts.ownBranch
            ? '不是 Latch 新建的分支，不删除。'
            : facts.merged?.into === 'default'
              ? `提交都已在 ${facts.merged.ref} 上。`
              : facts.merged
                ? '没有自己的提交，删除不丢提交。'
                : '没有找到它已合并的证据。'}
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
      setError(unknown ? '还不知道是否已移除。重试会发送同一个请求。' : errorMessage(cause))
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
  const heading = `移除「${title}」的工作树`
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
                重试
              </Button>
            }>
            {loadError}
          </InlineNotice>
        ) : (
          <Spinner size={14} label="正在读取工作树" />
        )
      ) : (
        <>
          <Facts facts={facts} />
          {facts.busy && <InlineNotice tone="warn">{BUSY[facts.busy]}</InlineNotice>}
          {facts.nested !== undefined && (
            <InlineNotice tone="warn">
              <VisibleText text={facts.nested} /> 是另一个 Git 仓库，先在终端里移走它
            </InlineNotice>
          )}
          {facts.tooLarge !== undefined && (
            <InlineNotice tone="warn">
              <VisibleText text={facts.tooLarge} /> 里文件太多，无法检查，先在终端里删除或移走它
            </InlineNotice>
          )}
          {facts.submoduleData && (
            <InlineNotice tone="warn">{`子模块仓库留在 ${facts.submoduleData.path}，确认其中的提交已推送后在终端里删除它`}</InlineNotice>
          )}
          {!!facts.submodules && (
            <InlineNotice tone="warn">{`有 ${facts.submodules} 个已检出的子模块，先在终端里运行 git submodule deinit --all`}</InlineNotice>
          )}
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
                  ? `丢弃 ${facts.files} 个未提交的文件和 ${facts.ignored} 个被忽略的文件`
                  : facts.files
                    ? `丢弃 ${facts.files} 个未提交的文件`
                    : `丢弃 ${facts.ignored} 个被忽略的文件`
              }
              description="这些文件会被删除，无法恢复。"
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
      {uncertain ? '重试同一请求' : '移除工作树'}
    </Button>
  )
  // A phone shows the same modal as a sheet: the answers stay in the footer; its close button only dismisses.
  return (
    <Modal label={heading} variant={phone ? 'sheet' : 'dialog'} dismissible={!busy} onClose={close} className="confirm-dialog">
      <ModalHeader title={heading} onClose={close} />
      <div className="ui-modal-body">{body}</div>
      <footer className="ui-modal-footer">
        <Button size="md" disabled={busy} onClick={onClose}>
          取消
        </Button>
        {action}
      </footer>
    </Modal>
  )
}
