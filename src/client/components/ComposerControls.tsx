import { Bot, Folder } from 'lucide-react'
import type { HarnessInfo, HostCatalog, ModelRef, SessionConfigOption, TaskMode, TaskSummary } from '../../shared/types.ts'
import { findHarness, sameModel, startableWorkspaces, type ComposerChoice } from '../composerChoice.ts'
import { basename } from '../format.ts'
import { ConfigChips, HarnessPicker, ModelPicker, ModeSwitch, RunSettingsSheet, StaticChip, WorkspacePicker, configSections, harnessSections, modelSections, pendingModelText, resetModelLabel, workspaceSections, type HarnessAccess, type SettingsGroup } from './Pickers.tsx'

const bothModes: TaskMode[] = ['chat', 'agent']

/** Phone run-settings groups for a new session; each group carries its own manage link. */
export function newSessionGroups(catalog: HostCatalog, choice: ComposerChoice, onChoice: (patch: Partial<ComposerChoice>) => void, manage: { providers?: () => void; workspaces?: () => void }, access?: HarnessAccess): SettingsGroup[] {
  const hostModels = findHarness(catalog, choice.harnessId)?.models === 'host'
  return [
    ...(catalog.harnesses.length > 1 ? [{ id: 'harness', title: 'Harness', sections: harnessSections(catalog, choice.harnessId, id => { onChoice({ harnessId: id }) }, access) }] : []),
    ...(hostModels && (catalog.providers.length > 0 || manage.providers) ? [{
      id: 'model', title: '模型', sections: modelSections(catalog, choice.model, model => { onChoice({ model }) }),
      links: manage.providers ? [{ id: 'providers', label: '管理模型服务…', onSelect: manage.providers }] : [],
    }] : []),
    ...(startableWorkspaces(catalog).length > 1 || manage.workspaces ? [{
      id: 'workspace', title: '项目', sections: workspaceSections(catalog, choice.workspaceId, id => { onChoice({ workspaceId: id }) }),
      links: manage.workspaces ? [{ id: 'workspaces', label: '管理项目…', onSelect: manage.workspaces }] : [],
    }] : []),
  ]
}

/** New session: harness, model (host-model harnesses only), project and mode. Without a catalog only the mode remains. */
export function NewSessionControls({ catalog, choice, onChoice, phone, disabled, onManageProviders, onManageWorkspaces, access }: {
  catalog?: HostCatalog
  choice: ComposerChoice
  onChoice: (patch: Partial<ComposerChoice>) => void
  phone: boolean
  disabled: boolean
  onManageProviders?: () => void
  onManageWorkspaces?: () => void
  access?: HarnessAccess
}) {
  const harness = findHarness(catalog, choice.harnessId)
  const modes = harness?.modes.length ? harness.modes : bothModes
  const mode = <ModeSwitch value={choice.mode} modes={modes} disabled={disabled} onChange={value => { onChoice({ mode: value }) }} />
  if (!catalog) return mode
  const hostModels = harness?.models === 'host'
  if (phone) {
    const groups = newSessionGroups(catalog, choice, onChoice, { providers: onManageProviders, workspaces: onManageWorkspaces }, access)
    const summary = [harness?.name, hostModels ? choice.model?.model : undefined].filter(Boolean).join(' · ') || '运行设置'
    return <>
      {groups.length > 0 ? <RunSettingsSheet summary={summary} groups={groups} disabled={disabled} /> : <StaticChip icon={Bot} text={summary} label={summary} />}
      {mode}
    </>
  }
  return <>
    <HarnessPicker catalog={catalog} value={choice.harnessId} disabled={disabled} access={access} onChange={id => { onChoice({ harnessId: id }) }} />
    {hostModels && <ModelPicker catalog={catalog} value={choice.model} disabled={disabled} onManage={onManageProviders} onChange={model => { onChoice({ model }) }} />}
    <WorkspacePicker catalog={catalog} value={choice.workspaceId} disabled={disabled} onManage={onManageWorkspaces} onChange={id => { onChoice({ workspaceId: id }) }} />
    {mode}
  </>
}

/** Existing session: switch its model from the next turn (host models) or change agent options. */
export function SessionControls({ catalog, summary, harness, model, current, onModel, config, configBusy, onConfig, phone, onManageProviders, locked = false }: {
  catalog?: HostCatalog
  summary: TaskSummary
  harness?: HarnessInfo
  /** Effective model for the next prompt, including an unsent switch. */
  model?: ModelRef
  current?: ModelRef
  onModel: (model: ModelRef | undefined) => void
  config: SessionConfigOption[]
  configBusy: string | null
  onConfig: (configId: string, value: string) => void
  phone: boolean
  onManageProviders?: () => void
  /** The device may not change this session's options (read-only or stopped). */
  locked?: boolean
}) {
  if (!catalog) return null
  if (locked) return summary.cwd && !phone ? <StaticChip icon={Folder} text={basename(summary.cwd)} label={`项目：${summary.cwd}`} /> : null
  const hostModels = harness?.models === 'host' && catalog.providers.length > 0
  const choose = (next: ModelRef) => { onModel(sameModel(next, current) ? undefined : next) }
  const pending = hostModels && model !== undefined && !sameModel(model, current) ? { current, onReset: () => { onModel(undefined) } } : undefined
  const workspace = summary.cwd ? <StaticChip icon={Folder} text={basename(summary.cwd)} label={`项目：${summary.cwd}`} /> : null
  if (phone) {
    const groups: SettingsGroup[] = [
      ...(hostModels ? [{
        id: 'model', title: '模型（从下一条消息起）', sections: modelSections(catalog, model, choose),
        links: [
          ...(pending ? [{ id: 'reset', label: resetModelLabel(current), onSelect: pending.onReset }] : []),
          ...(onManageProviders ? [{ id: 'providers', label: '管理模型服务…', onSelect: onManageProviders }] : []),
        ],
      }] : []),
      ...config.map(option => ({ id: option.id, title: option.name, sections: configSections(option, value => { if (value !== option.currentValue) onConfig(option.id, value) }) })),
    ]
    const modelText = hostModels && model ? pending ? pendingModelText(model.model) : model.model : undefined
    const label = [modelText, ...config.map(option => option.options.find(item => item.value === option.currentValue)?.name)].filter(Boolean).join(' · ')
    // The project stays in the session details on phones; the toolbar keeps one row.
    return groups.length > 0 ? <RunSettingsSheet summary={label || '运行设置'} groups={groups} disabled={configBusy !== null} pending={pending !== undefined} /> : null
  }
  return <>
    {hostModels && <ModelPicker catalog={catalog} value={model} pending={pending} onManage={onManageProviders} onChange={choose} />}
    <ConfigChips config={config} busy={configBusy} onChange={onConfig} />
    {workspace}
  </>
}
