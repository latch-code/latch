import type { BoardAttendInput, TaskSummary, WorkItemSummary } from '@latch/protocol'
import { checkSettle, openedSettle } from '../core/attend.ts'
import { BOARD_GROUPS, groupOf, type BoardCard, type BoardColumnGroup } from './model.ts'

/**
 * Dragging a card between columns is a gesture, never a status: the drop performs one of the card's existing actions,
 * and the card then stands wherever the Host's derived group puts it.
 */
export type DropAction =
  /** 开始: the same 新建 dialog as the card's button, bound to the revision it reads. */
  | { kind: 'start'; item: WorkItemSummary }
  /** 完成 (`closed: true`). */
  | { kind: 'finish'; item: WorkItemSummary }
  /** 重新打开 (`closed: false`). */
  | { kind: 'reopen'; item: WorkItemSummary }
  /** 停止, after a confirm at the drop. */
  | { kind: 'stop'; task: TaskSummary }
  /** `POST /tasks/:id/attend`: the failed run opened, the unknown results checked. */
  | { kind: 'attend'; task: TaskSummary; input: BoardAttendInput }

export interface DropFacts {
  /** This device may start a session now (the new-session input is open). */
  canStart: boolean
  /** This device holds the run scope: 完成, 重新打开, 停止 and 已核对. */
  canMark: boolean
  /** The card has a write of its own the Host has not answered for certain: nothing new is sent meanwhile. */
  unconfirmed: boolean
  /** A stop of this session is already on its way. */
  stopping: boolean
}

/** What dropping `card` on `target` does, or null where it may not go. 等你处理 and 可交付 never take a drop. */
export function dropAction(card: BoardCard, target: BoardColumnGroup, facts: DropFacts): DropAction | null {
  const from = groupOf(card)
  if (target === from || target === 'attention' || target === 'deliver' || target === 'todo') return null
  if (facts.unconfirmed) return null
  if (card.kind === 'item') {
    const { item } = card
    if (from === 'todo') return target === 'running' && facts.canStart ? { kind: 'start', item } : null
    if (!facts.canMark) return null
    if (target === 'done') return { kind: 'finish', item }
    // Only a 待办 the person marked done reopens; one ended by its merged pull request has nothing to undo.
    return from === 'done' && target === 'running' && item.closedAt !== undefined ? { kind: 'reopen', item } : null
  }
  const { task } = card
  if (target !== 'done') return null
  if (from === 'running') return facts.canMark && !facts.stopping ? { kind: 'stop', task } : null
  if (from !== 'attention') return null
  // A failed run is opened, results nobody can vouch for are checked; a failed run with both is let go of in one drop
  // (both name the same settlement, the Host's `board.settle`).
  const opened = openedSettle(task)
  const checked = facts.canMark ? checkSettle(task) : undefined
  const settle = opened ?? checked
  // Unknown results come first in the Host's reasons: opening alone would leave the run in 等你处理.
  if (settle === undefined || (task.board?.reason === 'unknown' && checked === undefined)) return null
  return {
    kind: 'attend',
    task,
    input: {
      settle,
      ...(opened !== undefined ? { opened: true as const } : {}),
      ...(checked !== undefined ? { checked: true as const } : {}),
    },
  }
}

/** Every column `card` may be dropped on, with what the drop does there. */
export function dropTargets(card: BoardCard, facts: DropFacts): Map<BoardColumnGroup, DropAction> {
  const targets = new Map<BoardColumnGroup, DropAction>()
  for (const group of BOARD_GROUPS) {
    const action = dropAction(card, group, facts)
    if (action) targets.set(group, action)
  }
  return targets
}
