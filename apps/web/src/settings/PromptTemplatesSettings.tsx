import { useState } from 'react'
import type { AppSnapshot, PromptTemplate } from '@latch/protocol'
import { Button, InlineNotice, Kbd, TextAreaField, TextField } from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import { usePromptTemplates } from '../hooks/usePromptTemplates.ts'
import { ConfirmDialog, Modal, ModalHeader } from '../components/overlays.tsx'
import { harnessName } from '../core/harnessName.ts'
import { defineCopy } from '../core/i18n.ts'
import { SettingsGroup, SettingsRow } from './common.tsx'

const TEMPLATES_COPY = defineCopy(
  {
    title: '提示模板',
    /** Around the 「/」 key cap. */
    captionBefore: '在输入框键入 ',
    captionAfter: ' 选择，插入后可编辑',
    allSessions: '所有会话',
    project: (name: string) => `项目：${name}`,
    agent: (name: string) => `Agent：${name}`,
    edit: '编辑',
    remove: '删除',
    addAnother: '再加一个模板',
    none: '还没有提示模板',
    add: '添加提示模板',
    editTitle: '编辑提示模板',
    name: '名称',
    content: '提示内容',
    scope: '适用范围',
    save: '保存',
    removeTitle: (name: string) => `删除“${name}”？`,
    removeMessage: '现有会话与草稿不受影响。',
  },
  {
    title: 'Prompt templates',
    captionBefore: 'Type ',
    captionAfter: ' in the input to pick one, then edit it',
    allSessions: 'All sessions',
    project: (name: string) => `Project: ${name}`,
    agent: (name: string) => `Agent: ${name}`,
    edit: 'Edit',
    remove: 'Delete',
    addAnother: 'Add another template',
    none: 'No prompt templates yet',
    add: 'Add template',
    editTitle: 'Edit prompt template',
    name: 'Name',
    content: 'Prompt',
    scope: 'Applies to',
    save: 'Save',
    removeTitle: (name: string) => `Delete “${name}”?`,
    removeMessage: 'Existing sessions and drafts stay as they are.',
  },
)

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
    if (scope.kind === 'all') return TEMPLATES_COPY.allSessions
    if (scope.kind === 'project')
      return TEMPLATES_COPY.project(snapshot.catalog?.workspaces.find(item => item.id === scope.id)?.name ?? scope.id)
    const harness = snapshot.catalog?.harnesses.find(item => item.id === scope.id)
    return TEMPLATES_COPY.agent(harness ? harnessName(harness) : scope.id)
  }
  return (
    <SettingsGroup
      title={TEMPLATES_COPY.title}
      caption={
        <>
          {TEMPLATES_COPY.captionBefore}
          <Kbd>/</Kbd>
          {TEMPLATES_COPY.captionAfter}
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
                {TEMPLATES_COPY.edit}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRemoving(template)}>
                {TEMPLATES_COPY.remove}
              </Button>
            </>
          }
        />
      ))}
      <SettingsRow
        title={templates.length ? TEMPLATES_COPY.addAnother : TEMPLATES_COPY.none}
        trailing={
          <Button
            size="sm"
            variant="outline"
            disabled={templates.length >= 200}
            onClick={() => setEditing({ id: crypto.randomUUID(), name: '', content: '', scope: { kind: 'all' } })}>
            {TEMPLATES_COPY.add}
          </Button>
        }
      />
      {editing && (
        <Modal
          label={TEMPLATES_COPY.editTitle}
          onClose={() => {
            if (!busy) setEditing(null)
          }}>
          <ModalHeader
            title={TEMPLATES_COPY.editTitle}
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
              label={TEMPLATES_COPY.name}
              value={editing.name}
              maxLength={80}
              onChange={event => setEditing({ ...editing, name: event.target.value })}
            />
            <TextAreaField
              label={TEMPLATES_COPY.content}
              value={editing.content}
              maxLength={20_000}
              rows={8}
              onChange={event => setEditing({ ...editing, content: event.target.value })}
            />
            <label>
              {TEMPLATES_COPY.scope}
              <select
                value={editing.scope.kind === 'all' ? 'all' : `${editing.scope.kind}:${editing.scope.id}`}
                onChange={event => {
                  const [kind, id] = event.target.value.split(':')
                  setEditing({ ...editing, scope: kind === 'all' ? { kind: 'all' } : { kind: kind as 'project' | 'agent', id } })
                }}>
                <option value="all">{TEMPLATES_COPY.allSessions}</option>
                {snapshot.catalog?.workspaces.map(item => (
                  <option key={item.id} value={`project:${item.id}`}>
                    {TEMPLATES_COPY.project(item.name)}
                  </option>
                ))}
                {snapshot.catalog?.harnesses.map(item => (
                  <option key={item.id} value={`agent:${item.id}`}>
                    {TEMPLATES_COPY.agent(harnessName(item))}
                  </option>
                ))}
              </select>
            </label>
            {error && <InlineNotice tone="error">{error}</InlineNotice>}
            <Button type="submit" disabled={busy || !editing.name.trim() || !editing.content.trim()}>
              {TEMPLATES_COPY.save}
            </Button>
          </form>
        </Modal>
      )}
      {removing && (
        <ConfirmDialog
          title={TEMPLATES_COPY.removeTitle(removing.name)}
          message={TEMPLATES_COPY.removeMessage}
          confirmLabel={TEMPLATES_COPY.remove}
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
