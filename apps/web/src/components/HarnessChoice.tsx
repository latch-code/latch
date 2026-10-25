import { useState, type RefObject } from 'react'
import { Plus } from 'lucide-react'
import type { AgentPresetSettings, AgentSettings, HostCatalog } from '@latch/protocol'
import { api } from '../core/api.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { harnessEntries, presetsToAdd, type HarnessEntry } from '../composerChoice.ts'
import { MenuFooterLink, Popover, TileAction, TileChoice, useLayerClose } from '@latch/ui'
import { HarnessTile } from './BrandTile.tsx'
import { AgentPresetList, AgentSetupPanel } from './SetupPanels.tsx'

/**
 * What a new session runs on, as a row of tiles: every harness the Host offers that can start here (the built-in one
 * as Agent and as 只对话), then those that cannot, each saying why (its tooltip, and its line on touch screens). The
 * last tile adds an agent in place: it lists the presets not added yet, and one of them opens its panel with what this
 * computer has of it and 「添加」. 管理 Agent 成员… goes to settings.
 */
export function HarnessChoice({
  catalog,
  workspaceId,
  value,
  onChange,
  access,
  onManage,
  onAdded,
  disabled,
  addRef,
}: {
  catalog: HostCatalog
  workspaceId?: string
  /** The chosen entry's key. */
  value: string | undefined
  onChange: (entry: HarnessEntry) => void
  access: Pick<DeviceAccess, 'legacy' | 'local' | 'admin'>
  /** Opens 设置 › Agent 成员 (devices that may manage the Host). */
  onManage?: () => void
  /** An agent was added here: the page fetches the catalog again and chooses it. */
  onAdded: (agent: AgentSettings) => void
  disabled?: boolean
  /** The 「添加 Agent」 tile, for a link elsewhere on the page that opens the same layer. */
  addRef?: RefObject<HTMLButtonElement | null>
}) {
  const entries = harnessEntries(catalog, access, workspaceId)
  const toAdd = presetsToAdd(catalog)
  const canAdd = !access.legacy && access.local && access.admin
  // The presets as the Host reports them, with what this computer has of each; until they arrive, the bare presets.
  const [reported, setReported] = useState<AgentPresetSettings[] | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const load = async () => {
    if (!access.admin || access.legacy) return
    try {
      setReported((await api<{ presets: AgentPresetSettings[] }>('agents')).presets)
    } catch {
      // The list still shows the presets; only what was found is missing.
    }
  }
  const presets = toAdd.map(preset => reported?.find(item => item.id === preset.id) ?? preset)
  const preset = presets.find(item => item.id === picked)
  return (
    <TileChoice
      label="Agent"
      variant="compact"
      className="harness-choice"
      value={value}
      options={entries.map(entry => ({
        value: entry.key,
        label: entry.label,
        ...(entry.note ? { note: entry.note } : {}),
        tile: <HarnessTile harness={entry.harness} size={20} />,
        description: entry.description,
        ...(entry.disabledReason || disabled ? { disabledReason: entry.disabledReason ?? '等待这次提交完成' } : {}),
      }))}
      onValueChange={key => {
        const entry = entries.find(item => item.key === key)
        if (entry) onChange(entry)
      }}>
      {(toAdd.length > 0 || onManage) && (
        <Popover
          label="添加 Agent"
          width={360}
          onOpenChange={open => {
            setPicked(null)
            if (open) void load()
          }}
          trigger={({ ref, ...props }) => (
            <TileAction
              {...props}
              ref={element => {
                ref.current = element
                if (addRef) addRef.current = element
              }}
              icon={Plus}
              variant="compact"
              label="添加 Agent"
            />
          )}>
          <AgentAdder
            presets={presets}
            picked={preset}
            canAdd={canAdd}
            onPick={setPicked}
            {...(access.admin ? { onRecheck: load } : {})}
            onManage={onManage}
            onAdded={onAdded}
          />
        </Popover>
      )}
    </TileChoice>
  )
}

/** The add-agent layer: the presets, or the one picked with its panel; adding or managing closes the layer. */
function AgentAdder({
  presets,
  picked,
  canAdd,
  onPick,
  onRecheck,
  onManage,
  onAdded,
}: {
  presets: AgentPresetSettings[]
  picked: AgentPresetSettings | undefined
  canAdd: boolean
  onPick: (id: string | null) => void
  onRecheck?: () => Promise<void>
  onManage?: () => void
  onAdded: (agent: AgentSettings) => void
}) {
  const close = useLayerClose()
  if (picked)
    return (
      <AgentSetupPanel
        key={picked.id}
        preset={picked}
        canAdd={canAdd}
        onBack={() => {
          onPick(null)
        }}
        {...(onRecheck ? { onRecheck } : {})}
        onAdded={agent => {
          close()
          onAdded(agent)
        }}
      />
    )
  return (
    <AgentPresetList
      presets={presets}
      onPick={item => {
        onPick(item.id)
      }}
      footer={
        onManage && (
          <div className="setup-list-foot">
            <MenuFooterLink closes onClick={onManage}>
              管理 Agent 成员…
            </MenuFooterLink>
          </div>
        )
      }
    />
  )
}
