import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, HostCatalog, TaskSummary } from '@latch/protocol'
import { readPending, submissionRequest, writePending, type PendingSubmission } from '../src/core/api.ts'
import { workspaceSections } from '../src/components/Pickers.tsx'
import { workspaceOptions } from '../src/components/pickerOptions.tsx'
import {
  harnessEntries,
  presetsToAdd,
  projectFor,
  resolveChoice,
  startableWorkspaces,
  startBlock,
  usesDemoModel,
} from '../src/composerChoice.ts'
import { GeneralSettings } from '../src/settings/GeneralSettings.tsx'

function catalog(overrides: Partial<HostCatalog> = {}): HostCatalog {
  return {
    harnesses: [
      { id: 'standard', name: 'Standard', source: 'builtin', status: 'ready', modes: ['chat', 'agent'], models: 'host' },
      { id: 'codex', name: 'Codex', source: 'acp', status: 'ready', modes: ['agent'], models: 'agent' },
      { id: 'pi', name: 'pi', source: 'acp', status: 'unavailable', statusMessage: '未找到命令 pi-acp', modes: ['agent'], models: 'agent' },
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
      policy: { localMaxLevel: 'L2', remoteMaxLevel: 'L1', allowL3: true },
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

  it('starts from the Host defaults', () => {
    expect(resolveChoice(catalog(), null)).toEqual({
      mode: 'agent',
      harnessId: 'standard',
      workspaceId: 'default',
      model: { providerId: 'deepseek', model: 'deepseek-chat' },
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

  it('orders usable harness choices before blocked ones and offers unadded presets separately', () => {
    const browser = harnessEntries(catalog(), { legacy: false, local: false })
    expect(browser.map(option => [option.harness.id, option.mode, option.note ?? null])).toEqual([
      ['standard', 'agent', 'Agent'],
      ['standard', 'chat', '只对话'],
      ['codex', 'agent', '仅本机桌面端'],
      ['pi', 'agent', '不可用'],
    ])
    expect(browser.find(option => option.harness.id === 'pi')?.disabledReason).toBe('未找到命令 pi-acp')
    expect(browser.find(option => option.harness.id === 'codex')?.disabledReason).toBeTruthy()
    expect(presetsToAdd(catalog()).map(preset => preset.id)).toEqual(['opencode', 'dsh', 'gemini', 'qwen', 'goose'])
    const desktop = harnessEntries(catalog(), { legacy: false, local: true })
    expect(desktop.find(option => option.harness.id === 'codex')?.disabledReason).toBeUndefined()
  })

  it('never offers a disabled workspace in the Host defaults, even when it is named as the default', () => {
    const disabled = catalog({
      workspaces: [
        { id: 'default', name: '默认工作区', path: '/work/app' },
        { id: 'docs', name: 'docs', path: '/work/docs', unavailable: '未通过安全检查' },
      ],
      defaults: { harnessId: 'standard', mode: 'agent', workspaceId: 'docs' },
    })
    const html = renderToStaticMarkup(
      createElement(GeneralSettings, { snapshot: snapshot({ catalog: disabled }), admin: true, onChanged: () => {} }),
    )
    // The only project left to offer, the start directory (named so in settings): the picker shows it as plain text,
    // without a menu of others.
    const project = /<span class="sr-only">项目：<\/span>(.*?)<\/span><\/span><\/span>/.exec(html)?.[1]
    expect(project).toBe('<span class="ui-value-picker-value"><span class="ui-value-picker-text" data-shown="">启动目录')
    expect(html).not.toContain('docs')
  })

  it('keeps a valid remembered choice', () => {
    const stored = { mode: 'chat' as const, harnessId: 'standard', workspaceId: 'docs', model: { providerId: 'local', model: 'qwen3' } }
    expect(resolveChoice(catalog(), stored)).toEqual(stored)
  })

  it('repairs a choice the Host no longer supports instead of failing at submit time', () => {
    expect(resolveChoice(catalog(), { harnessId: 'pi', mode: 'agent' }).harnessId).toBe('standard')
    expect(resolveChoice(catalog(), { harnessId: 'gone' }).harnessId).toBe('standard')
    expect(resolveChoice(catalog(), { workspaceId: 'removed' }).workspaceId).toBe('default')
    expect(resolveChoice(catalog(), { model: { providerId: 'deepseek', model: 'retired' } }).model).toEqual({
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
    expect(resolveChoice(next, null).model).toEqual({ providerId: 'deepseek', model: 'deepseek-chat' })
  })

  it('explains why a new session cannot start', () => {
    expect(startBlock(snapshot({ catalog: catalog() }), resolveChoice(catalog(), null))).toBeNull()
    expect(startBlock(snapshot({ catalog: catalog({ providers: [] }) }), resolveChoice(catalog({ providers: [] }), null))).toMatchObject({
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
    expect(startBlock(snapshot({ catalog: held }), resolveChoice(held, null))).toEqual({
      kind: 'model-required',
      message: 'Standard 需要一个模型服务。「Ollama\\u{202E}」的地址还没有确认。',
      hint: '在运行 Latch 的电脑上，打开 设置 › 模型服务 确认地址后即可开始。',
      action: '打开模型服务',
    })
    const keyless = catalog({ providers: [], unusableProviders: [{ id: 'deepseek', name: 'DeepSeek', reason: 'key-missing' }] })
    expect(startBlock(snapshot({ catalog: keyless }), resolveChoice(keyless, null))).toMatchObject({
      message: 'Standard 需要一个模型服务。「DeepSeek」还没有填写密钥。',
      hint: '在运行 Latch 的电脑上，打开 设置 › 模型服务 填写密钥后即可开始。',
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
      message: '未找到命令 pi-acp',
    })
    expect(startBlock(snapshot({ execution: { ready: false, modelConfigurationRequired: true } }), { mode: 'agent' })).toMatchObject({
      kind: 'model-required',
    })
    expect(startBlock(snapshot({ execution: { ready: false } }), { mode: 'agent' })).toMatchObject({ kind: 'harness-unavailable' })
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
    }
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
const task = (cwd?: string): TaskSummary => ({ id: 't', title: '', status: 'idle', updatedAt: '', ...(cwd ? { cwd } : {}) })

describe('harness entries', () => {
  const browser = { legacy: false, local: false }
  const desktop = { legacy: false, local: true }

  it('offers the built-in harness as Agent and as conversation only, usable ones first and the rest with why', () => {
    const entries = harnessEntries(catalog(), browser)
    expect(entries.map(entry => [entry.label, entry.mode, entry.note, entry.disabledReason])).toEqual([
      ['Latch 内置', 'agent', 'Agent', undefined],
      ['Latch 内置', 'chat', '只对话', undefined],
      ['Codex', 'agent', '仅本机桌面端', '仅本机桌面端'],
      ['pi', 'agent', '不可用', '未找到命令 pi-acp'],
    ])
    expect(entries[1]?.description).toBe('不读写文件、不运行命令')
    // On the computer that runs Latch, the full-access agent can start; its line says what it is, not a warning.
    const local = harnessEntries(catalog(), desktop)
    expect(local.map(entry => [entry.label, entry.note, entry.fullAccess])).toEqual([
      ['Latch 内置', 'Agent', false],
      ['Latch 内置', '只对话', false],
      ['Codex', '完全访问', true],
      ['pi', '不可用', true],
    ])
    expect(new Set(local.map(entry => entry.key)).size).toBe(local.length)
  })

  it('offers only the presets no agent was added from yet', () => {
    expect(presetsToAdd(catalog()).map(preset => preset.id)).not.toContain('codex')
    expect(presetsToAdd(catalog()).map(preset => preset.id)).not.toContain('pi')
    const more = catalog({
      harnesses: [
        { id: 'standard', name: 'Standard', source: 'builtin', status: 'ready', modes: ['chat', 'agent'], models: 'host' },
        { id: 'opencode-2', name: 'OpenCode', source: 'acp', status: 'ready', modes: ['agent'], models: 'agent' },
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
