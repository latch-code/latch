import { useEffect, useRef, useSyncExternalStore } from 'react'
import { Button, CopyButton, Hint, Icon, IconButton, Popover, RefreshGlyph, Spinner, useLayerClose, useLayerOpen } from '@latch/ui'
import { api } from '../core/api.ts'
import {
  PAGE_BUILD,
  buildStatus,
  buildStatusWords,
  harnessUpdateItems,
  oldHostWords,
  readServedBuild,
  shortBuild,
  type BuildStatus,
  type HarnessUpdateItem,
} from '../core/build.ts'
import { useShellUpdates } from '../core/shellUpdates.ts'
import { MarkTile } from '../components/BrandTile.tsx'
import { TerminalFillButton } from '../components/TerminalFillButton.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import type { ShellState } from './useShellLayout.tsx'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    check: '检查更新',
    checking: '正在检查',
    current: '已是最新',
    build: (build: string) => `构建 ${build}`,
    development: '开发运行',
    noBuild: '无构建号',
    failed: '未能检查',
    page: '有新版页面',
    reload: '重新载入',
    updateVersion: (version: string) => `Latch ${version} 可更新`,
    update: 'Latch 有更新',
    view: '查看',
    confirm: '确认',
    restartHelp: '怎么重启',
    restart: '重启 Latch',
    harnesses: 'Harness',
    manage: '设置',
    needsUpgrade: '需要升级',
    needsConfirm: '需要确认',
    programMoved: '命令找到了另一个程序',
    copyUpdate: '复制升级命令',
    openHarness: (name: string) => `在设置中打开 ${name}`,
  },
  {
    check: 'Check for updates',
    checking: 'Checking…',
    current: 'Up to date',
    build: (build: string) => `Build ${build}`,
    development: 'Development build',
    noBuild: 'No build number',
    failed: 'Couldn’t check for updates',
    page: 'New page version',
    reload: 'Reload',
    updateVersion: (version: string) => `Latch ${version} available`,
    update: 'Latch update available',
    view: 'View',
    confirm: 'Confirm',
    restartHelp: 'How to restart',
    restart: 'Restart Latch',
    harnesses: 'Harnesses',
    manage: 'Settings',
    needsUpgrade: 'Update required',
    needsConfirm: 'Needs confirmation',
    programMoved: 'Command points to a different binary',
    copyUpdate: 'Copy update command',
    openHarness: (name: string) => `Open ${name} in Settings`,
  },
)

/**
 * The served build and external Harness updates, read once per page/Host and again on every click, shared by every
 * 检查更新 on the page (the sidebar's foot in both places, the rail and the top bar), so one read answers all of them.
 */
