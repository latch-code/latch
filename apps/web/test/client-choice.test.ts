import { createElement } from 'react'
import { testHarness } from '@latch/testkit'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_PRESETS,
  pairRoute,
  GATEWAY_LOSSES,
  type AppSnapshot,
  type HarnessInfo,
  type HostCatalog,
  type ModelWire,
  type TaskSummary,
} from '@latch/protocol'
import { readPending, submissionRequest, writePending, type PendingSubmission } from '../src/core/api.ts'
import { workspaceSections } from '../src/components/Pickers.tsx'
import { workspaceOptions } from '../src/components/pickerOptions.tsx'
import {
  engineEntries,
  listsFoundHarnesses,
  noProjectLine,
  worktreeProject,
  nothingInstalled,
  presetsToAdd,
  projectFor,
  resolveChoice,
  draftStart,
  startableWorkspaces,
  startBlock,
  usesDemoModel,
  isPinnedChoice,
  pickedOwnDefault,
  pinnedChoice,
  projectDefault,
  servicePick,
  withOwnDefault,
  withServicePick,
  type ComposerChoice,
  type DraftPick,
} from '../src/composerChoice.ts'
import { forkedChoice } from '../src/forkChoice.ts'
import { presetsFound } from '../src/core/agentDetection.ts'
import { GeneralSettings } from '../src/settings/GeneralSettings.tsx'

const at = (id: string) => AGENT_PRESETS.find(preset => preset.id === id)!

function catalog(overrides: Partial<HostCatalog> = {}): HostCatalog {
  return {
    harnesses: [
      testHarness('standard', { kind: 'builtin', label: 'Latch 内置' }),
      testHarness('codex', { kind: 'agent', label: 'Codex' }),
      testHarness('pi', { kind: 'agent', label: 'pi', status: 'unavailable', statusMessage: '未找到命令 pi' }),
    ],
    providers: [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        kind: 'openai-compatible',
        models: ['deepseek-chat', 'deepseek-reasoner'],
        defaultModel: 'deepseek-chat',
      },
      { id: 'local', name: 'Ollama', kind: 'openai-compatible', models: ['qwen3'], defaultModel: 'qwen3' },
    ],
    workspaces: [
      { id: 'default', name: 'app', path: '/work/app' },
      { id: 'docs', name: 'docs', path: '/work/docs' },
    ],
    defaults: { harnessId: 'standard', mode: 'agent', workspaceId: 'default', model: { providerId: 'deepseek', model: 'deepseek-chat' } },
    ...overrides,
  }
}

