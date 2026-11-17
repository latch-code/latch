import { z } from 'zod'
import type { HarnessProfile, SessionUpdate } from './types.ts'

const text = z.string().max(4000)
const todo = z.object({
  id: z.string().max(256).optional(),
  content: text.optional(),
  title: text.optional(),
  status: z.string().max(32).optional(),
})
const todos = z.array(todo).max(200)
const plan = z.object({
  toolCallId: z.string().min(1).max(256),
  name: text.optional(),
  overview: text.optional(),
  plan: z.string().max(64 * 1024),
  todos: todos.optional(),
})
const todoUpdate = z.object({ todos, merge: z.boolean().optional() })

const STATUS = new Set(['pending', 'in_progress', 'completed'])

type Todo = z.infer<typeof todo>
/** Each session's last full list, so a merge keeps the items it does not name. Bounded: one entry per process key. */
const lists = new Map<string, Todo[]>()

function planUpdate(items: Todo[]): SessionUpdate {
  return {
    sessionUpdate: 'plan',
    // ACP has no cancelled step, and one is no longer part of the plan.
    entries: items
      .filter(item => item.status !== 'cancelled')
      .map(item => ({ content: item.content ?? item.title ?? '', status: STATUS.has(item.status ?? '') ? item.status : 'pending' }))
      .filter(item => item.content),
  }
}

function merged(sessionKey: string, items: Todo[], merge: boolean): Todo[] {
  const before = merge ? (lists.get(sessionKey) ?? []) : []
  const next = [...before]
  for (const item of items) {
    const at = item.id === undefined ? -1 : next.findIndex(entry => entry.id === item.id)
    if (at >= 0) next[at] = { ...next[at], ...item }
    else next.push(item)
  }
  lists.delete(sessionKey)
  if (lists.size >= 256) lists.delete(lists.keys().next().value!)
  lists.set(sessionKey, next.slice(-200))
  return next
}

export const cursorProfile: HarnessProfile = {
  presetId: 'cursor',
  version: 2,
  processMode: {
    prepare(_directory, mode) {
      const args = mode === 'agent-force' ? ['--force'] : mode === 'ask' || mode === 'plan' ? ['--mode', mode] : []
      return Promise.resolve({ args, env: {} })
    },
    unread: true,
    agentMode: mode => (mode === 'agent-force' ? 'agent' : mode),
    fromMode(option, launchMode) {
      const force = launchMode === 'agent-force' && option.currentValue === 'agent'
      return {
        ...option,
        ...(force ? { source: 'launch' as const } : {}),
        currentValue: force ? 'agent-force' : option.currentValue,
        options: [
          ...option.options.filter(item => item.value !== 'agent-force'),
          {
            value: 'agent-force',
            name: 'Agent --force',
            description: '启动参数；显式拒绝的命令仍拒绝，ACP 不独立报告 force。',
          },
        ],
      }
    },
  },
  ownModelsOnly: true,
  thinkingInModel: true,
  // An empty session runs no turn and calls no model.
  catalogueRead: { when: 'select' },
  permission: {
    approvals: 'prompts',
    defaultEnv: {},
    expectedMode: 'agent',
    // Ask and plan are documented as read-only.
    modeLadder: ['ask', 'plan', 'agent', 'agent-force'],
    modeTiers: {
      ask: { tier: 'plan', name: 'Ask', line: '问答，只读。' },
      plan: { tier: 'plan', name: 'Plan', line: '制定计划，只读。' },
      agent: { tier: 'ask', name: 'Agent', line: '完整工具能力，按 Cursor 权限规则询问。' },
      'agent-force': { tier: 'never', name: 'Agent --force', line: '启动时 --force；直接允许未被明确拒绝的命令。' },
    },
    // Both read only: Ask answers questions, Plan writes a plan.
    modeGlyphs: { ask: 'question', plan: 'plan' },
    // Cursor's documented option IDs; the one that stores a rule is hidden whatever kind it reports.
    hiddenOptionIds: ['allow-always'],
    readback: 'mode',
    notes: ['Cursor 的 --sandbox 与权限规则在 ACP 模式下的边界没有官方说明，Latch 不把它当作隔离'],
  },
  // Project rules, CLI permissions and MCP servers.
  projectConfigPaths: ['.cursor', '.cursorrules'],
  extensions: {
    requests: {
      // A plan Cursor wants approved before it builds: the person accepts or not, like any other ask in the session.
      // `cursor/ask_question` is read for every harness that sends it (questions.ts).
      'cursor/create_plan': {
        ask(params) {
          const parsed = plan.safeParse(params)
          if (!parsed.success) return undefined
          const { toolCallId, name, overview, plan: body } = parsed.data
          return {
            toolCall: {
              toolCallId,
              title: name ? `计划：${name}` : '计划',
              name: 'create_plan',
              kind: 'other',
              rawInput: overview ? `${overview}\n\n${body}` : body,
            },
            options: [
              { optionId: 'accept', name: '接受计划', kind: 'allow_once' },
              { optionId: 'reject', name: '不接受', kind: 'reject_once' },
            ],
          }
        },
        answer: optionId =>
          optionId === 'accept'
            ? { outcome: { outcome: 'accepted' } }
            : optionId === 'reject'
              ? { outcome: { outcome: 'rejected' } }
              : { outcome: { outcome: 'cancelled' } },
      },
    },
    notifications: {
      'cursor/update_todos'(params, sessionKey) {
        const parsed = todoUpdate.safeParse(params)
        if (!parsed.success) return undefined
        return planUpdate(merged(sessionKey, parsed.data.todos, parsed.data.merge === true))
      },
    },
  },
}
