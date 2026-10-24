import { useState } from 'react'
import type { AppSnapshot, HostCatalog, ModelRef, SessionDefaults, TaskMode } from '@latch/protocol'
import { api, errorMessage } from '../core/api.ts'
import { defaultModel, findHarness, startableWorkspaces } from '../composerChoice.ts'
import { setPreference, usePreferences, type SendKey, type ThemePreference } from '../preferences.ts'
import { Button, ChoiceList, InlineNotice, SegmentedControl } from '@latch/ui'
import { SectionHeading } from './common.tsx'

const encodeModel = (ref: ModelRef | undefined) => (ref ? JSON.stringify([ref.providerId, ref.model]) : '')
function decodeModel(value: string): ModelRef | undefined {
  try {
    const [providerId, model] = JSON.parse(value) as [string, string]
    return { providerId, model }
  } catch {
    return undefined
  }
}

/** Host-wide defaults that a new session starts from on every device. */
function SessionDefaultsForm({ catalog, onChanged }: { catalog: HostCatalog; onChanged: () => void }) {
  const [draft, setDraft] = useState<SessionDefaults>(() => ({
    ...catalog.defaults,
    ...(catalog.defaults.model ? {} : { model: defaultModel(catalog) }),
  }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const harness = findHarness(catalog, draft.harnessId)
  const modes: TaskMode[] = harness?.modes.length ? harness.modes : ['chat', 'agent']
  // The Host already answers a disabled saved default with the default workspace, so disabled ones are never offered.
  const workspaces = startableWorkspaces(catalog)
  const workspaceId = workspaces.some(item => item.id === draft.workspaceId) ? draft.workspaceId : (workspaces[0]?.id ?? draft.workspaceId)
  const update = (patch: Partial<SessionDefaults>) => {
    setDraft(previous => ({ ...previous, ...patch }))
    setSaved(false)
  }
  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const mode = modes.includes(draft.mode) ? draft.mode : modes[0]!
      await api('preferences', {
        method: 'PUT',
        body: {
          defaults: {
            harnessId: draft.harnessId,
            mode,
            workspaceId,
            ...(harness?.models === 'host' && draft.model ? { model: draft.model } : {}),
          },
        },
      })
      setSaved(true)
      onChanged()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="settings-group">
      <h4>新会话默认值</h4>
      <p className="settings-hint">每台设备会记住自己上次的选择；首次使用或选择失效时采用这里的默认值。</p>
      <div className="form-grid">
        <label className="field">
          <span>Harness</span>
          <select
            value={draft.harnessId}
            onChange={event => {
              update({ harnessId: event.target.value })
            }}>
            {catalog.harnesses.map(item => (
              <option key={item.id} value={item.id} disabled={item.status !== 'ready'}>
                {item.name}
                {item.status !== 'ready' ? '（不可用）' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>模式</span>
          <select
            value={modes.includes(draft.mode) ? draft.mode : modes[0]}
            onChange={event => {
              update({ mode: event.target.value as TaskMode })
            }}>
            {modes.map(mode => (
              <option key={mode} value={mode}>
                {mode === 'chat' ? '对话' : 'Agent'}
              </option>
            ))}
          </select>
        </label>
        {harness?.models === 'host' && (
          <label className="field">
            <span>模型</span>
            <select
              value={encodeModel(draft.model)}
              onChange={event => {
                update({ model: decodeModel(event.target.value) })
              }}>
              {!draft.model && <option value="">未选择</option>}
              {catalog.providers.map(provider => (
                <optgroup key={provider.id} label={provider.name}>
                  {(provider.models.length ? provider.models : [provider.defaultModel]).map(model => (
                    <option key={model} value={encodeModel({ providerId: provider.id, model })}>
                      {model}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>项目</span>
          <select
            value={workspaceId}
            onChange={event => {
              update({ workspaceId: event.target.value })
            }}>
            {workspaces.map(item => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="settings-actions">
        {saved && (
          <span className="settings-saved" role="status">
            已保存
          </span>
        )}
        <Button
          disabled={busy}
          onClick={() => {
            void save()
          }}
          loading={busy}>
          保存默认值
        </Button>
      </div>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
    </section>
  )
}

export function GeneralSettings({ snapshot, admin, onChanged }: { snapshot: AppSnapshot; admin: boolean; onChanged: () => void }) {
  const preferences = usePreferences()
  const owner = admin
  return (
    <>
      <SectionHeading title="通用" description="外观与发送方式只影响这台设备。" />
      <section className="settings-group">
        <h4>外观</h4>
        <SegmentedControl<ThemePreference>
          label="外观"
          value={preferences.theme}
          onValueChange={value => {
            setPreference('theme', value)
          }}
          options={[
            { value: 'system', label: '跟随系统' },
            { value: 'light', label: '浅色' },
            { value: 'dark', label: '深色' },
          ]}
        />
      </section>
      <section className="settings-group">
        <h4>发送消息</h4>
        <ChoiceList<SendKey>
          label="发送消息"
          value={preferences.sendKey}
          onValueChange={value => {
            setPreference('sendKey', value)
          }}
          options={[
            { value: 'enter', title: 'Enter 发送', description: 'Shift + Enter 换行' },
            { value: 'mod-enter', title: '⌘/Ctrl + Enter 发送', description: 'Enter 换行，适合输入长段落' },
          ]}
        />
        <p className="settings-hint">触屏设备上 Enter 始终换行，点按发送按钮发送；⌘/Ctrl + Enter 在任何设备上都会发送。</p>
      </section>
      {owner && snapshot.catalog && <SessionDefaultsForm catalog={snapshot.catalog} onChanged={onChanged} />}
    </>
  )
}
