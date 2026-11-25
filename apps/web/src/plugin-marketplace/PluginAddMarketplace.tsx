import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import {
  containsSecret,
  type PluginNpmPreview,
  type PluginNpmStage,
  type PluginPackageDetail,
  type PluginPackageSummary,
} from '@latch/protocol'
import { Button, ConfirmDialog, InlineNotice, TextField } from '@latch/ui'
import { ArrowLeft } from 'lucide-react'
import { InlineConfirm } from '../components/InlineConfirm.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { api, inlineError, newRequestId, type ApiOptions } from '../core/api.ts'
import { withConfirmation } from '../core/confirmations.ts'
import { defineCopy } from '../core/i18n.ts'
import { Loading, SettingsGroup, SettingsRow } from '../settings/common.tsx'
import { isPluginPackageReview, PluginRiskFacts, PluginSourceText } from '../settings/PluginMutationReview.tsx'
import { downloadPluginBundle } from '../settings/pluginAssets.ts'
import { PluginExternalMarketplace, usePluginExternalMarketplace } from './PluginExternalMarketplace.tsx'
import { pluginAddInput } from './pluginAddInput.ts'
import { PluginFallbackCover, PluginMarketIcon } from './PluginArtwork.tsx'
import {
  dataObject,
  digest,
  forgetReceipt,
  marketRequest,
  receipt,
  receiptUnsettled,
  rememberPending,
  useMarketReceipt,
  useMarketWriteScope,
} from './marketReceipts.ts'

