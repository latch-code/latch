import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { AppSnapshot, PluginCatalogUpdateStatus, PluginPackageSummary } from '@latch/protocol'
import { Button, EmptyState, Icon, InlineNotice, PlusGlyph, SearchField, Tabs } from '@latch/ui'
import { ArrowLeft, ArrowRight, LibraryBig, Package } from 'lucide-react'
import type { CatalogEntry } from '../../../../examples/marketplace/bundles.ts'
import { plugins as catalog } from '../../../../examples/latch.catelog.json'
import releasePreview from '../../../../examples/marketplace/release-check-preview.webp?url'
import { api, inlineError } from '../core/api.ts'
import { defineCopy, formatNumber, plural, useLocale } from '../core/i18n.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { Loading } from '../settings/common.tsx'
import { PluginRiskFacts } from '../settings/PluginMutationReview.tsx'
import { canEditPluginPackages } from '../settings/pluginAssets.ts'
import { SHELL_COPY } from '../shell/copy.ts'
import { BundledPluginPreview } from './BundledPluginPreview.tsx'
import { PluginMarketIcon } from './PluginArtwork.tsx'
import { usePluginAddMarketplace } from './PluginAddMarketplace.tsx'
import { usePluginCatalog } from './usePluginCatalog.ts'

declare const LATCH_CATALOG_MANIFESTS: Record<string, { name: string; version: string }>

