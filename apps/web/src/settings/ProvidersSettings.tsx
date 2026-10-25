import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { CircleAlert, CircleCheck, KeyRound, LockKeyhole, Plus, Trash } from 'lucide-react'
import type { AppSnapshot, ProviderKind, ProviderSettings, ProviderPreset } from '@latch/protocol'
import { api, ApiError, errorMessage, inlineError } from '../core/api.ts'
import { withConfirmation } from '../core/confirmations.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { safeTarget } from '../core/securityCopy.ts'
import { hostOf } from '../format.ts'
import { ConfirmDialog } from '../components/overlays.tsx'
import { Badge, Button, DemoMark, Icon, IconButton, InlineNotice, Radio, SearchField, SwitchRow, TextField } from '@latch/ui'
import { ProviderTile } from '../components/BrandTile.tsx'
import { IconTile, Loading, MiddleEllipsis, NavRow, SectionHeading, SettingsGroup, SettingsRow } from './common.tsx'
import { FieldDialog } from './dialogs.tsx'
import { SettingsPages, type SettingsLevel } from './navigation.tsx'

interface ProvidersResponse {
  providers: ProviderSettings[]
  presets: ProviderPreset[]
}
type Selection = { kind: 'provider'; id: string } | { kind: 'new'; preset: ProviderPreset } | { kind: 'presets' } | null
type CheckResult = { ok: true; latencyMs: number; count: number } | { ok: false; message: string }
/** A refused address this device may add to the Host's egress allowlist (desktop admin only). */
type EgressOffer = { target: string } | null
type Access = Pick<DeviceAccess, 'legacy' | 'local' | 'admin'>

const keyOriginOf = (baseURL: string): string | undefined => {
  try {
    const url = new URL(baseURL)
    return `${url.protocol}//${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`
  } catch {
    return undefined
  }
}

const kindLabels: Record<ProviderKind, string> = { 'openai-compatible': 'OpenAI 兼容', anthropic: 'Anthropic 原生' }
const KEY_HELD = '密钥只保存在执行端的私有目录，不会返回到浏览器。'
const KEY_ON_DESKTOP = '设置密钥需要在执行端电脑上用 Latch 桌面端确认。'

function PresetGrid({ presets, onPick }: { presets: ProviderPreset[]; onPick: (preset: ProviderPreset) => void }) {
  return (
    <div className="preset-grid">
      {presets.map(preset => (
        <button
          key={preset.id}
          type="button"
          className="preset-card"
          onClick={() => {
            onPick(preset)
          }}>
          <ProviderTile provider={{ id: preset.id, kind: preset.kind, presetId: preset.id }} size={32} />
          <span className="preset-card-text">
            <strong>{preset.name}</strong>
            <span>{preset.baseURL ? (preset.kind === 'anthropic' ? kindLabels.anthropic : hostOf(preset.baseURL)) : '任意兼容地址'}</span>
          </span>
          {!preset.requiresKey && preset.baseURL && <Badge>本地</Badge>}
        </button>
      ))}
    </div>
  )
}

/**
 * Probing a service, shared by the add form and a saved service's page: the connection check (latency and model
 * count) and fetching the model list. A refused address offers the egress allowlist to the Host's desktop admin; a
 * key bound to another address must be entered again.
 */
