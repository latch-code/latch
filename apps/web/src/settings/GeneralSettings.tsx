import { useContext, useState } from 'react'
import type { AppSnapshot } from '@latch/protocol'
import { Button, CodeGlyph, InlineNotice, Menu, SegmentedControl, SelectButton, SwitchRow, UI_COPY } from '@latch/ui'
import { useViewport } from '../breakpoints.ts'
import { CustomizationActionsContext } from '../core/customization.ts'
import { defineCopy, type LocalePreference } from '../core/i18n.ts'
import { deviceAccess } from '../core/permissions.ts'
import { computerLabel } from '../core/securityCopy.ts'
import { currentShell } from '../core/shell.ts'
import { keepAwakeLine, loginItemNote, useShellLifecycle } from '../core/shellLifecycle.ts'
import { backdropLevel, setPreference, usePreferences, type SendKey, type ThemePreference, type WorkDisplay } from '../preferences.ts'
import { SettingsGroup, SettingsRow } from './common.tsx'
import { NotificationSettings } from './NotificationSettings.tsx'
import { chooseEditor, useEditors } from '../components/OpenInEditor.tsx'
import { PromptTemplatesSettings } from './PromptTemplatesSettings.tsx'
import { CustomizationSettings } from './CustomizationSettings.tsx'
import { BackdropTiles, DensityTiles, MotionChoice } from './AppearanceTiles.tsx'
import { CliSettings } from './CliSettings.tsx'

const COPY = defineCopy(
  {
    appearance: '外观',
    theme: { system: '跟随系统', light: '浅色', dark: '深色' },
    backdrop: '背景效果',
    density: '密度',
    motion: '动效',
    onlyHere: '仅此设备',
    use: '使用',
    language: '界面语言',
    system: '跟随系统',
    chinese: '简体中文',
    english: 'English',
    send: '发送消息',
    enter: '⏎ 发送',
    commandEnter: '⌘⏎ 发送',
    controlEnter: 'Ctrl ⏎ 发送',
    work: '工作过程',
    showAll: '全部显示',
    failures: '只留失败',
    fold: '收起',
    autoOpen: '新文档生成后自动打开',
    name: '名称',
    editor: '编辑器',
    editorFailed: '没有保存编辑器，请重试',
    login: '登录时打开 Latch',
    awake: '有任务时保持 Mac 唤醒',
  },
  {
    appearance: 'Appearance',
    theme: { system: 'System', light: 'Light', dark: 'Dark' },
    backdrop: 'Background effects',
    density: 'Density',
    motion: 'Motion',
    onlyHere: 'This device only',
    use: 'General',
    language: 'Display language',
    system: 'System',
    chinese: '简体中文',
    english: 'English',
    send: 'Send message',
    enter: '⏎ Send',
    commandEnter: '⌘⏎ Send',
    controlEnter: 'Ctrl ⏎ Send',
    work: 'Work details',
    showAll: 'Show all',
    failures: 'Failures',
    fold: 'Collapsed',
    autoOpen: 'Open new documents automatically',
    name: 'Name',
    editor: 'Editor',
    editorFailed: 'Could not save the editor. Try again.',
    login: 'Open Latch at login',
    awake: 'Keep Mac awake during tasks',
  },
)
const THEMES: readonly ThemePreference[] = ['system', 'light', 'dark']

