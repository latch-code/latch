import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { grokSavedRules, grokStartCatalogue } from '../src/profiles/grok.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** Grok Build 1.0.89's `initialize._meta.modelState` in a temporary home (2026-11-20), descriptions trimmed. */
const MODEL_STATE = {
  currentModelId: 'grok-4.6',
  availableModels: [
    {
      modelId: 'grok-4.6',
      name: 'Grok 4.6',
      _meta: {
        totalContextTokens: 500000,
        supportsReasoningEffort: true,
        reasoningEffort: 'high',
        reasoningEfforts: [
          { id: 'xhigh', value: 'xhigh', label: 'Extra High Effort', description: 'Highest effort and reasoning level', default: false },
          {
            id: 'high',
            value: 'high',
            label: 'High Effort',
            description: 'Higher implementation quality with extensive reasoning',
            default: true,
          },
          { id: 'low', value: 'low', label: 'Low Effort', description: 'Quick, fast implementations', default: false },
        ],
      },
    },
    { modelId: 'main-model', name: 'main-model', _meta: { totalContextTokens: 200000 } },
  ],
}

describe('Grok Build before a session', () => {
  it('reads the model list and thinking from its answer to initialize, as its session/new then reports them', () => {
    const read = grokStartCatalogue({ modelState: MODEL_STATE, agentVersion: '1.0.89' })
    // The `model` and `reasoning_effort` options its session/new answered with in the same home.
    const thinking = {
      id: 'reasoning_effort',
      name: 'Reasoning Effort',
      category: 'thought_level',
      currentValue: 'high',
      options: [
        { value: 'xhigh', name: 'Extra High Effort', description: 'Highest effort and reasoning level' },
        { value: 'high', name: 'High Effort', description: 'Higher implementation quality with extensive reasoning' },
        { value: 'low', name: 'Low Effort', description: 'Quick, fast implementations' },
      ],
    }
    expect(read).toEqual({
      options: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          currentValue: 'grok-4.6',
          options: [
            { value: 'grok-4.6', name: 'Grok 4.6' },
            { value: 'main-model', name: 'main-model' },
          ],
        },
        thinking,
      ],
      perModel: [
        { model: 'grok-4.6', options: [thinking] },
        { model: 'main-model', options: [] },
      ],
    })
  })

  it('reads nothing from a shape it does not know', () => {
    expect(grokStartCatalogue(undefined)).toBeUndefined()
    expect(grokStartCatalogue({ modelState: { currentModelId: 'gone', availableModels: MODEL_STATE.availableModels } })).toBeUndefined()
    expect(grokStartCatalogue({ modelState: { currentModelId: 'grok-4.6', availableModels: [] } })).toBeUndefined()
  })
})

describe('Grok Build saved answers', () => {
  it('says the project of a session has saved answers, by the repository root, without reading them', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-grok-saved-')))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const repo = join(root, 'repo')
    await mkdir(join(repo, '.git'), { recursive: true })
    await mkdir(join(repo, 'packages', 'web'), { recursive: true })
    const home = join(root, 'home')
    const saved = join(home, '.grok', 'sessions', encodeURIComponent(repo))
    await mkdir(saved, { recursive: true })
    // An empty file holds nothing, and another tool's file is not Grok's answer.
    await writeFile(join(saved, 'permission.toml'), '')
    await writeFile(join(saved, 'notes.toml'), 'x')
    expect(await grokSavedRules(join(repo, 'packages', 'web'), { HOME: home })).toEqual([])
    await writeFile(join(saved, 'permission_latch.toml'), 'SECRET-LOOKING CONTENT')
    const notes = await grokSavedRules(join(repo, 'packages', 'web'), { HOME: home })
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('permission_latch.toml')
    expect(notes[0]).not.toContain('SECRET')
    // GROK_HOME moves the home; a folder outside any repository is its own scope.
    expect(await grokSavedRules(join(repo, 'packages', 'web'), { HOME: home, GROK_HOME: join(root, 'elsewhere') })).toEqual([])
    const loose = join(root, 'loose')
    await mkdir(join(home, '.grok', 'sessions', encodeURIComponent(loose)), { recursive: true })
    await writeFile(join(home, '.grok', 'sessions', encodeURIComponent(loose), 'permission.toml'), 'x')
    expect(await grokSavedRules(loose, { HOME: home })).toHaveLength(1)
    expect(await grokSavedRules(loose, {})).toEqual([])
  })
})
