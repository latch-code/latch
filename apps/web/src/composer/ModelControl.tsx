import { useState } from 'react'
import { ChevronLeft, ChevronRight, Cpu, Box, Plus, Sparkles } from 'lucide-react'
import type { AgentPresetSettings, AgentSettings, HarnessInfo, HostCatalog, ModelRef, SessionConfigOption } from '@latch/protocol'
import {
  Button,
  IconButton,
  InlineNotice,
  MenuFooterLink,
  MenuFooterNote,
  SegmentedControl,
  Tooltip,
  ValuePicker,
  useLayerClose,
  type PickerGroup,
} from '@latch/ui'
import { api } from '../core/api.ts'
import { harnessLevel, type DeviceAccess } from '../core/permissions.ts'
import { SETUP_COPY } from '../core/securityCopy.ts'
import { engineEntries, harnessName, LATCH_ENGINE_LIMIT, presetsToAdd, sameModel, type ComposerChoice } from '../composerChoice.ts'
import { fuzzyModelMatch, modelKey, rememberModel, useModelPreferences } from '../modelPreferences.ts'
import { HarnessTile } from '../components/BrandTile.tsx'
import { ModelAddPanel, modelGroups } from '../components/Pickers.tsx'
import { AgentPresetList, AgentSetupPanel } from '../components/SetupPanels.tsx'
import { escapeHiddenCharacters, VisibleText } from '../components/VisibleText.tsx'
import {
  agentConfigBlocked,
  agentConfigChoice,
  agentConfigLabel,
  agentConfigValues,
  agentModelControls,
  type AgentConfigState,
} from './modelReasoning.ts'
import { draftPermission, type PermissionView } from './permission.ts'
import { MODE_ICONS, PermissionList } from './PermissionList.tsx'
import { useFooterFoldLevel } from './useFooterFold.ts'

type Access = Pick<DeviceAccess, 'legacy' | 'local' | 'admin'>
/** The most levels a segmented row holds in the popover's width; more go in a row that opens its own list. */
const SEGMENTED_LEVELS = 5

const pendingModelText = (model: string) => `下一条：${model}`
const resetModelLabel = (current: ModelRef | undefined) => (current ? `撤销切换，继续使用 ${current.model}` : '撤销切换')

const engineKey = (harnessId: string, model?: ModelRef) => `${harnessId}\u0000${model ? modelKey(model) : ''}`
const fromEngineKey = (key: string): { harnessId: string; model?: ModelRef } => {
  const [harnessId = '', providerId = '', model = ''] = key.split('\u0000')
  return { harnessId, ...(providerId ? { model: { providerId, model } } : {}) }
}

/** 思考: a segmented row of the levels the engine reported; the menu stays open. */
function LevelRow({ option, disabled, onChoose }: { option: SessionConfigOption; disabled: boolean; onChoose: (value: string) => void }) {
  const values = agentConfigValues(option)
  return (
    <div className="model-setting">
      <span className="model-setting-name">{escapeHiddenCharacters(option.name)}</span>
      {values.length <= SEGMENTED_LEVELS ? (
        <SegmentedControl
          label={escapeHiddenCharacters(option.name)}
          value={option.currentValue}
          disabled={disabled}
          options={values.map(item => ({ value: item.value, label: escapeHiddenCharacters(item.name) }))}
          onValueChange={onChoose}
        />
      ) : (
        <ValuePicker
          variant="row"
          label={escapeHiddenCharacters(option.name)}
          value={option.currentValue}
          disabled={disabled}
          options={values.map(item => ({ value: item.value, label: escapeHiddenCharacters(item.name) }))}
          onValueChange={onChoose}
        />
      )}
    </div>
  )
}

