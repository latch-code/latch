import { Sparkles } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { HarnessInfo, HostCatalog, ModelRef, SessionConfigOption, TaskSummary } from '@latch/protocol'
import { MOTION, usePresence } from '@latch/ui'
import { findHarness, sameModel, startableWorkspaces, type ComposerChoice } from '../composerChoice.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import {
  StaticChip,
  ConfigPicker,
  ModelPicker,
  ModeSwitch,
  ProjectPicker,
  RunSettingsSheet,
  modelSections,
  pendingModelText,
  workspaceSections,
  type SettingsGroup,
} from './Pickers.tsx'

type Access = Pick<DeviceAccess, 'legacy' | 'local' | 'admin'>

/** Phone run-settings groups for a new session (the harness is the row of tiles); each group carries its manage link. */
export function newSessionGroups(
  catalog: HostCatalog,
  choice: ComposerChoice,
  onChoice: (patch: Partial<ComposerChoice>) => void,
  manage: { providers?: () => void; workspaces?: () => void },
): SettingsGroup[] {
  const hostModels = findHarness(catalog, choice.harnessId)?.models === 'host'
  return [
    ...(hostModels && (catalog.providers.length > 0 || manage.providers)
      ? [
          {
            id: 'model',
            title: '模型',
            sections: modelSections(catalog, choice.model, model => {
              onChoice({ model })
            }),
            links: manage.providers ? [{ id: 'providers', label: '管理模型服务…', onSelect: manage.providers }] : [],
          },
        ]
      : []),
    ...(choice.mode !== 'chat' && (startableWorkspaces(catalog).length > 1 || manage.workspaces)
      ? [
          {
            id: 'workspace',
            title: '项目',
            sections: workspaceSections(catalog, choice.workspaceId, id => {
              onChoice({ workspaceId: id })
            }),
            links: manage.workspaces ? [{ id: 'workspaces', label: '管理项目…', onSelect: manage.workspaces }] : [],
          },
        ]
      : []),
  ]
}

/**
 * The toolbar of a new session's input: the project (not for a conversation, which reads and writes no files) and the
 * model (only for a harness on the Host's models). The harness is chosen in the tiles above. On phones both sit in
 * one run-settings sheet. A Host without a catalog offers only 对话 / Agent.
 */
export function NewSessionControls({
  catalog,
  choice,
  onChoice,
  phone,
  disabled,
  access,
  onManageProviders,
  onManageWorkspaces,
  onCreateProject,
  onProvidersChanged,
}: {
  catalog?: HostCatalog
  choice: ComposerChoice
  onChoice: (patch: Partial<ComposerChoice>) => void
  phone: boolean
  disabled: boolean
  access: Access
  onManageProviders?: () => void
  onManageWorkspaces?: () => void
  /** The desktop app on the Host's computer: a new project from the system's folder panel. */
  onCreateProject?: () => void
  onProvidersChanged?: () => void
}) {
  if (!catalog)
    return (
      <ModeSwitch
        value={choice.mode}
        disabled={disabled}
        onChange={mode => {
          onChoice({ mode })
        }}
      />
    )
  const harness = findHarness(catalog, choice.harnessId)
  const hostModels = harness?.models === 'host'
  const projects = choice.mode !== 'chat'
  if (phone) {
    const groups = newSessionGroups(catalog, choice, onChoice, { providers: onManageProviders, workspaces: onManageWorkspaces })
    const workspace = startableWorkspaces(catalog).find(item => item.id === choice.workspaceId)
    const summary =
      [
        hostModels ? choice.model?.model : undefined,
        projects && workspace ? (workspace.id === 'default' ? '启动目录' : workspace.name) : undefined,
      ]
        .filter(Boolean)
        .join(' · ') || '运行设置'
    return <RunSettingsSheet summary={summary} groups={groups} disabled={disabled} />
  }
  return (
    <>
      <Fading show={projects}>
        <ProjectPicker
          access={access}
          harness={harness}
          catalog={catalog}
          value={choice.workspaceId}
          disabled={disabled}
          onManage={onManageWorkspaces}
          onCreate={onCreateProject}
          onChange={id => {
            onChoice({ workspaceId: id })
          }}
        />
      </Fading>
      <Fading show={hostModels}>
        <ModelPicker
          catalog={catalog}
          value={choice.model}
          access={access}
          disabled={disabled}
          onManage={onManageProviders}
          onAdded={onProvidersChanged}
          onChange={model => {
            onChoice({ model })
          }}
        />
      </Fading>
    </>
  )
}

/**
 * A toolbar control that comes and goes with the choice above it: it fades in when it comes (not on the page's first
 * render) and fades out before it goes. Under reduced motion it changes at once.
 */
function Fading({ show, children }: { show: boolean; children: ReactNode }) {
  const { present, leaving } = usePresence(show, MOTION.fastExit)
  // Shown from the start, it needs no entrance; once it has gone, every return fades in.
  const [entering, setEntering] = useState(false)
  if (!show && !entering) setEntering(true)
  if (!present) return null
  return (
    <span className="composer-fade" data-enter={entering ? '' : undefined} data-leaving={leaving ? '' : undefined}>
      {children}
    </span>
  )
}

/**
 * An existing session's toolbar: its model for the next message (a switch reads 「下一条：…」 and can be undone from the
 * menu), or the agent's own model option. Its other options are in the session information. On phones the model and
 * every option live in the session information. Nothing while the device may not change them.
 */
export function SessionControls({
  catalog,
  harness,
  model,
  current,
  onModel,
  config,
  configBusy,
  onConfig,
  phone,
  access,
  onManageProviders,
  onProvidersChanged,
  locked = false,
}: {
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
  access: Access
  onManageProviders?: () => void
  onProvidersChanged?: () => void
  /** The device may not change this session's options (read-only or stopped). */
  locked?: boolean
}) {
  if (!catalog || locked) return null
  const hostModels = harness?.models === 'host' && catalog.providers.length > 0
  const choose = (next: ModelRef) => {
    onModel(sameModel(next, current) ? undefined : next)
  }
  const pending =
    hostModels && model !== undefined && !sameModel(model, current)
      ? {
          current,
          onReset: () => {
            onModel(undefined)
          },
        }
      : undefined
  // Phone session options live in 会话信息; this chip only reports an unsent model change.
  if (phone)
    return pending && model ? (
      <StaticChip icon={Sparkles} text={pendingModelText(model.model)} label={`下一条消息使用：${model.model}`} className="is-pending" />
    ) : null

  const modelOption = config.find(option => option.category === 'model')
  if (hostModels)
    return (
      <ModelPicker
        catalog={catalog}
        value={model}
        pending={pending}
        access={access}
        onManage={onManageProviders}
        onAdded={onProvidersChanged}
        onChange={choose}
      />
    )
  return modelOption ? <ConfigPicker option={modelOption} busy={configBusy !== null} onChange={onConfig} /> : null
}
