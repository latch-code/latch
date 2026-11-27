import { useCallback, useContext, useEffect, useId, useState, type ReactNode } from 'react'
import { Upload } from 'lucide-react'
import {
  PLUGIN_MARKETPLACE_PAGE,
  type AppSnapshot,
  type AppSummary,
  type PluginInfo,
  type PluginPackageBundle,
  type PluginPackageDetail,
  type PluginPackageReviewSource,
  type PluginPackageSummary,
} from '@latch/protocol'
import { api, errorMessage, inlineError } from '../core/api.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { Button, ChevronRightGlyph, EmptyState, Icon, InlineNotice, Switch, PlusGlyph } from '@latch/ui'
import { Loading, SectionHeading, SettingsGroup, SettingsRow } from './common.tsx'
import { NavigationContext, SettingsPages } from './navigation.tsx'
import { packageState, PluginReachGroup, usePluginAssets } from './PluginAssetsSettings.tsx'
import { canEditPluginPackages, needsPageBuild, packageReach, pluginInUseReason, pluginReach, type PluginReach } from './pluginAssets.ts'
import { AppDraftCard } from './NewAppCard.tsx'
import { CreatorPluginReview } from './CreatorPluginReview.tsx'
import { isPluginPackageReview, PluginSourceText } from './PluginMutationReview.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { isAppleMobile } from '../plugin-marketplace/route.ts'
import { computerName } from '../core/securityCopy.ts'
import { DiagnosticsDialog } from '../plugin-pages/AppsPage.tsx'
import { currentLocale, defineCopy, formatNumber, useLocale } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    tools: '工具',
    skills: '技能',
    connections: '连接',
    workbench: '工作台',
    list: '插件',
    details: '查看详情',
    browseMarketplace: '浏览插件市场',
    modelService: '模型服务',
    ui: '界面',
    data: '数据',
    pageSurface: '页面 · 侧栏入口',
    alwaysOn: '始终开启',
    on: '已开启',
    off: '未开启',
    add: '添加插件…',
    create: '创建插件…',
    importFile: '导入文件…',
    newTool: '新建工具',
    finishChange: '请先完成当前的插件更改。',
    settings: '设置',
    version: '版本',
    source: '来源',
    bundled: '随 Latch 提供',
    launchPlugin: '随工作台启动加载',
    draftVersion: '待确认版本',
    appliedVersion: '已安装版本',
    enablePlugin: '启用插件',
    catalogUpdate: '精选目录有可下载的新版',
    reviewVersion: '前往插件市场',
    provides: '提供',
    content: '内容',
    editOnMac: '在 Mac 上的 Latch 里编辑',
    edit: '编辑…',
    export: '导出插件',
    exportScope: '导出当前保存的清单与文件。包内不含运行数据或批准记录。',
    rollback: '回退',
    diagnostics: '诊断',
    loading: '正在读取插件…',
    retry: '重试',
    empty: '这台 Mac 还没有可管理的插件',
    enable: (name: string) => `启用 ${name}`,
    rollBackTo: (version: string) => `回退到 ${version}`,
    editOnHost: (host: string) => `在 ${host} 上修改`,
  },
  {
    tools: 'Tools',
    skills: 'Skills',
    connections: 'Connections',
    workbench: 'Workbench',
    list: 'Plugins',
    details: 'View details',
    browseMarketplace: 'Browse Plugin Marketplace',
    modelService: 'Model service',
    ui: 'UI',
    data: 'Data',
    pageSurface: 'Page · Available in the sidebar',
    alwaysOn: 'Always on',
    on: 'On',
    off: 'Off',
    add: 'Add plugin…',
    create: 'Create plugin…',
    importFile: 'Import file…',
    newTool: 'New tool',
    finishChange: 'Finish the current plugin change first.',
    settings: 'Settings',
    version: 'Version',
    source: 'Source',
    bundled: 'Shipped with Latch',
    launchPlugin: 'Loaded at workbench startup',
    draftVersion: 'Version to review',
    appliedVersion: 'Installed version',
    enablePlugin: 'Enable plugin',
    catalogUpdate: 'A newer catalog version is available',
    reviewVersion: 'Open Plugin Marketplace',
    provides: 'Provides',
    content: 'Content',
    editOnMac: 'Edit in Latch on the Mac',
    edit: 'Edit…',
    export: 'Export plugin',
    exportScope: 'Export the saved manifest and files. Runtime data and approvals are excluded.',
    rollback: 'Roll back',
    diagnostics: 'Diagnostics',
    loading: 'Loading plugins…',
    retry: 'Retry',
    empty: 'No plugins to manage on this Mac',
    enable: (name: string) => `Turn on ${name}`,
    rollBackTo: (version: string) => `Roll back to ${version}`,
    editOnHost: (host: string) => `Edit on ${host}`,
  },
)

