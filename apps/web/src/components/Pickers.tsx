import { useState } from 'react'
import { Folder, FolderPlus, Plus, Sparkles } from 'lucide-react'
import type { HarnessInfo, HostCatalog, ModelRef, SessionConfigOption, TaskMode } from '@latch/protocol'
import { findProvider, pinnedChoice, startableWorkspaces } from '../composerChoice.ts'
import {
  fuzzyModelMatch,
  getModelPreferences,
  modelKey,
  rememberModel,
  useModelPreferences,
  type ModelPreferences,
} from '../modelPreferences.ts'
import { PROJECT_ICONS, ProjectIcon, projectFolders } from '../projects.tsx'
import { basename, middleEllipsis } from '../format.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { ProviderTile } from './BrandTile.tsx'
import type { MenuSection } from './overlays.tsx'
import { CODE_ROOT_COPY, REMOTE_PROJECT_REFUSED, SETUP_COPY } from '../core/securityCopy.ts'
import { ProviderSetupPanel } from './SetupPanels.tsx'
import {
  Badge,
  ChoiceList,
  DemoMark,
  MenuFooterLink,
  MenuFooterNote,
  SegmentedControl,
  ValuePicker,
  useLayerClose,
  type PickerGroup,
} from '@latch/ui'

/** A model as one value of a picker. */
const modelOf = (key: string): ModelRef => {
  const [providerId = '', model = ''] = key.split('\u0000')
  return { providerId, model }
}

/** The models of every service, grouped under the service's tile and name; the demo model carries its mark. */
export function modelGroups(
  catalog: HostCatalog,
  preferences?: ModelPreferences,
  current?: ModelRef,
  showHidden = false,
  access?: Pick<DeviceAccess, 'legacy' | 'local'>,
): Array<PickerGroup<string>> {
  const hidden = new Set(preferences?.hidden),
    selected = current && modelKey(current)
  // Where new sessions are pinned to one model, the tag marks that one rather than each service's own first choice.
  const pinned = pinnedChoice(catalog, access)?.model
  const isDefault = (providerId: string, serviceDefault: string, model: string) =>
    pinned ? pinned.providerId === providerId && pinned.model === model : model === serviceDefault
  const groups: Array<PickerGroup<string>> = catalog.providers.map(provider => ({
    id: provider.id,
    label: provider.name,
    media: <ProviderTile provider={provider} size={16} />,
    options: (provider.models.length ? provider.models : [provider.defaultModel])
      .filter(Boolean)
      .map(model => ({
        value: modelKey({ providerId: provider.id, model }),
        label: model,
        description: provider.name,
        tag:
          provider.kind === 'demo' ? (
            <DemoMark compact />
          ) : isDefault(provider.id, provider.defaultModel, model) ? (
            <Badge>默认</Badge>
          ) : undefined,
      }))
      .filter(option => showHidden || !hidden.has(option.value) || selected === option.value),
  }))
  const recent = (preferences?.recent ?? []).flatMap(key => groups.flatMap(group => group.options).filter(option => option.value === key))
  const keys = new Set(recent.map(option => option.value))
  return [
    ...(recent.length ? [{ id: '~recent', label: '最近使用', options: recent }] : []),
    ...groups.map(group => ({ ...group, options: group.options.filter(option => !keys.has(option.value)) })),
  ].filter(group => group.options.length)
}

/**
 * The model, as a value picker in the composer: the service's tile, the model, the models of every service grouped
 * under it (searchable when there are many). Adding a service happens in place: 「添加模型服务…」 turns the layer into the small panel;
 * 管理模型服务… goes to settings. With no service yet the picker still opens, onto that offer.
 */