/** The three looks as small windows; the tile itself is the choice. Arrows move between them, as a radio group does. */
function ThemeTiles({ value, onValueChange }: { value: ThemePreference; onValueChange: (value: ThemePreference) => void }) {
  return (
    <div
      className="theme-tiles"
      role="radiogroup"
      aria-label={COPY.appearance}
      onKeyDown={event => {
        const step =
          event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
        if (step === 0) return
        event.preventDefault()
        const index = THEMES.indexOf(value)
        const next = THEMES[(index + step + THEMES.length) % THEMES.length]!
        onValueChange(next)
        event.currentTarget.querySelector<HTMLButtonElement>(`[data-value="${next}"]`)?.focus()
      }}>
      {THEMES.map(theme => (
        <button
          key={theme}
          type="button"
          role="radio"
          className="theme-tile"
          data-value={theme}
          aria-checked={value === theme}
          tabIndex={value === theme ? 0 : -1}
          onClick={() => {
            onValueChange(theme)
          }}>
          <span className="theme-preview" data-look={theme} aria-hidden="true">
            <span className="theme-preview-side" />
            <span className="theme-preview-line" />
            <span className="theme-preview-line is-short" />
            <span className="theme-preview-input" />
          </span>
          <span className="theme-tile-label">
            <span className="theme-tile-dot" aria-hidden="true" />
            {COPY.theme[theme]}
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
  const editors = useEditors()
  const chosenEditor = editors?.editors.find(editor => editor.id === editors.chosen)
  return (
    <SettingsGroup title={computerLabel(local, hostName)}>
      <SettingsRow title={COPY.name} trailing={<span className="settings-row-value">{hostName || computerLabel(true)}</span>} />
      {local && editors && editors.editors.length > 0 && (
        <SettingsRow
          title={COPY.editor}
          trailing={
            <Menu
              label={COPY.editor}
              align="end"
              selection
              sections={[
                {
                  id: 'editors',
                  items: editors.editors.map(editor => ({
                    id: editor.id,
                    label: editor.name,
                    checked: editor.id === editors.chosen,
                    onSelect: () => {
                      setError('')
                      void chooseEditor(editor.id).then(next => {
                        if (next?.chosen !== editor.id) setError(COPY.editorFailed)
                      })
                    },
                  })),
                },
              ]}
              trigger={menu => (
                <SelectButton {...menu} icon={CodeGlyph}>
                  {chosenEditor?.name ?? UI_COPY.unselected}
                </SelectButton>
              )}
            />
          }
        />
      )}
      {view?.loginItem.available && (
        <SwitchRow
          className="settings-row"
          title={COPY.login}
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
          title={COPY.awake}
          description={keepAwakeLine(view.keepAwake) || undefined}
          checked={view.keepAwake.enabled}
          disabled={busy !== null}
          onCheckedChange={enabled => {
            void act('awake', () => lifecycle.setKeepAwake(enabled))
          }}
        />
      )}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {local && <CliSettings />}
    </SettingsGroup>
  )
}

export function GeneralSettings({ snapshot, admin, onChanged }: { snapshot: AppSnapshot; admin: boolean; onChanged: () => void }) {
  const preferences = usePreferences()
  const phone = useViewport() === 'phone'
  const writer = useContext(CustomizationActionsContext)
  // Touch screens always send with the button, and phones never open a document by themselves: nothing to choose there.
  const usage = !phone
  return (
    <>
      <SettingsGroup title={COPY.appearance} bare>
        <ThemeTiles
          value={preferences.theme}
          onValueChange={value => {
            setPreference('theme', value)
          }}
        />
        <div className="layout-choice-head">
          <span>{COPY.backdrop}</span>
          <span>{COPY.onlyHere}</span>
        </div>
        <BackdropTiles
          value={backdropLevel(preferences, phone)}
          onValueChange={value => {
            setPreference('backdrop', value)
          }}
        />
        <div className="layout-choice-head">
          <span>{COPY.density}</span>
          <span>{COPY.onlyHere}</span>
        </div>
        <DensityTiles
          value={preferences.density}
          onValueChange={value => {
            setPreference('density', value)
          }}
        />
        <div className="layout-choice-head">
          <span>{COPY.motion}</span>
          <span>{COPY.onlyHere}</span>
        </div>
        <MotionChoice
          value={preferences.motion}
          onValueChange={value => {
            setPreference('motion', value)
          }}
        />
      </SettingsGroup>
      {snapshot.catalog?.features?.customization && (admin || writer.pending) && (
        <CustomizationSettings admin={admin} writer={writer} onChanged={onChanged} />
      )}
      <SettingsGroup title={COPY.use}>
        <SettingsRow
          title={COPY.language}
          trailing={
            <SegmentedControl<LocalePreference>
              className="display-language"
              label={COPY.language}
              value={preferences.locale}
              options={[
                { value: 'system', label: COPY.system },
                { value: 'zh-CN', label: COPY.chinese },
                { value: 'en', label: COPY.english },
              ]}
              onValueChange={value => {
                setPreference('locale', value)
              }}
            />
          }
        />
        {usage && (
          <SettingsRow
            title={COPY.send}
            trailing={
              <SegmentedControl<SendKey>
                label={COPY.send}
                value={preferences.sendKey}
                options={[
                  { value: 'enter', label: COPY.enter },
                  { value: 'mod-enter', label: /Mac|iPhone|iPad/.test(navigator.platform) ? COPY.commandEnter : COPY.controlEnter },
                ]}
                onValueChange={value => {
                  setPreference('sendKey', value)
                }}
              />
            }
          />
        )}
        {/* What the conversation shows of a turn's work, on this device. Approvals, questions and failures show at every level. */}
        <SettingsRow
          title={COPY.work}
          trailing={
            <SegmentedControl<WorkDisplay>
              className="work-details-choice"
              label={COPY.work}
              value={preferences.workDisplay}
              options={[
                { value: 'all', label: COPY.showAll },
                { value: 'failures', label: COPY.failures },
                { value: 'folded', label: COPY.fold },
              ]}
              onValueChange={value => {
                setPreference('workDisplay', value)
              }}
            />
          }
        />
        {usage && snapshot.catalog?.features?.filePreview && (
          <SwitchRow
            className="settings-row"
            title={COPY.autoOpen}
            checked={preferences.autoOpenDocuments}
            onCheckedChange={enabled => setPreference('autoOpenDocuments', enabled)}
          />
        )}
      </SettingsGroup>
      <NotificationSettings />
      <ThisMac hostName={snapshot.hostName} local={deviceAccess(snapshot, currentShell()).local} />
      {admin && snapshot.catalog?.features?.promptTemplates && <PromptTemplatesSettings snapshot={snapshot} onChanged={onChanged} />}
    </>
  )
}
