import { useMemo, useState } from 'react'
import { AGENT_PRESETS, type AppSnapshot } from '@latch/protocol'
import { Button, ButtonLink, DevMark, InlineNotice } from '@latch/ui'
import { BrandMark } from '../components/ui.tsx'
import type { DeviceAccess } from '../core/permissions.ts'
import { DEV_MODE_TEXT, hostView } from '../core/permissions.ts'
import { presenceUnavailableText } from '../core/securityCopy.ts'
import { SectionHeading, SettingsGroup, SettingsRow } from './common.tsx'
import { SettingsPages } from './navigation.tsx'

/** Latch's own licence and those of the engines it can start; the engines are programs of their own, each under its licence. */
function Licences() {
  const engines = useMemo(() => AGENT_PRESETS.toSorted((a, b) => a.name.localeCompare(b.name)), [])
  return (
    <>
      <SectionHeading title="开源许可" />
      <SettingsGroup>
        <SettingsRow record title="Latch" trailing={<span className="settings-row-value">Apache License 2.0</span>} />
      </SettingsGroup>
      <SettingsGroup title="引擎">
        {engines.map(preset => (
          <SettingsRow
            key={preset.id}
            title={preset.name}
            trailing={
              <>
                <span className="settings-row-value">{preset.license}</span>
                {preset.homepage && (
                  <ButtonLink variant="ghost" href={preset.homepage} target="_blank" rel="noreferrer">
                    主页
                  </ButtonLink>
                )}
              </>
            }
          />
        ))}
      </SettingsGroup>
    </>
  )
}

export function AboutSettings({ snapshot, access }: { snapshot: AppSnapshot; access: Pick<DeviceAccess, 'legacy'> }) {
  const [licences, setLicences] = useState(false)
  const host = access.legacy ? undefined : hostView(snapshot)
  const dev = host?.devMode === true
  const main = (
    <>
      <header className="about-head">
        <BrandMark size={56} />
        <div>
          <h2>
            Latch
            {dev && <DevMark description={DEV_MODE_TEXT} />}
          </h2>
          {snapshot.version && <p>版本 {snapshot.version}</p>}
        </div>
      </header>
      {host?.presence.status === 'unavailable' && <InlineNotice tone="warn">{presenceUnavailableText(host.presence.message)}</InlineNotice>}
      <SettingsGroup caption="Agent 和插件以你的权限在这台电脑上运行。" captionIcon={null}>
        <SettingsRow
          title="开源许可"
          trailing={
            <Button
              variant="ghost"
              onClick={() => {
                setLicences(true)
              }}>
              查看
            </Button>
          }
        />
      </SettingsGroup>
    </>
  )
  return (
    <SettingsPages
      main={main}
      levels={
        licences
          ? [
              {
                key: 'licences',
                title: '开源许可',
                onBack: () => {
                  setLicences(false)
                },
                content: <Licences />,
              },
            ]
          : []
      }
    />
  )
}
