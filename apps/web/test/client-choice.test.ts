import { createElement } from 'react'
import { testHarness } from '@latch/testkit'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, HostCatalog, TaskSummary } from '@latch/protocol'
import { readPending, submissionRequest, writePending, type PendingSubmission } from '../src/core/api.ts'
import { workspaceSections } from '../src/components/Pickers.tsx'
import { workspaceOptions } from '../src/components/pickerOptions.tsx'
import {
  engineEntries,
  forkedChoice,
  noProjectLine,
  needsProject,
  nothingInstalled,
  presetsToAdd,
  projectFor,
  resolveChoice,
  draftStart,
  startableWorkspaces,
  startBlock,
  usesDemoModel,
  isPinnedChoice,
  pinnedChoice,
  type ComposerChoice,
  type DraftPick,
} from '../src/composerChoice.ts'
import { GeneralSettings } from '../src/settings/GeneralSettings.tsx'

function catalog(overrides: Partial<HostCatalog> = {}): HostCatalog {
  return {
    harnesses: [
      testHarness('standard', { kind: 'builtin', label: 'Latch 内置' }),
      testHarness('codex', { kind: 'agent', label: 'Codex' }),
      testHarness('pi', { kind: 'agent', label: 'pi', status: 'unavailable', statusMessage: '未找到命令 pi-acp' }),
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
    expect(forkedChoice(hostChosen, null, { ...borrowed, mode: 'agent' })).toMatchObject({ mode: 'agent' })
    expect(forkedChoice(catalog(), null, { ...borrowed, mode: 'chat' })).toMatchObject({ mode: 'chat' })
    expect(forkedChoice(hostChosen, null, { ...borrowed, harnessId: 'codex', mode: 'chat' })).toMatchObject({ mode: 'agent' })
  })

  it('says what 不选项目 does for this Harness', () => {
    expect(noProjectLine({ modes: ['chat', 'agent'] })).toBe('不读写文件，不运行命令')
    expect(noProjectLine({ modes: ['agent'] })).toBe('在一个新的空文件夹里开始')
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

  it('asks for a folder only when a Harness has none and the Host would make one up', () => {
    const local = { legacy: false, local: true }
    const hostChosen = catalog({ sessionFolders: true, workspaces: catalog().workspaces.filter(item => item.id === 'default') })
    const choice = resolveChoice(hostChosen, { harnessId: 'codex' })
    expect(needsProject(hostChosen, choice)).toBe(true)
    expect(needsProject(hostChosen, { ...choice, projectSkipped: true })).toBe(false)
    expect(needsProject(hostChosen, resolveChoice(hostChosen, { harnessId: 'standard' }))).toBe(false)
    // A start directory the owner set is a folder in mind.
    expect(needsProject({ ...hostChosen, sessionFolders: undefined }, choice)).toBe(false)
    // 不选项目 is remembered; anything else leaves the question open.
    expect(resolveChoice(hostChosen, { workspaceId: 'default', projectSkipped: true }).projectSkipped).toBe(true)
    expect(resolveChoice(hostChosen, { workspaceId: 'default' }).projectSkipped).toBeUndefined()
  })

  it('takes a saved project when nothing was chosen and the Host would otherwise make a folder', () => {
    const start = catalog().workspaces[0]!
    const saved = { ...start, id: 'rust', name: 'rust-learn', path: '/tmp/rust-learn' }
    const both = catalog({ sessionFolders: true, workspaces: [start, saved] })
    expect(resolveChoice(both, null).workspaceId).toBe('rust')
    expect(resolveChoice(both, { workspaceId: 'default', projectSkipped: true }).workspaceId).toBe('default')
    expect(resolveChoice(catalog({ workspaces: [start, saved] }), null).workspaceId).toBe('default')
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
    expect(presetsToAdd(catalog()).map(preset => preset.id)).toEqual(['opencode', 'dsh', 'gemini', 'qwen', 'goose'])
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
    // A configured service the Host holds back is named, with what it lacks, instead of asking for another service.
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
      hint: '在 Mac 上，打开 设置 › 模型 确认地址后即可开始。',
      action: '打开模型服务',
    })
    const keyless = catalog({ providers: [], unusableProviders: [{ id: 'deepseek', name: 'DeepSeek', reason: 'key-missing' }] })
    expect(startBlock(snapshot({ catalog: keyless }), resolveChoice(keyless, standard))).toMatchObject({
      message: '还没有可用的模型服务。「DeepSeek」还没有填写密钥。',
      hint: '在 Mac 上，打开 设置 › 模型 填写密钥后即可开始。',
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

  it('starts a personal conversation using its profile without leaking ordinary composer overrides', () => {
    const assistantId = 'asst_11111111-1111-4111-8111-111111111111'
    expect(
      submissionRequest({
        requestId: 'r1',
        prompt: '你好',
        assistantId,
        mode: 'agent',
        workspaceId: 'other',
        harnessId: 'other',
        model: { providerId: 'other', model: 'other' },
      }),
    ).toEqual({
      path: 'tasks',
      body: { requestId: 'r1', prompt: '你好', assistantId },
    })
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    })
    const submission = { requestId: 'r1', prompt: '你好', assistantId }
    writePending('personal', submission)
    expect(readPending('personal')).toEqual(submission)
    writePending('personal', { ...submission, workspaceId: 'other' })
    expect(readPending('personal')).toBeNull()
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
    }
    expect(submissionRequest(submission).body).toMatchObject({ attachmentIds: submission.attachmentIds, fileRefs: submission.fileRefs })
    writePending('k', submission)
    expect(readPending('k')).toEqual(submission)
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
    expect(entries[0]?.disabledReason).toContain('最多使用 1 个')
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
    expect(presetsToAdd(more).map(preset => preset.id)).toEqual(['codex', 'pi', 'dsh', 'gemini', 'qwen', 'goose'])
    expect(presetsToAdd(undefined)).toHaveLength(7)
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
