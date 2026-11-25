import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { OFFICIAL_PLUGIN_CATALOG_REPOSITORY } from '@latch/protocol'
import type {
  AppSnapshot,
  PluginCatalogCheckResult,
  PluginCatalogPreview,
  PluginCatalogUpdateStatus,
  PluginPackageSummary,
} from '@latch/protocol'
import { Button, CheckGlyph, Collapse, Dialog, EmptyState, FoldHeader, Icon, InlineNotice, PlusGlyph, SearchField, Tabs } from '@latch/ui'
import { ArrowRight, LibraryBig, ListChecks, Package } from 'lucide-react'
import type { CatalogEntry } from '../../../../examples/marketplace/bundles.ts'
import { plugins as catalog } from '../../../../examples/latch.catalog.json'
import releasePreview from '../../../../examples/marketplace/release-check-preview.webp?url'
import { api, inlineError } from '../core/api.ts'
import { defineCopy, formatNumber, plural, useLocale } from '../core/i18n.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { describeFailure } from '../core/securityCopy.ts'
import { VisibleText } from '../components/VisibleText.tsx'
import { Loading } from '../settings/common.tsx'
import { PluginFileViewer } from '../settings/CreatorPluginReview.tsx'
import { PluginRiskFacts } from '../settings/PluginMutationReview.tsx'
import { canEditPluginPackages } from '../settings/pluginAssets.ts'
import { SHELL_COPY } from '../shell/copy.ts'
import { BundledPluginPreview } from './BundledPluginPreview.tsx'
import { InstalledPluginList } from './InstalledPluginList.tsx'
import { useInstalledPluginSwitch } from './InstalledPluginSwitch.tsx'
import type { MarketplaceTab } from './route.ts'
import { PluginMarketIcon } from './PluginArtwork.tsx'
import { usePluginAddMarketplace } from './PluginAddMarketplace.tsx'
import { usePluginInstallReview } from './PluginInstallReview.tsx'
import { useOfficialPluginCheck, usePluginCatalog } from './usePluginCatalog.ts'

declare const LATCH_CATALOG_MANIFESTS: Record<string, { name: string; version: string }>

