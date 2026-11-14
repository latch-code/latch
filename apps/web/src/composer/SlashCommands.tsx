import { useEffect, useId, useMemo, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import type { PromptTemplate, SessionCommand } from '@latch/protocol'
import { escapeSecurityText } from '@latch/protocol'
import { Button, CodeGlyph, FileGlyph, Icon, Kbd, Suggest } from '@latch/ui'
import { BookOpen } from 'lucide-react'
import { BrandMark } from '../components/ui.tsx'
import { matchSlash, slashToken } from './slash-match.ts'
import { slashOptions, type SlashAction, type SlashContext, type SlashOption } from './slash-options.ts'
import { SlashHistory } from '../core/slashHistory.ts'
import { latchActionOf } from './latchActions.ts'
export { slashMatches, slashOptions, type SlashAction, type SlashOption } from './slash-options.ts'

export function useSlashCommands({
  draft,
  caret = draft.length,
  commands = [],
  skills = [],
  skillsTruncated = false,
  templates = [],
  actions = [],
  enabled,
  onDraft,
  onCommand,
  harnessName = '当前 Harness',
  harnessMedia,
  running = false,
  firstTurn = false,
  session = false,
  previousSession = false,
  awaitingSession = false,
  historyScope,
}: {
  draft: string
  caret?: number
  commands?: readonly SessionCommand[]
  skillsTruncated?: boolean
  templates?: readonly PromptTemplate[]
  actions?: readonly SlashAction[]
  enabled: boolean
  onDraft(text: string, selection?: { start: number; end: number }): void
  onCommand?(text: string): void
  harnessName?: string
  harnessMedia?: ReactNode
  previousSession?: boolean
  awaitingSession?: boolean
  historyScope?: { deviceId: string; harnessId?: string }
} & SlashContext) {
  const id = useId()
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [selection, setSelection] = useState({ word: '', optionId: '' })
  const token = slashToken(draft, caret)
  const word = token ? draft.slice(0, token.end) : ''
  useEffect(() => {
    setDismissed(previous => (previous === word ? previous : null))
  }, [word])
  const history = useMemo(
    () => (historyScope ? new SlashHistory(location.origin, historyScope.deviceId) : undefined),
    [historyScope?.deviceId],
  )
  const available = slashOptions(word, commands, templates, actions, { running, firstTurn, session, skills })
  const recent =
    token && !token.query
      ? (history
          ?.ids(historyScope?.harnessId)
          .flatMap(id => {
            const option = available.find(item => item.id === id && !item.unavailable)
            return option ? [{ ...option, id: 'recent:' + option.id, recent: true as const }] : []
          })
          .slice(0, 5) ?? [])
      : []
  const options = [...recent, ...available]
  const remember = (option: SlashOption) => {
    history?.record(option.id.replace(/^recent:/u, ''), historyScope?.harnessId)
  }
  const open = enabled && token !== undefined && dismissed !== word
  const first = token?.query ? options.findIndex(option => !option.unavailable) : -1
  const active = selection.word === word ? options.findIndex(option => option.id === selection.optionId && !option.unavailable) : first
  const dismiss = () => setDismissed(word)
  const select = (option: SlashOption, intent: 'complete' | 'activate' = 'activate') => {
    if (option.unavailable || !token) return
    remember(option)
    if (intent === 'activate' && option.kind === 'action' && option.run) {
      option.run(draft.slice(token.end).trim())
    } else {
      const text = draft.slice(0, token.start) + option.text + draft.slice(token.end)
      const argument = option.kind === 'template' ? option.text.indexOf('$ARGUMENTS') : -1
      const start = token.start + (argument >= 0 ? argument : option.text.length)
      onDraft(text, { start, end: start + (argument >= 0 ? '$ARGUMENTS'.length : 0) })
    }
    dismiss()
  }
  const keydown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || event.nativeEvent.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey) return false
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      dismiss()
      return true
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const usable = options.map((option, index) => (option.unavailable ? -1 : index)).filter(index => index >= 0)
      if (!usable.length) return false
      const step = event.key === 'ArrowDown' ? 1 : -1
      const at = usable.indexOf(active)
      const next = at < 0 ? (step > 0 ? 0 : usable.length - 1) : (at + step + usable.length) % usable.length
      event.preventDefault()
      event.stopPropagation()
      setSelection({ word, optionId: options[usable[next]!]!.id })
      return true
    }
    const option = options[active]
    if ((event.key !== 'Enter' && event.key !== 'Tab') || event.shiftKey || !option) return false
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Enter' && option.kind === 'command' && !option.inputHint && !running && !previousSession && onCommand) {
      remember(option)
      dismiss()
      onCommand(option.text.trimEnd())
    } else select(option, event.key === 'Tab' ? 'complete' : 'activate')
    return true
  }
  return {
    id,
    draft,
    query: token?.query ?? '',
    open,
    options,
    active,
    select,
    keydown,
    dismiss,
    reopen: () => setDismissed(null),
    harnessName,
    harnessMedia,
    previousSession,
    awaitingSession,
    skillsTruncated,
    enterLabel: options[active]?.kind === 'command' && !options[active]?.inputHint && !running && !previousSession ? '运行' : '选择',
    reportedCommands: commands.length,
    setActive: (index: number) => {
      const option = options[index]
      if (option && !option.unavailable) setSelection({ word, optionId: option.id })
    },
  }
}

