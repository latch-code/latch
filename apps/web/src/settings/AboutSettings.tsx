import { useMemo, useState } from 'react'
import { AGENT_PRESETS, type AppSnapshot, type TaskSummary } from '@latch/protocol'
import { Shield, TriangleAlert } from 'lucide-react'
import { Button, ButtonLink, DevMark, Hint, Icon, InlineNotice, Meter, StatusWord, SwitchRow } from '@latch/ui'
import type { UpdateView } from '../core/shell.ts'
import { useShellUpdates } from '../core/shellUpdates.ts'
import { formatSize, relativeTime } from '../format.ts'
import { BrandMark } from '../components/ui.tsx'
import type { DeviceAccess } from '../core/permissions.ts'
import { DEV_MODE_TEXT, hostView } from '../core/permissions.ts'
import { computerName, presenceUnavailableText, RUNS_AS_YOU_COPY } from '../core/securityCopy.ts'
import { NavRow, NoteLine, SectionHeading, SettingsGroup, SettingsRow } from './common.tsx'
import { SettingsPages } from './navigation.tsx'

const UPDATE_COPY = {
  versions: '版本',
  app: 'Latch 应用',
  hostHere: '这台 Mac 上的 Host',
  hostOn: (name: string) => `${name} 上的 Host`,
  updates: '更新',
  check: '检查更新',
  checking: '正在检查…',
  notChecked: '尚未检查',
  upToDate: '已是最新版本',
  checkedAt: (when: string) => `检查于 ${when}`,
  newVersion: (version: string) => `新版本 ${version}`,
  download: '下载',
  downloading: (version: string) => `正在下载 ${version}`,
  progress: (received: string, total: string) => `${received} / ${total}`,
  ready: (version: string) => `${version} 已下载`,
  restartInstall: '重启并安装',
  later: '稍后',
  atQuit: '下次退出时安装',
  atQuitChosen: '将在下次退出 Latch 时安装',
  appOnly: '只重启 Latch 应用，会话不受影响',
  hostChange: '包含 Latch 服务的更新',
  hostChangeDetail:
    '安装前会等这台 Mac 上运行中、等你处理和结果未知的会话、排队的消息与终端里的命令结束；等待期间不能开始新会话。安装后数据目录不变。',
  waiting: (count: number) => `等 ${count} 项结束`,
  waitingDetail: (counts: NonNullable<UpdateView['waiting']>) =>
    [
      counts.running && `运行中 ${counts.running}`,
      counts.waiting && `等你处理 ${counts.waiting}`,
      counts.unknown && `结果未知 ${counts.unknown}`,
      counts.queued && `排队 ${counts.queued}`,
      counts.terminals && `终端命令 ${counts.terminals}`,
      counts.services && `本地服务 ${counts.services}（随终端结束）`,
    ]
      .filter(Boolean)
      .join(' · '),
  view: '查看会话',
  hide: '收起',
  cancel: '取消',
  installing: '正在安装…',
  retry: '重试',
  notes: (version: string) => `${version} 更新说明`,
  autoDownload: '自动下载更新',
  autoDownloadDetail: '在后台下载，安装前仍会问你',
  incompatible: (names: string) => `这些插件与新版本不兼容，安装后会停用，资产保留：${names}`,
  held: (names: string) => `更新后已停用不兼容的插件：${names}。资产仍保留，更新插件后可在「插件」中重新启用。`,
  unsupported: '不支持自动更新',
  reason: {
    development: '源码运行，不支持自动更新',
    'not-configured': '这个版本没有配置更新来源',
    unsigned: '这个版本没有签名，macOS 不允许它自行安装更新',
    platform: '目前只在 macOS 上支持自动更新',
  },
  failed: {
    check: '无法检查更新，当前版本照常可用',
    untrusted: '更新信息无法验证，已忽略',
    download: '下载中断，当前版本照常可用',
    verify: '下载的文件校验失败，已删除，没有安装',
    install: '安装没有完成，当前版本照常可用，数据未改动',
    installDetail: '可以重试；仍失败时，退出 Latch 后重新打开再试。',
    hostExternal: '这台 Mac 的 Latch 服务不是由 Latch 应用启动的，请在启动它的终端停止后再安装',
    hostUnreachable: '无法联系这台 Mac 的 Latch 服务，没有安装',
  },
}

