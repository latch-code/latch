import { useState } from 'react'
import type { HostCatalog } from '@latch/protocol'
import { Button, SearchField, SwitchRow } from '@latch/ui'
import { fuzzyModelMatch, hideModel, modelKey, useModelPreferences } from '../modelPreferences.ts'
import { SettingsGroup, SettingsRow } from './common.tsx'
export function ModelVisibilitySettings({ catalog }: { catalog: HostCatalog }) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(''),
    preferences = useModelPreferences()
  const models = catalog.providers.flatMap(provider =>
    (provider.models.length ? provider.models : [provider.defaultModel])
      .filter(Boolean)
      .map(model => ({ provider, model, key: modelKey({ providerId: provider.id, model }) })),
  )
  if (!models.length) return null
  return (
    <SettingsGroup title="模型列表" caption="只影响这台设备的模型选择器；隐藏不会停用模型服务。">
      <SettingsRow
        title="选择器里的模型"
        description={`显示 ${models.filter(item => !preferences.hidden.includes(item.key)).length} / ${models.length} 个`}
        trailing={
          <Button size="sm" variant="outline" onClick={() => setOpen(!open)}>
            {open ? '收起模型列表' : '管理显示的模型'}
          </Button>
        }
      />
      {open && (
        <>
          {models.length > 8 && (
            <div className="settings-card-body">
              <SearchField label="搜索模型" value={query} onValueChange={setQuery} />
            </div>
          )}
          {models
            .filter(item => fuzzyModelMatch(`${item.provider.name} ${item.model}`, query))
            .map(item => (
              <SwitchRow
                key={item.key}
                title={item.model}
                description={item.provider.name}
                checked={!preferences.hidden.includes(item.key)}
                onCheckedChange={visible => hideModel(item.key, !visible)}
              />
            ))}
        </>
      )}
    </SettingsGroup>
  )
}