function highlighted(text: string, query: string): ReactNode {
  const safe = escapeSecurityText(text)
  const match = matchSlash(safe.replace(/^[/\$]/u, ''), query)
  const offset = /^[/\$]/u.test(safe) ? 1 : 0
  const positions = new Set(match?.positions.map(position => position + offset))
  let index = 0
  return Array.from(safe).map(character => {
    const start = index
    index += character.length
    return positions.has(start) ? <strong key={start}>{character}</strong> : character
  })
}

export function SlashCommands({
  menu,
  anchorRef,
  onCreateTemplate,
}: {
  menu: ReturnType<typeof useSlashCommands>
  anchorRef: RefObject<HTMLElement | null>
  onCreateTemplate?: () => void
}) {
  const labels = {
    recent: '最近',
    action: 'Latch',
    template: '提示模板',
    skill: '技能' + (menu.previousSession ? '（上次会话）' : ''),
    command: menu.harnessName + (menu.previousSession ? '（上次会话）' : ''),
  }
  const noCommands = menu.awaitingSession
    ? '开始会话后列出'
    : menu.previousSession
      ? '上次会话没有列出命令'
      : `${menu.harnessName} 还没报告命令`
  const media = {
    recent: undefined,
    action: <BrandMark size={16} />,
    template: <Icon icon={FileGlyph} size={16} />,
    skill: <Icon icon={BookOpen} size={16} />,
    command: menu.harnessMedia ?? <Icon icon={CodeGlyph} size={16} />,
  }
  const groups = menu.query
    ? ['search' as const]
    : (['recent', 'command', 'skill', 'template', 'action'] as const).filter(
        kind => kind === 'command' || menu.options.some(option => (option.recent ? 'recent' : option.kind) === kind),
      )
  const empty = menu.query
    ? latchActionOf('/' + menu.query)
      ? '这个动作在当前页面不可用'
      : `没有「/${escapeSecurityText(menu.query)}」· Enter 原样发给 ${menu.harnessName}`
    : noCommands
  return (
    <Suggest
      id={menu.id}
      label="命令与提示模板"
      open={menu.open}
      anchorRef={anchorRef}
      activeId={menu.active >= 0 ? menu.id + '-' + menu.active : undefined}
      onActiveChange={id => menu.setActive(Number(id.slice(menu.id.length + 1)))}
      onChoose={id => {
        const option = menu.options[Number(id.slice(menu.id.length + 1))]
        if (option) menu.select(option)
      }}
      onDismiss={menu.dismiss}
      groups={[
        ...groups.map(kind => ({
          id: kind,
          ...(kind !== 'search' ? { label: labels[kind], media: media[kind] } : {}),
          ...(kind === 'command' && !menu.reportedCommands
            ? {
                empty: (
                  <>
                    <span>{noCommands}</span>
                    {onCreateTemplate && (
                      <Button size="xs" variant="ghost" onClick={onCreateTemplate}>
                        新建提示模板
                      </Button>
                    )}
                  </>
                ),
              }
            : {}),
          items: menu.options.flatMap((option, index) =>
            kind !== 'search' && (option.recent ? 'recent' : option.kind) !== kind
              ? []
              : [
                  {
                    id: menu.id + '-' + index,
                    label: highlighted(option.label, menu.query),
                    description: escapeSecurityText(option.description),
                    ...(option.inputHint ? { hint: escapeSecurityText(option.inputHint) } : {}),
                    ...(kind === 'search'
                      ? {
                          source: option.source ? `${labels[option.kind]} · ${option.source}` : labels[option.kind],
                          media: media[option.kind],
                        }
                      : option.source
                        ? { source: option.source }
                        : {}),
                    disabled: option.unavailable,
                  },
                ],
          ),
        })),
        ...(menu.skillsTruncated
          ? [
              {
                id: 'skill-limit',
                items: [],
                empty: <span role="status">{menu.query && !menu.options.length ? `${empty}。` : ''}仅列出部分技能</span>,
              },
            ]
          : []),
      ]}
      empty={empty}
      footer={
        <>
          <span>
            <Kbd>↑↓</Kbd>
          </span>
          <span>
            <Kbd>Tab</Kbd> 补全
          </span>
          <span>
            <Kbd>⏎</Kbd> {menu.enterLabel}
          </span>
          <Kbd>Esc</Kbd>
        </>
      }
    />
  )
}
