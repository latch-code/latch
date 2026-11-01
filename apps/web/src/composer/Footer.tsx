import { Ellipsis, GitBranch } from 'lucide-react'
import type { SessionConfigOption } from '@latch/protocol'
import { ICON_STROKE, IconButton, Popover, SwitchRow, Tooltip, ValuePicker } from '@latch/ui'
import { escapeHiddenCharacters, VisibleText } from '../components/VisibleText.tsx'
import { agentConfigValues } from './modelReasoning.ts'
import { MODE_ICONS, PermissionList } from './PermissionList.tsx'
import type { PermissionView } from './permission.ts'

/** 通用 is the built-in Agent and today the only one, so the chip names it and has nothing to open. */
export function AgentChip() {
  return (
    <Tooltip content="通用是默认的 Agent，没有额外的指令和技能">
      <span className="chip chip-static chip-agent" tabIndex={0} aria-label="Agent：通用">
        <span className="chip-text">通用</span>
      </span>
    </Tooltip>
  )
}

/** The branch as the Host read it; with nothing verified the footer shows nothing. */
export function BranchLabel({ branch }: { branch: string }) {
  const name = escapeHiddenCharacters(branch)
  return (
    <Tooltip content={`分支 ${name}`}>
      <span className="composer-branch" tabIndex={0}>
        <GitBranch size={12} strokeWidth={ICON_STROKE[12]} aria-hidden="true" />
        <span className="composer-branch-name">
          <VisibleText text={branch} />
        </span>
      </span>
    </Tooltip>
  )
}

const RING_RADIUS = 4.75

export function UsageRing({ use }: { use: { percent: number; words: string } }) {
  const length = 2 * Math.PI * RING_RADIUS
  return (
    <Tooltip content={use.words}>
      <span className="composer-usage" tabIndex={0} aria-label={use.words}>
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <circle className="composer-usage-track" cx="6" cy="6" r={RING_RADIUS} />
          <circle
            className="composer-usage-value"
            cx="6"
            cy="6"
            r={RING_RADIUS}
            strokeDasharray={`${((length * use.percent) / 100).toFixed(2)} ${length.toFixed(2)}`}
          />
        </svg>
        {use.percent}%
      </span>
    </Tooltip>
  )
}

/** What the engine lets a session change besides its model, thinking and mode. */
function OptionRows({
  options,
  disabled,
  onChoose,
}: {
  options: readonly SessionConfigOption[]
  disabled: boolean
  onChoose: (option: SessionConfigOption, value: string) => void
}) {
  return (
    <>
      {options.map(option => (
        <ValuePicker
          key={option.id}
          variant="row"
          label={escapeHiddenCharacters(option.name)}
          value={option.currentValue}
          options={agentConfigValues(option).map(item => ({ value: item.value, label: escapeHiddenCharacters(item.name) }))}
          disabled={disabled}
          onValueChange={value => {
            onChoose(option, value)
          }}
        />
      ))}
    </>
  )
}

/** 「⋯」: only when there is something in it. */
export function MoreMenu({
  chatOnly,
  options = [],
  disabled = false,
  onOption,
}: {
  chatOnly?: { value: boolean; onChange: (value: boolean) => void } | undefined
  options?: readonly SessionConfigOption[]
  disabled?: boolean
  onOption: (option: SessionConfigOption, value: string) => void
}) {
  if (!chatOnly && options.length === 0) return null
  return (
    <span className="composer-more">
      <Popover
        label="更多选项"
        width={272}
        side="top"
        align="end"
        trigger={props => <IconButton {...props} size="sm" icon={Ellipsis} label="更多选项" />}>
        <div className="composer-more-body">
          {chatOnly && (
            <SwitchRow title="只聊天，不读写文件" checked={chatOnly.value} disabled={disabled} onCheckedChange={chatOnly.onChange} />
          )}
          <OptionRows options={options} disabled={disabled} onChoose={onOption} />
        </div>
      </Popover>
    </span>
  )
}

/** Under 420: 权限, other options, the branch and usage in one 「⋯」. An amber 权限 stays out of it. */
export function FoldMenu({
  permission,
  branch,
  use,
  options = [],
  disabled = false,
  chatOnly,
  onOption,
}: {
  permission: PermissionView | undefined
  branch?: string | undefined
  use?: { percent: number; words: string } | undefined
  options?: readonly SessionConfigOption[]
  disabled?: boolean
  chatOnly?: { value: boolean; onChange: (value: boolean) => void } | undefined
  onOption: (option: SessionConfigOption, value: string) => void
}) {
  const plain = permission && !permission.amber ? permission : undefined
  if (!plain && !branch && !use && options.length === 0 && !chatOnly) return null
  const Glyph = plain ? MODE_ICONS[plain.icon] : undefined
  return (
    <span className="composer-fold-more">
      <Popover
        label="权限、更多选项、分支和用量"
        width={272}
        side="top"
        align="end"
        trigger={props => <IconButton {...props} size="sm" icon={Ellipsis} label="权限、更多选项、分支和用量" />}>
        <div className="composer-more-body">
          {plain?.rows && plain.option ? (
            <PermissionList
              rows={plain.rows}
              onChoose={value => {
                onOption(plain.option!, value)
              }}
            />
          ) : (
            plain
            && Glyph && (
              <p className="composer-more-line">
                <Glyph size={14} aria-hidden="true" />
                权限 · {plain.label}
              </p>
            )
          )}
          {chatOnly && (
            <SwitchRow title="只聊天，不读写文件" checked={chatOnly.value} disabled={disabled} onCheckedChange={chatOnly.onChange} />
          )}
          <OptionRows options={options} disabled={disabled} onChoose={onOption} />
          {branch && (
            <p className="composer-more-line">
              分支 · <VisibleText text={branch} />
            </p>
          )}
          {use && <p className="composer-more-line">{use.words}</p>}
        </div>
      </Popover>
    </span>
  )
}
