import { escapeSecurityText } from '@latch/protocol'
import { Button, Checkbox, CloseGlyph, Icon, Popover } from '@latch/ui'
import { NO_FILTERS, type BoardFilters, type FilterKey, type FilterOption } from './model.ts'

const FILTER_LABELS: Record<FilterKey, string> = { projects: '项目', harnesses: 'Harness', who: '谁在做', tags: '标签', origin: '来源' }
const FILTER_KEYS: readonly FilterKey[] = ['projects', 'harnesses', 'who', 'tags', 'origin']

function toggle(filters: BoardFilters, key: FilterKey, value: string): BoardFilters {
  const values = filters[key]
  return { ...filters, [key]: values.includes(value) ? values.filter(item => item !== value) : [...values, value] }
}

/** One dimension's choices: several at once, each applied as it is ticked. */
function FilterChoices({
  name,
  options,
  chosen,
  onToggle,
}: {
  name: FilterKey
  options: readonly FilterOption[]
  chosen: readonly string[]
  onToggle: (value: string) => void
}) {
  return (
    <div className="work-board-filter-choices" role="group" aria-label={FILTER_LABELS[name]}>
      {options.map(option => (
        <Checkbox
          key={option.value}
          label={escapeSecurityText(option.label)}
          checked={chosen.includes(option.value)}
          onChange={() => {
            onToggle(option.value)
          }}
        />
      ))}
    </div>
  )
}

/** A dimension's button: its name, and how many of its values are chosen. */
function FilterMenu({
  name,
  options,
  filters,
  onFilters,
}: {
  name: FilterKey
  options: readonly FilterOption[]
  filters: BoardFilters
  onFilters: (filters: BoardFilters) => void
}) {
  const chosen = filters[name]
  return (
    <Popover
      label={FILTER_LABELS[name]}
      size="xs"
      trigger={props => (
        <Button
          {...props}
          variant="ghost"
          size="sm"
          menu
          className="work-board-filter"
          data-active={chosen.length ? '' : undefined}
          disabled={!options.length && !chosen.length}>
          {FILTER_LABELS[name]}
          {chosen.length > 0 && <span className="work-board-filter-count">{chosen.length}</span>}
        </Button>
      )}>
      <FilterChoices
        name={name}
        options={options}
        chosen={chosen}
        onToggle={value => {
          onFilters(toggle(filters, name, value))
        }}
      />
    </Popover>
  )
}

/** The four filter buttons. */
export function FilterMenus({
  options,
  filters,
  onFilters,
}: {
  options: Record<FilterKey, FilterOption[]>
  filters: BoardFilters
  onFilters: (filters: BoardFilters) => void
}) {
  return (
    <>
      {FILTER_KEYS.map(key => (
        <FilterMenu key={key} name={key} options={options[key]} filters={filters} onFilters={onFilters} />
      ))}
    </>
  )
}

/** What is chosen, as pieces that each take themselves off. A value no card holds any more is still shown, to undo. */
export function FilterChips({
  options,
  filters,
  onFilters,
}: {
  options: Record<FilterKey, FilterOption[]>
  filters: BoardFilters
  onFilters: (filters: BoardFilters) => void
}) {
  const chosen = FILTER_KEYS.flatMap(key =>
    filters[key].map(value => ({ key, value, label: options[key].find(option => option.value === value)?.label ?? value })),
  )
  if (!chosen.length) return null
  return (
    <div className="work-board-chips" role="group" aria-label="已选筛选">
      {chosen.map(item => (
        <span key={`${item.key}:${item.value}`} className="work-board-chip">
          <span>{escapeSecurityText(item.label)}</span>
          <button
            type="button"
            className="work-board-chip-remove"
            aria-label={`去掉筛选 ${FILTER_LABELS[item.key]}：${escapeSecurityText(item.label)}`}
            onClick={() => {
              onFilters(toggle(filters, item.key, item.value))
            }}>
            <Icon icon={CloseGlyph} size={12} />
          </button>
        </span>
      ))}
      {chosen.length > 1 && (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => {
            onFilters(NO_FILTERS)
          }}>
          清除
        </Button>
      )}
    </div>
  )
}

/** Every dimension in one layer: the phone's 筛选 (a bottom sheet there). */
export function AllFilters({
  options,
  filters,
  onFilters,
}: {
  options: Record<FilterKey, FilterOption[]>
  filters: BoardFilters
  onFilters: (filters: BoardFilters) => void
}) {
  const chosen = FILTER_KEYS.reduce((sum, key) => sum + filters[key].length, 0)
  return (
    <Popover
      label="筛选"
      size="sm"
      trigger={props => (
        <Button {...props} variant="ghost" size="sm" menu className="work-board-filter" data-active={chosen ? '' : undefined}>
          筛选
          {chosen > 0 && <span className="work-board-filter-count">{chosen}</span>}
        </Button>
      )}>
      <div className="work-board-filter-sheet">
        {FILTER_KEYS.filter(key => options[key].length > 0 || filters[key].length > 0).map(key => (
          <section key={key}>
            <h4>{FILTER_LABELS[key]}</h4>
            <FilterChoices
              name={key}
              options={options[key]}
              chosen={filters[key]}
              onToggle={value => {
                onFilters(toggle(filters, key, value))
              }}
            />
          </section>
        ))}
      </div>
    </Popover>
  )
}
