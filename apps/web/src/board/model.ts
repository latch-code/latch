import {
  GENERAL_AGENT_ID,
  type AppSnapshot,
  type BoardGroup,
  type BoardPriority,
  type BoardReason,
  type TaskSummary,
  type WorkspaceInfo,
} from '@latch/protocol'
import { projectOf } from '../sessions.ts'

/**
 * The board: every session the Host marks as a card (`board.card`), in the group the Host gave it (`board.group`). The
 * page never decides a group, never counts from anything but those summaries, and never adds a session the snapshot
 * does not list (a private one stays out of every count on a device that may not read it).
 */

/** The columns, left to right then top to bottom. Phase 2 puts 未开始 first. */
export const BOARD_GROUPS: readonly BoardGroup[] = ['attention', 'running', 'deliver', 'done']
export const GROUP_LABELS: Record<BoardGroup, string> = {
  attention: '等你处理',
  running: '进行中',
  deliver: '可交付',
  done: '已结束',
}
/** 已结束 on the board holds the last seven days; the list holds all of it. */
const DONE_DAYS = 7
const DAY = 86_400_000

export const PRIORITY_LABELS: Record<BoardPriority | 'mid', string> = { high: '高', mid: '中', low: '低' }
const PRIORITY_RANK: Record<BoardPriority | 'mid', number> = { high: 0, mid: 1, low: 2 }
const REASON_RANK: Record<BoardReason, number> = { approval: 0, question: 1, unknown: 2, failed: 3, unrecognized: 4, silent: 5 }

export const NO_PROJECT = '~none'
export const WHO_CODE = '~code'

export interface BoardFilters {
  projects: string[]
  harnesses: string[]
  /** WHO_CODE, `general` (通用) or a custom Agent's id. */
  who: string[]
  tags: string[]
}
export const NO_FILTERS: BoardFilters = { projects: [], harnesses: [], who: [], tags: [] }
export type FilterKey = keyof BoardFilters

export type BoardView = 'board' | 'list'
/** The list's and the phone's state filter; `archived` only in the list. */
export type ListState = 'all' | BoardGroup | 'archived'

export interface BoardMemory {
  view: BoardView
  filters: BoardFilters
}

const isCard = (task: TaskSummary): boolean => task.board?.card === true

export const priorityOf = (task: Pick<TaskSummary, 'priority'>): BoardPriority | 'mid' => task.priority ?? 'mid'

/** Who works on it: Code, 通用, or one of the person's Agents. */
export const whoOf = (task: Pick<TaskSummary, 'agent' | 'generalChat'>): string =>
  task.agent?.customAgentId ?? (task.generalChat ? GENERAL_AGENT_ID : WHO_CODE)

const projectKey = (task: TaskSummary, workspaces: readonly WorkspaceInfo[]): string => projectOf(task, workspaces)?.id ?? NO_PROJECT

function matchesFilters(task: TaskSummary, filters: BoardFilters, workspaces: readonly WorkspaceInfo[]): boolean {
  // Or within a dimension, and between them.
  if (filters.projects.length && !filters.projects.includes(projectKey(task, workspaces))) return false
  if (filters.harnesses.length && !filters.harnesses.includes(task.harnessId ?? '')) return false
  if (filters.who.length && !filters.who.includes(whoOf(task))) return false
  if (filters.tags.length && !(task.tags ?? []).some(tag => filters.tags.includes(tag))) return false
  return true
}

export const filtering = (filters: BoardFilters): boolean => Object.values(filters).some(values => values.length > 0)

const updated = (task: TaskSummary) => Date.parse(task.updatedAt) || 0

/** Priority first (高, 中, 低), then within 等你处理 the Host's reason in rule order, then the newest change first. */
function compareCards(a: TaskSummary, b: TaskSummary): number {
  return (
    PRIORITY_RANK[priorityOf(a)] - PRIORITY_RANK[priorityOf(b)]
    || (a.board?.group === 'attention' && b.board?.group === 'attention'
      ? REASON_RANK[a.board.reason ?? 'silent'] - REASON_RANK[b.board.reason ?? 'silent']
      : 0)
    || updated(b) - updated(a)
    || a.id.localeCompare(b.id)
  )
}

/** On the board 已结束 keeps the last seven days by the Host's clock. */
const onBoard = (task: TaskSummary, now: number): boolean => task.board?.group !== 'done' || now - updated(task) <= DONE_DAYS * DAY

export interface BoardColumn {
  group: BoardGroup
  /** The cards the filters let through, sorted. */
  cards: TaskSummary[]
  /** How many cards the column holds without any filter. */
  total: number
}

export function boardColumns(
  tasks: readonly TaskSummary[],
  filters: BoardFilters,
  workspaces: readonly WorkspaceInfo[],
  now: number,
): BoardColumn[] {
  const cards = tasks.filter(task => isCard(task) && onBoard(task, now))
  return BOARD_GROUPS.map(group => {
    const own = cards.filter(task => task.board!.group === group)
    return {
      group,
      cards: own.filter(task => matchesFilters(task, filters, workspaces)).toSorted(compareCards),
      total: own.length,
    }
  })
}