const CAPABILITY_LABELS: Partial<Record<string, 'modelService' | 'tools' | 'ui' | 'skills' | 'data' | 'connections' | 'workbench'>> = {
  provider: 'modelService',
  tool: 'tools',
  ui: 'ui',
  skill: 'skills',
  data: 'data',
  transport: 'connections',
  workspace: 'workbench',
}
const kindsOf = (capabilities: readonly string[]) => capabilities.map(capability => capability.split(':')[0])

const BUILTIN_NAMES: Readonly<Record<string, { name: string; englishName: string; description: string; englishDescription: string }>> = {
  [PLUGIN_MARKETPLACE_PAGE.pluginId]: {
    name: '插件市场',
    englishName: 'Plugin Marketplace',
    description: '浏览随 Latch 提供的插件，并从此电脑批准的 npm 源查看和下载插件。',
    englishDescription: 'Browse plugins shipped with Latch and preview or download plugins from this computer’s approved npm source.',
  },
  'user-questions': {
    name: '向你提问',
    englishName: 'Questions for you',
    description: '内置 Agent 的选择题与多题向导；回答仅交回当前会话。',
    englishDescription: 'Multiple-choice questions from the built-in Agent. Answers go only to the current session.',
  },
  browser: {
    name: '浏览器',
    englishName: 'Browser',
    description: '内置 Agent 经这台 Mac 的 Latch 桌面端操作「浏览器」页签：只在本机地址上。',
    englishDescription: 'The built-in Agent can use the Browser tab in the Latch desktop app on this Mac, on local addresses only.',
  },
  device: {
    name: '设备',
    englishName: 'Devices',
    description:
      '内置 Agent 经 xcrun simctl 与 devicectl 查看和操作这台 Mac 上的 iOS 模拟器；点按与按键只给完全访问的外部 Harness 会话，不启动或关闭设备。',
    englishDescription:
      'Access this Mac’s iOS simulators through xcrun simctl and devicectl. Only external Harness sessions with full access can tap or press keys. These tools leave device power unchanged.',
  },
  'workspace-files': {
    name: '项目文件',
    englishName: 'Project files',
    description: '列出、读取和编辑项目各文件夹中的文件；每次写入需要审批，节点私有数据不可访问。',
    englishDescription:
      'List, read, and edit files in project folders. Each write requires approval. Private Latch data on this computer stays inaccessible.',
  },
  'safe-tools': {
    name: '安全文件工具',
    englishName: 'Safe file tools',
    description: '需要审批的报告写入，以及固定 30 秒的可取消任务；文件只能写入执行节点的 artifacts 目录。',
    englishDescription:
      'Write reports with approval and run a cancellable 30-second task. Files can only be written to the artifacts folder on this computer.',
  },
  demo: {
    name: '确定性演示模型',
    englishName: 'Deterministic demo model',
    description: '无需 API Key；通过真实工具、审批与文件产物验证执行流程。用量为演示值。',
    englishDescription: 'Try a workflow with real tools, approvals, and files without an API key. Usage figures are simulated.',
  },
}

