import { useState } from 'react'
import type { HostCatalog } from '@latch/protocol'
import { SearchField, SwitchRow } from '@latch/ui'
import { ProviderTile } from '../components/BrandTile.tsx'
import { fuzzyModelMatch, hideModel, modelKey, useModelPreferences } from '../modelPreferences.ts'
import { SettingsGroup, SettingsRow } from './common.tsx'

/** Which models this device's pickers offer. Hiding one turns nothing off: the service keeps it. */
export function ModelVisibilitySettings({ catalog }: { catalog: HostCatalog }) {
  const [query, setQuery] = useState(''),
    preferences = useModelPreferences()
  const models = catalog.providers.flatMap(provider =>
    (provider.models.length ? provider.models : [provider.defaultModel])
      .filter(Boolean)
      .map(model => ({ provider, model, key: modelKey({ providerId: provider.id, model }) })),
  )
  if (!models.length) return null
  const shown = models.filter(item => fuzzyModelMatch(`${item.provider.name} ${item.model}`, query))
  return (
    <SettingsGroup
      title="显示的模型"
      meta={models.length >= 6 ? <SearchField label="搜索模型" value={query} onValueChange={setQuery} /> : undefined}
      caption="只影响这台设备的模型选择器。"
      captionIcon={null}>
      {shown.map(item => (
        <SwitchRow
          key={item.key}
          className="settings-row visible-model"
          title={
            <span className="visible-model-name">
              <ProviderTile provider={item.provider} size={20} />
              {item.model}
              <span className="settings-row-note">{item.provider.name}</span>
            </span>
          }
          checked={!preferences.hidden.includes(item.key)}
          onCheckedChange={visible => {
            hideModel(item.key, !visible)
          }}
        />
      ))}
      {shown.length === 0 && <SettingsRow title={`没有找到「${query.trim()}」`} />}
    </SettingsGroup>
  )
}