export function ModelPicker({
  catalog,
  variant,
  value,
  onChange,
  access,
  onManage,
  onAdded,
  disabled,
}: {
  catalog: HostCatalog
  variant?: 'row'
  value?: ModelRef
  onChange: (model: ModelRef) => void
  access: Pick<DeviceAccess, 'legacy' | 'local' | 'admin'>
  /** Opens 设置 › 模型服务 (devices that may manage the Host). */
  onManage?: () => void
  /** A service was added here: the page fetches the catalog again. */
  onAdded?: () => void
  disabled?: boolean
}) {
  const [adding, setAdding] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const modelPreferences = useModelPreferences()
  const groups = modelGroups(catalog, modelPreferences, value, showHidden, access)
  const count = groups.reduce((sum, group) => sum + group.options.length, 0)
  const provider = value ? findProvider(catalog, value.providerId) : undefined
  return (
    <ValuePicker
      variant={variant}
      label="模型"
      placeholder="选择模型"
      value={value ? modelKey(value) : undefined}
      groups={groups}
      searchable={(count > 8 || showHidden) && !adding}
      searchMatch={(option, query) => fuzzyModelMatch(`${option.label} ${option.description ?? ''}`, query)}
      width={adding ? 360 : undefined}
      leading={provider ? <ProviderTile provider={provider} size={16} /> : Sparkles}
      className={`${variant === 'row' ? 'new-sheet-row ' : ''}model-picker`}
      disabled={disabled}
      onOpenChange={open => {
        if (!open) setAdding(false)
      }}
      onValueChange={key => {
        rememberModel(key)
        onChange(modelOf(key))
      }}
      footer={
        <>
          {modelPreferences.hidden.length > 0 && (
            <MenuFooterLink onClick={() => setShowHidden(!showHidden)}>
              {showHidden ? '收起隐藏的模型' : `显示隐藏的模型（${modelPreferences.hidden.length}）`}
            </MenuFooterLink>
          )}
          {access.admin ? (
            <MenuFooterLink
              icon={Plus}
              chevron={false}
              onClick={() => {
                setAdding(true)
              }}>
              添加模型服务…
            </MenuFooterLink>
          ) : (
            count === 0 && <MenuFooterNote>{SETUP_COPY.addProviderElsewhere}</MenuFooterNote>
          )}
          {onManage && (
            <MenuFooterLink closes onClick={onManage}>
              管理模型服务…
            </MenuFooterLink>
          )}
        </>
      }
      panel={
        adding ? (
          <ModelAddPanel
            access={access}
            onCancel={() => {
              setAdding(false)
            }}
            onManage={onManage}
            onSaved={model => {
              rememberModel(modelKey(model))
              onChange(model)
              onAdded?.()
            }}
          />
        ) : undefined
      }
    />
  )
}

/** The model picker's layer as the panel that adds a service; saving uses its model and closes the layer. */
export function ModelAddPanel({
  access,
  onCancel,
  onManage,
  onSaved,
}: {
  access: Pick<DeviceAccess, 'legacy' | 'local' | 'admin'>
  onCancel: () => void
  onManage?: (() => void) | undefined
  onSaved: (model: ModelRef) => void
}) {
  const close = useLayerClose()
  return (
    <ProviderSetupPanel
      access={access}
      onCancel={onCancel}
      {...(onManage
        ? {
            onSettings: () => {
              close()
              onManage()
            },
          }
        : {})}
      onSaved={model => {
        close()
        onSaved(model)
      }}
    />
  )
}

const NO_PROJECT = '不选项目'

/**
 * The project of a new session: the saved projects with their paths (the default one marked), then the Host's start
 * directory. In the desktop app 新建项目… opens the system's folder panel and chooses the new project; elsewhere a note
 * says where projects are created. 管理项目… goes to settings.
 */