export interface UpdateActions {
  check(): void
  download(): void
  install(when: 'now' | 'at-quit'): void
  cancelWaiting(): void
  setAutoDownload(enabled: boolean): void
}

const UNTRUSTED = new Set(['signature', 'feed-format', 'no-asset', 'asset-url'])

/** The failure in a few words, with the detail behind ⓘ for an install that did not finish. */
function failureText(failure: NonNullable<UpdateView['failure']>): { text: string; detail?: string } {
  const copy = UPDATE_COPY.failed
  if (failure.code === 'host-external') return { text: copy.hostExternal }
  if (failure.code === 'host-unreachable') return { text: copy.hostUnreachable }
  if (failure.stage === 'check') return { text: UNTRUSTED.has(failure.code) ? copy.untrusted : copy.check }
  if (failure.stage === 'download') return { text: copy.download }
  if (failure.stage === 'verify') return { text: copy.verify }
  return { text: copy.install, detail: copy.installDetail }
}

/** The sessions an install waits for, from this page's own list. */
function waitingSessions(tasks: readonly TaskSummary[]): TaskSummary[] {
  return tasks.filter(task => task.status === 'running' || task.status === 'waiting-approval')
}

/**
 * Settings › 关于's update area on the desktop app: one row for where the update stands, with at most one primary
 * action, then the release notes and the auto-download switch.
 */
