import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readPending, submissionRequest, writePending, type PendingSubmission } from '../src/client/api.ts'
import { newSessionGroups } from '../src/client/components/ComposerControls.tsx'
import { workspaceSections } from '../src/client/components/Pickers.tsx'
import { resolveChoice, startableWorkspaces, startBlock, usesDemoModel } from '../src/client/composerChoice.ts'
import { GeneralSettings } from '../src/client/settings/GeneralSettings.tsx'
import type { AppSnapshot, HostCatalog } from '../src/shared/types.ts'

function catalog(overrides: Partial<HostCatalog> = {}): HostCatalog {
  return {
    harnesses: [
      { id: 'standard', name: 'Standard', source: 'builtin', status: 'ready', modes: ['chat', 'agent'], models: 'host' },
      { id: 'codex', name: 'Codex', source: 'acp', status: 'ready', modes: ['agent'], models: 'agent' },
      { id: 'pi', name: 'pi', source: 'acp', status: 'unavailable', statusMessage: '未找到命令 pi-acp', modes: ['agent'], models: 'agent' },
    ],
    providers: [
      { id: 'deepseek', name: 'DeepSeek', kind: 'openai-compatible', models: ['deepseek-chat', 'deepseek-reasoner'], defaultModel: 'deepseek-chat' },
      { id: 'local', name: 'Ollama', kind: 'openai-compatible', models: ['qwen3'], defaultModel: 'qwen3' },
    ],
    workspaces: [{ id: 'default', name: 'app', path: '/work/app' }, { id: 'docs', name: 'docs', path: '/work/docs' }],
    defaults: { harnessId: 'standard', mode: 'agent', workspaceId: 'default', model: { providerId: 'deepseek', model: 'deepseek-chat' } },
    ...overrides,
  }
}

