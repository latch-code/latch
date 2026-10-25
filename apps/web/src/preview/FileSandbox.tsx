import { useEffect, useMemo, useRef, useState } from 'react'
import { InlineNotice, Loading } from '@latch/ui'
import { currentShell } from '../core/shell.ts'
import { isFrameCommand, isFrameEvent, type FrameInput } from './types.ts'

/** Untrusted document bytes have no access to Host objects or trusted demand-package React panels. */
export function FileSandbox({ kind, data, versionKey, options, onMessage, onChannel }: FrameInput) {
  const frame = useRef<HTMLIFrameElement>(null)
  const latest = useRef({ onMessage, onChannel })
  latest.current = { onMessage, onChannel }
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const nonce = useMemo(() => crypto.randomUUID().replaceAll('-', ''), [kind, data, versionKey, options?.theme, options?.showChanges])
  const name = kind === 'pptx' || kind === 'docx' || kind === 'xlsx' ? 'office' : 'diagram'
  const src = currentShell() ? `latch-frame://preview/${name}.html#nonce=${nonce}` : `/link/preview-frame/${name}.html#nonce=${nonce}`
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
      const safeOptions = { theme: options?.theme === 'dark' ? 'dark' : 'light', showChanges: options?.showChanges === true }
      channel.port1.onmessage = message => {
        if (disposed) return
        if (!isFrameEvent(message.data)) {
          fail()
          return
        }
        const value = message.data
        if (value.type === 'rendered' || value.type === 'diagram') {
          clearTimeout(timer)
          setReady(true)
        }
        if (value.type === 'error') clearTimeout(timer)
        latest.current.onMessage?.(value)
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
    <div className="file-sandbox">
      {error ? (
        <InlineNotice tone="error">{error}</InlineNotice>
      ) : (
        <>
          {!ready && <Loading label="正在显示文档…" />}
          <iframe
            key={nonce}
            ref={frame}
            title="文档预览"
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
