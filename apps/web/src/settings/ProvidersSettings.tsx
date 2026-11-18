import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { KeyRound, Network } from 'lucide-react'
import {
  MAX_CONTEXT_TOKENS,
  MIN_CONTEXT_TOKENS,
  PROVIDER_KINDS,
  type ModelCapabilities,
  type ModelFallback,
  type ProviderKind,
  type ProviderPreset,
  type ProviderSettings,
} from '@latch/protocol'
import { api, ApiError, errorMessage, inlineError, isUncertain, MessageError } from '../core/api.ts'
import { keepWhileAway } from '../core/blocking.ts'
import {
  checkAction,
  checkAddress,
  changesProviderTarget,
  confirmAddress,
  createProvider,
  describeProbeFailure,
  destinationOf,
  isUnconfirmed,
  keyScopeOf,
  listModels,
  missingKey,
  modelIdProblem,
  servicesToPick,
  SERVICE_FORM,
  shownAddress,
  trackedPresenter,
  updateProvider,
  type Destination,
  type ListedModels,
  type NewProvider,
  type ProbeFailure,
  type ProvidersResponse,
} from '../core/providerSetup.ts'
import { PROVIDER_COPY } from '../core/securityCopy.ts'
import { InlineConfirm } from '../components/InlineConfirm.tsx'
import { ConfirmDialog } from '../components/overlays.tsx'
import {
  Badge,
  Button,
  Hint,
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
  AlertGlyph,
  CircleCheckGlyph,
  InfoGlyph,
  LockGlyph,
  PlusGlyph,
  TrashGlyph,
} from '@latch/ui'
import { THINKING_SETS, thinkingSetText } from '../composer/modelReasoning.ts'
import { ProviderTile } from '../components/BrandTile.tsx'
import { HealthLine } from '../components/ServiceHealth.tsx'
import { IconTile, MiddleEllipsis, moreButton, NoteLine, SectionHeading, SettingsGroup, SettingsRow } from './common.tsx'
import { FieldDialog } from './dialogs.tsx'
import { dropProviderDraft, keepProviderDraft, peekProviderDraft, type ProviderDraft } from './providerDraft.ts'
import { isSupported, providerKindLabels, type SupportedProvider } from './providerKind.ts'
import { fallbackLabel, ModelFallbacksDialog } from './ModelFallbacks.tsx'
import { BudgetRow, PricesDialog, useModelSpend } from './ModelSpend.tsx'
import type { ProviderAbilities } from '../core/providerAbilities.ts'
import { clearProviderAddition, previousProviderInput, providerAddition, rememberProviderAddition } from '../core/providerAddition.ts'
import { defineCopy, formatNumber, plural } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    checkConnection: '检测连接',
    unreachable: 'Latch 还不能访问这个地址',
    checkFailed: '没有通过',
    checking: '检测中…',
    check: '检测',
    checkAgain: '重新检测',
    manualModel: '手动添加模型 ID',
    addTyped: '添加输入的模型 ID',
    add: '添加',
    noModelsYet: '尚未添加模型。获取服务的模型列表，或手动输入模型 ID。',
    noReturnedModels: '服务没有返回模型，可以手动添加。',
    models: '模型',
    fetching: '获取中…',
    fetchModels: '获取模型',
    setImagesThinking: '图片与思考按服务的文档设置',
    setThinking: '思考按服务的文档设置',
    default: '默认',
    fallback: '出错时改用',
    priced: '已填单价',
    fallbackEdit: '出错时改用…',
    savingPlain: '正在保存',
    price: '单价…',
    acceptImages: '可以接收图片（需与模型服务的真实能力一致）',
    remove: '移除',
    modelsToAdd: '可添加的模型',
    filterModels: '筛选模型',
    notListed: '服务没有列出模型',
    canEnterModel: '可以手动输入模型 ID。',
    manualModelFirst: '服务没有列出模型。手动输入一个模型 ID，再保存。',
    noReceipt: '还没有收到添加回执。',
    cancel: '取消',
    saving: '保存中…',
    addUnknown: '添加结果未确认。',
    verifyResult: '核对结果',
    retryRequest: '重试同一请求',
    letGo: '放下这次请求',
    name: '名称',
    protocol: '协议',
    enterKey: '输入密钥',
    localKey: '本地服务通常无需密钥',
    optional: '可选',
    contextTokens: '上下文长度（token）',
    context: '上下文',
    thinkingDefault: '思考：默认',
    thinkingOptions: '这个模型接受的思考',
    keepOne: '至少保留一个模型。',
    saveTouchID: '用 Touch ID 保存',
    save: '保存',
    rename: '重命名…',
    confirming: '确认中…',
    setKeyEllipsis: '设置密钥…',
    connection: '连接',
    enable: '启用',
    change: '修改…',
    clearsThinking: '换协议会清除为模型设置的思考',
    concurrent: '同时请求',
    concurrentDetail: '这个服务同时最多几个请求',
    unlimited: '不限',
    removeService: '移除此服务',
    replaceKeyEllipsis: '替换密钥…',
    key: '密钥',
    savedKey: '已保存（不回显）',
    notSet: '未设置',
    keyRequired: '这个服务需要密钥才能使用',
    replace: '替换…',
    addressBeforeFetch: '确认地址后才能获取模型',
    keyBeforeFetch: '填写密钥后才能获取模型',
    removeKey: '移除密钥',
    deleteService: '删除服务',
    delete: '删除',
    renameService: '重命名服务',
    changeAddress: '修改地址',
    addressRemovesKey: '密钥只发往原来的地址：保存后会移除已保存的密钥。',
    replaceKey: '替换密钥',
    setKey: '设置密钥',
    deleteModelService: '删除模型服务',
    checkResult: (ms: number, count: number) => `连接正常 · ${formatNumber(ms)} ms · ${formatNumber(count)} 个模型`,
    manualAfter: (reason: string) => `${reason}可以手动输入模型 ID。`,
    listResult: (count: number, fresh: number) =>
      `获取到 ${formatNumber(count)} 个模型${fresh ? `，${formatNumber(fresh)} 个尚未添加` : '，都已添加'}。`,
    thinkingDetail: (vision: boolean) => `${vision ? '图片未开启时只发送文字。' : ''}思考选「默认」时用模型自己的默认值。`,
    newSessionDefault: (model: string) => `默认使用 ${model}`,
    fallbackCount: (count: number) => ` 等 ${formatNumber(count)} 个`,
    moreModel: (model: string) => `${model} 的更多设置`,
    modelImages: (model: string) => `${model} 可以接收图片`,
    removeModel: (model: string) => `移除模型 ${model}`,
    modelCount: (count: number) => `${formatNumber(count)} 个模型`,
    addModel: (model: string) => `添加模型 ${model}`,
    foundModels: (count: number) => `找到 ${formatNumber(count)} 个模型`,
    useModel: (model: string) => `使用 ${model}`,
    foundDefault: (count: number) => `找到 ${formatNumber(count)} 个模型，第一个打开的是默认`,
    listingNeedsKey: (elsewhere: string) => `列出模型需要密钥。${elsewhere}`,
    confirmThere: (computer: string) => `可以先手动输入模型 ID 保存，再在 ${computer} 上确认这个地址。`,
    modelContext: (model: string) => `${model} 的上下文长度（token）`,
    modelThinking: (model: string) => `${model} 的思考`,
    thinking: (level: string) => `思考：${level}`,
    defaultService: (kind: string) => `${kind} · 新会话默认使用`,
    requests: (count: number) => `${formatNumber(count)} 个`,
    sentTo: (scope: string) => `只发往 ${scope}`,
    keySentTo: (scope: string) => `密钥只发往 ${scope}`,
    confirmRemoveKey: (service: string) => `移除「${service}」保存的密钥？需要密钥的服务在重新设置前不能使用。`,
    confirmDelete: (service: string) => `删除「${service}」及其保存的密钥？正在使用它的会话需要换用其他模型。`,
  },
  {
    checkConnection: 'Check connection',
    unreachable: 'Latch can’t reach this address yet',
    checkFailed: 'Failed',
    checking: 'Checking…',
    check: 'Check',
    checkAgain: 'Check again',
    manualModel: 'Add a model ID',
    addTyped: 'Add the typed model ID',
    add: 'Add',
    noModelsYet: 'No models yet. Fetch the service’s list, or type a model ID.',
    noReturnedModels: 'The service returned no models. You can add one by ID.',
    models: 'Models',
    fetching: 'Fetching…',
    fetchModels: 'Fetch models',
    setImagesThinking: 'Set images and thinking per the service’s docs',
    setThinking: 'Set thinking per the service’s docs',
    default: 'Default',
    fallback: 'Fallback models',
    priced: 'Price set',
    fallbackEdit: 'Fallback models…',
    savingPlain: 'Saving',
    price: 'Price…',
    acceptImages: 'Accepts images (must match what the service really supports)',
    remove: 'Remove',
    modelsToAdd: 'Models to add',
    filterModels: 'Filter models',
    notListed: 'The service listed no models',
    canEnterModel: 'You can type a model ID.',
    manualModelFirst: 'The service listed no models. Type a model ID, then save.',
    noReceipt: 'No receipt for adding the service yet.',
    cancel: 'Cancel',
    saving: 'Saving…',
    addUnknown: 'Adding the service is still unconfirmed.',
    verifyResult: 'Check result',
    retryRequest: 'Retry same request',
    letGo: 'Stop waiting for this request',
    name: 'Name',
    protocol: 'Protocol',
    enterKey: 'Enter key',
    localKey: 'Local services usually need no key',
    optional: 'Optional',
    contextTokens: 'Context length (tokens)',
    context: 'Context',
    thinkingDefault: 'Thinking: Default',
    thinkingOptions: 'Thinking this model accepts',
    keepOne: 'Keep at least one model.',
    saveTouchID: 'Save with Touch ID',
    save: 'Save',
    rename: 'Rename…',
    confirming: 'Confirming…',
    setKeyEllipsis: 'Set key…',
    connection: 'Connection',
    enable: 'Enable',
    change: 'Change…',
    clearsThinking: 'Changing the protocol clears the thinking set for each model',
    concurrent: 'Concurrent requests',
    concurrentDetail: 'Maximum concurrent requests for this service',
    unlimited: 'Unlimited',
    removeService: 'Remove service',
    replaceKeyEllipsis: 'Replace key…',
    key: 'Key',
    savedKey: 'Saved (not shown)',
    notSet: 'Not set',
    keyRequired: 'This service needs a key',
    replace: 'Replace…',
    addressBeforeFetch: 'Confirm the address to fetch models',
    keyBeforeFetch: 'Add a key to fetch models',
    removeKey: 'Remove key',
    deleteService: 'Delete service',
    delete: 'Delete',
    renameService: 'Rename service',
    changeAddress: 'Change address',
    addressRemovesKey: 'The key is sent only to the original address. Saving removes the saved key.',
    replaceKey: 'Replace key',
    setKey: 'Set key',
    deleteModelService: 'Delete model service',
    checkResult: (ms: number, count: number) =>
      `Connected · ${formatNumber(ms)} ms · ${plural(count, { one: '{n} model', other: '{n} models' })}`,
    manualAfter: (reason: string) => `${reason} You can type a model ID.`,
    listResult: (count: number, fresh: number) =>
      `Received ${plural(count, { one: '{n} model', other: '{n} models' })}.${fresh ? ` ${formatNumber(fresh)} available to add.` : ' All have been added.'}`,
    thinkingDetail: (vision: boolean) =>
      `${vision ? 'With images off, the request sends text only. ' : ''}Default thinking uses the model’s own default.`,
    newSessionDefault: (model: string) => `Use ${model} by default`,
    fallbackCount: (count: number) => ` and ${formatNumber(count - 1)} more`,
    moreModel: (model: string) => `More settings for ${model}`,
    modelImages: (model: string) => `${model} accepts images`,
    removeModel: (model: string) => `Remove model ${model}`,
    modelCount: (count: number) => plural(count, { one: '{n} model', other: '{n} models' }),
    addModel: (model: string) => `Add model ${model}`,
    foundModels: (count: number) => `Found ${plural(count, { one: '{n} model', other: '{n} models' })}`,
    useModel: (model: string) => `Use ${model}`,
    foundDefault: (count: number) =>
      `Found ${plural(count, { one: '{n} model', other: '{n} models' })}. The first enabled model is the default.`,
    listingNeedsKey: (elsewhere: string) => `Listing models requires a key. ${elsewhere}`,
    confirmThere: (computer: string) => `You can save a model ID manually, then confirm this address on ${computer}.`,
    modelContext: (model: string) => `Context length for ${model} (tokens)`,
    modelThinking: (model: string) => `Thinking for ${model}`,
    thinking: (level: string) => `Thinking: ${level}`,
    defaultService: (kind: string) => `${kind} · Default for new sessions`,
    requests: (count: number) => formatNumber(count),
    sentTo: (scope: string) => `Sent only to ${scope}`,
    keySentTo: (scope: string) => `The key goes only to ${scope}`,
    confirmRemoveKey: (service: string) =>
      `Remove the saved key for “${service}”? If the service requires a key, it becomes available again after you set one.`,
    confirmDelete: (service: string) => `Delete “${service}” and its saved key? Sessions using the service will need a different model.`,
  },
)
export { providerAbilities, type ProviderAbilities } from '../core/providerAbilities.ts'

