import { Ellipsis, GitBranch } from 'lucide-react'
import type { SessionConfigOption } from '@latch/protocol'
import { ICON_STROKE, IconButton, Popover, Tooltip, ValuePicker } from '@latch/ui'
import { escapeHiddenCharacters, VisibleText } from '../components/VisibleText.tsx'
import { agentConfigValues } from './modelReasoning.ts'

/** The branch as the Host read it, under the input; with nothing verified there is nothing to show. */
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
  options = [],
  disabled = false,
  onOption,
}: {
  options?: readonly SessionConfigOption[]
  disabled?: boolean
  onOption: (option: SessionConfigOption, value: string) => void
}) {
  if (options.length === 0) return null
  return (
    <span className="composer-more">
      <Popover
        label="更多选项"
        width={272}
        side="top"
        align="end"
        trigger={props => <IconButton {...props} size="sm" icon={Ellipsis} label="更多选项" />}>
        <div className="composer-more-body">
          <OptionRows options={options} disabled={disabled} onChoose={onOption} />
        </div>
      </Popover>
    </span>
  )
}
