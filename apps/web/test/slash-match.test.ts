import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { SLASH_MATCH_VECTORS_FILE } from '@latch/testkit'
import { matchSlash, pinyinInitials, slashToken } from '../src/composer/slash-match.ts'

describe('slash matching', () => {
  it('matches the shared native and web vectors', () => {
    const vectors = JSON.parse(readFileSync(SLASH_MATCH_VECTORS_FILE, 'utf8')) as {
      cases: Array<{ name: string; query: string; description?: string; score: number | null }>
    }
    for (const item of vectors.cases)
      expect(matchSlash(item.name, item.query, item.description)?.score ?? null, item.name + ':' + item.query).toBe(item.score)
  })
  it('ranks names before descriptions and matches noncontiguous letters', () => {
    expect(matchSlash('compact', 'compact')?.score).toBe(0)
    expect(matchSlash('compact', 'com')?.score).toBe(1)
    expect(matchSlash('project-review', 'rev')?.score).toBe(2)
    expect(matchSlash('compact', 'mpa')?.score).toBe(4)
    expect(matchSlash('compact', 'cmpt')).toEqual({ score: 5, positions: [0, 2, 3, 6] })
    expect(matchSlash('compact', '压缩', '压缩上下文')?.score).toBe(6)
    expect(matchSlash('compact', 'missing')).toBeUndefined()
  })
  it('finds Chinese templates by platform pinyin initials', () => {
    expect(pinyinInitials('代码审查')).toBe('dmsc')
    expect(matchSlash('代码审查', 'dmsc')?.score).toBe(3)
    expect(pinyinInitials('检查改动')).toBe('jcgd')
  })
  it('recognizes fullwidth slashes and inline template queries, leaving paths and parameters alone', () => {
    expect(slashToken('／Rev')).toMatchObject({ query: 'rev', start: 0, initial: true })
    expect(slashToken('看看 /rev 后面', 7)).toMatchObject({ query: 'rev', start: 3, initial: false })
    expect(slashToken('/tmp/x')).toBeUndefined()
    expect(slashToken('/review argument')).toBeUndefined()
    expect(slashToken('abc/review')).toBeUndefined()
    expect(slashToken('/review', 3)).toBeUndefined()
  })
})