const COPY = defineCopy(
  {
    source: 'npm 源',
    sourceLoading: '正在读取 npm 源…',
    noSource: '尚未配置 npm 源',
    find: '从外部来源添加插件',
    input: 'npm 包名、GitHub 地址或文件夹路径',
    npmInput: 'npm 包名',
    findHint: '例如 @team/plugin@1.2.3、https://github.com/team/plugins 或 ~/Projects/plugins。',
    npmFindHint: '例如 @team/plugin@1.2.3。省略版本时查找最新稳定版。',
    inputInvalid: '输入 npm 包名、GitHub 仓库地址，或这台 Mac 上的绝对路径。',
    inputNpmInvalid: '输入 npm 包名，可在包名后加确切版本。',
    npmUnavailable: '当前工作台无法从 npm 添加插件。',
    configure: '配置 npm 源',
    registry: 'npm 源地址',
    registryHint: '填写 npm 源的 HTTPS 地址，可以包含镜像的路径前缀。保存新地址时需要在这台 Mac 上确认。',
    invalidRegistry: '使用不带用户名、密码、查询参数或片段的 HTTPS 地址。',
    official: '使用 npm 官方源',
    mirror: '使用 npmmirror 镜像',
    custom: '填写自定义地址',
    save: '保存来源',
    disable: '停用来源',
    cancel: '取消',
    retry: '重试',
    lookup: '查找',
    back: '返回查找',
    backInstalled: '返回已安装',
    switchRegistry: '切换 npm 源',
    loading: '正在读取插件版本…',
    downloaded: '已下载的 npm 插件',
    external: '从 GitHub 或文件夹添加的插件',
    downloadedVersion: (version: string) => `已下载 v${version}`,
    installedVersion: (version: string) => `已安装 v${version}`,
    draftVersion: (version: string) => `草稿 v${version}`,
    availableVersion: (version: string) => `可更新到 v${version}`,
    checkUpdate: '检查更新',
    same: '此来源没有更高版本。',
    modified: '草稿有本地改动。可以先导出备份，或打开现有草稿审阅。',
    exportDraft: '导出本地草稿',
    draftChanged: '这份草稿已有变化，请重新检查更新。',
    replace: '替换本地草稿',
    replaceConfirm: '确认替换草稿',
    replaces: (version: string, name: string) =>
      `用 npm 上的 ${name} ${version} 替换当前草稿会丢弃这份草稿的本地修改。已经应用的版本会继续使用。`,
    switchSource: '切换回下载此插件时使用的 npm 源，即可检查更新。',
    conflict: '这台 Mac 上的另一份插件已使用此标识。',
    active: '已启用',
    earlierActive: '较早版本仍在使用',
    disabled: '已停用',
    unreviewed: '尚未应用',
    details: '包详细信息',
    preview: '版本预览',
    identity: '安装标识',
    digest: '仓库提供的包摘要',
    savedVersion: '已保存草稿版本',
    install: '下载为草稿',
    stageUpdate: '下载更新草稿',
    review: '审阅草稿',
    reviewLocal: '查看已有插件',
    staged: '草稿已保存。审阅并应用后才会使用新版本。',
    unknown: '暂时不知道这次操作是否完成。可重试同一请求。',
    retrySame: '重试同一请求',
  },
  {
    source: 'npm registry',
    sourceLoading: 'Reading npm registry…',
    noSource: 'No npm registry configured',
    find: 'Add from an external source',
    input: 'npm package name, GitHub URL, or folder path',
    npmInput: 'npm package name',
    findHint: 'For example, @team/plugin@1.2.3, https://github.com/team/plugins, or ~/Projects/plugins.',
    npmFindHint: 'For example, @team/plugin@1.2.3. Omit the version for the latest stable release.',
    inputInvalid: 'Enter an npm package name, a GitHub repository URL, or an absolute path on this Mac.',
    inputNpmInvalid: 'Enter an npm package name. You can append an exact version.',
    npmUnavailable: 'This workbench can’t add plugins from npm.',
    configure: 'Configure npm registry',
    registry: 'npm registry URL',
    registryHint: 'Enter the registry’s HTTPS URL, including its path prefix if needed. Confirm a new address on this Mac.',
    invalidRegistry: 'Use an HTTPS URL without a username, password, query or fragment.',
    official: 'Use official npm registry',
    mirror: 'Use npmmirror',
    custom: 'Enter a custom address',
    save: 'Save registry',
    disable: 'Disable registry',
    cancel: 'Cancel',
    retry: 'Retry',
    lookup: 'Find',
    back: 'Back to search',
    backInstalled: 'Back to installed plugins',
    switchRegistry: 'Switch npm registry',
    loading: 'Reading plugin release…',
    downloaded: 'Downloaded npm plugins',
    external: 'Plugins added from GitHub or a local folder',
    downloadedVersion: (version: string) => `Downloaded v${version}`,
    installedVersion: (version: string) => `Installed v${version}`,
    draftVersion: (version: string) => `Draft v${version}`,
    availableVersion: (version: string) => `Update to v${version} available`,
    checkUpdate: 'Check for update',
    same: 'This source has no newer release.',
    modified: 'This draft has local edits. Export a backup or open the existing draft for review.',
    exportDraft: 'Export local draft',
    draftChanged: 'The local draft has changed. Check for updates again.',
    replace: 'Replace local draft',
    replaceConfirm: 'Confirm draft replacement',
    replaces: (version: string, name: string) =>
      `Replacing the draft with ${name} ${version} from npm discards its local edits. The applied version stays active.`,
    switchSource: 'Switch back to the registry this plugin was downloaded from to check for updates.',
    conflict: 'Another local plugin already uses this ID.',
    active: 'Enabled',
    earlierActive: 'Earlier version is still active',
    disabled: 'Disabled',
    unreviewed: 'Awaiting application',
    details: 'Package details',
    preview: 'Version preview',
    identity: 'Plugin ID',
    digest: 'Registry package digest',
    savedVersion: 'Saved draft version',
    install: 'Download as draft',
    stageUpdate: 'Download update draft',
    review: 'Review draft',
    reviewLocal: 'View local plugin',
    staged: 'Draft saved. Review and apply it to start using the new version.',
    unknown: 'The outcome is unknown. You can retry the same request.',
    retrySame: 'Retry same request',
  },
)

interface Lookup {
  name: string
  version?: string
  pluginId?: string
}
interface RegistryChange {
  registry: string | null
  baseRegistry: string | null
  baseRevision: string
  requestId: string
}
interface RegistryState {
  registry: string | null
  revision: string
}

const ROUTE = 'plugin-packages/npm'
const OFFICIAL = 'https://registry.npmjs.org/'
const MIRROR = 'https://registry.npmmirror.com/'

function registryAddress(input: string): string | undefined {
  try {
    const url = new URL(input)
    if (
      input.length > 512
      || !/^https:\/\/[A-Za-z0-9.[\]:-]+(?:\/[A-Za-z0-9._~-]+)*\/?$/iu.test(input)
      || /\/\.{1,2}(?:\/|$)/u.test(input)
      || url.hostname.endsWith('.')
      || containsSecret(input)
    )
      return undefined
    return url.href.endsWith('/') ? url.href : url.href + '/'
  } catch {
    return undefined
  }
}

const registryValue = (value: unknown): boolean => typeof value === 'string' && registryAddress(value) === value
const maybeRegistry = (value: unknown): boolean => value === null || registryValue(value)