function builtInCopy(plugin: PluginInfo) {
  if (currentLocale() !== 'en' || !(plugin.builtIn || plugin.managed === 'core') || !Object.hasOwn(BUILTIN_NAMES, plugin.id))
    return undefined
  const words = BUILTIN_NAMES[plugin.id]
  return words?.name === plugin.name ? words : undefined
}

function provides(capabilities: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const kind of kindsOf(capabilities)) if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1)
  return [...counts]
    .map(([kind, count]) => {
      const label = CAPABILITY_LABELS[kind]
      return `${label ? COPY[label] : kind === 'harness' ? 'Harness' : kind} ${formatNumber(count)}`
    })
    .join(' · ')
}

type Item = { key: string; name: string; description: string; state: string; attention: boolean } & (
  | { kind: 'plugin'; plugin: PluginInfo }
  | { kind: 'package'; record: PluginPackageSummary; plugin?: PluginInfo }
)

/** What 设置 › 模型 and 设置 › Harness already list. A person's own package offering either is still a plugin. */
function managedElsewhere(plugin: PluginInfo): boolean {
  if (plugin.managed === 'provider' || plugin.managed === 'agent') return true
  return plugin.managed === 'core' && kindsOf(plugin.capabilities).some(kind => kind === 'harness' || kind === 'provider')
}

function pluginState(plugin: PluginInfo): string {
  if (plugin.managed === 'core') return COPY.alwaysOn
  return plugin.enabled ? COPY.on : COPY.off
}

export function pluginItems(plugins: readonly PluginInfo[], records: readonly PluginPackageSummary[]): Item[] {
  const owned = new Map(records.map(record => [record.id, record]))
  return [
    ...records.map((record): Item => {
      const plugin = plugins.find(item => item.id === record.id)
      return {
        key: `package:${record.id}`,
        kind: 'package',
        record,
        ...(plugin ? { plugin } : {}),
        name: record.name,
        description: record.description,
        state: packageState(record),
        attention: record.unavailableReason !== undefined,
      }
    }),
    ...plugins
      .filter(plugin => !owned.has(plugin.id) && !managedElsewhere(plugin))
      .map((plugin): Item => {
        const words = builtInCopy(plugin)
        return {
          key: `plugin:${plugin.id}`,
          kind: 'plugin',
          plugin,
          name: words?.englishName ?? plugin.name,
          description: words && words.description === plugin.description ? words.englishDescription : plugin.description,
          state: pluginState(plugin),
          attention: false,
        }
      }),
  ]
}

function PluginCard({ item, onSelect, control }: { item: Item; onSelect: (key: string) => void; control: ReactNode }) {
  const titleId = useId()
  const record = item.kind === 'package' ? item.record : undefined
  const enabled = record?.enabled ?? item.plugin?.enabled
  const version =
    record?.appliedRevision && record.revision !== record.appliedRevision
      ? record.appliedVersion
      : (record?.version ?? item.plugin?.version)
  return (
    <li className="plugin-setting-card">
      <button
        type="button"
        className="plugin-nav-row"
        aria-labelledby={titleId + ' ' + titleId + '-action'}
        onClick={() => onSelect(item.key)}>
        <span className="plugin-nav-heading">
          <span className="plugin-nav-name" id={titleId}>
            <VisibleText text={item.name} />
          </span>
          {version && (
            <span className="plugin-nav-version">
              <VisibleText text={'v' + version} />
            </span>
          )}
        </span>
        {item.description && (
          <span className="plugin-nav-description">
            <VisibleText text={item.description} />
          </span>
        )}
        <span className="plugin-nav-link" id={titleId + '-action'}>
          {COPY.details}
          <Icon icon={ChevronRightGlyph} size={12} />
        </span>
      </button>
      <div className="plugin-setting-footer">
        <span className="plugin-nav-state" data-enabled={enabled || undefined} data-attention={item.attention || undefined}>
          {item.state}
        </span>
        {control}
      </div>
    </li>
  )
}