/** How many cards each group holds, unfiltered: what the column heads and the phone's state filter say. */
export function groupCounts(tasks: readonly TaskSummary[], now: number): Record<BoardGroup, number> {
  const counts: Record<BoardGroup, number> = { attention: 0, running: 0, deliver: 0, done: 0 }
  for (const task of tasks) if (isCard(task) && onBoard(task, now)) counts[task.board!.group]++
  return counts
}

/**
 * An archived session that would be a card: one of Code's, or a scheduled run of 我的 Agent. The Host gives an archived
 * session no card, so the list's 已归档 reads this instead.
 */
const archivedCard = (task: TaskSummary): boolean =>
  task.archived === true && !task.personal && (whoOf(task) === WHO_CODE || task.automationId !== undefined)

const groupRank = (task: TaskSummary) => (task.board ? BOARD_GROUPS.indexOf(task.board.group) : BOARD_GROUPS.length)

/** The list: every card (已结束 in full), or the archived ones; by group, priority and time, or by time alone. */
export function listRows(
  tasks: readonly TaskSummary[],
  state: ListState,
  filters: BoardFilters,
  workspaces: readonly WorkspaceInfo[],
  order: 'group' | 'time',
): TaskSummary[] {
  return tasks
    .filter(task => (state === 'archived' ? archivedCard(task) : isCard(task) && (state === 'all' || task.board!.group === state)))
    .filter(task => matchesFilters(task, filters, workspaces))
    .toSorted((a, b) =>
      order === 'time' ? updated(b) - updated(a) || a.id.localeCompare(b.id) : groupRank(a) - groupRank(b) || compareCards(a, b),
    )
}

/** The phone's first state: 等你处理, or 进行中 when nothing waits. */
export const firstPhoneState = (counts: Record<BoardGroup, number>): BoardGroup => (counts.attention > 0 ? 'attention' : 'running')

export interface FilterOption {
  value: string
  label: string
}

const unique = <T>(values: T[]): T[] => [...new Set(values)]

/** What each filter can choose from: only what the cards (and the archived list) hold. */
export function filterOptions(
  tasks: readonly TaskSummary[],
  snapshot: Pick<AppSnapshot, 'catalog' | 'customAgents'>,
): Record<FilterKey, FilterOption[]> {
  const cards = tasks.filter(task => isCard(task) || archivedCard(task))
  const workspaces = snapshot.catalog?.workspaces ?? []
  const harnesses = snapshot.catalog?.harnesses ?? []
  const projects = unique(cards.map(task => projectKey(task, workspaces))).map(id => ({
    value: id,
    label: id === NO_PROJECT ? '无项目' : (workspaces.find(item => item.id === id)?.name ?? id),
  }))
  const harnessIds = unique(cards.map(task => task.harnessId).filter((id): id is string => !!id))
  const who = unique(cards.map(whoOf)).flatMap(id => {
    if (id === WHO_CODE) return [{ value: id, label: 'Code' }]
    if (id === GENERAL_AGENT_ID) return [{ value: id, label: '通用' }]
    // An Agent this device is not told about has no name to show; its sessions stay under no 谁在做 choice.
    const agent = snapshot.customAgents?.find(item => item.id === id)
    return agent ? [{ value: id, label: agent.name }] : []
  })
  return {
    projects: projects.toSorted(
      (a, b) => Number(a.value === NO_PROJECT) - Number(b.value === NO_PROJECT) || a.label.localeCompare(b.label),
    ),
    harnesses: harnessIds.map(id => {
      const harness = harnesses.find(item => item.id === id)
      return { value: id, label: harness?.capabilities.display.label ?? id }
    }),
    who: who.toSorted((a, b) => Number(b.value === WHO_CODE) - Number(a.value === WHO_CODE)),
    tags: unique(cards.flatMap(task => task.tags ?? []))
      .toSorted((a, b) => a.localeCompare(b))
      .map(tag => ({ value: tag, label: tag })),
  }
}

/** What a card in 等你处理 says it waits for, from the Host's reason. */
export function reasonWords(task: TaskSummary): string {
  const unknown = task.runEnd?.unknownResultCount ?? 0
  const words: Record<BoardReason, string> = {
    approval: '审批',
    question: `${Math.max(1, task.pendingQuestions ?? 1)} 个问题`,
    unrecognized: '不支持的请求',
    silent: '没有动静',
    unknown: `${unknown} 条结果未知`,
    failed: unknown > 0 ? `失败 · ${unknown} 条结果未知` : '失败',
  }
  return task.board?.reason ? words[task.board.reason] : GROUP_LABELS.attention
}

// ---- Per-device memory: a convenience only, never the Host's ------------------------------------------------------

export const boardKey = (deviceId: string): string => `latch.board.${location.origin}.${deviceId}`

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 64) : []

export function readBoardMemory(key: string): BoardMemory {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    const stored = record(parsed)
    const filters = record(stored.filters)
    return {
      view: stored.view === 'list' ? 'list' : 'board',
      filters: {
        projects: strings(filters.projects),
        harnesses: strings(filters.harnesses),
        who: strings(filters.who),
        tags: strings(filters.tags),
      },
    }
  } catch {
    return { view: 'board', filters: NO_FILTERS }
  }
}

export function writeBoardMemory(key: string, memory: BoardMemory): void {
  try {
    localStorage.setItem(key, JSON.stringify(memory))
  } catch {
    // Remembering is a convenience: a page that cannot store still filters.
  }
}