function snapshot(extra: Partial<AppSnapshot> = {}): AppSnapshot {
  return { instanceId: 'host', device: { id: 'd', name: 'Mac', status: 'active', listener: 'loopback-tcp', scopes: ['view', 'run', 'approve:standard', 'admin'], dataScope: 'work', fingerprint: 'ABCD EFGH IJKL MNOP QRST', createdAt: '', lastSeenAt: '', credentialExpiresAt: '', pairedBy: { method: 'lpc' }, current: true, renewAfter: '' }, host: { hostId: 'h', devMode: true, presence: { status: 'available' }, tls: null, policy: { localMaxLevel: 'L2', remoteMaxLevel: 'L1', allowL3: true } }, tasks: [], approvals: [], demo: false, hostName: 'host', ...extra }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('composer choice', () => {
  it('keeps only the mode when the Host sends no catalog', () => {
    expect(resolveChoice(undefined, null)).toEqual({ mode: 'agent' })
    expect(resolveChoice(undefined, { mode: 'chat', harnessId: 'x' })).toEqual({ mode: 'chat' })
  })

  it('starts from the Host defaults', () => {
    expect(resolveChoice(catalog(), null)).toEqual({ mode: 'agent', harnessId: 'standard', workspaceId: 'default', model: { providerId: 'deepseek', model: 'deepseek-chat' } })
  })

  it('never picks or offers a workspace the Host disabled for this run', () => {
    const disabled = catalog({
      workspaces: [{ id: 'default', name: 'app', path: '/work/app' }, { id: 'docs', name: 'docs', path: '/work/docs', unavailable: '该目录位于受保护目录（如 .git）内，不能作为项目' }],
      defaults: { harnessId: 'standard', mode: 'agent', workspaceId: 'docs' },
    })
    expect(resolveChoice(disabled, { workspaceId: 'docs' }).workspaceId).toBe('default')
    expect(startableWorkspaces(disabled).map(item => item.id)).toEqual(['default'])
    const offered = workspaceSections(disabled, 'default', () => {}).flatMap(section => section.items.map(item => item.id))
    expect(offered).toEqual(['default'])
    // With one startable workspace left, the phone sheet has no project group to choose from.
    expect(newSessionGroups(disabled, resolveChoice(disabled, null), () => {}, {}).map(group => group.id)).not.toContain('workspace')
    const onlyDisabled = catalog({ workspaces: [{ id: 'docs', name: 'docs', path: '/work/docs', unavailable: 'x' }] })
    expect(resolveChoice(onlyDisabled, { workspaceId: 'docs' })).not.toHaveProperty('workspaceId')
  })

  it('never offers a disabled workspace in the Host defaults, even when it is named as the default', () => {
    const disabled = catalog({
      workspaces: [{ id: 'default', name: '默认工作区', path: '/work/app' }, { id: 'docs', name: 'docs', path: '/work/docs', unavailable: '未通过安全检查' }],
      defaults: { harnessId: 'standard', mode: 'agent', workspaceId: 'docs' },
    })
    const html = renderToStaticMarkup(createElement(GeneralSettings, { snapshot: snapshot({ catalog: disabled }), admin: true, onChanged: () => {} }))
    const project = /<span>项目<\/span><select>(.*?)<\/select>/.exec(html)?.[1]
    expect(project).toBe('<option value="default" selected="">默认工作区</option>')
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
    expect(resolveChoice(catalog(), { model: { providerId: 'deepseek', model: 'retired' } }).model).toEqual({ providerId: 'deepseek', model: 'deepseek-chat' })
    // An agent-managed harness carries no host model, and only accepts its own modes.
    expect(resolveChoice(catalog(), { harnessId: 'codex', mode: 'chat', model: { providerId: 'local', model: 'qwen3' } })).toEqual({ mode: 'agent', harnessId: 'codex', workspaceId: 'default' })
  })

  it('falls back to the first configured model when the default is missing', () => {
    const next = catalog({ defaults: { harnessId: 'standard', mode: 'chat', workspaceId: 'default' } })
    expect(resolveChoice(next, null).model).toEqual({ providerId: 'deepseek', model: 'deepseek-chat' })
  })

  it('explains why a new session cannot start', () => {
    expect(startBlock(snapshot({ catalog: catalog() }), resolveChoice(catalog(), null))).toBeNull()
    expect(startBlock(snapshot({ catalog: catalog({ providers: [] }) }), resolveChoice(catalog({ providers: [] }), null))).toMatchObject({ kind: 'model-required' })
    // Agent harnesses bring their own models.
    expect(startBlock(snapshot({ catalog: catalog({ providers: [] }) }), resolveChoice(catalog({ providers: [] }), { harnessId: 'codex' }))).toBeNull()
    const onlyUnavailable = catalog({ harnesses: [catalog().harnesses[2]!], defaults: { harnessId: 'pi', mode: 'agent', workspaceId: 'default' } })
    expect(startBlock(snapshot({ catalog: onlyUnavailable }), resolveChoice(onlyUnavailable, null))).toEqual({ kind: 'harness-unavailable', message: '未找到命令 pi-acp' })
    expect(startBlock(snapshot({ execution: { ready: false, modelConfigurationRequired: true } }), { mode: 'agent' })).toMatchObject({ kind: 'model-required' })
    expect(startBlock(snapshot({ execution: { ready: false } }), { mode: 'agent' })).toMatchObject({ kind: 'harness-unavailable' })
  })
})

describe('pending submissions', () => {
  it('replays the full create body, including harness, model and project', () => {
    const submission: PendingSubmission = { requestId: 'r1', prompt: '你好', mode: 'chat', harnessId: 'standard', workspaceId: 'docs', model: { providerId: 'local', model: 'qwen3' } }
    expect(submissionRequest(submission)).toEqual({ path: 'tasks', body: { prompt: '你好', requestId: 'r1', mode: 'chat', harnessId: 'standard', model: { providerId: 'local', model: 'qwen3' }, workspaceId: 'docs' } })
  })

  it('keeps the legacy create body when the Host has no catalog', () => {
    expect(submissionRequest({ requestId: 'r1', prompt: 'x' })).toEqual({ path: 'tasks', body: { prompt: 'x', requestId: 'r1', mode: 'agent' } })
  })

  it('sends a model switch only with the prompt that asked for it', () => {
    expect(submissionRequest({ requestId: 'r2', prompt: 'y', sessionId: 'a/b' })).toEqual({ path: 'tasks/a%2Fb/prompt', body: { prompt: 'y', requestId: 'r2' } })
    expect(submissionRequest({ requestId: 'r3', prompt: 'z', sessionId: 's', model: { providerId: 'p', model: 'm' } }).body).toEqual({ prompt: 'z', requestId: 'r3', model: { providerId: 'p', model: 'm' } })
  })

  it('stores and validates the submission in browser storage', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) }, removeItem: (key: string) => { store.delete(key) } })
    const submission: PendingSubmission = { requestId: 'r1', prompt: 'p', mode: 'agent', harnessId: 'codex', workspaceId: 'docs', model: { providerId: 'x', model: 'y' } }
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
