import { useState, type ReactNode } from 'react'
import { ChevronsUpDown, Folder, FolderPlus, Plus, SlidersHorizontal, Sparkles, Undo2 } from 'lucide-react'
import type { HostCatalog, ModelRef, SessionConfigOption, TaskMode } from '@latch/protocol'
import { findProvider, sameModel, startableWorkspaces } from '../composerChoice.ts'
import { basename, middleEllipsis } from '../format.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { ProviderTile } from './BrandTile.tsx'
import { Modal, ModalHeader, type MenuSection } from './overlays.tsx'
import { CODE_ROOT_COPY, SETUP_COPY } from '../core/securityCopy.ts'
import { ProviderSetupPanel } from './SetupPanels.tsx'
import {
  Badge,
  ChoiceList,
  DemoMark,
  ICON_STROKE,
  MenuFooterLink,
  MenuFooterNote,
  SegmentedControl,
  ValuePicker,
  useLayerClose,
  type PickerGroup,
  type LucideIcon,
} from '@latch/ui'

/** A model as one value of a picker. */
const modelKey = (model: ModelRef) => `${model.providerId}\u0000${model.model}`
const modelOf = (key: string): ModelRef => {
  const [providerId = '', model = ''] = key.split('\u0000')
  return { providerId, model }
}

/** The models of every service, grouped under the service's tile and name; the demo model carries its mark. */
function modelGroups(catalog: HostCatalog): Array<PickerGroup<string>> {
  return catalog.providers.map(provider => ({
    id: provider.id,
    label: provider.name,
    media: <ProviderTile provider={provider} size={16} />,
    options: (provider.models.length ? provider.models : [provider.defaultModel]).filter(Boolean).map(model => ({
      value: modelKey({ providerId: provider.id, model }),
      label: model,
      tag: provider.kind === 'demo' ? <DemoMark compact /> : model === provider.defaultModel ? <Badge>默认</Badge> : undefined,
    })),
  }))
}

/** A model switch chosen for an existing session that its next message will carry. */
export interface PendingModel {
  current?: ModelRef
  onReset: () => void
}

export const pendingModelText = (model: string) => `下一条：${model}`
export const resetModelLabel = (current: ModelRef | undefined) => (current ? `撤销切换，继续使用 ${current.model}` : '撤销切换')

/**
 * The model, as a value picker in the composer: the service's tile, the model, the models of every service grouped
 * under it (searchable when there are many). A switch for the next message reads 「下一条：…」 and its undo is the
 * menu's first footer row. Adding a service happens in place: 「添加模型服务…」 turns the layer into the small panel;
 * 管理模型服务… goes to settings. With no service yet the picker still opens, onto that offer.
 */
