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

export const SERVICE_LABELS: Record<SimulatorPrivacyService, string> = {
  calendar: '日历',
  'contacts-limited': '通讯录（基本）',
  contacts: '通讯录',
  location: '定位（使用期间）',
  'location-always': '定位（始终）',
  'photos-add': '添加照片',
  photos: '照片',
  'media-library': '媒体资料库',
  microphone: '麦克风',
  motion: '运动与健身',
  reminders: '提醒事项',
  siri: 'Siri',
}

const ACTION_LABELS: Record<SimulatorPrivacyAction, string> = { grant: '允许', revoke: '拒绝', reset: '重置' }

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
          label="权限"
          size="xs"
          hint="每个 App 的盾牌按钮改这一项权限"
          value={service}
          options={SIMULATOR_PRIVACY_SERVICES.map(value => ({ value, label: SERVICE_LABELS[value] }))}
          onValueChange={value => setService(value)}
        />
        <span className="sim-spacer" />
        <IconButton size="xs" icon={RotateCw} label="重新列出" onClick={onReload} />
        <IconButton size="xs" icon={X} label="关闭 App 列表" onClick={onClose} />
      </div>
      {apps === undefined ? (
        <div className="sim-pane-empty">
          <Spinner size={14} />
        </div>
      ) : (
        <ul className="sim-apps" aria-label="设备上的 App">
          {apps.map(app => (
            <li key={app.bundleId} title={app.bundleId}>
              <span className="sim-app-name">
                <VisibleText text={app.name} />
              </span>
              {app.kind === 'user' && <span className="sim-app-tag">你的</span>}
              <span className="sim-spacer" />
              {busy === app.bundleId ? (
                <Spinner size={12} />
              ) : (
                <>
                  <IconButton
                    size="xs"
                    icon={Play}
                    label={`启动 ${app.name}`}
                    tooltip="启动"
                    disabled={busy !== undefined}
                    onClick={() => onLaunch(app)}
                  />
                  <IconButton
                    size="xs"
                    icon={Square}
                    label={`结束 ${app.name}`}
                    tooltip="结束"
                    disabled={busy !== undefined}
                    onClick={() => onTerminate(app)}
                  />
                  <Menu
                    label={`${app.name} 的${SERVICE_LABELS[service]}权限`}
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
                        label={`${app.name}：${SERVICE_LABELS[service]}权限`}
                        tooltip={`${SERVICE_LABELS[service]}：允许、拒绝或重置`}
                        disabled={busy !== undefined}
                      />
                    )}
                  />
                </>
              )}
            </li>
          ))}
          {apps.length === 0 && <li className="sim-quiet">没有 App</li>}
        </ul>
      )}
    </section>
  )
}
