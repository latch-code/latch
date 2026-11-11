import * as React from 'react'
import { Component, useEffect, type ReactNode } from 'react'
import * as JsxRuntime from 'react/jsx-runtime'
import { createRoot } from 'react-dom/client'
import {
  APP_MODULE_BYTES,
  APP_PROTOCOL,
  APP_RUNTIME_MODULES,
  APP_SDK_VERSION,
  type AppFrameInit,
  type AppFrameMessage,
  type AppHostInfo,
  type AppStorageDocument,
} from '@latch/protocol'
import { AppBridgeError, createBridge } from './bridge.ts'
import { defineApp, isAppDefinition, type AppDefinition, type MigratedDocument } from './index.ts'
import { createAppUi, type AppPrimitives, type AppUi } from './ui.tsx'

const describe = (cause: unknown) => (cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)).slice(0, 2000)

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function isInit(value: unknown, nonce: string): value is AppFrameInit {
  if (typeof value !== 'object' || value === null) return false
  const init = value as Partial<AppFrameInit>
  return (
    init.type === 'init'
    && init.protocol === APP_PROTOCOL
    && init.nonce === nonce
    && init.module instanceof ArrayBuffer
    && typeof init.bundleHash === 'string'
    && /^[a-f0-9]{64}$/u.test(init.bundleHash)
    && typeof init.title === 'string'
    && typeof init.info === 'object'
    && init.info !== null
  )
}

function applyTheme(info: AppHostInfo) {
  document.documentElement.dataset.theme = info.theme === 'dark' ? 'dark' : 'light'
}

class Boundary extends Component<{ ui: AppUi; onError: (cause: unknown) => void; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override componentDidCatch(cause: unknown) {
    this.props.onError(cause)
  }
  override render() {
    const { Notice } = this.props.ui
    return this.state.failed ? <Notice tone="error" title="页面出错了" /> : this.props.children
  }
}

function Mounted({ onMount, children }: { onMount: () => void; children: ReactNode }) {
  useEffect(onMount, [])
  return children
}

/**
 * The page frame's runtime (`runtime.html`): says `ready` with the nonce from its address, takes one `init` from the
 * parent (the port, the page's module bytes and its hash), checks the hash, imports the module from a Blob and draws it.
 * Everything afterwards goes over the port. Cmd/Ctrl keys and Esc are passed to the shell before the page sees them.
 */
/**
 * What can open a connection without `connect-src`: WebRTC (STUN/TURN reach any address, and a TURN user name carries
 * data), WebTransport and the media and network APIs around them. CSP has no directive Chrome enforces for WebRTC, so
 * they are removed before any page code runs; a fresh child frame cannot bring them back (`frame-src 'none'`).
 */
export function removeSockets(scope: typeof globalThis = globalThis): void {
  for (const name of Object.getOwnPropertyNames(scope))
    if (/RTC|WebTransport|MediaStream|MediaRecorder|^Presentation/u.test(name)) Reflect.deleteProperty(scope, name)
  const navigatorType = Reflect.get(scope, 'Navigator') as { prototype?: object } | undefined
  for (const target of [scope.navigator, navigatorType?.prototype])
    if (target)
      for (const name of ['mediaDevices', 'getUserMedia', 'webkitGetUserMedia', 'connection', 'sendBeacon', 'presentation'])
        Reflect.deleteProperty(target, name)
}

