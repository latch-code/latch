import {
  GENERAL_AGENT_ID,
  type AppSnapshot,
  type BoardPriority,
  type BoardReason,
  type TaskSummary,
  type WorkItemPlace,
  type WorkItemSummary,
  type WorkspaceInfo,
} from '@latch/protocol'
import { projectOf } from '../sessions.ts'

/**
 * The board: every card the Host gives, in the group the Host gave it. A card is one thing: a 待办 with its sessions
 * (`items`, placed by `items[].board`), or a session the Host marks as a card (`board.card`) that belongs to no 待办. A
 * 待办's sessions are read from `items[].sessionIds`, never from a session's `itemId` (absent where the device may not
 * learn of the 待办). The page never decides a group, never counts from anything but those, and never adds a session
 * or 待办 the snapshot does not list (a private one stays out of every count on a device that may not read it).
 */

/** A column of the board: 未开始 (a 待办 without a session yet) and the Host's four session groups. */
export type BoardColumnGroup = WorkItemPlace['group']

/** The columns, left to right then top to bottom. */
export const BOARD_GROUPS: readonly BoardColumnGroup[] = ['todo', 'attention', 'running', 'deliver', 'done']
export const GROUP_LABELS: Record<BoardColumnGroup, string> = {
  todo: '未开始',
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
export type ListState = 'all' | BoardColumnGroup | 'archived'

export interface BoardMemory {
  view: BoardView
  filters: BoardFilters
}

/** One card: a session of no 待办, or a 待办 with the sessions of it this device lists, in the order they joined. */
export type BoardCard =
  | { kind: 'session'; id: string; task: TaskSummary }
  | { kind: 'item'; id: string; item: WorkItemSummary; sessions: TaskSummary[] }

const isCard = (task: TaskSummary): boolean => task.board?.card === true

export const priorityOf = (task: Pick<TaskSummary, 'priority'>): BoardPriority | 'mid' => task.priority ?? 'mid'

/** Who works on it: Code, 通用, or one of the person's Agents. */
export const whoOf = (task: Pick<TaskSummary, 'agent' | 'generalChat'>): string =>
  task.agent?.customAgentId ?? (task.generalChat ? GENERAL_AGENT_ID : WHO_CODE)

const projectKey = (task: TaskSummary, workspaces: readonly WorkspaceInfo[]): string => projectOf(task, workspaces)?.id ?? NO_PROJECT
/** A 待办's suggested project, read as a session's: the Host's default folder is 无项目. */
const itemProjectKey = (item: WorkItemSummary): string => (item.projectId && item.projectId !== 'default' ? item.projectId : NO_PROJECT)

/** The card's column. An archived session has no place from the Host; the list's 已归档 reads it as ended. */
export const groupOf = (card: BoardCard): BoardColumnGroup =>
  card.kind === 'item' ? card.item.board.group : (card.task.board?.group ?? 'done')

const sessionCard = (task: TaskSummary): BoardCard => ({ kind: 'session', id: task.id, task })

interface CardFacets {
  projects: string[]
  harnesses: string[]
  who: string[]
  tags: string[]
}

/** What a card is filtered by: a 待办 by its own project and tags and by its sessions, or (before it has one) its suggestions. */
function facetsOf(card: BoardCard, workspaces: readonly WorkspaceInfo[]): CardFacets {
  if (card.kind === 'session') {
    const { task } = card
    return { projects: [projectKey(task, workspaces)], harnesses: [task.harnessId ?? ''], who: [whoOf(task)], tags: task.tags ?? [] }
  }
  const { item, sessions } = card
  const started = item.sessionIds.length > 0
  return {
    projects: [
      ...new Set([...(item.projectId || !started ? [itemProjectKey(item)] : []), ...sessions.map(task => projectKey(task, workspaces))]),
    ],
    harnesses: started ? sessions.map(task => task.harnessId ?? '') : item.harnessId ? [item.harnessId] : [],
    // A 待办's sessions are Code sessions, and so is the one it would start.
    who: started ? sessions.map(whoOf) : [WHO_CODE],
    tags: item.tags ?? [],
  }
}

export const filtering = (filters: BoardFilters): boolean => Object.values(filters).some(values => values.length > 0)

function matchesFilters(card: BoardCard, filters: BoardFilters, workspaces: readonly WorkspaceInfo[]): boolean {
  if (!filtering(filters)) return true
  const facets = facetsOf(card, workspaces)
  // Or within a dimension, and between them.
  for (const key of ['projects', 'harnesses', 'who', 'tags'] as const)
    if (filters[key].length && !facets[key].some(value => filters[key].includes(value))) return false
  return true
}

const updated = (task: Pick<TaskSummary, 'updatedAt'>) => Date.parse(task.updatedAt) || 0
/** A 待办 changes when it or any of its sessions does. */
export const cardUpdated = (card: BoardCard): number =>
  card.kind === 'session' ? updated(card.task) : Math.max(updated(card.item), ...card.sessions.map(updated))
/** When the card last changed, as the Host wrote it. */
export const cardUpdatedAt = (card: BoardCard): string => new Date(cardUpdated(card)).toISOString()
const cardPriority = (card: BoardCard) => priorityOf(card.kind === 'item' ? card.item : card.task)
const cardReason = (card: BoardCard): BoardReason | undefined => {
  const reason = card.kind === 'item' ? card.item.board.reason : card.task.board?.reason
  return reason === 'settled' ? undefined : reason
}

/** Priority first (高, 中, 低), then within 等你处理 the Host's reason in rule order, then the newest change first. */
function compareCards(a: BoardCard, b: BoardCard): number {
  return (
    PRIORITY_RANK[cardPriority(a)] - PRIORITY_RANK[cardPriority(b)]
    || (groupOf(a) === 'attention' && groupOf(b) === 'attention'
      ? REASON_RANK[cardReason(a) ?? 'silent'] - REASON_RANK[cardReason(b) ?? 'silent']
      : 0)
    || cardUpdated(b) - cardUpdated(a)
    || a.id.localeCompare(b.id)
  )
}

/** On the board 已结束 keeps the last seven days by the Host's clock. */
const onBoard = (card: BoardCard, now: number): boolean => groupOf(card) !== 'done' || now - cardUpdated(card) <= DONE_DAYS * DAY

/**
 * Sessions no listed 待办 holds, by the rule `items.ts`'s `itemOfSession` reads (`items[].sessionIds` only; that module
 * imports this one, so the rule is repeated rather than imported). A held session is a row of its card, never a card,
 * row or count of its own.
 */
const outsideItems = (items: readonly WorkItemSummary[]) => {
  const held = new Set(items.flatMap(item => item.sessionIds))
  return (task: TaskSummary) => !held.has(task.id)
}

/** Every card the snapshot holds, unfiltered and in no order: its 待办 and the sessions of none. */
export function boardCards(tasks: readonly TaskSummary[], items: readonly WorkItemSummary[] = []): BoardCard[] {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const outside = outsideItems(items)
  return [
    ...items.map((item): BoardCard => ({
      kind: 'item',
      id: item.id,
      item,
      sessions: item.sessionIds.flatMap(id => {
        const task = byId.get(id)
        return task ? [task] : []
      }),
    })),
    ...tasks.filter(task => isCard(task) && outside(task)).map(sessionCard),
  ]
}

export interface BoardColumn {
  group: BoardColumnGroup
  /** The cards the filters let through, sorted. */
  cards: BoardCard[]
  /** How many cards the column holds without any filter. */
  total: number
}

export function boardColumns(
  tasks: readonly TaskSummary[],
  filters: BoardFilters,
  workspaces: readonly WorkspaceInfo[],
  now: number,
  items: readonly WorkItemSummary[] = [],
): BoardColumn[] {
  const cards = boardCards(tasks, items).filter(card => onBoard(card, now))
  return BOARD_GROUPS.map(group => {
    const own = cards.filter(card => groupOf(card) === group)
    return {
      group,
      cards: own.filter(card => matchesFilters(card, filters, workspaces)).toSorted(compareCards),
      total: own.length,
    }
  })
}

/** How many cards each group holds, unfiltered: what the column heads and the phone's state filter say. */
export function groupCounts(
  tasks: readonly TaskSummary[],
  now: number,
  items: readonly WorkItemSummary[] = [],
): Record<BoardColumnGroup, number> {
  const counts: Record<BoardColumnGroup, number> = { todo: 0, attention: 0, running: 0, deliver: 0, done: 0 }
  for (const card of boardCards(tasks, items)) if (onBoard(card, now)) counts[groupOf(card)]++
  return counts
}

/**
 * An archived session that would be a card: one of Code's, or a scheduled run of 我的 Agent. The Host gives an archived
 * session no card, so the list's 已归档 reads this instead. A 待办's archived session stays under its 待办.
 */
const archivedCard = (task: TaskSummary): boolean =>
  task.archived === true && !task.personal && (whoOf(task) === WHO_CODE || task.automationId !== undefined)

const groupRank = (card: BoardCard) => BOARD_GROUPS.indexOf(groupOf(card))

const archivedCards = (tasks: readonly TaskSummary[], items: readonly WorkItemSummary[]): BoardCard[] => {
  const outside = outsideItems(items)
  return tasks.filter(task => archivedCard(task) && outside(task)).map(sessionCard)
}

/** The list: every card (已结束 in full), or the archived sessions; by group, priority and time, or by time alone. */
export function listRows(
  tasks: readonly TaskSummary[],
  state: ListState,
  filters: BoardFilters,
  workspaces: readonly WorkspaceInfo[],
  order: 'group' | 'time',
  items: readonly WorkItemSummary[] = [],
): BoardCard[] {
  const cards =
    state === 'archived' ? archivedCards(tasks, items) : boardCards(tasks, items).filter(card => state === 'all' || groupOf(card) === state)
  return cards
    .filter(card => matchesFilters(card, filters, workspaces))
    .toSorted((a, b) =>
      order === 'time'
        ? cardUpdated(b) - cardUpdated(a) || a.id.localeCompare(b.id)
        : state === 'archived'
          ? compareCards(a, b)
          : groupRank(a) - groupRank(b) || compareCards(a, b),
    )
}

/** The phone's first state: 等你处理, or 进行中 when nothing waits. */
export const firstPhoneState = (counts: Record<BoardColumnGroup, number>): BoardColumnGroup =>
  counts.attention > 0 ? 'attention' : 'running'

export interface FilterOption {
  value: string
  label: string
}

const unique = <T>(values: T[]): T[] => [...new Set(values)]

/** What each filter can choose from: only what the cards (and the archived list) hold. */
export function filterOptions(
  tasks: readonly TaskSummary[],
  snapshot: Pick<AppSnapshot, 'catalog' | 'customAgents'>,
  items: readonly WorkItemSummary[] = [],
): Record<FilterKey, FilterOption[]> {
  const workspaces = snapshot.catalog?.workspaces ?? []
  const harnesses = snapshot.catalog?.harnesses ?? []
  const facets = [...boardCards(tasks, items), ...archivedCards(tasks, items)].map(card => facetsOf(card, workspaces))
  const projects = unique(facets.flatMap(facet => facet.projects)).map(id => ({
    value: id,
    label: id === NO_PROJECT ? '无项目' : (workspaces.find(item => item.id === id)?.name ?? id),
  }))
  const harnessIds = unique(facets.flatMap(facet => facet.harnesses).filter(id => !!id))
  const who = unique(facets.flatMap(facet => facet.who)).flatMap(id => {
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
    tags: unique(facets.flatMap(facet => facet.tags))
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
