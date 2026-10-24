import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { ChevronLeft, CircleAlert, CircleCheck, KeyRound, LockKeyhole, Plus, RefreshCw, Trash } from 'lucide-react'
import type { AppSnapshot, ProviderKind, ProviderSettings, ProviderPreset } from '@latch/protocol'
import { api, ApiError, errorMessage, inlineError } from '../core/api.ts'
import { withConfirmation } from '../core/confirmations.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { safeTarget } from '../core/securityCopy.ts'
import { hostOf } from '../format.ts'
import { ConfirmDialog } from '../components/overlays.tsx'
import { Badge, Button, Count, ICON_STROKE, IconButton, InlineNotice, StatusPill, Switch } from '@latch/ui'
import { ProviderTile } from '../components/BrandTile.tsx'
import { Loading, SectionHeading } from './common.tsx'

interface ProvidersResponse {
  providers: ProviderSettings[]
  presets: ProviderPreset[]
}
type Selection = { kind: 'provider'; id: string } | { kind: 'new'; preset: ProviderPreset } | { kind: 'presets' } | null
type CheckResult = { ok: true; latencyMs: number; count: number } | { ok: false; message: string }
/** A refused address this device may add to the Host's egress allowlist (desktop admin only). */
type EgressOffer = { target: string } | null

const keyOriginOf = (baseURL: string): string | undefined => {
  try {
    const url = new URL(baseURL)
    return `${url.protocol}//${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`
  } catch {
    return undefined
  }
}

const kindLabels: Record<ProviderKind, string> = { 'openai-compatible': 'OpenAI 兼容', anthropic: 'Anthropic 原生' }

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
 * One provider's form. A saved key is never shown; leaving it untouched keeps it,
 * and replacing or removing it are explicit actions.
 */
