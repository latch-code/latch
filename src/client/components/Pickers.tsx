import { useState } from 'react'
import { Bot, Check, ChevronDown, Folder, SlidersHorizontal, Sparkles } from 'lucide-react'
import type { HarnessInfo, HostCatalog, ModelRef, SessionConfigOption, TaskMode } from '../../shared/types.ts'
import { findHarness, sameModel, startableWorkspaces } from '../composerChoice.ts'
import { basename, middleEllipsis } from '../format.ts'
import { ICON_STROKE, type LucideIcon } from '../icons.tsx'
import { harnessGate, harnessLevel, type DeviceAccess } from '../permissions.ts'
import { Menu, Modal, ModalHeader, type MenuSection, type MenuTriggerProps } from './overlays.tsx'
import { Badge, Segmented } from './ui.tsx'

const sourceLabels: Record<HarnessInfo['source'], string> = { builtin: '内置', acp: 'ACP', plugin: '插件' }

function ChipButton({
  icon: Icon,
  text,
  label,
  trigger,
  disabled,
  className = '',
}: {
  icon: LucideIcon
  text: string
  label: string
  trigger: MenuTriggerProps
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      className={className ? `chip ${className}` : 'chip'}
      aria-label={label}
      title={label}
      disabled={disabled}
      {...trigger}>
      <Icon size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
      <span className="chip-text">{text}</span>
      <ChevronDown className="chip-chevron" size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
    </button>
  )
}

export function StaticChip({ icon: Icon, text, label }: { icon: LucideIcon; text: string; label: string }) {
  return (
    <span className="chip chip-static" title={label}>
      <Icon size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
      <span className="chip-text">{text}</span>
    </span>
  )
}

function manageFooter(label: string, onManage: (() => void) | undefined) {
  return onManage
    ? (close: () => void) => (
        <button
          type="button"
          className="menu-footer-link"
          onClick={() => {
            close()
            onManage()
          }}>
          {label}
        </button>
      )
    : undefined
}

/** Which harnesses this device may start; without access information every ready harness is offered. */
export type HarnessAccess = Pick<DeviceAccess, 'legacy' | 'local'>
const openAccess: HarnessAccess = { legacy: true, local: false }

export function harnessSections(
  catalog: HostCatalog,
  value: string | undefined,
  onChange: (id: string) => void,
  access: HarnessAccess = openAccess,
): MenuSection[] {
  return [
    {
      id: 'harnesses',
      items: catalog.harnesses.map(harness => {
        const gate = harnessGate(harness, access)
        const full = !access.legacy && harnessLevel(harness) === 'L3'
        return {
          id: harness.id,
          label: harness.name,
          checked: harness.id === value,
          description: harness.description ?? (harness.models === 'agent' ? '自带模型与登录' : '使用执行端的模型服务'),
          tag: (
            <>
              {full && <Badge tone="warn">L3</Badge>}
              <Badge>{sourceLabels[harness.source]}</Badge>
            </>
          ),
          disabled: harness.status !== 'ready' || !gate.allowed,
          disabledReason: harness.status !== 'ready' ? harness.statusMessage || '暂不可用' : gate.reason,
          onSelect: () => {
            onChange(harness.id)
          },
        }
      }),
    },
  ]
}

export function modelSections(catalog: HostCatalog, value: ModelRef | undefined, onChange: (model: ModelRef) => void): MenuSection[] {
  return catalog.providers.map(provider => ({
    id: provider.id,
    label: provider.name,
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
        label: workspace.name || basename(workspace.path),
        description: middleEllipsis(workspace.path, 44),
        checked: workspace.id === value,
        onSelect: () => {
          onChange(workspace.id)
        },
      })),
    },
  ]
}

export function HarnessPicker({
  catalog,
  value,
  onChange,
  disabled,
  access,
}: {
  catalog: HostCatalog
  value?: string
  onChange: (id: string) => void
  disabled?: boolean
  access?: HarnessAccess
}) {
  const harness = findHarness(catalog, value)
  const text = harness?.name ?? '选择 Harness'
  if (catalog.harnesses.length <= 1 && harness?.status === 'ready') return <StaticChip icon={Bot} text={text} label={`Harness：${text}`} />
  return (
    <Menu
      label="选择 Harness"
      selection
      placement="top-start"
      sections={harnessSections(catalog, value, onChange, access)}
      trigger={props => <ChipButton icon={Bot} text={text} label={`Harness：${text}`} trigger={props} disabled={disabled} />}
    />
  )
}

/** A model switch chosen for an existing session that its next message will carry. */
export interface PendingModel {
  current?: ModelRef
  onReset: () => void
}

export const pendingModelText = (model: string) => `下一条：${model}`
export const resetModelLabel = (current: ModelRef | undefined) => (current ? `撤销切换，继续使用 ${current.model}` : '撤销切换')

