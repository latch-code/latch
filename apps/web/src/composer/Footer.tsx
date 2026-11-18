import type { SessionConfigOption } from '@latch/protocol'
import { IconButton, Popover, ValuePicker, MoreGlyph } from '@latch/ui'
import { defineCopy } from '../core/i18n.ts'
import { escapeHiddenCharacters } from '../components/VisibleText.tsx'
import { agentConfigValues } from './modelReasoning.ts'

const COPY = defineCopy({ more: '更多选项' }, { more: 'More options' })

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
        label={COPY.more}
        size="sm"
        side="top"
        align="end"
        trigger={props => <IconButton {...props} size="sm" icon={MoreGlyph} label={COPY.more} />}>
        <div className="composer-more-body">
          <OptionRows options={options} disabled={disabled} onChoose={onOption} />
        </div>
      </Popover>
    </span>
  )
}
