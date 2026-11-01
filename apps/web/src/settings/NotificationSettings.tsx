import { useEffect, useState } from 'react'
import { InlineNotice, SwitchRow } from '@latch/ui'
import { currentShell, type NotificationPreferences } from '../core/shell.ts'
import { SettingsGroup } from './common.tsx'
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
        if (active) setError('无法读取通知设置。')
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
      else setError('无法保存通知设置。')
    } catch {
      setError('无法保存通知设置。')
    }
  }
  // Saved separately in the past, the two can still differ: say which one holds instead of drawing the switch as all or nothing.
  const partly = value.completion !== value.approval
  return (
    <SettingsGroup title="通知">
      {!value.supported && <InlineNotice>当前系统不支持通知。</InlineNotice>}
      <SwitchRow
        className="settings-row"
        title="完成或需要我处理时通知"
        description={partly ? (value.completion ? '现在只在完成时通知' : '现在只在需要你处理时通知') : undefined}
        checked={value.completion || value.approval}
        disabled={!value.supported}
        onCheckedChange={checked => change({ completion: checked, approval: checked })}
      />
      <SwitchRow
        className="settings-row"
        title="通知中显示会话标题"
        checked={value.title}
        disabled={!value.supported}
        onCheckedChange={checked => change({ title: checked })}
      />
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
    </SettingsGroup>
  )
}
