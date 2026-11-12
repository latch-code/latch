import { useEffect, useMemo, useRef, useState } from 'react'
import { InlineNotice, Loading } from '@latch/ui'
import { currentShell, shellFrameUrl } from '../core/shell.ts'
import { isFrameCommand, isFrameEvent, type FrameInput } from './types.ts'

/** Untrusted document bytes have no access to Host objects or trusted demand-package React panels. */
export function FileSandbox({ kind, data, versionKey, options, onMessage, onChannel, canvas, focusOnReady }: FrameInput) {
  const frame = useRef<HTMLIFrameElement>(null)
  const latest = useRef({ onMessage, onChannel })
  latest.current = { onMessage, onChannel }
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const [room, setRoom] = useState<{ width: number; height: number }>()
  // Only what this frame was opened for: an update to the file must not take the keyboard from the composer.
  const focusWhenShown = useRef(focusOnReady === true)
  useEffect(() => {
    if (!ready || !focusWhenShown.current) return
    focusWhenShown.current = false
    frame.current?.focus()
  }, [ready])
  const fitted = canvas !== undefined
  useEffect(() => {
    const element = box.current
    if (!fitted || !element) return undefined
    const observer = new ResizeObserver(() => {
      setRoom({ width: element.clientWidth, height: element.clientHeight })
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [fitted])
  const scale = canvas && room ? Math.min(room.width / canvas.width, room.height / canvas.height) : 0
  const nonce = useMemo(() => crypto.randomUUID().replaceAll('-', ''), [kind, data, versionKey, options?.theme, options?.showChanges])
  const name = kind === 'html' || kind === 'html-script' ? kind : kind === 'mermaid' ? 'diagram' : 'office'
  const src = currentShell()
    ? `${shellFrameUrl('preview', `${name}.html`)}#nonce=${nonce}`
    : `/link/preview-frame/${name}.html#nonce=${nonce}`
  useEffect(() => {
    setError('')
    setReady(false)
    let disposed = false,
      initialized = false,
      loaded = false
    const channel = new MessageChannel()
    const fail = () => {
      if (disposed) return
      disposed = true
      clearTimeout(timer)
      channel.port1.close()
      channel.port2.close()
      latest.current.onChannel?.(undefined)
      setError('文档预览已停止，请关闭后重新打开。')
    }
    const timer = setTimeout(fail, 15_000)
    const receive = (event: MessageEvent<unknown>) => {
      const value = event.data
      if (
        disposed
        || initialized
        || event.source !== frame.current?.contentWindow
        || event.origin !== 'null'
        || !value
        || typeof value !== 'object'
        || Array.isArray(value)
      )
        return
      const message = value as Record<string, unknown>
      if (Object.keys(message).length !== 3 || message.type !== 'ready' || message.protocol !== 1 || message.nonce !== nonce) return
      initialized = true
      const buffer = data.slice(0)
      const safeOptions = {
        theme: options?.theme === 'dark' ? 'dark' : 'light',
        showChanges: options?.showChanges === true,
        ...(Number.isInteger(options?.pageIndex) && Number(options?.pageIndex) >= 0 && Number(options?.pageIndex) <= 9999
          ? { pageIndex: options!.pageIndex }
          : {}),
        fit: options?.fit !== false,
        ...(Number.isInteger(options?.zoomPercent) && Number(options?.zoomPercent) >= 10 && Number(options?.zoomPercent) <= 400
          ? { zoomPercent: options!.zoomPercent }
          : {}),
      }
      channel.port1.onmessage = message => {
        if (disposed) return
        if (!isFrameEvent(message.data)) {
          fail()
          return
        }
        const value = message.data
        if (value.type === 'rendered' || value.type === 'diagram' || value.type === 'html') {
          // A page's scripts run after its first report and can hang, so only the last one ends the watch.
          if (value.type !== 'html' || value.settled) clearTimeout(timer)
          setReady(true)
        }
        if (value.type === 'error') clearTimeout(timer)
        latest.current.onMessage?.(value, { versionKey, data })
      }
      channel.port1.onmessageerror = fail
      channel.port1.start()
      latest.current.onChannel?.(command => {
        if (!disposed && isFrameCommand(command)) channel.port1.postMessage(command)
      })
      frame.current!.contentWindow!.postMessage({ type: 'init', protocol: 1, nonce, kind, data: buffer, options: safeOptions }, '*', [
        channel.port2,
        buffer,
      ])
    }
    const load = () => {
      if (loaded) fail()
      else loaded = true
    }
    const element = frame.current
    element?.addEventListener('load', load)
    window.addEventListener('message', receive)
    return () => {
      disposed = true
      clearTimeout(timer)
      window.removeEventListener('message', receive)
      element?.removeEventListener('load', load)
      channel.port1.close()
      channel.port2.close()
      latest.current.onChannel?.(undefined)
    }
  }, [kind, data, nonce, versionKey, options?.theme, options?.showChanges])
  return (
    <div ref={box} className={canvas ? 'file-sandbox fitted' : 'file-sandbox'} onClick={canvas ? () => frame.current?.focus() : undefined}>
      {error ? (
        <InlineNotice tone="error">{error}</InlineNotice>
      ) : (
        <>
          {!ready && <Loading label="正在显示文档…" />}
          <iframe
            key={nonce}
            ref={frame}
            title="文档预览"
            // The frame keeps a real viewport, so its own layout, pointer targets and resize events all stay true.
            style={
              canvas && room
                ? {
                    width: canvas.width,
                    height: canvas.height,
                    transform: `translate(${(room.width - canvas.width * scale) / 2}px, ${(room.height - canvas.height * scale) / 2}px) scale(${scale})`,
                  }
                : undefined
            }
            src={src}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
          />
        </>
      )}
    </div>
  )
}
