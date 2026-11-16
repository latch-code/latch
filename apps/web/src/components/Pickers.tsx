import { useEffect, useState } from 'react'
import { FolderPlus } from 'lucide-react'
import type { AppSnapshot, HarnessInfo, HostCatalog, ModelRef, SessionConfigOption, TaskMode } from '@latch/protocol'
import { api } from '../core/api.ts'
import { findProvider, noProjectLine, pinnedChoice, startableWorkspaces } from '../composerChoice.ts'
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
import { HealthDot, menuHealth, nameWithHealth } from './ServiceHealth.tsx'
import type { MenuSection } from './overlays.tsx'
import { CODE_ROOT_COPY, computerName, SETUP_COPY } from '../core/securityCopy.ts'
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
  FolderGlyph,
  PlusGlyph,
  ModelGlyph,
} from '@latch/ui'

/** A model as one value of a picker. */
const modelOf = (key: string): ModelRef => {
  const [providerId = '', model = ''] = key.split('\u0000')
  return { providerId, model }
}

/**
 * The Host computer's name for a line that sends this device there (`computerName`), read from the snapshot only while
 * such a line shows; 「Mac」 until it arrives or when it cannot be read.
 */
export function useComputerName(needed: boolean): string {
  const [hostName, setHostName] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!needed || hostName !== undefined) return undefined
    let active = true
    api<AppSnapshot>('snapshot').then(
      current => {
        if (active) setHostName(current.hostName)
      },
      () => {
        // The line still reads 「Mac」.
      },
    )
    return () => {
      active = false
    }
  }, [needed, hostName])
  return computerName(hostName)
}

/**
 * The models of every service, grouped under the service's tile and name; the demo model carries its mark. Models hidden
 * in 设置 are not listed (the chosen one stays); they come back from there, not from a disclosure in the menu.
 */
export function modelGroups(
  catalog: HostCatalog,
  preferences?: ModelPreferences,
  current?: ModelRef,
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
    // Only what stops the service now, as the Host's real requests showed it: the word in the name, a dot beside the tile.
    label: nameWithHealth(provider.name, menuHealth(provider)),
    media: (
      <>
        <ProviderTile provider={provider} size={16} />
        {menuHealth(provider) && <HealthDot words={menuHealth(provider)!} />}
      </>
    ),
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
      .filter(option => !hidden.has(option.value) || selected === option.value),
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
  const [open, setOpen] = useState(false)
  const modelPreferences = useModelPreferences()
  const groups = modelGroups(catalog, modelPreferences, value, access)
  const count = groups.reduce((sum, group) => sum + group.options.length, 0)
  const computer = useComputerName(open && !access.admin && count === 0)
  const provider = value ? findProvider(catalog, value.providerId) : undefined
  return (
    <ValuePicker
      variant={variant}
      label="模型"
      placeholder="选择模型"
      value={value ? modelKey(value) : undefined}
      groups={groups}
      searchable={count > 8 && !adding}
      searchMatch={(option, query) => fuzzyModelMatch(`${option.label} ${option.description ?? ''}`, query)}
      width={adding ? 'md' : undefined}
      leading={provider ? <ProviderTile provider={provider} size={16} /> : ModelGlyph}
      className={`${variant === 'row' ? 'new-sheet-row ' : ''}model-picker`}
      disabled={disabled}
      onOpenChange={next => {
        setOpen(next)
        if (!next) setAdding(false)
      }}
      onValueChange={key => {
        rememberModel(key)
        onChange(modelOf(key))
      }}
      footer={
        <>
          {access.admin ? (
            <MenuFooterLink
              icon={PlusGlyph}
              chevron={false}
              onClick={() => {
                setAdding(true)
              }}>
              添加模型服务…
            </MenuFooterLink>
          ) : (
            count === 0 && <MenuFooterNote>{SETUP_COPY.addProviderElsewhere(computer)}</MenuFooterNote>
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
 * The project of a new session: the saved projects with their paths (the default one marked) and going without, then
 * 添加项目… and 管理项目…. In the desktop app 添加项目… opens the system's folder panel and the folder becomes a project at
 * once; elsewhere a note names the computer where projects are added. 管理项目… goes to settings.
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
  openRequest,
  notice,
  onClosed,
  defaultLocation,
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
  /** Each new value opens the list: sending found no project, or a folder was refused. */
  openRequest?: number | undefined
  /** Why the folder just chosen did not become a project, in the Host's words. */
  notice?: string | undefined
  onClosed?: (() => void) | undefined
  /** Agent forms use the same default ID for the Host-allocated home, never for the public start folder. */
  defaultLocation?: { label: string; description: string }
}) {
  const workspaces = catalog.workspaces
  const start = workspaces.find(workspace => workspace.id === 'default')
  const [open, setOpen] = useState(false)
  const computer = useComputerName(open && !onCreate)
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
      ?? (harness?.projectFolders?.access === 'all'
      && harness.projectFolders.max !== undefined
      && projectFolders(workspace).length > harness.projectFolders.max
        ? `${harness.capabilities.display.label} 最多使用 ${harness.projectFolders.max} 个文件夹`
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
    ...(start
      ? [
          {
            id: 'start',
            options: [
              {
                ...option(start, defaultLocation?.label ?? NO_PROJECT),
                tag: undefined,
                // The Host's own start directory gives each session a new folder; one the owner set is used as it is.
                description:
                  defaultLocation?.description ?? (catalog.sessionFolders ? noProjectLine(harness) : middleEllipsis(start.path, 44)),
              },
            ],
          },
        ]
      : []),
  ]
  return (
    <ValuePicker
      variant={variant}
      label="项目"
      className={inline ? 'project-inline' : variant === 'row' ? 'new-sheet-row' : undefined}
      menuChevron={variant !== 'row'}
      openRequest={openRequest}
      onOpenChange={next => {
        setOpen(next)
        if (!next) onClosed?.()
      }}
      leading={
        inline
          ? undefined
          : workspaces.find(item => item.id === value)?.glyph
            ? (PROJECT_ICONS[workspaces.find(item => item.id === value)!.glyph!]?.icon ?? FolderGlyph)
            : FolderGlyph
      }
      placeholder={NO_PROJECT}
      header={{ title: '项目' }}
      width="sm"
      value={value}
      groups={groups}
      disabled={disabled}
      onValueChange={onChange}
      footer={
        <>
          {notice && <MenuFooterNote>{notice}</MenuFooterNote>}
          {onCreate ? (
            <MenuFooterLink icon={FolderPlus} chevron={false} closes onClick={onCreate}>
              添加项目…
            </MenuFooterLink>
          ) : (
            <MenuFooterNote>{SETUP_COPY.addProjectElsewhere(computer)}</MenuFooterNote>
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
        { value: 'chat', label: '对话' },
        { value: 'agent', label: 'Agent' },
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