export function UpdateArea({
  view,
  actions,
  tasks = [],
  onOpenSession,
}: {
  view: UpdateView
  actions: UpdateActions
  tasks?: readonly TaskSummary[]
  onOpenSession?: (id: string) => void
}) {
  const [later, setLater] = useState(false)
  const [listing, setListing] = useState(false)
  const release = view.release
  const copy = UPDATE_COPY
  let row
  switch (view.state) {
    case 'unsupported':
      row = (
        <SettingsRow
          title={copy.unsupported}
          description={view.reason ? copy.reason[view.reason] : undefined}
          trailing={<span className="settings-row-value">{view.appVersion}</span>}
        />
      )
      break
    case 'idle':
    case 'checking':
    case 'up-to-date':
      row = (
        <SettingsRow
          title={view.state === 'up-to-date' ? copy.upToDate : view.state === 'checking' ? copy.checking : copy.notChecked}
          description={view.checkedAt && view.state === 'up-to-date' ? copy.checkedAt(relativeTime(view.checkedAt)) : undefined}
          trailing={
            <Button variant="secondary" loading={view.state === 'checking'} onClick={actions.check}>
              {copy.check}
            </Button>
          }
        />
      )
      break
    case 'available':
      row = (
        <SettingsRow
          title={copy.newVersion(release?.version ?? '')}
          description={release ? formatSize(release.size) : undefined}
          trailing={
            <Button variant="primary" onClick={actions.download}>
              {copy.download}
            </Button>
          }
        />
      )
      break
    case 'downloading': {
      const received = view.progress?.received ?? 0
      const total = view.progress?.total ?? release?.size ?? 0
      const words = copy.progress(formatSize(received), formatSize(total))
      row = (
        <SettingsRow
          title={copy.downloading(release?.version ?? '')}
          description={words}
          trailing={<Meter value={received} max={total} label={copy.downloading(release?.version ?? '')} valueText={words} size="md" />}
        />
      )
      break
    }
    case 'ready':
      row = (
        <SettingsRow
          title={copy.ready(release?.version ?? '')}
          description={view.installAtQuit ? copy.atQuitChosen : release?.plan === 'app' ? copy.appOnly : undefined}
          trailing={
            <>
              {!later && !view.installAtQuit && (
                <>
                  <Button variant="ghost" onClick={() => actions.install('at-quit')}>
                    {copy.atQuit}
                  </Button>
                  <Button variant="ghost" onClick={() => setLater(true)}>
                    {copy.later}
                  </Button>
                </>
              )}
              <Button variant={later || view.installAtQuit ? 'secondary' : 'primary'} onClick={() => actions.install('now')}>
                {copy.restartInstall}
              </Button>
            </>
          }
        />
      )
      break
    case 'waiting': {
      const counts = view.waiting ?? { count: 0, running: 0, waiting: 0, unknown: 0, queued: 0, terminals: 0, services: 0 }
      row = (
        <SettingsRow
          title={<StatusWord tone="waiting">{copy.waiting(counts.count)}</StatusWord>}
          description={copy.waitingDetail(counts) || undefined}
          trailing={
            <>
              {onOpenSession && (
                <Button variant="ghost" aria-expanded={listing} onClick={() => setListing(open => !open)}>
                  {listing ? copy.hide : copy.view}
                </Button>
              )}
              <Button variant="secondary" onClick={actions.cancelWaiting}>
                {copy.cancel}
              </Button>
            </>
          }
        />
      )
      break
    }
    case 'installing':
      row = (
        <SettingsRow
          title={copy.installing}
          trailing={
            <Button variant="secondary" loading disabled>
              {copy.restartInstall}
            </Button>
          }
        />
      )
      break
    case 'failed': {
      const failure = view.failure ? failureText(view.failure) : { text: copy.failed.check }
      const stage = view.failure?.stage ?? 'check'
      // A file that failed verification is not fetched again as it was: the retry reads the feed again first.
      const retry =
        stage === 'check' || stage === 'verify' ? actions.check : stage === 'download' ? actions.download : () => actions.install('now')
      row = (
        <SettingsRow
          title={<StatusWord tone="failed">{failure.text}</StatusWord>}
          description={failure.detail}
          trailing={
            <Button variant="secondary" onClick={retry}>
              {copy.retry}
            </Button>
          }
        />
      )
      break
    }
  }
  const showNotes = release && ['available', 'downloading', 'ready', 'waiting', 'installing'].includes(view.state)
  const notes = release ? release.notes['zh-CN'] : ''
  const plugins = release?.incompatiblePlugins ?? []
  return (
    <div className="about-updates" data-update-state={view.state}>
      <SettingsGroup
        title={copy.updates}
        note={
          release?.plan === 'host' && ['available', 'downloading', 'ready'].includes(view.state) ? (
            <NoteLine brief={{ label: copy.hostChange, detail: copy.hostChangeDetail }} />
          ) : undefined
        }>
        {row}
        {view.state === 'waiting' && listing && onOpenSession
          ? waitingSessions(tasks).map(task => (
              <NavRow key={task.id} title={task.title || task.id} onClick={() => onOpenSession(task.id)} />
            ))
          : null}
        {view.state !== 'unsupported' && (
          <SwitchRow
            className="settings-row"
            title={copy.autoDownload}
            description={copy.autoDownloadDetail}
            checked={view.autoDownload}
            onCheckedChange={actions.setAutoDownload}
          />
        )}
      </SettingsGroup>
      {plugins.length > 0 && showNotes && (
        <InlineNotice tone="warn">{copy.incompatible(plugins.map(item => item.name).join('、'))}</InlineNotice>
      )}
      {view.heldPlugins.length > 0 && <InlineNotice>{copy.held(view.heldPlugins.map(item => item.name).join('、'))}</InlineNotice>}
      {showNotes && notes && (
        <SettingsGroup title={copy.notes(release.version)}>
          <p className="about-notes">{notes}</p>
        </SettingsGroup>
      )}
    </div>
  )
}