export function ModelPicker({
  catalog,
  value,
  onChange,
  onManage,
  disabled,
  pending,
}: {
  catalog: HostCatalog
  value?: ModelRef
  onChange: (model: ModelRef) => void
  onManage?: () => void
  disabled?: boolean
  pending?: PendingModel
}) {
  const text = value ? (pending ? pendingModelText(value.model) : value.model) : '选择模型'
  const footer =
    pending || onManage
      ? (close: () => void) => (
          <>
            {pending && (
              <button
                type="button"
                className="menu-footer-link"
                onClick={() => {
                  close()
                  pending.onReset()
                }}>
                {resetModelLabel(pending.current)}
              </button>
            )}
            {onManage && (
              <button
                type="button"
                className="menu-footer-link"
                onClick={() => {
                  close()
                  onManage()
                }}>
                管理模型服务…
              </button>
            )}
          </>
        )
      : undefined
  return (
    <Menu
      label="选择模型"
      selection
      placement="top-start"
      sections={modelSections(catalog, value, onChange)}
      footer={footer}
      trigger={props => (
        <ChipButton
          icon={Sparkles}
          text={text}
          label={pending && value ? `下一条消息使用：${value.model}` : `模型：${text}`}
          trigger={props}
          className={pending ? 'is-pending' : ''}
          disabled={disabled || (catalog.providers.length === 0 && !onManage)}
        />
      )}
    />
  )
}

export function WorkspacePicker({
  catalog,
  value,
  onChange,
  onManage,
  disabled,
}: {
  catalog: HostCatalog
  value?: string
  onChange: (id: string) => void
  onManage?: () => void
  disabled?: boolean
}) {
  const workspaces = startableWorkspaces(catalog)
  const workspace = workspaces.find(item => item.id === value)
  const text = workspace ? workspace.name || basename(workspace.path) : '选择项目'
  if (workspaces.length <= 1 && !onManage) return <StaticChip icon={Folder} text={text} label={`项目：${workspace?.path ?? text}`} />
  return (
    <Menu
      label="选择项目"
      selection
      placement="top-start"
      sections={workspaceSections(catalog, value, onChange)}
      footer={manageFooter('管理项目…', onManage)}
      trigger={props => (
        <ChipButton icon={Folder} text={text} label={`项目：${workspace?.path ?? text}`} trigger={props} disabled={disabled} />
      )}
    />
  )
}

export function ModeSwitch({
  value,
  modes,
  onChange,
  disabled,
}: {
  value: TaskMode
  modes: TaskMode[]
  onChange: (mode: TaskMode) => void
  disabled?: boolean
}) {
  return (
    <Segmented
      label="会话模式"
      value={value}
      disabled={disabled}
      onChange={onChange}
      className="mode-switch"
      options={[
        {
          value: 'chat',
          label: '对话',
          disabled: !modes.includes('chat'),
          title: modes.includes('chat') ? '只对话，不调用工具' : '此 Harness 不支持对话模式',
        },
        {
          value: 'agent',
          label: 'Agent',
          disabled: !modes.includes('agent'),
          title: modes.includes('agent') ? '可调用工具，需要时请你批准' : '此 Harness 不支持 Agent 模式',
        },
      ]}
    />
  )
}

const optionName = (option: SessionConfigOption) =>
  option.options.find(item => item.value === option.currentValue)?.name ?? option.currentValue

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

/** Options an agent exposes for this session, such as its model or permission mode. */
export function ConfigChips({
  config,
  busy,
  onChange,
}: {
  config: SessionConfigOption[]
  busy: string | null
  onChange: (configId: string, value: string) => void
}) {
  return (
    <>
      {config.map(option => (
        <Menu
          key={option.id}
          label={option.name}
          selection
          placement="top-start"
          sections={configSections(option, value => {
            if (value !== option.currentValue) onChange(option.id, value)
          })}
          trigger={props => (
            <ChipButton
              icon={option.category === 'model' ? Sparkles : SlidersHorizontal}
              text={optionName(option)}
              label={`${option.name}：${optionName(option)}`}
              trigger={props}
              disabled={busy !== null}
            />
          )}
        />
      ))}
    </>
  )
}

export function RadioList({ label, sections }: { label: string; sections: MenuSection[] }) {
  return (
    <div className="radio-list" role="radiogroup" aria-label={label}>
      {sections
        .filter(section => section.items.length)
        .map(section => (
          <div key={section.id} className="radio-section">
            {section.label && <div className="menu-section-label">{section.label}</div>}
            {section.items.map(item => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={item.checked === true}
                disabled={item.disabled}
                className="menu-item"
                onClick={item.onSelect}>
                <span className="menu-item-text">
                  <span className="menu-item-label">
                    {item.label}
                    {item.tag}
                  </span>
                  {(item.disabled ? item.disabledReason : item.description) && (
                    <span className="menu-item-description">{item.disabled ? item.disabledReason : item.description}</span>
                  )}
                </span>
                {item.checked && <Check className="menu-item-check" size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />}
              </button>
            ))}
          </div>
        ))}
    </div>
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
              className="menu-footer-link"
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
        <SlidersHorizontal size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
        <span className="chip-text">{summary}</span>
        <ChevronDown className="chip-chevron" size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
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
          <div className="sheet-body">
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
