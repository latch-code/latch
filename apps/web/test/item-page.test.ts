import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, TaskSummary, WorkItem, WorkItemSummary } from '@latch/protocol'
import { ItemPrompt } from '../src/board/ItemPage.tsx'
import { bringReply, itemOfSession, joinableSessions, lastReply, openItems } from '../src/board/items.ts'
import { readPending, submissionRequest, writePending, type PendingSubmission } from '../src/core/api.ts'
import { handDraft, takeHandedDraft } from '../src/core/draftHandoff.ts'
import { sessionMenuSections, type SessionActions } from '../src/sessionMenu.ts'

const noop = () => {}
const ITEM = 'itm_AAAAAAAAAAAAAAAAAAAAAA'
const task = (id: string, extra: Partial<TaskSummary> = {}): TaskSummary => ({
  harnessId: 'standard',
  id,
  title: id,
  status: 'idle',
  updatedAt: '2026-11-17T00:00:00.000Z',
  ...extra,
})
const item = (extra: Partial<WorkItem> = {}): WorkItem => ({
  id: ITEM,
  title: '给 README 加一节',
  prompt: '写一节安装说明',
  sessionIds: [],
  createdAt: '2026-11-17T00:00:00.000Z',
  updatedAt: '2026-11-17T00:00:00.000Z',
  revision: 1,
  board: { group: 'todo' },
  ...extra,
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the 待办 page', () => {
  it('edits 要求 while the 待办 has no session, and only reads it once one exists', () => {
    const render = (editable: boolean) =>
      renderToStaticMarkup(createElement(ItemPrompt, { record: item(), editable, busy: false, onSave: async () => true }))
    const before = render(true)
    expect(before).toContain('<textarea')
    expect(before).toContain('写一节安装说明')
    expect(before).toContain('保存')
    const after = render(false)
    expect(after).not.toContain('<textarea')
    expect(after).not.toContain('保存')
    expect(after).toContain('写一节安装说明')
    expect(after).toContain('data-readonly')
  })

  it('带过去 reads the source once and only hands its last reply to the target’s input: nothing is sent', async () => {
    const read = vi.fn(async (_path: string) => ({
      messages: [
        { id: 'u', role: 'user' as const, text: '审一下' },
        { id: 'a1', role: 'assistant' as const, text: '旧的回复' },
        { id: 'a2', role: 'assistant' as const, text: '第一行\n\n第二行' },
        { id: 't', role: 'tool' as const, text: 'ls' },
      ],
    }))
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const opened: string[] = []
    const result = await bringReply('source', 'target', {
      read,
      // What the session controller appends to the target's input when it opens.
      hand: handDraft,
      open: id => opened.push(id),
    })
    expect(result).toBe('brought')
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith('tasks/source')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(opened).toEqual(['target'])
    expect(takeHandedDraft('target')).toBe('> 第一行\n>\n> 第二行')
    expect(takeHandedDraft('source')).toBeUndefined()
  })

  it('brings nothing from a session that has not replied', async () => {
    const hand = vi.fn()
    const open = vi.fn()
    const result = await bringReply('source', 'target', {
      read: async () => ({ messages: [{ id: 'u', role: 'user', text: '在吗' }] }),
      hand,
      open,
    })
    expect(result).toBe('empty')
    expect(hand).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('bounds a long reply at a line', () => {
    const long = `${'a'.repeat(5000)}\n${'b'.repeat(5000)}`
    const reply = lastReply([{ role: 'assistant', text: long }])!
    expect(reply.length).toBeLessThan(long.length)
    expect(reply.endsWith('\n…')).toBe(true)
    expect(reply).not.toContain('b')
  })
})

describe('membership as the Host lists it', () => {
  const snapshot = {
    tasks: [
      task('in-item'),
      task('free', { updatedAt: '2026-11-17T02:00:00.000Z' }),
      task('older'),
      task('agent', { agent: { customAgentId: 'a' } } as Partial<TaskSummary>),
      task('archived', { archived: true }),
      task('claims-item', { itemId: 'itm_BBBBBBBBBBBBBBBBBBBBBB' }),
    ],
    items: [item({ sessionIds: ['in-item'], board: { group: 'running' } })] as WorkItemSummary[],
  } satisfies Pick<AppSnapshot, 'tasks' | 'items'>

  it('reads it from items[].sessionIds, never from a session’s own field', () => {
    expect(itemOfSession(snapshot, 'in-item')?.id).toBe(ITEM)
    expect(itemOfSession(snapshot, 'claims-item')).toBeUndefined()
    expect(itemOfSession({}, 'in-item')).toBeUndefined()
  })

  it('offers listed Code sessions in no 待办 to join, newest first', () => {
    expect(joinableSessions(snapshot).map(entry => entry.id)).toEqual(['free', 'older', 'claims-item'])
  })

  it('offers only 待办 not done and not full to a session', () => {
    const items = [
      item({ id: 'itm_CCCCCCCCCCCCCCCCCCCCCC', closedAt: '2026-11-17T01:00:00.000Z' }),
      item({ id: 'itm_DDDDDDDDDDDDDDDDDDDDDD', sessionIds: ['1', '2'] }),
      item(),
    ]
    expect(openItems({ items }, 2).map(entry => entry.id)).toEqual([ITEM])
  })

  it('puts 加入待办… or 移出待办 in the session menu, never both', () => {
    const actions: SessionActions = { rename: noop, pin: noop, export: noop }
    const ids = (extra: Partial<SessionActions>) =>
      sessionMenuSections(task('s'), { ...actions, ...extra }, true).flatMap(section => section.items.map(entry => entry.label))
    expect(ids({ item: { join: noop } })).toContain('加入待办…')
    expect(ids({ item: { join: noop } })).not.toContain('移出待办')
    expect(ids({ item: { leave: noop } })).toContain('移出待办')
    expect(ids({})).not.toContain('加入待办…')
    expect(ids({})).not.toContain('移出待办')
  })
})

describe('再开一个 through the input', () => {
  it('sends a 待办’s start to its own route, without a fork or an Agent, and keeps that across a reload', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    })
    const submission: PendingSubmission = {
      requestId: '11111111-1111-4111-8111-111111111111',
      prompt: '审这个分支',
      mode: 'agent',
      harnessId: 'opencode',
      workspaceId: 'release',
      worktree: { from: 'reuse', name: '20261117-abcd' },
      itemId: ITEM,
      itemRevision: 3,
    }
    expect(submissionRequest(submission)).toEqual({
      path: `work/items/${ITEM}/start`,
      body: {
        prompt: '审这个分支',
        requestId: submission.requestId,
        baseRevision: 3,
        mode: 'agent',
        harnessId: 'opencode',
        workspaceId: 'release',
        worktree: { from: 'reuse', name: '20261117-abcd' },
      },
    })
    writePending('k', submission)
    expect(readPending('k')).toEqual(submission)
    // Never retried anywhere else: dropped rather than sent as `POST /tasks`.
    for (const bad of [
      { ...submission, itemId: 'not-an-item' },
      { ...submission, itemRevision: undefined },
      { ...submission, itemRevision: 0 },
      { ...submission, sessionId: 's' },
      { ...submission, customAgentId: 'general' },
      { ...submission, forkOf: { taskId: 't', upToMessageId: 'm' } },
    ]) {
      store.set('k', JSON.stringify(bad))
      expect(readPending('k')).toBeNull()
    }
  })
})