function ProviderEditor({
  provider,
  preset,
  presets,
  access,
  onSaved,
  onDeleted,
  onCancel,
}: {
  provider?: ProviderSettings
  preset?: ProviderPreset
  presets: ProviderPreset[]
  access: Pick<DeviceAccess, 'legacy' | 'local' | 'admin'>
  onSaved: (provider: ProviderSettings) => void
  onDeleted?: () => void
  onCancel?: () => void
}) {
  const [name, setName] = useState(provider?.name ?? preset?.name ?? '')
  const [kind, setKind] = useState<ProviderKind>(provider?.kind ?? preset?.kind ?? 'openai-compatible')
  const [baseURL, setBaseURL] = useState(provider?.baseURL ?? preset?.baseURL ?? '')
  const [keyMode, setKeyMode] = useState<'keep' | 'replace' | 'clear'>(provider?.hasKey ? 'keep' : 'replace')
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState<string[]>(provider?.models ?? [])
  const [available, setAvailable] = useState<string[]>([])
  const [defaultModel, setDefaultModel] = useState(provider?.defaultModel ?? '')
  const [enabled, setEnabled] = useState(provider?.enabled ?? true)
  const [manual, setManual] = useState('')
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState<null | 'save' | 'fetch' | 'check'>(null)
  const [check, setCheck] = useState<CheckResult | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [egress, setEgress] = useState<EgressOffer>(null)
  /** Keys are set only from the Host's desktop (local confirmation); other devices may still edit everything else. */
  const keyEditable = access.legacy || access.local
  const requiresKey = (preset ?? presets.find(item => item.id === provider?.presetId))?.requiresKey ?? false
  const customKind = !provider && (preset?.id === 'custom' || !preset?.baseURL)
  const typedKey = keyMode === 'replace' && apiKey.trim() ? apiKey.trim() : undefined
  const storedKey = provider !== undefined && keyMode === 'keep'

  const probe = async () => {
    if (storedKey && baseURL.trim() === provider.baseURL) {
      const result = await api<{ models: string[] }>(`providers/${encodeURIComponent(provider.id)}/models`, {
        method: 'POST',
        body: {},
        timeoutMs: 20_000,
      })
      return { models: result.models, latencyMs: undefined as number | undefined }
    }
    return api<{ ok: true; models: string[]; latencyMs: number }>('provider-checks', {
      method: 'POST',
      timeoutMs: 20_000,
      body: { kind, baseURL: baseURL.trim(), ...(typedKey ? { apiKey: typedKey } : {}), ...(storedKey ? { providerId: provider.id } : {}) },
    })
  }

  /** Egress refusals offer the allowlist; a key bound to another address must be entered again. */
  const probeFailed = (cause: unknown): string => {
    if (cause instanceof ApiError && cause.code === 'egress-denied') {
      const target = safeTarget(cause.details.target)
      setEgress(target !== undefined && access.local && access.admin ? { target } : null)
    }
    if (cause instanceof ApiError && cause.code === 'key-origin-mismatch' && keyEditable) {
      setKeyMode('replace')
      setApiKey('')
    }
    return errorMessage(cause)
  }

  const fetchModels = async () => {
    if (!baseURL.trim()) {
      setError('请先填写 API 地址。')
      return
    }
    setBusy('fetch')
    setError('')
    setNotice('')
    setEgress(null)
    try {
      const result = await probe()
      const fresh = result.models.filter(model => !models.includes(model))
      setAvailable(fresh)
      setNotice(
        result.models.length === 0
          ? '服务没有返回模型，可以手动添加。'
          : `获取到 ${result.models.length} 个模型${fresh.length ? `，${fresh.length} 个尚未添加` : ''}。`,
      )
    } catch (cause) {
      setError(probeFailed(cause))
    } finally {
      setBusy(null)
    }
  }

  const checkConnection = async () => {
    if (!baseURL.trim()) {
      setError('请先填写 API 地址。')
      return
    }
    setBusy('check')
    setError('')
    setCheck(null)
    setEgress(null)
    const started = performance.now()
    try {
      const result = await probe()
      setCheck({ ok: true, latencyMs: result.latencyMs ?? Math.round(performance.now() - started), count: result.models.length })
    } catch (cause) {
      setCheck({ ok: false, message: probeFailed(cause) })
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
      setNotice(`已允许 Host 访问 ${target}。`)
    } catch (cause) {
      const text = inlineError(cause)
      if (text) setError(text)
    } finally {
      setBusy(null)
    }
    if (allowed) void checkConnection()
  }

  const addModel = (model: string) => {
    const value = model.trim()
    if (!value || models.includes(value)) return
    setModels(previous => [...previous, value])
    setAvailable(previous => previous.filter(item => item !== value))
    if (!defaultModel) setDefaultModel(value)
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
    if (!provider && requiresKey && !typedKey && keyEditable) {
      setError('此服务需要 API Key。')
      return
    }
    const chosenDefault = models.includes(defaultModel) ? defaultModel : models[0]!
    setBusy('save')
    setError('')
    setNotice('')
    try {
      // A new key is confirmed on the Host's desktop; the resend repeats the identical body.
      const body = provider
        ? {
            name: name.trim(),
            baseURL: baseURL.trim(),
            models,
            defaultModel: chosenDefault,
            enabled,
            ...(keyMode === 'clear' ? { apiKey: null } : typedKey ? { apiKey: typedKey } : {}),
          }
        : {
            name: name.trim(),
            kind,
            ...(preset ? { presetId: preset.id } : {}),
            baseURL: baseURL.trim(),
            models,
            defaultModel: chosenDefault,
            enabled,
            ...(typedKey ? { apiKey: typedKey } : {}),
          }
      const path = provider ? `providers/${encodeURIComponent(provider.id)}` : 'providers'
      const result = await withConfirmation(confirmation =>
        api<{ provider: ProviderSettings }>(path, { method: provider ? 'PUT' : 'POST', body, ...(confirmation ? { confirmation } : {}) }),
      )
      setApiKey('')
      setKeyMode(result.provider.hasKey ? 'keep' : 'replace')
      setNotice('已保存。')
      onSaved(result.provider)
    } catch (cause) {
      const text = inlineError(cause)
      if (text) setError(text)
    } finally {
      setBusy(null)
    }
  }

  const shown = available.filter(model => model.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
  const originChanged = provider?.hasKey === true && keyMode === 'keep' && keyOriginOf(baseURL.trim()) !== keyOriginOf(provider.baseURL)
  const keyHint = !keyEditable
    ? `设置密钥需要在执行端电脑上用 Latch 桌面端确认。${provider ? `也可以停止 Host 后运行 pnpm latch provider set-key ${provider.id}。` : ''}`
    : provider?.keyOrigin && keyMode === 'keep'
      ? `密钥只发往 ${provider.keyOrigin}`
      : '密钥只保存在执行端的私有目录，不会返回到浏览器。'
  return (
    <form
      className="provider-editor"
      onSubmit={event => {
        void save(event)
      }}>
      <div className="editor-heading">
        <ProviderTile
          provider={{ id: provider?.id ?? preset?.id ?? 'custom', kind, presetId: provider ? provider.presetId : preset?.id }}
          size={32}
        />
        <div>
          <h4>{provider ? provider.name : `添加 ${preset?.name ?? '服务'}`}</h4>
          <span>{kindLabels[kind]}</span>
        </div>
        {provider && <Switch label={`启用 ${provider.name}`} checked={enabled} onCheckedChange={setEnabled} />}
      </div>
      <div className="form-grid">
        <label className={`field ${customKind ? '' : 'field-wide'}`}>
          <span>名称</span>
          <input
            value={name}
            maxLength={80}
            onChange={event => {
              setName(event.target.value)
            }}
            autoComplete="off"
          />
        </label>
        {customKind && (
          <label className="field">
            <span>接口类型</span>
            <select
              value={kind}
              onChange={event => {
                setKind(event.target.value as ProviderKind)
              }}>
              <option value="openai-compatible">{kindLabels['openai-compatible']}</option>
              <option value="anthropic">{kindLabels.anthropic}</option>
            </select>
          </label>
        )}
        <label className="field field-wide">
          <span>API 地址</span>
          <input
            type="url"
            value={baseURL}
            placeholder="https://api.example.com/v1"
            spellCheck={false}
            autoComplete="off"
            onChange={event => {
              setBaseURL(event.target.value)
              setCheck(null)
            }}
          />
        </label>
        <div className="field field-wide">
          <span>API Key{!requiresKey && <small>可选</small>}</span>
          {keyMode === 'keep' ? (
            <div className="key-state">
              <KeyRound size={16} strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
              <span>已保存（不回显）</span>
              {keyEditable && (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    setKeyMode('replace')
                  }}>
                  更换
                </Button>
              )}
              <Button
                variant="danger"
                size="xs"
                onClick={() => {
                  setKeyMode('clear')
                }}>
                移除
              </Button>
            </div>
          ) : keyMode === 'clear' ? (
            <div className="key-state is-clearing">
              <span>保存后将移除已保存的密钥</span>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  setKeyMode('keep')
                }}>
                撤销
              </Button>
            </div>
          ) : keyEditable ? (
            <div className="key-input">
              <input
                type="password"
                aria-label="API Key"
                value={apiKey}
                placeholder={requiresKey ? '输入密钥' : '本地服务通常无需密钥'}
                autoComplete="new-password"
                onChange={event => {
                  setApiKey(event.target.value)
                  setCheck(null)
                }}
              />
              {provider?.hasKey && (
                <Button
                  variant="link"
                  onClick={() => {
                    setKeyMode('keep')
                    setApiKey('')
                  }}>
                  保留原密钥
                </Button>
              )}
            </div>
          ) : (
            <div className="key-state is-locked">
              <LockKeyhole size={16} strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
              <span>{provider?.hasKey ? '已保存（不回显）' : '未设置'}</span>
            </div>
          )}
          <small className="field-hint">{keyHint}</small>
          {originChanged && <small className="field-hint is-warn">修改地址会清空已保存的密钥。</small>}
        </div>
      </div>
      <div className="connection-check">
        <Button
          icon={RefreshCw}
          disabled={busy !== null}
          loading={busy === 'check'}
          onClick={() => {
            void checkConnection()
          }}>
          检测连接
        </Button>
        {check && (
          <span className={`check-result ${check.ok ? 'is-ok' : 'is-error'}`} role="status">
            {check.ok ? (
              <CircleCheck size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
            ) : (
              <CircleAlert size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
            )}
            {check.ok ? `连接正常 · ${check.latencyMs} ms · ${check.count} 个模型` : check.message}
          </span>
        )}
      </div>
      <section className="model-section" aria-labelledby="provider-models">
        <div className="model-section-heading">
          <h5 id="provider-models">
            模型 <Count value={models.length} />
          </h5>
          <Button
            disabled={busy !== null}
            onClick={() => {
              void fetchModels()
            }}
            loading={busy === 'fetch'}>
            获取模型
          </Button>
        </div>
        {models.length === 0 && <p className="settings-hint">尚未添加模型。获取服务的模型列表，或手动输入模型 ID。</p>}
        <ul className="model-list">
          {models.map(model => (
            <li key={model} className="model-row">
              <code>{model}</code>
              <label className="model-default">
                <input
                  type="radio"
                  name="default-model"
                  checked={defaultModel === model}
                  onChange={() => {
                    setDefaultModel(model)
                  }}
                />
                默认
              </label>
              <IconButton
                label={`移除模型 ${model}`}
                tooltip="移除"
                icon={Trash}
                onClick={() => {
                  removeModel(model)
                }}
              />
            </li>
          ))}
        </ul>
        {available.length > 0 && (
          <div className="model-available">
            <div className="model-available-heading">
              <span>可添加</span>
              {available.length > 8 && (
                <input
                  type="search"
                  aria-label="筛选模型"
                  placeholder="筛选模型"
                  value={filter}
                  onChange={event => {
                    setFilter(event.target.value)
                  }}
                />
              )}
            </div>
            <ul className="model-list">
              {shown.map(model => (
                <li key={model} className="model-row is-available">
                  <code>{model}</code>
                  <Button
                    variant="link"
                    onClick={() => {
                      addModel(model)
                    }}>
                    添加
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="model-manual">
          <input
            aria-label="手动添加模型 ID"
            placeholder="手动添加模型 ID"
            value={manual}
            spellCheck={false}
            onChange={event => {
              setManual(event.target.value)
            }}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                addModel(manual)
                setManual('')
              }
            }}
          />
          <Button
            disabled={!manual.trim()}
            onClick={() => {
              addModel(manual)
              setManual('')
            }}
            icon={Plus}>
            添加
          </Button>
        </div>
      </section>
      {egress && (
        <InlineNotice
          tone="warn"
          action={
            <Button
              size="xs"
              disabled={busy !== null}
              onClick={() => {
                void allowEgress(egress.target)
              }}>
              允许 Host 访问 {egress.target}（需要本机确认）
            </Button>
          }>
          Host 出站策略拒绝了这个地址。只有你信任该服务时才加入白名单。
        </InlineNotice>
      )}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {notice && !error && <InlineNotice tone="neutral">{notice}</InlineNotice>}
      <footer className="editor-footer">
        {provider && onDeleted && (
          <Button
            size="md"
            variant="danger"
            disabled={busy !== null}
            onClick={() => {
              setConfirmDelete(true)
            }}>
            删除服务
          </Button>
        )}
        <span className="editor-footer-spacer" />
        {onCancel && (
          <Button size="md" disabled={busy !== null} onClick={onCancel}>
            取消
          </Button>
        )}
        <Button size="md" type="submit" variant={provider ? 'secondary' : 'primary'} disabled={busy !== null} loading={busy === 'save'}>
          {provider ? '保存' : '添加服务'}
        </Button>
      </footer>
      {confirmDelete && provider && (
        <ConfirmDialog
          title="删除模型服务"
          danger
          confirmLabel="删除"
          message={`删除「${provider.name}」及其保存的密钥？正在使用它的会话需要换用其他模型。`}
          onClose={() => {
            setConfirmDelete(false)
          }}
          onConfirm={async () => {
            try {
              await api(`providers/${encodeURIComponent(provider.id)}`, { method: 'DELETE' })
            } catch (cause) {
              throw new Error(errorMessage(cause))
            }
            onDeleted?.()
          }}
        />
      )}
    </form>
  )
}

