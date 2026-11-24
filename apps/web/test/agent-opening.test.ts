import { describe, expect, it } from 'vitest'
import { fillDraft, openingActions, type OpeningInput } from '../src/agents/opening.ts'
import { helperLine } from '../src/agents/AgentsSpaceList.tsx'
import { currentLocale, setLocale } from '../src/core/i18n.ts'

const base: OpeningInput = {
  general: false,
  description: '查资料，写成一页摘要',
  abilities: [],
  mode: 'agent',
  schedules: [],
  canAutomate: false,
  project: undefined,
}

describe('an Agent speaks first', () => {
  it('offers three things it can really do, the most specific first', () => {
    const builtin = openingActions({
      ...base,
      abilities: ['files', 'mcp', 'ask', 'memory', 'schedule'],
      schedules: [{ name: '晨报', enabled: true, lastRun: { at: '2026-11-17T09:00:00.000Z', state: 'completed', trigger: 'schedule' } }],
      canAutomate: true,
    })
    expect(builtin.map(action => action.id)).toEqual(['schedule-last', 'duty', 'remember'])
    expect(builtin[0]).toMatchObject({ label: '「晨报」上次怎么样', text: '「晨报」上次运行得怎么样？结果在哪？' })
    // No schedule yet, but it can keep one: it offers to.
    expect(openingActions({ ...base, abilities: ['files', 'schedule'], canAutomate: true }).map(action => action.id)).toEqual([
      'duty',
      'schedule-new',
      'remember',
    ])
    // It cannot run on its own: no schedule offered.
    expect(
      openingActions({ ...base, description: '', abilities: ['files', 'commands', 'schedule'], canAutomate: false }).map(
        action => action.id,
      ),
    ).toEqual(['summarize', 'remember', 'steps'])
  })

  it('never promises what its Harness cannot do: a chat-only Agent has no folder or command', () => {
    const chat = openingActions({ ...base, mode: 'chat', abilities: ['files', 'commands'] })
    expect(chat.map(action => action.id)).toEqual(['duty', 'remember', 'steps'])
    expect(chat[0]).toMatchObject({ label: '查资料，写成一页摘要', text: '查资料，写成一页摘要。这次的材料或问题是：' })
    // A Harness with no card at all and no description: only what works everywhere.
    expect(openingActions({ ...base, description: undefined }).map(action => action.id)).toEqual(['summarize', 'remember', 'steps'])
    expect(openingActions({ ...base, abilities: ['files'], project: 'latch' })[1]).toMatchObject({
      id: 'folder',
      label: '梳理「latch」的材料',
    })
  })

  it('fills an English draft when the visible suggestion is in English', () => {
    const previous = currentLocale()
    try {
      setLocale('en')
      const [summary] = openingActions({ ...base, general: true })
      expect(summary?.label).toBe('Summarize my notes')
      expect(summary?.text).toMatch(/^Turn the material below into a one-page summary/u)
    } finally {
      setLocale(previous)
    }
  })

  it('fills the input without replacing what is written, and sends nothing', () => {
    expect(fillDraft('', '记住：')).toBe('记住：')
    expect(fillDraft('先写了一半  ', '记住：')).toBe('先写了一半\n记住：')
    expect(fillDraft('记住：', '记住：')).toBe('记住：')
  })
})

describe('a helper on a page of its own', () => {
  const row = { state: 'idle' as const, unavailable: undefined, topics: [], duty: '查资料' }
  it('says what it is doing, else what it last did, else its role', () => {
    expect(helperLine({ ...row, state: 'running', word: { words: '在看文件', tone: 'running' } }, false)).toBe('在看文件')
    expect(helperLine({ ...row, state: 'waiting' }, true)).toBe('上次状态：等你点头')
    expect(helperLine({ ...row, topics: [{ title: '比较三家汇率接口' }] as never }, false)).toBe('比较三家汇率接口')
    expect(helperLine(row, false)).toBe('查资料')
    expect(helperLine({ ...row, duty: '' }, false)).toBe('还没聊过')
    expect(helperLine({ ...row, unavailable: 'Harness 没准备好' }, false)).toBe('现在不能开始')
  })
})
