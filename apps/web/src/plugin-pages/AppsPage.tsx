import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  AppWindow,
  BookOpen,
  Bug,
  Calendar,
  ChartColumn,
  ClipboardList,
  Gauge,
  GitPullRequest,
  LayoutDashboard,
  ListChecks,
  MessagesSquare,
  NotebookPen,
  Package,
  Rocket,
  ShieldCheck,
  Star,
  SquareCheckBig,
  SquareKanban,
  Table,
  TestTubeDiagonal,
  Wrench,
} from 'lucide-react'
import {
  ActionMenu,
  Button,
  EmptyState,
  ErrorState,
  ICON_STROKE,
  IconButton,
  InlineNotice,
  Loading,
  Modal,
  ModalHeader,
  type ActionMenuSection,
  type IconComponent,
  ChevronLeftGlyph,
  ChevronRightGlyph,
  CodeGlyph,
  MoreGlyph,
  FileGlyph,
  InboxGlyph,
  SearchGlyph,
  OfflineGlyph,
} from '@latch/ui'
import type { AppDiagnostic, AppMigrationLease, AppSummary, PluginPackageDetail } from '@latch/protocol'
import { api, inlineError, isUncertain, newRequestId, type ApiOptions } from '../core/api.ts'
import { withConfirmation } from '../core/confirmations.ts'
import { computerName } from '../core/securityCopy.ts'
import { useBackLayer } from '../hooks/backStack.ts'
import { NavTop, NewSessionRow, ShellNewAgent, ShellNavFoot, shellSpaces } from '../shell/SpaceNav.tsx'
import { SidebarComputer } from '../shell/WorkbenchNav.tsx'
import { settingsSections } from '../settings/SettingsPage.tsx'
import {
  PluginMutationDialog,
  PluginWriteFeedback,
  reviewedPluginMutation,
  type PluginMutationTarget,
} from '../settings/PluginMutationReview.tsx'
import type { ShellState } from '../shell/useShellLayout.tsx'
import type { AppTarget } from '../shell/routes.ts'
import { AppFrame, hostInfo, reportDiagnostic, type FrameOutcome } from './AppFrame.tsx'
import { appRef, fallbackVersion, findApp, listedApps, openStep, type PageVersion } from './model.ts'
import { useShellTheme } from '../hooks/useShellTheme.ts'
import { useSecureCover } from './secureCover.ts'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    apps: '应用',
    notFound: '找不到这个页面',
    backToApps: '回到应用',
    reload: '重新加载',
    diagnostics: '诊断',
    disable: '停用',
    showDiagnostics: '查看诊断',
    disabled: '插件已停用',
    migrating: '正在更新数据…',
    newerData: '数据比这个版本新',
    pluginSettings: '打开插件设置',
    unbuilt: '页面还没有构建',
    migrationNeeded: '数据需要更新',
    viewOnly: '这台设备只能查看',
    migrationFailed: '数据更新没成功',
    openFailed: '页面没有打开',
    opening: '正在打开页面…',
    back: '返回',
    offline: '不在线',
    actions: '页面操作',
    usingOld: '新版本没有打开，正在显示上一个版本',
    reading: '正在读取…',
    noDiagnostics: '没有诊断',
    unknownChange: '修改结果尚未确认。',
    retrySame: '重试同一请求',
    plugin: (name: string, version?: string) => `插件 · ${name}${version ? ` ${version}` : ''}`,
    rollback: (version: string) => `回退到 ${version}`,
    editOn: (computer: string) => `在 ${computer} 上修改`,
    diagnosticsFor: (title: string) => `${title} 的诊断`,
  },
  {
    apps: 'Apps',
    notFound: 'Page not found',
    backToApps: 'Back to Apps',
    reload: 'Reload',
    diagnostics: 'Diagnostics',
    disable: 'Disable',
    showDiagnostics: 'View diagnostics',
    disabled: 'Plugin disabled',
    migrating: 'Updating data…',
    newerData: 'This page’s data is newer',
    pluginSettings: 'Open plugin settings',
    unbuilt: 'Page hasn’t been built',
    migrationNeeded: 'Data needs an update',
    viewOnly: 'This device is read only',
    migrationFailed: 'Data update failed',
    openFailed: 'Page couldn’t open',
    opening: 'Opening page…',
    back: 'Back',
    offline: 'Offline',
    actions: 'Page actions',
    usingOld: 'The new version couldn’t open. Showing the previous version.',
    reading: 'Loading…',
    noDiagnostics: 'No diagnostics',
    unknownChange: 'The outcome is unknown.',
    retrySame: 'Retry same request',
    plugin: (name: string, version?: string) => `Plugin · ${name}${version ? ` ${version}` : ''}`,
    rollback: (version: string) => `Roll back to ${version}`,
    editOn: (computer: string) => `Edit on ${computer}`,
    diagnosticsFor: (title: string) => `Diagnostics for ${title}`,
  },
)