/** 权限 in the popover: the current mode, opening the list; or a sentence for an engine without modes. */
function PermissionRowLink({ view, onOpen }: { view: PermissionView | undefined; onOpen: () => void }) {
  if (!view) return null
  const Glyph = MODE_ICONS[view.icon]
  if (!view.rows)
    return (
      <Tooltip content={view.tooltip}>
        <div className="model-setting" tabIndex={0}>
          <span className="model-setting-name">权限</span>
          <span className="model-setting-value">
            <Glyph size={14} aria-hidden="true" />
            {view.label}
          </span>
        </div>
      </Tooltip>
    )
  return (
    <button type="button" className="model-setting model-setting-link" onClick={onOpen}>
      <span className="model-setting-name">权限</span>
      <span className="model-setting-value" data-amber={view.amber ? '' : undefined}>
        <Glyph size={14} aria-hidden="true" />
        {escapeHiddenCharacters(view.label)}
      </span>
      <ChevronRight size={12} aria-hidden="true" />
    </button>
  )
}

/** Models hidden in settings stay one press away, here where they are chosen. */
function HiddenModelsLink({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  const { hidden } = useModelPreferences()
  if (hidden.length === 0) return null
  return (
    <MenuFooterLink chevron={false} onClick={onToggle}>
      {shown ? '收起隐藏的模型' : `显示隐藏的模型（${hidden.length}）`}
    </MenuFooterLink>
  )
}

function ManageLinks({ engines, models }: { engines?: (() => void) | undefined; models?: (() => void) | undefined }) {
  if (!engines && !models) return null
  return (
    <div className="model-manage">
      {engines && (
        <MenuFooterLink icon={Cpu} chevron={false} closes onClick={engines}>
          管理引擎…
        </MenuFooterLink>
      )}
      {models && (
        <MenuFooterLink icon={Box} chevron={false} closes onClick={models}>
          管理模型…
        </MenuFooterLink>
      )}
    </div>
  )
}

/** Adding an engine where it is chosen: the presets not added yet, then the one picked with its panel. */
function EngineAddPanel({
  onBack,
  canAdd,
  admin,
  catalog,
  onAdded,
}: {
  onBack: () => void
  canAdd: boolean
  admin: boolean
  catalog: HostCatalog
  onAdded: (agent: AgentSettings) => void
}) {
  const close = useLayerClose()
  const toAdd = presetsToAdd(catalog)
  const [reported, setReported] = useState<AgentPresetSettings[] | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [asked, setAsked] = useState(false)
  const load = async () => {
    try {
      setReported((await api<{ presets: AgentPresetSettings[] }>('agents')).presets)
    } catch {
      // The list still shows the presets; only what was found on this computer is missing.
    }
  }
  if (admin && !asked) {
    setAsked(true)
    void load()
  }
  const presets = toAdd.map(preset => reported?.find(item => item.id === preset.id) ?? preset)
  const preset = presets.find(item => item.id === picked)
  if (preset)
    return (
      <AgentSetupPanel
        key={preset.id}
        preset={preset}
        canAdd={canAdd}
        onBack={() => {
          setPicked(null)
        }}
        {...(admin ? { onRecheck: load } : {})}
        onAdded={agent => {
          close()
          onAdded(agent)
        }}
      />
    )
  return (
    <div className="permission-list">
      <header className="permission-list-head">
        <IconButton size="xs" icon={ChevronLeft} label="返回" onClick={onBack} />
        <span>添加引擎</span>
      </header>
      <AgentPresetList
        presets={presets}
        onPick={item => {
          setPicked(item.id)
        }}
      />
    </div>
  )
}

/**
 * The one control for what a new session runs on: the engine as its icon, the model as its name. Its popover has a
 * section per engine usable from this device, then 权限 and the ways to add or manage. An engine that brings its own
 * models is one row until it has started, because nothing tells Latch its list before that.
 */
export function DraftModelControl({
  catalog,
  choice,
  onChoice,
  access,
  disabled,
  onManageEngines,
  onManageModels,
  onProvidersChanged,
  onEngineAdded,
}: {
  catalog: HostCatalog
  choice: ComposerChoice
  onChoice: (patch: Partial<ComposerChoice>) => void
  access: Access
  disabled: boolean
  onManageEngines?: (() => void) | undefined
  onManageModels?: (() => void) | undefined
  onProvidersChanged?: (() => void) | undefined
  onEngineAdded?: ((agent: AgentSettings) => void) | undefined
}) {
  const [panel, setPanel] = useState<'service' | 'engine' | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const preferences = useModelPreferences()
  const entries = engineEntries(catalog, access, choice.workspaceId)
  const harness = entries.find(entry => entry.harness.id === choice.harnessId)?.harness
  // One flat list per engine, the most recently used first.
  const hostModels = modelGroups(catalog, preferences, choice.model, showHidden).flatMap(group => group.options)
  const groups: Array<PickerGroup<string>> = entries.map(entry => ({
    id: entry.harness.id,
    label: entry.label,
    media: <HarnessTile harness={entry.harness} size={16} />,
    options:
      entry.harness.models === 'host'
        ? hostModels.map(option => {
            const [providerId = '', model = ''] = option.value.split('\u0000')
            return {
              ...option,
              // Two services can offer one name; only then does the row need to say whose it is.
              description: hostModels.filter(other => other.label === option.label).length > 1 ? option.description : undefined,
              value: engineKey(entry.harness.id, { providerId, model }),
              ...(entry.disabledReason ? { disabledReason: entry.disabledReason } : {}),
            }
          })
        : [
            {
              value: engineKey(entry.harness.id),
              label: `${entry.label} 自带的模型`,
              description: '开始后可以换',
              ...(entry.disabledReason ? { disabledReason: entry.disabledReason } : {}),
            },
          ],
  }))
  // With a saved service the new session runs on the engine that uses it, whichever one was chosen before.
  const hostEngine = harness?.models === 'host' ? harness : entries.find(entry => entry.harness.models === 'host')?.harness
  const value = harness ? engineKey(harness.id, harness.models === 'host' ? choice.model : undefined) : undefined
  const count = groups.reduce((sum, group) => sum + group.options.length, 0)
  const canAddEngine = !access.legacy && access.local && access.admin && presetsToAdd(catalog).length > 0
  const elsewhere =
    !access.local && !access.legacy && catalog.harnesses.some(item => item.status === 'ready' && harnessLevel(item) === 'L3')
  const noService = harness?.models === 'host' && !choice.model
  const permission = draftPermission(harness)
  return (
    <ValuePicker
      label="模型"
      placeholder="选择引擎"
      value={value}
      valueText={harness ? (harness.models === 'host' ? (choice.model?.model ?? harnessName(harness)) : harnessName(harness)) : undefined}
      groups={groups}
      searchable={count >= 8 && panel === null}
      searchMatch={(option, query) => fuzzyModelMatch(option.label, query)}
      width={panel ? 360 : 320}
      leading={harness ? <HarnessTile harness={harness} size={16} /> : Sparkles}
      className="model-picker"
      menuChevron
      disabled={disabled}
      onOpenChange={open => {
        if (!open) setPanel(null)
      }}
      onValueChange={key => {
        const next = fromEngineKey(key)
        if (next.model) rememberModel(modelKey(next.model))
        const chosen = entries.find(entry => entry.harness.id === next.harnessId)?.harness
        const modes = chosen?.modes ?? []
        onChoice({
          harnessId: next.harnessId,
          ...(next.model ? { model: next.model } : {}),
          ...(choice.mode === 'chat' && !modes.includes('chat') ? { mode: 'agent' as const } : {}),
        })
      }}
      footer={
        <div className="model-footer">
          {harness?.source === 'builtin' && <p className="model-note">{LATCH_ENGINE_LIMIT}</p>}
          {elsewhere && <p className="model-note">其他引擎只能在 Mac 上开始。</p>}
          {noService && access.admin && (
            <MenuFooterLink
              icon={Plus}
              chevron={false}
              onClick={() => {
                setPanel('service')
              }}>
              添加模型服务…
            </MenuFooterLink>
          )}
          {noService && !access.admin && <MenuFooterNote>{SETUP_COPY.addProviderElsewhere}</MenuFooterNote>}
          <PermissionRowLink view={permission} onOpen={() => {}} />
          <HiddenModelsLink
            shown={showHidden}
            onToggle={() => {
              setShowHidden(!showHidden)
            }}
          />
          {canAddEngine && (
            <MenuFooterLink
              icon={Plus}
              chevron={false}
              onClick={() => {
                setPanel('engine')
              }}>
              添加引擎…
            </MenuFooterLink>
          )}
          {access.admin && !noService && hostEngine && (
            <MenuFooterLink
              icon={Plus}
              chevron={false}
              onClick={() => {
                setPanel('service')
              }}>
              添加模型服务…
            </MenuFooterLink>
          )}
          <ManageLinks engines={onManageEngines} models={onManageModels} />
        </div>
      }
      panel={
        panel === 'service' ? (
          <ModelAddPanel
            access={access}
            onCancel={() => {
              setPanel(null)
            }}
            onManage={onManageModels}
            onSaved={model => {
              rememberModel(modelKey(model))
              onChoice({ model, ...(hostEngine ? { harnessId: hostEngine.id } : {}) })
              onProvidersChanged?.()
            }}
          />
        ) : panel === 'engine' ? (
          <EngineAddPanel
            catalog={catalog}
            canAdd={canAddEngine}
            admin={access.admin}
            onBack={() => {
              setPanel(null)
            }}
            onAdded={agent => {
              onEngineAdded?.(agent)
            }}
          />
        ) : undefined
      }
    />
  )
}

/**
 * The same control in a session: the engine is fixed, the model, 思考 and 权限 change when the engine allows it. Latch's
 * own engine lists your services and a switch goes with the next message; an external engine lists what it reported,
 * and a change is written to it at once.
 */
export function SessionModelControl({
  catalog,
  harness,
  model,
  current,
  onModel,
  config,
  busy,
  feedback,
  onRefresh,
  onConfig,
  permission,
  onManageEngines,
  onManageModels,
}: AgentConfigState & {
  catalog: HostCatalog
  harness: HarnessInfo | undefined
  model: ModelRef | undefined
  current: ModelRef | undefined
  onModel: (model: ModelRef | undefined) => void
  config: readonly SessionConfigOption[]
  onRefresh?: (() => void | Promise<void>) | undefined
  onConfig: (configId: string, value: string) => void | Promise<void>
  permission: PermissionView | undefined
  onManageEngines?: (() => void) | undefined
  onManageModels?: (() => void) | undefined
}) {
  const fold = useFooterFoldLevel()
  const [panel, setPanel] = useState<'permission' | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const preferences = useModelPreferences()
  const header = harness ? { title: harnessName(harness), meta: '会话开始后不能换引擎' } : undefined
  const leading = harness ? <HarnessTile harness={harness} size={16} /> : Sparkles
  const state: AgentConfigState = { busy, ...(feedback ? { feedback } : {}) }
  const blocked = agentConfigBlocked(state)
  const choose = (id: string, value: string) => {
    const intent = agentConfigChoice(config, id, value, state)
    if (intent) return onConfig(intent.configId, intent.value)
    return undefined
  }
  const permissionRow = (
    <PermissionRowLink
      view={permission}
      onOpen={() => {
        setPanel('permission')
      }}
    />
  )
  const permissionPanel =
    panel === 'permission' && permission?.rows && permission.option ? (
      <PermissionList
        rows={permission.rows}
        onBack={() => {
          setPanel(null)
        }}
        onChoose={value => {
          void choose(permission.option!.id, value)
        }}
      />
    ) : undefined
  if (harness?.models === 'host' && catalog.providers.length > 0) {
    const groups = modelGroups(catalog, preferences, model, showHidden).map(group => ({
      ...group,
      options: group.options.map(option => ({ ...option, description: undefined })),
    }))
    const count = groups.reduce((sum, group) => sum + group.options.length, 0)
    return (
      <ValuePicker
        label="模型"
        placeholder="选择模型"
        value={model ? modelKey(model) : undefined}
        {...(model && !sameModel(model, current) ? { valueText: pendingModelText(model.model) } : {})}
        groups={groups}
        header={header}
        searchable={count >= 8 && panel === null}
        searchMatch={(option, query) => fuzzyModelMatch(option.label, query)}
        width={320}
        leading={leading}
        className="model-picker"
        menuChevron
        onOpenChange={open => {
          if (!open) setPanel(null)
        }}
        onValueChange={key => {
          rememberModel(key)
          const [providerId = '', name = ''] = key.split('\u0000')
          onModel({ providerId, model: name })
        }}
        footer={
          <div className="model-footer">
            {harness?.source === 'builtin' && <p className="model-note">{LATCH_ENGINE_LIMIT}</p>}
            {model && !sameModel(model, current) && (
              <MenuFooterLink
                chevron={false}
                closes
                onClick={() => {
                  onModel(undefined)
                }}>
                {resetModelLabel(current)}
              </MenuFooterLink>
            )}
            {permissionRow}
            <HiddenModelsLink
              shown={showHidden}
              onToggle={() => {
                setShowHidden(!showHidden)
              }}
            />
            <ManageLinks engines={onManageEngines} models={onManageModels} />
          </div>
        }
        panel={permissionPanel}
      />
    )
  }
  const { primary, related } = agentModelControls(config)
  const thought = related.find(option => option.category === 'thought_level')
  const others = related.filter(option => option !== thought)
  const values = (option: SessionConfigOption) =>
    agentConfigValues(option).map(item => ({
      value: item.value,
      label: escapeHiddenCharacters(item.name),
      ...(item.description ? { description: escapeHiddenCharacters(item.description) } : {}),
      ...(blocked
        ? { disabledReason: feedback?.kind === 'unknown' ? '上次切换的结果未知，请先刷新当前设置。' : '正在切换，请稍后。' }
        : {}),
    }))
  const name = harness ? harnessName(harness) : '引擎'
  const shown = primary ? agentConfigLabel(primary) : name
  const level = primary?.category === 'model' && thought ? agentConfigLabel(thought) : undefined
  const text = level && fold < 2 ? `${shown} · ${level}` : shown
  const footer = (
    <div className="model-footer">
      {primary?.category === 'model' && thought && (
        <LevelRow
          option={thought}
          disabled={blocked}
          onChoose={value => {
            void choose(thought.id, value)
          }}
        />
      )}
      {permissionRow}
      {others.map(option => (
        <ConfigRow
          key={option.id}
          option={option}
          disabled={blocked}
          onChoose={value => {
            void choose(option.id, value)
          }}
        />
      ))}
      {feedback && (
        <InlineNotice
          tone={feedback.kind === 'unknown' ? 'warn' : 'error'}
          action={feedback.kind === 'unknown' && onRefresh ? <RefreshConfig refresh={onRefresh} /> : undefined}>
          <VisibleText text={feedback.message} />
        </InlineNotice>
      )}
      <ManageLinks engines={onManageEngines} />
    </div>
  )
  return (
    <ValuePicker
      label={primary ? escapeHiddenCharacters(primary.name) : '引擎'}
      value={primary?.currentValue ?? 'engine'}
      valueText={escapeHiddenCharacters(feedback?.kind === 'unknown' ? `${text} · 结果未知` : text)}
      options={primary ? values(primary) : [{ value: 'engine', label: `${name} 自己决定用哪个模型` }]}
      header={header}
      leading={leading}
      className="model-picker"
      menuChevron
      searchable={(primary?.options.length ?? 0) >= 8 && panel === null}
      width={320}
      pending={busy !== null}
      pendingLabel="正在切换…"
      onOpenChange={open => {
        if (!open) setPanel(null)
      }}
      onValueChange={value => {
        if (primary) return choose(primary.id, value)
        return undefined
      }}
      footer={footer}
      panel={permissionPanel}
    />
  )
}

function ConfigRow({ option, disabled, onChoose }: { option: SessionConfigOption; disabled: boolean; onChoose: (value: string) => void }) {
  return (
    <ValuePicker
      variant="row"
      label={escapeHiddenCharacters(option.name)}
      value={option.currentValue}
      options={agentConfigValues(option).map(item => ({ value: item.value, label: escapeHiddenCharacters(item.name) }))}
      disabled={disabled}
      searchable={option.options.length > 8}
      onValueChange={onChoose}
    />
  )
}

function RefreshConfig({ refresh }: { refresh: () => void | Promise<void> }) {
  const close = useLayerClose()
  return (
    <Button
      size="xs"
      onClick={() => {
        void Promise.resolve(refresh())
          .then(close)
          .catch(() => {})
      }}>
      刷新当前设置
    </Button>
  )
}