/** Latch's own licence and those of the engines it can start; the engines are programs of their own, each under its licence. */
function Licences() {
  const engines = useMemo(() => AGENT_PRESETS.toSorted((a, b) => a.name.localeCompare(b.name)), [])
  return (
    <>
      <SectionHeading title="许可与条款" />
      <SettingsGroup>
        <SettingsRow record title="Latch" trailing={<span className="settings-row-value">MIT License</span>} />
      </SettingsGroup>
      <SettingsGroup title="Harness">
        {engines.map(preset => (
          <SettingsRow
            key={preset.id}
            title={preset.name}
            trailing={
              <>
                <span className="settings-row-value">{preset.license}</span>
                {preset.homepage && (
                  <ButtonLink variant="ghost" href={preset.homepage} target="_blank" rel="noreferrer">
                    主页
                  </ButtonLink>
                )}
              </>
            }
          />
        ))}
      </SettingsGroup>
    </>
  )
}

export function AboutSettings({
  snapshot,
  access,
  onOpenSession,
}: {
  snapshot: AppSnapshot
  access: Pick<DeviceAccess, 'legacy'> & Partial<Pick<DeviceAccess, 'local'>>
  onOpenSession?: (id: string) => void
}) {
  const [licences, setLicences] = useState(false)
  const updates = useShellUpdates()
  // The desktop app shows its own version beside the Host's; a browser or a phone sees the Host's only, and nothing to install.
  const desktop = updates.view !== null
  const host = access.legacy ? undefined : hostView(snapshot)
  const dev = host?.devMode === true
  const main = (
    <>
      <header className="about-head">
        <BrandMark size={56} />
        <div>
          <h2>
            Latch
            {dev && <DevMark description={DEV_MODE_TEXT} />}
          </h2>
          {snapshot.version && !desktop && <p>版本 {snapshot.version}</p>}
          {dev && <Hint lead={<Icon icon={TriangleAlert} size={12} />} label={RUNS_AS_YOU_COPY.devMode.label} />}
        </div>
      </header>
      {host?.presence.status === 'unavailable' && <InlineNotice tone="warn">{presenceUnavailableText(host.presence.message)}</InlineNotice>}
      {desktop && updates.view && (
        <SettingsGroup title={UPDATE_COPY.versions}>
          <SettingsRow title={UPDATE_COPY.app} trailing={<span className="settings-row-value">{updates.view.appVersion}</span>} />
          {snapshot.version && (
            <SettingsRow
              title={access.local ? UPDATE_COPY.hostHere : UPDATE_COPY.hostOn(computerName(snapshot.hostName))}
              trailing={<span className="settings-row-value">{snapshot.version}</span>}
            />
          )}
        </SettingsGroup>
      )}
      {desktop && access.local && updates.view && (
        <UpdateArea
          view={updates.view}
          tasks={snapshot.tasks ?? []}
          {...(onOpenSession ? { onOpenSession } : {})}
          actions={{
            check: () => void updates.check(),
            download: () => void updates.download(),
            install: when => void updates.install(when),
            cancelWaiting: () => void updates.cancelWaiting(),
            setAutoDownload: enabled => void updates.setAutoDownload(enabled),
          }}
        />
      )}
      <SettingsGroup
        note={
          <NoteLine icon={Shield} brief={RUNS_AS_YOU_COPY.about(access.local ? '这台 Mac 上' : ` ${computerName(snapshot.hostName)} 上`)} />
        }>
        <SettingsRow
          title="许可与条款"
          trailing={
            <Button
              variant="ghost"
              onClick={() => {
                setLicences(true)
              }}>
              查看
            </Button>
          }
        />
      </SettingsGroup>
    </>
  )
  return (
    <SettingsPages
      main={main}
      levels={
        licences
          ? [
              {
                key: 'licences',
                title: '许可与条款',
                onBack: () => {
                  setLicences(false)
                },
                content: <Licences />,
              },
            ]
          : []
      }
    />
  )
}
