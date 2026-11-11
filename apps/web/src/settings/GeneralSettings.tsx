import { useState } from 'react'
import type { AppSnapshot } from '@latch/protocol'
import { InlineNotice, SegmentedControl, SwitchRow } from '@latch/ui'
import { useViewport } from '../breakpoints.ts'
import { deviceAccess } from '../core/permissions.ts'
import { computerLabel } from '../core/securityCopy.ts'
import { currentShell } from '../core/shell.ts'
import { keepAwakeLine, loginItemNote, useShellLifecycle } from '../core/shellLifecycle.ts'
import { setPreference, usePreferences, type SendKey, type ThemePreference } from '../preferences.ts'
import { SettingsGroup, SettingsRow } from './common.tsx'
import { NotificationSettings } from './NotificationSettings.tsx'
import { PromptTemplatesSettings } from './PromptTemplatesSettings.tsx'

const THEMES: Array<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
]

/** The three looks as small windows; the tile itself is the choice. Arrows move between them, as a radio group does. */
function ThemeTiles({ value, onValueChange }: { value: ThemePreference; onValueChange: (value: ThemePreference) => void }) {
  return (
    <div
      className="theme-tiles"
      role="radiogroup"
      aria-label="外观"
      onKeyDown={event => {
        const step =
          event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
        if (step === 0) return
        event.preventDefault()
        const index = THEMES.findIndex(theme => theme.value === value)
        const next = THEMES[(index + step + THEMES.length) % THEMES.length]!
        onValueChange(next.value)
        event.currentTarget.querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`)?.focus()
      }}>
      {THEMES.map(theme => (
        <button
          key={theme.value}
          type="button"
          role="radio"
          className="theme-tile"
          data-value={theme.value}
          aria-checked={value === theme.value}
          tabIndex={value === theme.value ? 0 : -1}
          onClick={() => {
            onValueChange(theme.value)
          }}>
          <span className="theme-preview" data-look={theme.value} aria-hidden="true">
            <span className="theme-preview-side" />
            <span className="theme-preview-line" />
            <span className="theme-preview-line is-short" />
            <span className="theme-preview-input" />
          </span>
          <span className="theme-tile-label">
            <span className="theme-tile-dot" aria-hidden="true" />
            {theme.label}
          </span>
        </button>
      ))}
    </div>
  )
}

/**
 * The computer's name and, in the Latch app on it, how it starts and stays awake. The group is titled 「这台 Mac」 there
 * and with the computer's name on other devices. Opening at login needs a packaged app, so the row is left out while the
 * shell reports it unavailable (a development run, another platform) and comes back with an installer. Main owns the
 * state; the page asks.
 */
function ThisMac({ hostName, local }: { hostName: string; local: boolean }) {
  const lifecycle = useShellLifecycle()
  const [busy, setBusy] = useState<'login' | 'awake' | null>(null)
  const [error, setError] = useState('')
  const act = async (kind: 'login' | 'awake', action: () => Promise<string>) => {
    setBusy(kind)
    setError('')
    setError(await action())
    setBusy(null)
  }
  const view = lifecycle.view
  return (
    <SettingsGroup title={computerLabel(local, hostName)}>
      <SettingsRow title="名称" trailing={<span className="settings-row-value">{hostName || '这台 Mac'}</span>} />
      {view?.loginItem.available && (
        <SwitchRow
          className="settings-row"
          title="登录时打开 Latch"
          description={loginItemNote(view.loginItem) || undefined}
          checked={view.loginItem.enabled}
          disabled={busy !== null}
          onCheckedChange={enabled => {
            void act('login', () => lifecycle.setLoginItem(enabled))
          }}
        />
      )}
      {view && (
        <SwitchRow
          className="settings-row"
          title="有任务时保持 Mac 唤醒"
          description={keepAwakeLine(view.keepAwake) || undefined}
          checked={view.keepAwake.enabled}
          disabled={busy !== null}
          onCheckedChange={enabled => {
            void act('awake', () => lifecycle.setKeepAwake(enabled))
          }}
        />
      )}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
    </SettingsGroup>
  )
}

export function GeneralSettings({ snapshot, admin, onChanged }: { snapshot: AppSnapshot; admin: boolean; onChanged: () => void }) {
  const preferences = usePreferences()
  const phone = useViewport() === 'phone'
  // Touch screens always send with the button, and phones never open a document by themselves: nothing to choose there.
  const usage = !phone
  return (
    <>
      <SettingsGroup title="外观" bare>
        <ThemeTiles
          value={preferences.theme}
          onValueChange={value => {
            setPreference('theme', value)
          }}
        />
      </SettingsGroup>
      {usage && (
        <SettingsGroup title="使用">
          <SettingsRow
            title="发送消息"
            trailing={
              <SegmentedControl<SendKey>
                label="发送消息"
                value={preferences.sendKey}
                options={[
                  { value: 'enter', label: '⏎ 发送' },
                  { value: 'mod-enter', label: /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘⏎ 发送' : 'Ctrl ⏎ 发送' },
                ]}
                onValueChange={value => {
                  setPreference('sendKey', value)
                }}
              />
            }
          />
          {snapshot.catalog?.features?.filePreview && (
            <SwitchRow
              className="settings-row"
              title="新文档生成后自动打开"
              checked={preferences.autoOpenDocuments}
              onCheckedChange={enabled => setPreference('autoOpenDocuments', enabled)}
            />
          )}
        </SettingsGroup>
      )}
      <NotificationSettings />
      <ThisMac hostName={snapshot.hostName} local={deviceAccess(snapshot, currentShell()).local} />
      {admin && snapshot.catalog?.features?.promptTemplates && <PromptTemplatesSettings snapshot={snapshot} onChanged={onChanged} />}
    </>
  )
}