/**
 * One plugin: what it is, what it provides, where its code runs and which devices receive it.
 */
function PluginDetail({
  item,
  busy,
  error,
  reach,
  onRetryReach,
  canEdit,
  status,
  control,
  onEdit,
  onExport,
  pages = [],
  onRollback,
  source,
  onMarketplace,
  creatorDraft,
}: {
  item: Item
  busy: boolean
  error: string
  reach: PluginReach[]
  onRetryReach?: () => void
  canEdit: boolean
  /** A package change under way or with an unknown result. */
  status: ReactNode
  control: ReactNode
  onEdit: (record: PluginPackageSummary) => void
  onExport: (id: string) => Promise<void>
  /** The package's applied pages, from the snapshot. */
  pages?: AppSummary[]
  onRollback?: (record: PluginPackageSummary, revision: string) => void
  source?: PluginPackageReviewSource
  onMarketplace?: () => void
  creatorDraft?: ReactNode
}) {
  const [diagnostics, setDiagnostics] = useState<AppSummary | null>(null)
  const [exportError, setExportError] = useState('')
  // A phone's page has the name in its bar.
  const { phone } = useContext(NavigationContext)
  const plugin = item.plugin
  const record = item.kind === 'package' ? item.record : undefined
  const version = record?.version ?? plugin?.version
  const hasDraft = record !== undefined && record.revision !== record.appliedRevision
  const appliedVersion = record?.appliedVersion ?? (record?.appliedRevision ? plugin?.version : undefined)
  const updateVersion = record?.catalogUpdate?.status === 'available' ? record.catalogUpdate.version : undefined
  const capabilities = record?.capabilities ?? plugin?.capabilities ?? []
  return (
    <>
      {!phone && <SectionHeading title={item.name} />}
      {item.description && (
        <p className="plugin-description">
          <VisibleText text={item.description} />
        </p>
      )}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {exportError && <InlineNotice tone="error">{exportError}</InlineNotice>}
      {record?.unavailableReason && <InlineNotice tone="error">{record.unavailableReason}</InlineNotice>}
      {status}
      {creatorDraft}
      <SettingsGroup title={COPY.settings}>
        {(control || !record) && (
          <SettingsRow
            title={control ? COPY.enablePlugin : item.state}
            description={control && pluginInUseReason(plugin)}
            trailing={control}
          />
        )}
        {appliedVersion && hasDraft && (
          <SettingsRow
            title={COPY.appliedVersion}
            trailing={
              <span className="settings-row-value">
                <VisibleText text={appliedVersion} />
              </span>
            }
          />
        )}
        {version && (
          <SettingsRow
            title={hasDraft ? COPY.draftVersion : record ? COPY.appliedVersion : COPY.version}
            trailing={
              <span className="settings-row-value">
                <VisibleText text={version} />
              </span>
            }
          />
        )}
        {source ? (
          <SettingsRow className="marketplace-fact" title={COPY.source} description={<PluginSourceText source={source} />} />
        ) : (
          plugin
          && !record
          && !plugin.editable && <SettingsRow title={COPY.source} description={plugin.builtIn ? COPY.bundled : COPY.launchPlugin} />
        )}
        {updateVersion && onMarketplace && (
          <SettingsRow
            title={COPY.catalogUpdate}
            description={<VisibleText text={updateVersion} />}
            trailing={
              <Button disabled={busy} onClick={onMarketplace}>
                {COPY.reviewVersion}
              </Button>
            }
          />
        )}
        {capabilities.length > 0 && (
          <SettingsRow title={COPY.provides} trailing={<span className="settings-row-value">{provides(capabilities)}</span>} />
        )}
        {plugin?.editable && !record && <SettingsRow title={COPY.content} description={COPY.editOnMac} />}
        {record && canEdit && (
          <SettingsRow
            title={COPY.content}
            trailing={
              <div className="plugin-asset-actions">
                <Button
                  disabled={busy}
                  onClick={() => {
                    onEdit(record)
                  }}>
                  {COPY.edit}
                </Button>
                <Button
                  disabled={busy}
                  title={COPY.exportScope}
                  onClick={() => {
                    setExportError('')
                    void onExport(record.id).catch(cause => setExportError(inlineError(cause)))
                  }}>
                  {COPY.export}
                </Button>
              </div>
            }
          />
        )}
        {record && canEdit && onRollback && record.rollbackRevisions?.[0] && (
          <SettingsRow
            title={COPY.rollback}
            trailing={
              <Button disabled={busy} onClick={() => onRollback(record, record.rollbackRevisions![0]!.revision)}>
                {COPY.rollBackTo(record.rollbackRevisions[0].version)}
              </Button>
            }
          />
        )}
        {pages.map(page => (
          <SettingsRow
            key={page.appId}
            title={page.title}
            description={COPY.pageSurface}
            trailing={<Button onClick={() => setDiagnostics(page)}>{COPY.diagnostics}</Button>}
          />
        ))}
      </SettingsGroup>
      {diagnostics && <DiagnosticsDialog page={diagnostics} onClose={() => setDiagnostics(null)} />}
      <PluginReachGroup reach={reach} {...(onRetryReach ? { onRetryRead: onRetryReach } : {})} />
    </>
  )
}

