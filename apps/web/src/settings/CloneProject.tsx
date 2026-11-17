import { useEffect, useRef, useState, type ReactNode } from 'react'
import { GitBranch } from 'lucide-react'
import type { GitCloneState } from '@latch/protocol'
import { Button, Hint, PromptDialog, Spinner, StatusWord } from '@latch/ui'
import { api, ApiError, MessageError } from '../core/api.ts'
import type { ShellFolders } from '../core/shell.ts'
import { cloneCopy, cloneProgress } from './clone.ts'

/** While a clone runs and this page shows it: how often its progress is read. */
const FOLLOW_MS = 1_000

/**
 * 克隆仓库 in Settings › 项目, on the desktop app of the computer that runs Latch: the address here, where it goes in
 * main's native panel, then the clone's progress and 取消 until it is a project. The page never sends a path.
 */
export function useCloneProject(
  folders: ShellFolders | null,
  onCloned: (workspaceId: string) => void,
): { button: ReactNode; status: ReactNode } {
  const [asking, setAsking] = useState(false)
  const [clone, setClone] = useState<GitCloneState>()
  const [failed, setFailed] = useState<string>()
  const [cancelling, setCancelling] = useState(false)
  const done = useRef<string | undefined>(undefined)
  const running = clone?.state === 'running'

  useEffect(() => {
    if (!running || !clone) return undefined
    const id = clone.id
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void api<{ clone: GitCloneState }>(`workspaces/clone/${id}`).then(
        answer => setClone(answer.clone),
        (cause: unknown) => {
          if (cause instanceof ApiError && cause.code === 'clone-not-found') setClone(undefined)
        },
      )
    }, FOLLOW_MS)
    return () => {
      clearInterval(timer)
    }
  }, [running, clone?.id])

  useEffect(() => {
    if (clone?.state === 'done' && clone.workspaceId && done.current !== clone.id) {
      done.current = clone.id
      onCloned(clone.workspaceId)
    }
  }, [clone, onCloned])

  const start = async (url: string) => {
    if (!folders?.clone) return
    setFailed(undefined)
    const result = await folders.clone(url)
    if (result.status === 'cloning') {
      setClone({ id: result.id, name: result.name, state: 'running', startedAt: new Date().toISOString() })
      return
    }
    if (result.status === 'failed') throw new MessageError(cloneCopy(result.code).label)
    // Canceled in the panel, or another dialog open: the address stays for another try.
    if (result.status === 'busy') throw new MessageError('另一个对话框正在打开')
  }

  const cancel = async () => {
    if (!clone) return
    setCancelling(true)
    try {
      setClone((await api<{ clone: GitCloneState }>(`workspaces/clone/${clone.id}/cancel`, { method: 'POST', body: {} })).clone)
    } catch {
      setFailed('clone-failed')
    } finally {
      setCancelling(false)
    }
  }

  const ended = clone && clone.state !== 'running' ? clone : undefined
  const copy = ended?.code ? cloneCopy(ended.code) : failed ? cloneCopy(failed) : undefined
  if (!folders?.clone) return { button: null, status: null }
  const button = (
    <>
      <Button
        variant="outline"
        icon={GitBranch}
        disabled={running}
        tooltip={running ? '一个仓库正在克隆' : undefined}
        onClick={() => setAsking(true)}>
        克隆仓库
      </Button>
      {asking && (
        <PromptDialog
          title="克隆仓库"
          label="仓库地址"
          initial=""
          confirmLabel="选择位置…"
          maxLength={2048}
          onSubmit={start}
          onClose={() => setAsking(false)}
        />
      )}
    </>
  )
  const status =
    running || ended || failed ? (
      <div className="clone-status" role="status">
        {running ? (
          <>
            <Spinner size={12} />
            <span className="clone-status-name">{clone.name}</span>
            <span className="clone-status-progress">{cloneProgress(clone)}</span>
            <span className="clone-status-space" />
            <Button size="xs" variant="ghost" loading={cancelling} loadingLabel="取消中…" onClick={() => void cancel()}>
              取消
            </Button>
          </>
        ) : ended?.state === 'done' && !ended.notAdded ? (
          <>
            <StatusWord tone="done">已克隆</StatusWord>
            <span className="clone-status-name">{ended.name}</span>
          </>
        ) : (
          <>
            <StatusWord tone={ended?.state === 'cancelled' ? 'neutral' : 'failed'}>
              {ended?.notAdded ? '已克隆，没有加入项目' : ended?.state === 'cancelled' ? '已取消' : '没有克隆'}
            </StatusWord>
            {ended && <span className="clone-status-name">{ended.name}</span>}
            {copy
              && ended?.state !== 'cancelled'
              && (copy.detail ? <Hint label={copy.label}>{copy.detail}</Hint> : <span>{copy.label}</span>)}
          </>
        )}
      </div>
    ) : null
  return { button, status }
}
