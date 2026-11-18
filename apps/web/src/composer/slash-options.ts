import type { PromptTemplate, SessionCommand, SessionSkill } from '@latch/protocol'
import { matchSlash, slashToken } from './slash-match.ts'
import { isLatchAction } from './latchActions.ts'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    afterFirst: '第一条消息之后可用',
    afterTurn: '这一轮结束后可用',
    unsupported: '这个 Harness 尚不支持',
    compact: '压缩上下文',
  },
  {
    afterFirst: 'Available after the first message',
    afterTurn: 'Available after this turn',
    unsupported: 'This Harness does not support it yet',
    compact: 'Compact context',
  },
)

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
  kind: 'action' | 'template' | 'command' | 'skill'
  label: string
  description: string
  text: string
  score: number
  inputHint?: string
  run?: (argument?: string) => void
  unavailable?: true
  source?: string
}

export interface SlashContext {
  running?: boolean
  firstTurn?: boolean
  session?: boolean
  skills?: readonly SessionSkill[]
}
const ORDER = { command: 0, skill: 1, template: 2, action: 3 }
const SKILL_SCOPE = defineCopy(
  { project: '项目', user: '个人', system: '系统', admin: '管理', temporary: '临时' },
  { project: 'Project', user: 'Personal', system: 'System', admin: 'Administrator', temporary: 'Temporary' },
)

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
  const skills = context.skills ?? []
  const score = (name: string, description: string) => matchSlash(name, query, description)?.score ?? Infinity
  const options: SlashOption[] = [
    ...(token.initial
      ? commands
          .filter(command => !isLatchAction(command.name.toLowerCase()) && !actions.some(action => action.name === command.name))
          .filter(command => !skills.some(skill => skill.invocation === '/' + command.name))
          .map(command => {
            const unavailable = context.firstTurn ? COPY.afterFirst : context.running && command.idleOnly ? COPY.afterTurn : undefined
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
    ...skills
      .filter(skill => token.initial || skill.invocation.startsWith('$'))
      .map(skill => {
        const description = skill.description ?? commands.find(command => '/' + command.name === skill.invocation)?.description ?? ''
        return {
          id: 'skill:' + skill.invocation,
          kind: 'skill' as const,
          label: skill.invocation,
          description,
          text: skill.invocation + ' ',
          score: Math.min(score(skill.name, description), score(skill.invocation.slice(1), description)),
          ...(skill.scope ? { source: SKILL_SCOPE[skill.scope] } : {}),
        }
      }),
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
      description: COPY.unsupported,
      text: '/compact ',
      score: score('compact', COPY.compact),
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