function validRegistryChange(value: unknown): value is RegistryChange {
  return (
    dataObject(value)
    && Object.keys(value).length === 4
    && receipt(value.requestId)
    && digest(value.baseRevision)
    && maybeRegistry(value.registry)
    && maybeRegistry(value.baseRegistry)
  )
}

function validStage(value: unknown): value is PluginNpmStage {
  if (!dataObject(value) || !receipt(value.requestId) || !digest(value.revision)) return false
  const { release, update } = value
  if (
    !dataObject(release)
    || Object.keys(release).length !== 4
    || !registryValue(release.registry)
    || typeof release.name !== 'string'
    || release.name.length > 214
    || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(release.name)
    || containsSecret(release.name)
    || typeof release.version !== 'string'
    || !/^[0-9][0-9A-Za-z.+-]{0,63}$/u.test(release.version)
    || containsSecret(release.version)
    || typeof release.integrity !== 'string'
    || !/^sha512-[A-Za-z0-9+/]{85}[AQgw]==$/u.test(release.integrity)
  )
    return false
  return update === undefined
    ? Object.keys(value).length === 3
    : Object.keys(value).length === 4
        && dataObject(update)
        && Object.keys(update).length === (update.replaceLocalDraft === true ? 4 : 3)
        && typeof update.pluginId === 'string'
        && /^[A-Za-z0-9_-]{1,64}$/u.test(update.pluginId)
        && typeof update.installId === 'string'
        && /^[A-Za-z0-9_-]{22}$/u.test(update.installId)
        && digest(update.baseRevision)
}