const COPY = defineCopy(
  {
    source: '插件来源',
    bundled: 'Latch 官方',
    officialRepo: '在 GitHub 查看此插件',
    check: '检查更新',
    checking: '正在检查官方插件目录…',
    checkFailed: '未能检查官方目录，目前显示这台 Mac 已有的版本。',
    checkOffline: '连上工作台所在的电脑后即可检查更新。',
    checkConnection: '未收到工作台的回应，请检查连接后重试。',
    githubRateLimit: 'GitHub 暂时限制匿名读取，请稍后再点「检查更新」。',
    bundledGuide: '随附版使用说明',
    checked: '已检查官方目录。',
    noUpdates: '已检查官方目录，已添加的插件没有可用更新。',
    checkPluginFailed: '检查更新失败，请重试。',
    savedDraft: '已检查官方目录，有已保存的草稿待审阅。',
    available: (count: number) => `有 ${formatNumber(count)} 个官方插件可更新。`,
    officialSaved: '已保存这个官方版本，可在插件设置中管理。',
    addResults: '添加插件结果',
    introduction: '为工作台添加技能、会话面板和应用。',
    search: '搜索任务或插件',
    featured: '精选插件',
    filter: '贡献类型',
    clear: '清除搜索和筛选',
    results: (count: number) => `${formatNumber(count)} 个插件`,
    empty: '没有匹配的插件',
    use: '在哪里使用',
    agent: 'Agent 能做什么',
    access: '运行权限',
    publisher: '发布者',
    identity: '安装名称与标识',
    back: '返回',
    cancel: '取消',
    done: '完成',
    about: '能做什么与能访问什么',
    files: '文件与源码',
    review: '审阅并安装',
    reviewUpdate: '审阅更新',
    reviewDraft: '审阅草稿',
    apply: '应用',
    buildInSettings: '在插件设置中构建',
    manage: '查看已有插件',
    installedVersion: (version: string) => `已安装 v${version}`,
    draftVersion: (version: string) => `草稿 v${version}`,
    availableVersion: (version: string) => `可更新到 v${version}`,
    installed: '已安装',
    installedCount: (count: number) => `已安装（${formatNumber(count)}）`,
    localMatch: '这台 Mac 已有同标识插件',
    localMatchVersion: (version: string) => `这台 Mac 上的同标识插件 · v${version}`,
    updateStatus: {
      current: '已保存此随附版本，可在插件设置中管理。',
      older: '这台 Mac 已保存更新的随附版本。',
      'local-changes': '此插件有本地改动，请在插件设置中审阅。',
      'different-source': '这台 Mac 上已有插件使用此标识。',
      'same-version-changed': '当前版本的随附内容已经改变，请在插件设置中查看已有插件。',
    },
    uncertain: '暂时不知道这次操作是否完成。可重试同一请求。',
    retrySame: '重试同一请求',
    stageHint: '先保存草稿，应用后才会启用。',
    local: '请在这台 Mac 的 Latch 桌面端安装插件。',
    offline: '连上工作台所在的电脑后即可查找和添加插件。',
    loading: '正在读取已安装的插件…',
    bundleLoading: '正在读取插件审阅信息…',
    retry: '重试',
    create: '创建插件',
    createOffline: '连上工作台所在的电脑后即可创建插件。',
    preview: '样例项目的发布检查页面，显示逐项结果、证据和备注。',
  },
  {
    source: 'Plugin source',
    bundled: 'Latch official',
    officialRepo: 'View this plugin on GitHub',
    check: 'Check for updates',
    checking: 'Checking the official plugin catalog…',
    checkFailed: 'Couldn’t check the official catalog. Showing versions already available on this Mac.',
    checkOffline: 'Connect to the computer running Latch to check for updates.',
    checkConnection: 'The workbench did not respond. Check the connection and try again.',
    githubRateLimit: 'GitHub has temporarily limited anonymous requests. Try checking again later.',
    bundledGuide: 'Guide for the bundled version',
    checked: 'Official catalog checked.',
    noUpdates: 'Official catalog checked. No updates are available for your plugins.',
    checkPluginFailed: 'Update check failed. Try again.',
    savedDraft: 'Official catalog checked. A saved draft is ready for review.',
    available: (count: number) => plural(count, { one: '{n} official plugin has an update.', other: '{n} official plugins have updates.' }),
    officialSaved: 'This official version is already saved. Manage it in plugin settings.',
    addResults: 'Add plugin results',
    introduction: 'Add skills, session panels and apps to your workbench.',
    search: 'Search by task or plugin',
    featured: 'Featured plugins',
    filter: 'Contribution type',
    clear: 'Clear search and filters',
    results: (count: number) => plural(count, { one: '{n} plugin', other: '{n} plugins' }),
    empty: 'No matching plugins',
    use: 'Where to use it',
    agent: 'What the agent gets',
    access: 'Access',
    publisher: 'Publisher',
    identity: 'Local name and ID',
    back: 'Back',
    cancel: 'Cancel',
    done: 'Done',
    about: 'What it does and can access',
    files: 'Files and source',
    review: 'Review and install',
    reviewUpdate: 'Review update',
    reviewDraft: 'Review draft',
    apply: 'Apply',
    buildInSettings: 'Build in plugin settings',
    manage: 'View local plugin',
    installedVersion: (version: string) => `Installed v${version}`,
    draftVersion: (version: string) => `Draft v${version}`,
    availableVersion: (version: string) => `Update to v${version} available`,
    installed: 'Installed',
    installedCount: (count: number) => `Installed (${formatNumber(count)})`,
    localMatch: 'Local plugin with the same ID',
    localMatchVersion: (version: string) => `Local plugin with the same ID · v${version}`,
    updateStatus: {
      current: 'This bundled version is already saved. Manage it in plugin settings.',
      older: 'This Mac already has a newer bundled version.',
      'local-changes': 'This plugin has local changes. Review it in plugin settings.',
      'different-source': 'A local plugin already uses this ID on this Mac.',
      'same-version-changed': 'The bundled content changed within this version. View your existing plugin in settings.',
    },
    uncertain: 'The outcome is unknown. You can retry the same request.',
    retrySame: 'Retry same request',
    stageHint: 'Save a draft first. The plugin takes effect when you apply it.',
    local: 'Install plugins in the desktop app on the host Mac.',
    offline: 'Connect to the computer running Latch to find and add plugins.',
    loading: 'Reading local plugins…',
    bundleLoading: 'Reading plugin review…',
    retry: 'Retry',
    create: 'Create plugin',
    createOffline: 'Connect to the computer running Latch to create a plugin.',
    preview: 'A sample release check showing per-item results, evidence and notes.',
  },
)

const FACET_NAMES = defineCopy(
  { skill: '技能', panel: '会话面板', app: '应用页面', tool: '工具' },
  { skill: 'Skill', panel: 'Session panel', app: 'App page', tool: 'Tool' },
)
const FILTER_NAMES = defineCopy(
  { all: '全部', skill: '技能', panel: '会话面板', app: '应用页面', tool: '工具' },
  { all: 'All', skill: 'Skills', panel: 'Session panels', app: 'App pages', tool: 'Tools' },
)
const FACETS = ['skill', 'panel', 'app', 'tool'] as const
const catalogIds = catalog.map(entry => entry.id)
const FILTERS = ['all', ...FACETS.filter(facet => catalog.some(entry => entry.facets.includes(facet)))] as const
type Facet = (typeof FILTERS)[number]