function useProbe(access: Access, probe: () => Promise<{ models: string[]; latencyMs?: number }>, onKeyMismatch?: () => void) {
  const [busy, setBusy] = useState<null | 'check' | 'fetch'>(null)
  const [check, setCheck] = useState<CheckResult | null>(null)
  const [fetched, setFetched] = useState<string[] | null>(null)
  const [error, setError] = useState('')
  const [egress, setEgress] = useState<EgressOffer>(null)

  const failed = (cause: unknown): string => {
    if (cause instanceof ApiError && cause.code === 'egress-denied') {
      const target = safeTarget(cause.details.target)
      setEgress(target !== undefined && access.local && access.admin ? { target } : null)
    }
    if (cause instanceof ApiError && cause.code === 'key-origin-mismatch') onKeyMismatch?.()
    return errorMessage(cause)
  }
  const runCheck = async () => {
    setBusy('check')
    setCheck(null)
    setEgress(null)
    setError('')
    const started = performance.now()
    try {
      const result = await probe()
      setCheck({ ok: true, latencyMs: result.latencyMs ?? Math.round(performance.now() - started), count: result.models.length })
    } catch (cause) {
      setCheck({ ok: false, message: failed(cause) })
    } finally {
      setBusy(null)
    }
  }
  const fetchModels = async () => {
    setBusy('fetch')
    setEgress(null)
    setError('')
    try {
      setFetched((await probe()).models)
    } catch (cause) {
      setError(failed(cause))
    } finally {
      setBusy(null)
    }
  }
  const allowEgress = async (target: string) => {
    setBusy('check')
    setError('')
    let allowed = false
    try {
      await withConfirmation(confirmation =>
        api('policy', { method: 'PATCH', body: { hostEgressAllow: { add: [target] } }, ...(confirmation ? { confirmation } : {}) }),
      )
      allowed = true
      setEgress(null)
    } catch (cause) {
      const text = inlineError(cause)
      if (text) setError(text)
    } finally {
      setBusy(null)
    }
    if (allowed) void runCheck()
  }
  const reset = () => {
    setCheck(null)
    setFetched(null)
  }
  return { busy, check, fetched, error, egress, runCheck, fetchModels, allowEgress, reset }
}

/** The connection check as an action row: its result (or what it does) is the row's line. */
function CheckRow({
  busy,
  disabled,
  result,
  onCheck,
}: {
  busy: boolean
  disabled: boolean
  result: CheckResult | null
  onCheck: () => void
}) {
  return (
    <SettingsRow
      title="检测连接"
      description={
        result === null ? (
          '用这个地址和密钥请求服务的模型列表'
        ) : (
          <span className={`check-result ${result.ok ? 'is-ok' : 'is-error'}`} role="status">
            <Icon icon={result.ok ? CircleCheck : CircleAlert} size={12} />
            {result.ok ? `连接正常 · ${result.latencyMs} ms · ${result.count} 个模型` : result.message}
          </span>
        )
      }
      trailing={
        <Button aria-label="检测连接" disabled={disabled} loading={busy} onClick={onCheck}>
          检测
        </Button>
      }
    />
  )
}

/** The egress refusal, with the way to allow the address on the Host's desktop. */
function EgressNotice({ offer, busy, onAllow }: { offer: EgressOffer; busy: boolean; onAllow: (target: string) => void }) {
  if (offer === null) return null
  return (
    <InlineNotice
      tone="warn"
      action={
        <Button
          size="xs"
          disabled={busy}
          onClick={() => {
            onAllow(offer.target)
          }}>
          允许 Host 访问 {offer.target}（需要本机确认）
        </Button>
      }>
      Host 出站策略拒绝了这个地址。只有你信任该服务时才加入白名单。
    </InlineNotice>
  )
}

/**
 * The models of a service: one row per model with the default chosen by its radio and a remove button, then a row to
 * add a model by its ID. 获取模型 fills a second card with the models the service offers that are not added yet.
 */
