import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Folder } from 'lucide-react'
import type { AppSnapshot, WorkspaceInfo } from '@latch/protocol'
import type { DeviceAccess } from '../core/permissions.ts'
import { api, errorMessage } from '../core/api.ts'
import { middleEllipsis } from '../format.ts'
import { ConfirmDialog } from '../components/overlays.tsx'
import { Badge, Button, ICON_STROKE, InlineNotice, StatusPill } from '@latch/ui'
import { CopyButton } from '../components/ui.tsx'
import { Loading, SectionHeading } from './common.tsx'

/** A saved workspace. One the Host disabled for this run stays listed with its reason so it can be removed. */
export function WorkspaceRow({
  workspace,
  owner,
  onRemove,
}: {
  workspace: WorkspaceInfo
  owner: boolean
  onRemove: (workspace: WorkspaceInfo) => void
}) {
  const disabled = workspace.unavailable !== undefined
  return (
    <li className={`workspace-row${disabled ? ' is-unavailable' : ''}`}>
      <Folder size={16} strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
      <div className="workspace-row-text">
        <strong>
          {workspace.name}
          {workspace.id === 'default' && <Badge>启动目录</Badge>}
          {disabled && <StatusPill tone="warn">不可用</StatusPill>}
        </strong>
        <span title={workspace.path}>{middleEllipsis(workspace.path, 56)}</span>
        {disabled && <span className="workspace-unavailable">{workspace.unavailable || '此项目本次未通过检查，不能用于新会话。'}</span>}
      </div>
      <CopyButton text={workspace.path} label="复制路径" />
      {owner && workspace.id !== 'default' && (
        <Button
          variant="danger"
          onClick={() => {
            onRemove(workspace)
          }}>
          移除
        </Button>
      )}
    </li>
  )
}

export function WorkspacesSettings({
  snapshot,
  access,
  onChanged,
}: {
  snapshot: AppSnapshot
  access: Pick<DeviceAccess, 'admin'>
  onChanged: () => void
}) {
  const owner = access.admin
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[] | null>(snapshot.catalog?.workspaces ?? null)
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [removing, setRemoving] = useState<WorkspaceInfo | null>(null)
  const load = useCallback(async () => {
    try {
      setWorkspaces((await api<{ workspaces: WorkspaceInfo[] }>('workspaces')).workspaces)
      setError('')
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const add = async (event: FormEvent) => {
    event.preventDefault()
    if (!path.trim()) return
    setBusy(true)
    setError('')
    try {
      await api('workspaces', { method: 'POST', body: { path: path.trim(), ...(name.trim() ? { name: name.trim() } : {}) } })
      setPath('')
      setName('')
      onChanged()
      await load()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <SectionHeading title="项目" description="新会话可以选择在哪个目录中工作。Agent 的文件工具只能访问所选项目。" />
      {workspaces === null ? (
        error ? (
          <InlineNotice tone="error">{error}</InlineNotice>
        ) : (
          <Loading />
        )
      ) : (
        <ul className="workspace-list">
          {workspaces.map(workspace => (
            <WorkspaceRow key={workspace.id} workspace={workspace} owner={owner} onRemove={setRemoving} />
          ))}
        </ul>
      )}
      {owner && (
        <form
          className="settings-group workspace-add"
          onSubmit={event => {
            void add(event)
          }}>
          <h4>添加项目</h4>
          <div className="form-grid">
            <label className="field field-wide">
              <span>目录的绝对路径</span>
              <input
                value={path}
                spellCheck={false}
                autoComplete="off"
                placeholder="/Users/me/projects/app"
                onChange={event => {
                  setPath(event.target.value)
                }}
              />
            </label>
            <label className="field">
              <span>
                名称<small>可选</small>
              </span>
              <input
                value={name}
                maxLength={80}
                autoComplete="off"
                placeholder="默认使用目录名"
                onChange={event => {
                  setName(event.target.value)
                }}
              />
            </label>
          </div>
          <div className="settings-actions">
            <Button type="submit" variant="primary" disabled={busy || !path.trim()} loading={busy}>
              添加项目
            </Button>
          </div>
        </form>
      )}
      {error && workspaces !== null && <InlineNotice tone="error">{error}</InlineNotice>}
      {removing && (
        <ConfirmDialog
          title="移除项目"
          confirmLabel="移除"
          danger
          message={`从列表中移除「${removing.name}」？目录中的文件不会被删除。`}
          onClose={() => {
            setRemoving(null)
          }}
          onConfirm={async () => {
            try {
              await api(`workspaces/${encodeURIComponent(removing.id)}`, { method: 'DELETE' })
            } catch (cause) {
              throw new Error(errorMessage(cause))
            }
            onChanged()
            await load()
          }}
        />
      )}
    </>
  )
}