export function PluginsSettings({
  snapshot,
  access,
  onChanged,
  onOpenSession,
  onOpenApp,
  initialPluginId,
  initialPluginBundle,
  onMarketplace,
  onAddPlugin,
  onCreatePlugin,
  creatorBlockedReason,
}: {
  snapshot: AppSnapshot
  access: DeviceAccess
  onChanged: () => void
  onOpenSession?: (id: string) => void
  onOpenApp?: (target: { pluginId: string; appId: string }) => void
  initialPluginId?: string
  initialPluginBundle?: PluginPackageBundle | undefined
  onMarketplace?: () => void
  onAddPlugin?: () => void
  onCreatePlugin?: (query?: string) => void
  creatorBlockedReason?: string | undefined
}) {
  useLocale()
  const reasonId = useId()
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
  const [chosen, setChosen] = useState<string | null>(initialPluginId ? `package:${initialPluginId}` : null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [manifestRead, setManifestRead] = useState<{ id: string; revision: string; detail?: PluginPackageDetail } | null>(null)
  const [readAgain, setReadAgain] = useState(0)
  const load = useCallback(async () => {
    try {
      setPlugins((await api<{ plugins: PluginInfo[] }>('plugins')).plugins)
      setError('')
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  const canEdit = canEditPluginPackages(snapshot, access)
  const assets = usePluginAssets({
    canEdit,
    initialBundle: initialPluginBundle,
    onPreview: id => setChosen(`package:${id}`),
    onChanged: () => {
      void load()
      onChanged()
    },
  })

  // A build or an automatic import (开发中) changes the list without this page asking: the snapshot moves with it.
  const reload = assets.reload
  useEffect(() => {
    if (canEdit) reload()
  }, [snapshot.revision, canEdit])
  const appPages = snapshot.catalog?.features?.appPages === 1

  // The switch moving is the feedback; only a failure is said.
  const toggle = async (plugin: PluginInfo) => {
    if (busy !== null) return
    setBusy(plugin.id)
    setError('')
    try {
      setPlugins(
        (
          await api<{ plugins: PluginInfo[] }>(`plugins/${encodeURIComponent(plugin.id)}`, {
            method: 'POST',
            body: { enabled: !plugin.enabled },
          })
        ).plugins,
      )
      onChanged()
    } catch (cause) {
      await load()
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const visiblePlugins = isAppleMobile(navigator)
    ? (plugins ?? []).filter(plugin => !plugin.builtIn || plugin.id !== PLUGIN_MARKETPLACE_PAGE.pluginId)
    : (plugins ?? [])
  const items = pluginItems(visiblePlugins, canEdit ? (assets.records ?? []) : [])
  const selected = items.find(item => item.key === chosen)
  const selectedRecord = selected?.kind === 'package' ? selected.record : undefined
  useEffect(() => {
    if (!selectedRecord) return undefined
    let live = true
    const { id, revision } = selectedRecord
    assets.read(selectedRecord).then(
      detail => {
        if (live) setManifestRead({ id, revision: detail.revision, detail })
      },
      () => {
        if (live) setManifestRead({ id, revision })
      },
    )
    return () => {
      live = false
    }
    // Reads again when the saved content changes; `assets` is new each render.
  }, [selectedRecord?.id, selectedRecord?.revision, selectedRecord?.appliedRevision, readAgain])
  const read =
    manifestRead && manifestRead.id === selectedRecord?.id && manifestRead.revision === selectedRecord.revision ? manifestRead : null
  const reach = selected
    ? selected.kind === 'package'
      ? packageReach(read?.detail?.bundle.manifest, selected.record)
      : pluginReach(selected.plugin)
    : []
  const readFailed = selected?.kind === 'package' && read !== null && read.detail === undefined
  const draftSource =
    read?.detail && isPluginPackageReview(read.detail.review, read.detail.revision) ? read.detail.review.source : undefined

  if (plugins === null) return error ? <InlineNotice tone="error">{error}</InlineNotice> : <Loading label={COPY.loading} />

  const installBlocked = assets.locked ? COPY.finishChange : undefined
  const createBlocked = creatorBlockedReason ?? installBlocked
  const switchFor = (item: Item) => {
    const plugin = item.plugin
    const record = item.kind === 'package' ? item.record : undefined
    if (record ? !canEdit || !record.appliedRevision : !access.admin || !plugin || plugin.managed === 'core' || plugin.editable)
      return undefined
    const reason = pluginInUseReason(plugin)
    return (
      <Switch
        label={COPY.enable(item.name)}
        checked={record?.enabled ?? plugin?.enabled === true}
        disabled={busy !== null || assets.locked || reason !== undefined}
        title={reason}
        onCheckedChange={enabled => {
          if (record) assets.setEnabled(record, enabled)
          else if (plugin) void toggle(plugin)
        }}
      />
    )
  }
  const detail = selected && (
    <PluginDetail
      item={selected}
      busy={busy !== null || assets.locked}
      error={error}
      reach={reach}
      {...(readFailed
        ? {
            onRetryReach: () => {
              setManifestRead(null)
              setReadAgain(count => count + 1)
            },
          }
        : {})}
      canEdit={canEdit}
      status={assets.pageStatus}
      control={switchFor(selected)}
      onEdit={assets.open}
      onExport={assets.exportBundle}
      pages={(snapshot.apps ?? []).filter(page => selected.kind === 'package' && page.pluginId === selected.record.id)}
      onRollback={assets.rollback}
      {...(draftSource ? { source: draftSource } : {})}
      {...(onMarketplace ? { onMarketplace } : {})}
      creatorDraft={
        canEdit
        && selectedRecord && (
          <>
            {(!selectedRecord.source || selectedRecord.source.kind === 'plugin') && read?.detail && (
              <CreatorPluginReview
                key={selectedRecord.id}
                record={selectedRecord}
                bundle={read.detail.bundle}
                locked={assets.locked}
                error={assets.reviewErrorId === selectedRecord.id ? assets.error : ''}
                {...(!(appPages && needsPageBuild(read.detail.bundle.manifest))
                  ? { onApply: () => assets.applyDraft(selectedRecord) }
                  : {})}
                {...(selectedRecord.source?.kind === 'plugin'
                  ? {
                      onUpdate: () => {
                        void assets.updateCreatorDraft(selectedRecord.id, selectedRecord.source!.sessionId).then(updated => {
                          if (updated) setChosen(`package:${updated.id}`)
                        })
                      },
                      ...(onOpenSession && snapshot.tasks.some(task => task.id === selectedRecord.source?.sessionId)
                        ? { onOpenSession: () => onOpenSession(selectedRecord.source!.sessionId) }
                        : {}),
                    }
                  : {})}
              />
            )}
            {appPages
              && (needsPageBuild(read?.detail?.bundle.manifest) || (selectedRecord.source && selectedRecord.source.kind !== 'plugin')) && (
                <AppDraftCard
                  key={selectedRecord.id}
                  record={selectedRecord}
                  snapshot={snapshot}
                  applying={assets.applyingId === selectedRecord.id}
                  reviewLocked={assets.locked}
                  onReview={() => assets.applyDraft(selectedRecord)}
                  onChanged={() => {
                    assets.reload()
                    onChanged()
                  }}
                  {...(onOpenSession ? { onOpenSession } : {})}
                  {...(onOpenApp ? { onOpenApp } : {})}
                />
              )}
          </>
        )
      }
    />
  )
  const assetsError = !assets.locked && assets.error && (
    <InlineNotice
      tone="error"
      action={
        <Button variant="ghost" onClick={assets.retry}>
          {COPY.retry}
        </Button>
      }>
      {assets.error}
    </InlineNotice>
  )
  return (
    <>
      <SettingsPages
        main={
          <>
            {error && !selected && <InlineNotice tone="error">{error}</InlineNotice>}
            {assetsError}
            {!selected && assets.pageStatus}
            {(canEdit || onMarketplace) && (
              <SettingsGroup bare>
                <div className="plugin-asset-actions">
                  {canEdit && onAddPlugin && (
                    <Button variant="primary" icon={PlusGlyph} disabled={assets.locked} onClick={onAddPlugin}>
                      {COPY.add}
                    </Button>
                  )}
                  {canEdit && onCreatePlugin && (
                    <Button
                      variant={onAddPlugin ? 'outline' : 'primary'}
                      disabled={assets.locked || !!createBlocked}
                      aria-describedby={createBlocked ? reasonId : undefined}
                      onClick={() => onCreatePlugin()}>
                      {COPY.create}
                    </Button>
                  )}
                  {canEdit && (
                    <Button icon={Upload} disabled={assets.locked} onClick={assets.importFile}>
                      {COPY.importFile}
                    </Button>
                  )}
                  {canEdit && (
                    <Button variant="ghost" disabled={assets.locked} onClick={assets.newTool}>
                      {COPY.newTool}
                    </Button>
                  )}
                  {onMarketplace && (
                    <Button variant="ghost" disabled={assets.locked} onClick={onMarketplace}>
                      {COPY.browseMarketplace}
                    </Button>
                  )}
                </div>
                {canEdit && onCreatePlugin && createBlocked && (
                  <p className="settings-caption" id={reasonId}>
                    {createBlocked}
                  </p>
                )}
              </SettingsGroup>
            )}
            {!canEdit && appPages && <p className="settings-empty">{COPY.editOnHost(computerName(snapshot.hostName))}</p>}
            {items.length > 0 ? (
              <ul className="plugin-setting-grid" role="list" aria-label={COPY.list}>
                {items.map(item => (
                  <PluginCard key={item.key} item={item} onSelect={setChosen} control={switchFor(item)} />
                ))}
              </ul>
            ) : (
              <EmptyState title={COPY.empty} />
            )}
          </>
        }
        levels={
          selected
            ? [
                {
                  key: selected.key,
                  title: selected.name,
                  onBack: () => {
                    setChosen(null)
                  },
                  content: detail,
                },
              ]
            : []
        }
      />
      {assets.dialogs}
    </>
  )
}
