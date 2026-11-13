import { describe, expect, it, vi } from 'vitest'
import {
  browserDraftStorage,
  DRAFT_EXPIRY_MS,
  draftsKey,
  forgetStoredDrafts,
  holdsExcerpt,
  listedSessions,
  SessionDrafts,
} from '../src/core/sessionDrafts.ts'

describe('session text drafts', () => {
  it('restores only the requested conversation and removes text that was sent or explicitly cleared', () => {
    const drafts = new SessionDrafts()
    drafts.save('first', 'First unsent text', false)
    expect(drafts.read('second', true)).toBe('')
    drafts.save('second', 'Different text', false)
    expect(drafts.read('first', true)).toBe('First unsent text')
    drafts.remove('first')
    expect(drafts.read('first', true)).toBe('')
    drafts.save('second', '', false)
    expect(drafts.read('second', true)).toBe('')
  })
  it('drops private text on withdrawn access, keeps public text and clears everything on device replacement', () => {
    const drafts = new SessionDrafts()
    drafts.save('private', 'Private unsent text', true)
    drafts.save('public', 'Project text', false)
    drafts.clearPrivate()
    expect(drafts.read('private', true)).toBe('')
    expect(drafts.read('public', false)).toBe('Project text')
    drafts.save('private', 'Private again', true)
    expect(drafts.read('private', false)).toBe('')
    expect(drafts.read('private', true)).toBe('')
    drafts.clear()
    expect(drafts.read('public', true)).toBe('')
  })
  it('bounds count and aggregate text, touches recent drafts and refuses oversize text without overwriting it', () => {
    const drafts = new SessionDrafts()
    for (let i = 0; i < 20; i++) drafts.save(String(i), 'draft ' + i, false)
    drafts.read('0', true)
    drafts.save('last', 'Newest', false)
    expect(drafts.read('1', true)).toBe('')
    expect(drafts.read('0', true)).toBe('draft 0')
    drafts.save('large', 'x'.repeat(200_000), false)
    drafts.save('larger', 'y'.repeat(100_000), false)
    expect(drafts.read('large', true)).toBe('')
    expect(drafts.read('larger', true)).toHaveLength(100_000)
    expect(drafts.save('larger', 'z'.repeat(256_001), false)).toBe(false)
    expect(drafts.read('larger', true)).toHaveLength(100_000)
  })
})