export function usePluginAddMarketplace({
  active,
  installedView = false,
  connected = true,
  editable,
  npmEnabled,
  externalEnabled,
  storageKey,
  records,
  onStage,
  onManage,
  onReview,
}: {
  active: boolean
  installedView?: boolean
  connected?: boolean
  editable: boolean
  npmEnabled: boolean
  externalEnabled: boolean
  storageKey: string
  records: readonly PluginPackageSummary[]
  onStage: () => void
  onManage: (id: string) => void
  /** Reviews and applies a draft just saved here, without leaving the marketplace. */
  onReview: (id: string) => void
}) {
  const sourceKey = `${storageKey}:source`
  const stageKey = `${storageKey}:stage`
  const writeSignal = useMarketWriteScope(storageKey, editable && connected)
  const [registryState, setRegistryState] = useState<RegistryState>()
  const registry = registryState?.registry
  const [registryError, setRegistryError] = useState('')
  const [sourceRetry, setSourceRetry] = useState(0)
  const [sourcePending, setSourcePending] = useMarketReceipt(sourceKey, editable && npmEnabled, validRegistryChange)
  const [showConfiguration, setConfiguring] = useState(false)
  const configuring = showConfiguration || sourcePending !== null
  const [address, setAddress] = useState('')
  const [sourceBusy, setSourceBusy] = useState(false)
  const [sourceFailure, setSourceFailure] = useState('')
  const [searchText, setSearchText] = useState('')
  const needle = pluginAddInput(searchText)
  const [preview, setPreview] = useState<{ value: PluginNpmPreview; lookup: Lookup } | null>(null)
  const [lastLookup, setLastLookup] = useState<Lookup | null>(null)
  const [checkedUpdates, setCheckedUpdates] = useState<Record<string, { registry: string; revision: string; version: string }>>({})
  const [loading, setLoading] = useState(false)
  const [lookupError, setLookupError] = useState('')
  const [stageBusy, setStageBusy] = useState(false)
  const [stagePending, setStagePending] = useMarketReceipt(stageKey, editable && npmEnabled, validStage)
  const [stageError, setStageError] = useState('')
  const [stagedId, setStagedId] = useState<string | null>(null)
  const [replacement, setReplacement] = useState<PluginNpmStage | null>(null)
  const [exporting, setExporting] = useState(false)
  const mounted = useRef(false)
  const controlId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const registryTrigger = useRef('configure')
  const external = usePluginExternalMarketplace({
    active,
    connected,
    editable: editable && externalEnabled,
    storageKey: storageKey + ':external-stage',
    onStage,
  })
  const view = configuring ? 'registry' : preview ? 'preview' : 'browse'
  const lastView = useRef(view)
  const previewRequest = useRef<AbortController | null>(null)
  const previousInstalledView = useRef(installedView)
  // A lookup belongs to its list. Pending writes keep their original Host and device receipt across both lists.
  useLayoutEffect(() => {
    if (previousInstalledView.current === installedView) return
    previousInstalledView.current = installedView
    previewRequest.current?.abort()
    external.clear()
    setPreview(null)
    setLastLookup(null)
    setLoading(false)
    setLookupError('')
    setStageError('')
    setStagedId(null)
    setReplacement(null)
    setConfiguring(false)
    lastView.current = 'browse'
  })
  useEffect(() => {
    if (active && lastView.current !== view) {
      const trigger =
        lastView.current === 'registry' ? registryTrigger.current : lastLookup?.pluginId ? 'update-' + lastLookup.pluginId : 'find'
      const target = view === 'browse' ? document.getElementById(controlId + '-' + trigger) : heading.current
      const focus = target ?? heading.current
      focus?.focus({ preventScroll: true })
    }
    lastView.current = view
  }, [active, controlId, lastLookup, view])
  useEffect(() => {
    if (!active || !connected) setReplacement(null)
  }, [active, connected])
  useEffect(() => {
    if (active && connected && editable && npmEnabled) return
    previewRequest.current?.abort()
    setLoading(false)
  }, [active, connected, editable, npmEnabled])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      previewRequest.current?.abort()
    }
  }, [])

  const needsRegistry = npmEnabled && (!installedView || configuring || records.some(record => record.npm && record.appliedRevision))
  useEffect(() => {
    if (!active || !editable || !needsRegistry || !connected) return
    const abort = new AbortController()
    setRegistryError('')
    void api<RegistryState>(`${ROUTE}/registry`, { signal: abort.signal }).then(
      result => {
        if (!abort.signal.aborted) {
          setRegistryState(result)
          setPreview(current => (current?.value.release.registry === result.registry ? current : null))
        }
      },
      cause => {
        if (!abort.signal.aborted) {
          setRegistryState(undefined)
          setRegistryError(inlineError(cause))
        }
      },
    )
    return () => abort.abort()
  }, [active, connected, editable, needsRegistry, sourceRetry])

  const configure = async (change: RegistryChange) => {
    const signal = writeSignal()
    if (!active || !signal || !npmEnabled || sourceBusy) return
    const request = <T,>(path: string, options?: ApiOptions) => marketRequest<T>(signal, path, options)
    setSourceBusy(true)
    setSourceFailure('')
    rememberPending(sourceKey, change)
    try {
      const result = await withConfirmation(
        confirmation =>
          request<RegistryState>(`${ROUTE}/registry`, {
            method: 'PUT',
            body: change,
            ...(confirmation ? { confirmation } : {}),
          }),
        { signal, api: request },
      )
      forgetReceipt(sourceKey, change.requestId)
      if (mounted.current) {
        setRegistryState(result)
        setConfiguring(false)
        setSourcePending(null)
        setPreview(null)
        setLookupError('')
        setStageError('')
      }
    } catch (cause) {
      const uncertain = signal.aborted || receiptUnsettled(cause, sourcePending?.requestId === change.requestId)
      if (!uncertain) forgetReceipt(sourceKey, change.requestId)
      if (mounted.current) {
        setSourcePending(uncertain ? change : null)
        if (!signal.aborted) setSourceFailure(inlineError(cause))
        if (!uncertain) setSourceRetry(current => current + 1)
      }
    } finally {
      if (mounted.current) setSourceBusy(false)
    }
  }

  const lookup = async (input: Lookup) => {
    if (!active || !editable || !npmEnabled || !connected) return
    external.clear()
    previewRequest.current?.abort()
    const abort = new AbortController()
    previewRequest.current = abort
    setLastLookup(input)
    setPreview(null)
    setStagedId(null)
    setLookupError('')
    setStageError('')
    setLoading(true)
    try {
      const value = await api<PluginNpmPreview>(`${ROUTE}/preview`, {
        method: 'POST',
        body: input,
        signal: abort.signal,
        timeoutMs: 45_000,
      })
      if (!abort.signal.aborted) {
        setPreview({ value, lookup: input })
        const { installed, release } = value
        const pluginId = input.pluginId
        if (pluginId && installed && installed.id === pluginId) {
          setCheckedUpdates(current => {
            const next = { ...current }
            if (value.updateAvailable)
              next[pluginId] = { registry: release.registry, revision: installed.revision, version: release.version }
            else delete next[pluginId]
            return next
          })
        }
      }
    } catch (cause) {
      if (!abort.signal.aborted) setLookupError(inlineError(cause))
    } finally {
      if (!abort.signal.aborted) setLoading(false)
    }
  }
  const changeRegistry = (next: string | null) => {
    if (!connected || !registryState || sourceBusy || sourcePending) return
    void configure({
      registry: next,
      baseRegistry: registryState.registry,
      baseRevision: registryState.revision,
      requestId: newRequestId(),
    })
  }

  const stage = async (input: PluginNpmStage) => {
    const signal = writeSignal()
    if (!active || !signal || !npmEnabled || stageBusy) return
    setStageBusy(true)
    setStageError('')
    rememberPending(stageKey, input)
    try {
      const { package: record } = await marketRequest<{ package: PluginPackageDetail }>(signal, `${ROUTE}/stage`, {
        method: 'POST',
        body: input,
        timeoutMs: 45_000,
      })
      forgetReceipt(stageKey, input.requestId)
      if (mounted.current) {
        setStagePending(null)
        setPreview(null)
        setStagedId(record.id)
        setSearchText('')
        onStage()
      }
    } catch (cause) {
      const uncertain = signal.aborted || receiptUnsettled(cause, stagePending?.requestId === input.requestId)
      if (!uncertain) forgetReceipt(stageKey, input.requestId)
      if (mounted.current) {
        setStagePending(uncertain ? input : null)
        if (!signal.aborted) setStageError(inlineError(cause))
      }
    } finally {
      if (mounted.current) setStageBusy(false)
    }
  }

  const locked =
    !connected || loading || stageBusy || stagePending !== null || external.loading || external.busy || external.pending !== null
  const npmRecords = npmEnabled ? records.filter(record => record.npm !== undefined) : []
  const externalRecords = externalEnabled ? records.filter(record => record.external !== undefined) : []
  const installed = preview?.value.installed
  const manifest = preview?.value.bundle.manifest
  const release = preview?.value.release
  const review = preview && isPluginPackageReview(preview.value.review, preview.value.revision) ? preview.value.review : null
  const checkingUpdate = preview?.lookup.pluginId !== undefined
  const newerRelease = checkingUpdate && preview?.value.updateAvailable === true
  const exportDraft = async (id: string, revision: string) => {
    if (!connected) return
    setExporting(true)
    setStageError('')
    try {
      const { package: record } = await api<{ package: PluginPackageDetail }>(`plugin-packages/${encodeURIComponent(id)}`)
      if (!mounted.current) return
      if (record.revision !== revision) setStageError(COPY.draftChanged)
      else downloadPluginBundle(record.id, record.bundle)
    } catch (cause) {
      if (mounted.current) setStageError(inlineError(cause))
    } finally {
      if (mounted.current) setExporting(false)
    }
  }

  if (!editable) return { sourceBusy: false, browsing: true, controls: null, content: null, updateAction: () => null }
  const download = preview && review && release && release.registry === registry && (!installed || newerRelease) && (
    <Button
      variant={installed?.modified ? 'outline' : 'primary'}
      loading={stageBusy}
      disabled={stagePending !== null}
      onClick={() => {
        const input: PluginNpmStage = {
          release,
          revision: preview.value.revision,
          requestId: newRequestId(),
          ...(installed
            ? {
                update: {
                  pluginId: installed.id,
                  baseRevision: installed.revision,
                  installId: installed.installId,
                  ...(installed.modified ? { replaceLocalDraft: true as const } : {}),
                },
              }
            : {}),
        }
        if (installed?.modified) setReplacement(input)
        else void stage(input)
      }}>
      {installed?.modified ? COPY.replace : checkingUpdate ? COPY.stageUpdate : COPY.install}
    </Button>
  )

  const browsing = !preview && !configuring && !external.found && !external.preview
  const savedId = stagedId ?? external.stagedId
  const showSaved =
    savedId
    && (!installedView
      || records.some(record => record.id === savedId && record.appliedRevision && record.appliedRevision !== record.revision))
  const askRegistry = (value: string, trigger = 'configure') => {
    registryTrigger.current = trigger
    setAddress(value)
    setSourceFailure('')
    setConfiguring(true)
  }
  const updateAction = (record: PluginPackageSummary, disabled = false) => {
    if (record.npm && npmEnabled) {
      const { name, registry: origin } = record.npm
      const current = registry === origin
      const switchRegistry = installedView && registry !== undefined && !current
      return (
        <Button
          id={controlId + '-update-' + record.id}
          disabled={disabled || locked || (!current && !switchRegistry)}
          onClick={() => (switchRegistry ? askRegistry(origin, 'update-' + record.id) : void lookup({ name, pluginId: record.id }))}>
          {switchRegistry ? COPY.switchRegistry : COPY.checkUpdate}
        </Button>
      )
    }
    if (record.external && externalEnabled)
      return (
        <Button
          id={controlId + '-external-update-' + record.id}
          disabled={disabled || locked}
          onClick={() => {
            setStagedId(null)
            setLookupError('')
            setStageError('')
            external.lookup({ pluginId: record.id })
          }}>
          {COPY.checkUpdate}
        </Button>
      )
    return null
  }
  const canFind = needle?.kind === 'npm' ? npmEnabled && !!registry : needle?.kind === 'external' && externalEnabled
  const controls = !installedView && browsing && (
    <div className="plugin-market-npm-content plugin-market-npm-controls" inert={!connected || undefined}>
      <h2 className="sr-only" ref={heading} tabIndex={-1}>
        {COPY.find}
      </h2>
      <form
        className="plugin-market-npm-form"
        onSubmit={event => {
          event.preventDefault()
          if (locked || !canFind || !needle) return
          if (needle.kind === 'external') {
            setStagedId(null)
            setLookupError('')
            setStageError('')
            external.lookup({ input: needle.input })
          } else {
            const { name, version } = needle
            void lookup({ name, ...(version ? { version } : {}) })
          }
        }}>
        <TextField
          ref={inputRef}
          label={externalEnabled ? COPY.input : COPY.npmInput}
          placeholder="@team/plugin"
          hint={externalEnabled ? COPY.findHint : COPY.npmFindHint}
          value={searchText}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          onChange={event => {
            setSearchText(event.target.value)
            setLookupError('')
            setStageError('')
            external.clear()
          }}
          disabled={locked}
        />
        <div className="plugin-market-actions">
          <Button id={controlId + '-find'} type="submit" variant="primary" disabled={!canFind || locked}>
            {COPY.lookup}
          </Button>
        </div>
      </form>
      {searchText.trim() && (!needle || (needle.kind === 'external' && !externalEnabled)) && (
        <p className="plugin-market-note">{externalEnabled ? COPY.inputInvalid : COPY.inputNpmInvalid}</p>
      )}
      {needle?.kind === 'npm' && !npmEnabled && <p className="plugin-market-note">{COPY.npmUnavailable}</p>}
      {needle?.kind === 'npm'
        && npmEnabled
        && (registryError ? (
          <InlineNotice tone="error" action={<Button onClick={() => setSourceRetry(current => current + 1)}>{COPY.retry}</Button>}>
            {registryError}
          </InlineNotice>
        ) : registry === undefined ? (
          <Loading label={COPY.sourceLoading} />
        ) : (
          <SettingsGroup>
            <SettingsRow
              className="marketplace-fact"
              title={COPY.source}
              description={registry ?? COPY.noSource}
              trailing={
                <div className="marketplace-row-actions">
                  <select
                    aria-label={COPY.source}
                    value={registry ?? ''}
                    disabled={locked}
                    onChange={event => askRegistry(event.target.value === 'custom' ? '' : event.target.value)}>
                    <option value="" disabled>
                      {COPY.noSource}
                    </option>
                    <option value={OFFICIAL}>{COPY.official}</option>
                    <option value={MIRROR}>{COPY.mirror}</option>
                    {registry && registry !== OFFICIAL && registry !== MIRROR && <option value={registry}>{registry}</option>}
                    <option value="custom">{COPY.custom}</option>
                  </select>
                  <Button id={controlId + '-configure'} disabled={locked} onClick={() => askRegistry(registry ?? '')}>
                    {COPY.configure}
                  </Button>
                </div>
              }
            />
          </SettingsGroup>
        ))}
    </div>
  )

  const content = (
    <div className="plugin-market-npm-content" inert={!connected || undefined}>
      {configuring ? (
        <form
          className="settings-form plugin-market-registry-form"
          onSubmit={event => {
            event.preventDefault()
            if (!sourceBusy && !sourcePending && registry !== undefined && address.trim()) {
              const next = registryAddress(address.trim())
              if (next) changeRegistry(next)
              else setSourceFailure(COPY.invalidRegistry)
            }
          }}>
          <h2 className="plugin-market-section-title" ref={heading} tabIndex={-1}>
            {COPY.configure}
          </h2>
          <div className="plugin-asset-actions">
            <Button size="sm" disabled={sourceBusy || sourcePending !== null} onClick={() => setAddress(OFFICIAL)}>
              {COPY.official}
            </Button>
            <Button size="sm" disabled={sourceBusy || sourcePending !== null} onClick={() => setAddress(MIRROR)}>
              {COPY.mirror}
            </Button>
          </div>
          <TextField
            type="url"
            label={COPY.registry}
            placeholder="https://registry.npmjs.org/"
            hint={COPY.registryHint}
            value={sourcePending ? (sourcePending.registry ?? '') : address}
            autoComplete="off"
            spellCheck={false}
            onChange={event => setAddress(event.target.value)}
            disabled={sourceBusy || sourcePending !== null}
          />
          <div className="plugin-asset-actions">
            <Button disabled={sourceBusy || sourcePending !== null} onClick={() => setConfiguring(false)}>
              {COPY.cancel}
            </Button>
            {registry && (
              <Button disabled={sourceBusy || sourcePending !== null} onClick={() => changeRegistry(null)}>
                {COPY.disable}
              </Button>
            )}
            <Button
              type="submit"
              variant="primary"
              loading={sourceBusy}
              disabled={!address.trim() || registry === undefined || sourcePending !== null}>
              {COPY.save}
            </Button>
          </div>
          <InlineConfirm active={active && sourceBusy} rank={2} />
          {sourceFailure && <InlineNotice tone="error">{sourceFailure}</InlineNotice>}
          {sourcePending && (
            <InlineNotice
              tone="warn"
              action={
                <Button loading={sourceBusy} onClick={() => void configure(sourcePending)}>
                  {COPY.retrySame}
                </Button>
              }>
              {COPY.unknown}
            </InlineNotice>
          )}
        </form>
      ) : (
        <>
          {externalEnabled && (
            <PluginExternalMarketplace
              external={external}
              installedView={installedView}
              disabled={!connected || stageBusy}
              onManage={onManage}
              browseFocus={() => {
                const target =
                  external.lastLookup && 'pluginId' in external.lastLookup
                    ? controlId + '-external-update-' + external.lastLookup.pluginId
                    : undefined
                requestAnimationFrame(() => {
                  const focus = (target ? document.getElementById(target) : null) ?? inputRef.current
                  focus?.focus({ preventScroll: true })
                })
              }}
            />
          )}
          {installedView && needsRegistry && registryError && (
            <InlineNotice tone="error" action={<Button onClick={() => setSourceRetry(current => current + 1)}>{COPY.retry}</Button>}>
              {registryError}
            </InlineNotice>
          )}
          {showSaved && (
            <InlineNotice action={!installedView && <Button onClick={() => onReview(savedId)}>{COPY.review}</Button>}>
              {COPY.staged}
            </InlineNotice>
          )}
          {loading && <Loading label={COPY.loading} />}
          {lookupError && (
            <InlineNotice
              tone="error"
              action={lastLookup && registry && <Button onClick={() => void lookup(lastLookup)}>{COPY.retry}</Button>}>
              {lookupError}
            </InlineNotice>
          )}
          {preview && manifest && release && (
            <>
              <header className="plugin-market-npm-preview">
                <div className="plugin-market-detail-identity">
                  {!installedView && <PluginMarketIcon id={release.name} size={24} framed />}
                  <div>
                    <p className="plugin-market-meta">{COPY.preview}</p>
                    <h2 className="plugin-market-section-title" ref={heading} tabIndex={-1}>
                      <VisibleText text={manifest.name} />
                    </h2>
                    {manifest.description && (
                      <p className="plugin-market-note">
                        <VisibleText text={manifest.description} />
                      </p>
                    )}
                  </div>
                </div>
                <Button variant="ghost" icon={ArrowLeft} disabled={stageBusy} onClick={() => setPreview(null)}>
                  {installedView ? COPY.backInstalled : COPY.back}
                </Button>
              </header>
              {!installedView && (
                <div className="plugin-market-npm-cover">
                  <PluginFallbackCover id={release.name} />
                </div>
              )}
              <PluginRiskFacts
                review={preview.value.review}
                extra={
                  installed?.version
                  && installed.version !== release.version
                  && !preview.value.review.comparison && (
                    <SettingsRow title={COPY.savedVersion} description={<VisibleText text={installed.version} />} />
                  )
                }
              />
              {installed && (
                <div className="settings-caption">
                  {installed.modified
                    ? COPY.modified
                    : !checkingUpdate
                      ? COPY.conflict
                      : !preview.value.updateAvailable
                        ? COPY.same
                        : undefined}
                </div>
              )}
              <div className="plugin-asset-actions">
                {download}
                {installed && (
                  <Button disabled={stageBusy} onClick={() => onManage(installed.id)}>
                    {COPY.reviewLocal}
                  </Button>
                )}
                {installed?.modified && (
                  <Button loading={exporting} disabled={stageBusy} onClick={() => void exportDraft(installed.id, installed.revision)}>
                    {COPY.exportDraft}
                  </Button>
                )}
              </div>
              <details className="plugin-asset-details">
                <summary>{COPY.details}</summary>
                <SettingsGroup>
                  <SettingsRow title={COPY.identity} description={manifest.id} />
                  <SettingsRow title={COPY.digest} description={release.integrity} />
                </SettingsGroup>
              </details>
            </>
          )}
          {stageError && (
            <InlineNotice
              tone="error"
              action={!stagePending && lastLookup && registry && <Button onClick={() => void lookup(lastLookup)}>{COPY.retry}</Button>}>
              {stageError}
            </InlineNotice>
          )}
          {stagePending && (
            <InlineNotice
              tone="warn"
              action={
                <Button loading={stageBusy} onClick={() => void stage(stagePending)}>
                  {COPY.retrySame}
                </Button>
              }>
              {COPY.unknown}
            </InlineNotice>
          )}
          {!installedView && browsing && npmRecords.length > 0 && (
            <SettingsGroup title={COPY.downloaded}>
              {npmRecords.map(record => {
                const origin = record.npm!
                const current = registry === origin.registry
                const checked = checkedUpdates[record.id]
                const available =
                  current && checked?.registry === registry && checked.revision === record.revision ? checked.version : undefined
                const applied = record.appliedVersion ?? (record.revision === record.appliedRevision ? record.version : undefined)
                const draft = record.revision !== record.appliedRevision ? record.version : undefined
                const status = !record.appliedRevision
                  ? COPY.unreviewed
                  : !record.enabled
                    ? COPY.disabled
                    : record.revision === record.appliedRevision
                      ? COPY.active
                      : COPY.earlierActive
                return (
                  <SettingsRow
                    key={record.id}
                    className="marketplace-fact"
                    title={record.name}
                    description={
                      <>
                        <span>
                          {origin.name} · {status}
                        </span>
                        <span className="plugin-market-versions">
                          {available && <strong>{COPY.availableVersion(available)}</strong>}
                          {applied && <span>{COPY.installedVersion(applied)}</span>}
                          {draft && <span>{COPY.draftVersion(draft)}</span>}
                          {origin.version !== draft && origin.version !== applied && <span>{COPY.downloadedVersion(origin.version)}</span>}
                        </span>
                        <span>{origin.registry}</span>
                        {!current && <span>{COPY.switchSource}</span>}
                      </>
                    }
                    trailing={
                      <div className="marketplace-row-actions">
                        <Button disabled={stageBusy} onClick={() => onManage(record.id)}>
                          {COPY.reviewLocal}
                        </Button>
                        {updateAction(record)}
                      </div>
                    }
                  />
                )
              })}
            </SettingsGroup>
          )}
          {!installedView && browsing && externalRecords.length > 0 && (
            <SettingsGroup title={COPY.external}>
              {externalRecords.map(record => {
                const origin = record.external
                const applied = record.appliedVersion ?? (record.revision === record.appliedRevision ? record.version : undefined)
                const draft = record.revision !== record.appliedRevision ? record.version : undefined
                return (
                  <SettingsRow
                    key={record.id}
                    className="marketplace-fact"
                    title={<VisibleText text={record.name} />}
                    description={
                      <>
                        {origin && <PluginSourceText source={{ kind: 'external', ...origin }} />}
                        <span className="plugin-market-versions">
                          {applied && <span>{COPY.installedVersion(applied)}</span>}
                          {draft && <span>{COPY.draftVersion(draft)}</span>}
                        </span>
                      </>
                    }
                    trailing={
                      <div className="marketplace-row-actions">
                        <Button disabled={locked} onClick={() => onManage(record.id)}>
                          {COPY.reviewLocal}
                        </Button>
                        {updateAction(record)}
                      </div>
                    }
                  />
                )
              })}
            </SettingsGroup>
          )}
          {active && connected && replacement && (
            <ConfirmDialog
              title={COPY.replace}
              message={COPY.replaces(replacement.release.version, replacement.release.name)}
              confirmLabel={COPY.replaceConfirm}
              danger
              onConfirm={() => stage(replacement)}
              onClose={() => setReplacement(null)}
            />
          )}
        </>
      )}
    </div>
  )
  return { sourceBusy, browsing, controls, content, updateAction }
}