type CheckState = { ok: true; latencyMs: number; count: number } | { ok: false; failure: ProbeFailure }

/** Where an address is confirmed on the desktop that cannot confirm it now: the fix, or the offline command. */
function offlineText(abilities: ProviderAbilities, providerId?: string): string {
  if (abilities.presenceBroken) return PROVIDER_COPY.presenceBroken(abilities.presenceBroken)
  return providerId ? PROVIDER_COPY.confirmOffline(providerId) : PROVIDER_COPY.confirmOfflineNew()
}

/** The protocols a service's address speaks, its preset's first; a service with no preset may speak any. */
export function protocolChoices(preset: ProviderPreset | undefined, current?: ProviderKind): ProviderKind[] {
  const offered: ProviderKind[] = preset ? [preset.kind, ...(preset.otherKinds ?? [])] : [...PROVIDER_KINDS]
  return current && !offered.includes(current) ? [current, ...offered] : offered
}

/**
 * The services one can add, as a grid of brand tiles ending in 「自定义地址…」; the chosen one stays marked while its form
 * shows below.
 */
export function PresetGrid({
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
      {servicesToPick(presets).map(preset => (
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
          <span className="preset-card-name">{preset.id === 'custom' || !preset.baseURL ? SERVICE_FORM.custom : preset.name}</span>
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
function useProbe(probe: () => Promise<ListedModels & { latencyMs?: number }>, onKeyMismatch?: () => void) {
  const [busy, setBusy] = useState<null | 'check' | 'fetch'>(null)
  // The context length the last listing reported per model, read at once by a save that follows in the same handler.
  const listedContext = useRef<Record<string, number>>({})
  const [check, setCheck] = useState<CheckState | null>(null)
  const [fetched, setFetched] = useState<string[] | null>(null)
  const [failure, setFailure] = useState<ProbeFailure | null>(null)
  // The last listing's failure at once, for a caller that goes on in the same handler (state updates come later).
  const last = useRef<ProbeFailure | null>(null)

  const failed = (cause: unknown): ProbeFailure => {
    const described = describeProbeFailure(cause)
    if (cause instanceof ApiError && cause.code === 'key-origin-mismatch') onKeyMismatch?.()
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
      listedContext.current = result.contextTokens ?? {}
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
      const { models, contextTokens } = await probe()
      listedContext.current = contextTokens ?? {}
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
  /** What the last listing said of `model`'s context length, to prefill its declaration when it is added. */
  const listedContextOf = (model: string): number | undefined =>
    Object.hasOwn(listedContext.current, model) ? listedContext.current[model] : undefined
  return { busy, check, fetched, failure, runCheck, fetchModels, setFetched, reset, listedContextOf, lastFailure: () => last.current }
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
      title={COPY.checkConnection}
      description={
        result === null ? undefined : local ? (
          <span className="check-result" role="status">
            <Icon icon={InfoGlyph} size={12} />
            {COPY.unreachable}
          </span>
        ) : unknown ? (
          <span className="check-result" role="status">
            <Icon icon={InfoGlyph} size={12} />
            {PROVIDER_COPY.listingUnavailable}
          </span>
        ) : (
          <span className={`check-result ${result.ok ? 'is-ok' : 'is-error'}`} role="status">
            <Icon icon={result.ok ? CircleCheckGlyph : AlertGlyph} size={12} />
            {result.ok ? COPY.checkResult(result.latencyMs, result.count) : reasonBelow ? COPY.checkFailed : result.failure.text}
          </span>
        )
      }
      trailing={
        <Button
          aria-label={COPY.checkConnection}
          disabled={disabled}
          tooltip={disabledReason}
          loading={busy}
          loadingLabel={COPY.checking}
          onClick={onCheck}>
          {result === null ? COPY.check : COPY.checkAgain}
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
  if (atSave && abilities.confirm) return <NoteLine icon={Network} brief={PROVIDER_COPY.localNoteAtSave(target)} />
  const note = PROVIDER_COPY.localNote(target)
  return (
    <NoteLine
      icon={Network}
      brief={abilities.confirm ? note : { label: note.label, detail: `${note.detail ?? ''}${elsewhere}` }}
      action={
        abilities.confirm ? (
          <Button
            size="xs"
            icon={LockGlyph}
            disabled={busy}
            loading={waiting}
            loadingLabel={PROVIDER_COPY.waitingTouchID}
            onClick={onAllow}>
            {actionLabel}
          </Button>
        ) : undefined
      }
    />
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
        aria-label={COPY.manualModel}
        aria-describedby={problem ? hint : undefined}
        aria-invalid={problem ? true : undefined}
        placeholder={COPY.manualModel}
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
      <Button icon={PlusGlyph} aria-label={COPY.addTyped} disabled={disabled || !manual.trim()} onClick={add}>
        {COPY.add}
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
  onContext,
  fallbacks,
  services,
  onFallbacks,
  priced,
  onPrices,
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
  /** The model's declared context length; absent on the add form, which declares only what the listing said. */
  onContext?: (model: string, contextTokens: number | undefined) => void
  /** 「出错时改用」 by model, with the saved services their entries name. Absent on the add form, which has nothing saved yet. */
  fallbacks?: Record<string, ModelFallback[]>
  services?: readonly Pick<ProviderSettings, 'id' | 'name'>[]
  onFallbacks?: (model: string) => void
  /** The models the person entered prices for, and the way to 「单价」. Absent on the add form. */
  priced?: ReadonlySet<string>
  onPrices?: (model: string) => void
}) {
  const group = useId()
  const [filter, setFilter] = useState('')
  const fresh = fetched?.filter(model => !models.includes(model)) ?? []
  const shown = fresh.filter(model => model.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
  const caption = failed
    ? COPY.manualAfter(failed)
    : fetched === null
      ? models.length === 0
        ? COPY.noModelsYet
        : undefined
      : fetched.length === 0
        ? COPY.noReturnedModels
        : COPY.listResult(fetched.length, fresh.length)
  return (
    <>
      <SettingsGroup
        title={COPY.models}
        meta={
          <Button
            variant="link"
            size="xs"
            loading={fetching}
            loadingLabel={COPY.fetching}
            disabled={disabled || fetchBlocked !== undefined}
            tooltip={fetchBlocked}
            onClick={onFetch}>
            {COPY.fetchModels}
          </Button>
        }
        caption={caption}
        captionIcon={null}
        note={
          <NoteLine
            brief={{
              label: onVision ? COPY.setImagesThinking : COPY.setThinking,
              detail: COPY.thinkingDetail(Boolean(onVision)),
            }}
          />
        }>
        {models.map(model => (
          <div key={model} className="settings-row model-row" data-leading="" data-check="">
            <span className="settings-row-lead">
              <Radio
                name={group}
                checked={defaultModel === model}
                disabled={disabled}
                aria-label={COPY.newSessionDefault(model)}
                onChange={() => {
                  onDefault(model)
                }}
              />
            </span>
            <span className="settings-row-text">
              <span className="settings-row-title settings-row-name">
                <code className="settings-mono model-id">{model}</code>
                {defaultModel === model && <Badge>{COPY.default}</Badge>}
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
                {onContext && (
                  <ContextField
                    model={model}
                    value={modelCapabilities?.[model]?.contextTokens}
                    disabled={disabled}
                    onChange={contextTokens => {
                      onContext(model, contextTokens)
                    }}
                  />
                )}
                {fallbacks?.[model]?.length ? (
                  <span className="model-fallback-note">
                    {COPY.fallback} {fallbackLabel(fallbacks[model]![0]!, services ?? [])}
                    {fallbacks[model]!.length > 1 ? COPY.fallbackCount(fallbacks[model]!.length) : ''}
                  </span>
                ) : null}
                {priced?.has(model) && <span className="model-fallback-note">{COPY.priced}</span>}
              </span>
            </span>
            <span className="settings-row-end">
              {onFallbacks && (
                <Menu
                  label={COPY.moreModel(model)}
                  align="end"
                  trigger={moreButton(COPY.moreModel(model))}
                  sections={[
                    {
                      id: 'model',
                      items: [
                        {
                          id: 'fallbacks',
                          label: COPY.fallbackEdit,
                          ...(disabled ? { disabledReason: COPY.savingPlain } : {}),
                          onSelect: () => {
                            onFallbacks(model)
                          },
                        },
                        ...(onPrices
                          ? [
                              {
                                id: 'prices',
                                label: COPY.price,
                                onSelect: () => {
                                  onPrices(model)
                                },
                              },
                            ]
                          : []),
                      ],
                    },
                  ]}
                />
              )}
              {onVision && (
                <Switch
                  label={COPY.modelImages(model)}
                  title={COPY.acceptImages}
                  checked={modelCapabilities?.[model]?.vision === true}
                  disabled={disabled}
                  onCheckedChange={vision => onVision(model, vision)}
                />
              )}
              <IconButton
                label={COPY.removeModel(model)}
                tooltip={COPY.remove}
                icon={TrashGlyph}
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
        <SettingsGroup title={COPY.modelsToAdd} meta={COPY.modelCount(fresh.length)}>
          {fresh.length > 8 && (
            <div className="settings-row model-filter">
              <SearchField label={COPY.filterModels} value={filter} onValueChange={setFilter} />
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
                    aria-label={COPY.addModel(model)}
                    onClick={() => {
                      onAdd(model)
                    }}>
                    {COPY.add}
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

/** The limits a service's 同时请求 offers; the Host takes any whole number from 1 to 32. */
const CONCURRENCY_CHOICES = [1, 2, 4, 8, 16, 32]

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
        {fetched === null ? COPY.models : fetched.length ? COPY.foundModels(fetched.length) : COPY.notListed}
      </span>
      {all.length > 8 && <SearchField label={COPY.filterModels} value={filter} onValueChange={setFilter} />}
      {shown.length > 0 && (
        <div className="provider-found-list">
          {shown.map(model => (
            <div key={model} className="provider-found-row">
              <code className="settings-mono model-id">{model}</code>
              <Switch
                label={COPY.useModel(model)}
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
      {failed && (
        <p className="settings-caption">
          {failed}
          {COPY.canEnterModel}
        </p>
      )}
    </div>
  )
}

/** The address's state under the add form's fields: confirmed once on first use, and where that happens. */
function addressNote(destination: Destination, abilities: ProviderAbilities, localTarget: string | undefined, computer: string): ReactNode {
  if (destination !== 'unconfirmed') return null
  // The save button says 「用 Touch ID 保存」, and a local address has its own line.
  if (abilities.confirm) return null
  if (abilities.offline) return offlineText(abilities)
  return PROVIDER_COPY.savedUnconfirmed(computer)
}

/**
 * The add form of a new service: fields in cards, the models it will offer, and 保存 at the end. A preset's HTTPS
 * address saves at once; any other address is confirmed once, on the desktop, with its key and its allowance, and the
 * button says so (「用 Touch ID 保存」). It is the one form of every frame (the settings dialog, the in-place panel), with
 * the same labels and save words; only the frame differs.
 *
 * On a device with 管理 that is not this Mac, a service that needs a key saves here without it (the key is typed later on
 * the Mac); the in-place panel does not open the form for such a service and sends the person to the Mac instead
 * (`ProviderSetupPanel`), because a session cannot use the service before the key is there.
 */
export function ProviderAddForm({
  preset,
  data,
  abilities,
  onConfirmed,
  onSaved,
  onCancel,
  compact = false,
  computer = 'Mac',
  footer,
  onBusy,
  additionOwner,
}: {
  compact?: boolean
  /** The Host computer's name, for the lines that send another device there (`computerName`). */
  computer?: string
  /** Where the sheet wants 取消 and 保存, in its own footer. */
  footer?: HTMLElement | null
  /** A save is on its way: closing the form now would hide its failure, or its success after the person thought it cancelled. */
  onBusy?: (busy: boolean) => void
  additionOwner?: string
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
  const [addition, setAddition] = useState(() => providerAddition(additionOwner))
  const [guide, setGuide] = useState('')
  const manual = useRef<HTMLInputElement>(null)
  const requiresKey = preset.requiresKey
  const customKind = preset.id === 'custom' || !preset.baseURL
  const protocols = protocolChoices(preset)
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
      setError(SERVICE_FORM.needAddress)
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
      setError(customKind ? SERVICE_FORM.needNameAndAddress : SERVICE_FORM.needAddress)
      return
    }
    if (requiresKey && !typedKey && keyEditable) {
      setError(SERVICE_FORM.needKey)
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
        setGuide(listed.length === 0 ? COPY.manualModelFirst : COPY.foundDefault(listed.length))
        return
      }
      chosen = listed
      choice = listed[0]!
      setModels(listed)
      setDefaultModel(choice)
    }
    setSaving(true)
    const body: NewProvider = {
      name,
      kind,
      presetId: preset.id,
      baseURL,
      models: chosen,
      defaultModel: choice,
      modelCapabilities: Object.fromEntries(
        chosen.flatMap(model => {
          const contextTokens = probe.listedContextOf(model)
          return contextTokens === undefined ? [] : [[model, { contextTokens }]]
        }),
      ),
      ...(typedKey ? { apiKey: typedKey } : {}),
      ...(abilities.confirm ? { confirmOrigin: true } : {}),
    }
    const input = additionOwner ? rememberProviderAddition(additionOwner, preset.id, body) : body
    try {
      const provider = await createProvider(input, { presenter })
      if (additionOwner) clearProviderAddition(additionOwner)
      // A check right after saving is a model listing: not when the form already showed there is none, nor without a key.
      onSaved(provider, !listingFailed && !missingKey(provider, data.presets))
    } catch (cause) {
      if (additionOwner && isUncertain(cause)) setAddition(providerAddition(additionOwner))
      else if (additionOwner) clearProviderAddition(additionOwner)
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
  const note = addressNote(destination, abilities, localTarget, computer)
  const failure = probe.failure
  const listingFailed =
    failure === null || failure.kind === 'local'
      ? undefined
      : failure.kind === 'key' && !keyEditable && requiresKey
        ? COPY.listingNeedsKey(PROVIDER_COPY.keyElsewhere(computer))
        : failure.text
  const keyElsewhere = abilities.keys
    ? offlineText(abilities)
    : requiresKey
      ? PROVIDER_COPY.keyAfterSave(computer)
      : PROVIDER_COPY.keyElsewhere(computer)
  // The picker can live inside the composer's form. Its compact panel must not nest another native form there.
  const Form = compact ? 'div' : 'form'
  const formId = useId()
  const recover = async (retry: boolean) => {
    if (!addition || !additionOwner) return
    setSaving(true)
    setSubmitting(true)
    setError('')
    try {
      const input = retry ? previousProviderInput(additionOwner) : undefined
      const result = input
        ? { state: 'saved' as const, provider: await createProvider(input, { presenter }) }
        : await api<{ state: 'unknown' } | { state: 'saved'; provider: ProviderSettings }>(`providers/additions/${addition.requestId}`, {
            method: 'POST',
            body: {},
          })
      if (result.state === 'saved') {
        clearProviderAddition(additionOwner)
        setAddition(undefined)
        onSaved(result.provider, false)
      } else setError(COPY.noReceipt)
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'provider-changed') {
        clearProviderAddition(additionOwner)
        setAddition(undefined)
      }
      setError(inlineError(cause))
    } finally {
      setSaving(false)
      setSubmitting(false)
    }
  }
  /** The check is a listing, so what it finds fills the list at once instead of asking for a second press. */
  const checkAndTake = async () => {
    const listed = await probe.runCheck()
    if (listed) probe.setFetched(listed)
    take(listed)
  }
  const actions = (
    <>
      <Button size="md" disabled={saving} onClick={onCancel}>
        {COPY.cancel}
      </Button>
      <Button
        size="md"
        type={compact ? 'button' : 'submit'}
        form={compact ? undefined : formId}
        onClick={compact ? () => void save() : undefined}
        variant="primary"
        icon={locked ? LockGlyph : undefined}
        disabled={busy}
        loading={saving}
        loadingLabel={waiting ? PROVIDER_COPY.waitingTouchID : COPY.saving}>
        {locked ? PROVIDER_COPY.saveWithTouchID : PROVIDER_COPY.save}
      </Button>
    </>
  )
  if (addition && additionOwner)
    return (
      <div className="provider-add provider-add-inline">
        <InlineNotice tone="neutral">{COPY.addUnknown}</InlineNotice>
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
        <InlineConfirm active={saving} rank={2} />
        <div className="settings-actions">
          <Button disabled={saving} onClick={() => void recover(false)}>
            {COPY.verifyResult}
          </Button>
          {previousProviderInput(additionOwner) && (
            <Button loading={saving} onClick={() => void recover(true)}>
              {COPY.retryRequest}
            </Button>
          )}
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => {
              clearProviderAddition(additionOwner)
              setAddition(undefined)
              setError('')
            }}>
            {COPY.letGo}
          </Button>
        </div>
      </div>
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
            label={COPY.name}
            value={name}
            maxLength={80}
            autoComplete="off"
            onChange={event => {
              setName(event.target.value)
            }}
          />
        )}
        {protocols.length > 1 && (
          <label className="field">
            <span>{COPY.protocol}</span>
            <select
              value={kind}
              onChange={event => {
                const next = protocols.find(item => item === event.target.value)
                if (next) setKind(next)
                probe.reset()
              }}>
              {protocols.map(item => (
                <option key={item} value={item}>
                  {providerKindLabels[item]}
                </option>
              ))}
            </select>
          </label>
        )}
        <TextField
          label={SERVICE_FORM.address}
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
            label={SERVICE_FORM.key}
            type="password"
            value={apiKey}
            placeholder={requiresKey ? COPY.enterKey : COPY.localKey}
            autoComplete="new-password"
            hint={requiresKey ? undefined : COPY.optional}
            onChange={event => {
              setApiKey(event.target.value)
              probe.reset()
            }}
          />
        ) : (
          <p className="settings-caption">
            <Icon icon={LockGlyph} size={14} />
            <span>{keyElsewhere}</span>
          </p>
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
          elsewhere={abilities.offline ? offlineText(abilities) : COPY.confirmThere(computer)}
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

/**
 * One model's context length in tokens, typed as a number: saved when it is left or Enter is pressed, cleared when
 * emptied. A value outside the Host's bounds goes back to the saved one.
 */
function ContextField({
  model,
  value,
  disabled,
  onChange,
}: {
  model: string
  value: number | undefined
  disabled: boolean
  onChange: (contextTokens: number | undefined) => void
}) {
  const [text, setText] = useState(value === undefined ? '' : String(value))
  useEffect(() => {
    setText(value === undefined ? '' : String(value))
  }, [value])
  const commit = () => {
    const trimmed = text.trim().replace(/[,_\s]/gu, '')
    if (trimmed === '') {
      if (value !== undefined) onChange(undefined)
      return
    }
    const parsed = /^[0-9]{1,9}$/u.test(trimmed) ? Number(trimmed) : Number.NaN
    if (!Number.isSafeInteger(parsed) || parsed < MIN_CONTEXT_TOKENS || parsed > MAX_CONTEXT_TOKENS) {
      setText(value === undefined ? '' : String(value))
      return
    }
    if (parsed !== value) onChange(parsed)
  }
  return (
    <input
      className="ui-input model-context"
      inputMode="numeric"
      aria-label={COPY.modelContext(model)}
      title={COPY.contextTokens}
      placeholder={COPY.context}
      value={text}
      disabled={disabled}
      onChange={event => {
        setText(event.target.value)
      }}
      onBlur={commit}
      onKeyDown={event => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        }
      }}
    />
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
      label={COPY.modelThinking(model)}
      size="xs"
      value={current}
      valueText={current === NO_THINKING ? COPY.thinkingDefault : COPY.thinking(thinkingSetText(levels!))}
      options={[
        { value: NO_THINKING, label: COPY.default },
        ...offered.map(set => ({ value: set.join(' '), label: thinkingSetText(set) })),
      ]}
      header={{ title: COPY.thinkingOptions }}
      width="sm"
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
export function ProviderPage({
  admin,
  configReady,
  targetBlocked,
  onTargetError,
  supportsAttachments,
  provider,
  data,
  abilities,
  isDefault,
  checkOnOpen,
  fetchOnOpen,
  computer,
  onProbed,
  onSaved,
  onDeleted,
}: {
  admin: boolean
  configReady: boolean
  targetBlocked: string | undefined
  onTargetError: (cause: unknown) => void
  supportsAttachments?: boolean
  /** The Host computer's name, for the lines that send another device there. */
  computer: string
  provider: SupportedProvider
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
  const [fallbacksFor, setFallbacksFor] = useState<string | null>(null)
  const [pricesFor, setPricesFor] = useState<string | null>(null)
  if (!admin && pricesFor !== null) setPricesFor(null)
  const spending = useModelSpend(true, provider.id)
  const prices = spending.spend?.prices.filter(item => item.providerId === provider.id) ?? []
  // The switch moves at once and goes back if the Host refuses.
  const [enabled, setEnabled] = useState(provider.enabled)
  const [seen, setSeen] = useState(provider.enabled)
  if (seen !== provider.enabled) {
    setSeen(provider.enabled)
    setEnabled(provider.enabled)
  }
  const unconfirmed = isUnconfirmed(provider)
  const keyless = missingKey(provider, data.presets)
  const keyEditable = targetBlocked === undefined && abilities.keys && !(unconfirmed && abilities.offline)
  const preset = data.presets.find(item => item.id === provider.presetId)
  const requiresKey = preset?.requiresKey ?? false
  const protocols = protocolChoices(preset, provider.kind)
  const declaresThinking = Object.values(provider.modelCapabilities ?? {}).some(capabilities => capabilities.thinking?.length)
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
    if (!configReady || !checkOnOpen || unconfirmed || keyless || checked.current) return
    checked.current = true
    void probe.runCheck()
  }, [configReady, checkOnOpen, unconfirmed, keyless, probe])

  const fetched = useRef(false)
  useEffect(() => {
    if (!configReady || !fetchOnOpen || unconfirmed || keyless || fetched.current) return
    fetched.current = true
    void probe.fetchModels()
  }, [configReady, fetchOnOpen, unconfirmed, keyless, probe])

  /** One change; a confirmation, when the Host asks for one, resends the identical body. Returns the error. */
  const update = async (body: Record<string, unknown>): Promise<string> => {
    if (targetBlocked !== undefined && changesProviderTarget(body)) return targetBlocked
    setSaving(true)
    setError('')
    try {
      onSaved(await updateProvider(provider, body, { presenter }))
      return ''
    } catch (cause) {
      onTargetError(cause)
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
      setError(COPY.keepOne)
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
  const confirmLabel = unconfirmed && abilities.confirm ? COPY.saveTouchID : COPY.save
  const scope = origin ? shownAddress(origin) : undefined
  const newKeyScope = keyScopeOf(provider.baseURL)
  const keyCaption = keyEditable
    ? undefined
    : abilities.offline
      ? PROVIDER_COPY.keyOffline(provider.id)
      : requiresKey || provider.hasKey
        ? PROVIDER_COPY.keyElsewhere(computer)
        : undefined
  return (
    <>
      <SectionHeading
        title={provider.name}
        description={
          <>
            {isDefault ? COPY.defaultService(providerKindLabels[provider.kind]) : providerKindLabels[provider.kind]}
            <HealthLine health={provider.health} />
          </>
        }
        action={
          <Button
            disabled={busy}
            onClick={() => {
              setDialog('name')
            }}>
            {COPY.rename}
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
                icon={LockGlyph}
                disabled={busy || targetBlocked !== undefined}
                tooltip={targetBlocked}
                loading={saving}
                loadingLabel={waiting ? PROVIDER_COPY.waitingTouchID : COPY.confirming}
                onClick={confirmHere}>
                {PROVIDER_COPY.confirmAddress}
              </Button>
            ) : undefined
          }>
          {abilities.confirm ? (
            <Hint label={PROVIDER_COPY.unconfirmedNote.label}>{PROVIDER_COPY.unconfirmedNote.detail}</Hint>
          ) : abilities.offline ? (
            offlineText(abilities, provider.id)
          ) : (
            PROVIDER_COPY.confirmElsewhere(provider.name, computer)
          )}
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
                {COPY.setKeyEllipsis}
              </Button>
            ) : undefined
          }>
          {keyEditable ? undefined : (targetBlocked ?? PROVIDER_COPY.missingKeyElsewhere(provider.name, computer))}
        </InlineNotice>
      )}
      <InlineConfirm active={saving} rank={1} />
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <SettingsGroup title={COPY.connection} caption={targetBlocked}>
        <SwitchRow
          className="settings-row"
          title={COPY.enable}
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
          title={SERVICE_FORM.address}
          description={<MiddleEllipsis text={provider.baseURL} className="settings-mono" />}
          trailing={
            <Button
              variant="ghost"
              disabled={busy || targetBlocked !== undefined}
              tooltip={targetBlocked}
              onClick={() => {
                setDialog('address')
              }}>
              {COPY.change}
            </Button>
          }
        />
        {protocols.length > 1 && (
          <SettingsRow
            title={COPY.protocol}
            description={declaresThinking ? COPY.clearsThinking : undefined}
            trailing={
              <ValuePicker
                label={COPY.protocol}
                value={provider.kind}
                disabled={busy || targetBlocked !== undefined}
                bleed="end"
                options={protocols.map(item => ({ value: item, label: providerKindLabels[item] }))}
                onValueChange={value => {
                  if (value !== provider.kind) {
                    probe.reset()
                    apply({ kind: value })
                  }
                }}
              />
            }
          />
        )}
        <SettingsRow
          title={COPY.concurrent}
          trailing={
            <ValuePicker
              label={COPY.concurrent}
              value={provider.maxConcurrent === undefined ? 'none' : String(provider.maxConcurrent)}
              disabled={busy}
              bleed="end"
              header={{ title: COPY.concurrentDetail }}
              options={[
                { value: 'none', label: COPY.unlimited },
                ...CONCURRENCY_CHOICES.map(count => ({ value: String(count), label: COPY.requests(count) })),
                // A saved value outside the usual steps is still shown as it is.
                ...(provider.maxConcurrent !== undefined && !CONCURRENCY_CHOICES.includes(provider.maxConcurrent)
                  ? [{ value: String(provider.maxConcurrent), label: COPY.requests(provider.maxConcurrent) }]
                  : []),
              ]}
              onValueChange={value => {
                const next = value === 'none' ? null : Number(value)
                if (next !== (provider.maxConcurrent ?? null)) apply({ maxConcurrent: next })
              }}
            />
          }
        />
        {/* 模型 is shown only to a device that may manage this Mac; the Host checks the scope again on every change. */}
        <BudgetRow scope="service" id={provider.id} spend={spending.spend} admin={admin} disabled={busy} onChanged={spending.reload} />
        <CheckRow
          busy={probe.busy === 'check'}
          disabled={busy || !configReady || unconfirmed || keyless}
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
          busy={busy || targetBlocked !== undefined}
          waiting={saving && waiting}
          actionLabel={PROVIDER_COPY.allowAgain(localTarget)}
          elsewhere={abilities.offline ? offlineText(abilities, provider.id) : PROVIDER_COPY.allowElsewhere(computer)}
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
                {COPY.removeService}
              </Button>
            ) : (
              <Button
                size="xs"
                disabled={busy}
                onClick={() => {
                  setDialog('key')
                }}>
                {provider.hasKey ? COPY.replaceKeyEllipsis : COPY.setKeyEllipsis}
              </Button>
            )
          }>
          {checkFailure.text}
        </InlineNotice>
      )}
      <SettingsGroup
        title={COPY.key}
        caption={keyCaption}
        captionIcon="lock"
        note={keyEditable ? <NoteLine icon={LockGlyph} brief={PROVIDER_COPY.keyHeld} /> : undefined}>
        <SettingsRow
          leading={<IconTile icon={provider.hasKey ? KeyRound : LockGlyph} />}
          title={provider.hasKey ? COPY.savedKey : COPY.notSet}
          description={provider.hasKey && scope ? COPY.sentTo(scope) : requiresKey ? COPY.keyRequired : COPY.localKey}
          trailing={
            keyEditable ? (
              <Button
                disabled={busy}
                onClick={() => {
                  setDialog('key')
                }}>
                {provider.hasKey ? COPY.replace : COPY.setKeyEllipsis}
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
        fetchBlocked={unconfirmed ? COPY.addressBeforeFetch : keyless ? COPY.keyBeforeFetch : undefined}
        onFetch={() => {
          void probe.fetchModels()
        }}
        onDefault={model => {
          apply({ defaultModel: model })
        }}
        onRemove={removeModel}
        onAdd={model => {
          const contextTokens = probe.listedContextOf(model)
          apply({
            models: [...provider.models, model],
            ...(contextTokens !== undefined && provider.modelCapabilities?.[model]?.contextTokens === undefined
              ? { modelCapabilities: withCapability(provider.modelCapabilities, model, { contextTokens }) }
              : {}),
          })
        }}
        onContext={(model, contextTokens) => {
          apply({ modelCapabilities: withCapability(provider.modelCapabilities, model, { contextTokens }) })
        }}
        fallbacks={provider.fallbacks}
        services={data.providers}
        onFallbacks={setFallbacksFor}
        priced={new Set(prices.map(item => item.model))}
        {...(admin && spending.spend ? { onPrices: setPricesFor } : {})}
      />
      {admin && pricesFor !== null && spending.spend && (
        <PricesDialog
          key={pricesFor}
          providerId={provider.id}
          model={pricesFor}
          saved={prices.find(item => item.model === pricesFor)}
          revision={spending.spend.revision}
          disabled={busy}
          reload={spending.reload}
          onClose={() => {
            setPricesFor(null)
          }}
        />
      )}
      <ModelFallbacksDialog
        open={fallbacksFor !== null}
        provider={provider}
        model={fallbacksFor ?? provider.defaultModel}
        providers={data.providers.filter(isSupported)}
        onSubmit={list => {
          const { [fallbacksFor ?? '']: _replaced, ...others } = provider.fallbacks ?? {}
          return update({ fallbacks: list.length && fallbacksFor ? { ...others, [fallbacksFor]: list } : others })
        }}
        onClose={() => {
          setFallbacksFor(null)
        }}
      />
      <SettingsGroup>
        {provider.hasKey && (
          <SettingsRow
            title={COPY.removeKey}
            trailing={
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  setConfirm('clear-key')
                }}>
                {COPY.remove}
              </Button>
            }
          />
        )}
        <SettingsRow
          title={COPY.deleteService}
          trailing={
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                setConfirm('delete')
              }}>
              {COPY.delete}
            </Button>
          }
        />
      </SettingsGroup>
      <FieldDialog
        open={dialog === 'name'}
        title={COPY.renameService}
        label={COPY.name}
        initial={provider.name}
        maxLength={80}
        onSubmit={value => update({ name: value })}
        onClose={() => {
          setDialog(null)
        }}
      />
      <FieldDialog
        open={dialog === 'address' && targetBlocked === undefined}
        title={COPY.changeAddress}
        label={SERVICE_FORM.address}
        type="url"
        initial={provider.baseURL}
        placeholder="https://api.example.com/v1"
        warning={value => {
          const drops = provider.hasKey && keyScopeOf(value, provider.keyPath !== undefined) !== origin
          return drops ? COPY.addressRemovesKey : undefined
        }}
        onSubmit={value =>
          update({ baseURL: value, ...(abilities.confirm && destinationOf(value, data) === 'unconfirmed' ? { confirmOrigin: true } : {}) })
        }
        onClose={() => {
          setDialog(null)
        }}
      />
      <FieldDialog
        open={dialog === 'key' && keyEditable && !!newKeyScope}
        title={provider.hasKey ? COPY.replaceKey : COPY.setKey}
        subtitle={newKeyScope ? COPY.keySentTo(shownAddress(newKeyScope)) : undefined}
        label={SERVICE_FORM.key}
        type="password"
        placeholder={COPY.enterKey}
        hint={PROVIDER_COPY.keyHeld.label}
        confirmLabel={confirmLabel}
        onSubmit={value => update({ apiKey: value, ...(unconfirmed && abilities.confirm ? { confirmOrigin: true } : {}) })}
        onClose={() => {
          setDialog(null)
        }}
      />
      {confirm === 'clear-key' && (
        <ConfirmDialog
          title={COPY.removeKey}
          danger
          confirmLabel={COPY.remove}
          message={COPY.confirmRemoveKey(provider.name)}
          onClose={() => {
            setConfirm(null)
          }}
          onConfirm={async () => {
            const text = await update({ apiKey: null })
            if (text) throw new MessageError(text)
          }}
        />
      )}
      {confirm === 'delete' && (
        <ConfirmDialog
          title={COPY.deleteModelService}
          danger
          confirmLabel={COPY.delete}
          message={COPY.confirmDelete(provider.name)}
          onClose={() => {
            setConfirm(null)
          }}
          onConfirm={async () => {
            try {
              await api(`providers/${encodeURIComponent(provider.id)}`, { method: 'DELETE' })
            } catch (cause) {
              throw new MessageError(errorMessage(cause), { cause })
            }
            onDeleted()
          }}
        />
      )}
    </>
  )
}

export function ProviderAddContent({
  preset,
  data,
  abilities,
  computer,
  footer,
  committing,
  onPick,
  onConfirmed,
  onSaved,
  onCancel,
  onBusy,
}: {
  preset: ProviderPreset | null
  data: ProvidersResponse
  abilities: ProviderAbilities
  computer: string
  footer: HTMLElement | null
  committing: boolean
  onPick: (preset: ProviderPreset) => void
  onConfirmed: (address: string) => void
  onSaved: (provider: ProviderSettings) => void
  onCancel: () => void
  onBusy: (busy: boolean) => void
}) {
  return (
    <div className="provider-sheet">
      <PresetGrid presets={data.presets} chosen={preset?.id} disabled={committing} onPick={onPick} />
      {preset && (
        <ProviderAddForm
          key={preset.id}
          preset={preset}
          data={data}
          abilities={abilities}
          computer={computer}
          footer={footer}
          onBusy={onBusy}
          onConfirmed={onConfirmed}
          onSaved={onSaved}
          onCancel={onCancel}
        />
      )}
    </div>
  )
}