describe('session text drafts kept in browser storage', () => {
  it.each([false, true])('rejects a late old device handle after replacement, including another window: %s', async otherWindow => {
    vi.useFakeTimers()
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      get length() {
        return values.size
      },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
    try {
      const origin = `https://draft-${otherWindow}.invalid`
      const old = new SessionDrafts(browserDraftStorage(origin, 'old'))
      old.save('first', 'old private draft', true)
      old.keep('queued', 'old delayed draft', true)
      const next = new SessionDrafts(browserDraftStorage(origin, 'next'))
      next.save('next', 'new device draft', false)
      if (otherWindow) {
        vi.resetModules()
        const remote = await import('../src/core/sessionDrafts.ts')
        remote.forgetStoredDrafts(origin, 'next')
      } else forgetStoredDrafts(origin, 'next')
      old.save('late', 'old reply arriving late', true)
      vi.advanceTimersByTime(1000)
      old.flush()
      expect(values.has(draftsKey(origin, 'old'))).toBe(false)
      next.save('after', 'next device remains writable', false)
      const restored = new SessionDrafts(browserDraftStorage(origin, 'next'))
      expect(restored.read('next', true)).toBe('new device draft')
      expect(restored.read('after', true)).toBe('next device remains writable')
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  const memory = () => {
    let value: string | null = null
    return {
      read: () => value,
      write: (next: string | null) => {
        value = next
      },
      get value() {
        return value
      },
    }
  }
  it('survives a reload per session and per new-session draft, with the open composer written a moment later', () => {
    vi.useFakeTimers()
    try {
      const storage = memory()
      const page = new SessionDrafts(storage)
      page.save('session-a', '草稿 A：还没发', false)
      page.keep('', '新会话的草稿', false)
      expect(JSON.parse(storage.value!).drafts.map(([id]: [string]) => id)).toEqual(['session-a'])
      vi.advanceTimersByTime(300)
      const reloaded = new SessionDrafts(storage)
      expect(reloaded.read('session-a', true)).toBe('草稿 A：还没发')
      expect(reloaded.read('', true)).toBe('新会话的草稿')
      expect(reloaded.read('session-b', true)).toBe('')
      // Emptied in the composer: gone after the next load too.
      reloaded.keep('', '', false)
      reloaded.flush()
      expect(new SessionDrafts(storage).read('', true)).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })
  it('removes a deleted session at once, keeps only listed sessions, and forgets everything on clear', () => {
    const storage = memory()
    const page = new SessionDrafts(storage)
    page.save('deleted', 'gone', false)
    page.save('listed', 'kept', false)
    page.save('', 'new', false)
    page.remove('deleted')
    expect(new SessionDrafts(storage).read('deleted', true)).toBe('')
    page.save('elsewhere', 'deleted on another device', false)
    page.retain(new Set(['listed']))
    const reloaded = new SessionDrafts(storage)
    expect(reloaded.read('elsewhere', true)).toBe('')
    expect(reloaded.read('listed', true)).toBe('kept')
    expect(reloaded.read('', true)).toBe('new')
    page.clear()
    expect(storage.value).toBeNull()
  })
  it('keeps private text out of a later load that may not see it', () => {
    const storage = memory()
    new SessionDrafts(storage).save('private', 'secret plan', true)
    const narrowed = new SessionDrafts(storage)
    expect(narrowed.read('private', false)).toBe('')
    expect(new SessionDrafts(storage).read('private', true)).toBe('')
  })
  it('falls back to memory when storage throws, and never leaves a stale copy it could not update', () => {
    let stored: string | null = JSON.stringify({ version: 1, drafts: [['a', { text: 'old', private: false, at: 1 }]] })
    let fail = false
    const storage = {
      read: () => {
        if (fail) throw new Error('blocked')
        return stored
      },
      write: (next: string | null) => {
        if (fail && next !== null) throw new Error('quota')
        stored = next
      },
    }
    const page = new SessionDrafts(storage)
    fail = true
    page.save('a', 'new text', false)
    expect(page.read('a', true)).toBe('new text')
    expect(stored).toBeNull()
    const unreadable = new SessionDrafts({
      read: () => {
        throw new Error('private mode')
      },
      write: () => {
        throw new Error('private mode')
      },
    })
    unreadable.save('b', 'memory only', false)
    expect(unreadable.read('b', true)).toBe('memory only')
  })
  it('lets two windows of one device keep each other’s drafts', () => {
    const storage = memory()
    const first = new SessionDrafts(storage),
      second = new SessionDrafts(storage)
    first.save('a', 'from the first window', false)
    second.save('b', 'from the second window', false)
    const reloaded = new SessionDrafts(storage)
    expect(reloaded.read('a', true)).toBe('from the first window')
    expect(reloaded.read('b', true)).toBe('from the second window')
  })
  it('keeps one device per origin, and after sign-out nothing written later brings a draft back', () => {
    vi.useFakeTimers()
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      get length() {
        return values.size
      },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    })
    try {
      const origin = 'https://mac.local'
      new SessionDrafts(browserDraftStorage(origin, 'dev_old')).save('a', 'old device', false)
      const current = new SessionDrafts(browserDraftStorage(origin, 'dev_new'))
      current.save('a', 'this device', false)
      values.set('latch.pending.other', 'kept')
      forgetStoredDrafts(origin, 'dev_new')
      const storedDrafts = () => [...values.keys()].filter(key => key.startsWith('latch.drafts.')).sort()
      expect(storedDrafts()).toEqual([draftsKey(origin, 'dev_new')])
      expect(values.get('latch.pending.other')).toBe('kept')
      current.keep('b', 'typed just before', false)
      forgetStoredDrafts(origin)
      vi.advanceTimersByTime(1000)
      current.save('c', 'after sign-out', false)
      expect(storedDrafts()).toEqual([])
      expect(values.get('latch.drafts-forgotten.' + origin)).toEqual(expect.any(String))
      expect(values.get('latch.pending.other')).toBe('kept')
      // Another window signs out: this one, still open, writes nothing on its way out either.
      const other = new SessionDrafts(browserDraftStorage(origin, 'dev_new'))
      other.keep('d', 'typed in the other window', false)
      values.set('latch.drafts-forgotten.' + origin, 'signed out elsewhere')
      other.flush()
      expect(values.has(draftsKey(origin, 'dev_new'))).toBe(false)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })
})

describe('which listing may drop a draft', () => {
  const drafts = () => {
    const page = new SessionDrafts()
    for (const id of ['kept', 'archived', 'deleted', '']) page.save(id, `text of ${id || 'new'}`, false)
    return page
  }
  const prune = (page: SessionDrafts, snapshot: Parameters<typeof listedSessions>[0], seesAll = true) => {
    const listed = listedSessions(snapshot, seesAll)
    if (listed) page.retain(listed)
  }
  it('keeps every draft when the Host could not list every Harness', () => {
    const page = drafts()
    prune(page, { tasks: [{ id: 'kept' }] })
    expect(page.read('deleted', true)).toBe('text of deleted')
    expect(page.read('archived', true)).toBe('text of archived')
  })
  it('keeps an archived session, which a whole listing still has', () => {
    const page = drafts()
    prune(page, { tasks: [{ id: 'kept' }, { id: 'archived', archived: true } as { id: string }], tasksComplete: true })
    expect(page.read('archived', true)).toBe('text of archived')
  })
  it('keeps a session hidden from this device by scope or privacy', () => {
    const page = drafts()
    prune(page, { tasks: [{ id: 'kept' }], tasksComplete: true }, false)
    expect(page.read('deleted', true)).toBe('text of deleted')
  })
  it('drops a really deleted session, and only it, from a whole listing this device sees in full', () => {
    const page = drafts()
    prune(page, { tasks: [{ id: 'kept' }, { id: 'archived' }], tasksComplete: true })
    expect(page.read('deleted', true)).toBe('')
    expect(page.read('kept', true)).toBe('text of kept')
    expect(page.read('', true)).toBe('text of new')
  })
})

describe('what a stored draft may hold', () => {
  const memory = () => {
    let value: string | null = null
    return {
      read: () => value,
      write: (next: string | null) => {
        value = next
      },
      get value() {
        return value
      },
    }
  }
  it('drops a draft not edited for 14 days at the next load', () => {
    vi.useFakeTimers()
    try {
      const storage = memory()
      new SessionDrafts(storage).save('old', 'written long ago', false)
      vi.advanceTimersByTime(DRAFT_EXPIRY_MS + 60_000)
      new SessionDrafts(storage).save('new', 'written today', false)
      const later = new SessionDrafts(storage)
      expect(later.read('old', true)).toBe('')
      expect(later.read('new', true)).toBe('written today')
    } finally {
      vi.useRealTimers()
    }
  })
  it('keeps a project file excerpt only for a device that may see every kind of data', () => {
    const storage = memory()
    const excerpt = '[引用 app.ts · 选中内容]\n> const x = 1\n（引用时文件：12 bytes，更新于 2026-11-12T00:00:00.000Z）\n'
    expect(holdsExcerpt(excerpt)).toBe(true)
    expect(holdsExcerpt('普通的文字 [引用 不算]')).toBe(false)
    new SessionDrafts(storage).save('session', excerpt, false)
    expect(new SessionDrafts(storage).read('session', false)).toBe('')
    new SessionDrafts(storage).save('session', excerpt, false)
    expect(new SessionDrafts(storage).read('session', true)).toBe(excerpt)
  })
  it('never stores an excerpt written after the scope narrowed, though the text stays on screen', () => {
    const storage = memory()
    const page = new SessionDrafts(storage)
    const excerpt = '[引用 app.ts · 选中内容]\n> const x = 1\n（引用时文件：12 bytes，更新于 2026-11-12T00:00:00.000Z）\n'
    page.allowPrivate(false)
    page.save('session', excerpt, false)
    page.keep('other', excerpt + ' more', false)
    page.flush()
    expect(storage.value).toBeNull()
    expect(page.read('session', false)).toBe('')
  })
  it('keeps text holding a credential in memory only, without a word', () => {
    const storage = memory()
    const page = new SessionDrafts(storage)
    const secret = 'use sk-' + 'proj-' + 'a'.repeat(28) + ' for this'
    page.save('session', secret, false)
    page.save('plain', 'nothing secret', false)
    expect(page.read('session', true)).toBe(secret)
    expect(storage.value).not.toContain('sk-proj')
    expect(new SessionDrafts(storage).read('session', true)).toBe('')
    expect(new SessionDrafts(storage).read('plain', true)).toBe('nothing secret')
    page.save('carrier', 'open https://me:pw@example.test/ then', false)
    expect(new SessionDrafts(storage).read('carrier', true)).toBe('')
  })
})
