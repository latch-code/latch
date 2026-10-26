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
  const change = async (key: 'completion' | 'approval' | 'title', checked: boolean) => {
    try {
      const result = await api.set({ completion: value.completion, approval: value.approval, title: value.title, [key]: checked })
      if (result) setValue(result)
      else setError('无法保存通知设置。')
    } catch {
      setError('无法保存通知设置。')
    }
  }
  return (
    <SettingsGroup title="通知">
      {value.needsConsent && !value.completion && <InlineNotice>会话曾在后台完成。你可以开启完成通知。</InlineNotice>}
      {!value.supported && <InlineNotice>当前系统不支持通知。</InlineNotice>}
      <SwitchRow
        title="会话完成时通知"
        description="只在 Latch 没有前台窗口时通知"
        checked={value.completion}
        disabled={!value.supported}
        onCheckedChange={checked => change('completion', checked)}
      />
      <SwitchRow
        title="有请求等你处理时通知"
        checked={value.approval}
        disabled={!value.supported}
        onCheckedChange={checked => change('approval', checked)}
      />
      <SwitchRow
        title="通知中包含会话标题"
        description="关闭时只显示固定提示，不显示会话内容"
        checked={value.title}
        disabled={!value.supported}
        onCheckedChange={checked => change('title', checked)}
      />
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
    </SettingsGroup>
  )
}
