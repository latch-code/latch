import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    clear: '清空上下文',
    sideQuestion: '旁支提问',
    question: '问题',
    fork: '从最新一轮分叉',
    firstMessage: '第一句（可选）',
    newSession: '新会话',
    model: '选择模型',
    filter: '筛选（可选）',
    thinking: '选择思考深度',
    permissions: '选择权限',
    changes: '打开改动',
  },
  {
    clear: 'Clear context',
    sideQuestion: 'Side question',
    question: 'Question',
    fork: 'Fork from the latest turn',
    firstMessage: 'First message (optional)',
    newSession: 'New session',
    model: 'Choose model',
    filter: 'Filter (optional)',
    thinking: 'Choose thinking level',
    permissions: 'Choose permissions',
    changes: 'Open changes',
  },
)

/** Shared action names and words for slash completion, typed interception and the command palette. */
export const LATCH_ACTIONS = [
  {
    name: 'clear',
    get label() {
      return COPY.clear
    },
  },
  {
    name: 'btw',
    get label() {
      return COPY.sideQuestion
    },
    get inputHint() {
      return COPY.question
    },
  },
  {
    name: 'fork',
    get label() {
      return COPY.fork
    },
    get inputHint() {
      return COPY.firstMessage
    },
  },
  {
    name: 'new',
    get label() {
      return COPY.newSession
    },
    get inputHint() {
      return COPY.firstMessage
    },
  },
  {
    name: 'model',
    get label() {
      return COPY.model
    },
    get inputHint() {
      return COPY.filter
    },
  },
  {
    name: 'think',
    get label() {
      return COPY.thinking
    },
  },
  {
    name: 'permissions',
    get label() {
      return COPY.permissions
    },
  },
  {
    name: 'changes',
    get label() {
      return COPY.changes
    },
  },
] as const

export type LatchActionName = (typeof LATCH_ACTIONS)[number]['name']
const NAMES = new Set<string>(LATCH_ACTIONS.map(action => action.name))
export const isLatchAction = (name: string): name is LatchActionName => NAMES.has(name)

/** Only the initial whole token is reserved. A path, a substring and inline prose remain ordinary text. */
export function latchActionOf(draft: string): { name: LatchActionName; argument: string } | undefined {
  const match = /^[/／]([^\s/／]+)(?:\s+([\s\S]*))?$/u.exec(draft.trimStart())
  const name = match?.[1]?.toLowerCase()
  if (!match || !name || !isLatchAction(name)) return undefined
  return { name, argument: (match[2] ?? '').trim() }
}