function snapshot(extra: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    instanceId: 'host',
    device: {
      id: 'd',
      name: 'Mac',
      status: 'active',
      listener: 'loopback-tcp',
      scopes: ['view', 'run', 'approve:standard', 'admin'],
      dataScope: 'work',
      fingerprint: 'ABCD EFGH IJKL MNOP QRST',
      createdAt: '',
      lastSeenAt: '',
      credentialExpiresAt: '',
      pairedBy: { method: 'lpc' },
      current: true,
      renewAfter: '',
    },
    host: {
      hostId: 'h',
      devMode: true,
      presence: { status: 'available' },
      tls: null,
    },
    tasks: [],
    approvals: [],
    demo: false,
    hostName: 'host',
    ...extra,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('composer choice', () => {
  it('keeps only the mode when the Host sends no catalog', () => {
    expect(resolveChoice(undefined, null)).toEqual({ mode: 'agent' })
    expect(resolveChoice(undefined, { mode: 'chat', harnessId: 'x' })).toEqual({ mode: 'chat' })
  })

  it('takes the workspace from the Host', () => {
    expect(resolveChoice(catalog(), null)).toEqual({ mode: 'agent', harnessId: 'codex', workspaceId: 'default' })
  })

  it('derives the mode: with no project and no folder the owner set, a harness that can chat does', () => {
    const start = catalog().workspaces.find(item => item.id === 'default')!
    const saved = { id: 'app', name: 'app', path: '/repo/app' }
    const hostChosen = catalog({ sessionFolders: true, workspaces: [start, saved] })
    const noProject = { workspaceId: 'default', projectSkipped: true }
    expect(resolveChoice(hostChosen, { harnessId: 'standard', ...noProject })).toMatchObject({ mode: 'chat', workspaceId: 'default' })
    expect(resolveChoice(hostChosen, { harnessId: 'codex', ...noProject })).toMatchObject({ mode: 'agent', workspaceId: 'default' })
    expect(resolveChoice(hostChosen, { harnessId: 'standard', workspaceId: 'app' })).toMatchObject({ mode: 'agent', workspaceId: 'app' })
    // A start directory the owner set is a folder: 不选项目 works in it.
    expect(resolveChoice(catalog({ workspaces: [start, saved] }), { harnessId: 'standard', ...noProject })).toMatchObject({ mode: 'agent' })
    // What this device remembers does not decide it.
    expect(resolveChoice(hostChosen, { mode: 'chat', harnessId: 'standard', workspaceId: 'app' })).toMatchObject({ mode: 'agent' })
    expect(resolveChoice(hostChosen, { mode: 'agent', harnessId: 'standard', ...noProject })).toMatchObject({ mode: 'chat' })
  })

  it('lets a fork keep its source mode while the Harness has it', () => {
    const hostChosen = catalog({ sessionFolders: true })
    const borrowed = { harnessId: 'standard', workspaceId: 'default', projectSkipped: true }
    expect(forkedChoice(hostChosen, null, { ...borrowed, mode: 'agent' }).choice).toMatchObject({ mode: 'agent' })
    expect(forkedChoice(catalog(), null, { ...borrowed, mode: 'chat' }).choice).toMatchObject({ mode: 'chat' })
    expect(forkedChoice(hostChosen, null, { ...borrowed, harnessId: 'codex', mode: 'chat' }).choice).toMatchObject({ mode: 'agent' })
  })

  it('says what 不选项目 does for this Harness, in one kind of sentence for both kinds', () => {
    const [builtin, codex] = catalog().harnesses
    expect(noProjectLine({ ...builtin!, modes: ['chat', 'agent'] })).toBe('Latch 内置 只回复文字，不读写文件')
    expect(noProjectLine({ ...codex!, modes: ['agent'] })).toBe('Codex 在一个新的空文件夹里开始')
  })

  it('never asks: the last engine of this device, otherwise the first it can start with the built-in one last', () => {
    expect(resolveChoice(catalog(), null).harnessId).toBe('codex')
    expect(resolveChoice(catalog(), { harnessId: 'standard' }).harnessId).toBe('standard')
    expect(startBlock(snapshot({ catalog: catalog() }), resolveChoice(catalog(), null))).toBeNull()
    const onlyBuiltin = catalog({ harnesses: [catalog().harnesses[0]!] })
    expect(resolveChoice(onlyBuiltin, null).harnessId).toBe('standard')
  })

  it('orders engines as the presets are, whatever order the Host lists them in', () => {
    const local = { legacy: false, local: true }
    const [builtin, codex] = catalog().harnesses
    const offered = testHarness('opencode', { label: 'OpenCode', offer: { presetId: 'opencode' } })
    const listed = catalog({ harnesses: [builtin!, offered, testHarness('custom', { label: '自定义', mark: 'none' }), codex!] })
    expect(engineEntries(listed).map(entry => entry.harness.id)).toEqual(['codex', 'opencode', 'custom', 'standard'])
  })

  it('lists a Harness too old to run greyed with 需要升级, and keeps it chosen when it was found too old after the pick', () => {
    const [builtin, codex] = catalog().harnesses
    const pi = {
      ...testHarness('pi', { label: 'pi', offer: { presetId: 'pi' } }),
      status: 'unavailable' as const,
      statusMessage: 'pi 需要 0.84.4 或更高版本（当前 0.84.3）。升级：npm i -g pi',
      statusReason: 'outdated' as const,
    }
    const broken = { ...testHarness('broken', { label: '坏了' }), status: 'unavailable' as const, statusMessage: '未找到命令 broken' }
    const listed = catalog({ harnesses: [builtin!, codex!, pi, broken] })
    const entry = engineEntries(listed).find(item => item.harness.id === 'pi')
    expect(entry).toMatchObject({ disabledReason: '需要升级', line: '' })
    // Unavailable for any other reason, it is not listed at all.
    expect(engineEntries(listed).some(item => item.harness.id === 'broken')).toBe(false)
    // Never the first choice of a device that picked nothing; kept when the person had picked it.
    expect(resolveChoice(listed, null).harnessId).toBe('codex')
    const kept = resolveChoice(listed, { harnessId: 'pi' })
    expect(kept.harnessId).toBe('pi')
    expect(startBlock(snapshot({ catalog: listed }), kept)).toEqual({ kind: 'harness-unavailable', message: pi.statusMessage })
  })

  it('remembers 不选项目 as a choice of its own', () => {
    const hostChosen = catalog({ sessionFolders: true, workspaces: catalog().workspaces.filter(item => item.id === 'default') })
    // 不选项目 is remembered; anything else leaves the question open.
    expect(resolveChoice(hostChosen, { workspaceId: 'default', projectSkipped: true }).projectSkipped).toBe(true)
    expect(resolveChoice(hostChosen, { workspaceId: 'default' }).projectSkipped).toBeUndefined()
  })

  it('offers a new worktree only for a Git project with one folder, for a session that works on files and is no fork', () => {
    const git = { id: 'api', name: 'api', path: '/work/api', branch: 'main', folders: [{ id: 'f1', path: '/work/api' }] }
    const hosted = catalog({ workspaces: [...catalog().workspaces, git] })
    const choice = resolveChoice(hosted, { harnessId: 'codex', workspaceId: 'api' })
    expect(worktreeProject(hosted, choice, false)?.id).toBe('api')
    expect(worktreeProject(hosted, choice, true)).toBeUndefined()
    expect(worktreeProject(hosted, { ...choice, mode: 'chat' }, false)).toBeUndefined()
    expect(worktreeProject(hosted, { ...choice, workspaceId: 'docs' }, false)).toBeUndefined()
    const without = (patch: Partial<typeof git>) => catalog({ workspaces: [{ ...git, ...patch }] })
    expect(worktreeProject(without({ branch: undefined }), choice, false)).toBeUndefined()
    expect(worktreeProject(without({ unavailable: '找不到这个文件夹' } as Partial<typeof git>), choice, false)).toBeUndefined()
    expect(worktreeProject(without({ folders: [git.folders[0]!, { id: 'f2', path: '/work/shared' }] }), choice, false)).toBeUndefined()
  })

  it('takes a saved project when nothing was chosen and the Host would otherwise make a folder', () => {
    const start = catalog().workspaces[0]!
    const saved = { ...start, id: 'rust', name: 'rust-learn', path: '/tmp/rust-learn' }
    const both = catalog({ sessionFolders: true, workspaces: [start, saved] })
    expect(resolveChoice(both, null).workspaceId).toBe('rust')
    expect(resolveChoice(both, { workspaceId: 'default', projectSkipped: true }).workspaceId).toBe('default')
    expect(resolveChoice(catalog({ workspaces: [start, saved] }), null).workspaceId).toBe('default')
  })

  it('lists what was found on a first open of this Mac only, and never beside the install card', () => {
    const owner = { legacy: false, local: true, admin: true }
    const found = catalog()
    expect(listsFoundHarnesses(found, 0, owner)).toBe(true)
    // A first open is a Host with no session yet: nothing else records one.
    expect(listsFoundHarnesses(found, 1, owner)).toBe(false)
    // Another device, or one that cannot manage the Host, is not this Mac's app.
    expect(listsFoundHarnesses(found, 0, { ...owner, local: false })).toBe(false)
    expect(listsFoundHarnesses(found, 0, { ...owner, admin: false })).toBe(false)
    expect(listsFoundHarnesses(found, 0, { ...owner, legacy: true })).toBe(false)
    expect(listsFoundHarnesses(undefined, 0, owner)).toBe(false)
    // Nothing that runs commands was found: the install card speaks, with or without a service.
    const onlyBuiltin = catalog({ harnesses: [catalog().harnesses[0]!], providers: [] })
    expect(listsFoundHarnesses(onlyBuiltin, 0, owner)).toBe(false)
    expect(nothingInstalled(startBlock(snapshot({ catalog: onlyBuiltin }), resolveChoice(onlyBuiltin, null)), onlyBuiltin, owner)).toBe(
      true,
    )
    const withService = catalog({ harnesses: [catalog().harnesses[0]!] })
    expect(listsFoundHarnesses(withService, 0, owner)).toBe(false)
    // A found Harness with a saved service is still listed: the card is about what is on this Mac.
    expect(listsFoundHarnesses(catalog({ providers: [] }), 0, owner)).toBe(true)
  })

  it('sorts the presets into found, half-way and the rest, in preset order, counting each once', () => {
    const sorted = presetsFound([
      { ...at('codex'), detected: { found: false, agent: { command: 'codex', found: true } } },
      { ...at('claude-agent'), detected: { found: true, path: '/opt/homebrew/bin/claude-agent-acp' } },
      { ...at('pi'), detected: { found: false } },
      { ...at('opencode'), detected: { found: true, path: '/opt/homebrew/bin/opencode' } },
      // An older Host sends no detection: the preset is in no list.
      at('goose'),
    ])
    expect(sorted.found.map(item => [item.preset.id, item.path])).toEqual([
      ['claude-agent', '/opt/homebrew/bin/claude-agent-acp'],
      ['opencode', '/opt/homebrew/bin/opencode'],
    ])
    expect(sorted.halfway.map(item => [item.preset.id, item.program])).toEqual([['codex', 'codex']])
    expect(sorted.more.map(preset => preset.id)).toEqual(['pi'])
  })

  it('says what to install only where nothing else can run and this device could change that', () => {
    const owner = { legacy: false, local: true, admin: true }
    const onlyBuiltin = catalog({ harnesses: [catalog().harnesses[0]!], providers: [] })
    const missing = startBlock(snapshot({ catalog: onlyBuiltin }), resolveChoice(onlyBuiltin, null))
    expect(nothingInstalled(missing, onlyBuiltin, owner)).toBe(true)
    expect(nothingInstalled(missing, onlyBuiltin, { ...owner, local: false })).toBe(false)
    expect(nothingInstalled(missing, onlyBuiltin, { ...owner, admin: false })).toBe(false)
    expect(nothingInstalled(null, onlyBuiltin, owner)).toBe(false)
    expect(nothingInstalled(missing, catalog(), owner)).toBe(false)
  })

  it("starts a draft on its project's default model only where this device picked none, and remembers a pick as before", () => {
    const remote = { legacy: false, local: false }
    const withDefault = catalog({
      workspaces: [
        { id: 'default', name: 'app', path: '/work/app' },
        { id: 'docs', name: 'docs', path: '/work/docs', defaultModel: { providerId: 'local', model: 'qwen3' } },
        { id: 'old', name: 'old', path: '/work/old', defaultModel: { providerId: 'gone', model: 'removed' } },
      ],
    })
    const started = (memory: Partial<ComposerChoice> | null, pick: DraftPick | null = null) =>
      resolveChoice(withDefault, draftStart(withDefault, memory, pick, remote))
    const picked = { providerId: 'deepseek', model: 'deepseek-reasoner' }
    // No model picked on this device yet: the project's, not the Host's own default; another project has none.
    expect(started({ harnessId: 'standard', workspaceId: 'docs' }).model).toEqual({ providerId: 'local', model: 'qwen3' })
    expect(started({ harnessId: 'standard', workspaceId: 'default' }).model).toEqual(catalog().defaults.model)
    // A model this device picked is remembered and comes first, in a project with a default like anywhere else:
    // the memory is returned untouched, so nothing of the pick is held back from it.
    const memory = { harnessId: 'standard', workspaceId: 'docs', model: picked }
    expect(draftStart(withDefault, memory, null, remote)).toBe(memory)
    expect(started(memory).model).toEqual(picked)
    // A remembered model that is gone counts as none.
    expect(started({ harnessId: 'standard', workspaceId: 'docs', model: { providerId: 'gone', model: 'x' } }).model).toEqual({
      providerId: 'local',
      model: 'qwen3',
    })
    // A default that cannot be used now is no default.
    const stale = { harnessId: 'standard', workspaceId: 'old' }
    expect(projectDefault(withDefault, stale)).toBeUndefined()
    expect(draftStart(withDefault, stale, null, remote)).toBe(stale)
    // A Harness with its own models takes it as a service pick while nothing was picked for it.
    const routed = started({ harnessId: 'codex', workspaceId: 'docs' })
    const codex = withDefault.harnesses.find(harness => harness.id === 'codex')!
    const offered = servicePick(withDefault, codex, routed.config)
    if (codex.capabilities.models.wires.length) expect(offered).toEqual({ providerId: 'local', model: 'qwen3' })
    else expect(offered).toBeUndefined()
    const chosen = withServicePick(undefined, { providerId: 'deepseek', model: 'deepseek-chat' })!
    const kept = servicePick(withDefault, codex, started({ harnessId: 'codex', workspaceId: 'docs', config: chosen }).config)
    if (codex.capabilities.models.wires.length) expect(kept).toEqual({ providerId: 'deepseek', model: 'deepseek-chat' })
  })

  it("keeps the Harness's own default once it is chosen, before the project's default model, and remembers it", () => {
    const remote = { legacy: false, local: false }
    const gemini = testHarness('gemini', { kind: 'agent', label: 'Gemini CLI' })
    const routable: HostCatalog = {
      ...catalog(),
      harnesses: [
        {
          ...gemini,
          capabilities: {
            ...gemini.capabilities,
            models: { ...gemini.capabilities.models, owner: 'harness', wires: ['chat-completions'] },
          },
        },
      ],
      workspaces: [
        { id: 'default', name: 'app', path: '/work/app' },
        { id: 'docs', name: 'docs', path: '/work/docs', defaultModel: { providerId: 'local', model: 'qwen3' } },
      ],
    }
    const harness = routable.harnesses[0]!
    const started = (memory: Partial<ComposerChoice> | null) => resolveChoice(routable, draftStart(routable, memory, null, remote))
    // Nothing picked for this Harness: the project's model, as a service pick the menu shows and the start sends.
    const untouched = started({ harnessId: 'gemini', workspaceId: 'docs' })
    expect(servicePick(routable, harness, untouched.config)).toEqual({ providerId: 'local', model: 'qwen3' })
    expect(pickedOwnDefault(untouched.config)).toBe(false)
    // 「默认」 chosen in the menu: a pick like any other, kept through a repair of the picks and into the next draft.
    const chosen = withOwnDefault(untouched.config)
    expect(servicePick(routable, harness, chosen)).toBeUndefined()
    const next = started({ harnessId: 'gemini', workspaceId: 'docs', config: chosen })
    expect(pickedOwnDefault(next.config)).toBe(true)
    expect(servicePick(routable, harness, next.config)).toBeUndefined()
    expect(pickedOwnDefault(started(next).config)).toBe(true)
    // Picking a service model afterwards replaces it; so does going back to nothing picked in another project.
    const again = withServicePick(next.config, { providerId: 'deepseek', model: 'deepseek-chat' })
    expect(pickedOwnDefault(again)).toBe(false)
    expect(servicePick(routable, harness, started({ harnessId: 'gemini', workspaceId: 'docs', config: again! }).config)).toEqual({
      providerId: 'deepseek',
      model: 'deepseek-chat',
    })
    // It is the Harness's alone: Latch 内置 never carries it.
    expect(pickedOwnDefault(resolveChoice(catalog(), { harnessId: 'standard', config: chosen }).config)).toBe(false)
  })

  it('starts from a pinned engine and model on the devices that can use it, a pick in the draft winning until it starts', () => {
    const local = { legacy: false, local: true }
    const remote = { legacy: false, local: false }
    const pinned = catalog({
      defaults: {
        harnessId: 'codex',
        mode: 'agent',
        workspaceId: 'default',
        model: { providerId: 'deepseek', model: 'deepseek-chat' },
        pinned: true,
      },
    })
    // Pinned on the Mac, so unlike a Host's plain default it counts as this person's choice of a full-access engine.
    const started = (memory: Partial<ComposerChoice> | null, pick: DraftPick | null = null) =>
      resolveChoice(pinned, draftStart(pinned, memory, pick, local))
    expect(started(null).harnessId).toBe('codex')
    // The pin stands in for what this device remembers, what it does not hold stays.
    expect(draftStart(pinned, { harnessId: 'standard', mode: 'chat' }, null, local)).toMatchObject({ harnessId: 'codex', mode: 'chat' })
    // A pick in this draft stands in for the pin, and is gone once the draft is.
    expect(started({ harnessId: 'standard' }, { harnessId: 'standard' }).harnessId).toBe('standard')
    expect(started({ harnessId: 'standard' }, null).harnessId).toBe('codex')
    // The pin holds only where it can be seen and taken back: other devices keep their own memory, untouched.
    const elsewhere = { harnessId: 'standard', model: { providerId: 'local', model: 'qwen3' } }
    expect(pinnedChoice(pinned, remote)).toBeUndefined()
    expect(draftStart(pinned, elsewhere, null, remote)).toBe(elsewhere)
    expect(resolveChoice(pinned, draftStart(pinned, null, null, remote)).harnessId).toBe('codex')
    expect(pinnedChoice(catalog(), local)).toBeUndefined()
    expect(isPinnedChoice(pinned, testHarness('codex'), undefined)).toBe(true)
    expect(isPinnedChoice(pinned, testHarness('standard', { kind: 'builtin' }), undefined)).toBe(false)
  })

  it('says a named engine is gone', () => {
    const local = { legacy: false, local: true }
    expect(startBlock(snapshot({ catalog: catalog() }), { mode: 'agent', harnessId: 'deleted-agent' })).toMatchObject({
      kind: 'harness-unavailable',
    })
  })

  it('says plainly when there is no engine or no model service', () => {
    const none = catalog({ harnesses: [catalog().harnesses[2]!] })
    expect(startBlock(snapshot({ catalog: none }), resolveChoice(none, null))).toEqual({
      kind: 'harness-unavailable',
      message: '没有可用的 Harness。',
    })
    const noService = catalog({ providers: [], harnesses: [catalog().harnesses[0]!] })
    expect(startBlock(snapshot({ catalog: noService }), resolveChoice(noService, null))).toEqual({
      kind: 'model-required',
      message: '还没有模型服务。',
    })
  })

  it('never picks or offers a workspace the Host disabled for this run', () => {
    const disabled = catalog({
      workspaces: [
        { id: 'default', name: 'app', path: '/work/app' },
        { id: 'docs', name: 'docs', path: '/work/docs', unavailable: '该目录位于受保护目录（如 .git）内，不能作为项目' },
      ],
      defaults: { harnessId: 'standard', mode: 'agent', workspaceId: 'docs' },
    })
    expect(resolveChoice(disabled, { workspaceId: 'docs' }).workspaceId).toBe('default')
    expect(startableWorkspaces(disabled).map(item => item.id)).toEqual(['default'])
    const offered = workspaceSections(disabled, 'default', () => {}).flatMap(section => section.items.map(item => item.id))
    expect(offered).toEqual(['default'])
    // With one startable workspace left, the phone's new-session sheet offers only that one (its row is plain text).
    expect(workspaceOptions(disabled).map(option => option.value)).toEqual(['default'])
    const onlyDisabled = catalog({ workspaces: [{ id: 'docs', name: 'docs', path: '/work/docs', unavailable: 'x' }] })
    expect(resolveChoice(onlyDisabled, { workspaceId: 'docs' })).not.toHaveProperty('workspaceId')
  })

  it('lists the engines that are ready, the built-in one last, and offers unadded presets separately', () => {
    expect(engineEntries(catalog()).map(entry => [entry.harness.id, entry.label])).toEqual([
      ['codex', 'Codex'],
      ['standard', 'Latch 内置'],
    ])
    expect(presetsToAdd(catalog()).map(preset => preset.id)).toEqual([
      'claude-agent',
      'opencode',
      'dsh',
      'gemini',
      'qwen',
      'goose',
      'cursor',
      'antigravity',
      'grok',
    ])
  })

  it('keeps a valid remembered choice', () => {
    const stored = { mode: 'agent' as const, harnessId: 'standard', workspaceId: 'docs', model: { providerId: 'local', model: 'qwen3' } }
    expect(resolveChoice(catalog(), stored)).toEqual(stored)
  })

  it('repairs a choice the Host no longer supports instead of failing at submit time', () => {
    expect(resolveChoice(catalog(), { harnessId: 'pi', mode: 'agent' }).harnessId).toBe('codex')
    expect(resolveChoice(catalog(), { harnessId: 'gone' }).harnessId).toBe('codex')
    expect(resolveChoice(catalog(), { workspaceId: 'removed' }).workspaceId).toBe('default')
    expect(resolveChoice(catalog(), { harnessId: 'standard', model: { providerId: 'deepseek', model: 'retired' } }).model).toEqual({
      providerId: 'deepseek',
      model: 'deepseek-chat',
    })
    // An agent-managed harness carries no host model, and only accepts its own modes.
    expect(resolveChoice(catalog(), { harnessId: 'codex', mode: 'chat', model: { providerId: 'local', model: 'qwen3' } })).toEqual({
      mode: 'agent',
      harnessId: 'codex',
      workspaceId: 'default',
    })
  })

  it('falls back to the first configured model when the default is missing', () => {
    const next = catalog({ defaults: { harnessId: 'standard', mode: 'chat', workspaceId: 'default' } })
    expect(resolveChoice(next, { harnessId: 'standard' }).model).toEqual({ providerId: 'deepseek', model: 'deepseek-chat' })
  })

  it('explains why a new session cannot start', () => {
    const standard = { harnessId: 'standard' }
    expect(startBlock(snapshot({ catalog: catalog() }), resolveChoice(catalog(), standard))).toBeNull()
    expect(
      startBlock(snapshot({ catalog: catalog({ providers: [] }) }), resolveChoice(catalog({ providers: [] }), standard)),
    ).toMatchObject({
      kind: 'model-required',
    })
    // A configured service the Host holds back is named, with what it lacks and the computer to do it on.
    const held = catalog({
      providers: [],
      unusableProviders: [
        { id: 'ollama', name: 'Ollama\u202e', reason: 'origin-unconfirmed' },
        { id: 'deepseek', name: 'DeepSeek', reason: 'key-missing' },
      ],
    })
    expect(startBlock(snapshot({ catalog: held }), resolveChoice(held, standard))).toEqual({
      kind: 'model-required',
      message: '还没有可用的模型服务。「Ollama\\u{202E}」的地址还没有确认。',
      hint: '在 host 的 设置 › 模型 里确认地址',
      action: '打开模型服务',
    })
    const keyless = catalog({ providers: [], unusableProviders: [{ id: 'deepseek', name: 'DeepSeek', reason: 'key-missing' }] })
    expect(startBlock(snapshot({ catalog: keyless }), resolveChoice(keyless, standard))).toMatchObject({
      message: '还没有可用的模型服务。「DeepSeek」还没有填写密钥。',
      hint: '在 host 的 设置 › 模型 里填写密钥',
    })
    // Agent harnesses bring their own models.
    expect(
      startBlock(snapshot({ catalog: catalog({ providers: [] }) }), resolveChoice(catalog({ providers: [] }), { harnessId: 'codex' })),
    ).toBeNull()
    const onlyUnavailable = catalog({
      harnesses: [catalog().harnesses[2]!],
      defaults: { harnessId: 'pi', mode: 'agent', workspaceId: 'default' },
    })
    expect(startBlock(snapshot({ catalog: onlyUnavailable }), resolveChoice(onlyUnavailable, null))).toEqual({
      kind: 'harness-unavailable',
      message: '没有可用的 Harness。',
    })
    expect(startBlock(snapshot({ execution: { ready: false, modelConfigurationRequired: true } }), { mode: 'chat' })).toMatchObject({
      kind: 'model-required',
    })
    expect(startBlock(snapshot({ execution: { ready: false } }), { mode: 'chat' })).toMatchObject({ kind: 'harness-unavailable' })
  })
})

describe('pending submissions', () => {
  it('replays the full create body, including harness, model and project', () => {
    const submission: PendingSubmission = {
      requestId: 'r1',
      prompt: '你好',
      mode: 'chat',
      harnessId: 'standard',
      workspaceId: 'docs',
      model: { providerId: 'local', model: 'qwen3' },
    }
    expect(submissionRequest(submission)).toEqual({
      path: 'tasks',
      body: {
        prompt: '你好',
        requestId: 'r1',
        mode: 'chat',
        harnessId: 'standard',
        model: { providerId: 'local', model: 'qwen3' },
        workspaceId: 'docs',
      },
    })
  })

  it('keeps the legacy create body when the Host has no catalog', () => {
    expect(submissionRequest({ requestId: 'r1', prompt: 'x' })).toEqual({
      path: 'tasks',
      body: { prompt: 'x', requestId: 'r1', mode: 'agent' },
    })
  })

  it('never sends again a stored message that an assistant was to answer', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    })
    store.set('pending', JSON.stringify({ requestId: 'r1', prompt: '你好', assistantId: 'asst_11111111-1111-4111-8111-111111111111' }))
    expect(readPending('pending')).toBeNull()
  })

  it('sends a model switch only with the prompt that asked for it', () => {
    expect(submissionRequest({ requestId: 'r2', prompt: 'y', sessionId: 'a/b' })).toEqual({
      path: 'tasks/a%2Fb/prompt',
      body: { prompt: 'y', requestId: 'r2' },
    })
    expect(submissionRequest({ requestId: 'r3', prompt: 'z', sessionId: 's', model: { providerId: 'p', model: 'm' } }).body).toEqual({
      prompt: 'z',
      requestId: 'r3',
      model: { providerId: 'p', model: 'm' },
    })
  })

  it('stores and validates the submission in browser storage', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value)
      },
      removeItem: (key: string) => {
        store.delete(key)
      },
    })
    const submission: PendingSubmission = {
      requestId: 'r1',
      prompt: 'p',
      mode: 'agent',
      harnessId: 'codex',
      workspaceId: 'docs',
      model: { providerId: 'x', model: 'y' },
      attachmentIds: ['abcdefghijklmnopqrstuv'],
      fileRefs: [{ root: 'api', path: 'main.ts' }],
      worktree: true,
    }
    expect(submissionRequest(submission).body).toMatchObject({
      attachmentIds: submission.attachmentIds,
      fileRefs: submission.fileRefs,
      worktree: true,
    })
    writePending('k', submission)
    expect(readPending('k')).toEqual(submission)
    // A worktree belongs to a new session only.
    store.set('k', JSON.stringify({ requestId: 'r1', prompt: 'p', sessionId: 's', worktree: true }))
    expect(readPending('k')).toBeNull()
    store.set('k', JSON.stringify({ requestId: 'r1', prompt: 'p', worktree: 'yes' }))
    expect(readPending('k')).toBeNull()
    store.set('k', JSON.stringify({ requestId: 'r1', prompt: 'p', model: { providerId: 1 } }))
    expect(readPending('k')).toBeNull()
    store.set('k', JSON.stringify({ requestId: 'r1', prompt: 'p', harnessId: 3 }))
    expect(readPending('k')).toBeNull()
    writePending('k', null)
    expect(readPending('k')).toBeNull()
  })
})