const ICONS: Record<string, IconComponent> = {
  'list-checks': ListChecks,
  'clipboard-list': ClipboardList,
  'layout-dashboard': LayoutDashboard,
  'chart-column': ChartColumn,
  'file-text': FileGlyph,
  'git-pull-request': GitPullRequest,
  bug: Bug,
  rocket: Rocket,
  calendar: Calendar,
  'notebook-pen': NotebookPen,
  table: Table,
  gauge: Gauge,
  'square-kanban': SquareKanban,
  search: SearchGlyph,
  sparkles: Star,
  'flask-conical': TestTubeDiagonal,
  'shield-check': ShieldCheck,
  package: Package,
  wrench: Wrench,
  'square-check-big': SquareCheckBig,
  'messages-square': MessagesSquare,
  inbox: InboxGlyph,
  'book-open': BookOpen,
}

/** A page's icon from its manifest when Latch carries it, otherwise the neutral window. */
function AppIcon({ name, size = 16 }: { name: string | undefined; size?: 14 | 16 | 20 }) {
  const Glyph = (name && ICONS[name]) || AppWindow
  return <Glyph size={size} nonScalingStroke strokeWidth={ICON_STROKE[size]} aria-hidden="true" />
}

/** The sidebar's 「应用」 group: one row per page, its icon and title. Gone the moment a page is disabled or removed. */
function AppsGroup({ shell, current }: { shell: ShellState; current?: AppTarget | undefined }) {
  const pages = listedApps(shell.snapshot)
  if (!pages.length) return null
  return (
    <div className="sidebar-apps" role="group" aria-label={COPY.apps}>
      <h2 className="sidebar-apps-head">{COPY.apps}</h2>
      {pages.map(page => (
        <button
          key={appRef(page)}
          type="button"
          className="sidebar-nav-row sidebar-app"
          aria-current={current?.pluginId === page.pluginId && current.appId === page.appId ? 'page' : undefined}
          onClick={() => {
            shell.openApp({ pluginId: page.pluginId, appId: page.appId })
          }}>
          <AppIcon name={page.icon} />
          <span>{page.title}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * The sidebar's place on wide windows while a page is open: the sidebar's top in the place last shown (choosing either
 * leaves 应用 for it), the pages, and the shared foot.
 */
function AppsNav({ shell, current }: { shell: ShellState; current: AppTarget | undefined }) {
  const spaces = shellSpaces(shell)
  return (
    <div className="sidebar-body apps-nav-body">
      <NavTop
        className="apps-nav-top"
        snapshot={shell.snapshot}
        spaces={spaces && { ...spaces, onSpace: shell.goSpace }}
        primary={
          shell.space === 'agents' && spaces ? (
            <ShellNewAgent shell={shell} />
          ) : (
            <NewSessionRow onNew={shell.startNew} active={false} drawer={false} />
          )
        }
        onSearch={shell.openSearch}
        drawer={false}
        computer={computers => <SidebarComputer shell={shell} computers={computers} />}
      />
      {!spaces && (
        <button
          type="button"
          className="sidebar-nav-row apps-nav-code"
          onClick={() => {
            shell.goEntry('sessions')
          }}>
          <CodeGlyph size={16} nonScalingStroke strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
          <span>Code</span>
        </button>
      )}
      <nav className="space-list" aria-label={COPY.apps}>
        <AppsGroup shell={shell} current={current} />
      </nav>
      <ShellNavFoot shell={shell} />
    </div>
  )
}

/**
 * 应用: plugin pages. On wide windows the list of pages stands where the sidebar stands and the page fills the work panel
 * under its own header; on phones the list is the root page and a page is pushed over it. Like 设置 and 我的 Agent it
 * covers the session's columns without unmounting them, so the session, its draft and its reading position stay.
 */
export function AppsPage({ shell }: { shell: ShellState }) {
  const { snapshot, route, phone, titleSlot } = shell
  const pages = listedApps(snapshot)
  const target = route.app ?? (phone ? undefined : pages[0] && { pluginId: pages[0].pluginId, appId: pages[0].appId })
  const page = target && findApp(snapshot, target.pluginId, target.appId)
  const pushed = phone && route.app !== undefined
  const back = () => {
    shell.openApp()
  }
  useBackLayer(pushed, back)
  const escape = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || !pushed || event.defaultPrevented) return
    if (event.target instanceof Element && event.target.closest('dialog, [popover]')) return
    back()
  }
  return (
    <section aria-label={COPY.apps} className="settings-page apps-page" data-entry="apps" onKeyDown={escape}>
      {!phone && titleSlot && createPortal(<span className="titlebar-page-title">{COPY.apps}</span>, titleSlot)}
      <div className="settings-layout" data-level={phone ? (pushed ? 'section' : 'root') : undefined}>
        <div className="settings-nav-pane" inert={pushed || undefined}>
          {phone ? (
            <>
              <header className="settings-bar">
                <span />
                <h2>{COPY.apps}</h2>
              </header>
              <div className="settings-scroll">
                <ul className="apps-list">
                  {pages.map(item => (
                    <li key={appRef(item)}>
                      <button
                        type="button"
                        className="apps-list-row"
                        onClick={() => {
                          shell.openApp({ pluginId: item.pluginId, appId: item.appId })
                        }}>
                        <span className="apps-list-icon">
                          <AppIcon name={item.icon} size={20} />
                        </span>
                        <span className="apps-list-text">
                          <span className="apps-list-title">{item.title}</span>
                          <span className="apps-list-meta">{COPY.plugin(item.pluginName)}</span>
                        </span>
                        <ChevronRightGlyph size={16} nonScalingStroke strokeWidth={ICON_STROKE[16]} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          ) : (
            <AppsNav shell={shell} current={target} />
          )}
        </div>
        <section
          className="settings-panel apps-panel"
          aria-label={page?.title ?? COPY.apps}
          aria-hidden={(phone && !pushed) || undefined}
          inert={(phone && !pushed) || undefined}>
          {(!phone || pushed)
            && (page ? (
              <AppView key={appRef(page)} shell={shell} page={page} onBack={phone ? back : undefined} />
            ) : (
              <EmptyState title={COPY.notFound} action={<Button onClick={back}>{COPY.backToApps}</Button>} />
            ))}
        </section>
      </div>
    </section>
  )
}

type Phase = { kind: 'loading' } | { kind: 'ready' } | { kind: 'failed' } | { kind: 'migrating' } | { kind: 'migration-failed' }

/** Pending management changes keep their request ID until the Host has answered. */
interface PendingChange {
  path: string
  options: ApiOptions
}

/** One page: its header (title, 「插件 · 名称 版本」, ⋯) over the frame, or the state that stands in for it. */
function AppView({ shell, page, onBack }: { shell: ShellState; page: AppSummary; onBack?: (() => void) | undefined }) {
  const { snapshot, connection, access } = shell
  const online = connection === 'connected'
  const canRun = access.scopes.has('run')
  // Managing plugins is this Mac's: the same devices that see 设置 › 插件.
  const manager = settingsSections(snapshot, access).includes('plugins') && access.local
  const theme = useShellTheme()
  const covered = useSecureCover()
  const [attempt, setAttempt] = useState(0)
  /** Failed opens since mount, a new version or 重新加载; a page drawing in between does not reset them. */
  const failures = useRef(0)
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [diagnostics, setDiagnostics] = useState(false)
  const [lease, setLease] = useState<AppMigrationLease | undefined>()
  const [detail, setDetail] = useState<PluginPackageDetail | undefined>()
  const [pending, setPending] = useState<PendingChange | null>(null)
  const [reviewTarget, setReviewTarget] = useState<PluginMutationTarget | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const version = `${page.revision}:${page.bundleHash ?? ''}:${page.status}`
  /** The version last drawn here, and the earlier one shown after a new version would not open. */
  const lastDrawn = useRef<PageVersion | null>(null)
  const [fallback, setFallback] = useState<PageVersion | null>(null)
  // A new version, or a page that came back, starts fresh: three more tries.
  useEffect(() => {
    failures.current = 0
    setPhase({ kind: 'loading' })
    setLease(undefined)
    setFallback(null)
  }, [version])
  useEffect(() => () => clearTimeout(retry.current), [])
  useEffect(() => {
    if (!manager) return
    let live = true
    void api<{ package: PluginPackageDetail }>(`plugin-packages/${encodeURIComponent(page.pluginId)}`).then(
      result => {
        if (live) setDetail(result.package)
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [manager, page.pluginId, page.revision])

  const reload = () => {
    clearTimeout(retry.current)
    setFallback(null)
    failures.current = 0
    setPhase({ kind: 'loading' })
    setLease(undefined)
    setAttempt(value => value + 1)
  }
  const outcome = (result: FrameOutcome) => {
    if (result.kind === 'ready') {
      if (!fallback && page.bundleHash) lastDrawn.current = { revision: page.revision, bundleHash: page.bundleHash }
      setPhase({ kind: 'ready' })
      return
    }
    if (result.kind === 'migrated') {
      void commitMigration(result.documents)
      return
    }
    if (result.kind === 'migrate-failed') {
      reportDiagnostic(page, 'runtime', `数据更新失败：${result.message}`)
      setPhase({ kind: 'migration-failed' })
      return
    }
    // A new version that will not open: back to the one this tab last drew, which the Host still serves.
    const back = fallbackVersion(lastDrawn.current, page, fallback !== null)
    if (back && result.kind === 'failed') {
      if (online) reportDiagnostic(page, result.source, `新版本没有打开，回到上一个版本：${result.message}`)
      setFallback(back)
      failures.current = 0
      setPhase({ kind: 'loading' })
      setAttempt(value => value + 1)
      return
    }
    const step = openStep(failures.current, 'failed')
    failures.current = step.failures
    if (step.next === 'give-up') setPhase({ kind: 'failed' })
    else {
      setPhase({ kind: 'loading' })
      retry.current = setTimeout(() => {
        setAttempt(value => value + 1)
      }, 600)
    }
  }
  const commitMigration = async (documents: Array<{ scope: string; key: string; value: unknown }>) => {
    if (!lease) return
    try {
      await api(`apps/${encodeURIComponent(page.pluginId)}/data/migrate`, {
        method: 'POST',
        timeoutMs: 60_000,
        body: {
          via: { app: appRef(page), revision: page.revision },
          requestId: newRequestId(),
          lease: lease.lease,
          fromGeneration: lease.fromGeneration,
          toVersion: lease.toVersion,
          documents,
        },
      })
      setLease(undefined)
      await shell.refresh()
    } catch {
      setPhase({ kind: 'migration-failed' })
    }
  }
  // Data older than the code: this device takes the lease once per try and runs the page's migrate in a hidden frame.
  const asked = useRef('')
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    [],
  )
  useEffect(() => {
    const ask = `${version}:${attempt}`
    if (page.status !== 'needs-migration' || !canRun || !online || !page.bundleHash || asked.current === ask) return
    asked.current = ask
    setPhase({ kind: 'migrating' })
    void api<AppMigrationLease>(`apps/${encodeURIComponent(page.pluginId)}/data/migrate/lease`, {
      method: 'POST',
      body: { via: { app: appRef(page), revision: page.revision } },
    }).then(
      granted => {
        if (alive.current && asked.current === ask) setLease(granted)
      },
      () => {
        if (alive.current && asked.current === ask) setPhase({ kind: 'migration-failed' })
      },
    )
  }, [version, attempt, page.status, canRun, online, page.bundleHash])

  const change = async (next: PendingChange) => {
    if (busy || (pending && next !== pending) || !manager || !online) return
    setBusy(true)
    setError('')
    setPending(next)
    try {
      await withConfirmation(confirmation => api(next.path, { ...next.options, ...(confirmation ? { confirmation } : {}) }))
      setPending(null)
      setReviewTarget(null)
      await shell.refresh()
      reload()
    } catch (cause) {
      if (!isUncertain(cause)) setPending(null)
      setError(inlineError(cause))
    } finally {
      setBusy(false)
    }
  }
  const previous = detail?.appliedRevision === page.revision ? detail.rollbackRevisions?.[0] : undefined
  const manageLocked = busy || pending !== null || !online || reviewTarget !== null
  const disable = () => {
    void change({
      path: `plugin-packages/${encodeURIComponent(page.pluginId)}/enabled`,
      options: { method: 'POST', body: { requestId: newRequestId(), enabled: false } },
    })
  }
  const rollback = () => {
    if (!previous || manageLocked || !manager) return
    setError('')
    setReviewTarget({ operation: 'rollback', id: page.pluginId, name: page.pluginName, revision: previous.revision })
  }
  const sections: ActionMenuSection[] = [
    {
      id: 'page',
      items: [
        { id: 'reload', label: COPY.reload, onSelect: reload },
        {
          id: 'diagnostics',
          label: COPY.diagnostics,
          onSelect: () => {
            setDiagnostics(true)
          },
        },
      ],
    },
    ...(manager
      ? [
          {
            id: 'manage',
            items: [
              { id: 'disable', label: COPY.disable, disabled: manageLocked, onSelect: disable },
              ...(previous ? [{ id: 'rollback', label: COPY.rollback(previous.version), disabled: manageLocked, onSelect: rollback }] : []),
            ],
          },
        ]
      : [
          {
            id: 'manage',
            // Building, applying, turning off and going back happen on the Mac that runs the Host.
            items: [{ id: 'elsewhere', label: COPY.editOn(computerName(snapshot.hostName)), disabled: true, onSelect: () => {} }],
          },
        ]),
  ]
  const info = hostInfo(theme, online, canRun, {
    harnesses: (snapshot.catalog?.harnesses ?? []).map(harness => ({ id: harness.id, name: harness.capabilities.display.label })),
  })
  // Esc in the frame is the page's way back on a phone, and nothing else.
  const escapeFrame = () => {
    if (onBack && !document.querySelector('dialog[open], :popover-open')) onBack()
  }
  const manageActions = manager && (
    <>
      <Button variant="outline" disabled={manageLocked} onClick={disable}>
        {COPY.disable}
      </Button>
      {previous && (
        <Button variant="outline" disabled={manageLocked} onClick={rollback}>
          {COPY.rollback(previous.version)}
        </Button>
      )}
    </>
  )
  const showDiagnostics = (
    <Button
      variant="outline"
      onClick={() => {
        setDiagnostics(true)
      }}>
      {COPY.showDiagnostics}
    </Button>
  )

  let body
  if (page.status === 'disabled') body = <EmptyState title={COPY.disabled} />
  else if (page.status === 'migrating') body = <Loading variant="page" label={COPY.migrating} />
  else if (page.status === 'data-newer')
    body = (
      <ErrorState
        title={COPY.newerData}
        actions={
          manager ? (
            <Button
              variant="outline"
              onClick={() => {
                shell.openSettings('plugins')
              }}>
              {COPY.pluginSettings}
            </Button>
          ) : undefined
        }
      />
    )
  else if (!page.bundleHash) body = <EmptyState title={COPY.unbuilt} />
  else if (page.status === 'needs-migration' && !canRun) body = <EmptyState title={COPY.migrationNeeded} description={COPY.viewOnly} />
  else if (phase.kind === 'migration-failed')
    body = (
      <ErrorState
        title={COPY.migrationFailed}
        actions={
          <>
            {showDiagnostics}
            {manager && previous && (
              <Button variant="outline" disabled={manageLocked} onClick={rollback}>
                {COPY.rollback(previous.version)}
              </Button>
            )}
          </>
        }
      />
    )
  else if (phase.kind === 'failed')
    body = (
      <ErrorState
        title={COPY.openFailed}
        actions={
          <>
            <Button variant="primary" onClick={reload}>
              {COPY.reload}
            </Button>
            {showDiagnostics}
            {manageActions}
          </>
        }
      />
    )
  else if (page.status === 'needs-migration')
    body = (
      <>
        <Loading variant="page" label={COPY.migrating} />
        {lease && (
          <AppFrame
            key={`migrate:${attempt}`}
            page={{ ...page, bundleHash: page.bundleHash }}
            snapshot={snapshot}
            online={online}
            info={info}
            covered={covered}
            migration={lease}
            onOutcome={outcome}
            onOpenSession={shell.choose}
            onShortcut={shell.frameShortcut}
            onEscape={escapeFrame}
          />
        )}
      </>
    )
  else
    body = (
      <>
        {phase.kind !== 'ready' && <Loading variant="page" label={COPY.opening} />}
        <AppFrame
          key={`${version}:${attempt}`}
          page={{ ...page, bundleHash: page.bundleHash, ...(fallback ?? {}) }}
          snapshot={snapshot}
          online={online}
          info={info}
          covered={covered}
          onOutcome={outcome}
          onOpenSession={shell.choose}
          onShortcut={shell.frameShortcut}
          onEscape={escapeFrame}
        />
      </>
    )

  return (
    <div className="app-page" data-phase={phase.kind} data-covered={covered ? '' : undefined}>
      <header className="app-page-head">
        {onBack && <IconButton size="lg" label={COPY.back} icon={ChevronLeftGlyph} onClick={onBack} />}
        <span className="app-page-icon">
          <AppIcon name={page.icon} />
        </span>
        <div className="app-page-title">
          <h1>{page.title}</h1>
          <span className="app-page-plugin">{COPY.plugin(page.pluginName, page.version)}</span>
        </div>
        {!online && (
          <span className="app-page-offline">
            <OfflineGlyph size={12} nonScalingStroke strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
            {COPY.offline}
          </span>
        )}
        <ActionMenu
          label={COPY.actions}
          placement="bottom-end"
          sections={sections}
          trigger={props => <IconButton {...props} icon={MoreGlyph} label={COPY.actions} />}
        />
      </header>
      {error && (
        <InlineNotice
          tone="error"
          className="app-page-error"
          onClose={() => {
            setError('')
          }}>
          {error}
        </InlineNotice>
      )}
      {manager && !reviewTarget && <PluginWriteFeedback busy={busy} uncertain={false} />}
      {manager && pending && !busy && (
        <InlineNotice
          tone="warn"
          className="app-page-error"
          action={
            <Button disabled={!online} onClick={() => void change(pending)}>
              {COPY.retrySame}
            </Button>
          }>
          {COPY.unknownChange}
        </InlineNotice>
      )}
      {fallback && (
        <InlineNotice
          tone="warn"
          className="app-page-error"
          action={
            <Button variant="ghost" onClick={reload}>
              {COPY.reload}
            </Button>
          }>
          {COPY.usingOld}
        </InlineNotice>
      )}
      <div className="app-page-body">{body}</div>
      {manager && online && reviewTarget && (
        <PluginMutationDialog
          target={reviewTarget}
          busy={busy}
          failure={error}
          retryRequest={pending ? () => void change(pending) : undefined}
          onClose={() => setReviewTarget(null)}
          onConfirm={review => {
            const request = reviewedPluginMutation(reviewTarget, review)
            void change(request)
          }}
        />
      )}
      {diagnostics && (
        <DiagnosticsDialog
          page={page}
          onClose={() => {
            setDiagnostics(false)
          }}
        />
      )}
    </div>
  )
}

const SOURCE_LABEL = defineCopy<Record<AppDiagnostic['source'], string>>(
  { build: '构建', runtime: '运行', handshake: '打开', bridge: '能力', migration: '数据' },
  { build: 'Build', runtime: 'Run', handshake: 'Open', bridge: 'Capabilities', migration: 'Data' },
)

/** The page's last diagnostics, newest first, as the Host keeps them (redacted, at most 2 KiB each). */
export function DiagnosticsDialog({ page, onClose }: { page: AppSummary; onClose: () => void }) {
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'ready'; items: AppDiagnostic[] } | { kind: 'failed'; message: string }>(
    {
      kind: 'loading',
    },
  )
  useEffect(() => {
    let live = true
    void api<{ diagnostics: AppDiagnostic[] }>(
      `apps/${encodeURIComponent(page.pluginId)}/diagnostics?app=${encodeURIComponent(appRef(page))}&revision=${page.revision}`,
    ).then(
      result => {
        if (live) setState({ kind: 'ready', items: result.diagnostics.toReversed() })
      },
      (cause: unknown) => {
        if (live) setState({ kind: 'failed', message: inlineError(cause) })
      },
    )
    return () => {
      live = false
    }
  }, [page.pluginId, page.appId, page.revision])
  return (
    <Modal label={COPY.diagnosticsFor(page.title)} onClose={onClose} className="app-diagnostics">
      <ModalHeader title={COPY.diagnostics} onClose={onClose} />
      <div className="app-diagnostics-body">
        {state.kind === 'loading' && <Loading label={COPY.reading} />}
        {state.kind === 'failed' && <InlineNotice tone="error">{state.message}</InlineNotice>}
        {state.kind === 'ready' && state.items.length === 0 && <EmptyState title={COPY.noDiagnostics} />}
        {state.kind === 'ready' && state.items.length > 0 && (
          <ol className="app-diagnostics-list">
            {state.items.map(item => (
              <li key={item.id}>
                <span className="app-diagnostics-meta">
                  <span>{SOURCE_LABEL[item.source]}</span>
                  {item.code && <code>{item.code}</code>}
                  <time dateTime={item.at}>{new Date(item.at).toLocaleString('zh-CN', { hour12: false })}</time>
                </span>
                <span className="app-diagnostics-message">{item.message}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Modal>
  )
}