export function ProvidersSettings({
  snapshot,
  access,
  phone,
  onChanged,
}: {
  snapshot: AppSnapshot
  access: Pick<DeviceAccess, 'legacy' | 'local' | 'admin'>
  phone: boolean
  onChanged: () => void
}) {
  const [data, setData] = useState<ProvidersResponse | null>(null)
  const [error, setError] = useState('')
  const [selection, setSelection] = useState<Selection>(null)
  const load = useCallback(
    async (select?: Selection) => {
      try {
        const next = await api<ProvidersResponse>('providers')
        setData(next)
        setError('')
        setSelection(previous =>
          select !== undefined
            ? select
            : (previous ?? (phone ? null : next.providers[0] ? { kind: 'provider', id: next.providers[0].id } : { kind: 'presets' })),
        )
      } catch (cause) {
        setError(errorMessage(cause))
      }
    },
    [phone],
  )
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

  const list = (
    <div className="provider-list">
      <button
        type="button"
        className={`provider-add ${selection?.kind === 'presets' || selection?.kind === 'new' ? 'is-selected' : ''}`}
        onClick={() => {
          setSelection({ kind: 'presets' })
        }}>
        <Plus size={16} strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
        添加服务
      </button>
      {data.providers.length === 0 && <p className="settings-hint">还没有模型服务。添加一个后，内置 Harness 即可使用它。</p>}
      <ul>
        {data.providers.map(provider => (
          <li key={provider.id}>
            <button
              type="button"
              className={`provider-row ${selected?.id === provider.id ? 'is-selected' : ''}`}
              aria-current={selected?.id === provider.id ? 'true' : undefined}
              onClick={() => {
                setSelection({ kind: 'provider', id: provider.id })
              }}>
              <ProviderTile provider={provider} size={32} />
              <span className="provider-row-text">
                <strong>{provider.name}</strong>
                <span>
                  {hostOf(provider.baseURL)} · {provider.models.length} 个模型
                </span>
              </span>
              {defaultProvider === provider.id && <Badge>默认</Badge>}
              {!provider.enabled && <StatusPill>已停用</StatusPill>}
            </button>
          </li>
        ))}
      </ul>
      {external.length > 0 && (
        <>
          <h5 className="provider-list-label">其他来源</h5>
          <ul>
            {external.map(provider => (
              <li key={provider.id} className="provider-row is-static">
                <ProviderTile provider={provider} size={32} />
                <span className="provider-row-text">
                  <strong>{provider.name}</strong>
                  <span>{provider.kind === 'demo' ? '演示模型，回复由本地脚本生成' : '由插件提供'}</span>
                </span>
                {provider.kind === 'demo' && <Badge tone="warn">演示</Badge>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )

  const detail =
    selection?.kind === 'presets' ? (
      <div className="provider-presets">
        <h4>选择服务</h4>
        <p className="settings-hint">预设会填好 API 地址；之后填写密钥并获取模型。</p>
        <PresetGrid
          presets={data.presets}
          onPick={preset => {
            setSelection({ kind: 'new', preset })
          }}
        />
      </div>
    ) : selection?.kind === 'new' ? (
      <ProviderEditor
        key={`new:${selection.preset.id}`}
        preset={selection.preset}
        presets={data.presets}
        access={access}
        onSaved={saved}
        onCancel={() => {
          setSelection({ kind: 'presets' })
        }}
      />
    ) : selected ? (
      <ProviderEditor key={selected.id} provider={selected} presets={data.presets} access={access} onSaved={saved} onDeleted={deleted} />
    ) : null

  return (
    <>
      <SectionHeading title="模型服务" description="内置 Harness 通过这些服务调用模型。Agent 类 Harness 通常自带模型与登录。" />
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {phone ? (
        detail === null ? (
          list
        ) : (
          <div className="settings-subpage">
            <button
              type="button"
              className="back-link"
              onClick={() => {
                setSelection(selection?.kind === 'new' ? { kind: 'presets' } : null)
              }}>
              <ChevronLeft size={16} strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
              {selection?.kind === 'new' ? '选择服务' : '服务列表'}
            </button>
            {detail}
          </div>
        )
      ) : (
        <div className="list-detail">
          {list}
          <div className="list-detail-main">{detail}</div>
        </div>
      )}
    </>
  )
}
