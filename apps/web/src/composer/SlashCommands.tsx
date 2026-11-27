import { useEffect, useId, useMemo, useState, type ReactNode, type RefObject } from 'react'
import type { HarnessInfo, PromptTemplate, SessionCommand } from '@latch/protocol'
import { escapeSecurityText } from '@latch/protocol'
import { CodeGlyph, FileGlyph, Icon, Kbd, Suggest } from '@latch/ui'
import { BookOpen } from 'lucide-react'
import { BrandMark } from '../components/ui.tsx'
import { HarnessTile } from '../components/BrandTile.tsx'
import { harnessName } from '../core/harnessName.ts'
import { matchSlash, slashToken } from './slash-match.ts'
import { slashOptions, type SlashAction, type SlashContext, type SlashOption } from './slash-options.ts'
import { SlashHistory } from '../core/slashHistory.ts'
import { latchActionOf } from './latchActions.ts'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    thisHarness: '当前 Harness',
    run: '运行',
    choose: '选择',
    recent: '最近',
    templates: '提示模板',
    skills: '技能',
    previous: '（上次会话）',
    reading: (value1: string) => `正在读取 ${value1} 的命令列表…`,
    afterStart: '发送第一条消息后，可查看 Harness 返回的命令',
    noPrevious: '上次会话没有列出命令',
    noHarnessCommands: '当前 Harness 没有列出命令',
    unreported: '当前连接尚未提供命令列表',
    reportedEmpty: '当前会话没有可用的 Harness 命令',
    groupedElsewhere: '没有可单独列出的 Harness 命令',
    unsupported: '当前接入方式不提供 Harness 命令',
    unavailable: '这个动作在当前页面不可用',
    sendAsTyped: (value1: string, value2: string) => `没有「/${value1}」· Enter 原样发给 ${value2}`,
    commands: '命令与提示模板',
    someSkills: '仅列出部分技能',
    complete: ' 补全',
  },
  {
    thisHarness: 'This Harness',
    run: 'Run',
    choose: 'Choose',
    recent: 'Recent',
    templates: 'Prompt templates',
    skills: 'Skills',
    previous: ' (previous session)',
    reading: (value1: string) => `Reading commands from ${value1}…`,
    afterStart: 'Commands the Harness reports will appear after your first message',
    noPrevious: 'No commands were reported in the previous session',
    noHarnessCommands: 'This Harness listed no commands',
    unreported: 'This connection has not supplied a command list',
    reportedEmpty: 'No Harness commands are available in this session',
    groupedElsewhere: 'No separate Harness commands to list',
    unsupported: 'This connection does not provide Harness commands',
    unavailable: 'This action is unavailable here',
    sendAsTyped: (value1: string, value2: string) => `No “/${value1}” · Enter sends it as typed to ${value2}`,
    commands: 'Commands and prompt templates',
    someSkills: 'Only some skills are listed',
    complete: ' Complete',
  },
)

export { slashMatches, slashOptions, type SlashAction, type SlashOption } from './slash-options.ts'

export type CommandListSource = 'before-session' | 'previous-session' | 'harness' | 'session' | 'unsupported'

export function harnessCommandSource(
  harness: HarnessInfo | undefined,
  session: Exclude<CommandListSource, 'unsupported'>,
  commands?: readonly SessionCommand[],
) {
  if (!harness) return undefined
  const unsupported =
    harness.capabilities.permission.enforcement === 'latch' || harness.extensionSupport?.reports.includes('commands') === false
  const source: CommandListSource = commands === undefined && unsupported ? 'unsupported' : session
  return { source, name: harnessName(harness), media: <HarnessTile harness={harness} size={16} /> }
}

export function emptyCommandList(
  source: CommandListSource,
  commands: readonly SessionCommand[] | undefined,
  options?: { reading?: boolean; harnessName?: string },
): string {
  if (options?.reading && !commands?.length) return COPY.reading(options.harnessName ?? COPY.thisHarness)
  if (commands?.length) return COPY.groupedElsewhere
  if (source === 'previous-session') return COPY.noPrevious
  if (source === 'harness') return COPY.noHarnessCommands
  if (source === 'unsupported') return COPY.unsupported
  if (source === 'before-session') return COPY.afterStart
  return commands ? COPY.reportedEmpty : COPY.unreported
}

