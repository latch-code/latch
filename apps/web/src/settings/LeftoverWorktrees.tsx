import { useCallback, useEffect, useState } from 'react'
import { FolderGit2 } from 'lucide-react'
import type { LatchWorktree, WorkspaceInfo } from '@latch/protocol'
import { Button, Icon, InlineNotice, Spinner } from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import { VisibleText } from '../components/VisibleText.tsx'
import { RemoveWorktreeDialog, removalWords } from '../components/RemoveWorktreeDialog.tsx'
import { SettingsGroup, SettingsRow } from './common.tsx'

type Listing = { state: 'reading' } | { state: 'ready'; worktrees: LatchWorktree[] } | { state: 'failed'; message: string }

/**
 * 残留的工作树: the project's Latch worktrees that no session owns (a start that never finished, a crash, a deleted
 * session), each with the same 移除 flow as a session's.
 */
export function LeftoverWorktrees({ project }: { project: WorkspaceInfo }) {
  const [listing, setListing] = useState<Listing>({ state: 'reading' })
  const [removing, setRemoving] = useState<LatchWorktree | null>(null)
  const [done, setDone] = useState('')
  const load = useCallback(() => {
    void api<{ worktrees: LatchWorktree[] }>(`workspaces/${encodeURIComponent(project.id)}/worktrees`).then(
      reply => {
        setListing({ state: 'ready', worktrees: reply.worktrees.filter(entry => entry.state === 'leftover') })
      },
      (cause: unknown) => {
        setListing({ state: 'failed', message: errorMessage(cause) })
      },
    )
  }, [project.id])
  useEffect(load, [load])
  return (
    <SettingsGroup title="残留的工作树">
      {listing.state === 'reading' && <SettingsRow title={<Spinner size={12} label="正在读取工作树" />} />}
      {listing.state === 'failed' && (
        <InlineNotice
          tone="error"
          action={
            <Button size="xs" onClick={load}>
              重试
            </Button>
          }>
          {listing.message}
        </InlineNotice>
      )}
      {listing.state === 'ready' && listing.worktrees.length === 0 && <SettingsRow title="没有" />}
      {listing.state === 'ready'
        && listing.worktrees.map(entry => (
          <SettingsRow
            key={entry.name}
            leading={<Icon icon={FolderGit2} size={16} />}
            title={entry.name}
            description={entry.branch ? <VisibleText text={entry.branch} /> : '分离 HEAD'}
            trailing={
              <Button
                variant="danger"
                size="sm"
                disabled={!entry.reusable}
                tooltip={entry.reason}
                onClick={() => {
                  setDone('')
                  setRemoving(entry)
                }}>
                移除…
              </Button>
            }
          />
        ))}
      <span className="sr-only" role="status">
        {done}
      </span>
      {done && <SettingsRow title={done} />}
      {removing && (
        <RemoveWorktreeDialog
          target={{ kind: 'leftover', projectId: project.id, name: removing.name }}
          title={removing.name}
          onClose={() => {
            setRemoving(null)
          }}
          onRemoved={result => {
            setDone(removalWords(result))
            load()
          }}
        />
      )}
    </SettingsGroup>
  )
}