export function ModelPicker({
  catalog,
  variant,
  value,
  onChange,
  pending,
  access,
  onManage,
  onAdded,
  disabled,
}: {
  catalog: HostCatalog
  variant?: 'row'
  value?: ModelRef
  onChange: (model: ModelRef) => void
  pending?: PendingModel
  access: Pick<DeviceAccess, 'legacy' | 'local' | 'admin'>
  /** Opens 设置 › 模型服务 (devices that may manage the Host). */
  onManage?: () => void
  /** A service was added here: the page fetches the catalog again. */
  onAdded?: () => void
  disabled?: boolean
}) {
  const [adding, setAdding] = useState(false)
  const groups = modelGroups(catalog)
  const count = groups.reduce((sum, group) => sum + group.options.length, 0)
  const provider = value ? findProvider(catalog, value.providerId) : undefined
  return (
    <ValuePicker
      variant={variant}
      label="模型"
      placeholder="选择模型"
      value={value ? modelKey(value) : undefined}
      valueText={pending && value ? pendingModelText(value.model) : undefined}
      groups={groups}
      searchable={count > 8 && !adding}
      width={adding ? 360 : undefined}
      leading={provider ? <ProviderTile provider={provider} size={16} /> : Sparkles}
      className={`${variant === 'row' ? 'new-sheet-row ' : ''}model-picker${pending ? ' is-pending' : ''}`}
      disabled={disabled}
      onOpenChange={open => {
        if (!open) setAdding(false)
      }}
      onValueChange={key => {
        onChange(modelOf(key))
      }}
      footer={
        <>
          {pending && (
            <MenuFooterLink icon={Undo2} chevron={false} closes onClick={pending.onReset}>
              {resetModelLabel(pending.current)}
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
function ModelAddPanel({
  access,
  onCancel,
  onManage,
  onSaved,
}: {
  access: Pick<DeviceAccess, 'legacy' | 'local' | 'admin'>
  onCancel: () => void
  onManage?: () => void
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

/**
 * The project of a new session: the saved projects with their paths (the default one marked), then the Host's start
 * directory. In the desktop app 新建项目… opens the system's folder panel and chooses the new project; elsewhere a note
 * says where projects are created. 管理项目… goes to settings.
 */
export function ProjectPicker({
  catalog,
  variant,
  value,
  onChange,
  onManage,
  onCreate,
  disabled,
}: {
  catalog: HostCatalog
  variant?: 'row'
  value?: string
  onChange: (id: string) => void
  onManage?: () => void
  /** The desktop app on the Host's computer: a new project from a folder chosen in the system's panel. */
  onCreate?: () => void
  disabled?: boolean
}) {
  const workspaces = startableWorkspaces(catalog)
  const start = workspaces.find(workspace => workspace.id === 'default')
  const option = (workspace: (typeof workspaces)[number], label: string) => ({
    value: workspace.id,
    label,
    description: middleEllipsis(workspace.path, 44),
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
    ...(start ? [{ id: 'start', options: [option(start, '启动目录')] }] : []),
  ]
  return (
    <ValuePicker
      variant={variant}
      label="项目"
      className={variant === 'row' ? 'new-sheet-row' : undefined}
      leading={Folder}
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

/** One option an agent exposes for its session (its model, for one), as a value picker. */
export function ConfigPicker({
  option,
  busy,
  onChange,
}: {
  option: SessionConfigOption
  busy: boolean
  onChange: (configId: string, value: string) => void
}) {
  return (
    <ValuePicker
      label={option.name}
      leading={option.category === 'model' ? Sparkles : SlidersHorizontal}
      value={option.currentValue}
      options={option.options.map(item => ({ value: item.value, label: item.name, description: item.description }))}
      disabled={busy}
      disabledReason={busy ? '正在切换' : undefined}
      onValueChange={value => {
        if (value !== option.currentValue) onChange(option.id, value)
      }}
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

// ---- The phone's run-settings sheet --------------------------------------------------------------------------

export function modelSections(catalog: HostCatalog, value: ModelRef | undefined, onChange: (model: ModelRef) => void): MenuSection[] {
  return catalog.providers.map(provider => ({
    id: provider.id,
    label: provider.name,
    leading: <ProviderTile provider={provider} size={16} />,
    items: (provider.models.length ? provider.models : [provider.defaultModel]).filter(Boolean).map(model => ({
      id: `${provider.id}/${model}`,
      label: model,
      checked: sameModel(value, { providerId: provider.id, model }),
      tag: provider.kind === 'demo' ? <Badge tone="warn">演示</Badge> : model === provider.defaultModel ? <Badge>默认</Badge> : undefined,
      onSelect: () => {
        onChange({ providerId: provider.id, model })
      },
    })),
  }))
}

export function workspaceSections(catalog: HostCatalog, value: string | undefined, onChange: (id: string) => void): MenuSection[] {
  return [
    {
      id: 'workspaces',
      items: startableWorkspaces(catalog).map(workspace => ({
        id: workspace.id,
        label: workspace.id === 'default' ? '启动目录' : workspace.name || basename(workspace.path),
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

export function configSections(option: SessionConfigOption, onChange: (value: string) => void): MenuSection[] {
  return [
    {
      id: option.id,
      items: option.options.map(item => ({
        id: item.value,
        label: item.name,
        description: item.description,
        checked: item.value === option.currentValue,
        onSelect: () => {
          onChange(item.value)
        },
      })),
    },
  ]
}

export function RadioList({ label, sections }: { label: string; sections: MenuSection[] }) {
  const items = sections.flatMap(section => section.items.map(item => ({ item, section })))
  return (
    <ChoiceList
      label={label}
      value={items.find(({ item }) => item.checked)?.item.id}
      options={items.map(({ item, section }) => ({
        value: item.id,
        title: item.label,
        description: [section.label, item.description].filter(Boolean).join(' · ') || undefined,
        tag: item.tag,
        media: item.leading,
        disabledReason: item.disabled ? (item.disabledReason ?? '此项暂不可用') : undefined,
      }))}
      onValueChange={value => items.find(({ item }) => item.id === value)?.item.onSelect()}
    />
  )
}

export interface SettingsGroup {
  id: string
  title: string
  sections: MenuSection[]
  /** Actions that belong to this group, such as managing its services; shown under its choices. */
  links?: Array<{ id: string; label: string; onSelect: () => void }>
}

export function RunSettingsGroups({ groups, close }: { groups: SettingsGroup[]; close: () => void }) {
  return (
    <>
      {groups.map(group => (
        <section key={group.id} className="sheet-group">
          <h3>{group.title}</h3>
          <RadioList label={group.title} sections={group.sections} />
          {group.links?.map(link => (
            <button
              key={link.id}
              type="button"
              className="ui-menu-footer-link"
              onClick={() => {
                close()
                link.onSelect()
              }}>
              {link.label}
            </button>
          ))}
        </section>
      ))}
    </>
  )
}

/** Phone: one chip summarizing the run settings, opening a bottom sheet with every choice. */
export function RunSettingsSheet({
  summary,
  groups,
  disabled,
  pending = false,
}: {
  summary: string
  groups: SettingsGroup[]
  disabled?: boolean
  /** The summary names a model switch waiting for the next message. */
  pending?: boolean
}) {
  const [open, setOpen] = useState(false)
  if (groups.length === 0) return null
  return (
    <>
      <button
        type="button"
        className={pending ? 'chip run-settings-chip is-pending' : 'chip run-settings-chip'}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`运行设置：${summary}`}
        disabled={disabled}
        onClick={() => {
          setOpen(true)
        }}>
        <SlidersHorizontal size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />
        <span className="chip-text">{summary}</span>
        <ChevronsUpDown className="chip-chevron" size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
      </button>
      {open && (
        <Modal
          label="运行设置"
          variant="sheet"
          onClose={() => {
            setOpen(false)
          }}>
          <ModalHeader
            title="运行设置"
            onClose={() => {
              setOpen(false)
            }}
          />
          <div className="ui-modal-sheet-body">
            <RunSettingsGroups
              groups={groups}
              close={() => {
                setOpen(false)
              }}
            />
          </div>
        </Modal>
      )}
    </>
  )
}

export function StaticChip({
  icon: Icon,
  leading,
  text,
  label,
  className,
}: {
  icon: LucideIcon
  leading?: ReactNode
  text: string
  label: string
  className?: string
}) {
  return (
    <span className={className ? `chip chip-static ${className}` : 'chip chip-static'} title={label}>
      {leading ?? <Icon size={14} strokeWidth={ICON_STROKE[14]} aria-hidden="true" />}
      <span className="chip-text">{text}</span>
    </span>
  )
}

function manageFooter(label: string, onManage: (() => void) | undefined) {
  return onManage
    ? (close: () => void) => (
        <button
          type="button"
          className="ui-menu-footer-link"
          onClick={() => {
            close()
            onManage()
          }}>
          {label}
        </button>
      )
    : undefined
}