describe('demo labelling', () => {
  const withDemo = catalog({
    providers: [{ id: 'demo', name: '演示模型', kind: 'demo', models: ['demo'], defaultModel: 'demo' }, ...catalog().providers],
    defaults: { harnessId: 'standard', mode: 'agent', workspaceId: 'default', model: { providerId: 'demo', model: 'demo' } },
  })

  it('labels only host-model sessions on a demo provider, even on a Host started in demo mode', () => {
    const host = snapshot({ demo: true, catalog: withDemo })
    expect(usesDemoModel(host, 'standard', 'demo')).toBe(true)
    expect(usesDemoModel(host, 'standard', 'deepseek')).toBe(false)
    expect(usesDemoModel(host, 'codex', undefined)).toBe(false)
    // Sessions without a recorded provider follow the Host default.
    expect(usesDemoModel(host, undefined, undefined)).toBe(true)
    expect(usesDemoModel(snapshot({ demo: true, catalog: catalog() }), undefined, undefined)).toBe(false)
  })

  it('falls back to the Host-wide flag without a catalog', () => {
    expect(usesDemoModel(snapshot({ demo: true }), undefined, undefined)).toBe(true)
    expect(usesDemoModel(snapshot({ demo: false }), undefined, undefined)).toBe(false)
  })
})