export function ProjectPicker({
  catalog,
  harness,
  access,
  variant,
  inline = false,
  value,
  onChange,
  onManage,
  onCreate,
  disabled,
}: {
  catalog: HostCatalog
  harness?: HarnessInfo | undefined
  access?: Pick<DeviceAccess, 'local' | 'legacy'>
  variant?: 'row'
  /** Inside the new-session question: only the name, underlined under the pointer. */
  inline?: boolean
  value?: string
  onChange: (id: string) => void
  onManage?: (() => void) | undefined
  /** The desktop app on the Host's computer: a new project from a folder chosen in the system's panel. */
  onCreate?: (() => void) | undefined
  disabled?: boolean
}) {
  const workspaces = catalog.workspaces
  const start = workspaces.find(workspace => workspace.id === 'default')
  const option = (workspace: (typeof workspaces)[number], label: string) => ({
    value: workspace.id,
    label,
    description:
      projectFolders(workspace).length > 1
        ? `${projectFolders(workspace).length} 个文件夹 · ${projectFolders(workspace)
            .map(folder => basename(folder.path))
            .join('、')}`
        : middleEllipsis(workspace.path, 44),
    media: <ProjectIcon project={workspace} size={16} />,
    disabledReason:
      workspace.unavailable
      ?? (access && !access.local && !access.legacy && workspace.remoteStart === false ? REMOTE_PROJECT_REFUSED : undefined)
      ?? (harness?.projectFolders?.access === 'all'
      && harness.projectFolders.max !== undefined
      && projectFolders(workspace).length > harness.projectFolders.max
        ? `${harness.name} 最多使用 ${harness.projectFolders.max} 个文件夹`
        : undefined),
    tag: workspace.codeRoot ? (
      <Badge tone="warn">{CODE_ROOT_COPY.badge}</Badge>
    ) : workspace.id === catalog.defaults.workspaceId ? (
      <Badge>默认</Badge>
    ) : undefined,
  })
  const groups: Array<PickerGroup<string>> = [
    {
      id: 'projects',
      options: workspaces
        .filter(workspace => workspace.id !== 'default')
        .map(workspace => option(workspace, workspace.name || basename(workspace.path))),
    },
    ...(start ? [{ id: 'start', options: [{ ...option(start, NO_PROJECT), description: undefined }] }] : []),
  ]
  return (
    <ValuePicker
      variant={variant}
      label="项目"
      className={inline ? 'project-inline' : variant === 'row' ? 'new-sheet-row' : undefined}
      menuChevron={variant !== 'row'}
      leading={
        inline
          ? undefined
          : workspaces.find(item => item.id === value)?.glyph
            ? (PROJECT_ICONS[workspaces.find(item => item.id === value)!.glyph!]?.icon ?? Folder)
            : Folder
      }
      placeholder="选择项目"
      header={{ title: '项目' }}
      width={320}
      value={value}
      groups={groups}
      disabled={disabled}
      onValueChange={onChange}
      footer={
        <>
          {onCreate ? (
            <MenuFooterLink icon={FolderPlus} chevron={false} closes onClick={onCreate}>
              新建项目…
            </MenuFooterLink>
          ) : (
            <MenuFooterNote>{SETUP_COPY.addProjectElsewhere}</MenuFooterNote>
          )}
          {onManage && (
            <MenuFooterLink closes onClick={onManage}>
              管理项目…
            </MenuFooterLink>
          )}
        </>
      }
    />
  )
}

/** 对话 / Agent for a Host that sends no catalog of harnesses, where the way of working is the only choice. */
export function ModeSwitch({ value, onChange, disabled }: { value: TaskMode; onChange: (mode: TaskMode) => void; disabled?: boolean }) {
  return (
    <SegmentedControl
      label="会话模式"
      value={value}
      disabled={disabled}
      onValueChange={onChange}
      className="mode-switch"
      options={[
        { value: 'chat', label: '对话', title: '只对话，不调用工具' },
        { value: 'agent', label: 'Agent', title: '可调用工具，需要时请你批准' },
      ]}
    />
  )
}

export function workspaceSections(catalog: HostCatalog, value: string | undefined, onChange: (id: string) => void): MenuSection[] {
  return [
    {
      id: 'workspaces',
      items: startableWorkspaces(catalog).map(workspace => ({
        id: workspace.id,
        label: workspace.id === 'default' ? NO_PROJECT : workspace.name || basename(workspace.path),
        description: middleEllipsis(workspace.path, 44),
        // A folder in Latch's program directory: every Latch 内置 write will ask on the Host's computer.
        tag: workspace.codeRoot ? <Badge tone="warn">{CODE_ROOT_COPY.badge}</Badge> : undefined,
        checked: workspace.id === value,
        onSelect: () => {
          onChange(workspace.id)
        },
      })),
    },
  ]
}
