import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { CircleAlert, CircleCheck, Info, KeyRound, ListRestart, LockKeyhole, Pencil, Plus, Trash } from 'lucide-react'
import type { AppSnapshot, ModelCapabilities, ProviderKind, ProviderPreset, ProviderSettings } from '@latch/protocol'
import { api, errorMessage, inlineError } from '../core/api.ts'
import { keepWhileAway } from '../core/blocking.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { hostView } from '../core/permissions.ts'
import {
  checkAction,
  checkAddress,
  confirmAddress,
  createProvider,
  describeProbeFailure,
  latestQuestions,
  serviceHealth,
  destinationOf,
  isUnconfirmed,
  keyScopeOf,
  listModels,
  missingKey,
  modelIdProblem,
  shownAddress,
  trackedPresenter,
  updateProvider,
  type Destination,
  type ProbeFailure,
  type ServiceHealth,
  type ProvidersResponse,
} from '../core/providerSetup.ts'
import { PROVIDER_COPY } from '../core/securityCopy.ts'
import { InlineConfirm } from '../components/InlineConfirm.tsx'
import { ConfirmDialog } from '../components/overlays.tsx'
import {
  Badge,
  Button,
  DemoMark,
  Dialog,
  Icon,
  IconButton,
  InlineNotice,
  Menu,
  Radio,
  SearchField,
  Switch,
  SwitchRow,
  TextField,
  ValuePicker,
} from '@latch/ui'
import { THINKING_SETS, thinkingSetText } from '../composer/modelReasoning.ts'
import { ProviderTile } from '../components/BrandTile.tsx'
import { IconTile, Loading, MiddleEllipsis, moreButton, ObjectRow, SectionHeading, SettingsGroup, SettingsRow } from './common.tsx'
import { FieldDialog } from './dialogs.tsx'
import { dropProviderDraft, keepProviderDraft, peekProviderDraft, type ProviderDraft } from './providerDraft.ts'
import { ModelVisibilitySettings } from './ModelVisibilitySettings.tsx'
import { SettingsPages, type SettingsLevel } from './navigation.tsx'
import { UsageSettings } from './UsageSettings.tsx'
import { ConfirmedAddresses } from './ConfirmedAddresses.tsx'
import { providerAbilities, type ProviderAbilities } from '../core/providerAbilities.ts'
export { providerAbilities, type ProviderAbilities } from '../core/providerAbilities.ts'

type Selection = { kind: 'provider'; id: string; check?: boolean; fetch?: boolean } | null
type CheckState = { ok: true; latencyMs: number; count: number } | { ok: false; failure: ProbeFailure }
type Access = Pick<DeviceAccess, 'legacy' | 'local' | 'admin'>

/** Where an address is confirmed on the desktop that cannot confirm it now: the fix, or the offline command. */
function offlineText(abilities: ProviderAbilities, providerId?: string): string {
  if (abilities.presenceBroken) return PROVIDER_COPY.presenceBroken(abilities.presenceBroken)
  return providerId ? PROVIDER_COPY.confirmOffline(providerId) : PROVIDER_COPY.confirmOfflineNew
}

const kindLabels: Record<ProviderKind, string> = { 'openai-compatible': 'OpenAI 兼容', anthropic: 'Anthropic 原生' }