const COPY = defineCopy(
  {
    source: '插件来源',
    bundled: '随 Latch 附带',
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
    back: '返回市场',
    review: '审阅并安装',
    reviewUpdate: '审阅更新',
    manage: '查看已有插件',
    catalogVersion: (version: string) => `随附 v${version}`,
    installedVersion: (version: string) => `已安装 v${version}`,
    draftVersion: (version: string) => `草稿 v${version}`,
    availableVersion: (version: string) => `可更新到 v${version}`,
    installed: '已安装',
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
    bundled: 'Bundled with Latch',
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
    back: 'Back to marketplace',
    review: 'Review and install',
    reviewUpdate: 'Review update',
    manage: 'View local plugin',
    catalogVersion: (version: string) => `Bundled v${version}`,
    installedVersion: (version: string) => `Installed v${version}`,
    draftVersion: (version: string) => `Draft v${version}`,
    availableVersion: (version: string) => `Update to v${version} available`,
    installed: 'Installed',
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
const FILTERS = ['all', ...FACETS.filter(facet => catalog.some(entry => entry.facets.includes(facet)))] as const
type Facet = (typeof FILTERS)[number]

function pluginFacets(entry: CatalogEntry) {
  return FACETS.filter(value => entry.facets.includes(value))
}

function PluginTags({ entry }: { entry: CatalogEntry }) {
  return (
    <ul className="plugin-market-tags" role="list" aria-label={COPY.filter}>
      {pluginFacets(entry).map(value => (
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
      <span>{status === 'available' ? <strong>{COPY.availableVersion(version)}</strong> : COPY.catalogVersion(version)}</span>
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
  source: 'bundled' | 'add'
  onSourceChange: (value: 'bundled' | 'add') => void
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
  const showTabs = canAdd && showBundled
  const [selected, setSelected] = useState<CatalogEntry | null>(null)
  const [query, setQuery] = useState('')
  const [facet, setFacet] = useState<Facet>('all')
  const [records, setRecords] = useState<PluginPackageSummary[] | null>(null)
  const [recordsError, setRecordsError] = useState('')
  const [retry, setRetry] = useState(0)
  const reasonId = useId()
  const titleId = useId()
  const bundledId = titleId + '-bundled'
  const addId = titleId + '-add'
  const bundledResults = useRef<HTMLElement>(null)
  const bundledPosition = useRef(0)
  const addResults = useRef<HTMLDivElement>(null)
  const addPosition = useRef(0)
  const searchField = useRef<HTMLInputElement>(null)
  const detailHeading = useRef<HTMLHeadingElement>(null)
  const lastCard = useRef<{ id: string; scrollTop: number } | null>(null)
  useLayoutEffect(() => {
    if (!open) return
    if (selected && !showAdd) {
      detailHeading.current?.focus({ preventScroll: true })
    } else if (!showAdd && bundledResults.current) {
      bundledResults.current.scrollTop = lastCard.current?.scrollTop ?? bundledPosition.current
      if (lastCard.current) {
        document.getElementById(titleId + lastCard.current.id)?.focus({ preventScroll: true })
        lastCard.current = null
      }
    }
  }, [open, selected, showAdd, titleId])

  useEffect(() => {
    if (!canEdit) {
      setRecords(null)
      setRecordsError('')
      return
    }
    if (!open || !connected) return
    const abort = new AbortController()
    setRecordsError('')
    void api<{ packages: PluginPackageSummary[] }>('plugin-packages', { signal: abort.signal }).then(
      result => {
        if (!abort.signal.aborted) setRecords(result.packages)
      },
      cause => {
        if (!abort.signal.aborted) setRecordsError(inlineError(cause))
      },
    )
    return () => abort.abort()
  }, [canEdit, connected, open, retry, snapshot.revision])
  const reloadRecords = () => setRetry(current => current + 1)
  const storageKey = JSON.stringify([snapshot.host?.hostId, snapshot.device.id])
  const local = records?.find(item => item.id === selected?.id)
  const bundledView = usePluginCatalog({
    active: open && showBundled && !showAdd,
    selectedId: selected?.id,
    localRevision: local?.revision,
    editable: canEdit,
    connected,
    storageKey: `latch:catalog-market:${storageKey}`,
    onStage: id => {
      reloadRecords()
      if (open && !showAdd) onManage(id)
    },
  })
  const addView = usePluginAddMarketplace({
    active: open && showAdd,
    connected,
    editable: canAdd,
    npmEnabled,
    externalEnabled,
    storageKey: `latch:npm-market:${storageKey}`,
    records: records ?? [],
    onStage: reloadRecords,
    onManage,
  })

  useLayoutEffect(() => {
    if (showAdd && addResults.current) {
      addResults.current.scrollTop = addView.browsing ? addPosition.current : 0
    }
  }, [addView.browsing, showAdd])

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
  const installedId = catalogPreview?.installed?.id ?? local?.id
  const status = catalogStatus(local, catalogPreview?.updateStatus)
  const canStage = catalogPreview && status !== 'different-source' && (!catalogPreview.installed || catalogPreview.updateAvailable === true)
  const targetManifest = catalogPreview?.bundle.manifest ?? (selected ? LATCH_CATALOG_MANIFESTS[selected.id] : undefined)
  const listing = selected?.[lang]
  const canCreate = showBundled && !showAdd && canEdit && onCreatePlugin !== undefined
  const createBlocked = connected ? creatorBlockedReason : COPY.createOffline
  return (
    <section className="plugin-market" aria-labelledby={titleId}>
      {showBundled && !showAdd && selected && listing ? (
        <div className="plugin-market-scroll">
          <h1 id={titleId} className="sr-only">
            {SHELL_COPY.marketplace}
          </h1>
          <div className="plugin-market-back">
            <Button variant="ghost" icon={ArrowLeft} disabled={bundledView.stageBusy} onClick={() => setSelected(null)}>
              {COPY.back}
            </Button>
          </div>
          <header className="plugin-market-detail-heading">
            <div className="plugin-market-detail-identity">
              <PluginMarketIcon id={selected.id} size={24} bundled framed />
              <div>
                <PluginTags entry={selected} />
                <h2 className="plugin-market-title" ref={detailHeading} tabIndex={-1}>
                  {listing.name}
                </h2>
              </div>
            </div>
          </header>
          {targetManifest && <CatalogVersions record={local} version={targetManifest.version} status={status} />}
          <p className="plugin-market-introduction">{listing.summary}</p>
          {bundledView.previewError && (
            <InlineNotice tone="error" action={<Button onClick={bundledView.retryPreview}>{COPY.retry}</Button>}>
              {bundledView.previewError}
            </InlineNotice>
          )}
          {canEdit && connected && !catalogPreview && !bundledView.previewError && <Loading label={COPY.bundleLoading} />}
          {!canEdit && <InlineNotice>{COPY.local}</InlineNotice>}
          {canEdit && !connected && <InlineNotice>{COPY.offline}</InlineNotice>}
          <div className="plugin-market-detail-content">
            {selected.id === 'release-check' ? (
              <img className="plugin-market-detail-image" src={releasePreview} alt={COPY.preview} width={734} height={541} />
            ) : (
              <BundledPluginPreview id={selected.id} />
            )}
            <div>
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
                {targetManifest && (
                  <div>
                    <dt>{COPY.identity}</dt>
                    <dd>
                      {targetManifest.name} · <code>{selected.id}</code>
                    </dd>
                  </div>
                )}
                <div>
                  <dt>{COPY.publisher}</dt>
                  <dd>Latch</dd>
                </div>
              </dl>
            </div>
          </div>
          {canEdit && (
            <div className="plugin-market-review">
              {catalogPreview && <PluginRiskFacts review={catalogPreview.review} />}
              {status && status !== 'available' && <InlineNotice>{COPY.updateStatus[status]}</InlineNotice>}
              {stageNotice}
              {canStage && <p className="plugin-market-note">{COPY.stageHint}</p>}
              <div className="plugin-market-actions">
                {installedId && (
                  <Button disabled={!connected || bundledView.stageBusy} onClick={() => onManage(installedId)}>
                    {COPY.manage}
                  </Button>
                )}
                {canStage && (
                  <Button
                    variant="primary"
                    loading={bundledView.stageBusy}
                    disabled={!connected || bundledView.stagePending !== null}
                    onClick={bundledView.stageSelected}>
                    {catalogPreview.installed ? COPY.reviewUpdate : COPY.review}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      ) : (
        <>
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
              value={source}
              options={[
                { value: 'bundled', label: COPY.bundled, icon: LibraryBig, id: bundledId + '-tab', controls: bundledId },
                { value: 'add', label: SHELL_COPY.addPlugin, icon: Package, id: addId + '-tab', controls: addId },
              ]}
              onValueChange={onSourceChange}
              disabled={connected && addView.sourceBusy}
            />
          )}
          <div
            className="plugin-market-panel"
            id={bundledId}
            role={showTabs ? 'tabpanel' : undefined}
            aria-labelledby={showTabs ? bundledId + '-tab' : undefined}
            hidden={!showBundled || showAdd}>
            {showBundled && !showAdd && (
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
                  {stageNotice}
                  {matches.length > 0 ? (
                    <ul className="plugin-market-gallery">
                      {matches.map(item => {
                        const record = records?.find(entry => entry.id === item.id)
                        const available = record?.catalogUpdate
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
                                  onClick={() => {
                                    lastCard.current = { id: item.id, scrollTop: bundledResults.current?.scrollTop ?? 0 }
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
                                <CatalogVersions
                                  record={record}
                                  version={available?.version ?? LATCH_CATALOG_MANIFESTS[item.id]!.version}
                                  status={catalogStatus(record)}
                                />
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
        </>
      )}
    </section>
  )
}
