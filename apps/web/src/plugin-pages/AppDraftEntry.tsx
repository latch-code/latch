import { useEffect, useRef, useState } from 'react'
import { LayoutGrid } from 'lucide-react'
import { Button, Icon } from '@latch/ui'
import { api, inlineError, isUncertain, newRequestId } from '../core/api.ts'

/**
 * 改动's 「作为应用草稿」: a session whose folder holds `latch-app/latch-app.json` can hand that draft to 设置 › 插件,
 * where it is built, previewed and applied. Only this Mac's admin device with all data sees it; the Host checks again.
 */
export function AppDraftEntry({
  sessionId,
  revision,
  onImported,
  onError,
}: {
  sessionId: string
  /** Changes when the session's files may have: the presence of the draft is read again. */
  revision: string
  onImported: () => void
  onError: (text: string) => void
}) {
  const [state, setState] = useState<{ present: boolean; pluginId?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const request = useRef<string | null>(null)
  useEffect(() => {
    let live = true
    void api<{ present: boolean; pluginId?: string }>(`plugin-packages/session-draft?sessionId=${encodeURIComponent(sessionId)}`).then(
      value => {
        if (live) setState(value)
      },
      () => {
        if (live) setState(null)
      },
    )
    return () => {
      live = false
    }
  }, [sessionId, revision])
  if (!state?.present) return null
  const send = async () => {
    setBusy(true)
    request.current ??= newRequestId()
    try {
      await api('plugin-packages/import', { method: 'POST', body: { requestId: request.current, sessionId } })
      request.current = null
      onImported()
    } catch (cause) {
      if (!isUncertain(cause)) request.current = null
      onError(inlineError(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="changes-app-draft">
      <Icon icon={LayoutGrid} size={14} />
      <span>latch-app</span>
      <Button size="sm" loading={busy} onClick={() => void send()}>
        {state.pluginId ? '更新应用草稿' : '作为应用草稿'}
      </Button>
    </div>
  )
}