/** A session that ran in `cwd`. */
const task = (cwd?: string): TaskSummary => ({
  harnessId: 'standard',
  id: 't',
  title: '',
  status: 'idle',
  updatedAt: '',
  ...(cwd ? { cwd } : {}),
})

describe('harness entries', () => {
  it('applies multi-folder limits to Agent sessions while keeping chat independent of folders', () => {
    const limited = catalog({
      harnesses: [testHarness('standard', { kind: 'builtin', label: 'Latch 内置', projectFolders: { access: 'all', max: 1 } })],
      workspaces: [
        {
          id: 'wide',
          name: 'Wide',
          path: '/work/api',
          folders: [
            { id: 'api', path: '/work/api' },
            { id: 'web', path: '/work/web' },
          ],
        },
      ],
    })
    const entries = engineEntries(limited, 'wide')
    expect(entries[0]?.disabledReason).toBe('最多 1 个文件夹，这个项目有 2 个')
    expect(
      startBlock({ catalog: limited } as AppSnapshot, { harnessId: 'standard', workspaceId: 'wide', mode: 'agent' })?.message,
    ).toContain('最多使用 1 个')
  })

  it('offers only the presets no agent was added from yet', () => {
    expect(presetsToAdd(catalog()).map(preset => preset.id)).not.toContain('codex')
    expect(presetsToAdd(catalog()).map(preset => preset.id)).not.toContain('pi')
    const more = catalog({
      harnesses: [
        testHarness('standard', { kind: 'builtin', label: 'Latch 内置' }),
        testHarness('opencode-2', { kind: 'agent', label: 'OpenCode' }),
      ],
    })
    expect(presetsToAdd(more).map(preset => preset.id)).toEqual([
      'codex',
      'claude-agent',
      'pi',
      'dsh',
      'gemini',
      'qwen',
      'goose',
      'cursor',
      'antigravity',
      'grok',
    ])
    expect(presetsToAdd(undefined)).toHaveLength(AGENT_PRESETS.length)
  })

  it('starts a new session in the project of the session it is opened from', () => {
    expect(projectFor(catalog(), task('/work/docs/guides'))).toBe('docs')
    expect(projectFor(catalog(), task('/work/app'))).toBe('default')
    expect(projectFor(catalog(), task('/elsewhere'))).toBeUndefined()
    // A project the Host cannot use this run is not chosen.
    const unusable = catalog({ workspaces: [{ id: 'docs', name: 'docs', path: '/work/docs', unavailable: '目录不存在' }] })
    expect(projectFor(unusable, task('/work/docs'))).toBeUndefined()
    expect(projectFor(undefined, task('/work/docs'))).toBeUndefined()
  })
})

