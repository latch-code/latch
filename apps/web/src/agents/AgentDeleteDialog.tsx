import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentFolderExport, AgentFolderResult, AgentFolderView, AgentHome } from '@latch/protocol'
import { Button, Dialog, Hint, InlineNotice, Spinner } from '@latch/ui'
import { api, ApiError, errorMessage, newRequestId } from '../core/api.ts'
import { shellFolders, type AgentFolderStart } from '../core/shell.ts'
import { defineCopy, formatNumber } from '../core/i18n.ts'
import { agentDeletionMessage } from '../deletionCopy.ts'
import type { AgentWrites } from './useAgentWrites.ts'

const FOLDER_COPY = defineCopy(
  {
    title: (name: string) => `删除「${name}」？`,
    cancel: '取消',
    delete: '删除',
    retry: '重试同一请求',
    deleteForGood: '永久删除',
    exportThenDelete: '导出后删除',
    exportWhat: 'zip 里只有它的工作文件夹，不含记忆、指令和对话。导出完成并核对后才删除。',
    exportElsewhere: '需要导出？',
    exportOnMac: '导出文件夹只能在这台 Mac 的 Latch 桌面端进行；在这里只能永久删除。',
    exporting: '正在导出…',
    deleting: '正在删除…',
    stopExport: '取消导出',
    cancelled: '已取消导出，什么都没有删除。',
    tooLarge: (size: string) => `文件夹太大（${size}），不能在这里导出；什么都没有删除。`,
    changed: '导出时文件夹有变化，什么都没有删除。请重试。',
    exportFailed: '导出没有完成，什么都没有删除。',
    exportedNotDeleted: '已导出到所选文件夹；Agent 和文件夹都没有删除。',
    exportedAgentGone: '已导出到所选文件夹，Agent 已删除；文件夹没有删除，可在 设置 › 数据 里删除。',
    unreadable: '读不了文件夹，没有导出，什么都没有删除。',
    badDirectory: '选择的位置不能用来导出，换一个文件夹。',
    busy: '另一次导出还在进行，等它结束后再试。',
    inUse: '还有会话在运行或打开着终端，结束后再导出；什么都没有删除。',
    unknown: '删除结果尚未确认。',
    unknownExport: '还不知道导出是否开始；再按一次会核对同一次导出。',
    left: (why: string) => `已删除 Agent，文件夹保留在原处：${why}`,
    kept: '已删除 Agent，文件夹保留在原处。',
    later: '可在 设置 › 数据 里删除。',
    exportHolds: '导出只含文件夹',
    leftWhy: {
      changed: '文件夹在你确认后有了变化，没有删除。',
      unconfirmed: '这个文件夹没有给你看过或没有导出，没有删除。',
      unverified: '文件夹已不是 Latch 建的那个，没有动它。',
      'in-use': '还有会话在运行或打开着终端。',
      mount: '文件夹里有另一个磁盘。',
      'too-large': '文件夹里的项目太多。',
      unavailable: '这台电脑没有删除文件夹的组件。',
      'audit-failed': '没能先写下安全记录。',
      failed: '删除没有完成。',
    } as Record<string, string>,
  },
  {
    title: (name: string) => `Delete “${name}”?`,
    cancel: 'Cancel',
    delete: 'Delete',
    retry: 'Retry the same request',
    deleteForGood: 'Delete permanently',
    exportThenDelete: 'Export, then delete',
    exportWhat:
      'The zip holds its working folder only, not its memory, instructions or conversations. Deletion follows once the export is checked.',
    exportElsewhere: 'Need an export?',
    exportOnMac: 'Exporting the folder works only in the Latch desktop app on this Mac. Here it can only be deleted permanently.',
    exporting: 'Exporting…',
    deleting: 'Deleting…',
    stopExport: 'Cancel export',
    cancelled: 'Export cancelled. Nothing was deleted.',
    tooLarge: (size: string) => `The folder is too large to export here (${size}). Nothing was deleted.`,
    changed: 'The folder changed during the export. Nothing was deleted. Try again.',
    exportFailed: 'The export didn’t finish. Nothing was deleted.',
    exportedNotDeleted: 'Exported to the chosen folder. The Agent and its folder weren’t deleted.',
    exportedAgentGone: 'Exported to the chosen folder and the Agent was deleted. Its folder wasn’t; you can delete it in Settings › Data.',
    unreadable: 'The folder couldn’t be read. Nothing was exported or deleted.',
    badDirectory: 'That location can’t be used for the export. Choose another folder.',
    busy: 'Another export is running. Try again when it ends.',
    inUse: 'A session is still running or a terminal is open. Export once it ends. Nothing was deleted.',
    unknown: 'The deletion result is unknown.',
    unknownExport: 'It isn’t known yet whether the export started. Press again to check the same export.',
    left: (why: string) => `Agent deleted. Its folder was kept: ${why}`,
    kept: 'Agent deleted. Its folder was kept.',
    later: ' You can delete it in Settings › Data.',
    exportHolds: 'The export holds the folder only',
    leftWhy: {
      changed: 'The folder changed after you confirmed, so it wasn’t deleted.',
      unconfirmed: 'This folder wasn’t shown to you or wasn’t exported, so it wasn’t deleted.',
      unverified: 'The folder is no longer the one Latch made, so it was left alone.',
      'in-use': 'A session is still running or a terminal is open.',
      mount: 'Another disk is mounted inside the folder.',
      'too-large': 'The folder has too many items.',
      unavailable: 'This computer has no component to delete the folder.',
      'audit-failed': 'The security record couldn’t be written first.',
      failed: 'The deletion didn’t finish.',
    } as Record<string, string>,
  },
)