function ModelsGroups({
  models,
  defaultModel,
  fetched,
  fetching,
  disabled,
  onFetch,
  onDefault,
  onRemove,
  onAdd,
}: {
  models: string[]
  defaultModel: string
  fetched: string[] | null
  fetching: boolean
  disabled: boolean
  onFetch: () => void
  onDefault: (model: string) => void
  onRemove: (model: string) => void
  onAdd: (model: string) => void
}) {
  const group = useId()
  const [manual, setManual] = useState('')
  const [filter, setFilter] = useState('')
  const fresh = fetched?.filter(model => !models.includes(model)) ?? []
  const shown = fresh.filter(model => model.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
  // A row inside the add form, so it is not a form of its own: Enter in the field adds, like the button.
  const add = () => {
    const value = manual.trim()
    if (!value || models.includes(value)) return
    onAdd(value)
    setManual('')
  }
  const caption =
    fetched === null
      ? models.length === 0
        ? '尚未添加模型。获取服务的模型列表，或手动输入模型 ID。'
        : undefined
      : fetched.length === 0
        ? '服务没有返回模型，可以手动添加。'
        : `获取到 ${fetched.length} 个模型${fresh.length ? `，${fresh.length} 个尚未添加` : '，都已添加'}。`
  return (
    <>
      <SettingsGroup
        title="模型"
        meta={
          <Button variant="link" size="xs" loading={fetching} disabled={disabled} onClick={onFetch}>
            获取模型
          </Button>
        }
        caption={caption}>
        {models.map(model => (
          <div key={model} className="settings-row model-row" data-leading="" data-check="">
            <span className="settings-row-lead">
              <Radio
                name={group}
                checked={defaultModel === model}
                disabled={disabled}
                aria-label={`默认使用 ${model}`}
                onChange={() => {
                  onDefault(model)
                }}
              />
            </span>
            <span className="settings-row-text">
              <span className="settings-row-title settings-row-name">
                <code className="settings-mono model-id">{model}</code>
                {defaultModel === model && <Badge>默认</Badge>}
              </span>
            </span>
            <span className="settings-row-end">
              <IconButton
                label={`移除模型 ${model}`}
                tooltip="移除"
                icon={Trash}
                disabled={disabled}
                onClick={() => {
                  onRemove(model)
                }}
              />
            </span>
          </div>
        ))}
        <div className="settings-row model-add">
          <input
            className="ui-input"
            aria-label="手动添加模型 ID"
            placeholder="手动添加模型 ID"
            value={manual}
            spellCheck={false}
            autoComplete="off"
            onChange={event => {
              setManual(event.target.value)
            }}
            onKeyDown={event => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
              event.preventDefault()
              add()
            }}
          />
          <Button icon={Plus} disabled={disabled || !manual.trim()} onClick={add}>
            添加
          </Button>
        </div>
      </SettingsGroup>
      {fresh.length > 0 && (
        <SettingsGroup title="可添加的模型" meta={`${fresh.length} 个模型`}>
          {fresh.length > 8 && (
            <div className="settings-row model-filter">
              <SearchField label="筛选模型" value={filter} onValueChange={setFilter} />
            </div>
          )}
          <div className="model-available">
            {shown.map(model => (
              <SettingsRow
                key={model}
                title={<code className="settings-mono model-id">{model}</code>}
                trailing={
                  <Button
                    variant="ghost"
                    disabled={disabled}
                    aria-label={`添加模型 ${model}`}
                    onClick={() => {
                      onAdd(model)
                    }}>
                    添加
                  </Button>
                }
              />
            ))}
          </div>
        </SettingsGroup>
      )}
    </>
  )
}

