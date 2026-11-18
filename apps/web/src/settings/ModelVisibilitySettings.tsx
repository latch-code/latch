import { useState } from 'react'
import type { HostCatalog } from '@latch/protocol'
import { SearchField, SwitchRow } from '@latch/ui'
import { defineCopy } from '../core/i18n.ts'
import { ProviderTile } from '../components/BrandTile.tsx'
import { fuzzyModelMatch, hideModel, modelKey, useModelPreferences } from '../modelPreferences.ts'
import { SettingsGroup, SettingsRow } from './common.tsx'

const VISIBILITY_COPY = defineCopy(
  {
    title: '显示的模型',
    search: '搜索模型',
    caption: '只影响这台设备',
    notFound: (query: string) => `没有找到「${query}」`,
  },
  {
    title: 'Shown models',
    search: 'Search models',
    caption: 'Only on this device',
    notFound: (query: string) => `Nothing matches “${query}”`,
  },
)

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
      title={VISIBILITY_COPY.title}
      meta={models.length >= 6 ? <SearchField label={VISIBILITY_COPY.search} value={query} onValueChange={setQuery} /> : undefined}
      caption={VISIBILITY_COPY.caption}
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
      {shown.length === 0 && <SettingsRow title={VISIBILITY_COPY.notFound(query.trim())} />}
    </SettingsGroup>
  )
}
