import { useState } from 'react'
import { Play, RotateCw, ShieldCheck, Square, X } from 'lucide-react'
import { IconButton, Menu, Spinner, ValuePicker } from '@latch/ui'
import {
  SIMULATOR_PRIVACY_SERVICES,
  type SimulatorAppView,
  type SimulatorPrivacyAction,
  type SimulatorPrivacyService,
} from '@latch/protocol'
import { VisibleText } from '../../components/VisibleText.tsx'
import { defineCopy } from '../../core/i18n.ts'

const COPY = defineCopy(
  {
    calendar: '日历',
    limitedContacts: '通讯录（基本）',
    contacts: '通讯录',
    location: '定位（使用期间）',
    alwaysLocation: '定位（始终）',
    addPhotos: '添加照片',
    photos: '照片',
    media: '媒体资料库',
    microphone: '麦克风',
    motion: '运动与健身',
    reminders: '提醒事项',
    grant: '允许',
    revoke: '拒绝',
    reset: '重置',
    permissions: '权限',
    shieldHint: '每个 App 的盾牌按钮改这一项权限',
    reload: '重新列出',
    close: '关闭 App 列表',
    apps: '设备上的 App',
    yours: '你的',
    launchName: (value1: string | number) => `启动 ${value1}`,
    launch: '启动',
    quitName: (value1: string | number) => `结束 ${value1}`,
    quit: '结束',
    appPermission: (value1: string | number, value2: string | number) => `${value1} 的${value2}权限`,
    appPermissionTitle: (value1: string | number, value2: string | number) => `${value1}：${value2}权限`,
    actions: (value1: string | number) => `${value1}：允许、拒绝或重置`,
    empty: '没有 App',
  },
  {
    calendar: 'Calendar',
    limitedContacts: 'Contacts (basic)',
    contacts: 'Contacts',
    location: 'Location (while using)',
    alwaysLocation: 'Location (always)',
    addPhotos: 'Add photos',
    photos: 'Photos',
    media: 'Media library',
    microphone: 'Microphone',
    motion: 'Motion and fitness',
    reminders: 'Reminders',
    grant: 'Allow',
    revoke: 'Deny',
    reset: 'Reset',
    permissions: 'Permissions',
    shieldHint: 'Use the shield button beside an app to change this permission',
    reload: 'Refresh list',
    close: 'Close app list',
    apps: 'Apps on the device',
    yours: 'Yours',
    launchName: (value1: string | number) => `Launch ${value1}`,
    launch: 'Launch',
    quitName: (value1: string | number) => `Quit ${value1}`,
    quit: 'Quit',
    appPermission: (value1: string | number, value2: string | number) => `${value2} permission for ${value1}`,
    appPermissionTitle: (value1: string | number, value2: string | number) => `${value1}: ${value2} permission`,
    actions: (value1: string | number) => `${value1}: allow, deny or reset`,
    empty: 'No apps',
  },
)

export const SERVICE_LABELS: Record<SimulatorPrivacyService, string> = {
  get calendar() {
    return COPY.calendar
  },
  get 'contacts-limited'() {
    return COPY.limitedContacts
  },
  get contacts() {
    return COPY.contacts
  },
  get location() {
    return COPY.location
  },
  get 'location-always'() {
    return COPY.alwaysLocation
  },
  get 'photos-add'() {
    return COPY.addPhotos
  },
  get photos() {
    return COPY.photos
  },
  get 'media-library'() {
    return COPY.media
  },
  get microphone() {
    return COPY.microphone
  },
  get motion() {
    return COPY.motion
  },
  get reminders() {
    return COPY.reminders
  },
  siri: 'Siri',
}

const ACTION_LABELS: Record<SimulatorPrivacyAction, string> = {
  get grant() {
    return COPY.grant
  },
  get revoke() {
    return COPY.revoke
  },
  get reset() {
    return COPY.reset
  },
}

export interface DeviceAppsProps {
  apps: readonly SimulatorAppView[] | undefined
  busy: string | undefined
  onLaunch: (app: SimulatorAppView) => void
  onTerminate: (app: SimulatorAppView) => void
  onPrivacy: (app: SimulatorAppView, action: SimulatorPrivacyAction, service: SimulatorPrivacyService) => void
  onReload: () => void
  onClose: () => void
}

/** The device's apps (not the hidden ones): start, end, and grant, revoke or reset one permission ahead of its prompt. */
export function DeviceApps({ apps, busy, onLaunch, onTerminate, onPrivacy, onReload, onClose }: DeviceAppsProps) {
  const [service, setService] = useState<SimulatorPrivacyService>('photos')
  return (
    <section className="sim-pane" aria-label="App">
      <div className="sim-pane-bar">
        <ValuePicker
          label={COPY.permissions}
          size="xs"
          hint={COPY.shieldHint}
          value={service}
          options={SIMULATOR_PRIVACY_SERVICES.map(value => ({ value, label: SERVICE_LABELS[value] }))}
          onValueChange={value => setService(value)}
        />
        <span className="sim-spacer" />
        <IconButton size="xs" icon={RotateCw} label={COPY.reload} onClick={onReload} />
        <IconButton size="xs" icon={X} label={COPY.close} onClick={onClose} />
      </div>
      {apps === undefined ? (
        <div className="sim-pane-empty">
          <Spinner size={14} />
        </div>
      ) : (
        <ul className="sim-apps" aria-label={COPY.apps}>
          {apps.map(app => (
            <li key={app.bundleId} title={app.bundleId}>
              <span className="sim-app-name">
                <VisibleText text={app.name} />
              </span>
              {app.kind === 'user' && <span className="sim-app-tag">{COPY.yours}</span>}
              <span className="sim-spacer" />
              {busy === app.bundleId ? (
                <Spinner size={12} />
              ) : (
                <>
                  <IconButton
                    size="xs"
                    icon={Play}
                    label={COPY.launchName(app.name)}
                    tooltip={COPY.launch}
                    disabled={busy !== undefined}
                    onClick={() => onLaunch(app)}
                  />
                  <IconButton
                    size="xs"
                    icon={Square}
                    label={COPY.quitName(app.name)}
                    tooltip={COPY.quit}
                    disabled={busy !== undefined}
                    onClick={() => onTerminate(app)}
                  />
                  <Menu
                    label={COPY.appPermission(app.name, SERVICE_LABELS[service])}
                    sections={[
                      {
                        id: 'privacy',
                        label: SERVICE_LABELS[service],
                        items: (['grant', 'revoke', 'reset'] as const).map(action => ({
                          id: action,
                          label: ACTION_LABELS[action],
                          onSelect: () => onPrivacy(app, action, service),
                        })),
                      },
                    ]}
                    trigger={props => (
                      <IconButton
                        {...props}
                        size="xs"
                        icon={ShieldCheck}
                        label={COPY.appPermissionTitle(app.name, SERVICE_LABELS[service])}
                        tooltip={COPY.actions(SERVICE_LABELS[service])}
                        disabled={busy !== undefined}
                      />
                    )}
                  />
                </>
              )}
            </li>
          ))}
          {apps.length === 0 && <li className="sim-quiet">{COPY.empty}</li>}
        </ul>
      )}
    </section>
  )
}
