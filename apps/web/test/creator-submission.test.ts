// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { AppSnapshot, HarnessInfo, HostCatalog } from '@latch/protocol'
import { draftConfig, servicePick, writeChoice } from '../src/composerChoice.ts'
import { readPending, submissionRequest, writePending, type PendingSubmission } from '../src/core/api.ts'
import { useSubmission } from '../src/hooks/useSubmission.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

it.each([false, true])(
  'shows an uncertain creator’s launch choices after reload and retries the same request after revocation (routed=%s)',
  async routed => {
    const pinned = { providerId: 'service', model: 'pinned', effort: 'low' }
    const picked = { providerId: 'service', model: 'picked', ...(routed ? {} : { effort: 'high' }) }
    const builtIn: HarnessInfo = {
      id: 'pin',
      status: 'ready',
      modes: ['agent', 'chat'],
      level: 'L1',
      capabilities: {
        models: { owner: 'latch', catalogue: 'live', wires: ['chat-completions'] },
        permission: { enforcement: 'latch', rejectionNote: true },
        tools: { shell: false, fileMentions: true },
        display: { label: 'Pin', mark: 'latch' },
      },
    }
    const creator: HarnessInfo = {
      ...builtIn,
      id: 'creator',
      pluginCreation: true,
      capabilities: routed
        ? { ...builtIn.capabilities, models: { owner: 'harness', catalogue: 'session-check', wires: ['chat-completions'] } }
        : builtIn.capabilities,
      serviceOptions: [
        {
          providerId: picked.providerId,
          model: picked.model,
          source: 'declared',
          options: [
            {
              id: 'reasoning',
              name: 'Thinking',
              category: 'thought_level',
              currentValue: 'low',
              options: [
                { name: 'Low', value: 'low' },
                { name: 'High', value: 'high' },
              ],
            },
          ],
        },
      ],
    }
    const catalog: HostCatalog = {
      defaults: { harnessId: 'pin', mode: 'agent', workspaceId: 'default', model: pinned, pinned: true },
      harnesses: [builtIn, creator],
      providers: [
        {
          id: 'service',
          name: 'Service',
          kind: 'openai-compatible',
          models: ['pinned', 'picked'],
          defaultModel: 'pinned',
          modelCapabilities: { pinned: { thinking: ['low'] }, picked: { thinking: ['high'] } },
        },
      ],
      workspaces: [
        { id: 'default', name: 'Default', path: '/test/default' },
        { id: 'ordinary', name: 'Ordinary', path: '/test/ordinary' },
      ],
      sessionFolders: true,
    }
    const snapshot: AppSnapshot = {
      instanceId: 'host',
      device: {
        id: 'device',
        name: 'Mac',
        status: 'active',
        listener: 'unix',
        scopes: ['view', 'run', 'admin'],
        dataScope: 'all',
        fingerprint: '',
        createdAt: '',
        lastSeenAt: '',
        credentialExpiresAt: '',
        pairedBy: { method: 'lpc' },
        current: true,
        renewAfter: '',
      },
      host: { hostId: 'host', devMode: false, presence: { status: 'available' }, tls: null },
      tasks: [],
      approvals: [],
      demo: false,
      hostName: 'Mac',
      catalog,
    }
    const pending: PendingSubmission = {
      requestId: 'original',
      prompt: 'make a plugin',
      mode: 'agent',
      harnessId: 'creator',
      pluginCreation: true,
      model: picked,
      ...(routed ? { config: [{ configId: 'reasoning', value: 'high' }] } : {}),
    }
    const pendingKey = `latch.pending.${location.origin}.${snapshot.device.id}`
    writePending(pendingKey, pending)
    writeChoice(snapshot.device.id, { mode: 'agent', workspaceId: 'ordinary' })
    const request = vi.fn(async (_path: string, _init: RequestInit) => Response.json({ sessionId: 'created' }))
    vi.stubGlobal('fetch', request)

    const select = vi.fn()
    const refresh = vi.fn(async () => {})
    const onSent = vi.fn()
    let submission: ReturnType<typeof useSubmission>
    function Composer({ creating, creatorAllowed }: { creating: boolean; creatorAllowed: boolean }) {
      submission = useSubmission({
        snapshot,
        access: { legacy: false, local: true },
        selectedId: null,
        atStart: () => true,
        creating,
        creatorAllowed,
        select,
        refresh,
        onSent,
      })
      return null
    }
    const root = createRoot(document.createElement('div'))
    const render = (creating: boolean, creatorAllowed: boolean) =>
      act(() => root.render(createElement(Composer, { creating, creatorAllowed })))
    try {
      render(true, true)
      expect(submission!.choice).toMatchObject({ mode: 'agent', harnessId: pending.harnessId, model: picked })
      expect(submission!.choice.workspaceId).toBe('default')
      if (routed) {
        expect(servicePick(catalog, creator, submission!.choice.config)).toEqual(picked)
        expect(draftConfig(creator, submission!.choice.config)?.config[0]?.currentValue).toBe('high')
      }
      expect(submission!.draft).toBe(pending.prompt)
      const retryFromOldRender = submission!.submit

      render(false, false)
      expect(submission!.pending).toBeNull()
      expect(submission!.startingMessage).toBeNull()
      expect(readPending(pendingKey)).toEqual(pending)
      expect(await retryFromOldRender(pending)).toBe(false)
      act(() => submission!.setDraft('ordinary message'))
      await act(async () => {
        expect(await submission!.submit()).toBe(false)
      })
      expect(submission!.error).toBeTruthy()
      expect(submission!.error).not.toContain(pending.prompt)
      expect(request).not.toHaveBeenCalled()

      render(true, true)
      await act(async () => {
        expect(await submission!.submit(submission!.pending!)).toBe(true)
      })
      expect(request).toHaveBeenCalledExactlyOnceWith('/link/api/tasks', expect.anything())
      expect(JSON.parse(request.mock.calls[0]![1].body as string)).toEqual(submissionRequest(pending).body)
      expect(select).toHaveBeenCalledWith('created')
      expect(readPending(pendingKey)).toBeNull()

      render(false, true)
      expect(submission!.choice).toMatchObject({ mode: 'agent', harnessId: 'pin', model: pinned, workspaceId: 'ordinary' })
    } finally {
      act(() => root.unmount())
    }
  },
)
