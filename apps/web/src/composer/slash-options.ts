import type { PromptTemplate, SessionCommand } from '@latch/protocol'
import { matchSlash, slashToken } from './slash-match.ts'
import { isLatchAction } from './latchActions.ts'

const RANDOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

export function slashMatches(draft: string, commands: readonly SessionCommand[]): SessionCommand[] {
  const token = slashToken(draft)
  if (!token?.initial) return []
  return commands
    .map((command, order) => ({ command, order, match: matchSlash(command.name, token.query, command.description) }))
    .filter(item => item.match !== undefined)
    .sort((a, b) => a.match!.score - b.match!.score || a.order - b.order)
    .map(item => item.command)
}

/** Latch actions use existing UI handlers; they are never sent to a Harness. */
export interface SlashAction {
  name: string
  description: string
  run?(argument?: string): void
  text?: string
  unavailable?: string
  inputHint?: string
}

export interface SlashOption {
  recent?: true
  id: string
  kind: 'action' | 'template' | 'command'
  label: string
  description: string
  text: string
  score: number
  inputHint?: string
  run?: (argument?: string) => void
  unavailable?: true
}

export interface SlashContext {
  running?: boolean
  firstTurn?: boolean
  session?: boolean
}
const ORDER = { command: 0, template: 1, action: 2 }

export function slashOptions(
  draft: string,
  commands: readonly SessionCommand[],
  templates: readonly PromptTemplate[],
  actions: readonly SlashAction[] = [],
  context: SlashContext = {},
): SlashOption[] {
  const token = slashToken(draft)
  if (!token) return []
  const query = token.query
  const score = (name: string, description: string) => matchSlash(name, query, description)?.score ?? Infinity
  const options: SlashOption[] = [
    ...(token.initial
      ? commands
          .filter(command => !isLatchAction(command.name.toLowerCase()) && !actions.some(action => action.name === command.name))
          .map(command => {
            const unavailable = context.firstTurn
              ? '第一条消息之后可用'
              : context.running && command.idleOnly
                ? '这一轮结束后可用'
                : undefined
            return {
              id: 'command:' + command.name,
              kind: 'command' as const,
              label: '/' + command.name,
              description: unavailable ?? command.description ?? '',
              text: '/' + command.name + ' ',
              score: score(command.name, command.description ?? ''),
              ...(command.inputHint ? { inputHint: command.inputHint } : {}),
              ...(unavailable ? { unavailable: true as const } : {}),
            }
          })
      : []),
    ...templates.map(template => {
      const slug = !RANDOM_ID.test(template.id)
      const description = template.content.split('\n').find(line => line.trim()) ?? ''
      return {
        id: 'template:' + template.id,
        kind: 'template' as const,
        label: slug ? '/' + template.id + ' · ' + template.name : '/' + template.name,
        description,
        text: template.content,
        score: slug ? Math.min(score(template.id, description), score(template.name, description)) : score(template.name, description),
      }
    }),
    ...(token.initial
      ? actions.map(action => ({
          id: 'action:' + action.name,
          kind: 'action' as const,
          label: '/' + action.name,
          description: action.unavailable ?? action.description,
          text: action.text ?? '/' + action.name + ' ',
          score: Math.min(score(action.name, action.description), matchSlash(action.description, query)?.score === 3 ? 6 : Infinity),
          ...(action.inputHint ? { inputHint: action.inputHint } : {}),
          ...(action.run && !action.unavailable ? { run: action.run } : {}),
          ...(action.unavailable ? { unavailable: true as const } : {}),
        }))
      : []),
  ]
  if (token.initial && context.session && !commands.some(command => command.name === 'compact'))
    options.push({
      id: 'command:compact',
      kind: 'command',
      label: '/compact',
      description: '这个 Harness 尚不支持',
      text: '/compact ',
      score: score('compact', '压缩上下文'),
      unavailable: true,
    })
  return options
    .filter(option => Number.isFinite(option.score))
    .sort((a, b) =>
      query
        ? Number(!!a.unavailable) - Number(!!b.unavailable) || a.score - b.score || ORDER[a.kind] - ORDER[b.kind]
        : ORDER[a.kind] - ORDER[b.kind] || Number(!!a.unavailable) - Number(!!b.unavailable),
    )
}
