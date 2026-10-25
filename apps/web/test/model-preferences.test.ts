import { describe, expect, it } from 'vitest'
import { fuzzyModelMatch, parseModelPreferences } from '../src/modelPreferences.ts'
describe('local model choices', () => {
  it('matches abbreviated literal model names without interpreting regex syntax', () => {
    expect(fuzzyModelMatch('OpenAI gpt-5.1-mini', 'gpt5m')).toBe(true)
    expect(fuzzyModelMatch('Claude Sonnet 4', 'clsn4')).toBe(true)
    expect(fuzzyModelMatch('gpt-5', '.*')).toBe(false)
    expect(fuzzyModelMatch('本地模型', '本模')).toBe(true)
  })
  it('migrates absent or malformed preferences, deduplicates choices and bounds recent history', () => {
    expect(parseModelPreferences(null)).toEqual({ recent: [], hidden: [] })
    expect(parseModelPreferences(JSON.stringify({ recent: ['a', 'a', 'b', 'c', 'd', 'e', 'f'], hidden: ['x', 1, 'x'] }))).toEqual({
      recent: ['a', 'b', 'c', 'd', 'e'],
      hidden: ['x'],
    })
  })
})
