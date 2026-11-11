import { useState } from 'react'
import type { AppSnapshot, PromptTemplate } from '@latch/protocol'
import { Button, InlineNotice, Kbd, TextAreaField, TextField } from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import { usePromptTemplates } from '../hooks/usePromptTemplates.ts'
import { ConfirmDialog, Modal, ModalHeader } from '../components/overlays.tsx'
import { SettingsGroup, SettingsRow } from './common.tsx'
export function PromptTemplatesSettings({ snapshot, onChanged }: { snapshot: AppSnapshot; onChanged: () => void }) {
  const templates = usePromptTemplates(true, snapshot.catalog?.promptTemplatesVersion),
    [editing, setEditing] = useState<PromptTemplate | null>(null),
    [removing, setRemoving] = useState<PromptTemplate | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const save = async () => {
    if (!editing) return
    setBusy(true)
    setError('')
    try {
      await api(`prompts/${editing.id}`, { method: 'PUT', body: editing })
      setEditing(null)
      onChanged()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  const scopeName = (template: PromptTemplate) => {
    const scope = template.scope
    return scope.kind === 'all'
      ? '所有会话'
      : scope.kind === 'project'
        ? `项目：${snapshot.catalog?.workspaces.find(item => item.id === scope.id)?.name ?? scope.id}`
        : `Agent：${snapshot.catalog?.harnesses.find(item => item.id === scope.id)?.capabilities.display.label ?? scope.id}`
  }
  return (
    <SettingsGroup
      title="提示模板"
      caption={
        <>
          在输入框键入 <Kbd>/</Kbd> 选择，插入后可编辑
        </>
      }
      captionIcon={null}>
      {templates.map(template => (
        <SettingsRow
          key={template.id}
          title={template.name}
          description={scopeName(template)}
          trailing={
            <>
              <Button size="sm" variant="ghost" onClick={() => setEditing(template)}>
                编辑
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRemoving(template)}>
                删除
              </Button>
            </>
          }
        />
      ))}
      <SettingsRow
        title={templates.length ? '再加一个模板' : '还没有提示模板'}
        trailing={
          <Button
            size="sm"
            variant="outline"
            disabled={templates.length >= 200}
            onClick={() => setEditing({ id: crypto.randomUUID(), name: '', content: '', scope: { kind: 'all' } })}>
            添加提示模板
          </Button>
        }
      />
      {editing && (
        <Modal
          label="编辑提示模板"
          onClose={() => {
            if (!busy) setEditing(null)
          }}>
          <ModalHeader
            title="编辑提示模板"
            onClose={() => {
              if (!busy) setEditing(null)
            }}
          />
          <form
            className="prompt-template-editor"
            onSubmit={event => {
              event.preventDefault()
              void save()
            }}>
            <TextField
              label="名称"
              value={editing.name}
              maxLength={80}
              onChange={event => setEditing({ ...editing, name: event.target.value })}
            />
            <TextAreaField
              label="提示内容"
              value={editing.content}
              maxLength={20_000}
              rows={8}
              onChange={event => setEditing({ ...editing, content: event.target.value })}
            />
            <label>
              适用范围
              <select
                value={editing.scope.kind === 'all' ? 'all' : `${editing.scope.kind}:${editing.scope.id}`}
                onChange={event => {
                  const [kind, id] = event.target.value.split(':')
                  setEditing({ ...editing, scope: kind === 'all' ? { kind: 'all' } : { kind: kind as 'project' | 'agent', id } })
                }}>
                <option value="all">所有会话</option>
                {snapshot.catalog?.workspaces.map(item => (
                  <option key={item.id} value={`project:${item.id}`}>
                    项目：{item.name}
                  </option>
                ))}
                {snapshot.catalog?.harnesses.map(item => (
                  <option key={item.id} value={`agent:${item.id}`}>
                    Agent：{item.capabilities.display.label}
                  </option>
                ))}
              </select>
            </label>
            {error && <InlineNotice tone="error">{error}</InlineNotice>}
            <Button type="submit" disabled={busy || !editing.name.trim() || !editing.content.trim()}>
              保存
            </Button>
          </form>
        </Modal>
      )}
      {removing && (
        <ConfirmDialog
          title={`删除“${removing.name}”？`}
          message="现有会话与草稿不受影响。"
          confirmLabel="删除"
          danger
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await api(`prompts/${removing.id}`, { method: 'DELETE' })
            onChanged()
          }}
        />
      )}
    </SettingsGroup>
  )
}