const GB = 1024 * 1024 * 1024

/** What an export that did not end in deletion says: nothing was deleted, and why. */
function exportFailure(state: Pick<AgentFolderExport, 'state' | 'phase' | 'code' | 'bytes' | 'agentDeleted'>): string {
  if (state.state === 'cancelled' || state.code === 'export-cancelled') return FOLDER_COPY.cancelled
  if (state.phase === 'delete') return state.agentDeleted ? FOLDER_COPY.exportedAgentGone : FOLDER_COPY.exportedNotDeleted
  if (state.code === 'agent-folder-unreadable') return FOLDER_COPY.unreadable
  if (state.code === 'agent-folder-too-large')
    return FOLDER_COPY.tooLarge(state.bytes === undefined ? '> 2 GB' : `${formatNumber(Math.ceil((state.bytes / GB) * 10) / 10)} GB`)
  if (state.code === 'agent-folder-changed' || state.code === 'agent-folder-mount') return FOLDER_COPY.changed
  return FOLDER_COPY.exportFailed
}

/** Main's answer when the export did not start. */
function startFailure(result: AgentFolderStart): string {
  if (result.status === 'busy' || (result.status === 'failed' && result.code === 'export-busy')) return FOLDER_COPY.busy
  if (result.status === 'failed' && result.code === 'agent-folder-in-use') return FOLDER_COPY.inUse
  if (result.status === 'failed' && (result.code === 'export-folder-invalid' || result.code === 'invalid')) return FOLDER_COPY.badDirectory
  return FOLDER_COPY.exportFailed
}

/** A short line after the deletion when the folder stayed; nothing when it went (the dialog said so) or there was none. */
export function folderNotice(result: AgentFolderResult | undefined): string | undefined {
  if (result?.outcome !== 'left' && result?.outcome !== 'kept') return undefined
  // Every folder that is still the one Latch made is listed in 设置 › 数据; one that is not never is.
  const later = result.reason !== 'unverified' ? FOLDER_COPY.later : ''
  if (result.outcome === 'kept') return `${FOLDER_COPY.kept}${later}`
  const why = (result.reason && FOLDER_COPY.leftWhy[result.reason]) ?? FOLDER_COPY.leftWhy.failed
  return `${FOLDER_COPY.left(why)}${later}`
}

/**
 * 导出后删除 as the page follows it: main's native picker, then the Host's job under the page's request ID, polled until
 * it ends. Nothing is deleted until the Host has verified the archive; a failure says nothing was deleted.
 */