/** The add form of a new service: fields in cards, the models it will offer, and 添加服务 at the end. */
function ProviderAdd({
  preset,
  presets,
  access,
  onSaved,
  onCancel,
}: {
  preset: ProviderPreset
  presets: ProviderPreset[]
  access: Access
  onSaved: (provider: ProviderSettings) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(preset.name)
  const [kind, setKind] = useState<ProviderKind>(preset.kind)
  const [baseURL, setBaseURL] = useState(preset.baseURL)
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [defaultModel, setDefaultModel] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const keyEditable = access.legacy || access.local
  const requiresKey = presets.find(item => item.id === preset.id)?.requiresKey ?? false
  const customKind = preset.id === 'custom' || !preset.baseURL
  const typedKey = apiKey.trim() || undefined
  const probe = useProbe(
    access,
    () =>
      api<{ ok: true; models: string[]; latencyMs: number }>('provider-checks', {
        method: 'POST',
        timeoutMs: 20_000,
        body: { kind, baseURL: baseURL.trim(), ...(typedKey ? { apiKey: typedKey } : {}) },
      }),
    () => {
      setApiKey('')
    },
  )
  const needsAddress = (run: () => Promise<void>) => () => {
    if (!baseURL.trim()) {
      setError('请先填写 API 地址。')
      return
    }
    setError('')
    void run()
  }

  const addModel = (model: string) => {
    setModels(previous => (previous.includes(model) ? previous : [...previous, model]))
    if (!defaultModel) setDefaultModel(model)
  }
  const removeModel = (model: string) => {
    const next = models.filter(item => item !== model)
    setModels(next)
    if (defaultModel === model) setDefaultModel(next[0] ?? '')
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || !baseURL.trim()) {
      setError('请填写名称和 API 地址。')
      return
    }
    if (models.length === 0) {
      setError('至少添加一个模型。可以点击「获取模型」或手动输入模型 ID。')
      return
    }
    if (requiresKey && !typedKey && keyEditable) {
      setError('此服务需要 API Key。')
      return
    }
    setSaving(true)
    setError('')
    try {
      // A new key is confirmed on the Host's desktop; the resend repeats the identical body.
      const body = {
        name: name.trim(),
        kind,
        presetId: preset.id,
        baseURL: baseURL.trim(),
        models,
        defaultModel: models.includes(defaultModel) ? defaultModel : models[0],
        enabled: true,
        ...(typedKey ? { apiKey: typedKey } : {}),
      }
      const result = await withConfirmation(confirmation =>
        api<{ provider: ProviderSettings }>('providers', { method: 'POST', body, ...(confirmation ? { confirmation } : {}) }),
      )
      onSaved(result.provider)
    } catch (cause) {
      const text = inlineError(cause)
      if (text) setError(text)
      setSaving(false)
    }
  }

  const busy = saving || probe.busy !== null
  return (
    <form
      className="settings-subpage provider-add"
      onSubmit={event => {
        void save(event)
      }}>
      <SectionHeading
        title={`添加 ${preset.name}`}
        description={preset.baseURL ? kindLabels[kind] : '任何 OpenAI 兼容或 Anthropic 原生接口的服务'}
      />
      <SettingsGroup title="连接">
        <div className="settings-card-body settings-fields">
          <TextField
            label="名称"
            value={name}
            maxLength={80}
            autoComplete="off"
            onChange={event => {
              setName(event.target.value)
            }}
          />
          {customKind && (
            <label className="field">
              <span>接口类型</span>
              <select
                value={kind}
                onChange={event => {
                  setKind(event.target.value === 'anthropic' ? 'anthropic' : 'openai-compatible')
                  probe.reset()
                }}>
                <option value="openai-compatible">{kindLabels['openai-compatible']}</option>
                <option value="anthropic">{kindLabels.anthropic}</option>
              </select>
            </label>
          )}
          <TextField
            label="API 地址"
            type="url"
            value={baseURL}
            placeholder="https://api.example.com/v1"
            spellCheck={false}
            autoComplete="off"
            onChange={event => {
              setBaseURL(event.target.value)
              probe.reset()
            }}
          />
        </div>
        <CheckRow busy={probe.busy === 'check'} disabled={busy} result={probe.check} onCheck={needsAddress(probe.runCheck)} />
      </SettingsGroup>
      <SettingsGroup title="密钥" caption={keyEditable ? KEY_HELD : KEY_ON_DESKTOP} captionIcon={keyEditable ? 'info' : 'lock'}>
        {keyEditable ? (
          <div className="settings-card-body settings-fields">
            <TextField
              label="API Key"
              type="password"
              value={apiKey}
              placeholder={requiresKey ? '输入密钥' : '本地服务通常无需密钥'}
              autoComplete="new-password"
              hint={requiresKey ? undefined : '可选'}
              onChange={event => {
                setApiKey(event.target.value)
                probe.reset()
              }}
            />
          </div>
        ) : (
          <SettingsRow leading={<IconTile icon={LockKeyhole} />} title="未设置" description="添加后可以在这台电脑的 Latch 桌面端设置" />
        )}
      </SettingsGroup>
      <ModelsGroups
        models={models}
        defaultModel={defaultModel}
        fetched={probe.fetched}
        fetching={probe.busy === 'fetch'}
        disabled={busy}
        onFetch={needsAddress(probe.fetchModels)}
        onDefault={setDefaultModel}
        onRemove={removeModel}
        onAdd={addModel}
      />
      <EgressNotice offer={probe.egress} busy={busy} onAllow={target => void probe.allowEgress(target)} />
      {(error || probe.error) && <InlineNotice tone="error">{error || probe.error}</InlineNotice>}
      <div className="settings-actions">
        <Button size="md" disabled={saving} onClick={onCancel}>
          取消
        </Button>
        <Button size="md" type="submit" variant="primary" disabled={busy} loading={saving}>
          添加服务
        </Button>
      </div>
    </form>
  )
}

/**
 * A saved service's page. Every value applies on its own, as settings values do: the switch, a renamed name or a new
 * address, the key (set on the Host's desktop with a local confirmation), the default model and each added or removed
 * model. A saved key is never shown; removing it and deleting the service are in the red group at the end.
 */