export function startRuntime(primitives: AppPrimitives): void {
  const nonce = /^#nonce=([a-f0-9]{32})$/u.exec(location.hash)?.[1]
  if (!nonce) return
  removeSockets()
  const ui = createAppUi(primitives)
  // What a page bundle imports: `react`, `react/jsx-runtime` and `@latch/app-sdk` resolve to these frozen objects.
  Object.defineProperty(globalThis, APP_RUNTIME_MODULES, {
    value: Object.freeze({
      react: Object.freeze({ ...React }),
      'react/jsx-runtime': Object.freeze({ ...JsxRuntime }),
      '@latch/app-sdk': Object.freeze({ defineApp, AppBridgeError, APP_SDK_VERSION }),
    }),
    writable: false,
    configurable: false,
    enumerable: false,
  })
  let port: MessagePort | undefined
  const send = (message: AppFrameMessage) => {
    port?.postMessage(message)
  }
  addEventListener(
    'keydown',
    event => {
      // Only keys a person pressed; the shell checks again that one just did.
      if (!event.isTrusted || (event.key !== 'Escape' && !event.metaKey && !event.ctrlKey)) return
      send({
        t: 'key',
        key: event.key.slice(0, 32),
        code: event.code.slice(0, 32),
        meta: event.metaKey,
        ctrl: event.ctrlKey,
        shift: event.shiftKey,
        alt: event.altKey,
      })
    },
    true,
  )
  addEventListener('error', event => {
    send({ t: 'error', message: describe(event.error ?? event.message) })
  })
  addEventListener('unhandledrejection', event => {
    send({ t: 'error', message: describe(event.reason) })
  })
  const onInit = (event: MessageEvent<unknown>) => {
    if (event.source !== parent || port || !isInit(event.data, nonce) || event.ports.length !== 1) return
    removeEventListener('message', onInit)
    port = event.ports[0]!
    void boot(event.data, port, send, ui)
  }
  addEventListener('message', onInit)
  parent.postMessage({ type: 'ready', protocol: APP_PROTOCOL, nonce }, '*')
}

async function boot(init: AppFrameInit, port: MessagePort, send: (message: AppFrameMessage) => void, ui: AppUi): Promise<void> {
  applyTheme(init.info)
  document.title = init.title
  const { latch, receive } = createBridge(send, { info: init.info, view: init.view })
  port.onmessage = event => {
    receive(event.data)
    const data = event.data as { t?: unknown; name?: unknown; info?: AppHostInfo }
    if (data?.t === 'event' && data.name === 'host' && data.info) applyTheme(data.info)
  }
  port.start()
  const bytes = new Uint8Array(init.module)
  let definition: AppDefinition
  try {
    if (bytes.byteLength > APP_MODULE_BYTES || (await sha256Hex(bytes)) !== init.bundleHash) throw new Error('页面代码与版本不符')
    const url = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }))
    let loaded: { default?: unknown }
    try {
      loaded = (await import(/* @vite-ignore */ url)) as { default?: unknown }
    } finally {
      URL.revokeObjectURL(url)
    }
    if (!isAppDefinition(loaded.default)) throw new Error('页面模块没有用 defineApp 导出')
    definition = loaded.default
  } catch (cause) {
    send({ t: 'error', message: describe(cause) })
    return
  }
  if (init.migrate) {
    try {
      const documents: AppStorageDocument[] = structuredClone(init.migrate.documents)
      const migrated: MigratedDocument[] = definition.migrate
        ? await definition.migrate(init.migrate.from, documents)
        : documents.map(({ scope, key, value }) => ({ scope, key, value }))
      if (!Array.isArray(migrated)) throw new Error('migrate 没有返回文档列表')
      send({
        t: 'migrated',
        documents: migrated.map(item => ({ scope: String(item.scope), key: String(item.key), value: structuredClone(item.value) })),
      })
    } catch (cause) {
      send({ t: 'migrate-failed', message: describe(cause) })
    }
    return
  }
  const Page = definition.page
  const host = document.getElementById('app')!
  createRoot(host, {
    onUncaughtError: cause => {
      send({ t: 'error', message: describe(cause) })
    },
  }).render(
    <Boundary
      ui={ui}
      onError={cause => {
        send({ t: 'error', message: describe(cause) })
      }}>
      <Mounted
        onMount={() => {
          send({ t: 'rendered' })
        }}>
        <Page latch={latch} ui={ui} />
      </Mounted>
    </Boundary>,
  )
}
