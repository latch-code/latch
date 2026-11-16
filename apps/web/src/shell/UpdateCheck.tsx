import { useEffect, useSyncExternalStore } from 'react'
import { Button, Hint, Icon, IconButton, Popover, RefreshGlyph, Spinner, useLayerClose } from '@latch/ui'
import { PAGE_BUILD, buildStatus, buildStatusWords, oldHostWords, readServedBuild, shortBuild, type BuildStatus } from '../core/build.ts'
import { useShellUpdates } from '../core/shellUpdates.ts'
import type { ShellState } from './useShellLayout.tsx'

/**
 * The served build, read once per page and again on every click, shared by every 检查更新 on the page (the sidebar's
 * foot in both places, the rail and the top bar), so one read answers all of them.
 */
let state: { served: string | null | undefined; checking: boolean } = { served: undefined, checking: false }
let readOnce = false
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

async function recheck(alsoApp?: () => Promise<unknown>) {
  if (state.checking) return
  set({ checking: true })
  const [served] = await Promise.all([readServedBuild(), alsoApp?.().catch(() => {})])
  set({ served, checking: false })
}

/** 重启 Latch as the banner and the update popover offer it: main's own rules decide, and its refusal is the toast. */
export function restartLatch(shell: Pick<ShellState, 'lifecycle' | 'setToast'>) {
  void shell.lifecycle.restartHost().then(message => {
    if (message) shell.setToast({ text: message, tone: 'error' })
  })
}

/**
 * 检查更新: a refresh glyph that compares this page's build with the one the Host serves now and the one it started
 * beside, and in the desktop app also asks the app's own updater. Spinning while it checks, an amber dot when something
 * newer is ready; the click checks again and opens what can be done about it, under each action's own rules.
 */
function UpdateCheck({
  hostBuild,
  computer,
  restart,
  openAbout,
}: {
  /** `AppSnapshot.build`: the page that was beside the Host when it started. */
  hostBuild: string | undefined
  /** The computer's name for the old-Host words (`computerLabel`). */
  computer: string
  /** Only the Latch app on that Mac restarts its Host. */
  restart?: (() => void) | undefined
  /** Settings › 关于, where the desktop app's own update moves on. */
  openAbout?: (() => void) | undefined
}) {
  const { served, checking } = useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  )
  const updates = useShellUpdates()
  const view = updates.view
  const app = view && view.state !== 'unsupported' ? { state: view.state, version: view.release?.version } : null
  useEffect(() => {
    if (readOnce) return
    readOnce = true
    void recheck()
  }, [])
  const status = buildStatus({ page: PAGE_BUILD, host: hostBuild, served, checking, app })
  const words = buildStatusWords(status)
  return (
    <Popover
      label="检查更新"
      side="auto"
      align="end"
      size="sm"
      onOpenChange={open => {
        if (open) void recheck(app ? () => updates.check() : undefined)
      }}
      trigger={props => (
        <IconButton
          {...props}
          className="update-check"
          label="检查更新"
          icon={RefreshGlyph}
          tooltip={words.tooltip}
          busy={status.kind === 'checking'}
          {...(words.dot ? { badge: <span className="icon-dot" /> } : {})}
        />
      )}>
      <UpdateCheckBody status={status} computer={computer} restart={restart} openAbout={openAbout} />
    </Popover>
  )
}

/** What was found, in a line, with at most one thing to do about it. */
export function UpdateCheckBody({
  status,
  computer,
  restart,
  openAbout,
}: {
  status: BuildStatus
  computer: string
  restart?: (() => void) | undefined
  openAbout?: (() => void) | undefined
}) {
  const close = useLayerClose()
  const row = (title: string, meta?: string, action?: { label: string; run: () => void }) => (
    <div className="update-check-body" role="status">
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
  switch (status.kind) {
    case 'checking':
      return (
        <div className="update-check-body" role="status">
          <Spinner size={14} />
          <span className="update-check-title">正在检查</span>
        </div>
      )
    case 'current':
      return row('已是最新', `构建 ${shortBuild(status.build)}`)
    case 'dev':
      return row('开发运行', '无构建号')
    case 'failed':
      return row('未能检查', `构建 ${shortBuild(status.build)}`)
    case 'page':
      return row('有新版页面', undefined, {
        label: '重新载入',
        run: () => {
          window.location.reload()
        },
      })
    case 'app':
      return row(
        status.version ? `Latch ${status.version} 可更新` : 'Latch 有更新',
        undefined,
        openAbout ? { label: '查看', run: openAbout } : undefined,
      )
    case 'host': {
      const words = oldHostWords(computer)
      return (
        <div className="update-check-body" role="status">
          <span className="update-check-text">
            <span className="update-check-title">{words.title}</span>
            {!restart && (
              <Hint lead={<Icon icon={RefreshGlyph} size={12} />} label={words.label} moreLabel="怎么重启">
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
              重启 Latch
            </Button>
          )}
        </div>
      )
    }
  }
}

/** 检查更新 as the shell draws it, wherever its foot, rail or top bar is. */
export function ShellUpdateCheck({ shell }: { shell: ShellState }) {
  return (
    <UpdateCheck
      hostBuild={shell.snapshot.build}
      computer={shell.computer}
      restart={shell.shellHost ? () => restartLatch(shell) : undefined}
      openAbout={() => shell.openSettings('about')}
    />
  )
}