function ProviderPage({
  provider,
  presets,
  access,
  isDefault,
  onSaved,
  onDeleted,
}: {
  provider: ProviderSettings
  presets: ProviderPreset[]
  access: Access
  isDefault: boolean
  onSaved: (provider: ProviderSettings) => void
  onDeleted: () => void
}) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [dialog, setDialog] = useState<null | 'name' | 'address' | 'key'>(null)
  const [confirm, setConfirm] = useState<null | 'delete' | 'clear-key'>(null)
  // The switch moves at once and goes back if the Host refuses.
  const [enabled, setEnabled] = useState(provider.enabled)
  const [seen, setSeen] = useState(provider.enabled)
  if (seen !== provider.enabled) {
    setSeen(provider.enabled)
    setEnabled(provider.enabled)
  }
  const keyEditable = access.legacy || access.local
  const requiresKey = presets.find(item => item.id === provider.presetId)?.requiresKey ?? false
  const id = encodeURIComponent(provider.id)
  const probe = useProbe(access, () => api<{ models: string[] }>(`providers/${id}/models`, { method: 'POST', body: {}, timeoutMs: 20_000 }))

  /** One change; a new key goes through the local confirmation, which resends the identical body. Returns the error. */
  const update = async (body: Record<string, unknown>): Promise<string> => {
    setSaving(true)
    setError('')
    try {
      const result = await withConfirmation(confirmation =>
        api<{ provider: ProviderSettings }>(`providers/${id}`, { method: 'PUT', body, ...(confirmation ? { confirmation } : {}) }),
      )
      onSaved(result.provider)
      return ''
    } catch (cause) {
      return inlineError(cause)
    } finally {
      setSaving(false)
    }
  }
  const apply = (body: Record<string, unknown>) => {
    void update(body).then(text => {
      if (text) setError(text)
    })
  }
  const removeModel = (model: string) => {
    const models = provider.models.filter(item => item !== model)
    if (models.length === 0) {
      setError('至少保留一个模型。')
      return
    }
    apply({ models, ...(provider.defaultModel === model ? { defaultModel: models[0] } : {}) })
  }

  const busy = saving || probe.busy !== null
  const origin = provider.keyOrigin ?? keyOriginOf(provider.baseURL)
  return (
    <>
      <SectionHeading
        title={provider.name}
        description={isDefault ? `${kindLabels[provider.kind]} · 新会话默认使用` : kindLabels[provider.kind]}
        action={
          <Button
            disabled={busy}
            onClick={() => {
              setDialog('name')
            }}>
            重命名…
          </Button>
        }
      />
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <SettingsGroup title="连接">
        <SwitchRow
          className="settings-row"
          title="启用"
          description={enabled ? 'Latch 内置可以使用它的模型' : '停用后 Latch 内置不能使用它的模型'}
          checked={enabled}
          disabled={saving}
          onCheckedChange={next => {
            setEnabled(next)
            void update({ enabled: next }).then(text => {
              if (text) {
                setError(text)
                setEnabled(provider.enabled)
              }
            })
          }}
        />
        <SettingsRow
          title="API 地址"
          description={<MiddleEllipsis text={provider.baseURL} className="settings-mono" />}
          trailing={
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setDialog('address')
              }}>
              修改…
            </Button>
          }
        />
        <CheckRow
          busy={probe.busy === 'check'}
          disabled={busy}
          result={probe.check}
          onCheck={() => {
            void probe.runCheck()
          }}
        />
      </SettingsGroup>
      <EgressNotice offer={probe.egress} busy={busy} onAllow={target => void probe.allowEgress(target)} />
      <SettingsGroup
        title="密钥"
        caption={keyEditable ? KEY_HELD : `${KEY_ON_DESKTOP}也可以停止 Host 后运行 pnpm latch provider set-key ${provider.id}。`}
        captionIcon={keyEditable ? 'info' : 'lock'}>
        <SettingsRow
          leading={<IconTile icon={provider.hasKey ? KeyRound : LockKeyhole} />}
          title={provider.hasKey ? '已保存（不回显）' : '未设置'}
          description={provider.hasKey && origin ? `只发往 ${origin}` : requiresKey ? '这个服务需要密钥才能使用' : '本地服务通常无需密钥'}
          trailing={
            keyEditable ? (
              <Button
                disabled={busy}
                onClick={() => {
                  setDialog('key')
                }}>
                {provider.hasKey ? '替换…' : '设置密钥…'}
              </Button>
            ) : undefined
          }
        />
      </SettingsGroup>
      <ModelsGroups
        models={provider.models}
        defaultModel={provider.defaultModel}
        fetched={probe.fetched}
        fetching={probe.busy === 'fetch'}
        disabled={busy}
        onFetch={() => {
          void probe.fetchModels()
        }}
        onDefault={model => {
          apply({ defaultModel: model })
        }}
        onRemove={removeModel}
        onAdd={model => {
          apply({ models: [...provider.models, model] })
        }}
      />
      {probe.error && <InlineNotice tone="error">{probe.error}</InlineNotice>}
      <SettingsGroup danger>
        {provider.hasKey && (
          <SettingsRow
            title="移除密钥"
            description="移除后，需要密钥的服务在重新设置前不能使用"
            trailing={
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  setConfirm('clear-key')
                }}>
                移除
              </Button>
            }
          />
        )}
        <SettingsRow
          title="删除服务"
          description="删除这个服务和它保存的密钥；使用它的会话要换用其他模型"
          trailing={
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                setConfirm('delete')
              }}>
              删除
            </Button>
          }
        />
      </SettingsGroup>
      <FieldDialog
        open={dialog === 'name'}
        title="重命名服务"
        label="名称"
        initial={provider.name}
        maxLength={80}
        onSubmit={value => update({ name: value })}
        onClose={() => {
          setDialog(null)
        }}
      />
      <FieldDialog
        open={dialog === 'address'}
        title="修改 API 地址"
        label="API 地址"
        type="url"
        initial={provider.baseURL}
        placeholder="https://api.example.com/v1"
        warning={value =>
          provider.hasKey && keyOriginOf(value) !== origin ? '密钥只发往原来的地址：保存后会移除已保存的密钥。' : undefined
        }
        onSubmit={value => update({ baseURL: value })}
        onClose={() => {
          setDialog(null)
        }}
      />
      <FieldDialog
        open={dialog === 'key'}
        title={provider.hasKey ? '替换密钥' : '设置密钥'}
        subtitle={origin ? `密钥只发往 ${origin}` : undefined}
        note="需要在这台电脑上验证身份"
        label="API Key"
        type="password"
        placeholder="输入密钥"
        hint={KEY_HELD}
        onSubmit={value => update({ apiKey: value })}
        onClose={() => {
          setDialog(null)
        }}
      />
      {confirm === 'clear-key' && (
        <ConfirmDialog
          title="移除密钥"
          danger
          confirmLabel="移除"
          message={`移除「${provider.name}」保存的密钥？需要密钥的服务在重新设置前不能使用。`}
          onClose={() => {
            setConfirm(null)
          }}
          onConfirm={async () => {
            const text = await update({ apiKey: null })
            if (text) throw new Error(text)
          }}
        />
      )}
      {confirm === 'delete' && (
        <ConfirmDialog
          title="删除模型服务"
          danger
          confirmLabel="删除"
          message={`删除「${provider.name}」及其保存的密钥？正在使用它的会话需要换用其他模型。`}
          onClose={() => {
            setConfirm(null)
          }}
          onConfirm={async () => {
            try {
              await api(`providers/${id}`, { method: 'DELETE' })
            } catch (cause) {
              throw new Error(errorMessage(cause), { cause })
            }
            onDeleted()
          }}
        />
      )}
    </>
  )
}