function pluginFacets(entry: CatalogEntry) {
  return FACETS.filter(value => entry.facets.includes(value))
}

function PluginTags({ entry, review }: { entry: CatalogEntry; review?: PluginCatalogPreview['review'] | undefined }) {
  const shown = review
    ? {
        skill: review.skills.length,
        panel: review.panels.length + review.dataPanels.length,
        app: review.pages.length,
        tool: review.toolNames.length,
      }
    : null
  return (
    <ul className="plugin-market-tags" role="list" aria-label={COPY.filter}>
      {(shown ? FACETS.filter(facet => shown[facet] > 0) : pluginFacets(entry)).map(value => (
        <li key={value}>{FACET_NAMES[value]}</li>
      ))}
    </ul>
  )
}

function catalogStatus(record: PluginPackageSummary | undefined, previewStatus?: PluginCatalogUpdateStatus) {
  if (record && !record.catalog) return 'different-source'
  return previewStatus ?? record?.catalogUpdate?.status
}

function CatalogVersions({
  record,
  version,
  status,
}: {
  record: PluginPackageSummary | undefined
  version: string
  status: PluginCatalogUpdateStatus | undefined
}) {
  const applied = record?.appliedVersion ?? (record?.revision === record?.appliedRevision ? record?.version : undefined)
  const draft = record && record.revision !== record.appliedRevision ? record.version : undefined
  const local = applied ?? record?.version
  return (
    <div className="plugin-market-versions">
      <span>{status === 'available' ? <strong>{COPY.availableVersion(version)}</strong> : `v${version}`}</span>
      {status === 'different-source' ? (
        <span>{local ? COPY.localMatchVersion(local) : COPY.localMatch}</span>
      ) : (
        <>
          {record?.appliedRevision && <span>{applied ? COPY.installedVersion(applied) : COPY.installed}</span>}
          {draft && <span>{COPY.draftVersion(draft)}</span>}
        </>
      )}
    </div>
  )
}

/**
 * A bundled plugin before anything is saved: what it is for, its cover, what it does and can access, its files, and — on
 * a device that may install it — the Host's risk facts for the exact catalog revision.
 */
function CatalogOverview({
  entry,
  record,
  status,
  preview,
  version,
  manifestName,
  checkControls,
  installedView,
  children,
}: {
  entry: CatalogEntry
  record: PluginPackageSummary | undefined
  status: PluginCatalogUpdateStatus | undefined
  preview: PluginCatalogPreview | null
  version: string | undefined
  manifestName: string | undefined
  checkControls: ReactNode
  installedView: boolean
  children: ReactNode
}) {
  const lang = useLocale() === 'en' ? 'en' : 'zh'
  const listing = entry[lang]
  const [about, setAbout] = useState(true)
  const [files, setFiles] = useState(false)
  const aboutId = useId()
  const filesId = useId()
  const source = preview?.review.source
  const commit = source?.kind === 'catalog' ? source.commit : undefined
  const updated = !!commit && preview?.bundle.manifest.version !== LATCH_CATALOG_MANIFESTS[entry.id]?.version
  return (
    <div className="plugin-market-dialog-body">
      <div className="plugin-market-dialog-identity">
        {!installedView && <PluginMarketIcon id={entry.id} size={20} bundled framed />}
        <div className="plugin-market-dialog-meta">
          <span>{COPY.publisher} · Latch</span>
          {version && <CatalogVersions record={record} version={version} status={status} />}
        </div>
      </div>
      {!installedView && (
        <>
          <PluginTags entry={entry} review={updated ? preview?.review : undefined} />
          <p className="plugin-market-dialog-summary">
            <VisibleText text={(updated && preview?.bundle.manifest.description) || listing.summary} />
          </p>
        </>
      )}
      <a href={`${OFFICIAL_PLUGIN_CATALOG_REPOSITORY}/tree/${commit ?? 'main'}/plugins/${entry.id}`} target="_blank" rel="noreferrer">
        {COPY.officialRepo}
      </a>
      {checkControls}
      {!installedView
        && (entry.id === 'release-check' ? (
          <img className="plugin-market-detail-image" src={releasePreview} alt={COPY.preview} width={734} height={541} />
        ) : (
          <BundledPluginPreview id={entry.id} />
        ))}
      {!installedView && (
        <div className="plugin-market-dialog-fold">
          <FoldHeader open={about} onOpenChange={setAbout} aria-controls={aboutId}>
            {updated ? COPY.bundledGuide : COPY.about}
          </FoldHeader>
          <Collapse open={about} id={aboutId}>
            <dl className="plugin-market-facts">
              <div>
                <dt>{COPY.use}</dt>
                <dd>{listing.use}</dd>
              </div>
              <div>
                <dt>{COPY.agent}</dt>
                <dd>{listing.agent}</dd>
              </div>
              <div>
                <dt>{COPY.access}</dt>
                <dd>{listing.access}</dd>
              </div>
              {manifestName && (
                <div>
                  <dt>{COPY.identity}</dt>
                  <dd>
                    <VisibleText text={manifestName} /> · <code>{entry.id}</code>
                  </dd>
                </div>
              )}
            </dl>
          </Collapse>
        </div>
      )}
      {preview && (
        <div className="plugin-market-dialog-fold">
          <FoldHeader open={files} onOpenChange={setFiles} aria-controls={filesId} meta={formatNumber(preview.bundle.files.length + 1)}>
            {COPY.files}
          </FoldHeader>
          <Collapse open={files} id={filesId} lazy>
            <div className="creator-plugin-review">
              <PluginFileViewer bundle={preview.bundle} />
            </div>
          </Collapse>
        </div>
      )}
      {children}
    </div>
  )
}