export function useFolderExport(target: { agentId: string } | { folder: string }, onDone: (result: AgentFolderResult | undefined) => void) {
  const [state, setState] = useState<AgentFolderExport | null>(null)
  const [error, setError] = useState('')
  const requestId = useRef(newRequestId())
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const done = useRef(onDone)
  useEffect(() => {
    done.current = onDone
  })
  useEffect(() => () => clearTimeout(timer.current), [])
  const poll = useCallback(() => {
    timer.current = setTimeout(() => {
      void api<{ export: AgentFolderExport }>(`custom-agents/folder-exports/${encodeURIComponent(requestId.current)}`)
        .then(({ export: next }) => {
          setState(next)
          if (next.state === 'running') poll()
          else if (next.state === 'done') done.current(next.folder)
          else {
            setError(exportFailure(next))
            // A failed export leaves nothing to retry under this request; the next press is a new one.
            requestId.current = newRequestId()
          }
        })
        .catch((cause: unknown) => {
          setError(errorMessage(cause))
          // The Host no longer knows this export (it restarted): nothing more will come; anything else is retried.
          if (cause instanceof ApiError && cause.status === 404) setState(null)
          else poll()
        })
    }, 400)
  }, [])
  const start = async () => {
    const exportAgentFolder = shellFolders()?.exportAgentFolder
    if (!exportAgentFolder) return
    setError('')
    let result: AgentFolderStart
    try {
      result = await exportAgentFolder({ ...target, requestId: requestId.current })
    } catch {
      result = { status: 'failed', code: 'host-failed' }
    }
    if (result.status === 'canceled') return
    if (result.status !== 'exporting') {
      // Main's answer may have been lost after the Host took the request: only the Host says it did not start.
      const known = await api<{ export: AgentFolderExport }>(`custom-agents/folder-exports/${encodeURIComponent(requestId.current)}`).catch(
        // Unknown to the Host, or a device that may not start one at all: it did not start.
        (cause: unknown) => (cause instanceof ApiError && (cause.status === 404 || cause.status === 403) ? null : undefined),
      )
      if (known === null) {
        setError(startFailure(result))
        return
      }
      if (known === undefined) {
        setError(FOLDER_COPY.unknownExport)
        return
      }
    }
    setState({ requestId: requestId.current, state: 'running', phase: 'export' })
    poll()
  }
  const cancel = async () => {
    try {
      const { export: next } = await api<{ export: AgentFolderExport }>(
        `custom-agents/folder-exports/${encodeURIComponent(requestId.current)}/cancel`,
        { method: 'POST', body: {} },
      )
      setState(next)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }
  return { state, error, running: state?.state === 'running', start, cancel, available: !!shellFolders()?.exportAgentFolder }
}

/**
 * Deleting one of 我的 Agent. When its folder holds files the person chooses: 导出后删除 (the desktop app on this Mac
 * only) or 永久删除. With an empty folder or none there is nothing to ask. The folder is never kept silently: after the
 * deletion `onDeleted` gets a short line when it stayed.
 */
export function AgentDeleteDialog({
  agent,
  writes,
  onClose,
  onDeleted,
}: {
  agent: { id: string; name: string }
  writes: AgentWrites
  onClose: () => void
  onDeleted: (notice?: string) => void
}) {
  const [home, setHome] = useState<AgentHome | null>(null)
  const [folders, setFolders] = useState<AgentFolderView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    const id = encodeURIComponent(agent.id)
    void api<AgentHome>(`custom-agents/${id}/home`)
      .then(value => live && setHome(value))
      .catch(() => {})
    void api<AgentFolderView>(`custom-agents/${id}/folders`)
      .then(value => live && setFolders(value))
      // Unknown: ask as if it held files, and show (so send) no home: none is removed on this answer.
      .catch(() => live && setFolders({ contents: 'files', homes: [] }))
    return () => {
      live = false
    }
  }, [agent.id])
  const finish = (result: AgentFolderResult | undefined) => {
    onDeleted(folderNotice(result))
    onClose()
  }
  const exporting = useFolderExport({ agentId: agent.id }, finish)
  const contents = folders?.contents
  const choose = contents === 'files'
  const remove = async () => {
    setBusy(true)
    setError('')
    try {
      const done = writes.held
        ? await writes.retry<{ folder?: AgentFolderResult }>()
        : await writes.run<{ folder?: AgentFolderResult }>(
            `agent:${agent.id}`,
            `custom-agents/${encodeURIComponent(agent.id)}`,
            'DELETE',
            // Exactly the homes this dialog showed, with their counts: a home that appeared or changed since stays.
            contents === 'none' || !folders ? {} : { folder: 'delete', seen: folders.homes },
          )
      if (done === undefined) {
        setError(FOLDER_COPY.unknown)
        setBusy(false)
        return
      }
      finish(done.folder)
    } catch (cause) {
      setError(errorMessage(cause))
      setBusy(false)
    }
  }
  const locked = busy || exporting.running || contents === undefined
  const status = exporting.running ? (exporting.state?.phase === 'delete' ? FOLDER_COPY.deleting : FOLDER_COPY.exporting) : undefined
  return (
    <Dialog
      open
      size="md"
      className="agent-delete-dialog"
      title={FOLDER_COPY.title(agent.name)}
      dismissible={!locked}
      onClose={() => {
        if (!locked) onClose()
      }}
      note={
        exporting.running && exporting.state?.phase === 'export' ? (
          <Button variant="ghost" onClick={() => void exporting.cancel()}>
            {FOLDER_COPY.stopExport}
          </Button>
        ) : (
          <Button variant="ghost" disabled={locked} onClick={onClose}>
            {FOLDER_COPY.cancel}
          </Button>
        )
      }
      footer={
        <>
          {choose && exporting.available && (
            <Button disabled={locked || writes.held} onClick={() => void exporting.start()}>
              {FOLDER_COPY.exportThenDelete}
            </Button>
          )}
          <Button variant="destroy" disabled={locked || exporting.running} loading={busy} onClick={() => void remove()}>
            {writes.held ? FOLDER_COPY.retry : choose ? FOLDER_COPY.deleteForGood : FOLDER_COPY.delete}
          </Button>
        </>
      }>
      <div className="agent-delete-body">
        <p className="ui-confirm-message">{agentDeletionMessage(home?.available ? home.path : undefined, contents)}</p>
        {choose
          && (exporting.available ? (
            <Hint label={FOLDER_COPY.exportHolds}>{FOLDER_COPY.exportWhat}</Hint>
          ) : (
            <Hint label={FOLDER_COPY.exportElsewhere}>{FOLDER_COPY.exportOnMac}</Hint>
          ))}
        {status && (
          <p className="agent-delete-status" role="status">
            <Spinner size={12} /> {status}
          </p>
        )}
        {(error || exporting.error) && <InlineNotice tone="error">{error || exporting.error}</InlineNotice>}
      </div>
    </Dialog>
  )
}