export function ProvidersSettings({ snapshot, access, onChanged }: { snapshot: AppSnapshot; access: Access; onChanged: () => void }) {
  const [data, setData] = useState<ProvidersResponse | null>(null)
  const [error, setError] = useState('')
  const [selection, setSelection] = useState<Selection>(null)
  const load = useCallback(async (select?: Selection) => {
    try {
      const next = await api<ProvidersResponse>('providers')
      setData(next)
      setError('')
      if (select !== undefined) setSelection(select)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const external = snapshot.catalog?.providers.filter(provider => provider.kind === 'demo' || provider.kind === 'plugin') ?? []
  const defaultProvider = snapshot.catalog?.defaults.model?.providerId
  const selected = selection?.kind === 'provider' ? data?.providers.find(provider => provider.id === selection.id) : undefined
  const saved = (provider: ProviderSettings) => {
    onChanged()
    void load({ kind: 'provider', id: provider.id })
  }
  const deleted = () => {
    onChanged()
    setSelection(null)
    void load()
  }
  const addService = () => {
    setSelection({ kind: 'presets' })
  }

  if (data === null)
    return (
      <>
        <SectionHeading title="模型服务" />
        {error ? (
          <InlineNotice
            tone="error"
            action={
              <Button
                onClick={() => {
                  void load()
                }}>
                重试
              </Button>
            }>
            {error}
          </InlineNotice>
        ) : (
          <Loading />
        )}
      </>
    )

  const main = (
    <>
      <SectionHeading
        title="模型服务"
        description="Latch 内置通过这些服务调用模型。Agent 成员通常自带模型与登录。"
        action={
          <Button icon={Plus} onClick={addService}>
            添加服务
          </Button>
        }
      />
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <SettingsGroup title="模型服务" meta={data.providers.length ? `${data.providers.length} 个服务` : undefined}>
        {data.providers.length === 0 ? (
          <NavRow
            leading={<IconTile icon={Plus} />}
            title="还没有模型服务"
            description="添加一个后，Latch 内置即可使用它"
            value="添加服务"
            onClick={addService}
          />
        ) : (
          data.providers.map(provider => (
            <NavRow
              key={provider.id}
              className="provider-row"
              leading={<ProviderTile provider={provider} size={32} />}
              record
              dim={!provider.enabled}
              title={
                <span className="settings-row-name">
                  {provider.name}
                  {defaultProvider === provider.id && <Badge>默认</Badge>}
                </span>
              }
              description={`${hostOf(provider.baseURL)} · ${provider.models.length} 个模型`}
              value={provider.enabled ? undefined : '已停用'}
              onClick={() => {
                setSelection({ kind: 'provider', id: provider.id })
              }}
            />
          ))
        )}
      </SettingsGroup>
      {external.length > 0 && (
        <SettingsGroup title="其他来源">
          {external.map(provider => (
            <SettingsRow
              key={provider.id}
              className="provider-row is-static"
              leading={<ProviderTile provider={provider} size={32} />}
              record
              title={
                <span className="settings-row-name">
                  {provider.name}
                  {provider.kind === 'demo' && <DemoMark compact />}
                </span>
              }
              description={provider.kind === 'demo' ? '演示模型，回复由本地脚本生成' : '由插件提供'}
            />
          ))}
        </SettingsGroup>
      )}
    </>
  )

  const presetsLevel: SettingsLevel = {
    key: 'presets',
    title: '选择服务',
    onBack: () => {
      setSelection(null)
    },
    content: (
      <>
        <SectionHeading title="选择服务" description="预设会填好 API 地址；之后填写密钥并获取模型。" />
        <PresetGrid
          presets={data.presets}
          onPick={preset => {
            setSelection({ kind: 'new', preset })
          }}
        />
      </>
    ),
  }
  const levels: SettingsLevel[] = []
  const notice: ReactNode = error ? <InlineNotice tone="error">{error}</InlineNotice> : null
  if (selection?.kind === 'presets') levels.push(presetsLevel)
  if (selection?.kind === 'new')
    levels.push(presetsLevel, {
      key: `new:${selection.preset.id}`,
      title: `添加 ${selection.preset.name}`,
      onBack: () => {
        setSelection({ kind: 'presets' })
      },
      content: (
        <>
          {notice}
          <ProviderAdd
            key={selection.preset.id}
            preset={selection.preset}
            presets={data.presets}
            access={access}
            onSaved={saved}
            onCancel={() => {
              setSelection({ kind: 'presets' })
            }}
          />
        </>
      ),
    })
  if (selected)
    levels.push({
      key: `provider:${selected.id}`,
      title: selected.name,
      onBack: () => {
        setSelection(null)
      },
      content: (
        <>
          {notice}
          <ProviderPage
            key={selected.id}
            provider={selected}
            presets={data.presets}
            access={access}
            isDefault={defaultProvider === selected.id}
            onSaved={saved}
            onDeleted={deleted}
          />
        </>
      ),
    })

  return <SettingsPages main={main} levels={levels} />
}