export function PluginMarketplace({
  open,
  connected = true,
  snapshot,
  access,
  showBundled,
  source,
  onSourceChange,
  onManage,
  onCreatePlugin,
  creatorBlockedReason,
}: {
  open: boolean
  connected?: boolean
  snapshot: AppSnapshot
  access: DeviceAccess
  showBundled: boolean
  source: MarketplaceTab
  onSourceChange: (value: MarketplaceTab) => void
  onManage: (id: string) => void
  onCreatePlugin?: (query?: string) => void
  creatorBlockedReason?: string | undefined
}) {
  const lang = useLocale() === 'en' ? 'en' : 'zh'
  const canEdit = access.scopes.has('view') && canEditPluginPackages(snapshot, access)
  const npmEnabled = snapshot.catalog?.features?.pluginNpmRegistry === true
  const externalEnabled = snapshot.catalog?.features?.pluginExternalSources === true
  const canAdd = canEdit && (npmEnabled || externalEnabled)
  const showAdd = canAdd && (source === 'add' || !showBundled)
  const showTabs = canEdit && showBundled
  const showInstalled = showTabs && source === 'installed'
  const showFeatured = showBundled && !showAdd && !showInstalled
  const [selected, setSelected] = useState<CatalogEntry | null>(null)
  // The saved draft the dialog reviews, then what was applied.
  const [review, setReview] = useState<{ id: string; done?: { name: string; version: string } } | null>(null)
  const [query, setQuery] = useState('')
  const [facet, setFacet] = useState<Facet>('all')
  const storageKey = JSON.stringify([snapshot.host?.hostId, snapshot.device.id])
  const official = useOfficialPluginCheck(open && showBundled && !showAdd && canEdit && connected, storageKey, catalogIds)
  const checkedCatalog = canEdit ? official.check?.result : undefined
  const [installationList, setInstallationList] = useState<{
    scope: string
    catalog: PluginCatalogCheckResult | undefined
    packages: PluginPackageSummary[]
  } | null>(null)
  const records = canEdit && installationList?.scope === storageKey ? installationList.packages : null
  const [recordsError, setRecordsError] = useState('')
  const [retry, setRetry] = useState(0)
  const reasonId = useId()
  const titleId = useId()
  const bundledId = titleId + '-bundled'
  const installedId = titleId + '-installed'
  const addId = titleId + '-add'
  const bundledResults = useRef<HTMLElement>(null)
  const bundledPosition = useRef(0)
  const installedResults = useRef<HTMLDivElement>(null)
  const installedPosition = useRef(0)
  const addResults = useRef<HTMLDivElement>(null)
  const addPosition = useRef(0)
  const searchField = useRef<HTMLInputElement>(null)
  const dialogFor = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    dialogFor.current = selected?.id
  })
  useLayoutEffect(() => {
    if (open && showFeatured && bundledResults.current) bundledResults.current.scrollTop = bundledPosition.current
  }, [open, showFeatured])

  useEffect(() => {
    if (!canEdit) {
      setInstallationList(null)
      setRecordsError('')
      return
    }
    if (!open || !connected) return
    const abort = new AbortController()
    setRecordsError('')
    void api<{ packages: PluginPackageSummary[] }>('plugin-packages', { signal: abort.signal }).then(
      result => {
        if (!abort.signal.aborted) setInstallationList({ scope: storageKey, catalog: checkedCatalog, packages: result.packages })
      },
      cause => {
        if (!abort.signal.aborted) setRecordsError(inlineError(cause))
      },
    )
    return () => abort.abort()
  }, [canEdit, connected, open, retry, snapshot.revision, storageKey, checkedCatalog])
  const reloadRecords = () => setRetry(current => current + 1)
  const installedSwitch = useInstalledPluginSwitch({
    active: open && showInstalled,
    editable: canEdit,
    connected,
    storageKey,
    revision: snapshot.revision,
    onChanged: reloadRecords,
  })
  const local = records?.find(item => item.id === selected?.id)
  const bundledView = usePluginCatalog({
    active: open && showBundled && !showAdd,
    selectedId: selected?.id,
    localRevision: local?.revision,
    checkedCatalog,
    editable: canEdit,
    connected,
    storageKey: `latch:catalog-market:${storageKey}`,
    onStage: id => {
      reloadRecords()
      // Only the dialog that asked moves on to the draft; a retry from the list stays on the list.
      if (dialogFor.current === id) setReview({ id })
    },
  })
  const addView = usePluginAddMarketplace({
    active: open && (showAdd || showInstalled),
    installedView: showInstalled,
    connected,
    editable: canAdd,
    npmEnabled,
    externalEnabled,
    storageKey: `latch:npm-market:${storageKey}`,
    records: records ?? [],
    onStage: reloadRecords,
    onManage,
    onReview: id => {
      setSelected(null)
      setReview({ id })
    },
  })
  const appPages = snapshot.catalog?.features?.appPages === 1
  const installReview = usePluginInstallReview({
    id: review?.id,
    active: open && canEdit && connected && review !== null && review.done === undefined,
    revisionHint: records?.find(item => item.id === review?.id)?.revision,
    pageBuilds: appPages,
    onApplied: done => {
      reloadRecords()
      setReview(current => (current ? { ...current, done } : current))
    },
  })

  useLayoutEffect(() => {
    if (showAdd && addResults.current) {
      addResults.current.scrollTop = addView.browsing ? addPosition.current : 0
    }
  }, [addView.browsing, showAdd])

  useLayoutEffect(() => {
    if (showInstalled && installedResults.current) {
      installedResults.current.scrollTop = addView.browsing ? installedPosition.current : 0
    }
  }, [addView.browsing, showInstalled])

  const resetResults = () => {
    bundledPosition.current = 0
    if (bundledResults.current) bundledResults.current.scrollTop = 0
  }
  const recordStatus =
    canEdit
    && connected
    && records === null
    && (recordsError ? (
      <InlineNotice tone="error" action={<Button onClick={reloadRecords}>{COPY.retry}</Button>}>
        {recordsError}
      </InlineNotice>
    ) : (
      <Loading label={COPY.loading} />
    ))
  const stageNotice = bundledView.stagePending ? (
    <InlineNotice
      tone="warn"
      action={
        <Button disabled={!connected} loading={bundledView.stageBusy} onClick={bundledView.retryStage}>
          {COPY.retrySame}
        </Button>
      }>
      {COPY.uncertain}
    </InlineNotice>
  ) : (
    bundledView.stageError && <InlineNotice tone="error">{bundledView.stageError}</InlineNotice>
  )

  const search = query.trim().toLowerCase()
  const filtered = facet !== 'all' || search !== ''
  const matches = catalog.filter(item => {
    if (facet !== 'all' && !item.facets.includes(facet)) return false
    const contributionNames = pluginFacets(item).flatMap(value => [FACET_NAMES[value], FILTER_NAMES[value]])
    return [item.id, ...Object.values(item[lang]), ...contributionNames].join(' ').toLowerCase().includes(search)
  })
  const catalogPreview = bundledView.preview
  // After a stage, apply or removal, the package list has fresher installation status than the catalog check.
  const reread = records !== null && installationList?.catalog === checkedCatalog
  const releases = catalog.map(entry => {
    const { id } = entry
    const record = records?.find(item => item.id === id)
    const known = checkedCatalog?.plugins.find(item => item.id === id)
    const latest = reread ? record?.catalogUpdate : undefined
    return {
      entry,
      id,
      record,
      version: known?.version ?? record?.catalogUpdate?.version ?? LATCH_CATALOG_MANIFESTS[id]!.version,
      status: catalogStatus(
        record,
        reread && (!known || !record || latest?.version === known.version) ? latest?.status : known?.updateStatus,
      ),
    }
  })
  const selectedRelease = releases.find(entry => entry.id === selected?.id)
  const selectedInstallId = catalogPreview?.installed?.id ?? local?.id
  const status = catalogStatus(local, catalogPreview?.updateStatus ?? selectedRelease?.status)
  const checking = connected && official.check?.status === 'checking'
  const canStage =
    catalogPreview && !checking && status !== 'different-source' && (!catalogPreview.installed || catalogPreview.updateAvailable === true)
  // This catalog version is already saved as a draft: the dialog reviews that draft instead of saving another.
  const savedDraft =
    !canStage && status === 'current' && local?.catalog !== undefined && local.revision !== local.appliedRevision ? local : undefined
  const targetManifest = catalogPreview?.bundle.manifest
  const listing = selected?.[lang]
  const canCreate = showFeatured && canEdit && onCreatePlugin !== undefined
  const createBlocked = connected ? creatorBlockedReason : COPY.createOffline
  const step = review ? (review.done ? 'done' : 'review') : selected && listing ? 'overview' : null
  const dialogLocked = bundledView.stageBusy || installReview.locked
  const checkedRecords = releases.filter(entry => entry.record?.catalog)
  const updateCount = releases.filter(release => release.status === 'available').length
  let checkStatus = ''
  let checkFailure: string | undefined
  if (!connected) checkStatus = COPY.checkOffline
  else if (checking) checkStatus = COPY.checking
  else if (official.check?.status === 'failed') {
    const failure = official.check.failure
    if (failure === 'connection') checkFailure = COPY.checkConnection
    else if (failure)
      checkFailure =
        failure.code === 'plugin-external-github-rate-limit' ? COPY.githubRateLimit : describeFailure(failure.status, failure.code)
    checkStatus = [COPY.checkFailed, checkFailure].filter(Boolean).join(' ')
  } else if (official.check?.status === 'checked') {
    checkStatus = COPY.checked
    if (updateCount) checkStatus = COPY.available(updateCount)
    else if (checkedRecords.some(entry => entry.status === 'current' && entry.record?.revision !== entry.record?.appliedRevision))
      checkStatus = COPY.savedDraft
    else if (checkedRecords.length > 0 && checkedRecords.every(entry => entry.status === 'current' || entry.status === 'older'))
      checkStatus = COPY.noUpdates
  }
  const checkButton = (
    <Button disabled={!connected || checking || dialogLocked} loading={checking} onClick={official.refresh}>
      {COPY.check}
    </Button>
  )
  const checkControls = canEdit && (
    <div className="plugin-market-list-heading">
      <span role="status">{checkStatus}</span>
      {checkButton}
    </div>
  )
  const closeDialog = () => {
    if (dialogLocked) return
    setSelected(null)
    setReview(null)
  }
  const manage = (id: string) => {
    setSelected(null)
    setReview(null)
    onManage(id)
  }
  const reviewName = installReview.name ?? records?.find(item => item.id === review?.id)?.name
  const dialogTitle =
    listing && (step === 'overview' || review?.id === selected?.id) ? (
      listing.name
    ) : review?.done ? (
      <VisibleText text={review.done.name} />
    ) : reviewName ? (
      <VisibleText text={reviewName} />
    ) : (
      COPY.reviewDraft
    )
  const cancel = (
    <Button size="md" disabled={dialogLocked} onClick={closeDialog}>
      {COPY.cancel}
    </Button>
  )
  const dialogFooter =
    step === 'overview' ? (
      <>
        {canEdit && selectedInstallId && (
          <Button size="md" variant="ghost" disabled={!connected || dialogLocked} onClick={() => manage(selectedInstallId)}>
            {COPY.manage}
          </Button>
        )}
        {cancel}
        {canEdit && canStage && (
          <Button
            size="md"
            variant="primary"
            loading={bundledView.stageBusy}
            disabled={!connected || bundledView.stagePending !== null}
            onClick={bundledView.stageSelected}>
            {catalogPreview.installed ? COPY.reviewUpdate : COPY.review}
          </Button>
        )}
        {canEdit && savedDraft && (
          <Button size="md" variant="primary" disabled={!connected} onClick={() => setReview({ id: savedDraft.id })}>
            {COPY.reviewDraft}
          </Button>
        )}
      </>
    ) : step === 'review' && review ? (
      <>
        {selected && (
          <Button size="md" variant="ghost" disabled={dialogLocked} onClick={() => setReview(null)}>
            {COPY.back}
          </Button>
        )}
        {cancel}
        {installReview.pageBuild ? (
          <Button size="md" variant="primary" disabled={!connected} onClick={() => manage(review.id)}>
            {COPY.buildInSettings}
          </Button>
        ) : (
          !installReview.applied && (
            <Button
              size="md"
              variant="primary"
              loading={installReview.busy}
              disabled={!connected || !installReview.ready}
              onClick={installReview.apply}>
              {installReview.retrying ? COPY.retrySame : COPY.apply}
            </Button>
          )
        )}
      </>
    ) : (
      <Button size="md" variant="primary" onClick={closeDialog}>
        {COPY.done}
      </Button>
    )
  const dialog = (
    <Dialog
      open={open && step !== null}
      size="xl"
      className="plugin-market-dialog"
      secure={step === 'review'}
      dismissible={!dialogLocked}
      title={dialogTitle}
      onClose={closeDialog}
      {...(step === 'overview' && canEdit && canStage ? { note: COPY.stageHint } : {})}
      footer={dialogFooter}>
      {step === 'overview' && selected ? (
        <CatalogOverview
          key={selected.id}
          entry={selected}
          record={local}
          status={status}
          preview={catalogPreview}
          version={targetManifest?.version ?? selectedRelease?.version}
          manifestName={targetManifest?.name ?? LATCH_CATALOG_MANIFESTS[selected.id]?.name}
          installedView={showInstalled}
          checkControls={showInstalled ? null : checkControls}>
          {bundledView.previewError && (
            <InlineNotice tone="error" action={<Button onClick={bundledView.retryPreview}>{COPY.retry}</Button>}>
              {bundledView.previewError}
            </InlineNotice>
          )}
          {canEdit && connected && !catalogPreview && !bundledView.previewError && <Loading label={COPY.bundleLoading} />}
          {!canEdit && <InlineNotice>{COPY.local}</InlineNotice>}
          {canEdit && !connected && <InlineNotice>{COPY.offline}</InlineNotice>}
          {canEdit && catalogPreview && <PluginRiskFacts review={catalogPreview.review} />}
          {canEdit
            && status
            && status !== 'available'
            && !savedDraft
            && (status !== 'current' || (connected && official.check?.status === 'checked')) && (
              <InlineNotice>
                {status === 'current' && catalogPreview?.review.source.kind === 'catalog' && catalogPreview.review.source.commit
                  ? COPY.officialSaved
                  : COPY.updateStatus[status]}
              </InlineNotice>
            )}
          {canEdit && stageNotice}
        </CatalogOverview>
      ) : step === 'review' ? (
        <div className="plugin-market-dialog-body">
          {!connected && <InlineNotice>{COPY.offline}</InlineNotice>}
          {installReview.body}
        </div>
      ) : review?.done ? (
        <div className="plugin-market-dialog-done" role="status">
          <Icon icon={CheckGlyph} size={20} />
          <span>{COPY.installedVersion(review.done.version)}</span>
        </div>
      ) : null}
    </Dialog>
  )
  return (
    <section className="plugin-market" aria-labelledby={titleId}>
      {dialog}
      <header className="plugin-market-header">
        <div className="plugin-market-heading">
          <h1 id={titleId} className="plugin-market-title">
            {showBundled ? SHELL_COPY.marketplace : SHELL_COPY.addPlugin}
          </h1>
          {canCreate && (
            <Button
              className="plugin-market-create"
              variant="primary"
              size="md"
              icon={PlusGlyph}
              aria-describedby={createBlocked ? reasonId : undefined}
              disabled={!!createBlocked}
              onClick={() => onCreatePlugin(query.trim() || undefined)}>
              {COPY.create}
            </Button>
          )}
        </div>
        {showBundled && <p className="plugin-market-introduction">{COPY.introduction}</p>}
        {canCreate && createBlocked && (
          <p className="plugin-market-note" id={reasonId}>
            {createBlocked}
          </p>
        )}
      </header>
      {showTabs && (
        <Tabs
          className="plugin-market-source"
          label={COPY.source}
          value={showInstalled ? 'installed' : showAdd ? 'add' : 'bundled'}
          options={[
            { value: 'bundled', label: COPY.bundled, icon: LibraryBig, id: bundledId + '-tab', controls: bundledId },
            {
              value: 'installed',
              label: records ? COPY.installedCount(records.filter(record => record.appliedRevision !== undefined).length) : COPY.installed,
              icon: ListChecks,
              id: installedId + '-tab',
              controls: installedId,
            },
            ...(canAdd ? [{ value: 'add' as const, label: SHELL_COPY.addPlugin, icon: Package, id: addId + '-tab', controls: addId }] : []),
          ]}
          onValueChange={onSourceChange}
          disabled={connected && (addView.sourceBusy || (showInstalled && installedSwitch.busy))}
        />
      )}
      <div
        className="plugin-market-panel"
        id={bundledId}
        role={showTabs ? 'tabpanel' : undefined}
        aria-labelledby={showTabs ? bundledId + '-tab' : undefined}
        hidden={!showFeatured}>
        {showFeatured && (
          <>
            <div className="plugin-market-controls">
              <SearchField
                ref={searchField}
                className="plugin-market-search"
                label={COPY.search}
                value={query}
                onValueChange={value => {
                  resetResults()
                  setQuery(value)
                }}
              />
              <div className="plugin-market-filters" role="group" aria-label={COPY.filter}>
                {FILTERS.map(value => (
                  <button
                    type="button"
                    key={value}
                    className="plugin-market-filter"
                    aria-pressed={facet === value}
                    onClick={() => {
                      resetResults()
                      setFacet(value)
                    }}>
                    {FILTER_NAMES[value]}
                  </button>
                ))}
              </div>
            </div>
            <section
              className="plugin-market-list plugin-market-scroll"
              aria-labelledby={titleId + '-featured'}
              ref={bundledResults}
              tabIndex={0}
              onScroll={event => {
                bundledPosition.current = event.currentTarget.scrollTop
              }}>
              <div className="plugin-market-list-heading">
                <h2 id={titleId + '-featured'}>{COPY.featured}</h2>
                <span role="status">{filtered ? COPY.results(matches.length) : ''}</span>
              </div>
              {checkControls}
              {step === null && stageNotice}
              {matches.length > 0 ? (
                <ul className="plugin-market-gallery">
                  {matches.map(item => {
                    const release = releases.find(entry => entry.id === item.id)!
                    return (
                      <li key={item.id} className="plugin-market-card">
                        <BundledPluginPreview id={item.id} />
                        <div className="plugin-market-card-body">
                          <h3>
                            <button
                              type="button"
                              className="plugin-market-card-heading"
                              id={titleId + item.id}
                              aria-describedby={`${titleId}${item.id}-description ${titleId}${item.id}-kind`}
                              aria-haspopup="dialog"
                              onClick={() => {
                                setReview(null)
                                setSelected(item)
                              }}>
                              <PluginMarketIcon id={item.id} size={20} bundled />
                              <span>{item[lang].name}</span>
                              <Icon className="plugin-market-card-arrow" icon={ArrowRight} size={16} />
                            </button>
                          </h3>
                          <p id={titleId + item.id + '-description'}>{item[lang].summary}</p>
                          <div className="plugin-market-card-meta" id={titleId + item.id + '-kind'}>
                            <PluginTags entry={item} />
                            <CatalogVersions record={release.record} version={release.version} status={release.status} />
                          </div>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <EmptyState
                  title={COPY.empty}
                  action={
                    <Button
                      onClick={() => {
                        resetResults()
                        setFacet('all')
                        setQuery('')
                        searchField.current?.focus()
                      }}>
                      {COPY.clear}
                    </Button>
                  }
                />
              )}
            </section>
          </>
        )}
      </div>
      {showTabs && (
        <div
          className="plugin-market-panel"
          id={installedId}
          role="tabpanel"
          aria-labelledby={installedId + '-tab'}
          hidden={!showInstalled}>
          <div
            className="plugin-market-scroll"
            role="region"
            aria-labelledby={installedId + '-tab'}
            tabIndex={0}
            ref={installedResults}
            onScroll={event => {
              if (showInstalled && addView.browsing) installedPosition.current = event.currentTarget.scrollTop
            }}>
            {showInstalled && (
              <div className="plugin-market-installed">
                {!connected && <InlineNotice>{COPY.checkOffline}</InlineNotice>}
                {recordStatus}
                {installedSwitch.feedback}
                {step === null && stageNotice}
                {canAdd && addView.content}
                {records && (!canAdd || addView.browsing) && (
                  <InstalledPluginList
                    records={records}
                    releases={releases}
                    lang={lang}
                    connected={connected}
                    locked={installedSwitch.locked}
                    officialStatus={official.check?.status}
                    failure={checkFailure ?? COPY.checkPluginFailed}
                    onCheck={official.refresh}
                    switchControl={installedSwitch.control}
                    updateAction={addView.updateAction}
                    onReviewUpdate={setSelected}
                    onReviewDraft={id => setReview({ id })}
                    onManage={manage}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      )}
      {canAdd && (
        <div
          className="plugin-market-panel"
          role={showTabs ? 'tabpanel' : undefined}
          id={addId}
          aria-labelledby={showTabs ? addId + '-tab' : undefined}
          hidden={!showAdd}>
          {showAdd && (
            <>
              {addView.controls && <div className="plugin-market-controls plugin-market-npm">{addView.controls}</div>}
              <div
                className="plugin-market-scroll"
                ref={addResults}
                role="region"
                aria-label={COPY.addResults}
                tabIndex={0}
                onScroll={event => {
                  if (addView.browsing) addPosition.current = event.currentTarget.scrollTop
                }}>
                <div className="plugin-market-npm">
                  {!connected && <InlineNotice>{COPY.offline}</InlineNotice>}
                  {addView.content}
                  {recordStatus}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  )
}