/**
 * Whether Enter must leave the command in the input for its argument. A hint the Harness marks optional (`筛选（可选）`,
 * `[filter]`, `filter (optional)`) does not hold Enter back: the command runs, and Tab still puts it in the input.
 */
export function needsInput(hint: string | undefined): boolean {
  if (!hint) return false
  const text = hint.trim()
  return !(/可选|optional/iu.test(text) || /^\[[^\]]*\]$/u.test(text))
}

export function useSlashCommands({
  draft,
  caret,
  commands,
  skills = [],
  skillsTruncated = false,
  templates = [],
  actions = [],
  enabled,
  onDraft,
  onCommand,
  harnessName = COPY.thisHarness,
  harnessMedia,
  running = false,
  reading = false,
  firstTurn = false,
  session = false,
  source = 'session',
  historyScope,
}: {
  draft: string
  caret: number | null
  commands?: readonly SessionCommand[]
  skillsTruncated?: boolean
  templates?: readonly PromptTemplate[]
  actions?: readonly SlashAction[]
  enabled: boolean
  onDraft(text: string, selection?: { start: number; end: number }): void
  onCommand?(text: string): void
  harnessName?: string
  harnessMedia?: ReactNode
  reading?: boolean
  source?: CommandListSource
  historyScope?: { deviceId: string; harnessId?: string }
} & SlashContext) {
  const id = useId()
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [selection, setSelection] = useState({ word: '', optionId: '' })
  const token = caret === null ? undefined : slashToken(draft, caret)
  const word = token ? draft.slice(0, token.end) : ''
  useEffect(() => {
    setDismissed(previous => (previous === word ? previous : null))
  }, [word])
  // A list that opens again starts from its top: the row arrowed to or hovered last time is not carried over once the
  // slash word is gone (the input was cleared, sent, or became the home's after 新会话).
  const listed = token !== undefined
  useEffect(() => {
    if (!listed) setSelection(previous => (previous.word ? { word: '', optionId: '' } : previous))
  }, [listed])
  const history = useMemo(
    () => (historyScope ? new SlashHistory(location.origin, historyScope.deviceId) : undefined),
    [historyScope?.deviceId],
  )
  const previousSession = source === 'previous-session'
  const inSession = source === 'session'
  const available = slashOptions(word, commands ?? [], templates, actions, { running, firstTurn, session, skills })
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
  const keydown = (event: KeyboardEvent) => {
    if (!open || event.isComposing || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey) return false
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
    if (event.key === 'Enter' && option.kind === 'command' && !needsInput(option.inputHint) && !running && inSession && onCommand) {
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
    noCommands: emptyCommandList(source, commands, { reading, harnessName }),
    skillsTruncated,
    enterLabel:
      options[active]?.kind === 'command' && !needsInput(options[active]?.inputHint) && !running && inSession ? COPY.run : COPY.choose,
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
}: {
  menu: ReturnType<typeof useSlashCommands>
  anchorRef: RefObject<HTMLElement | null>
}) {
  const labels = {
    recent: COPY.recent,
    action: 'Latch',
    template: COPY.templates,
    skill: COPY.skills + (menu.previousSession ? COPY.previous : ''),
    command: menu.harnessName + (menu.previousSession ? COPY.previous : ''),
  }
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
      ? COPY.unavailable
      : COPY.sendAsTyped(escapeSecurityText(menu.query), menu.harnessName)
    : menu.noCommands
  return (
    <Suggest
      frosted
      id={menu.id}
      label={COPY.commands}
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
          ...(kind === 'command' ? { empty: menu.noCommands } : {}),
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
                empty: (
                  <span role="status">
                    {menu.query && !menu.options.length ? `${empty}。` : ''}
                    {COPY.someSkills}
                  </span>
                ),
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
            <Kbd>Tab</Kbd>
            {COPY.complete}
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
