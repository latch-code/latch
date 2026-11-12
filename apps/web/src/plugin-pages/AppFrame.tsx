import { useEffect, useMemo, useRef } from 'react'
import {
  APP_MODULE_BYTES,
  APP_PROTOCOL,
  APP_SDK_VERSION,
  isAppFrameMessage,
  type AppFrameInit,
  type AppHostInfo,
  type AppMigrationLease,
  type AppPreviewTask,
  type AppSnapshot,
  type AppSummary,
} from '@latch/protocol'
import { api } from '../core/api.ts'
import { onAppData } from '../core/appEvents.ts'
import { currentShell } from '../core/shell.ts'
import { acceptFrameKey, appRef, storageDocument } from './model.ts'
import { createParentBridge, type ParentBridge } from './parentBridge.ts'
import { createPreviewBridge } from './previewBridge.ts'

/** Whatever a page kept with `view.setState`, by page: only in this tab's memory, carried over to a reload or a new version. */
const views = new Map<string, unknown>()

/** The frame stops waiting after this long without `ready` and a drawn page. */
const FRAME_TIMEOUT_MS = 15_000

/** No feature of the browser reaches the frame: no fullscreen, clipboard, camera, location or anything else. */
export const FRAME_ALLOW =
  "fullscreen 'none'; camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; display-capture 'none'; payment 'none'; usb 'none'; serial 'none'; hid 'none'; bluetooth 'none'; midi 'none'; screen-wake-lock 'none'; web-share 'none'; autoplay 'none'; publickey-credentials-get 'none'; publickey-credentials-create 'none'"

export type FrameOutcome =
  | { kind: 'ready' }
  | { kind: 'failed'; source: 'handshake' | 'runtime'; message: string }
  | { kind: 'migrated'; documents: Array<{ scope: string; key: string; value: unknown }> }
  | { kind: 'migrate-failed'; message: string }

/** The frame's address: the fixed runtime, with the nonce it must say back in its `ready`. */
export function frameSource(nonce: string, desktop = currentShell() !== null): string {
  return desktop ? `latch-frame://app/runtime.html#nonce=${nonce}` : `/link/app-frame/runtime.html#nonce=${nonce}`
}

/** Only the frame this shell made, from an opaque origin, with its nonce, says `ready` once. */
export function isFrameReady(event: Pick<MessageEvent, 'source' | 'origin' | 'data'>, frame: unknown, nonce: string): boolean {
  if (event.source === null || event.source !== frame || event.origin !== 'null') return false
  const value = event.data as Record<string, unknown> | null
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length === 3
    && value.type === 'ready'
    && value.protocol === APP_PROTOCOL
    && value.nonce === nonce
  )
}

export function reportDiagnostic(page: AppSummary, source: 'runtime' | 'handshake' | 'bridge', message: string): void {
  void api(`apps/${encodeURIComponent(page.pluginId)}/diagnostics`, {
    method: 'POST',
    body: { via: { app: appRef(page), revision: page.revision }, source, message: message.slice(0, 2000) },
  }).catch(() => {})
}

interface FrameProps {
  page: AppSummary & { bundleHash: string }
  snapshot: AppSnapshot
  online: boolean
  info: AppHostInfo
  /** A security surface, dialog or toast of the shell is open: the frame takes no input. */
  covered: boolean
  /** Runs the page's `migrate` with these documents instead of drawing it. */
  migration?: AppMigrationLease
  onOutcome: (outcome: FrameOutcome) => void
  onOpenSession: (sessionId: string) => void
  /** A Cmd/Ctrl key pressed in the frame, for the shell's own shortcuts. */
  onShortcut: (init: KeyboardEventInit) => void
  /** Esc pressed in the frame. */
  onEscape: () => void
  /**
   * A draft's preview: the bundle from `moduleUrl` (the build route), a bridge that never calls the Host, and no
   * diagnostics sent anywhere.
   */
  preview?: { moduleUrl: string; tasks?: readonly AppPreviewTask[]; onPreviewOnly: () => void }
}

