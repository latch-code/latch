import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { geminiThinkingOption, geminiThinkingSettings } from '../src/profiles/gemini-thinking.ts'
import { geminiProfile } from '../src/profiles/gemini.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('Gemini thinking as a private launch setting', () => {
  it('offers only documented values for the exact model family and never calls them an Agent read-back', () => {
    const values = (model: string) => geminiThinkingOption(model)?.options.map(option => option.value)
    expect(values('gemini-3-pro-preview')).toEqual(['default', 'low', 'high'])
    expect(values('gemini-3.1-pro-preview')).toEqual(['default', 'low', 'medium', 'high'])
    expect(values('gemini-3-flash-preview')).toEqual(['default', 'minimal', 'low', 'medium', 'high'])
    expect(values('gemini-2.5-pro')).not.toContain('0')
    expect(values('gemini-2.5-flash')).toContain('0')
    expect(values('auto-gemini-3')).toBeUndefined()
    expect(values('custom-alias')).toBeUndefined()
    expect(geminiThinkingOption('gemini-3.1-pro-preview')).toMatchObject({ source: 'launch', currentValue: 'default' })
    expect(geminiThinkingOption('gemini-3.1-pro-preview', { model: 'gemini-3-flash-preview', value: 'minimal' })?.currentValue).toBe(
      'default',
    )
    expect(() => geminiThinkingSettings({ model: 'gemini-3-pro-preview', value: 'medium' })).toThrow('Unsupported')
  })

  it('keeps separate 0600 settings for two sessions, targets only their model and preserves approval settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-gemini-thinking-'))
    roots.push(root)
    const first = await geminiProfile.materialize!({
      dataDir: root,
      session: { directory: join(root, 'one'), thinking: { model: 'gemini-3.1-pro-preview', value: 'low' } },
    })
    const second = await geminiProfile.materialize!({
      dataDir: root,
      session: { directory: join(root, 'two'), thinking: { model: 'gemini-2.5-flash', value: '1024' } },
    })
    const fileA = first.GEMINI_CLI_SYSTEM_SETTINGS_PATH!
    const fileB = second.GEMINI_CLI_SYSTEM_SETTINGS_PATH!
    expect(fileA).not.toBe(fileB)
    for (const path of [fileA, fileB]) expect((await stat(path)).mode & 0o777).toBe(0o600)
    const a = JSON.parse(await readFile(fileA, 'utf8'))
    const b = JSON.parse(await readFile(fileB, 'utf8'))
    expect(a.modelConfigs.customAliases).toEqual({
      'gemini-3.1-pro-preview': {
        extends: 'chat-base-3',
        modelConfig: { model: 'gemini-3.1-pro-preview', generateContentConfig: { thinkingConfig: { thinkingLevel: 'LOW' } } },
      },
    })
    expect(b.modelConfigs.customAliases['gemini-2.5-flash'].modelConfig.generateContentConfig.thinkingConfig).toEqual({
      thinkingBudget: 1024,
    })
    expect(a.security).toEqual({ disableAlwaysAllow: true, enablePermanentToolApproval: false })
    expect(geminiThinkingSettings({ model: 'gemini-3.1-pro-preview', value: 'default' })).toEqual({})
  })
})