let state: { served: string | null | undefined; checking: boolean; harnessChecking: boolean } = {
  served: undefined,
  checking: false,
  harnessChecking: false,
}
let readOnce = false
const readHarnessHosts = new Set<string>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function set(next: Partial<typeof state>) {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

async function checkHarnesses(recheck: boolean, refresh: () => Promise<unknown>) {
  await api(recheck ? 'agents' : 'agents?recheck=0')
  await refresh()
}

async function recheck(options?: {
  alsoApp?: (() => Promise<unknown>) | undefined
  harnesses?: { recheck: boolean; refresh: () => Promise<unknown> } | undefined
}) {
  if (state.checking || state.harnessChecking) return
  set({ checking: true, harnessChecking: Boolean(options?.harnesses) })
  const [served] = await Promise.all([
    readServedBuild(),
    options?.alsoApp?.().catch(() => {}),
    options?.harnesses ? checkHarnesses(options.harnesses.recheck, options.harnesses.refresh).catch(() => {}) : undefined,
  ])
  set({ served, checking: false, harnessChecking: false })
}

async function recheckHarnessesOnce(refresh: () => Promise<unknown>) {
  if (state.checking || state.harnessChecking) return
  set({ harnessChecking: true })
  await checkHarnesses(false, refresh).catch(() => {})
  set({ harnessChecking: false })
}

/** 重启 Latch as the banner and the update popover offer it: main's own rules decide, and its refusal is the toast. */
export function restartLatch(shell: Pick<ShellState, 'lifecycle' | 'setToast'>) {
  void shell.lifecycle.restartHost().then(message => {
    if (message) shell.setToast({ text: message, tone: 'error' })
  })
}

/**
 * 检查更新: a refresh glyph that compares this page's build with the one the Host serves now and the one it started
 * beside, asks the desktop app's own updater, and for an admin device also checks saved external Harnesses. Spinning
 * while it checks, an amber dot when something newer or actionable is ready; the click checks again and opens what can
 * be done about it, under each action's own rules.
 */
function UpdateCheck({
  hostId,
  hostBuild,
  computer,
  harnesses,
  editableHarnesses = false,
  refresh,
  restart,
  openAbout,
  openHarnesses,
  openAgent,
}: {
  hostId?: string | undefined
  /** `AppSnapshot.build`: the page that was beside the Host when it started. */
  hostBuild: string | undefined
  /** The computer's name for the old-Host words (`computerLabel`). */
  computer: string
  harnesses: readonly HarnessUpdateItem[]
  /** At least one saved, enabled external Harness can be checked by this admin device. */
  editableHarnesses?: boolean | undefined
  refresh?: (() => Promise<unknown>) | undefined
  /** Only the Latch app on that Mac restarts its Host. */
  restart?: (() => void) | undefined
  /** Settings › 关于, where the desktop app's own update moves on. */
  openAbout?: (() => void) | undefined
  /** Settings › Harness, where every external Harness is managed. */
  openHarnesses?: (() => void) | undefined
  /** Settings › Harness › `<id>`, for confirming a moved binary or inspecting a Harness. */
  openAgent?: ((id: string) => void) | undefined
}) {
  const { served, checking, harnessChecking } = useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  )
  const updates = useShellUpdates()
  const view = updates.view
  const app = view && view.state !== 'unsupported' ? { state: view.state, version: view.release?.version } : null
  useEffect(() => {
    const canAskHarnesses = Boolean(editableHarnesses && refresh && hostId && !readHarnessHosts.has(hostId))
    if (!readOnce) {
      readOnce = true
      if (canAskHarnesses && hostId) readHarnessHosts.add(hostId)
      void recheck({
        harnesses: canAskHarnesses && refresh ? { recheck: false, refresh } : undefined,
      })
      return
    }
    if (canAskHarnesses && hostId && refresh) {
      readHarnessHosts.add(hostId)
      void recheckHarnessesOnce(refresh)
    }
  }, [editableHarnesses, hostId, refresh])
  const status = buildStatus({ page: PAGE_BUILD, host: hostBuild, served, checking, harnessChecking, app })
  const words = buildStatusWords(status, harnesses)
  return (
    <Popover
      label={COPY.check}
      side="auto"
      align="end"
      size={harnesses.length > 0 && status.kind !== 'checking' ? 'md' : 'sm'}
      onOpenChange={open => {
        if (open)
          void recheck({
            alsoApp: app ? () => updates.check() : undefined,
            harnesses: editableHarnesses && refresh ? { recheck: true, refresh } : undefined,
          })
      }}
      trigger={props => (
        <IconButton
          {...props}
          className="update-check"
          label={COPY.check}
          icon={RefreshGlyph}
          tooltip={words.tooltip}
          busy={status.kind === 'checking'}
          {...(words.dot ? { badge: <span className="icon-dot" /> } : {})}
        />
      )}>
      <UpdateCheckBody
        status={status}
        computer={computer}
        harnesses={harnesses}
        restart={restart}
        openAbout={openAbout}
        openHarnesses={openHarnesses}
        openAgent={openAgent}
      />
    </Popover>
  )
}

function HarnessUpdateRow({ item, openAgent }: { item: HarnessUpdateItem; openAgent?: ((id: string) => void) | undefined }) {
  const close = useLayerClose()
  const flag = item.kind === 'outdated' ? COPY.needsUpgrade : item.kind === 'moved' ? COPY.needsConfirm : undefined
  const meta = item.kind === 'outdated' ? item.need : item.kind === 'moved' ? COPY.programMoved : `${item.current} → ${item.latest}`
  const text = (
    <>
      <span className="update-check-item-head">
        <span className="update-check-title">
          <VisibleText text={item.name} />
        </span>
        {flag && <span className="update-check-flag">{flag}</span>}
      </span>
      <span className="update-check-meta">{meta}</span>
    </>
  )
  return (
    <div className="update-check-item">
      <MarkTile mark={item.mark} cold={item.kind !== 'update'} size={16} />
      {openAgent ? (
        <button
          type="button"
          className="update-check-item-main"
          aria-label={COPY.openHarness(item.name)}
          onClick={() => {
            close()
            openAgent(item.id)
          }}>
          {text}
        </button>
      ) : (
        <div className="update-check-item-main">{text}</div>
      )}
      {item.kind !== 'moved' && item.command ? (
        <span className="command-actions">
          <CopyButton text={item.command} label={COPY.copyUpdate} />
          <TerminalFillButton command={item.command} detached />
        </span>
      ) : openAgent ? (
        <Button
          size="xs"
          onClick={() => {
            close()
            openAgent(item.id)
          }}>
          {item.kind === 'moved' ? COPY.confirm : COPY.view}
        </Button>
      ) : null}
    </div>
  )
}