/**
 * One page in its opaque frame: the fixed runtime (`sandbox="allow-scripts"`, no `allow-same-origin`, the CSP from the
 * Host or the desktop app), a nonce and one MessageChannel. The parent fetches the page's module with its own
 * credentials and hands the bytes over; the frame never makes an authenticated request. Unmounting closes the port, the
 * subscriptions and the bridge.
 */
export function AppFrame({
  page,
  snapshot,
  online,
  info,
  covered,
  migration,
  onOutcome,
  onOpenSession,
  onShortcut,
  onEscape,
  preview,
}: FrameProps) {
  const frame = useRef<HTMLIFrameElement>(null)
  const bridge = useRef<ParentBridge | null>(null)
  const latest = useRef({ snapshot, online, info, onOutcome, onOpenSession, onShortcut, onEscape, migration, covered, preview })
  latest.current = { snapshot, online, info, onOutcome, onOpenSession, onShortcut, onEscape, migration, covered, preview }
  const nonce = useMemo(() => crypto.randomUUID().replaceAll('-', ''), [page.revision, page.bundleHash, migration])
  // A preview keeps its view state apart from the applied page's.
  const key = (preview ? 'preview:' : '') + appRef(page)

  useEffect(() => {
    let disposed = false
    let initialized = false
    let rendered = false
    let loads = 0
    const channel = new MessageChannel()
    const element = frame.current
    const previewing = latest.current.preview
    const module = api<ArrayBuffer>(
      previewing?.moduleUrl ?? `app-modules/${encodeURIComponent(page.pluginId)}/${encodeURIComponent(page.appId)}/${page.bundleHash}.js`,
      { response: 'bytes', timeoutMs: 30_000 },
    )
    module.catch(() => {})
    const close = () => {
      disposed = true
      clearTimeout(timer)
      window.removeEventListener('message', receive)
      element?.removeEventListener('load', load)
      channel.port1.onmessage = null
      channel.port1.close()
      channel.port2.close()
      bridge.current?.dispose()
      bridge.current = null
    }
    const finish = (outcome: FrameOutcome) => {
      if (disposed) return
      close()
      if (outcome.kind === 'failed' && latest.current.online && !previewing) reportDiagnostic(page, outcome.source, outcome.message)
      latest.current.onOutcome(outcome)
    }
    const timer = setTimeout(() => {
      finish({ kind: 'failed', source: 'handshake', message: initialized ? '页面 15 秒内没有显示' : '页面框 15 秒内没有就绪' })
    }, FRAME_TIMEOUT_MS)
    // The frame may load once; a second load means it navigated away from the runtime.
    const load = () => {
      if (++loads > 1) finish({ kind: 'failed', source: 'runtime', message: '页面框离开了运行环境' })
    }
    const receive = (event: MessageEvent<unknown>) => {
      if (disposed || initialized || !isFrameReady(event, element?.contentWindow, nonce)) return
      initialized = true
      void module.then(
        bytes => {
          if (disposed) return
          if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > APP_MODULE_BYTES) {
            finish({ kind: 'failed', source: 'handshake', message: '页面代码超过 2 MiB' })
            return
          }
          start(bytes)
        },
        () => {
          finish({ kind: 'failed', source: 'handshake', message: '页面代码取不到' })
        },
      )
    }
    const start = (bytes: ArrayBuffer) => {
      const lease = previewing ? undefined : latest.current.migration
      bridge.current = previewing
        ? createPreviewBridge({
            page,
            ...(previewing.tasks ? { tasks: previewing.tasks } : {}),
            info: () => latest.current.info,
            send: message => {
              if (!disposed) channel.port1.postMessage(message)
            },
            setView: state => {
              views.set(key, state)
            },
            onPreviewOnly: () => {
              latest.current.preview?.onPreviewOnly()
            },
          })
        : createParentBridge({
            page,
            snapshot: () => latest.current.snapshot,
            online: () => latest.current.online,
            info: () => latest.current.info,
            api,
            send: message => {
              if (!disposed) channel.port1.postMessage(message)
            },
            openSession: id => {
              latest.current.onOpenSession(id)
            },
            setView: state => {
              views.set(key, state)
            },
            covered: () => latest.current.covered,
            activated: () => navigator.userActivation?.isActive === true,
          })
      channel.port1.onmessage = event => {
        if (disposed) return
        const message: unknown = event.data
        if (!isAppFrameMessage(message)) {
          finish({ kind: 'failed', source: 'runtime', message: '页面发来无法识别的消息' })
          return
        }
        switch (message.t) {
          case 'call':
            if (!lease) bridge.current?.call(message)
            return
          case 'key':
            if (
              !acceptFrameKey({
                key: message.key,
                covered: latest.current.covered,
                migrating: lease !== undefined,
                focused: document.hasFocus() && document.activeElement === element,
                activated: navigator.userActivation?.isActive === true,
              })
            )
              return
            // Cmd/Ctrl combinations go to the shell's shortcuts and Esc to the page's way back, as calls: never as events
            // dispatched in the shell, where an approval's own keys would hear them.
            if (message.key === 'Escape') latest.current.onEscape()
            else if (message.meta || message.ctrl)
              latest.current.onShortcut({
                key: message.key,
                code: message.code,
                metaKey: message.meta,
                ctrlKey: message.ctrl,
                shiftKey: message.shift,
                altKey: message.alt,
              })
            return
          case 'rendered':
            if (lease || rendered) return
            rendered = true
            clearTimeout(timer)
            latest.current.onOutcome({ kind: 'ready' })
            return
          case 'error':
            if (lease) finish({ kind: 'migrate-failed', message: message.message })
            else if (!rendered) finish({ kind: 'failed', source: 'runtime', message: message.message })
            else if (latest.current.online && !previewing) reportDiagnostic(page, 'runtime', message.message)
            return
          case 'migrated':
            if (lease) finish({ kind: 'migrated', documents: message.documents })
            return
          case 'migrate-failed':
            if (lease) finish({ kind: 'migrate-failed', message: message.message })
            return
        }
      }
      channel.port1.onmessageerror = () => {
        finish({ kind: 'failed', source: 'runtime', message: '页面消息无法读取' })
      }
      channel.port1.start()
      const init: AppFrameInit = {
        type: 'init',
        protocol: APP_PROTOCOL,
        nonce,
        module: bytes,
        bundleHash: page.bundleHash,
        title: page.title,
        info: latest.current.info,
        view: views.get(key) ?? null,
        ...(lease ? { migrate: { from: lease.fromVersion, to: lease.toVersion, documents: lease.documents.map(storageDocument) } } : {}),
      }
      element?.contentWindow?.postMessage(init, '*', [channel.port2, bytes])
    }
    element?.addEventListener('load', load)
    window.addEventListener('message', receive)
    return close
  }, [nonce])

  useEffect(() => {
    bridge.current?.update()
  }, [snapshot, online])
  useEffect(
    () =>
      onAppData(change => {
        bridge.current?.dataChanged(change)
      }),
    [],
  )
  useEffect(() => {
    bridge.current?.hostChanged()
  }, [info.theme, info.offline, info.canRun])

  return (
    <iframe
      key={nonce}
      ref={frame}
      className="app-frame"
      title={page.title}
      src={frameSource(nonce)}
      sandbox="allow-scripts"
      allow={FRAME_ALLOW}
      referrerPolicy="no-referrer"
      inert={covered || undefined}
      hidden={migration !== undefined || undefined}
    />
  )
}

/** The host facts a page may read: the SDK, the theme, whether this shell is offline and whether this device may run. */
export function hostInfo(theme: 'light' | 'dark', online: boolean, canRun: boolean): AppHostInfo {
  return { sdk: APP_SDK_VERSION, appProtocol: APP_PROTOCOL, theme, offline: !online, canRun }
}
