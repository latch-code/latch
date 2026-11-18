import { useEffect, useState } from 'react'
import { InlineNotice, SwitchRow } from '@latch/ui'
import { currentShell, type NotificationPreferences } from '../core/shell.ts'
import { defineCopy } from '../core/i18n.ts'
import { SettingsGroup } from './common.tsx'

const NOTIFY_COPY = defineCopy(
  {
    title: '通知',
    readFailed: '无法读取通知设置。',
    saveFailed: '无法保存通知设置。',
    unsupported: '当前系统不支持通知。',
    notify: '完成或需要我处理时通知',
    onlyDone: '现在只在完成时通知',
    onlyNeedsYou: '现在只在需要你处理时通知',
    showTitle: '通知中显示会话标题',
  },
  {
    title: 'Notifications',
    readFailed: 'Couldn’t read notification settings.',
    saveFailed: 'Couldn’t save notification settings.',
    unsupported: 'This system doesn’t support notifications.',
    notify: 'Notify when done or when I’m needed',
    onlyDone: 'Now only when done',
    onlyNeedsYou: 'Now only when you’re needed',
    showTitle: 'Show session titles',
  },
)

export function NotificationSettings() {
  const api = currentShell()?.notifications
  const [value, setValue] = useState<NotificationPreferences>(),
    [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void api
      ?.get()
      .then(value => {
        if (active) setValue(value)
      })
      .catch(() => {
        if (active) setError(NOTIFY_COPY.readFailed)
      })
    const stop = api?.subscribeState?.(setValue)
    return () => {
      active = false
      stop?.()
    }
  }, [api])
  if (!api || !value) return error ? <InlineNotice tone="error">{error}</InlineNotice> : null
  const change = async (patch: Partial<Pick<NotificationPreferences, 'completion' | 'approval' | 'title'>>) => {
    try {
      const result = await api.set({ completion: value.completion, approval: value.approval, title: value.title, ...patch })
      if (result) setValue(result)
      else setError(NOTIFY_COPY.saveFailed)
    } catch {
      setError(NOTIFY_COPY.saveFailed)
    }
  }
  // Saved separately in the past, the two can still differ: say which one holds instead of drawing the switch as all or nothing.
  const partly = value.completion !== value.approval
  return (
    <SettingsGroup title={NOTIFY_COPY.title}>
      {!value.supported && <InlineNotice>{NOTIFY_COPY.unsupported}</InlineNotice>}
      <SwitchRow
        className="settings-row"
        title={NOTIFY_COPY.notify}
        description={partly ? (value.completion ? NOTIFY_COPY.onlyDone : NOTIFY_COPY.onlyNeedsYou) : undefined}
        checked={value.completion || value.approval}
        disabled={!value.supported}
        onCheckedChange={checked => change({ completion: checked, approval: checked })}
      />
      <SwitchRow
        className="settings-row"
        title={NOTIFY_COPY.showTitle}
        checked={value.title}
        disabled={!value.supported}
        onCheckedChange={checked => change({ title: checked })}
      />
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
    </SettingsGroup>
  )
}
