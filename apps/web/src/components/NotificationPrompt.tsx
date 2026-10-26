import { useEffect, useState } from 'react'
import { Button, InlineNotice } from '@latch/ui'
import { currentShell, type NotificationPreferences } from '../core/shell.ts'

export function NotificationPrompt() {
  const api = currentShell()?.notifications
  const [state, setState] = useState<NotificationPreferences>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  useEffect(() => {
    if (!api?.respond) return
    let active = true
    const update = (value: NotificationPreferences | undefined) => {
      if (active) setState(value)
    }
    const refresh = () => {
      if (!document.hidden)
        void api
          .get()
          .then(update)
          .catch(() => {})
    }
    refresh()
    const unsubscribe = api.subscribeState?.(update)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      active = false
      unsubscribe?.()
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [api])
  if (!api?.respond || !state?.supported || state.consent !== 'pending') return null
  const respond = async (choice: 'enable' | 'decline') => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const result = await api.respond!({ choice })
      if (result) setState(result)
      else setError('没有保存选择，请重试。')
    } catch {
      setError('没有保存选择，请重试。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <InlineNotice
      action={
        <>
          <Button
            size="xs"
            disabled={busy}
            onClick={() => {
              void respond('enable')
            }}>
            开启通知
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              void respond('decline')
            }}>
            暂不需要
          </Button>
        </>
      }>
      {error || '刚才的任务已在后台完成。需要完成和待处理通知吗？'}
    </InlineNotice>
  )
}