/** The services one can add, as a grid of brand tiles; the chosen one stays marked while its form shows below. */
function PresetGrid({
  presets,
  chosen,
  disabled = false,
  onPick,
}: {
  presets: ProviderPreset[]
  chosen?: string
  disabled?: boolean
  onPick: (preset: ProviderPreset) => void
}) {
  return (
    <div className="preset-grid">
      {presets.map(preset => (
        <button
          key={preset.id}
          type="button"
          className="preset-card"
          aria-pressed={chosen === preset.id}
          disabled={disabled}
          onClick={() => {
            onPick(preset)
          }}>
          <ProviderTile provider={{ id: preset.id, kind: preset.kind, presetId: preset.id }} size={24} />
          <span className="preset-card-name">{preset.id === 'custom' || !preset.baseURL ? '自定义' : preset.name}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * Probing a service, shared by the add form and a saved service's page: the connection check (latency and model
 * count) and fetching the model list. Each failure becomes one sentence with its kind; a local address is not an
 * error, it is what the address confirmation allows.
 */
function useProbe(probe: () => Promise<{ models: string[]; latencyMs?: number }>, onKeyMismatch?: () => void) {
  const [busy, setBusy] = useState<null | 'check' | 'fetch'>(null)
  const [check, setCheck] = useState<CheckState | null>(null)
  const [fetched, setFetched] = useState<string[] | null>(null)
  const [failure, setFailure] = useState<ProbeFailure | null>(null)
  // The last listing's failure at once, for a caller that goes on in the same handler (state updates come later).
  const last = useRef<ProbeFailure | null>(null)

  const failed = (cause: unknown): ProbeFailure => {
    const described = describeProbeFailure(cause)
    if (described.kind === 'key' && described.text.startsWith('已保存的密钥')) onKeyMismatch?.()
    return described
  }
  /** The models it found, or undefined after a failure (shown as `check`). */
  const runCheck = async (): Promise<string[] | undefined> => {
    setBusy('check')
    setCheck(null)
    setFailure(null)
    const started = performance.now()
    try {
      const result = await probe()
      setCheck({ ok: true, latencyMs: result.latencyMs ?? Math.round(performance.now() - started), count: result.models.length })
      return result.models
    } catch (cause) {
      setCheck({ ok: false, failure: failed(cause) })
      return undefined
    } finally {
      setBusy(null)
    }
  }
  /** The models it offers, or undefined after a failure (shown as `failure`). */
  const fetchModels = async (): Promise<string[] | undefined> => {
    setBusy('fetch')
    setFailure(null)
    last.current = null
    try {
      const { models } = await probe()
      setFetched(models)
      return models
    } catch (cause) {
      last.current = failed(cause)
      setFailure(last.current)
      return undefined
    } finally {
      setBusy(null)
    }
  }
  const reset = () => {
    setCheck(null)
    setFetched(null)
    setFailure(null)
  }
  return { busy, check, fetched, failure, runCheck, fetchModels, setFetched, reset, lastFailure: () => last.current }
}

/**
 * The connection check as an action row: its result (or what it does) is the row's line. A local address is not a
 * failure: the notice under the card says how to allow it. `reasonBelow`: a notice under the card says why, with what
 * to do, so the row only says that it did not pass. `listingNeutral` (a saved service): the check is a model listing,
 * and a service that answers without one is not a failed connection, so it reads as unknown. `disabledReason`: why the
 * button cannot be pressed.
 */
function CheckRow({
  busy,
  disabled,
  disabledReason,
  result,
  reasonBelow = false,
  listingNeutral = false,
  onCheck,
}: {
  busy: boolean
  disabled: boolean
  disabledReason?: string
  result: CheckState | null
  reasonBelow?: boolean
  listingNeutral?: boolean
  onCheck: () => void
}) {
  const local = result?.ok === false && result.failure.kind === 'local'
  const unknown = listingNeutral && result?.ok === false && result.failure.kind === 'listing'
  return (
    <SettingsRow
      title="检测连接"
      description={
        result === null ? (
          '用这个地址和密钥请求服务的模型列表'
        ) : local ? (
          <span className="check-result" role="status">
            <Icon icon={Info} size={12} />
            Latch 还不能访问这个地址
          </span>
        ) : unknown ? (
          <span className="check-result" role="status">
            <Icon icon={Info} size={12} />
            {PROVIDER_COPY.listingUnavailable}
          </span>
        ) : (
          <span className={`check-result ${result.ok ? 'is-ok' : 'is-error'}`} role="status">
            <Icon icon={result.ok ? CircleCheck : CircleAlert} size={12} />
            {result.ok ? `连接正常 · ${result.latencyMs} ms · ${result.count} 个模型` : reasonBelow ? '没有通过' : result.failure.text}
          </span>
        )
      }
      trailing={
        <Button aria-label="检测连接" disabled={disabled} tooltip={disabledReason} loading={busy} loadingLabel="检测中…" onClick={onCheck}>
          {result === null ? '检测' : '重新检测'}
        </Button>
      }
    />
  )
}

/**
 * The notice for a local or private address that is not allowed yet: what it is, and the one way forward on this
 * device. On the desktop the button confirms it now; elsewhere the sentence says where.
 */
function LocalAddressNotice({
  target,
  abilities,
  busy,
  waiting,
  actionLabel,
  elsewhere,
  atSave = false,
  onAllow,
}: {
  target: string
  abilities: ProviderAbilities
  busy: boolean
  waiting: boolean
  actionLabel: string
  /** Where to do it when this device cannot. */
  elsewhere: string
  /** The save button confirms the address anyway: one lock on screen, so the notice only says so. */
  atSave?: boolean
  onAllow: () => void
}) {
  if (atSave && abilities.confirm) return <InlineNotice tone="neutral">{PROVIDER_COPY.localAddressAtSave(target)}</InlineNotice>
  return (
    <InlineNotice
      tone="neutral"
      action={
        abilities.confirm ? (
          <Button
            size="xs"
            icon={LockKeyhole}
            disabled={busy}
            loading={waiting}
            loadingLabel={PROVIDER_COPY.waitingTouchID}
            onClick={onAllow}>
            {actionLabel}
          </Button>
        ) : undefined
      }>
      {PROVIDER_COPY.localAddress(target)}
      {!abilities.confirm && ` ${elsewhere}`}
    </InlineNotice>
  )
}

/** The add-model row: a typed model ID, checked against the Host's limits before it is added. */
function ManualModel({
  models,
  disabled,
  inputRef,
  onAdd,
}: {
  models: string[]
  disabled: boolean
  inputRef?: Ref<HTMLInputElement>
  onAdd: (model: string) => void
}) {
  const [manual, setManual] = useState('')
  const [problem, setProblem] = useState('')
  const hint = useId()
  // A row inside the add form, so it is not a form of its own: Enter in the field adds, like the button.
  const add = () => {
    const issue = modelIdProblem(manual, models)
    if (issue) {
      setProblem(issue)
      return
    }
    onAdd(manual.trim())
    setManual('')
    setProblem('')
  }
  return (
    <div className="settings-row model-add">
      <input
        ref={inputRef}
        className="ui-input"
        aria-label="手动添加模型 ID"
        aria-describedby={problem ? hint : undefined}
        aria-invalid={problem ? true : undefined}
        placeholder="手动添加模型 ID"
        value={manual}
        maxLength={400}
        spellCheck={false}
        autoComplete="off"
        onChange={event => {
          setManual(event.target.value)
          setProblem('')
        }}
        onKeyDown={event => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
          event.preventDefault()
          add()
        }}
      />
      <Button icon={Plus} aria-label="添加输入的模型 ID" disabled={disabled || !manual.trim()} onClick={add}>
        添加
      </Button>
      {problem && (
        <span id={hint} className="model-add-problem" role="alert">
          {problem}
        </span>
      )}
    </div>
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
  failed,
  manualRef,
  fetchBlocked,
  onFetch,
  onDefault,
  onRemove,
  onAdd,
  modelCapabilities,
  onVision,
  kind,
  onThinking,
}: {
  models: string[]
  defaultModel: string
  fetched: string[] | null
  fetching: boolean
  disabled: boolean
  /** Why the last listing failed, in one sentence: the caption says it and points to typing an ID instead. */
  failed?: string
  manualRef?: Ref<HTMLInputElement>
  /** Why the models cannot be listed yet (an unconfirmed address, a missing key); listing is offered without one. */
  fetchBlocked?: string
  onFetch: () => void
  onDefault: (model: string) => void
  onRemove: (model: string) => void
  onAdd: (model: string) => void
  modelCapabilities?: Record<string, ModelCapabilities>
  onVision?: (model: string, vision: boolean) => void
  /** The service's protocol, which decides the level sets on offer. */
  kind: ProviderKind
  onThinking: (model: string, levels: string[] | undefined) => void
}) {
  const group = useId()
  const [filter, setFilter] = useState('')
  const fresh = fetched?.filter(model => !models.includes(model)) ?? []
  const shown = fresh.filter(model => model.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
  const caption = failed
    ? `${failed}可以手动输入模型 ID。`
    : fetched === null
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
          <Button
            variant="link"
            size="xs"
            loading={fetching}
            loadingLabel="获取中…"
            disabled={disabled || fetchBlocked !== undefined}
            tooltip={fetchBlocked}
            onClick={onFetch}>
            获取模型
          </Button>
        }
        caption={`${caption ?? ''}${caption ? ' ' : ''}${onVision ? '图片开关与' : ''}思考深度按模型服务的文档设置${onVision ? '：图片未开启时只发送文字，' : '，'}思考不设置时用模型自己的默认值。`}>
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
              <span className="model-thinking">
                <ThinkingPicker
                  model={model}
                  kind={kind}
                  levels={modelCapabilities?.[model]?.thinking}
                  disabled={disabled}
                  onChange={levels => {
                    onThinking(model, levels)
                  }}
                />
              </span>
            </span>
            <span className="settings-row-end">
              {onVision && (
                <Switch
                  label={`${model} 可以接收图片`}
                  title="可以接收图片（需与模型服务的真实能力一致）"
                  checked={modelCapabilities?.[model]?.vision === true}
                  disabled={disabled}
                  onCheckedChange={vision => onVision(model, vision)}
                />
              )}
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
        <ManualModel models={models} disabled={disabled} inputRef={manualRef} onAdd={onAdd} />
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

/** How many models a listing may turn on by itself: a short list is what the person wants, a catalogue is not. */
const TAKE_ALL_UP_TO = 12

/** The models found at the address, each with a switch, and a row to type one the listing left out. */
function FoundModels({
  models,
  fetched,
  disabled,
  failed,
  manualRef,
  onToggle,
  onAdd,
}: {
  models: string[]
  fetched: string[] | null
  disabled: boolean
  failed?: string
  manualRef?: Ref<HTMLInputElement>
  onToggle: (model: string, on: boolean) => void
  onAdd: (model: string) => void
}) {
  const [filter, setFilter] = useState('')
  const all = [...new Set([...(fetched ?? []), ...models])]
  const needle = filter.trim().toLocaleLowerCase()
  const shown = all.filter(model => model.toLocaleLowerCase().includes(needle))
  return (
    <div className="provider-found">
      <span className="provider-found-title">
        {fetched === null ? '模型' : fetched.length ? `找到 ${fetched.length} 个模型` : '服务没有列出模型'}
      </span>
      {all.length > 8 && <SearchField label="筛选模型" value={filter} onValueChange={setFilter} />}
      {shown.length > 0 && (
        <div className="provider-found-list">
          {shown.map(model => (
            <div key={model} className="provider-found-row">
              <code className="settings-mono model-id">{model}</code>
              <Switch
                label={`使用 ${model}`}
                checked={models.includes(model)}
                disabled={disabled}
                onCheckedChange={on => {
                  onToggle(model, on)
                }}
              />
            </div>
          ))}
        </div>
      )}
      <ManualModel models={models} disabled={disabled} inputRef={manualRef} onAdd={onAdd} />
      {failed && <p className="settings-caption">{failed}可以手动输入模型 ID。</p>}
    </div>
  )
}

/** The address's state under the add form's fields: confirmed once on first use, and where that happens. */
function addressNote(destination: Destination, abilities: ProviderAbilities, localTarget: string | undefined): ReactNode {
  if (destination !== 'unconfirmed') return null
  if (abilities.confirm) return localTarget ? PROVIDER_COPY.localAddressAtSave(localTarget) : PROVIDER_COPY.firstUse
  if (abilities.offline) return offlineText(abilities)
  return `这个地址要在 Mac 上确认后才能使用。${PROVIDER_COPY.savedUnconfirmed}`
}

/**
 * The add form of a new service: fields in cards, the models it will offer, and 保存服务 at the end. A preset's HTTPS
 * address saves at once; any other address is confirmed once, on the desktop, with its key and its allowance.
 */
export function ProviderAddForm({
  preset,
  data,
  abilities,
  onConfirmed,
  onSaved,
  onCancel,
  compact = false,
  saveLabel,
  footer,
  onBusy,
}: {
  compact?: boolean
  saveLabel?: string
  /** Where the sheet wants 取消 and 保存, in its own footer. */
  footer?: HTMLElement | null
  /** A save is on its way: closing the form now would hide its failure, or its success after the person thought it cancelled. */
  onBusy?: (busy: boolean) => void
  preset: ProviderPreset
  data: ProvidersResponse
  abilities: ProviderAbilities
  /** An address (origin and path) confirmed before saving, so the form stops asking for it. */
  onConfirmed: (address: string) => void
  /** `check`: test the connection at once; not when the form already showed it has no model list, or has no key. */
  onSaved: (provider: ProviderSettings, check: boolean) => void
  onCancel: () => void
}) {
  // What was typed before 查看会话 left settings for a session, handed back once.
  const [restored] = useState(() => peekProviderDraft(preset.id))
  const [name, setName] = useState(restored?.name ?? preset.name)
  const [kind, setKind] = useState<ProviderKind>(restored?.kind ?? preset.kind)
  const [baseURL, setBaseURL] = useState(restored?.baseURL ?? preset.baseURL)
  const [apiKey, setApiKey] = useState(restored?.apiKey ?? '')
  const [models, setModels] = useState<string[]>(restored?.models ?? [])
  const [defaultModel, setDefaultModel] = useState(restored?.defaultModel ?? '')
  useEffect(() => {
    if (restored) dropProviderDraft()
  }, [restored])
  const typed = useRef<ProviderDraft>({ preset, name, kind, baseURL, apiKey, models, defaultModel })
  typed.current = { preset, name, kind, baseURL, apiKey, models, defaultModel }
  useEffect(
    () =>
      keepWhileAway(() => {
        keepProviderDraft(typed.current)
      }),
    [],
  )
  const [saving, setSaving] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')
  const [guide, setGuide] = useState('')
  const manual = useRef<HTMLInputElement>(null)
  const requiresKey = preset.requiresKey
  const customKind = preset.id === 'custom' || !preset.baseURL
  const destination = destinationOf(baseURL, data)
  // An address that is not confirmed takes a key only together with its confirmation; the desktop without local
  // confirmation saves it keyless and confirms it with the offline command.
  const keyEditable = abilities.keys && !(destination === 'unconfirmed' && abilities.offline)
  const typedKey = keyEditable ? apiKey.trim() || undefined : undefined
  const presenter = trackedPresenter(setWaiting)
  const probe = useProbe(
    () => checkAddress({ kind, baseURL, ...(typedKey ? { apiKey: typedKey } : {}) }),
    () => {
      setApiKey('')
    },
  )
  const checkFailure = probe.check?.ok === false ? probe.check.failure : null
  const local = [probe.failure, checkFailure].find(item => item?.kind === 'local')
  const localTarget = local?.kind === 'local' ? local.target : undefined
  const needsAddress = (run: () => Promise<unknown>) => () => {
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
    setGuide('')
  }
  const removeModel = (model: string) => {
    const next = models.filter(item => item !== model)
    setModels(next)
    if (defaultModel === model) setDefaultModel(next[0] ?? '')
  }
  /** Confirms the address now (desktop): the one confirmation this address gets. False when it did not pass. */
  const confirmNow = async (): Promise<boolean> => {
    setConfirming(true)
    setError('')
    try {
      const result = await confirmAddress(baseURL, { presenter })
      onConfirmed(result.address ?? keyScopeOf(baseURL) ?? result.origin)
      return true
    } catch (cause) {
      const text = inlineError(cause)
      if (text) setError(text)
      return false
    } finally {
      setConfirming(false)
    }
  }
  /** A listing turns on a short list by itself, unless the person already chose. */
  const take = (listed: string[] | undefined) => {
    if (listed && listed.length > 0 && listed.length <= TAKE_ALL_UP_TO) {
      setModels(previous => {
        if (previous.length > 0) return previous
        setDefaultModel(listed[0]!)
        return listed
      })
      setGuide('')
    }
  }
  /** Confirms the address, then lists its models. */
  const allowAndFetch = async () => {
    if (await confirmNow()) take(await probe.fetchModels())
  }

  const submit = async () => {
    if (!name.trim() || !baseURL.trim()) {
      setError('请填写名称和 API 地址。')
      return
    }
    if (requiresKey && !typedKey && keyEditable) {
      setError('这个服务需要 API Key。')
      return
    }
    setError('')
    let chosen = models
    let choice = defaultModel
    // The form already showed the service has no usable model list, or cannot be reached: checking again says the same.
    let listingFailed = [probe.failure, probe.check?.ok === false ? probe.check.failure : null].some(
      failure => failure !== null && failure.kind !== 'local',
    )
    if (chosen.length === 0) {
      // Nothing chosen yet: list what the service offers. A single model is taken as it is; several wait for a choice.
      let listed = await probe.fetchModels()
      // A local address can only be listed once it is confirmed: this button carries the lock, so it confirms here
      // (the one Touch ID), lists, and saves at once when there is a single model.
      if (listed === undefined && locked && probe.lastFailure()?.kind === 'local') {
        // The button that was pressed says 「等待 Touch ID…」 while the confirmation is shown.
        setSaving(true)
        const confirmed = await confirmNow()
        setSaving(false)
        if (!confirmed) return
        listed = await probe.fetchModels()
      }
      if (listed === undefined) {
        manual.current?.focus()
        return
      }
      listingFailed = false
      if (listed.length === 0 || listed.length > TAKE_ALL_UP_TO) {
        if (listed.length === 0) manual.current?.focus()
        setGuide(
          listed.length === 0
            ? '服务没有列出模型。手动输入一个模型 ID，再保存。'
            : `找到 ${listed.length} 个模型。打开要用的模型，第一个打开的是默认模型，然后再保存。`,
        )
        return
      }
      chosen = listed
      choice = listed[0]!
      setModels(listed)
      setDefaultModel(choice)
    }
    setSaving(true)
    try {
      const provider = await createProvider(
        {
          name,
          kind,
          presetId: preset.id,
          baseURL,
          models: chosen,
          defaultModel: choice,
          ...(typedKey ? { apiKey: typedKey } : {}),
          ...(abilities.confirm ? { confirmOrigin: true } : {}),
        },
        { presenter },
      )
      // A check right after saving is a model listing: not when the form already showed there is none, nor without a key.
      onSaved(provider, !listingFailed && !missingKey(provider, data.presets))
    } catch (cause) {
      const text = inlineError(cause)
      if (text) setError(text)
      setSaving(false)
    }
  }
  // The whole press counts, including the listing before the save: the save goes on from there even with the form gone.
  const save = async (event?: FormEvent) => {
    event?.preventDefault()
    event?.stopPropagation()
    setSubmitting(true)
    try {
      await submit()
    } finally {
      setSubmitting(false)
    }
  }

  const busy = saving || confirming || probe.busy !== null
  const committing = submitting || confirming
  useEffect(() => {
    onBusy?.(committing)
    return () => {
      onBusy?.(false)
    }
  }, [committing, onBusy])
  const locked = destination === 'unconfirmed' && abilities.confirm
  const note = addressNote(destination, abilities, localTarget)
  const failure = probe.failure
  const listingFailed =
    failure === null || failure.kind === 'local'
      ? undefined
      : failure.kind === 'key' && !keyEditable && requiresKey
        ? `列出模型需要密钥。${PROVIDER_COPY.keyElsewhere}`
        : failure.text
  const keyElsewhere = abilities.keys ? offlineText(abilities) : requiresKey ? PROVIDER_COPY.keyAfterSave : PROVIDER_COPY.keyElsewhere
  // The picker can live inside the composer's form. Its compact panel must not nest another native form there.
  const Form = compact ? 'div' : 'form'
  const formId = useId()
  /** The check is a listing, so what it finds fills the list at once instead of asking for a second press. */
  const checkAndTake = async () => {
    const listed = await probe.runCheck()
    if (listed) probe.setFetched(listed)
    take(listed)
  }
  const actions = (
    <>
      <Button size="md" disabled={saving} onClick={onCancel}>
        取消
      </Button>
      <Button
        size="md"
        type={compact ? 'button' : 'submit'}
        form={compact ? undefined : formId}
        onClick={compact ? () => void save() : undefined}
        variant="primary"
        icon={locked ? LockKeyhole : undefined}
        disabled={busy}
        loading={saving}
        loadingLabel={waiting ? PROVIDER_COPY.waitingTouchID : '保存中…'}>
        {saveLabel ? (locked ? `用 Touch ID ${saveLabel}` : saveLabel) : locked ? PROVIDER_COPY.saveWithTouchID : PROVIDER_COPY.save}
      </Button>
    </>
  )
  return (
    <Form
      id={compact ? undefined : formId}
      className={compact ? 'provider-add provider-add-inline' : 'provider-add'}
      onSubmit={event => {
        void save(event)
      }}
      onKeyDown={event => {
        if (!compact || event.key !== 'Enter' || event.defaultPrevented || event.nativeEvent.isComposing) return
        if (!(event.target instanceof HTMLInputElement)) return
        event.preventDefault()
        event.stopPropagation()
        if (!busy) void save()
      }}>
      <div className="settings-fields">
        {customKind && (
          <TextField
            label="名称"
            value={name}
            maxLength={80}
            autoComplete="off"
            onChange={event => {
              setName(event.target.value)
            }}
          />
        )}
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
          label="地址"
          type="url"
          value={baseURL}
          placeholder="https://api.example.com/v1"
          spellCheck={false}
          autoComplete="off"
          onChange={event => {
            setBaseURL(event.target.value)
            probe.reset()
            setGuide('')
          }}
        />
        {keyEditable ? (
          <TextField
            label="密钥"
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
        ) : (
          <p className="settings-caption">{keyElsewhere}</p>
        )}
      </div>
      <CheckRow busy={probe.busy !== null} disabled={busy} result={probe.check} onCheck={needsAddress(checkAndTake)} />
      <FoundModels
        models={models}
        fetched={probe.fetched}
        disabled={busy}
        failed={listingFailed}
        manualRef={manual}
        onToggle={(model, on) => {
          if (on) addModel(model)
          else removeModel(model)
        }}
        onAdd={addModel}
      />
      {localTarget !== undefined && (
        <LocalAddressNotice
          target={localTarget}
          abilities={abilities}
          busy={busy}
          waiting={confirming && waiting}
          actionLabel={PROVIDER_COPY.allowAndFetch}
          elsewhere={abilities.offline ? offlineText(abilities) : '可以先手动输入模型 ID 保存，再在 Mac 上确认这个地址。'}
          atSave={locked}
          onAllow={() => {
            void allowAndFetch()
          }}
        />
      )}
      {note && localTarget === undefined && <InlineNotice tone="neutral">{note}</InlineNotice>}
      {guide && <InlineNotice tone="neutral">{guide}</InlineNotice>}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <InlineConfirm active={saving || confirming} rank={2} />
      {footer ? createPortal(actions, footer) : footer === undefined && <div className="settings-actions">{actions}</div>}
    </Form>
  )
}

const NO_THINKING = '~none'

/** One model's capabilities with `change` applied; a field set to undefined is removed, and so is a model left with none. */
function withCapability(
  all: Record<string, ModelCapabilities> | undefined,
  model: string,
  change: ModelCapabilities,
): Record<string, ModelCapabilities> {
  const next: ModelCapabilities = { ...all?.[model], ...change }
  for (const key of Object.keys(next) as Array<keyof ModelCapabilities>) if (next[key] === undefined) delete next[key]
  const rest = { ...all }
  delete rest[model]
  return Object.keys(next).length ? { ...rest, [model]: next } : rest
}

/**
 * Which thinking levels a model accepts: not set, or one of the protocol's usual sets. What the service takes is in its
 * own documentation; a wrong set fails the turn with the service's error, so nothing is preselected.
 */
function ThinkingPicker({
  model,
  kind,
  levels,
  disabled,
  onChange,
}: {
  model: string
  kind: ProviderKind
  levels: readonly string[] | undefined
  disabled: boolean
  onChange: (levels: string[] | undefined) => void
}) {
  const sets = THINKING_SETS[kind]
  const current = levels?.length ? levels.join(' ') : NO_THINKING
  // A set saved some other way stays on offer, so the picker never shows a value it cannot list.
  const offered = levels?.length && !sets.some(set => set.join(' ') === current) ? [...sets, levels] : sets
  return (
    <ValuePicker
      label={`${model} 的思考深度`}
      size="xs"
      value={current}
      valueText={current === NO_THINKING ? '思考：不设置' : `思考：${thinkingSetText(levels!)}`}
      options={[
        { value: NO_THINKING, label: '不设置', description: '不发送思考深度，用模型自己的默认值' },
        ...offered.map(set => ({ value: set.join(' '), label: thinkingSetText(set) })),
      ]}
      header={{ title: '这个模型接受的思考深度' }}
      width={300}
      disabled={disabled}
      onValueChange={value => {
        onChange(value === NO_THINKING ? undefined : value.split(' '))
      }}
    />
  )
}

/**
 * A saved service's page. Every value applies on its own, as settings values do: the switch, a renamed name or a new
 * address, the key (typed on the Host's desktop), the default model and each added or removed model. A saved key is
 * never shown; removing it and deleting the service are in the red group at the end. An address that is not
 * confirmed says so first, with the way to confirm it from here or where to go.
 */
function ProviderPage({
  supportsAttachments,
  provider,
  data,
  abilities,
  isDefault,
  checkOnOpen,
  fetchOnOpen,
  onProbed,
  onSaved,
  onDeleted,
}: {
  supportsAttachments?: boolean
  provider: ProviderSettings
  data: ProvidersResponse
  abilities: ProviderAbilities
  isDefault: boolean
  /** Just saved: check the connection at once and say what failed in place. */
  checkOnOpen: boolean
  /** Opened by 刷新模型列表: list what the service offers now. */
  fetchOnOpen: boolean
  /** What a listing from this page found, for the service's row. */
  onProbed: (failure: ProbeFailure | null) => void
  onSaved: (provider: ProviderSettings) => void
  onDeleted: () => void
}) {
  const [saving, setSaving] = useState(false)
  const [waiting, setWaiting] = useState(false)
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
  const unconfirmed = isUnconfirmed(provider)
  const keyless = missingKey(provider, data.presets)
  const keyEditable = abilities.keys && !(unconfirmed && abilities.offline)
  const requiresKey = data.presets.find(item => item.id === provider.presetId)?.requiresKey ?? false
  const presenter = trackedPresenter(setWaiting)
  const probe = useProbe(async () => {
    try {
      const listed = await listModels(provider.id)
      onProbed(null)
      return listed
    } catch (cause) {
      onProbed(describeProbeFailure(cause))
      throw cause
    }
  })
  const checked = useRef(false)
  useEffect(() => {
    if (!checkOnOpen || unconfirmed || keyless || checked.current) return
    checked.current = true
    void probe.runCheck()
  }, [checkOnOpen, unconfirmed, keyless, probe])

  const fetched = useRef(false)
  useEffect(() => {
    if (!fetchOnOpen || unconfirmed || keyless || fetched.current) return
    fetched.current = true
    void probe.fetchModels()
  }, [fetchOnOpen, unconfirmed, keyless, probe])

  /** One change; a confirmation, when the Host asks for one, resends the identical body. Returns the error. */
  const update = async (body: Record<string, unknown>): Promise<string> => {
    setSaving(true)
    setError('')
    try {
      onSaved(await updateProvider(provider.id, body, { presenter }))
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
  /** Confirms this service's address (and the allowance it needs) on this computer, then checks it. */
  const confirmHere = () => {
    void update({ confirmOrigin: true }).then(text => {
      if (text) setError(text)
      else void probe.runCheck()
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
  const origin = provider.keyOrigin ? `${provider.keyOrigin}${provider.keyPath ?? ''}` : keyScopeOf(provider.baseURL)
  const checkFailure = probe.check?.ok === false ? probe.check.failure : null
  const local = [probe.failure, checkFailure].find(item => item?.kind === 'local')
  const localTarget = local?.kind === 'local' ? local.target : undefined
  // The reason stands in the notice with its action, and the row only says that the check did not pass.
  const failedAction = checkAction(checkFailure, { keyEditable, justSaved: checkOnOpen })
  const listingFailed = probe.failure === null || probe.failure.kind === 'local' ? undefined : probe.failure.text
  const confirmLabel = unconfirmed && abilities.confirm ? '用 Touch ID 保存' : '保存'
  const scope = origin ? shownAddress(origin) : undefined
  const keyCaption = keyEditable
    ? PROVIDER_COPY.keyHeld
    : abilities.offline
      ? PROVIDER_COPY.keyOffline(provider.id)
      : requiresKey || provider.hasKey
        ? PROVIDER_COPY.keyElsewhere
        : undefined
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
      {unconfirmed && (
        <InlineNotice
          tone="warn"
          title={PROVIDER_COPY.unconfirmed}
          action={
            abilities.confirm ? (
              <Button
                size="xs"
                icon={LockKeyhole}
                disabled={busy}
                loading={saving}
                loadingLabel={waiting ? PROVIDER_COPY.waitingTouchID : '确认中…'}
                onClick={confirmHere}>
                {PROVIDER_COPY.confirmAddress}
              </Button>
            ) : undefined
          }>
          {abilities.confirm
            ? '确认后 Latch 才会向它发送请求；localhost 或局域网地址同时允许 Latch 访问。'
            : abilities.offline
              ? offlineText(abilities, provider.id)
              : PROVIDER_COPY.confirmElsewhere(provider.name)}
        </InlineNotice>
      )}
      {!unconfirmed && keyless && (
        <InlineNotice
          tone="warn"
          title={PROVIDER_COPY.missingKey}
          action={
            keyEditable ? (
              <Button
                size="xs"
                disabled={busy}
                onClick={() => {
                  setDialog('key')
                }}>
                设置密钥…
              </Button>
            ) : undefined
          }>
          {keyEditable ? PROVIDER_COPY.missingKeyHere : PROVIDER_COPY.missingKeyElsewhere(provider.name)}
        </InlineNotice>
      )}
      <InlineConfirm active={saving} rank={1} />
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <SettingsGroup title="连接">
        <SwitchRow
          className="settings-row"
          title="启用"
          description={
            !enabled
              ? PROVIDER_COPY.disabled
              : unconfirmed
                ? PROVIDER_COPY.enabledUnconfirmed
                : keyless
                  ? PROVIDER_COPY.enabledMissingKey
                  : PROVIDER_COPY.enabled
          }
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
          disabled={busy || unconfirmed || keyless}
          disabledReason={unconfirmed ? PROVIDER_COPY.checkNeedsAddress : keyless ? PROVIDER_COPY.checkNeedsKey : undefined}
          result={probe.check}
          reasonBelow={failedAction !== undefined}
          listingNeutral
          onCheck={() => {
            void probe.runCheck()
          }}
        />
      </SettingsGroup>
      {localTarget !== undefined && (
        <LocalAddressNotice
          target={localTarget}
          abilities={abilities}
          busy={busy}
          waiting={saving && waiting}
          actionLabel={PROVIDER_COPY.allowAgain(localTarget)}
          elsewhere={abilities.offline ? offlineText(abilities, provider.id) : PROVIDER_COPY.allowElsewhere}
          onAllow={confirmHere}
        />
      )}
      {failedAction !== undefined && checkFailure && (
        <InlineNotice
          tone="error"
          action={
            failedAction === 'remove' ? (
              <Button
                size="xs"
                disabled={busy}
                onClick={() => {
                  setConfirm('delete')
                }}>
                移除此服务
              </Button>
            ) : (
              <Button
                size="xs"
                disabled={busy}
                onClick={() => {
                  setDialog('key')
                }}>
                {provider.hasKey ? '替换密钥…' : '设置密钥…'}
              </Button>
            )
          }>
          {checkFailure.text}
        </InlineNotice>
      )}
      <SettingsGroup title="密钥" caption={keyCaption} captionIcon={keyCaption === undefined ? null : keyEditable ? 'info' : 'lock'}>
        <SettingsRow
          leading={<IconTile icon={provider.hasKey ? KeyRound : LockKeyhole} />}
          title={provider.hasKey ? '已保存（不回显）' : '未设置'}
          description={provider.hasKey && scope ? `只发往 ${scope}` : requiresKey ? '这个服务需要密钥才能使用' : '本地服务通常无需密钥'}
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
        modelCapabilities={provider.modelCapabilities}
        onVision={
          supportsAttachments
            ? (model, vision) => apply({ modelCapabilities: withCapability(provider.modelCapabilities, model, { vision }) })
            : undefined
        }
        kind={provider.kind}
        onThinking={(model, thinking) => {
          apply({ modelCapabilities: withCapability(provider.modelCapabilities, model, { thinking }) })
        }}
        models={provider.models}
        defaultModel={provider.defaultModel}
        fetched={probe.fetched}
        fetching={probe.busy === 'fetch'}
        disabled={busy}
        failed={listingFailed}
        fetchBlocked={unconfirmed ? '确认地址后才能获取模型' : keyless ? '填写密钥后才能获取模型' : undefined}
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
      <SettingsGroup>
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
        warning={value => {
          const drops = provider.hasKey && keyScopeOf(value, provider.keyPath !== undefined) !== origin
          const first = abilities.confirm && destinationOf(value, data) === 'unconfirmed'
          const lines = [
            ...(drops ? ['密钥只发往原来的地址：保存后会移除已保存的密钥。'] : []),
            ...(first ? ['这个地址第一次使用：保存时要用 Touch ID 确认。'] : []),
          ]
          return lines.length ? lines.join('') : undefined
        }}
        onSubmit={value =>
          update({ baseURL: value, ...(abilities.confirm && destinationOf(value, data) === 'unconfirmed' ? { confirmOrigin: true } : {}) })
        }
        onClose={() => {
          setDialog(null)
        }}
      />
      <FieldDialog
        open={dialog === 'key'}
        title={provider.hasKey ? '替换密钥' : '设置密钥'}
        subtitle={scope ? `密钥只发往 ${scope}` : undefined}
        note={unconfirmed && abilities.confirm ? '保存时要用 Touch ID 确认这个地址' : undefined}
        label="API Key"
        type="password"
        placeholder="输入密钥"
        hint={PROVIDER_COPY.keyHeld}
        confirmLabel={confirmLabel}
        onSubmit={value => update({ apiKey: value, ...(unconfirmed && abilities.confirm ? { confirmOrigin: true } : {}) })}
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
              await api(`providers/${encodeURIComponent(provider.id)}`, { method: 'DELETE' })
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

const EMPTY_PROVIDERS: ProviderSettings[] = []
const EMPTY_PRESETS: ProviderPreset[] = []

/** What a service's row says about it: facts it knows, or what the latest listing in this visit found. */
type Health = ServiceHealth

/** How many services are asked at once; each answer can take up to 20 seconds. */
const CHECKS_AT_ONCE = 4

/**
 * 已连接 has to be something the app just saw, not something it assumes from a saved key, so opening the page lists each
 * usable service's models once. A listing spends no tokens. A new address or key asks again, and a check on a service's
 * own page counts too, so its row never disagrees with the page.
 */
function useServiceHealth(
  providers: readonly ProviderSettings[],
  presets: readonly ProviderPreset[],
): { health: Record<string, Health>; recheck: (id: string) => void; report: (id: string, failure: ProbeFailure | null) => void } {
  const [health, setHealth] = useState<Record<string, Health>>({})
  const usable = useMemo(
    () => providers.filter(provider => provider.enabled && !isUnconfirmed(provider) && !missingKey(provider, presets)),
    [providers, presets],
  )
  const asked = useRef(new Map<string, string>())
  const questions = useRef(latestQuestions())
  useEffect(() => {
    const due = usable.filter(provider => asked.current.get(provider.id) !== provider.baseURL)
    if (due.length === 0) return
    for (const provider of due) asked.current.set(provider.id, provider.baseURL)
    setHealth(current => ({ ...current, ...Object.fromEntries(due.map(provider => [provider.id, 'checking' as const])) }))
    const queue = due.map(provider => ({ id: provider.id, latest: questions.current.ask(provider.id) }))
    const next = async (): Promise<void> => {
      const question = queue.shift()
      if (!question) return
      if (question.latest()) {
        const result = await listModels(question.id).then(
          () => serviceHealth(null),
          (cause: unknown) => serviceHealth(describeProbeFailure(cause)),
        )
        if (question.latest()) setHealth(current => ({ ...current, [question.id]: result }))
      }
      await next()
    }
    for (let worker = 0; worker < CHECKS_AT_ONCE; worker++) void next()
  }, [usable])
  return {
    health,
    recheck: id => {
      asked.current.delete(id)
    },
    report: useCallback((id, failure) => {
      questions.current.ask(id)
      setHealth(current => ({ ...current, [id]: serviceHealth(failure) }))
    }, []),
  }
}

/** The state at a service's end: quiet while it works, a red word with the way out when it does not. */
function ServiceStatus({
  provider,
  presets,
  health,
  abilities,
  onUpdateKey,
}: {
  provider: ProviderSettings
  presets: readonly ProviderPreset[]
  health: Health | undefined
  abilities: ProviderAbilities
  onUpdateKey: () => void
}) {
  const word = (text: string, tone?: 'err' | 'warn', reason?: string) => (
    <span className="service-status" data-tone={tone} title={reason}>
      {text}
    </span>
  )
  if (!provider.enabled) return word('已停用')
  if (isUnconfirmed(provider)) return word(PROVIDER_COPY.unconfirmedBadge, 'warn', PROVIDER_COPY.unconfirmedRow)
  const keyAction = (label: string) => (
    <Button
      variant="outline"
      disabled={!abilities.keys}
      tooltip={abilities.keys ? undefined : PROVIDER_COPY.keyElsewhere}
      onClick={onUpdateKey}>
      {label}
    </Button>
  )
  if (missingKey(provider, presets))
    return (
      <>
        {word(PROVIDER_COPY.missingKeyBadge, 'warn')}
        {keyAction('设置密钥')}
      </>
    )
  switch (health) {
    case 'key':
      return (
        <>
          {word('密钥无效', 'err')}
          {keyAction('更新密钥')}
        </>
      )
    case 'unreachable':
      return word('连不上', 'err')
    case 'local':
      return word('等待允许', 'warn')
    case 'ok':
      return word('已连接', undefined, PROVIDER_COPY.connectedReason)
    case 'checking':
      return word('检测中')
    default:
      return null
  }
}

export function ProvidersSettings({ snapshot, access, onChanged }: { snapshot: AppSnapshot; access: Access; onChanged: () => void }) {
  const [data, setData] = useState<ProvidersResponse | null>(null)
  const [error, setError] = useState('')
  const [selection, setSelection] = useState<Selection>(null)
  // A form left for a session (查看会话) opens again where it was.
  const [adding, setAdding] = useState<{ preset: ProviderPreset | null } | null>(() => {
    const draft = peekProviderDraft()
    return draft ? { preset: draft.preset } : null
  })
  const [sheetFooter, setSheetFooter] = useState<HTMLElement | null>(null)
  const [addCommitting, setAddCommitting] = useState(false)
  const [keyFor, setKeyFor] = useState<ProviderSettings | null>(null)
  const [removing, setRemoving] = useState<ProviderSettings | null>(null)
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
  const { health, recheck, report } = useServiceHealth(data?.providers ?? EMPTY_PROVIDERS, data?.presets ?? EMPTY_PRESETS)

  const abilities = providerAbilities(access, hostView(snapshot)?.presence)
  const external = snapshot.catalog?.providers.filter(provider => provider.kind === 'demo' || provider.kind === 'plugin') ?? []
  const defaultProvider = snapshot.catalog?.defaults.model?.providerId
  const selected = selection?.kind === 'provider' ? data?.providers.find(provider => provider.id === selection.id) : undefined
  const saved = (provider: ProviderSettings, check = false) => {
    recheck(provider.id)
    onChanged()
    void load({ kind: 'provider', id: provider.id, check })
  }
  const deleted = () => {
    onChanged()
    setSelection(null)
    void load()
  }
  const addService = () => {
    setAdding({ preset: null })
  }
  const confirmed = (address: string) => {
    setData(current =>
      current && current.confirmedAddresses && !current.confirmedAddresses.includes(address)
        ? { ...current, confirmedAddresses: [...current.confirmedAddresses, address] }
        : current,
    )
    onChanged()
  }

  if (data === null)
    return error ? (
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
    )

  const local = (provider: ProviderSettings) => data.presets.find(preset => preset.id === provider.presetId)?.requiresKey === false
  const main = (
    <>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <SettingsGroup
        title="服务"
        meta={
          <Button variant="outline" icon={Plus} onClick={addService}>
            添加服务
          </Button>
        }>
        {data.providers.length === 0 ? (
          <SettingsRow title="还没有模型服务" description="添加一个后，Latch 内置就能用它" />
        ) : (
          data.providers.map(provider => (
            <ObjectRow
              key={provider.id}
              className="provider-row"
              label={`编辑 ${provider.name}`}
              leading={<ProviderTile provider={provider} size={24} />}
              dim={!provider.enabled}
              title={
                <span className="settings-row-name">
                  {provider.name}
                  {local(provider) && <span className="settings-row-note">本地</span>}
                  {defaultProvider === provider.id && <span className="settings-row-note">默认</span>}
                </span>
              }
              description={`${provider.models.length} 个模型`}
              onOpen={() => {
                setSelection({ kind: 'provider', id: provider.id })
              }}
              trailing={
                <>
                  <ServiceStatus
                    provider={provider}
                    presets={data.presets}
                    health={health[provider.id]}
                    abilities={abilities}
                    onUpdateKey={() => {
                      setKeyFor(provider)
                    }}
                  />
                  <Menu
                    label={`${provider.name} 的操作`}
                    align="end"
                    sections={[
                      {
                        id: 'service',
                        items: [
                          {
                            id: 'edit',
                            label: '编辑…',
                            icon: Pencil,
                            onSelect: () => {
                              setSelection({ kind: 'provider', id: provider.id })
                            },
                          },
                          {
                            id: 'key',
                            label: '更新密钥…',
                            icon: KeyRound,
                            ...(abilities.keys ? {} : { disabledReason: PROVIDER_COPY.keyElsewhere }),
                            onSelect: () => {
                              setKeyFor(provider)
                            },
                          },
                          {
                            id: 'models',
                            label: '刷新模型列表',
                            icon: ListRestart,
                            onSelect: () => {
                              setSelection({ kind: 'provider', id: provider.id, fetch: true })
                            },
                          },
                        ],
                      },
                      {
                        id: 'danger',
                        items: [
                          {
                            id: 'remove',
                            label: '移除…',
                            icon: Trash,
                            danger: true,
                            onSelect: () => {
                              setRemoving(provider)
                            },
                          },
                        ],
                      },
                    ]}
                    trigger={moreButton(`${provider.name} 的操作`)}
                  />
                </>
              }
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
              leading={<ProviderTile provider={provider} size={24} />}
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
      {access.local && access.admin && (
        <ConfirmedAddresses
          providers={data.providers}
          revision={(data.confirmedAddresses ?? []).join('\n')}
          onChanged={() => {
            onChanged()
            void load()
          }}
        />
      )}
      {snapshot.catalog?.features?.usage && <UsageSettings catalog={snapshot.catalog} />}
      {snapshot.catalog && <ModelVisibilitySettings catalog={snapshot.catalog} />}
      <Dialog
        open={adding !== null}
        size="sheet"
        title="添加服务"
        onClose={() => {
          if (!addCommitting) setAdding(null)
        }}
        footer={
          adding?.preset ? (
            <div ref={setSheetFooter} className="provider-sheet-footer" />
          ) : (
            <Button
              size="md"
              onClick={() => {
                setAdding(null)
              }}>
              取消
            </Button>
          )
        }>
        {adding && (
          <div className="provider-sheet">
            <PresetGrid
              presets={data.presets}
              chosen={adding.preset?.id}
              disabled={addCommitting}
              onPick={preset => {
                setAdding({ preset })
              }}
            />
            {adding.preset && (
              <ProviderAddForm
                key={adding.preset.id}
                preset={adding.preset}
                data={data}
                abilities={abilities}
                footer={sheetFooter}
                onBusy={setAddCommitting}
                onConfirmed={confirmed}
                onSaved={() => {
                  setAdding(null)
                  onChanged()
                  void load()
                }}
                onCancel={() => {
                  if (!addCommitting) setAdding(null)
                }}
              />
            )}
          </div>
        )}
      </Dialog>
      <FieldDialog
        open={keyFor !== null}
        title={keyFor?.hasKey ? '更新密钥' : '设置密钥'}
        subtitle={keyFor && keyScopeOf(keyFor.baseURL) ? `密钥只发往 ${shownAddress(keyScopeOf(keyFor.baseURL)!)}` : undefined}
        note={keyFor && isUnconfirmed(keyFor) && abilities.confirm ? '保存时要用 Touch ID 确认这个地址' : undefined}
        label="API Key"
        type="password"
        placeholder="输入密钥"
        hint={PROVIDER_COPY.keyHeld}
        confirmLabel={keyFor && isUnconfirmed(keyFor) && abilities.confirm ? '用 Touch ID 保存' : '保存'}
        onSubmit={async value => {
          if (!keyFor) return ''
          try {
            await updateProvider(keyFor.id, {
              apiKey: value,
              ...(isUnconfirmed(keyFor) && abilities.confirm ? { confirmOrigin: true } : {}),
            })
            recheck(keyFor.id)
            onChanged()
            await load()
            return ''
          } catch (cause) {
            return inlineError(cause)
          }
        }}
        onClose={() => {
          setKeyFor(null)
        }}
      />
      {removing && (
        <ConfirmDialog
          title={`移除「${removing.name}」？`}
          danger
          confirmLabel="移除"
          message="它保存的密钥一起删除；正在使用它的会话要换用其他模型。"
          onClose={() => {
            setRemoving(null)
          }}
          onConfirm={async () => {
            try {
              await api(`providers/${encodeURIComponent(removing.id)}`, { method: 'DELETE' })
            } catch (cause) {
              throw new Error(errorMessage(cause), { cause })
            }
            deleted()
          }}
        />
      )}
    </>
  )

  const levels: SettingsLevel[] = []
  const notice: ReactNode = error ? <InlineNotice tone="error">{error}</InlineNotice> : null
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
            supportsAttachments={snapshot.catalog?.features?.attachments === true}
            provider={selected}
            data={data}
            abilities={abilities}
            isDefault={defaultProvider === selected.id}
            checkOnOpen={selection?.kind === 'provider' && selection.check === true}
            fetchOnOpen={selection?.kind === 'provider' && selection.fetch === true}
            onProbed={failure => {
              report(selected.id, failure)
            }}
            onSaved={provider => {
              saved(provider)
            }}
            onDeleted={deleted}
          />
        </>
      ),
    })

  return <SettingsPages main={main} levels={levels} />
}