/** What was found, for Latch itself and any actionable external Harnesses. */
export function UpdateCheckBody({
  status,
  computer,
  harnesses = [],
  restart,
  openAbout,
  openHarnesses,
  openAgent,
}: {
  status: BuildStatus
  computer: string
  harnesses?: readonly HarnessUpdateItem[] | undefined
  restart?: (() => void) | undefined
  openAbout?: (() => void) | undefined
  openHarnesses?: (() => void) | undefined
  openAgent?: ((id: string) => void) | undefined
}) {
  const close = useLayerClose()
  const layerOpen = useLayerOpen()
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!layerOpen || !bodyRef.current) return
    const popover = bodyRef.current.closest<HTMLElement>('.ui-popover')
    if (!popover || popover.contains(document.activeElement)) return
    const control = popover.querySelector<HTMLElement>(
      'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])',
    )
    ;(control ?? popover).focus({ preventScroll: true })
  }, [layerOpen, status.kind, harnesses.length])
  const row = (title: string, meta?: string, action?: { label: string; run: () => void }, withRef = true) => (
    <div ref={withRef ? bodyRef : undefined} className="update-check-body" role="status">
      <span className="update-check-text">
        <span className="update-check-title">{title}</span>
        {meta && <span className="update-check-meta">{meta}</span>}
      </span>
      {action && (
        <Button
          size="xs"
          onClick={() => {
            close()
            action.run()
          }}>
          {action.label}
        </Button>
      )}
    </div>
  )
  const stacked = status.kind !== 'checking' && harnesses.length > 0
  const latch = (() => {
    switch (status.kind) {
      case 'checking':
        return (
          <div ref={bodyRef} className="update-check-body" role="status">
            <Spinner size={14} />
            <span className="update-check-title">{COPY.checking}</span>
          </div>
        )
      case 'current':
        return row(COPY.current, COPY.build(shortBuild(status.build)), undefined, !stacked)
      case 'dev':
        return row(COPY.development, COPY.noBuild, undefined, !stacked)
      case 'failed':
        return row(COPY.failed, COPY.build(shortBuild(status.build)), undefined, !stacked)
      case 'page':
        return row(
          COPY.page,
          undefined,
          {
            label: COPY.reload,
            run: () => {
              window.location.reload()
            },
          },
          !stacked,
        )
      case 'app':
        return row(
          status.version ? COPY.updateVersion(status.version) : COPY.update,
          undefined,
          openAbout ? { label: COPY.view, run: openAbout } : undefined,
          !stacked,
        )
      case 'host': {
        const words = oldHostWords(computer)
        return (
          <div ref={stacked ? undefined : bodyRef} className="update-check-body" role="status">
            <span className="update-check-text">
              <span className="update-check-title">{words.title}</span>
              {!restart && (
                <Hint inline lead={<Icon icon={RefreshGlyph} size={12} />} label={words.label} moreLabel={COPY.restartHelp}>
                  {words.detail}
                </Hint>
              )}
            </span>
            {restart && (
              <Button
                size="xs"
                onClick={() => {
                  close()
                  restart()
                }}>
                {COPY.restart}
              </Button>
            )}
          </div>
        )
      }
    }
  })()
  if (!stacked) return latch
  return (
    <div ref={bodyRef} className="update-check-stack">
      {latch}
      <div className="update-check-harnesses" role="region" aria-label={COPY.harnesses}>
        <div className="update-check-section-head">
          <span className="update-check-section-title">{COPY.harnesses}</span>
          {openHarnesses && (
            <button
              type="button"
              className="update-check-link"
              onClick={() => {
                close()
                openHarnesses()
              }}>
              {COPY.manage}
            </button>
          )}
        </div>
        <div className="update-check-list">
          {harnesses.map(item => (
            <HarnessUpdateRow key={item.id} item={item} openAgent={openAgent} />
          ))}
        </div>
      </div>
    </div>
  )
}

/** 检查更新 as the shell draws it, wherever its foot, rail or top bar is. */
export function ShellUpdateCheck({ shell }: { shell: ShellState }) {
  const canManageHarnesses = shell.entries.includes('settings') && shell.access.admin && shell.snapshot.catalog !== undefined
  const catalogHarnesses = shell.snapshot.catalog?.harnesses
  const harnesses = harnessUpdateItems(catalogHarnesses, canManageHarnesses)
  const editableHarnesses = Boolean(canManageHarnesses && catalogHarnesses?.some(item => item.editable))
  return (
    <UpdateCheck
      hostId={shell.snapshot.instanceId}
      hostBuild={shell.snapshot.build}
      computer={shell.computer}
      harnesses={harnesses}
      editableHarnesses={editableHarnesses}
      refresh={shell.refresh}
      restart={shell.shellHost ? () => restartLatch(shell) : undefined}
      openAbout={() => shell.openSettings('about')}
      openHarnesses={canManageHarnesses ? () => shell.openSettings('engines') : undefined}
      openAgent={canManageHarnesses ? id => shell.openAgentPage({ kind: 'agent', id }) : undefined}
    />
  )
}