describe('a model service for a Harness with its own models', () => {
  const speaking = (harness: HarnessInfo, wires: ModelWire[], experimental?: true): HarnessInfo => ({
    ...harness,
    capabilities: { ...harness.capabilities, models: { ...harness.capabilities.models, wires, ...(experimental ? { experimental } : {}) } },
  })
  const services = catalog({
    harnesses: [
      testHarness('standard', { kind: 'builtin', label: 'Latch 内置' }),
      speaking(testHarness('codex', { label: 'Codex' }), ['responses'], true),
    ],
    providers: [
      { id: 'openai', name: 'OpenAI', kind: 'openai-responses', models: ['gpt-5.5', 'gpt-5.5-mini'], defaultModel: 'gpt-5.5' },
      { id: 'deepseek', name: 'DeepSeek', kind: 'openai-compatible', models: ['deepseek-chat'], defaultModel: 'deepseek-chat' },
      { id: 'demo', name: 'Demo', kind: 'demo', models: ['demo'], defaultModel: 'demo' },
    ],
  })
  const codex = services.harnesses[1]!

  it('prefers the same protocol, advertises only implemented translations and refuses other pairs', () => {
    expect(pairRoute(codex.capabilities)).toEqual({ kind: 'own' })
    expect(pairRoute(codex.capabilities, { kind: 'openai-responses' })).toEqual({
      kind: 'passthrough',
      wire: 'responses',
      experimental: true,
    })
    expect(pairRoute(codex.capabilities, { kind: 'openai-compatible' })).toEqual({
      kind: 'translate',
      wire: 'responses',
      upstream: 'chat-completions',
      experimental: true,
      losses: GATEWAY_LOSSES,
    })
    expect(pairRoute(codex.capabilities, { kind: 'anthropic' })).toEqual({
      kind: 'translate',
      wire: 'responses',
      upstream: 'anthropic-messages',
      experimental: true,
      losses: GATEWAY_LOSSES.filter(loss => loss !== 'tool-image-location'),
    })
    expect(pairRoute(codex.capabilities, { kind: 'demo' })).toEqual({ kind: 'unavailable', reason: 'not-a-service' })
    expect(pairRoute(testHarness('goose').capabilities, { kind: 'gemini' })).toEqual({ kind: 'unavailable', reason: 'not-forwarded' })
    expect(pairRoute(services.harnesses[0]!.capabilities, { kind: 'anthropic' })).toEqual({ kind: 'direct' })
  })

  it("keeps a service pick as that Harness's own, and only while Latch can forward the pair", () => {
    const picked = withServicePick({ model: 'gpt-5.5-codex', effort: 'high' }, { providerId: 'openai', model: 'gpt-5.5-mini' }, 'model')
    expect(picked).toEqual({ effort: 'high', '~service': 'openai\u0000gpt-5.5-mini' })
    expect(servicePick(services, codex, picked)).toEqual({ providerId: 'openai', model: 'gpt-5.5-mini' })
    expect(withServicePick(picked, undefined)).toEqual({ effort: 'high' })
    expect(servicePick(services, codex, { '~service': 'deepseek\u0000deepseek-chat' })).toEqual({
      providerId: 'deepseek',
      model: 'deepseek-chat',
    })
    // A model the service does not list, the demo model and the built-in Harness are no pick.
    expect(servicePick(services, codex, { '~service': 'openai\u0000gone' })).toBeUndefined()
    expect(servicePick(services, codex, { '~service': 'demo\u0000demo' })).toBeUndefined()
    expect(servicePick(services, services.harnesses[0], { '~service': 'openai\u0000gpt-5.5' })).toBeUndefined()

    expect(resolveChoice(services, { harnessId: 'codex', config: picked })).toMatchObject({
      harnessId: 'codex',
      config: { '~service': 'openai\u0000gpt-5.5-mini' },
    })
    expect(resolveChoice(services, { harnessId: 'codex', config: { '~service': 'deepseek\u0000deepseek-chat' } }).config).toEqual({
      '~service': 'deepseek\u0000deepseek-chat',
    })
    // Another Harness never inherits it: the pick stays with Codex's own.
    const away = resolveChoice(services, { harnessId: 'standard', otherPicks: { codex: picked! } })
    expect(away.config).toBeUndefined()
    expect(away.model).toEqual({ providerId: 'deepseek', model: 'deepseek-chat' })
  })
})
