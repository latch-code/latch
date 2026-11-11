import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { PromptTemplate, SessionCommand } from '@latch/protocol'
import { escapeSecurityText } from '@latch/protocol'
import { Kbd } from '@latch/ui'

const slashQuery = (draft: string) => (/^\/[^\s]*$/u.test(draft) ? draft.slice(1).toLocaleLowerCase() : null)
const rank = (name: string, query: string) => {
  const value = name.toLocaleLowerCase()
  if (value === query) return 0
  if (value.startsWith(query)) return 1
  if (value.split(/[-_:/. \s]+/u).some(word => word.startsWith(query))) return 2
  return value.includes(query) ? 3 : 4
}
export function slashMatches(draft: string, commands: readonly SessionCommand[]): SessionCommand[] {
  const query = slashQuery(draft)
  return query === null
    ? []
    : commands
        .map((command, order) => ({ command, order, rank: rank(command.name, query) }))
        .filter(item => item.rank < 4)
        .sort((a, b) => a.rank - b.rank || a.order - b.order)
        .slice(0, 20)
        .map(item => item.command)
}

/** Something Latch does in this session, not text for the Harness: choosing it runs it and empties the input. */
export interface SlashAction {
  name: string
  description: string
  run(): void
}

export interface SlashOption {
  id: string
  kind: 'action' | 'template' | 'command'
  label: string
  description: string
  text: string
  score: number
  run?: () => void
}
export function slashOptions(
  draft: string,
  commands: readonly SessionCommand[],
  templates: readonly PromptTemplate[],
  actions: readonly SlashAction[] = [],
): SlashOption[] {
  const query = slashQuery(draft)
  if (query === null) return []
  const options: SlashOption[] = [
    ...actions.map(action => ({
      id: 'action:' + action.name,
      kind: 'action' as const,
      label: '/' + action.name,
      description: action.description,
      text: '',
      score: rank(action.name, query),
      run: action.run,
    })),
    ...templates.map(template => ({
      id: 'template:' + template.id,
      kind: 'template' as const,
      label: '/' + template.id + ' · ' + template.name,
      description: '提示模板 · ' + { all: '全部会话', project: '当前项目', agent: '当前 Harness' }[template.scope.kind],
      text: template.content,
      score: Math.min(rank(template.id, query), rank(template.name, query)),
    })),
    ...commands.map(command => ({
      id: 'command:' + command.name,
      kind: 'command' as const,
      label: '/' + command.name,
      description: command.description ?? command.inputHint ?? 'Harness 命令',
      text: '/' + command.name + ' ',
      score: rank(command.name, query),
    })),
  ]
  const ranked = options
    .filter(item => item.score < 4)
    .sort((a, b) => a.score - b.score)
    .slice(0, 20)
  return [...new Set(ranked.map(item => item.kind))].flatMap(kind => ranked.filter(item => item.kind === kind))
}

export function useSlashCommands({
  draft,
  commands = [],
  templates = [],
  actions = [],
  enabled,
  onDraft,
}: {
  draft: string
  commands?: readonly SessionCommand[]
  templates?: readonly PromptTemplate[]
  actions?: readonly SlashAction[]
  enabled: boolean
  onDraft(text: string): void
}) {
  const id = useId(),
    [dismissed, setDismissed] = useState<string | null>(null),
    [selection, setSelection] = useState({ draft: '', index: 0 })
  const options = slashOptions(draft, commands, templates, actions)
  const open =
    enabled && slashQuery(draft) !== null && dismissed !== draft && (commands.length > 0 || templates.length > 0 || actions.length > 0)
  const active = selection.draft === draft ? Math.min(selection.index, Math.max(0, options.length - 1)) : 0
  const select = (option: SlashOption) => {
    onDraft(option.text)
    option.run?.()
  }
  const keydown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || event.nativeEvent.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey) return false
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setDismissed(draft)
      return true
    }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && options.length) {
      event.preventDefault()
      event.stopPropagation()
      setSelection({ draft, index: (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length })
      return true
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && options[active]) {
      event.preventDefault()
      event.stopPropagation()
      select(options[active])
      return true
    }
    return false
  }
  return { id, draft, open, options, active, select, keydown }
}

const GROUPS: Record<SlashOption['kind'], string> = { action: '这个会话', template: '提示模板', command: 'Harness 命令' }

export function SlashCommands({ menu }: { menu: ReturnType<typeof useSlashCommands> }) {
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [menu.active, menu.draft])
  if (!menu.open) return null
  return (
    <section className="slash-commands" aria-label="命令与提示模板">
      <p>
        <Kbd>↑</Kbd> <Kbd>↓</Kbd> 选择 · <Kbd>Enter</Kbd> 插入
      </p>
      {menu.options.length === 0 && <p role="status">没有匹配的命令或提示模板</p>}
      <div ref={list} id={menu.id} role="listbox" aria-label="命令与提示模板">
        {[...new Set(menu.options.map(option => option.kind))].map(kind => {
          const options = menu.options.filter(option => option.kind === kind)
          return options.length ? (
            <div key={kind} role="group" aria-label={GROUPS[kind]}>
              <p>{GROUPS[kind]}</p>
              {options.map(option => {
                const index = menu.options.indexOf(option)
                return (
                  <button
                    type="button"
                    role="option"
                    id={menu.id + '-' + index}
                    aria-selected={index === menu.active}
                    tabIndex={-1}
                    key={option.id}
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => menu.select(option)}>
                    <strong>{escapeSecurityText(option.label)}</strong>
                    <span>{escapeSecurityText(option.description)}</span>
                  </button>
                )
              })}
            </div>
          ) : null
        })}
      </div>
    </section>
  )
}
