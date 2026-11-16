import { useEffect, useRef, useState } from 'react'
import type { AppSnapshot, TaskSummary } from '@latch/protocol'
import { readSpace, spaceKey, spaceOf, waitingCount, writeSpace, type Space } from '../sessions.ts'
import type { MyAgentTarget, ShellEntry, ShellRoute } from './routes.ts'

/**
 * The place the shell is in: 我的 Agent's own pages, or the open session's place (a delegated session belongs to 我的
 * Agent); the new-session page is Code's home. A session the Host has not listed yet, and the pages both places share
 * (应用, 设置), keep the place last shown. Without 我的 Agent there is only Code.
 */
export function currentSpace({
  agents,
  entry,
  selectedId,
  selected,
  remembered,
  start = false,
}: {
  agents: boolean
  entry: ShellEntry
  selectedId: string | null
  selected: Pick<TaskSummary, 'agent' | 'generalChat'> | undefined
  remembered: Space
  start?: boolean | undefined
}): Space {
  if (start) return 'code'
  if (!agents) return 'code'
  if (entry === 'agents') return 'agents'
  if (entry === 'sessions') {
    if (selected) return spaceOf(selected)
    if (selectedId === null) return 'code'
  }
  return remembered
}

export const otherSpace = (space: Space): Space => (space === 'code' ? 'agents' : 'code')

/** Something waits for you in the place you are not in: its segment carries the amber dot. */
export function waitsElsewhere(snapshot: Pick<AppSnapshot, 'tasks' | 'approvals'>, space: Space): boolean {
  return waitingCount(snapshot, otherSpace(space)) > 0
}

/** Which places hold something that waits for you; a segment shows its dot only while it is not the place shown. */
export function placeWaits(snapshot: Pick<AppSnapshot, 'tasks' | 'approvals'>, agents: boolean): Record<Space, boolean> {
  return agents
    ? { code: waitingCount(snapshot, 'code') > 0, agents: waitingCount(snapshot, 'agents') > 0 }
    : { code: false, agents: false }
}

/** Where a place was left: a session, or (for 我的 Agent) one of its pages. */
export type Left = { kind: 'session'; id: string } | { kind: 'page'; myAgent?: MyAgentTarget | undefined } | { kind: 'start' }

/**
 * Going to a place: back to the session it was left on while that session is still its own and not archived (Code also
 * keeps an open session of its own), else its home: the new-session page, or 我的 Agent's list or the page it was left
 * on. `choose` is the session to open, when it is not the one open.
 */
export function spaceMove({
  target,
  left,
  selected,
  selectedId,
  tasks,
}: {
  target: Space
  left: Left | undefined
  selected: TaskSummary | undefined
  selectedId: string | null
  tasks: readonly TaskSummary[]
}): { route: ShellRoute; choose?: string | null } {
  const session =
    left?.kind === 'session' ? tasks.find(task => task.id === left.id && spaceOf(task) === target && !task.archived) : undefined
  const opening = (id: string | null) => (id === selectedId ? {} : { choose: id })
  if (target === 'code') {
    if (left?.kind === 'start') return { route: { entry: 'sessions', start: true } }
    const here = selected && spaceOf(selected) === 'code' ? selected.id : undefined
    return { route: { entry: 'sessions' }, ...opening(here ?? session?.id ?? null) }
  }
  if (session) return { route: { entry: 'sessions' }, ...opening(session.id) }
  return { route: { entry: 'agents', ...(left?.kind === 'page' && left.myAgent ? { myAgent: left.myAgent } : {}) } }
}

/** Whether the home was showing over the open session when this tab last drew Code; kept for the tab, per device. */
const homeKey = (deviceId: string) => `latch.home.${location.origin}.${deviceId}`

export function readHomeShown(deviceId: string): boolean {
  try {
    return sessionStorage.getItem(homeKey(deviceId)) === '1'
  } catch {
    return false
  }
}

export function writeHomeShown(deviceId: string, shown: boolean): void {
  try {
    if (shown) sessionStorage.setItem(homeKey(deviceId), '1')
    else sessionStorage.removeItem(homeKey(deviceId))
  } catch {
    /* Without storage a reload opens the session, which is still there under the home. */
  }
}

/**
 * On a cold start a wide window opens the place this device was last in (Code's start screen, or 我的 Agent's list); a
 * phone opens on its session list. A reload restores the open session, and the start screen over it when that is what
 * was showing: it is a place, not a way to a session.
 */
export function initialRoute(deviceId: string, agents: boolean, wide: boolean, restoring: boolean, home = false): ShellRoute {
  return agents && wide && !restoring && readSpace(spaceKey(deviceId)) === 'agents'
    ? { entry: 'agents' }
    : { entry: 'sessions', ...((wide && !restoring) || home ? { start: true } : {}) }
}

/**
 * The two places and the way between them. Going to a place returns to where it was left (a session that is still its
 * own, or 我的 Agent's page), otherwise to its home: the new-session page, or 我的 Agent's list. The place is kept per
 * device.
 */
export function useSpaces({
  snapshot,
  agents,
  route,
  setRoute,
  selectedId,
  selected,
  choose,
  leave,
}: {
  snapshot: AppSnapshot
  agents: boolean
  route: ShellRoute
  setRoute: (route: ShellRoute) => void
  selectedId: string | null
  selected: TaskSummary | undefined
  choose: (id: string | null) => void
  /** Closes what a move away closes: the tablet's drawer, a phone's new-session sheet. */
  leave: () => void
}) {
  const key = spaceKey(snapshot.device.id)
  const [remembered, setRemembered] = useState<Space>(() => readSpace(key))
  const space = currentSpace({
    agents,
    entry: route.entry,
    selectedId,
    selected,
    remembered,
    start: route.start,
  })
  // The place shown is the one to keep while a shared page or an unlisted session is open.
  if (agents && space !== remembered) setRemembered(space)
  useEffect(() => {
    if (agents) writeSpace(key, space)
  }, [agents, key, space])
  const left = useRef<Record<Space, Left | undefined>>({ code: undefined, agents: undefined })
  useEffect(() => {
    if (!agents) return
    if (route.start) {
      left.current.code = { kind: 'start' }
      return
    }
    if (route.entry === 'sessions' && selectedId !== null) left.current[space] = { kind: 'session', id: selectedId }
    else if (route.entry === 'sessions' && space === 'code') left.current.code = undefined
    else if (route.entry === 'agents') left.current.agents = { kind: 'page', myAgent: route.myAgent }
  }, [agents, space, route.entry, route.myAgent, route.start, selectedId])
  const goSpace = (target: Space) => {
    if (target === 'agents' && !agents) return
    leave()
    const move = spaceMove({ target, left: left.current[target], selected, selectedId, tasks: snapshot.tasks })
    setRoute(move.route)
    if (move.choose !== undefined) choose(move.choose)
  }
  return { space, goSpace, waits: placeWaits(snapshot, agents) }
}

/**
 * Where a phone goes back to from a session: a conversation in 我的 Agent to its list, where its Agent's row opens it
 * again; anything else (or without 我的 Agent) to Code's list, which is null here.
 */
export function backRoute(task: Pick<TaskSummary, 'agent' | 'generalChat'> | undefined, hasAgents: boolean): ShellRoute | null {
  return hasAgents && task && spaceOf(task) === 'agents' ? { entry: 'agents' } : null
}
