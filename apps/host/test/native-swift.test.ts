import { execFileSync, spawn } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  ascii,
  concat,
  encodeFrame,
  field,
  WebSocketParser,
  decodeMessage,
  uint,
  knock,
  serverBinding,
  routeId,
  encodeAddressBook,
  addressBookSigningInput,
  issuePass,
  decodeAddressBook,
  decodeRelayAuthority,
  decodeRelayDirectory,
  encodeRelayAuthority,
  encodeRelayDirectory,
  encodeSignedRelayDirectory,
  encodeDirectorySource,
  relayAuthorityInput,
  relayDirectoryInput,
  directoryEpochInput,
  formatPairingPayload,
  gatewayHash,
  invitationCode,
  parsePairingPayload,
  verifyProof,
  hex,
} from '@latch/link-wire'
import { nodeCrypto } from '@latch/link-client/crypto'
import { FAKE_ACP_AGENT, fakeConversation, swiftFixturePath, testHarness, writeFakeHistory } from '@latch/testkit'
import {
  AGENT_PRESETS,
  BUILTIN_HELPER_CARD,
  NOT_ACCEPTED_5XX,
  pairRoute,
  type AppSnapshot,
  type TaskDetail,
  type CustomAgent,
  type HarnessInfo,
  type HostCatalog,
} from '@latch/protocol'
import { startTestHost } from './helpers/host.ts'
import { startNativeHost } from '../src/native.ts'
import { loadOrCreateHostIdentity } from '../src/identity.ts'
import { base32 } from '../src/crypto.ts'
import { shapeContent, textShape } from '../src/files/edit.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
/** Every request the Hosts' native listeners received, by the device that sent it, as the Host saw it. */
const nativeSeen = vi.hoisted(() => [] as Array<{ deviceId: string; method: string; path: string }>)
/** `METHOD path` of requests the native listener answers 503 once without passing on: a write the Host never saw. */
const nativeDrop = vi.hoisted(() => new Set<string>())
const nativeReadFaults = vi.hoisted(() => new Map<string, Array<{ status: number; code: string }>>())
const nativeEventFaults = vi.hoisted(() => [] as Array<'end' | 'server' | 'transport' | 'metadata' | 'invalid'>)
const nativeMalformedSuccess = vi.hoisted(() => new Set<string>())
/** Replaces successful bodies only after the real Host authorizes the route, for native protocol-ordering fixtures. */
const nativeBodyScripts = vi.hoisted(
  () =>
    new Map<
      string,
      {
        details: unknown[]
        streams: string[][]
        opened: Array<{ delta: string | string[] | undefined; resume: boolean }>
        closed: number
        deviceId?: string
        snapshotDelay?: number
        snapshotFailures?: number
        snapshotReads?: number
        delays?: number[]
        frameInterval?: number
        beforeSnapshot?: (deviceId: string) => Promise<void>
        closedBeforeData?: boolean[]
        delayedMetadata?: { started: number; delivered: number }
      }
    >(),
)
vi.mock('../src/native.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/native.ts')>()
  return {
    ...actual,
    startNativeHost: (options: Parameters<typeof actual.startNativeHost>[0]) =>
      actual.startNativeHost({
        ...options,
        async handler(req, res, opening) {
          nativeSeen.push({ deviceId: opening.deviceId, method: req.method ?? '', path: req.url ?? '' })
          const key = `${req.method ?? ''} ${req.url ?? ''}`
          if (nativeMalformedSuccess.has(key)) {
            const end = res.end.bind(res)
            res.end = ((...args: Parameters<typeof res.end>) => {
              if (res.statusCode >= 200 && res.statusCode < 300 && nativeMalformedSuccess.delete(key)) return end('{"id":"malformed"}')
              return end(...args)
            }) as typeof res.end
          }
          const url = new URL(req.url ?? '/', 'https://fixture.invalid')
          const selected = url.pathname === '/link/api/events' ? url.searchParams.get('sessionId') : url.pathname.split('/').at(-1)
          const script = selected ? nativeBodyScripts.get(selected) : undefined
          const metadataScript =
            url.pathname === '/link/api/snapshot'
              ? [...nativeBodyScripts.values()].find(
                  value =>
                    value.deviceId === opening.deviceId
                    && (value.snapshotDelay || value.beforeSnapshot || value.snapshotFailures !== undefined),
                )
              : undefined
          if (metadataScript?.snapshotFailures !== undefined) {
            metadataScript.snapshotReads = (metadataScript.snapshotReads ?? 0) + 1
            if (metadataScript.snapshotFailures-- > 0) {
              res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"unavailable"}')
              return
            }
          }
          if (metadataScript?.beforeSnapshot) {
            const before = metadataScript.beforeSnapshot
            metadataScript.beforeSnapshot = undefined
            await before(opening.deviceId)
          }
          if (metadataScript) {
            const end = res.end.bind(res)
            res.end = ((...args: Parameters<typeof res.end>) => {
              if (res.statusCode !== 200) return end(...args)
              const count = (metadataScript.delayedMetadata ??= { started: 0, delivered: 0 })
              count.started++
              const timer = setTimeout(() => {
                if (!res.destroyed) {
                  count.delivered++
                  end(...args)
                }
              }, metadataScript.snapshotDelay)
              res.once('close', () => clearTimeout(timer))
              return res
            }) as typeof res.end
          }
          if (script && req.method === 'GET') {
            if (url.pathname === '/link/api/events') {
              const write = res.write.bind(res)
              const writeHead = res.writeHead.bind(res)
              const delay = script.delays?.shift() ?? 0
              let head: Parameters<typeof res.writeHead> | undefined
              if (delay)
                res.writeHead = ((...args: Parameters<typeof res.writeHead>) => {
                  if (args[0] !== 200) return writeHead(...args)
                  head = args
                  res.statusCode = 200
                  return res
                }) as typeof res.writeHead
              let sent = false
              let delivered = false
              const timers: Array<ReturnType<typeof setTimeout>> = []
              res.write = ((...args: Parameters<typeof res.write>) => {
                if (res.statusCode !== 200) return write(...args)
                if (!sent) {
                  sent = true
                  script.deviceId = opening.deviceId
                  script.opened.push({ delta: req.headers['x-latch-state'], resume: url.searchParams.has('resumeAfter') })
                  const frames = script.streams.shift() ?? []
                  frames.forEach((frame, index) =>
                    timers.push(
                      setTimeout(
                        () => {
                          if (!res.destroyed) {
                            if (head) {
                              writeHead(...head)
                              head = undefined
                            }
                            delivered = true
                            write(frame)
                          }
                        },
                        delay + index * (script.frameInterval ?? 10),
                      ),
                    ),
                  )
                }
                return true
              }) as typeof res.write
              res.once('close', () => {
                script.closed++
                ;(script.closedBeforeData ??= []).push(!delivered)
                timers.forEach(clearTimeout)
              })
            } else if (url.pathname === `/link/api/tasks/${selected}`) {
              const end = res.end.bind(res)
              res.end = ((...args: Parameters<typeof res.end>) => {
                if (res.statusCode === 200)
                  return end(JSON.stringify(script.details.length > 1 ? script.details.shift() : script.details[0]))
                return end(...args)
              }) as typeof res.end
            }
          }
          const eventFault = key.startsWith('GET /link/api/events') ? nativeEventFaults.shift() : undefined
          if (eventFault) {
            if (eventFault === 'transport') return opening.close?.()
            if (eventFault === 'metadata' || eventFault === 'invalid')
              nativeReadFaults.set('GET /link/api/snapshot', [{ status: eventFault === 'metadata' ? 503 : 200, code: 'fixture-read' }])
            res
              .writeHead(eventFault === 'server' ? 500 : 200, {
                'content-type': eventFault === 'server' ? 'application/json' : 'text/event-stream',
              })
              .end(eventFault === 'server' ? '{}' : ': ended\n\n')
            return
          }
          const readFault = nativeReadFaults.get(key)?.shift()
          if (readFault) {
            res.writeHead(readFault.status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: readFault.code }))
            return
          }
          if (nativeDrop.delete(key)) {
            res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"unavailable","message":"unavailable"}')
            return
          }
          return options.handler(req, res, opening)
        },
      }),
  }
})
let binary = ''
async function invoke(input: unknown, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8' } })
    let output = '',
      diagnostic = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Swift fixture timeout'))
    }, timeoutMs)
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString()
      if (output.length > 1_048_576) child.kill('SIGKILL')
    })
    child.stderr.on('data', (data: Buffer) => {
      diagnostic = (diagnostic + data.toString()).slice(0, 2000)
    })
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', code => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(diagnostic || 'Swift fixture rejected input'))
        return
      }
      try {
        resolve(JSON.parse(output) as Record<string, unknown>)
      } catch {
        reject(new Error('Invalid Swift fixture output'))
      }
    })
    child.stdin.end(JSON.stringify(input))
  })
}

describe.skipIf(process.platform !== 'darwin')('Swift native core interoperability', () => {
  it('selects current native summary facts by Host revision without reviving cached or other-instance bodies', async () => {
    const summary = (title: string, status: string) => ({ id: 'selected', title, status })
    const snapshot = { instanceId: 'host-a', revision: 20, tasks: [summary('list-running', 'running')] }
    const detail = { summary: summary('body-ended', 'idle'), cursor: 1, sync: { instanceId: 'host-a', revision: 21 } }
    const cases = [
      { snapshot, detail },
      { snapshot: { ...snapshot, revision: 22, tasks: [summary('new-run', 'running')] }, detail },
      { snapshot, detail, cached: true },
      { snapshot: { ...snapshot, instanceId: 'host-b' }, detail },
      { snapshot, detail: { ...detail, sync: { instanceId: 'host-a', revision: 20 }, cursor: 999_999 } },
      { snapshot: { ...snapshot, revision: 22 }, detail: { ...detail, cursor: 999_999 } },
      { snapshot: { ...snapshot, tasks: [] }, detail: { ...detail, sync: { instanceId: 'host-b', revision: 99 } } },
      { snapshot, detail: { ...detail, summary: { ...detail.summary, id: 'other' } } },
    ].map(value => ({ ...value, sessionId: 'selected' }))
    expect(await invoke({ operation: 'phoneProjection', currentSummaryCases: cases })).toEqual({
      current: ['body-ended', 'new-run', 'list-running', 'list-running', 'body-ended', 'list-running', 'none', 'list-running'],
    })
    expect(
      await invoke({
        operation: 'phoneProjection',
        bodyAvailability: [
          { ...snapshot, device: { status: 'active', scopes: ['view'] } },
          { ...snapshot, device: { status: 'active', scopes: [] } },
          { ...snapshot, device: { status: 'revoked', scopes: ['view'] } },
          { ...snapshot, device: { status: 'active', scopes: ['view'] }, tasks: [] },
        ],
      }),
    ).toEqual({ allowed: [true, false, false, false] })
  })
  it('projects a delivered body into its existing list row and helper face without fabricating global revision', async () => {
    const summary = (id: string, title: string, status: string) => ({ id, title, status, agent: { customAgentId: 'helper' } })
    const snapshot = {
      instanceId: 'host-a',
      revision: 20,
      tasks: [summary('selected', 'old-running', 'running'), summary('other', 'other', 'idle')],
    }
    const detail = { summary: summary('selected', 'ended', 'idle'), sync: { instanceId: 'host-a', revision: 21 } }
    const cases = [
      { snapshot, detail },
      { snapshot: { ...snapshot, revision: 22 }, detail },
      { snapshot, detail, cached: true },
      { snapshot: { ...snapshot, tasks: [snapshot.tasks[1]] }, detail },
      { snapshot, detail: { ...detail, sync: { instanceId: 'host-b', revision: 99 } } },
    ].map(value => ({ ...value, sessionId: 'selected' }))
    expect(await invoke({ operation: 'phoneProjection', projectedSummaryCases: cases })).toEqual({
      projected: [
        { revision: 20, tasks: ['ended', 'other'], face: 'idle' },
        { revision: 22, tasks: ['old-running', 'other'], face: 'running' },
        { revision: 20, tasks: ['old-running', 'other'], face: 'running' },
        { revision: 20, tasks: ['other'], face: 'idle' },
        { revision: 20, tasks: ['old-running', 'other'], face: 'running' },
      ],
    })
  })
  it('refreshes private Agent metadata after expiry without restoring an obsolete Host or reading intent', async () => {
    expect(await invoke({ operation: 'phonePrivateReopen' })).toEqual({
      rows: [
        { mode: 'topic', events: ['verify', 'snapshot', 'selected-detail'], access: 'ready' },
        { mode: 'list', events: ['verify', 'snapshot', 'selected-detail'], access: 'ready' },
        { mode: 'code', events: ['session:code-session'], access: 'closed' },
        { mode: 'none', events: [], access: 'closed' },
        { mode: 'face-id', events: [], access: 'closed' },
        { mode: 'old-host', events: [], access: 'closed' },
        { mode: 'changed-host', events: ['verify', 'cancelled'], access: 'closed' },
        { mode: 'cancelled', events: ['verify', 'cancelled'], access: 'closed' },
        { mode: 'changed-reading', events: ['verify', 'cancelled'], access: 'closed' },
      ],
    })
  })
  it('matches the shared slash vectors and keeps native command completion scoped, editable and separate from actions', async () => {
    const vectors = JSON.parse(await readFile(join(root, 'packages/testkit/vectors/slash-match-v1.json'), 'utf8')) as {
      cases: Array<{ score: number | null; positions: number[] | null }>
      tokens: Array<{ expect: unknown }>
      actions: Array<{ expect: unknown }>
      initials: Array<{ name: string; expect: string }>
    }
    const result = await invoke({ operation: 'phoneSlash', ...vectors })
    expect(result).toEqual({
      cases: vectors.cases.map(({ score, positions }) => ({ score, positions })),
      tokens: vectors.tokens.map(value => value.expect),
      actions: vectors.actions.map(value => value.expect),
      initials: vectors.initials.map(value => value.expect),
      all200Reachable: true,
      reservedNames: true,
      scopeFiltering: true,
      editableInsertion: true,
      utf16Selection: true,
      staleInsertionRefused: true,
      runningFirstTurn: true,
      closedPendingReadOnly: true,
    })
  })
  it('creates native helper requests from current capabilities while preserving a held request and explicit choices', async () => {
    const standard = {
      ...testHarness('standard', { kind: 'builtin', label: 'Latch' }),
      agentContext: 'private' as const,
      helperCard: BUILTIN_HELPER_CARD,
    }
    const base = testHarness('codex', { label: 'Codex' })
    const codex: HarnessInfo = {
      ...base,
      agentContext: 'first-turn',
      skills: 'server',
      helperCard: AGENT_PRESETS.find(item => item.id === 'codex')!.helperCard,
      capabilities: { ...base.capabilities, models: { ...base.capabilities.models, owner: 'harness', wires: ['responses'] } },
      permission: { approvals: 'prompts', readback: 'mode', modes: ['read-only', 'danger-full-access'], startMode: 'read-only' },
      catalogue: {
        reportedAt: '2026-11-14T00:00:00.000Z',
        source: 'session',
        options: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            currentValue: 'gpt-fixture',
            options: [
              { value: 'gpt-fixture', name: 'Fixture' },
              { value: 'gpt-other', name: 'Other' },
            ],
          },
          {
            id: 'reasoning',
            name: 'Thinking',
            category: 'thought_level',
            currentValue: 'low',
            options: [
              { value: 'low', name: 'Low' },
              { value: 'high', name: 'High' },
            ],
          },
        ],
        perModel: [
          {
            model: 'gpt-other',
            options: [
              {
                id: 'reasoning',
                name: 'Thinking',
                category: 'thought_level',
                currentValue: 'medium',
                options: [{ value: 'medium', name: 'Medium' }],
              },
              {
                id: 'other-format',
                name: 'Format',
                category: 'model_config',
                currentValue: 'plain',
                options: [{ value: 'plain', name: 'Plain' }],
              },
            ],
          },
        ],
      },
    }
    const pi: HarnessInfo = {
      ...testHarness('pi'),
      agentContext: 'first-turn',
      helperCard: AGENT_PRESETS.find(item => item.id === 'pi')!.helperCard,
      permission: { approvals: 'none', readback: 'none' },
    }
    pi.capabilities = { ...pi.capabilities, tools: { ...pi.capabilities.tools, shell: false } }
    const own: HarnessInfo = { ...testHarness('mine', { mark: 'unknown' }), agentContext: 'first-turn' }
    const missing: HarnessInfo = {
      ...testHarness('missing', { status: 'unavailable' }),
      agentContext: 'first-turn',
      statusMessage: 'Fixture command unavailable',
    }
    const providers: HostCatalog['providers'] = [
      {
        id: 'chat',
        name: 'Chat',
        kind: 'openai-compatible',
        models: ['m1'],
        defaultModel: 'm1',
        modelCapabilities: { m1: { thinking: ['low', 'high'] } },
      },
      { id: 'responses', name: 'Responses', kind: 'openai-responses', models: ['gpt-fixture'], defaultModel: 'gpt-fixture' },
      { id: 'anthropic', name: 'Anthropic', kind: 'anthropic', models: ['m2'], defaultModel: 'm2' },
      { id: 'other', name: 'Other', kind: 'plugin', models: ['g1'], defaultModel: 'g1' },
      { id: 'demo', name: 'Demo', kind: 'demo', models: ['demo'], defaultModel: 'demo' },
    ]
    const catalog: HostCatalog = {
      harnesses: [
        codex,
        pi,
        own,
        standard,
        missing,
        { ...codex, id: 'offer', offer: { presetId: 'codex' } },
        { ...own, id: 'no-context', agentContext: undefined },
      ],
      providers,
      workspaces: [{ id: 'project', name: 'Project', path: '/fixture' }],
      defaults: { harnessId: 'codex', mode: 'agent', workspaceId: 'project', model: { providerId: 'chat', model: 'm1' } },
    }
    const cases = [
      { harnessId: 'standard', name: '  Helper  ', description: ' First\nSecond ', instructions: 'Keep this\nverbatim' },
      { harnessId: 'codex', engineOptions: { model: 'gpt-fixture', '~mode': 'danger-full-access' }, chooseAgain: ['codex'] },
      {
        harnessId: 'codex',
        model: { providerId: 'chat', model: 'm1' },
        engineOptions: { '~mode': 'danger-full-access' },
        chooseAgain: ['standard'],
      },
      { harnessId: 'codex', catalogAfter: { ...catalog, harnesses: [{ ...codex, status: 'unavailable' }] } },
      { harnessId: 'no-context' },
      { harnessId: 'offer' },
      { harnessId: 'missing' },
      { harnessId: 'standard', name: '' },
      { harnessId: 'standard', name: '🙂'.repeat(41) },
      { harnessId: 'standard', name: 'before\u202eafter' },
      { harnessId: 'standard', defaultProjectId: 'missing' },
      { harnessId: 'standard', avatar: { kind: 'face', bracket: 'round', eyes: 'dot', hue: 'neutral' } },
      { harnessId: 'codex', model: { providerId: 'other', model: 'g1' } },
      { harnessId: 'codex', model: { providerId: 'chat', model: 'm1', effort: 'high' } },
      { harnessId: 'codex', model: { providerId: 'chat', model: 'm1', effort: 'invented' } },
      { harnessId: 'codex', engineOptions: { '~mode': 'invented' } },
      { harnessId: 'codex', engineOptions: { model: 'invented' } },
      { harnessId: 'codex', model: { providerId: 'chat', model: 'm1' }, engineOptions: { model: 'gpt-fixture' } },
      { harnessId: 'codex', engineOptions: { model: 'gpt-other', reasoning: 'high' } },
      { harnessId: 'codex', engineOptions: { model: 'gpt-other', reasoning: 'medium' } },
      { harnessId: 'standard', engineOptions: { '~mode': 'danger-full-access' } },
    ]
    const created = { id: `agt_${randomUUID()}`, revision: 1, harnessId: 'standard', name: 'A different display name' }
    const nativeDraft = {
      ...created,
      harnessId: 'codex',
      engineOptions: { model: 'gpt-other', reasoning: 'medium', 'other-format': 'plain', '~mode': 'danger-full-access' },
    }
    const result = await invoke({
      operation: 'phoneHelperCreate',
      catalog,
      cases,
      agents: [{ avatar: { hue: 'ink' } }],
      responses: [created, { ...created, id: 'general' }, { ...created, revision: 0 }, { ...created, harnessId: 'foreign' }],
      changes: [
        { agent: nativeDraft, engineOptions: { reasoning: 'medium', 'other-format': 'plain', '~mode': 'danger-full-access' } },
        { agent: nativeDraft, selectNativeModel: null },
        { agent: nativeDraft, selectNativeModel: 'gpt-fixture' },
        { agent: nativeDraft, selectNativeModel: 'unknown' },
      ],
    })
    expect(result.changes).toMatchObject([
      { accepted: false },
      { accepted: true, body: { engineOptions: { '~mode': 'danger-full-access' } } },
      { accepted: true, body: { engineOptions: { model: 'gpt-fixture', '~mode': 'danger-full-access' } } },
      { accepted: false },
    ])
    for (const change of (result.changes as Array<{ body?: { engineOptions: unknown } }>).slice(1, 3)) {
      expect(change.body?.engineOptions).not.toHaveProperty('reasoning')
      expect(change.body?.engineOptions).not.toHaveProperty('other-format')
    }
    expect((result.ready as Array<{ id: string }>).map(item => item.id)).toEqual(['standard', 'codex', 'pi', 'mine'])
    expect(result.waiting).toMatchObject([{ id: 'missing', reason: 'Fixture command unavailable' }])
    expect(result.ready).toMatchObject([
      { unasked: false },
      { abilities: expect.arrayContaining(['memory', 'schedule']) },
      { unasked: true, abilities: ['files'] },
      { abilities: [] },
    ])
    const rows = result.cases as Array<{
      accepted: boolean
      body: Record<string, unknown>
      sameHeldBytes: boolean
      duplicateHeldRefused: boolean
      createdIds: unknown[]
    }>
    expect(rows.map(row => row.accepted)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
      true,
      false,
    ])
    expect(rows[0]).toMatchObject({
      method: 'POST',
      path: '/link/api/custom-agents',
      body: {
        name: 'Helper',
        description: 'First\nSecond',
        instructions: 'Keep this\nverbatim',
        harnessId: 'standard',
        mode: 'agent',
        skills: [],
        avatar: { hue: 'slate' },
      },
      createdIds: [created.id, null, null, null],
    })
    expect(rows[0]!.body).not.toHaveProperty('model')
    expect(rows[0]!.body).not.toHaveProperty('engineOptions')
    expect(rows[0]!.body).not.toHaveProperty('defaultProjectId')
    expect(rows[1]!.body).toMatchObject({ engineOptions: { model: 'gpt-fixture', '~mode': 'danger-full-access' } })
    expect(rows[2]!.body).not.toHaveProperty('model')
    expect(rows[2]!.body).not.toHaveProperty('engineOptions')
    for (const row of rows.filter(row => row.accepted)) expect(row).toMatchObject({ sameHeldBytes: true, duplicateHeldRefused: true })
    const models = result.models as Record<string, Array<{ providerId: string; model: string; experimental: boolean }>>
    for (const harness of [standard, codex, pi, own]) {
      const expected = providers.flatMap(provider => {
        const route = pairRoute(harness.capabilities, provider)
        return ['direct', 'passthrough', 'translate'].includes(route.kind)
          ? provider.models.map(model => ({
              providerId: provider.id,
              model,
              experimental: 'experimental' in route && route.experimental === true,
            }))
          : []
      })
      expect(models[harness.id]).toEqual(
        expected.map(model => ({ ...model, id: Buffer.from(`${model.providerId}\0${model.model}`).toString('base64url') })),
      )
    }
    const knownOnly = {
      ...catalog,
      harnesses: [{ ...codex, capabilities: { ...codex.capabilities, models: { ...codex.capabilities.models, knownOnly: true } } }],
      providers: [
        {
          id: 'chat',
          name: 'Chat',
          kind: 'openai-compatible',
          models: ['vendor/GPT-FIXTURE-20261114', 'unlisted'],
          defaultModel: 'unlisted',
        },
      ],
    }
    const restricted = await invoke({
      operation: 'phoneHelperCreate',
      catalog: knownOnly,
      cases: [
        { harnessId: 'codex', model: { providerId: 'chat', model: 'vendor/GPT-FIXTURE-20261114' } },
        { harnessId: 'codex', model: { providerId: 'chat', model: 'unlisted' } },
      ],
    })
    expect(restricted.cases).toMatchObject([{ accepted: true }, { accepted: false }])
    const composed = 'caf\u00e9',
      decomposed = 'cafe\u0301'
    const unicode = {
      ...catalog,
      harnesses: [standard],
      providers: [{ id: 'chat', name: 'Chat', kind: 'openai-compatible', models: [composed, decomposed], defaultModel: composed }],
    }
    const exact = await invoke({
      operation: 'phoneHelperCreate',
      catalog: unicode,
      cases: [{ harnessId: 'standard', model: { providerId: 'chat', model: decomposed } }],
    })
    const exactModels = (exact.models as Record<string, Array<{ id: string; model: string }>>).standard!
    expect(new Set(exactModels.map(model => model.id)).size).toBe(2)
    expect(exact.cases).toMatchObject([{ accepted: true, body: { model: { model: decomposed } } }])
  })

  it('names native helper activity only from reported work and keeps unread permissions visible', async () => {
    const states = [
      { activity: { phase: 'starting' } },
      { activity: { phase: 'model' }, liveReasoning: 'reasoning' },
      { activity: { phase: 'model' }, liveText: 'answer' },
      { activity: { phase: 'cancelling' } },
      { questions: [{ id: 'q' }] },
      ...['read', 'search', 'fetch', 'edit', 'execute'].map(kind => ({
        activity: { phase: 'tool' },
        messages: [
          { id: 'u', role: 'user', text: 'work' },
          { id: 't', role: 'tool', state: 'running', tool: { kind } },
        ],
      })),
      { activity: { phase: 'tool', toolName: 'browser_open' } },
      { activity: { phase: 'tool', toolName: 'mcp__notes__find' } },
    ]
    const result = await invoke({
      operation: 'phoneHelperCreate',
      speech: states.map(detail => ({ detail })),
    })
    expect((result.speech as Array<{ status: string }>).map(item => item.status)).toEqual([
      '在准备',
      '在想',
      '在回复',
      '在停下',
      '等你点头',
      '在看文件',
      '在找东西',
      '在查资料',
      '在写文件',
      '在跑命令',
      '在看网页',
      '在用 notes',
    ])
    const detail = { summary: { mode: 'agent' }, permission: { level: 'L3', readback: 'mode', expectedMode: 'ask' } }
    const permissions = await invoke({
      operation: 'phoneHelperCreate',
      speech: [
        { detail },
        {
          detail: {
            ...detail,
            config: [{ category: 'mode', currentValue: 'ask' }],
            permission: { ...detail.permission, modeTiers: { ask: { tier: 'ask' } } },
          },
        },
        { detail: { permission: { level: 'L3', approvals: 'none', readback: 'none' } } },
        { detail: { permission: { level: 'L3', approvals: 'prompts', readback: 'none' } } },
      ],
    })
    expect(permissions.speech).toMatchObject([
      { permission: '权限没确认', blocked: true },
      { permission: null, blocked: false },
      { permission: '不先问你', blocked: false },
      { permission: '权限没确认', blocked: false },
    ])
  })
  it('sends a Swift-created helper request to the real Host and resolves retries from its receipt without creating a topic', async () => {
    const host = await startTestHost()
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const snapshot = await owner.json<AppSnapshot>('snapshot')
      expect(snapshot.catalog?.harnesses.find(item => item.id === 'standard')?.helperCard).toEqual(BUILTIN_HELPER_CARD)
      const input = {
        operation: 'phoneHelperCreate',
        catalog: snapshot.catalog,
        cases: [{ harnessId: 'standard', name: 'Native fixture helper' }],
      }
      const drafted = await invoke(input)
      const body = (drafted.cases as Array<{ body: Record<string, unknown> }>)[0]!.body
      const created = await owner.json<CustomAgent>('custom-agents', { method: 'POST', body })
      expect(created).toMatchObject({ name: 'Native fixture helper', harnessId: 'standard', mode: 'agent' })
      const retried = await owner.json<CustomAgent>('custom-agents', { method: 'POST', body })
      expect(retried.id).toBe(created.id)
      const resolved = await invoke({ ...input, responses: [retried] })
      expect(resolved.cases).toMatchObject([{ createdIds: [created.id] }])
      const after = await owner.json<AppSnapshot>('snapshot')
      expect(after.customAgents).toHaveLength(1)
      expect(after.tasks).toHaveLength(0)
      const defaults = await invoke({
        ...input,
        cases: [],
        changes: [
          { agent: created, model: { providerId: 'demo', model: 'demo' } },
          { agent: created, harnessId: 'other' },
          { agent: { ...created, revision: 0 } },
          { agent: { ...created, id: 'general' } },
          { agent: created, project: 'missing' },
        ],
      })
      const changes = defaults.changes as Array<{ accepted: boolean; body: Record<string, unknown> }>
      expect(changes.map(change => change.accepted)).toEqual([true, false, false, false, false])
      expect(Object.keys(changes[0]!.body).sort()).toEqual(['baseRevision', 'defaultProjectId', 'engineOptions', 'model', 'requestId'])
      const updated = await owner.json<CustomAgent>(`custom-agents/${created.id}`, { method: 'PATCH', body: changes[0]!.body })
      expect(updated).toMatchObject({
        revision: created.revision + 1,
        harnessId: 'standard',
        name: created.name,
        model: { providerId: 'demo', model: 'demo' },
      })
      expect(await owner.json(`custom-agents/${created.id}`, { method: 'PATCH', body: changes[0]!.body })).toEqual(updated)
      const stale = await owner.request(`custom-agents/${created.id}`, {
        method: 'PATCH',
        body: { ...changes[0]!.body, requestId: randomUUID() },
      })
      expect(stale.status).toBe(409)
      expect(await stale.json()).toMatchObject({ error: 'agent-changed' })
    } finally {
      await host.close()
    }
  })

  it('keeps a native helper at home by default and refuses a project beyond its Harness folder limit', async () => {
    const catalog = {
      harnesses: [{ ...testHarness('limited'), agentContext: 'first-turn', projectFolders: { access: 'all', max: 1 } }],
      providers: [],
      workspaces: [
        { id: 'default', name: 'Start folder', path: '/fixture' },
        { id: 'single', name: 'Single', folders: [{ id: 'one', path: '/fixture/one' }] },
        {
          id: 'multiple',
          name: 'Multiple',
          folders: [
            { id: 'one', path: '/fixture/one' },
            { id: 'two', path: '/fixture/two' },
          ],
        },
      ],
    }
    const result = await invoke({
      operation: 'phoneHelperCreate',
      catalog,
      cases: ['multiple', 'single', 'default'].map(defaultProjectId => ({ harnessId: 'limited', defaultProjectId })),
    })
    const rows = result.cases as Array<{ accepted: boolean; body: Record<string, unknown> }>
    expect(rows.map(row => row.accepted)).toEqual([false, true, true])
    expect(rows[1]!.body).toHaveProperty('defaultProjectId', 'single')
    expect(rows[2]!.body).not.toHaveProperty('defaultProjectId')
  })

  it('projects the shared task stream vectors without mixing HTTP into the stream shadow or weakening source priority', async () => {
    const vectors = JSON.parse(await readFile(join(root, 'packages/testkit/vectors/task-delta-v1.json'), 'utf8')) as {
      strings: Array<{ bytes: number | null }>
      streams: Array<{ name: string; actions: Array<{ expect: Record<string, unknown>; nativeExpect?: Record<string, unknown> }> }>
    }
    const result = await invoke({ operation: 'taskStreamProjection', ...vectors })
    expect(result.strings).toEqual(vectors.strings.map(value => value.bytes))
    expect(result.priorValuesUnchanged).toBe(true)
    const streams = result.streams as Array<{ name: string; steps: Array<Record<string, unknown>> }>
    expect(streams).toHaveLength(vectors.streams.length)
    for (const [index, vector] of vectors.streams.entries()) {
      expect(streams[index]?.name).toBe(vector.name)
      expect(streams[index]?.steps).toHaveLength(vector.actions.length)
      for (const [step, action] of vector.actions.entries())
        expect(streams[index]!.steps[step], `${vector.name}: ${step}`).toMatchObject(action.nativeExpect ?? action.expect)
    }
  })

  it('keeps native task candidates inside one MiB and rejects old connection tickets without resetting the revision floor', async () => {
    const vectors = JSON.parse(await readFile(join(root, 'packages/testkit/vectors/task-delta-v1.json'), 'utf8')) as {
      streams: Array<{ actions: Array<{ frame: unknown }> }>
    }
    const result = await invoke({
      operation: 'taskStreamBoundary',
      frame: vectors.streams[0]!.actions[0]!.frame,
      delta: vectors.streams[0]!.actions[1]!.frame,
    })
    expect(result.initialBytes).toBeLessThanOrEqual(1_048_576)
    expect(result.oversizedInputBytes).toBeGreaterThan(1_048_576)
    expect(result).toMatchObject({
      inputLimit: 'repair',
      candidateGrowth: 'repair',
      validAfterRefusal: 'detail',
      objectWidthLimit: 'repair',
      combinedSuffixLimit: 'repair',
      priorValueUnchanged: true,
      staleConnectionRejected: true,
      staleHTTPRejectedBeforeDecode: true,
      connectionKeepsRevisionFloor: true,
      newerHTTPAccepted: true,
      otherInstanceRejected: true,
      invalidUTF8Rejected: true,
      surrogateUTF8Rejected: true,
    })
  })

  it('uses the same bounded first-flight bucket grid in Swift without waiting for a future handshake flight', async () => {
    const first = Buffer.from(encodeFrame({ opcode: 2, payload: new Uint8Array([0, 4]) }, new Uint8Array([1, 2, 3, 4]))).toString('hex')
    const second = Buffer.from(encodeFrame({ opcode: 2, payload: new Uint8Array([0, 5]) }, new Uint8Array([1, 2, 3, 4]))).toString('hex')
    const result = await invoke({
      operation: 'outerPadding',
      actions: [
        { time: 0, frames: [first] },
        { time: 39, frames: [second] },
        { time: 40 },
        { time: 40 },
        { time: 80 },
        { time: 3000 },
        { time: 3001 },
      ],
    })
    expect(result.bufferedBytes).toBe(0)
    const batches = (result.batches as string[]).map(value => Buffer.from(value, 'hex'))
    expect(batches.map(value => value.length)).toEqual([4096, 4096, 4096])
    const frames = new WebSocketParser(true).feed(batches[0]!)
    expect(frames.map(value => decodeMessage(value.payload, 2).type)).toEqual(['data', 'data', 'pad'])
    expect(frames.slice(0, 2).map(value => Buffer.from(value.payload).toString('hex'))).toEqual(['0004', '0005'])
  })
  it('keeps the explicit v3 relay profile and outer-padding HMAC bound to the shared wire vector', async () => {
    const vectors = JSON.parse(await readFile(join(root, 'packages/testkit/vectors/link-v1.json'), 'utf8')) as {
      outerRelayV2: { knock: string; serverBinding: string }
      addressBookV3: { issuedAt: number; hostId: string; deviceId: string; generation: number; payloadHash: string }
    }
    const signed = vectors.addressBookV3
    expect(await invoke({ operation: 'addressBook', ...signed, timeMs: signed.issuedAt, profiles: true })).toEqual({
      hostId: signed.hostId,
      deviceId: signed.deviceId,
      generation: signed.generation,
      payloadHash: signed.payloadHash,
      relays: 1,
      profiles: ['outer-pad-v2'],
    })
    const result = await invoke({ ...vectors, operation: 'vectors', binding: 'relay-pad-v2' })
    expect(result.knock).toBe(vectors.outerRelayV2.knock)
    expect(result.serverBinding).toBe(vectors.outerRelayV2.serverBinding)
  })
  it('decodes the v4 edge book and signs and checks the edge identity exchange like link-wire', async () => {
    const vectors = JSON.parse(await readFile(join(root, 'packages/testkit/vectors/link-v1.json'), 'utf8')) as {
      relayId: string
      pass: string
      holderSeed: string
      timeMs: number
      edgeRelay: Record<string, string>
      addressBookV4: {
        encoded: string
        rootSpki: string
        deviceId: string
        issuedAt: number
        hostId: string
        generation: number
        payloadHash: string
      }
    }
    const signed = vectors.addressBookV4
    expect(await invoke({ operation: 'addressBook', ...signed, timeMs: signed.issuedAt, profiles: true, edge: true })).toEqual({
      hostId: signed.hostId,
      deviceId: signed.deviceId,
      generation: signed.generation,
      payloadHash: signed.payloadHash,
      relays: 2,
      profiles: ['outer-pad-v2', 'outer-pad-v2'],
      kinds: ['edge', 'self'],
      relayKeys: [vectors.edgeRelay.relayKey, ''],
      urls: [['https://latch-relay-ne.example.workers.dev/', 'https://ne.relay.example/'], ['https://relay.example/']],
      order: [vectors.relayId, '33'.repeat(16)],
      hostRegion: 'apac-ne',
    })
    const result = await invoke({ ...vectors, operation: 'edgeRelay' })
    expect(result).toMatchObject({ challengeInput: vectors.edgeRelay.challengeInput, verified: true, otherNonce: false, otherKey: false })
    // CryptoKit's Ed25519 signatures are randomized: the Swift proof is checked by the TypeScript verifier instead of by bytes.
    const admission = Buffer.from(String(result.boundAdmission), 'hex')
    const proof = {
      pass: admission.subarray(0, 174),
      timeMs: Number(admission.readBigUInt64BE(174)),
      nonce: admission.subarray(182, 198),
      signature: admission.subarray(198),
    }
    const relayNonce = Buffer.from(vectors.edgeRelay.relayNonce!, 'hex')
    expect(hex(proof.nonce)).toBe(vectors.edgeRelay.proofNonce)
    expect(await verifyProof(nodeCrypto, Buffer.from(vectors.relayId, 'hex'), proof, vectors.timeMs, relayNonce)).not.toBeNull()
    expect(await verifyProof(nodeCrypto, Buffer.from(vectors.relayId, 'hex'), proof, vectors.timeMs)).toBeNull()
  })
  it('keeps both directory floors through encrypted restart, revoked online keys and unknown commits in Swift', async () => {
    const vectors = JSON.parse(await readFile(join(root, 'packages/testkit/vectors/link-v1.json'), 'utf8')) as {
      directory: { authority: string; addresses: string; root: string; now: number }
      addressBook: { encoded: string; payload: string; rootSpki: string; deviceId: string; issuedAt: number }
    }
    const book = decodeAddressBook(Buffer.from(vectors.addressBook.payload, 'hex')),
      authority = decodeRelayAuthority(Buffer.from(vectors.directory.authority, 'hex')),
      online = decodeRelayDirectory(Buffer.from(vectors.directory.addresses, 'hex'))
    authority.nodes[0]!.relayId = book.relays[0]!.relayId
    authority.nodes[0]!.spkiHashes = [book.relays[0]!.spkiHash]
    online.nodes[0]!.relayId = book.relays[0]!.relayId
    async function seal(seed = Buffer.alloc(32, 4)) {
      const root = encodeRelayAuthority(authority)
      online.rootGeneration = authority.generation
      online.rootHash = await nodeCrypto.hash(root)
      const addresses = encodeRelayDirectory(online)
      const bundle = encodeSignedRelayDirectory({
        authority: root,
        directory: addresses,
        rootSignature: await nodeCrypto.sign(Buffer.alloc(32, 3), relayAuthorityInput(root)),
        signature: await nodeCrypto.sign(seed, relayDirectoryInput(addresses)),
      })
      return { bytes: Buffer.from(bundle).toString('hex'), rootHash: online.rootHash, hash: await nodeCrypto.hash(addresses) }
    }
    const first = await seal()
    online.generation = Number.MAX_SAFE_INTEGER
    online.nodes[0]!.addresses = ['1.1.1.1']
    const second = await seal()
    const source = { anchors: [Buffer.from(vectors.directory.root, 'hex')], mirrors: ['https://directory.example/relays-v1.bin'] }
    const freshSource = {
      ...source,
      minimum: { generation: 1, hash: first.rootHash },
      minimumOnline: { generation: Number.MAX_SAFE_INTEGER, hash: second.hash },
    }
    authority.generation++
    authority.revokedKeys = [online.key]
    const revoked = await seal()
    const replacement = Buffer.alloc(32, 5)
    authority.generation++
    authority.keys.push({ ...authority.keys[0]!, publicKey: await nodeCrypto.publicKey(replacement) })
    online.key = await nodeCrypto.publicKey(replacement)
    online.generation = 1
    const reissued = await seal(replacement)
    const cache = {
      book: vectors.addressBook.encoded,
      rootSpki: vectors.addressBook.rootSpki,
      deviceId: vectors.addressBook.deviceId,
      now: vectors.directory.now,
      bookTime: vectors.addressBook.issuedAt,
      source: Buffer.from(encodeDirectorySource(source)).toString('hex'),
      freshSource: Buffer.from(encodeDirectorySource(freshSource)).toString('hex'),
      first: first.bytes,
      second: second.bytes,
      revoked: revoked.bytes,
      reissued: reissued.bytes,
    }
    expect(await invoke({ operation: 'directoryCache', cache })).toEqual({
      unknownStayedClosed: true,
      rootRevocationSurvivedRestart: true,
      freshOfflineReplayRejected: true,
      reissued: true,
      rejected: 4,
    })
    expect(await invoke({ operation: 'directoryResolver', cache })).toEqual({ coalesced: true, revoked: true, cancelled: true })
  })
  it('matches stable directory hints and bounds fragmented HTTP mirror bodies before signatures', async () => {
    const { directoryEpoch: vector } = JSON.parse(await readFile(join(root, 'packages/testkit/vectors/link-v1.json'), 'utf8')) as {
      directoryEpoch: { source: string; hash: string; absentHash: string }
    }
    expect(createHash('sha256').update(directoryEpochInput()).digest('hex')).toBe(vector.absentHash)
    expect(await invoke({ operation: 'directoryEpoch', source: vector.source })).toEqual({
      hash: vector.hash,
      absentHash: vector.absentHash,
    })
    const body = Buffer.from('signed-public-directory-fixture'),
      hash = createHash('sha256').update(body).digest('hex')
    const fixed = Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n`), body])
    const chunked = Buffer.from(
      `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${body.length.toString(16)}\r\n${body.toString()}\r\n0\r\n\r\n`,
    )
    const eof = Buffer.concat([Buffer.from('HTTP/1.0 200 OK\r\n\r\n'), body])
    const valid = [fixed, chunked, eof].flatMap(bytes =>
      [1, 7, 8192].map(fragment => ({ bytes: bytes.toString('hex'), fragment, valid: true, hash })),
    )
    const invalid = [
      'HTTP/1.1 302 Redirect\r\nLocation: https://other.example/\r\n\r\n',
      'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\nab',
      'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\nab',
      'HTTP/1.1 200 OK\r\nContent-Length: 32769\r\n\r\n',
      'HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\n\r\nabc',
      'HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\nshort',
      `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${'1\r\na\r\n'.repeat(1025)}0\r\n\r\n`,
      `HTTP/1.1 200 OK\r\n\r\n${'a'.repeat(32769)}`,
      `HTTP/1.1 200 OK\r\nX-Fill: ${'a'.repeat(8192)}`,
    ].map(value => ({ bytes: Buffer.from(value).toString('hex'), fragment: 8192, valid: false }))
    expect(await invoke({ operation: 'directoryHTTP', cases: [...valid, ...invalid] })).toEqual({
      accepted: valid.length,
      rejected: invalid.length,
    })
  })
  it('matches directory source and opt-in address-book v2 vectors without changing the v1 contract', async () => {
    const vectors = JSON.parse(await readFile(join(root, 'packages/testkit/vectors/link-v1.json'), 'utf8')) as {
      directorySource: { mirrors: string[]; invalidMirrors: string[] }
      directorySourceOnline: { mirrors: string[]; invalidMirrors: string[] }
      addressBookV2: { hostId: string; deviceId: string; generation: number; payloadHash: string; issuedAt: number }
      addressBookV2Online: { hostId: string; deviceId: string; generation: number; payloadHash: string; issuedAt: number }
    }
    expect(await invoke({ operation: 'directorySource', source: vectors.directorySource })).toEqual({
      anchors: 1,
      mirrors: vectors.directorySource.mirrors,
      generation: 1,
      rejected: vectors.directorySource.invalidMirrors.length,
    })
    expect(await invoke({ operation: 'directorySource', source: vectors.directorySourceOnline })).toEqual({
      anchors: 1,
      mirrors: vectors.directorySourceOnline.mirrors,
      generation: 1,
      onlineGeneration: 1,
      rejected: vectors.directorySourceOnline.invalidMirrors.length,
    })
    for (const book of [vectors.addressBookV2, vectors.addressBookV2Online])
      expect(await invoke({ operation: 'addressBook', ...book, timeMs: book.issuedAt })).toEqual({
        hostId: book.hostId,
        deviceId: book.deviceId,
        generation: book.generation,
        payloadHash: book.payloadHash,
        relays: 0,
        directoryAnchors: 1,
      })
  })
  it('verifies the offline directory Root and online address delegation with the shared checkpoint', async () => {
    const { directory } = JSON.parse(await readFile(join(root, 'packages/testkit/vectors/link-v1.json'), 'utf8')) as {
      directory: Record<string, unknown>
    }
    expect(await invoke({ operation: 'directory', directory })).toEqual({
      verified: true,
      rejected: 3,
      rootHash: directory.rootHash,
      hash: directory.hash,
    })
  })
  it('matches padding cells and every fragmented small-cell boundary with the shared wire vector', async () => {
    const { padding } = JSON.parse(await readFile(join(root, 'packages/testkit/vectors/link-v1.json'), 'utf8')) as {
      padding: { payload: string; small: string; largeDummyHash: string }
    }
    expect(await invoke({ operation: 'padding', padding })).toEqual({ small: padding.small, largeDummyHash: padding.largeDummyHash })
  })
  beforeAll(async () => {
    binary = await swiftFixturePath()
  })
  it('matches shared knock, HKDF pairing, P256 verification and recovery vectors using CryptoKit', async () => {
    const vectors = JSON.parse(await readFile(join(root, 'packages/testkit/vectors/link-v1.json'), 'utf8')) as {
      knock: string
      serverBinding: string
      pairing: { knockSecret: string }
      nativeVerification: { text: string; recoverySecret: string }
    }
    expect(await invoke({ ...vectors, operation: 'vectors' })).toEqual({
      knock: vectors.knock,
      serverBinding: vectors.serverBinding,
      knockSecret: vectors.pairing.knockSecret,
      verificationText: vectors.nativeVerification.text,
      recoverySecret: vectors.nativeVerification.recoverySecret,
      verified: true,
    })
    const values = vectors as unknown as Record<string, string | number>
    const bytes = (key: string) => Buffer.from(String(values[key]), 'hex')
    const binding = { path: 'relay' as const, relayId: bytes('relayId'), routeId: await routeId(nodeCrypto, bytes('routePub')) }
    const relay = await invoke({ ...vectors, operation: 'vectors', binding: 'relay' })
    expect(relay.knock).toBe(
      Buffer.from(await knock(nodeCrypto, bytes('knockKey'), binding, Number(values.timeMs), bytes('nonce'))).toString('hex'),
    )
    expect(relay.serverBinding).toBe(
      Buffer.from(await serverBinding(nodeCrypto, bytes('knockKey'), binding, bytes('nonce'), ascii(String(values.certificate)))).toString(
        'hex',
      ),
    )
  })
  it('reads the pairing QR as the shared vectors pin it, and refuses what is not one', async () => {
    const vectors = JSON.parse(await readFile(join(root, 'packages/testkit/vectors/link-v1.json'), 'utf8')) as {
      pairingQr: {
        rootSpki: string
        secret: string
        expiresAt: number
        lan: Array<{ address: string; port: number }>
        code: string
        knockKey: string
        encoded: string
        invalid: unknown[]
      }
    }
    const qr = vectors.pairingQr
    const publicAddress = Buffer.from(qr.encoded, 'hex')
    // The first endpoint's address, made public; the vector's second endpoint is untouched.
    publicAddress.set([8, 8, 8, 8], 114)
    const value = (await invoke({ pairingQr: qr, publicAddress: publicAddress.toString('hex'), operation: 'pairingQr' })) as {
      lan: Array<{ address: string; port: number }>
    } & Record<string, unknown>
    expect(value).toEqual({
      rootSpki: qr.rootSpki,
      secret: qr.secret,
      expiresAt: qr.expiresAt,
      code: qr.code,
      knockKey: qr.knockKey,
      lan: qr.lan,
      rejected: qr.invalid.length,
      oldRefused: true,
      foreignRefused: true,
      expired: true,
      linkRefused: true,
      longRefused: true,
      publicRefused: true,
      recognized: true,
      foreignRecognized: false,
    })
  })
  it('reports a matching gateway hash for a Wi-Fi client and for the phone that is the hotspot, and none off the subnet', async () => {
    const mask = 'fffffff0',
      peer = '172.20.10.2',
      expected = Buffer.from(await gatewayHash(nodeCrypto, peer, 28, '172.20.10.1')).toString('hex')
    const gateway = async (input: Record<string, unknown>) => (await invoke({ operation: 'pairingGateway', peer, ...input })).hash
    expect(await gateway({ interfaces: [{ address: '172.20.10.5', mask }], routers: ['172.20.10.1'] })).toBe(expected)
    // The hotspot itself has no router on that network: it is the router.
    expect(await gateway({ interfaces: [{ address: '172.20.10.1', mask }], routers: ['10.1.2.3'] })).toBe(expected)
    expect(await gateway({ interfaces: [{ address: '192.168.1.5', mask: 'ffffff00' }], routers: ['192.168.1.1'] })).toBeUndefined()
    // IPv6: the router is link-local, outside the prefix, and the Mac hashes that same address.
    const v6Mask = 'ffffffffffffffff0000000000000000'
    const v6 = Buffer.from(await gatewayHash(nodeCrypto, 'fd00::2', 64, 'fe80::1')).toString('hex')
    expect(await gateway({ peer: 'fd00::2', interfaces: [{ address: 'fd00::9', mask: v6Mask }], routers: ['fe80::1'] })).toBe(v6)
  })
  it('accepts a root proof only for the pinned root, nonce, actual transport key and system clock', async () => {
    const rootKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
      transport = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const rootSpki = rootKey.publicKey.export({ format: 'der', type: 'spki' }),
      transportSpki = transport.publicKey.export({ format: 'der', type: 'spki' }),
      nonce = Buffer.alloc(16, 7)
    const before = 1000,
      after = 301_000
    const signed = concat(ascii('latch-host-proof-v1\0'), field(transportSpki), nonce, uint(before, 8), uint(after, 8))
    const signature = sign('sha256', signed, { key: rootKey.privateKey, dsaEncoding: 'ieee-p1363' })
    const proof = Buffer.from(concat(field(rootSpki), uint(before, 8), uint(after, 8), signature)).toString('hex')
    const input = {
      operation: 'hostProof',
      proof,
      rootSpki: rootSpki.toString('hex'),
      transportSpki: transportSpki.toString('hex'),
      nonce: nonce.toString('hex'),
      timeMs: 2000,
    }
    expect(await invoke(input)).toEqual({ verified: true })
    for (const patch of [
      { timeMs: 999 },
      { timeMs: after + 1 },
      { nonce: Buffer.alloc(16, 8).toString('hex') },
      { transportSpki: rootSpki.toString('hex') },
      { rootSpki: transportSpki.toString('hex') },
      { proof: `${proof}00` },
    ])
      await expect(invoke({ ...input, ...patch })).rejects.toThrow('rejected')
  })
  it.each([0, 8])(
    'performs the native lifecycle and recovers a signed tombstone after %i days',
    async days => {
      let offset = 0,
        agedRevocation = false
      const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 }, now: () => Date.now() + offset })
      const readCandidates = host.host.security.devices.nativeTransportCandidates.bind(host.host.security.devices)
      const candidates = vi.spyOn(host.host.security.devices, 'nativeTransportCandidates').mockImplementation(() => {
        if (days && host.host.security.devices.nativeRevocations().length) {
          // Move only Host policy time at the next real transport lookup, after revocation was persisted.
          offset = days * 86400_000
          agedRevocation = true
        }
        return readCandidates()
      })
      let resumeAttempts = 0
      const faulty = await startNativeHost({
        tlsBinary: join(root, 'dist/native/latch-native-tls'),
        identity: await loadOrCreateHostIdentity(host.dataDir),
        devices: host.host.security.devices,
        enrollments: host.host.security.enrollments,
        bind: { host: '127.0.0.1', port: 0 },
        handler(req, res) {
          if (req.url === '/link/api/native/verification/resume') resumeAttempts++
          const revocation = req.url === '/link/api/native/revocation'
          res.writeHead(revocation ? 200 : 503, { 'content-type': 'application/json' })
          res.end(JSON.stringify(revocation ? { revocation: null } : { error: 'temporary-unavailable' }))
        },
      })
      try {
        const response = await (await host.enroll({ listener: 'unix' })).request('native/pairings', { method: 'POST', body: {} })
        const { invitation } = (await response.json()) as { invitation: { payload: string } }
        const payload = parsePairingPayload(invitation.payload)
        const input = {
          port: host.host.nativePort,
          rootSpki: Buffer.from(payload.rootSpki).toString('hex'),
          knockKey: createHash('sha256').update(invitationCode(payload.secret)).digest('hex'),
        }
        expect(await invoke({ ...input, operation: 'nativeProbe' })).toEqual({ status: 401 })
        await writeFile(join(host.workspaceRoot, 'notes.txt'), 'Swift file fixture')
        const requestId = randomUUID()
        expect(await invoke({ ...input, faultPort: faulty.port, payload: invitation.payload, requestId, operation: 'nativePair' })).toEqual(
          {
            paired: true,
            verified: true,
            created: true,
            persistedBeforeComplete: true,
            bookRefreshed: true,
            bookRefreshCoalesced: true,
            epochHintUntrusted: true,
            resumedWithoutSigning: true,
            oldLeaseClosed: true,
            workspace: true,
            events: true,
            streamRequiresWindow: true,
            replayedAfterMetadata: true,
            rootRevocationClosedLease: true,
            files: true,
            pendingCleared: true,
            freeCancel: true,
            fallbackAfterHandshake: true,
            fallbackAfterResumeFailure: true,
            expiredLeafRejected: true,
          },
        )
        expect(agedRevocation).toBe(days > 0)
        candidates.mockRestore()
        offset = 0
        expect(resumeAttempts).toBeGreaterThan(0)
        const owner = await host.enroll({ listener: 'unix' })
        const snapshot = await owner.json<{ tasks: Array<{ id: string }> }>('snapshot')
        expect(snapshot.tasks).toHaveLength(1)
        const detail = await owner.json<{ messages: Array<{ requestId?: string; text: string }> }>(`tasks/${snapshot.tasks[0]!.id}`)
        expect(detail.messages.find(message => message.requestId === requestId)?.text).toBe('Swift native fixture `notes.txt`')
      } finally {
        candidates.mockRestore()
        offset = 0
        await faulty.close()
        await host.close()
      }
    },
    30_000,
  )
  it.each([
    { name: 'accepted recovery', rejectRecovery: false, directRecovery: false, eventFirst: false, lateHead: false, headFailure: '' },
    {
      name: 'rejected reconnect recovery',
      rejectRecovery: true,
      directRecovery: false,
      eventFirst: false,
      lateHead: false,
      headFailure: '',
    },
    {
      name: 'rejected explicit unlock recovery',
      rejectRecovery: true,
      directRecovery: true,
      eventFirst: false,
      lateHead: false,
      headFailure: '',
    },
    {
      name: 'event expiry before the window observer',
      rejectRecovery: false,
      directRecovery: false,
      eventFirst: true,
      lateHead: false,
      headFailure: '',
    },
    {
      name: 'event expiry before the response head',
      rejectRecovery: false,
      directRecovery: false,
      eventFirst: true,
      lateHead: true,
      headFailure: '',
    },
    {
      name: 'a stream closed before its response head',
      rejectRecovery: false,
      directRecovery: false,
      eventFirst: true,
      lateHead: false,
      headFailure: 'closed',
    },
    {
      name: 'a server failure before its response head',
      rejectRecovery: false,
      directRecovery: false,
      eventFirst: true,
      lateHead: false,
      headFailure: 'server',
    },
  ])('expires a restored body lease offline after $name', async ({ rejectRecovery, directRecovery, eventFirst, lateHead, headFailure }) => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    let opening = '',
      until = '',
      signatures = 0,
      recoveries = 0
    const token = `lnw1.${Buffer.alloc(32, 7).toString('base64url')}`
    const faulty = await startNativeHost({
      tlsBinary: join(root, 'dist/native/latch-native-tls'),
      identity: await loadOrCreateHostIdentity(host.dataDir),
      devices: host.host.security.devices,
      enrollments: host.host.security.enrollments,
      bind: { host: '127.0.0.1', port: 0 },
      handler(req, res) {
        if (eventFirst && req.url === '/link/api/events') {
          if (headFailure === 'closed') {
            res.destroy()
            return
          }
          if (headFailure === 'server') {
            res.writeHead(500, { 'content-type': 'application/json' }).end('{}')
            return
          }
          const head = () => {
            res.writeHead(200, { 'content-type': 'text/event-stream' })
            res.write(': heartbeat\n\n')
          }
          if (!lateHead) head()
          const timer = setTimeout(
            () => (lateHead ? head() : res.write(': heartbeat\n\n')),
            Math.max(1, Date.parse(until) - Date.now() + 20),
          )
          res.on('close', () => clearTimeout(timer))
          return
        }
        if (eventFirst && req.url === '/link/api/fixture-probe') {
          res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
          return
        }
        let bytes = 0
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > 8192) req.destroy()
          else chunks.push(chunk)
        })
        req.on('end', () => {
          const input = JSON.parse(Buffer.concat(chunks).toString()) as { appOpenId?: string; proofReceipt?: string }
          let status = 404,
            result: unknown = {}
          if (req.url === '/link/api/native/verification/challenge') {
            opening = input.appOpenId ?? ''
            status = 200
            result = { nonce: 'expiry-fixture-challenge', appOpenId: opening, expiresAt: Date.now() + 60_000, generation: 1 }
          } else if (req.url === '/link/api/native/verification') {
            signatures++
            until = new Date(Date.now() + 1200).toISOString()
            status = (rejectRecovery || eventFirst) && signatures > 1 ? 200 : 503
            if (status === 200) result = { verifiedUntil: until, windowToken: token }
          } else if (
            req.url === '/link/api/native/verification/recover'
            && input.appOpenId === opening
            && input.proofReceipt?.startsWith('lnp1.')
          ) {
            recoveries++
            status = rejectRecovery ? 403 : 200
            if (status === 200) result = { verifiedUntil: until, windowToken: token }
          }
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(result))
        })
      },
    })
    try {
      const response = await (await host.enroll({ listener: 'unix' })).request('native/pairings', { method: 'POST', body: {} })
      const { invitation } = (await response.json()) as { invitation: { payload: string } }
      const payload = parsePairingPayload(invitation.payload)
      expect(
        await invoke({
          operation: 'nativeLeaseExpiry',
          rejectRecovery,
          directRecovery,
          eventFirst,
          headFailure,
          port: faulty.port,
          rootSpki: Buffer.from(payload.rootSpki).toString('hex'),
          knockKey: createHash('sha256').update(invitationCode(payload.secret)).digest('hex'),
        }),
      ).toEqual({
        recoveredWithoutSigning: !rejectRecovery,
        rejectedRecoveryReverified: rejectRecovery,
        expiredWithoutNetwork: true,
        reboundObserverDidNotExtend: true,
        cancelledObserverSettled: true,
        cacheClosed: true,
        ...(headFailure
          ? { eventAction: 'reconnect', eventFailure: 'unavailable', failedStreamKeptWindow: true }
          : eventFirst
            ? {
                eventAction: 'contentExpired',
                eventFailure: 'expired',
                transportUsable: true,
                networkAction: 'reconnect',
                renewedOnSameTransport: true,
                oldWindowCannotCloseNew: true,
                missingWindowCannotCloseNew: true,
              }
            : {}),
      })
      expect(signatures).toBe(rejectRecovery || (eventFirst && !headFailure) ? 2 : 1)
      expect(recoveries).toBe(1)
    } finally {
      await faulty.close()
      await host.close()
    }
  })
  it('sends neither TLS bytes nor its device certificate to an unauthenticated preflight peer', async () => {
    let received = 0
    const server = createServer(socket => {
      let answered = false
      socket.setTimeout(3000, () => socket.destroy())
      socket.on('error', () => undefined)
      socket.on('data', bytes => {
        received += bytes.length
        if (!answered && received >= 32) {
          answered = true
          const body = concat(field(new Uint8Array([1, 2, 3])), new Uint8Array(32))
          socket.write(concat(uint(body.length, 2), body))
        }
        if (received > 4096) socket.destroy()
      })
    })
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('Missing temporary native listener')
      const root = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'der' })
      await expect(
        invoke({
          operation: 'nativeProbe',
          port: address.port,
          rootSpki: root.toString('hex'),
          knockKey: '11'.repeat(32),
          withFixtureIdentity: true,
        }),
      ).rejects.toThrow('rejected')
      expect(received).toBe(32)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
  it('preserves split UTF-8 event bodies and rejects unbounded or malformed SSE', async () => {
    const text = Buffer.from('event: task-state\r\ndata: {"text":"你好"}\r\n\r\n: heartbeat\n\nevent: refresh\ndata: {}\n\n')
    const chunks = Array.from(text, byte => Buffer.from([byte]).toString('hex'))
    expect(await invoke({ operation: 'events', chunks })).toEqual({
      events: [
        { type: 'task-state', data: '{"text":"你好"}' },
        { type: 'refresh', data: '{}' },
      ],
    })
    await expect(invoke({ operation: 'events', oversizedLine: true })).rejects.toThrow('rejected')
    for (const invalid of [Buffer.from([100, 97, 116, 97, 58, 0xff, 10, 10]), Buffer.from('event: unsafe.event\n\n')])
      await expect(invoke({ operation: 'events', chunks: [invalid.toString('hex')] })).rejects.toThrow('rejected')
  })
  it('does not report locally cleared private Agent data as an unconfirmed Host write', async () => {
    expect(
      await invoke({
        operation: 'phoneAgents',
        privateProjectionProbe: true,
        snapshot: { catalog: { features: { customAgents: true } }, device: { dataScope: 'all' }, customAgents: [] },
      }),
    ).toEqual({
      initial: 'ready',
      offlineCache: 'ready',
      cleared: 'closed',
      hostMissing: 'confirming',
      lateIgnored: true,
      closedPrivate: true,
    })
  })
  it('counts native changed files by the Host folder identity across absolute diffs and relative outputs', async () => {
    const project = async (summary: object, paths: string[], outputs: object[]) => {
      const result = await invoke({
        operation: 'phoneProjection',
        detail: {
          summary,
          messages: [
            { id: 'u', role: 'user', text: 'edit' },
            ...paths.map((path, index) => ({
              id: `tool-${index}`,
              role: 'tool',
              state: 'completed',
              tool: { kind: 'edit', diffs: [{ path, oldText: '', newText: 'line\n' }] },
            })),
          ],
        },
        outputs,
      })
      return (result.turns as Array<{ files: string[] }>)[0]!.files
    }
    const output = (root: string, path: string) => ({ root, path, change: 'created' })
    expect(
      await project(
        { cwd: '/work' },
        ['/work/agent-edit.txt'],
        [output('default', 'agent-edit.txt'), output('default', 'command-edit.txt')],
      ),
    ).toEqual(['agent-edit.txt', 'command-edit.txt'])
    expect(
      await project(
        {
          cwd: '/work/a',
          folders: [
            { id: 'a', path: '/work/a' },
            { id: 'b', path: '/work/b' },
          ],
        },
        ['/work/a/file.txt'],
        [output('a', 'file.txt'), output('b', 'file.txt')],
      ),
    ).toHaveLength(2)
    expect(
      await project(
        {
          cwd: '/work',
          folders: [
            { id: 'a', path: '/work' },
            { id: 'b', path: '/work/nested' },
          ],
        },
        ['/work/nested/file.txt'],
        [output('a', 'nested/file.txt'), output('b', 'file.txt')],
      ),
    ).toHaveLength(1)
    expect(await project({}, ['/work/file.txt'], [output('default', 'file.txt')])).toHaveLength(2)
    expect(await project({ cwd: '/work' }, ['/work/file.txt'], [output('unknown', 'file.txt')])).toHaveLength(2)
    expect(await project({ cwd: '/work' }, ['/work/file.txt'], [output('default', '../work/file.txt')])).toHaveLength(2)
    expect(await project({ cwd: '/work' }, ['/work/\u00e9.txt', '/work/e\u0301.txt'], [])).toHaveLength(2)
    expect(
      await project(
        {
          folders: [
            { id: 'a', path: '/work/\u00e9' },
            { id: 'b', path: '/work/e\u0301' },
          ],
        },
        ['/work/e\u0301/file.txt'],
        [output('a', 'file.txt')],
      ),
    ).toHaveLength(2)
    const scopes = await invoke({ operation: 'phoneProjection', scopes: [{ cwd: '/work/\u00e9' }, { cwd: '/work/e\u0301' }] })
    expect(scopes.sameScope).toBe(false)
  })
  it('projects Host sessions for the phone: shelves, frozen words, turns, approvals and what it may start', async () => {
    const at = (minute: number) => `2026-11-01T10:${String(minute).padStart(2, '0')}:00.000Z`
    const result = (await invoke({
      operation: 'phoneProjection',
      hostNow: at(30),
      query: '密钥',
      stamps: ['2026-11-01T10:30:00Z', '2026-11-01T10:30:00.500Z', 'not a date'],
      statuses: ['failed', 'cancelled', 'interrupted', 'idle'],
      runEnds: [
        { runEnd: { reason: 'process-exited', unknownResults: [{ name: 'pnpm test' }] } },
        { runEnd: { reason: 'forced-stop', unknownResultCount: 2, unknownResults: [{ name: 'a' }, { name: 'b' }] } },
        { runEnd: { reason: 'host-stopped' } },
        { runEnd: { reason: 'turn-ended' } },
        { runEnd: { reason: 'turn-ended', unknownResultCount: 1 } },
        {},
      ],
      delivered: {
        summary: { live: { activity: 'starting' } },
        contextCleared: true,
        messages: [
          { id: 'u', role: 'user', text: '去做' },
          { id: 'gone', role: 'assistant', text: '', outputs: [{ path: 'old.ts', change: 'deleted' }] },
        ],
      },
      workspaces: [
        { id: 'default', name: '默认文件夹', path: '/work' },
        { id: 'latch', name: 'latch', path: '/work/latch' },
      ],
      tasks: [
        { id: 'a', title: '等批准', status: 'waiting-approval', updatedAt: at(1), workspaceId: 'latch' },
        { id: 'b', title: '问一句', status: 'running', pendingQuestions: 1, updatedAt: at(2), workspaceId: 'latch' },
        {
          id: 'c',
          title: '修复密钥',
          status: 'running',
          updatedAt: at(3),
          workspaceId: 'latch',
          live: { activity: 'model', lastEventAt: at(3) },
        },
        {
          id: 'd',
          title: '安静',
          status: 'running',
          updatedAt: at(4),
          workspaceId: 'latch',
          live: { activity: 'command', lastEventAt: at(4), silent: true },
        },
        {
          id: 'e',
          title: '停止中',
          status: 'running',
          updatedAt: at(5),
          mode: 'chat',
          live: { activity: 'cancelling', silent: true, lastEventAt: at(5) },
        },
        {
          id: 'f',
          title: '强停',
          status: 'interrupted',
          updatedAt: at(6),
          mode: 'chat',
          runEnd: { reason: 'forced-stop', at: at(6), unknownResultCount: 2 },
        },
        { id: 'g', title: '失败', status: 'idle', runOutcome: 'failed', updatedAt: at(7), workspaceId: 'gone' },
        { id: 'h', title: '归档', status: 'idle', archived: true, updatedAt: at(8) },
        { id: 'i', title: '助手', status: 'idle', personal: { assistantId: 'asst_x' }, updatedAt: at(9) },
      ],
      detail: {
        summary: { id: 'c', status: 'running', level: 'L3', branch: 'main', live: { activity: 'command', lastEventAt: at(29) } },
        permission: {
          level: 'L3',
          readback: 'mode',
          defaultMode: 'read-only',
          modeTiers: { yolo: { tier: 'never', line: 'x' } },
        },
        config: [{ id: 'm', category: 'mode', currentValue: 'yolo', options: [{ value: 'yolo', name: 'Yolo' }] }],
        usageReport: { contextUsed: 62, contextSize: 100, at: at(29) },
        approvals: [],
        runStartedAt: at(28),
        runWaitMs: 60_000,
        liveText: '还在写',
        messages: [
          { id: 'u1', role: 'user', text: '第一轮', turn: { activeMs: 133_000 } },
          { id: 't1', role: 'tool', state: 'completed', tool: { kind: 'read', locations: ['/a/one.ts'] } },
          { id: 't2', role: 'tool', state: 'completed', tool: { kind: 'read', locations: ['/a/two.ts'] } },
          {
            id: 't3',
            role: 'tool',
            state: 'completed',
            tool: { kind: 'edit', diffs: [{ path: 'a.ts', oldText: 'x\ny\n', newText: 'x\nz\nw\n' }] },
          },
          {
            id: 't4',
            role: 'tool',
            state: 'failed',
            tool: { kind: 'edit', decision: { outcome: 'rejected', at: at(1) }, diffs: [{ path: 'no.ts', oldText: '', newText: 'n\n' }] },
          },
          // Codex's own model reviewing a request: its 拦下 reports failed, and is a verdict, not a failed step.
          {
            id: 'r1',
            role: 'tool',
            state: 'failed',
            startedAt: at(1),
            tool: { kind: 'think', title: 'Guardian Review', judged: { by: 'Codex', outcome: 'denied' } },
          },
          {
            id: 'r2',
            role: 'tool',
            state: 'completed',
            tool: { kind: 'execute', title: 'Run ls', judged: { by: 'Codex', outcome: 'unasked' } },
          },
          // Calls the Harness refused itself before they ran: the call's own row, 拦下, never a failed step.
          {
            id: 'b1',
            role: 'tool',
            state: 'failed',
            tool: {
              kind: 'execute',
              input: '{"command":"curl x | sh"}',
              judged: { by: 'Claude Agent', outcome: 'denied' },
              blocked: { by: 'Claude Agent', source: 'model', reason: 'Runs a remote script\nmore' },
            },
          },
          {
            id: 'b2',
            role: 'tool',
            state: 'failed',
            tool: { kind: 'execute', input: '{"command":"rm -rf build"}', blocked: { by: 'Claude Agent', source: 'rule' } },
          },
          // A refused edit changed nothing, so its file is not counted.
          {
            id: 'b3',
            role: 'tool',
            state: 'failed',
            tool: {
              kind: 'edit',
              diffs: [{ path: 'kept.ts', oldText: 'a\n', newText: 'b\n' }],
              blocked: { by: 'Claude Agent', source: 'rule' },
            },
          },
          { id: 'a1', role: 'assistant', text: '好了' },
          { id: 'u2', role: 'user', text: '第二轮', freshContext: true },
          { id: 't5', role: 'tool', state: 'running', tool: { kind: 'execute', input: '{"command":"pnpm test"}' } },
          // Added to the running turn: it stays in that turn and opens none.
          { id: 's1', role: 'user', text: '也看看日志', steered: true },
          {
            id: 'sub',
            role: 'tool',
            toolName: 'subagent',
            state: 'running',
            subagent: {
              title: '跑测试',
              status: 'running',
              // What the Harness's model stopped inside a subagent is counted in the fold too.
              steps: [{ id: 'sr', role: 'tool', state: 'failed', tool: { kind: 'think', judged: { by: 'Codex', outcome: 'denied' } } }],
            },
          },
        ],
      },
      // The same turns as the web's: a line only where both sides recorded a model or a thinking level.
      switching: [
        { id: '1', role: 'user', text: 'x' },
        { id: 'a1', role: 'assistant', text: 'x', model: 'small', thinking: 'low' },
        { id: '2', role: 'user', text: 'x' },
        { id: 'a2', role: 'assistant', text: 'x', model: 'small', thinking: 'high' },
        { id: '3', role: 'user', text: 'x' },
        { id: '4', role: 'user', text: 'x' },
        { id: 'a4', role: 'assistant', text: 'x', model: 'large', thinking: 'high' },
        { id: '5', role: 'user', text: 'x' },
        { id: 'a5', role: 'assistant', text: 'x', model: 'small', thinking: 'Max' },
        { id: '6', role: 'user', text: 'x' },
        { id: 'a6', role: 'assistant', text: 'x', model: 'small' },
        { id: '7', role: 'user', text: 'x' },
        { id: 'a7', role: 'assistant', text: 'x', model: 'other' },
        { id: '8', role: 'user', text: 'x' },
        { id: 'a8', role: 'assistant', text: 'x', model: 'other', thinking: 'low' },
      ],
      outputs: [{ path: 'a.ts' }, { path: 'made.pptx', root: 'r' }],
      canApprove: true,
      canApproveElevated: true,
      canRun: true,
      approvals: [
        { toolName: 'write_file', risk: 'R1', tool: { toolTitle: '写入', locations: ['src/a.ts'] } },
        { toolName: 'write_file', risk: 'R1', tool: { toolTitle: '写入', locations: ['src/a.ts', 'src/b.ts', 'src/c.ts'] } },
        {
          toolName: 'write_file',
          risk: 'R1',
          options: [
            { id: 'o1', kind: 'allow_once' },
            { id: 'o2', kind: 'allow_always' },
          ],
        },
        { toolName: 'write_file', risk: 'R1', options: [{ id: 'o2', kind: 'allow_always' }] },
        { toolName: 'write_file', risk: 'R2', riskReason: 'outside-workspace' },
        { toolName: 'shell', advisory: true, risk: 'R2' },
        { toolName: 'write_file' },
        { toolName: 'Edit', advisory: true, risk: 'R2', subagent: '跑测试', tool: { kind: 'edit', title: 'Edit a.txt' } },
      ],
      inputs: [
        { summary: { level: 'L1' }, canRun: true, connected: true },
        { summary: { level: 'L3' }, canRun: true, connected: true },
        { summary: { level: 'L1' }, canRun: true, connected: false },
        { summary: { level: 'L1', permissionDrift: true }, canRun: true, connected: true },
        { summary: { level: 'L1' }, canRun: false, connected: true },
        { summary: { level: 'L1', personal: { assistantId: 'asst_x' } }, canRun: true, connected: false },
      ],
      catalog: {
        harnesses: [
          testHarness('codex', { label: 'Codex' }),
          testHarness('broken', { label: 'Broken', status: 'unavailable' }),
          testHarness('standard', { kind: 'builtin', label: 'Latch 内置' }),
        ],
        workspaces: [
          { id: 'sealed', name: 'sealed' },
          { id: 'latch', name: 'latch' },
          { id: 'gone', name: 'gone', unavailable: '找不到这个文件夹' },
        ],
        providers: [{ id: 'p', name: 'P', models: ['m1', 'm2'], defaultModel: 'm1' }],
        defaults: { harnessId: 'codex', workspaceId: 'sealed', mode: 'agent', model: { providerId: 'p', model: 'm2' } },
      },
    })) as Record<string, unknown>
    expect(result.parsed).toEqual([Date.parse('2026-11-01T10:30:00Z') / 1000, Date.parse('2026-11-01T10:30:00.500Z') / 1000, -1])
    // A last-confirmed time older than today says which day it belongs to.
    expect(result.confirmed).toEqual([true, true, true])
    expect(result.clocks).toEqual(['0:47', '12:03', '1:02:03'])
    expect(result.durations).toEqual(['', '1.2 秒', '12 秒', '2 分 13 秒', '1 小时 2 分'])
    expect(result.runEnds).toEqual([
      { failed: true, text: 'Codex 已退出 · 这一轮没有完成 · 这 1 条命令结果未知，请核对', unknown: ['pnpm test'] },
      { failed: false, text: '已强制停止 · 这 2 条命令结果未知，请核对', unknown: ['a', 'b'] },
      { failed: false, text: 'Latch 重启时中断', unknown: [] },
      null,
      { failed: false, text: 'Codex 结束了这一轮 · 这 1 条命令结果未知，请核对', unknown: [] },
      null,
    ])
    expect(result.outcomes).toEqual(['failed', 'stopped', 'interrupted', 'completed'])
    expect(result.delivery).toBe('Mac 已收到')
    expect(result.hasFiles).toEqual([true, false])
    expect(result.noteTooLong).toEqual([false, true, false])
    // Backing out of Face ID is quiet; a sheet that failed says so, and neither reads as a lost connection.
    expect(result.faceId).toEqual([true, true, false, true, false, false])
    // Trust is set once when the phone is connected: signing a content window never asks for the person by itself.
    expect(result.verificationAsksPresence).toBe(false)
    // Face ID only when the person turned it on; without it, a window that ran out opens again with no tap.
    expect(result.unlock).toEqual([
      { reopen: '查看', symbol: 'eye', atExpiry: true },
      { reopen: '用 Face ID 查看', symbol: 'faceid', atExpiry: false },
    ])
    expect(result.rows).toEqual(['waiting', 'waiting', 'running', 'silent', 'stopping', 'ended:已强制停止:2', 'failed', 'read', 'read'])
    // A list that may be stale draws nothing live; a run that has already ended still says how.
    expect(result.frozen).toEqual(['frozen', 'frozen', 'frozen', 'frozen', 'frozen', 'ended:已强制停止:2', 'failed', 'read', 'read'])
    expect(result.shelves).toEqual([
      { label: '等你处理', ids: ['d', 'b', 'a'] },
      { label: 'latch', ids: ['c'] },
      // A session an assistant ran stays listed, to be read.
      { label: '对话', ids: ['i', 'g', 'f', 'e'] },
    ])
    expect(result.found).toEqual(['latch'])
    expect(result.turns).toEqual([
      {
        blocks: [
          {
            work: [
              'reads:2',
              '编辑 a.ts',
              '编辑 no.ts',
              'Codex 的模型审阅',
              'Run ls',
              '运行 curl x | sh',
              '运行 rm -rf build',
              '编辑 kept.ts',
            ],
          },
          { prose: '好了' },
        ],
        folds: true,
        fold: '已工作 2 分 13 秒 · 1 步被拒绝 · 模型拦下 2 次 · 规则拦下 2 次',
        // The rejected edit never ran, and a file the tools edited keeps their counts over the watcher's.
        files: ['a.ts', 'made.pptx'],
        add: -1,
        del: -1,
      },
      {
        blocks: [{ work: ['运行 pnpm test'] }, { steer: '也看看日志' }, { work: ['子 Agent 跑测试'] }, { prose: '还在写' }],
        folds: true,
        fold: '已工作 · 模型拦下 1 次',
        files: ['a.ts', 'made.pptx'],
        add: -1,
        del: -1,
      },
    ])
    // The second turn began a new context; a refused first message after a clear leaves the next one on a new context too.
    expect(result.dividers).toEqual(['', '清空了上下文'])
    expect(result.switches).toEqual({
      '2': '思考 低 → 高',
      '4': '模型 small → large',
      '5': 'large · 高 → small · Max',
      '7': '模型 small → other',
    })
    expect(result.cleared).toEqual([[], ['下一条消息开始新的上下文', '上下文已经清空，Codex 看不到之前的消息，记录仍留在这里。']])
    expect(result.status).toEqual({ text: '命令运行中 · pnpm test', clock: '1:00', tone: 'plain', actions: [] })
    expect(result.subtitle).toEqual(['Codex', '不再询问', 'main', '62%'])
    expect(result.neverAsks).toBe(true)
    expect(result.judged).toEqual(['true:拦下', 'false:没有问你', 'false:拦下'])
    expect(result.blocked).toEqual([
      'true:Claude Agent 的模型审阅：Runs a remote script',
      'false:被 Claude Agent 自己的规则或当前模式拦下',
      'false:被 Claude Agent 自己的规则或当前模式拦下',
    ])
    expect(result.input).toEqual([
      '',
      '',
      'Mac 不在线',
      '这个会话的权限变了，已停止接受输入',
      '这台手机不能发送消息',
      '这个会话来自已移除的 Agent，只能查看',
    ])
    expect(result.approvals).toEqual([
      { heading: '写入 src/a.ts', canAllow: true, option: '', refusal: '', clause: '' },
      { heading: '写入 src/a.ts 等 3 处', canAllow: true, option: '', refusal: '', clause: '' },
      { heading: 'write_file', canAllow: true, option: 'o1', refusal: '', clause: '' },
      // As the web: an ordinary step offers what the Host gave, so its only allow is the session-wide one.
      { heading: 'write_file', canAllow: true, option: 'o2', refusal: '', clause: '' },
      { heading: 'write_file', canAllow: true, option: '', refusal: '', clause: '在项目文件夹之外' },
      { heading: 'shell', canAllow: true, option: '', refusal: '', clause: '' },
      { heading: 'write_file', canAllow: true, option: '', refusal: '', clause: '高风险' },
      { heading: '子 Agent 跑测试 · Edit a.txt', canAllow: true, option: '', refusal: '', clause: '' },
    ])
    expect(result.engines).toEqual([
      { id: 'standard', name: 'Latch 内置' },
      { id: 'codex', name: 'Codex' },
    ])
    expect(result.projects).toEqual([{ id: 'sealed' }, { id: 'latch' }])
    // Codex chooses its own model, so the sheet picks none and sends none.
    expect(result.choice).toEqual({ harness: 'codex', workspace: 'sealed', model: '' })
    expect(result.blocker).toBe('')
    expect(result.fields).toEqual({
      prompt: '开始',
      harnessId: 'codex',
      workspaceId: 'sealed',
      mode: 'agent',
    })
  })
  it('matches the existing strict WebSocket wire codec with fragmented input and refuses unsupported frames', async () => {
    const payload = Buffer.from('public relay fixture'),
      mask = Buffer.from([1, 2, 3, 4])
    const incoming = Buffer.from(encodeFrame({ opcode: 2, payload }))
    expect(
      await invoke({
        operation: 'relayFrames',
        chunks: Array.from(incoming, byte => Buffer.from([byte]).toString('hex')),
        payload: payload.toString('hex'),
        mask: mask.toString('hex'),
      }),
    ).toEqual({
      frames: [{ opcode: 2, payload: payload.toString('hex') }],
      encoded: Buffer.from(encodeFrame({ opcode: 2, payload }, mask)).toString('hex'),
    })
    for (const hex of ['0200', '8100', 'c200', '828000000000', '827e0001', '8801ff', '887e0080']) {
      await expect(invoke({ operation: 'relayFrames', chunks: [hex] })).rejects.toThrow('rejected')
    }
  })
  it('matches the anonymous discovery and gateway vectors without historical or textual address ambiguity', async () => {
    const vectors = JSON.parse(await readFile(join(root, 'packages/testkit/vectors/link-v1.json'), 'utf8')) as {
      discovery: {
        key: string
        day: number
        epoch: { hash: string; input: string }
        names: Array<{ label: string }>
        gateways: Array<{ address: string; prefixLength: number; gateway: string; hash: string }>
      }
    }
    const value = vectors.discovery
    expect(await invoke({ operation: 'discovery', ...value })).toEqual({
      labels: value.names.map(item => item.label),
      hashes: value.gateways.map(item => item.hash),
      epoch: value.epoch.hash,
    })
    const mapped = {
      ...value.gateways[0]!,
      address: `::ffff:${value.gateways[0]!.address}`,
      gateway: `::ffff:${value.gateways[0]!.gateway}`,
    }
    expect((await invoke({ operation: 'discovery', ...value, gateways: [mapped] })).hashes).toEqual([mapped.hash])
    expect((await invoke({ operation: 'discovery', ...value, gateways: [{ ...value.gateways[0], mask: 'ffffff00' }] })).hashes).toEqual([
      value.gateways[0]!.hash,
    ])
    for (const mask of ['ffff00ff', '00000000', 'ffffff', 'ff'.repeat(16)])
      await expect(invoke({ operation: 'discovery', ...value, gateways: [{ ...value.gateways[0], mask }] })).rejects.toThrow('rejected')
    await expect(invoke({ operation: 'discovery', ...value, gateways: [{ ...value.gateways[0], prefixLength: 33 }] })).rejects.toThrow(
      'rejected',
    )
  })
  it('accepts credential retirement only for this fixed Root and device signed revocation', async () => {
    const vectors = JSON.parse(await readFile(join(root, 'packages/testkit/vectors/link-v1.json'), 'utf8')) as {
      nativeRevocation: { rootSpki: string; hostId: string; deviceId: string; revokedAt: number; signature: string; tombstoneHash: string }
    }
    const value = vectors.nativeRevocation
    expect(await invoke({ operation: 'revocation', ...value })).toEqual({ verified: true, tombstoneHash: value.tombstoneHash })
    for (const patch of [
      { expectedDeviceId: `dev_${'A'.repeat(22)}` },
      { expectedHostId: 'a'.repeat(52) },
      { revokedAt: value.revokedAt + 1 },
      { signature: 'A'.repeat(86) },
      { rootSpki: '00'.repeat(91) },
    ])
      await expect(invoke({ operation: 'revocation', ...value, ...patch })).rejects.toThrow('rejected')
  })
  it('keeps filtered-stream sequence gaps and heartbeat cursors without treating metadata revision as applied body state', async () => {
    const epoch = 'abc123-test-epoch'
    const text = Buffer.from(
      `id: ${epoch}:3\nevent: refresh\ndata: {"type":"refresh"}\n\nid: ${epoch}:19\n: resumed\n\nid: ${epoch}:25\n: heartbeat\n\n`,
    )
    expect(await invoke({ operation: 'events', chunks: [text.toString('hex')] })).toEqual({
      events: [
        { type: 'refresh', data: '{"type":"refresh"}', cursor: `${epoch}:3` },
        { type: 'resumed', data: '', cursor: `${epoch}:19` },
        { type: 'heartbeat', data: '', cursor: `${epoch}:25` },
      ],
    })
    for (const id of [`${epoch}:01`, `${epoch}:-1`, `${epoch}:9007199254740992`, 'unsafe epoch:1'])
      await expect(invoke({ operation: 'events', chunks: [Buffer.from(`id: ${id}\n\n`).toString('hex')] })).rejects.toThrow('rejected')
  })
  it('verifies the signed address-book vector and refuses rollback, identity changes and expiry', async () => {
    const vectors = JSON.parse(await readFile(join(root, 'packages/testkit/vectors/link-v1.json'), 'utf8')) as {
      addressBook: {
        encoded: string
        rootSpki: string
        deviceId: string
        hostId: string
        issuedAt: number
        expiresAt: number
        generation: number
        payloadHash: string
      }
      discovery: { key: string }
    }
    const book = vectors.addressBook
    const input = {
      operation: 'addressBook',
      ...book,
      timeMs: book.issuedAt,
      priorGeneration: book.generation,
      priorHash: book.payloadHash,
    }
    expect(await invoke(input)).toEqual({
      hostId: book.hostId,
      deviceId: book.deviceId,
      generation: book.generation,
      payloadHash: book.payloadHash,
      relays: 1,
    })
    expect(await invoke({ ...input, operation: 'discoveryKey', timeMs: book.expiresAt + 1 })).toEqual({ key: vectors.discovery.key })
    for (const patch of [
      { priorGeneration: book.generation + 1 },
      { priorHash: '00'.repeat(32) },
      { deviceId: `dev_${'A'.repeat(22)}` },
      { timeMs: book.expiresAt + 1 },
      { encoded: `${book.encoded}AA` },
    ])
      await expect(invoke({ ...input, ...patch })).rejects.toThrow('rejected')
    for (const patch of [{ priorGeneration: book.generation + 1 }, { priorHash: '00'.repeat(32) }, { encoded: `${book.encoded}AA` }])
      await expect(invoke({ ...input, ...patch, operation: 'discoveryKey', timeMs: book.expiresAt + 1 })).rejects.toThrow('rejected')
  })
  it('rebuilds App paths for verified relay identity and profile changes without reconnecting on pass renewal', async () => {
    const root = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
      rootSpki = root.publicKey.export({ format: 'der', type: 'spki' }),
      holderSeed = Buffer.alloc(32, 8),
      routeSeed = Buffer.alloc(32, 7),
      day = 20000,
      now = day * 86400000 + 3600000,
      relays = await Promise.all(
        [9, 10].map(async id => ({
          relayId: Buffer.alloc(16, id),
          url: `https://relay${id}.example`,
          spkiHash: Buffer.alloc(32, id),
          passes: await Promise.all(
            [day, day + 1].map(async day => ({
              holderSeed,
              pass: await issuePass(nodeCrypto, routeSeed, {
                pairing: false,
                relayId: Buffer.alloc(16, id),
                day,
                notBefore: day * 86400 - 900,
                notAfter: (day + 1) * 86400 + 900,
                routePub: await nodeCrypto.publicKey(routeSeed),
                holderPub: await nodeCrypto.publicKey(holderSeed),
                tag: Buffer.alloc(16, day % 255),
              }),
            })),
          ),
        })),
      ),
      book = {
        hostId: base32(createHash('sha256').update(rootSpki).digest()),
        deviceId: `dev_${'A'.repeat(22)}`,
        generation: 1,
        issuedAt: now - 1000,
        expiresAt: now + 86400000,
        discoveryKey: Buffer.alloc(32, 4),
        lan: [],
        relays,
      }
    const encode = (patch: Partial<Parameters<typeof encodeAddressBook>[0]> = {}) => {
      const payload = encodeAddressBook({ ...book, ...patch }),
        signature = sign('sha256', addressBookSigningInput(payload), { key: root.privateKey, dsaEncoding: 'ieee-p1363' })
      return `LATCHBOOK1.${Buffer.concat([payload, signature]).toString('base64url')}`
    }
    const input = {
      operation: 'bookPathChange',
      rootSpki: rootSpki.toString('hex'),
      deviceId: book.deviceId,
      timeMs: now,
      previous: encode(),
    }
    const refreshed = encode({
      generation: 2,
      issuedAt: now,
      relays: relays.toReversed().map(relay => ({ ...relay, url: 'https://new-address.example', passes: relay.passes.toReversed() })),
    })
    expect(await invoke({ ...input, current: refreshed })).toEqual({ migrate: false })
    for (const patch of [
      { discoveryKey: Buffer.alloc(32, 5) },
      { relays: relays.slice(1) },
      { relays: relays.map((relay, i) => ({ ...relay, ...(i === 0 ? { spkiHash: Buffer.alloc(32, 6) } : {}) })) },
      { relays: relays.map((relay, i) => ({ ...relay, ...(i === 0 ? { profile: 'outer-pad-v2' as const } : {}) })) },
    ])
      expect(await invoke({ ...input, current: encode({ generation: 2, ...patch }) })).toEqual({ migrate: true })
    expect(await invoke({ ...input, previous: encode({ relays: relays.slice(1) }), current: encode() })).toEqual({ migrate: true })
    expect(await invoke({ ...input, previous: undefined, current: encode() })).toEqual({ migrate: true })
    await expect(invoke({ ...input, current: refreshed.slice(0, -6) + 'AAAAAA' })).rejects.toThrow('rejected')
  })
  it('selects relay admission at each dial from one fixed verified book and refuses its expiry', async () => {
    const root = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
      rootSpki = root.publicKey.export({ format: 'der', type: 'spki' }),
      relayId = Buffer.alloc(16, 9),
      holderSeed = Buffer.alloc(32, 8),
      routeSeed = Buffer.alloc(32, 7),
      day = 20000,
      issuedAt = day * 86400000,
      expiresAt = issuedAt + 2 * 86400000,
      passes = await Promise.all(
        [day, day + 1].map(async day => ({
          holderSeed,
          pass: await issuePass(nodeCrypto, routeSeed, {
            pairing: false,
            relayId,
            day,
            notBefore: day * 86400 - 900,
            notAfter: (day + 1) * 86400 + 900,
            routePub: await nodeCrypto.publicKey(routeSeed),
            holderPub: await nodeCrypto.publicKey(holderSeed),
            tag: Buffer.alloc(16, day % 255),
          }),
        })),
      ),
      deviceId = `dev_${'A'.repeat(22)}`,
      payload = encodeAddressBook({
        hostId: base32(createHash('sha256').update(rootSpki).digest()),
        deviceId,
        generation: 1,
        issuedAt,
        expiresAt,
        discoveryKey: Buffer.alloc(32, 4),
        lan: [],
        relays: [{ relayId, url: 'https://relay.example', spkiHash: Buffer.alloc(32, 5), passes }],
      }),
      signature = sign('sha256', addressBookSigningInput(payload), { key: root.privateKey, dsaEncoding: 'ieee-p1363' }),
      input = {
        operation: 'relayAdmission',
        rootSpki: rootSpki.toString('hex'),
        deviceId,
        timeMs: issuedAt + 3600000,
        encoded: `LATCHBOOK1.${Buffer.concat([payload, signature]).toString('base64url')}`,
      }
    expect(await invoke({ ...input, times: [issuedAt + 3600000, issuedAt + 86400000 + 3600000, expiresAt - 1] })).toEqual({
      selected: [0, 1, 1],
    })
    for (const time of [issuedAt - 901000, expiresAt, expiresAt + 1])
      await expect(invoke({ ...input, times: [time] })).rejects.toThrow('rejected')
  })
  it('keeps two computers with the same device ID isolated through concurrent saves, locking and signed retirement', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'latch-swift-profiles-'))
    try {
      const now = Date.now(),
        deviceId = `dev_${'A'.repeat(22)}`
      const profiles = ['profile alpha', 'profile beta'].map(name => {
        const root = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
        const rootSpki = root.publicKey.export({ type: 'spki', format: 'der' })
        const hostId = base32(createHash('sha256').update(rootSpki).digest())
        const payload = Buffer.from(
          encodeAddressBook({
            hostId,
            deviceId,
            generation: 1,
            issuedAt: now - 1000,
            expiresAt: now + 86_400_000,
            discoveryKey: Buffer.alloc(32, 4),
            lan: [],
            relays: [],
          }),
        )
        const signature = sign('sha256', addressBookSigningInput(payload), { key: root.privateKey, dsaEncoding: 'ieee-p1363' })
        const publicKey = () =>
          generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
        return {
          signingKey: root.privateKey,
          profile: {
            name,
            prepared: false,
            device: {
              hostId,
              deviceId,
              rootSpki: rootSpki.toString('base64'),
              knockKey: Buffer.alloc(32, 7).toString('base64'),
              signedAddressBook: `LATCHBOOK1.${Buffer.concat([payload, signature]).toString('base64url')}`,
              bookGeneration: 1,
              bookHash: createHash('sha256').update(payload).digest('base64'),
            },
            keys: {
              connectionTag: Buffer.from(`fixture.connection.${randomUUID()}`).toString('base64'),
              verificationTag: Buffer.from(`fixture.verification.${randomUUID()}`).toString('base64'),
              connectionSpki: publicKey(),
              verificationSpki: publicKey(),
            },
          },
        }
      })
      const first = profiles[0]!,
        revokedAt = Date.now()
      const revocations = profiles.map(item => ({
        hostId: item.profile.device.hostId,
        deviceId,
        revokedAt,
        signature: sign('sha256', Buffer.from(`latch-native-revoked-v1\n${item.profile.device.hostId}\n${deviceId}\n${revokedAt}`), {
          key: item.signingKey,
          dsaEncoding: 'ieee-p1363',
        }).toString('base64url'),
      }))
      const draftPayload = formatPairingPayload({
        rootSpki: Buffer.from(first.profile.device.rootSpki, 'base64'),
        secret: Buffer.alloc(16, 1),
        expiresAt: Math.floor(now / 1000) + 600,
        lan: [{ address: '127.0.0.1', port: 1 }],
      })
      const input = {
        operation: 'profiles',
        directory: temporary,
        key: '11'.repeat(32),
        profiles: profiles.map(item => item.profile),
        revocation: revocations[0],
        secondRevocation: revocations[1],
        draft: {
          payload: draftPayload,
          keys: first.profile.keys,
          name: 'fixture draft',
        },
      }
      expect(await invoke(input)).toEqual({
        sameDeviceIdIsolated: true,
        concurrentSave: true,
        encryptedRecovery: true,
        lockClosedCache: true,
        immutableDraft: true,
        rootBoundRetirement: true,
        otherCachePreserved: true,
        retirementRetry: true,
        ciphertextProtected: true,
      })
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })
  it('stores authenticated ciphertext with private permissions, rejects substitutions and never follows cache symlinks', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'latch-swift-cache-test-')),
      directory = join(temporary, 'cache')
    const input = { operation: 'vault', directory, key: '11'.repeat(32), expected: 'fixture plaintext' }
    try {
      expect(await invoke({ ...input, text: input.expected })).toEqual({ matches: true, backupExcluded: true })
      const file = join(directory, 'meta-item.lcache'),
        cipher = await readFile(file)
      expect(cipher.includes(Buffer.from(input.expected))).toBe(false)
      expect(await invoke(input)).toEqual({ matches: true, backupExcluded: true })
      await expect(invoke({ ...input, key: '22'.repeat(32) })).rejects.toThrow('rejected')
      await copyFile(file, join(directory, 'meta-other.lcache'))
      await expect(invoke({ ...input, name: 'other' })).rejects.toThrow('rejected')
      await expect(invoke({ ...input, name: '../item' })).rejects.toThrow('rejected')
      const tampered = Buffer.from(cipher)
      tampered[tampered.length - 1]! ^= 1
      await writeFile(file, tampered)
      await expect(invoke(input)).rejects.toThrow('rejected')
      await writeFile(file, cipher)
      await chmod(file, 0o644)
      await expect(invoke(input)).rejects.toThrow('rejected')
      await rm(file)
      const outside = join(temporary, 'outside')
      await mkdir(outside, { mode: 0o700 })
      const outsideFile = join(outside, 'private')
      await writeFile(outsideFile, cipher, { mode: 0o600 })
      await symlink(outsideFile, file)
      await expect(invoke(input)).rejects.toThrow('rejected')
      await symlink(outside, join(temporary, 'alias'))
      await expect(invoke({ ...input, directory: join(temporary, 'alias') })).rejects.toThrow('rejected')
      expect(await readFile(outsideFile)).toEqual(cipher)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })
  it('distinguishes a Host Agent write awaiting confirmation from failed native reads without dropping the transport', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    const path = 'GET /link/api/custom-agents/general'
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const { invitation } = await owner.json<{ invitation: { payload: string } }>('native/pairings', { method: 'POST', body: {} })
      nativeReadFaults.set(path, [
        { status: 503, code: 'agent-write-unknown' },
        { status: 500, code: 'internal' },
        { status: 408, code: 'read-timeout' },
      ])
      expect(
        await invoke({ operation: 'nativeWorkspace', agentReadFailures: true, payload: invitation.payload, port: host.host.nativePort }),
      ).toEqual({ outcomes: ['confirming', 'failed', 'failed'], transportUsable: true, pending: 1, samePending: true, timeout: 'offline' })
    } finally {
      nativeReadFaults.delete(path)
      await host.close()
    }
  }, 30_000)
  it('retains an unanswered Swift helper creation when a successful HTTP response lacks its identity', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    const key = 'POST /link/api/custom-agents'
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const { invitation } = await owner.json<{ invitation: { payload: string } }>('native/pairings', { method: 'POST', body: {} })
      nativeMalformedSuccess.add(key)
      const result = await invoke({
        operation: 'nativeWorkspace',
        helperReceipt: true,
        payload: invitation.payload,
        port: host.host.nativePort,
      })
      expect(result).toMatchObject({ unknown: true, sameRequest: true, cleared: true })
      const snapshot = await owner.json<AppSnapshot>('snapshot')
      expect(snapshot.customAgents).toHaveLength(1)
      expect(snapshot.customAgents![0]!.id).toBe(result.createdId)
      expect(snapshot.tasks).toHaveLength(0)
    } finally {
      nativeMalformedSuccess.delete(key)
      await host.close()
    }
  }, 30_000)
  it('requires an actual native reader origin for event acceptance and cursor acknowledgement', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const { invitation } = await owner.json<{ invitation: { payload: string } }>('native/pairings', { method: 'POST', body: {} })
      const result = await invoke({
        operation: 'nativeWorkspace',
        eventProvenance: true,
        payload: invitation.payload,
        port: host.host.nativePort,
      })
      expect(result).toEqual({ ownAccepted: true, crossStreamAccepted: false, parserAccepted: false, parserAckRefused: true })
    } finally {
      await host.close()
    }
  }, 30_000)

  it.skipIf(process.env.LATCH_NATIVE_CADENCE !== '1')(
    'keeps native delta negotiation through large-history publication cadence',
    async () => {
      const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
      try {
        const owner = await host.enroll({ listener: 'unix' })
        await owner.confirmedJson('agents', {
          method: 'POST',
          body: {
            id: 'cadence',
            name: 'Cadence',
            command: process.execPath,
            args: [FAKE_ACP_AGENT],
          },
        })
        const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
          method: 'POST',
          body: {
            harnessId: 'cadence',
            mode: 'agent',
            prompt: 'big 20000',
            requestId: randomUUID(),
          },
        })
        const settled = () => expect.poll(async () => (await host.host.bridge.detail(sessionId)).summary.status).toBe('idle')
        await settled()
        for (let index = 1; index < 10; index++) {
          await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'big 20000', requestId: randomUUID() } })
          await settled()
        }
        const { invitation } = await owner.json<{ invitation: { payload: string } }>('native/pairings', { method: 'POST', body: {} })
        const result = await invoke(
          { operation: 'nativeWorkspace', bodyScript: 'cadence', sessionId, payload: invitation.payload, port: host.host.nativePort },
          100_000,
        )
        await mkdir(join(root, 'test-results/native-cadence'), { recursive: true })
        await writeFile(join(root, 'test-results/native-cadence/result.json'), JSON.stringify(result, null, 2))
        expect(result.repairs).toBe(0)
        expect(result.failure).toBe('')
        expect(result.delta).toBeGreaterThan(1000)
        expect(result.finalBytes).toBe(28890)
      } finally {
        await host.close()
      }
    },
    150_000,
  )

  it('publishes native body offers synchronously before committing progress and withdraws old selections and leases', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const { invitation } = await owner.json<{ invitation: { payload: string } }>('native/pairings', { method: 'POST', body: {} })
      const result = await invoke({
        operation: 'nativeWorkspace',
        bodyPublication: true,
        payload: invitation.payload,
        port: host.host.nativePort,
      })
      expect(result).toEqual({
        refusedApplication: true,
        noProgressBeforeApplication: true,
        nestedPublicationRefused: true,
        appliedOnce: true,
        cacheAfterReceipt: true,
        cursorAfterReceipt: true,
        idempotentReceipt: true,
        duplicateRefused: true,
        legacyAccepts: false,
        legacyAckRefused: true,
        staleSelectionRefused: true,
        foreignPublicationRefused: true,
        expiredPublicationRefused: true,
        closedRead: true,
        noImplicitVerification: true,
        closedPublicationRefused: true,
      })
    } finally {
      await host.close()
    }
  }, 30_000)

  it('advances the actual native stream shadow behind newer HTTP without replacing it or losing UTF8 offsets', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    let sessionId = ''
    try {
      const owner = await host.enroll({ listener: 'unix' })
      ;({ sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        method: 'POST',
        body: { mode: 'chat', prompt: 'Native shadow fixture', requestId: randomUUID() },
      }))
      const actual = await owner.json<{ summary: { status: string }; sync: { instanceId: string } }>(`tasks/${sessionId}`)
      await expect.poll(async () => (await owner.json<typeof actual>(`tasks/${sessionId}`)).summary.status).toBe('idle')
      const vectors = JSON.parse(await readFile(join(root, 'packages/testkit/vectors/task-delta-v1.json'), 'utf8')) as {
        streams: Array<{ actions: Array<{ frame: Record<string, unknown>; expect: { detail: { liveText: string } } }> }>
      }
      const actions = vectors.streams[0]!.actions.slice(0, 3)
      const frames: Array<Record<string, unknown>> = actions.map((action, index) => ({
        ...action.frame,
        instanceId: actual.sync.instanceId,
        sessionId,
        revision: index === 2 ? 21 : 10 + index,
      }))
      const first = frames[0] as unknown as { detail: Record<string, unknown> & { summary: Record<string, unknown> } }
      first.detail.summary.id = sessionId
      const details = [20, 21].map(revision => ({
        ...first.detail,
        liveText: 'HTTP newer',
        sync: { instanceId: actual.sync.instanceId, revision },
      }))
      const script = {
        details,
        streams: [
          frames.map(
            (frame, index) => `id: ${actual.sync.instanceId}:${index + 1}\nevent: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`,
          ),
        ],
        opened: [] as Array<{ delta: string | string[] | undefined; resume: boolean }>,
        closed: 0,
      }
      nativeBodyScripts.set(sessionId, script)
      const { invitation } = await owner.json<{ invitation: { payload: string } }>('native/pairings', { method: 'POST', body: {} })
      expect(
        await invoke({
          operation: 'nativeWorkspace',
          bodyScript: 'shadow',
          sessionId,
          payload: invitation.payload,
          port: host.host.nativePort,
        }),
      ).toEqual({
        ignoredOlder: 2,
        text: actions[2]!.expect.detail.liveText,
        httpUnchanged: true,
        streamWinsSameRevision: true,
        cursor: 3,
        cachedText: actions[2]!.expect.detail.liveText,
      })
      expect(script.opened).toEqual([{ delta: 'delta-v1', resume: false }])
      await expect.poll(() => script.closed).toBe(1)
    } finally {
      nativeBodyScripts.delete(sessionId)
      await host.close()
    }
  }, 30_000)

  it.each(['vault-covered', 'metadata-covered', 'ledger-state'] as const)(
    'retains eight unapplied slots while body proofs await %s',
    async mode => {
      const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
      let sessionId = ''
      try {
        const owner = await host.enroll({ listener: 'unix' })
        ;({ sessionId } = await owner.json<{ sessionId: string }>('tasks', {
          method: 'POST',
          body: {
            mode: 'chat',
            prompt: 'Body backlog fixture',
            requestId: randomUUID(),
          },
        }))
        await expect.poll(async () => (await host.host.bridge.summary(sessionId)).status).toBe('idle')
        const actual = await owner.json<TaskDetail>(`tasks/${sessionId}`),
          snapshot = await owner.json<AppSnapshot>('snapshot')
        const revision = snapshot.revision
        if (revision === undefined) throw new Error('Current Host omitted its snapshot revision')
        const vectors = JSON.parse(await readFile(join(root, 'packages/testkit/vectors/task-delta-v1.json'), 'utf8')) as {
          streams: Array<{
            actions: Array<{
              frame: Record<string, unknown> & { detail: { summary: Record<string, unknown> }; stream: Record<string, unknown> }
            }>
          }>
        }
        const base = vectors.streams[0]!.actions[0]!.frame,
          instanceId = actual.sync!.instanceId
        base.detail.summary.id = sessionId
        const full = (sequence: number) => ({
          ...base,
          instanceId,
          sessionId,
          revision: revision + 20 + sequence,
          stream: { ...base.stream, stateSeq: sequence },
        })
        const frames: Array<Record<string, unknown>> =
          mode === 'metadata-covered'
            ? [{ type: 'refresh', instanceId, revision }, ...Array.from({ length: 8 }, (_, i) => full(i + 1))]
            : Array.from({ length: 9 }, (_, i) => full(i + 1))
        const script = {
          details: [{ ...base.detail, sync: { instanceId, revision: actual.sync!.revision } }],
          streams: [frames.map((frame, i) => `id: ${instanceId}:${i + 1}\nevent: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`)],
          opened: [] as Array<{ delta: string | string[] | undefined; resume: boolean }>,
          closed: 0,
          frameInterval: 70,
          ...(mode === 'metadata-covered' ? { snapshotDelay: 1300 } : {}),
        }
        nativeBodyScripts.set(sessionId, script)
        const { invitation } = await owner.json<{ invitation: { payload: string } }>('native/pairings', { method: 'POST', body: {} })
        const result = await invoke({
          operation: 'nativeWorkspace',
          bodyScript: mode,
          sessionId,
          payload: invitation.payload,
          port: host.host.nativePort,
        })
        const output = join(root, 'test-results/native-ledger')
        await mkdir(output, { recursive: true })
        await writeFile(join(output, `${mode}.json`), JSON.stringify(result, null, 2))
        if (mode === 'ledger-state') {
          expect(result).toEqual({
            tailSurvivesOldWrite: true,
            tailCursorKept: true,
            nilKeepsLastCursor: true,
            metadataBarrierKept: true,
            appliedNoticeIdentityKept: true,
            httpDoesNotCoverSameRevisionStream: true,
            streamReceiptCovers: true,
            metadataStillBounded: true,
            resetClearsProof: true,
            closedRefused: true,
          })
          return
        }
        expect(result.storageTimedOut).toBe(false)
        expect(result.repaired).toBe(false)
        expect(result.receiptRefused).toBe(false)
        expect(result.cursor).toBe(9)
        if (mode === 'metadata-covered') expect(result.cursorHeldBeforeMetadata).toBe(true)
      } finally {
        nativeBodyScripts.delete(sessionId)
        await host.close()
      }
    },
    30_000,
  )

  it.each([
    'metadata',
    'metadata-retry',
    'detail-retry',
    'overflow',
    'repair',
    'opening',
    'reconnect',
    'scope',
    'scope-no-view',
    'host-state',
  ] as const)(
    'keeps native publication barriers bounded and repairs the actual reader once: %s',
    async mode => {
      const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
      let sessionId = ''
      try {
        const owner = await host.enroll({ listener: 'unix' })
        ;({ sessionId } = await owner.json<{ sessionId: string }>('tasks', {
          method: 'POST',
          body: { mode: 'chat', prompt: 'Native ordering fixture', requestId: randomUUID() },
        }))
        await expect.poll(async () => (await owner.json<{ summary: { status: string } }>(`tasks/${sessionId}`)).summary.status).toBe('idle')
        const actual = await owner.json<{ sync: { instanceId: string; revision: number } }>(`tasks/${sessionId}`)
        const snapshot = await owner.json<{ revision: number }>('snapshot')
        const vectors = JSON.parse(await readFile(join(root, 'packages/testkit/vectors/task-delta-v1.json'), 'utf8')) as {
          streams: Array<{ actions: Array<{ frame: Record<string, unknown> }> }>
        }
        const base = vectors.streams[0]!.actions[0]!.frame as Record<string, unknown> & {
          detail: { summary: Record<string, unknown> }
          stream: Record<string, unknown>
        }
        const delta = vectors.streams[0]!.actions[1]!.frame
        const instanceId = actual.sync.instanceId,
          revision = snapshot.revision + 20
        base.detail.summary.id = sessionId
        const full = (sequence: number, incremental = true) => ({
          ...base,
          instanceId,
          sessionId,
          revision: revision + sequence,
          ...(incremental ? { stream: { ...base.stream, stateSeq: sequence } } : { stream: undefined }),
        })
        const bad = { ...delta, instanceId, sessionId, revision: revision + 2, baseSeq: 99 }
        const refresh = { type: 'refresh', instanceId, revision: snapshot.revision }
        const lifecycle = { type: 'host-state', instanceId, state: 'awake', at: '2026-11-14T00:00:00.000Z' }
        const first =
          mode === 'host-state'
            ? [{ ...lifecycle, instanceId: 'another-host' }, lifecycle, full(1)]
            : mode === 'metadata' || mode === 'metadata-retry' || mode === 'detail-retry'
              ? [refresh, full(1), { ...delta, instanceId, sessionId, revision: revision + 2 }]
              : mode === 'overflow'
                ? [refresh, ...Array.from({ length: 8 }, (_, index) => full(index + 1))]
                : ['opening', 'scope', 'scope-no-view', 'reconnect'].includes(mode)
                  ? [full(1)]
                  : [full(1), bad]
        const fallback = mode === 'repair' ? [full(10, false), bad] : [full(10, false)]
        const wire = (frames: Array<Record<string, unknown>>, offset = 0) =>
          frames.map(
            (frame, index) =>
              `${frame.type === 'host-state' ? '' : `id: ${instanceId}:${offset + index + 1}\n`}event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`,
          )
        const script = {
          details: [{ ...base.detail, liveText: 'Old HTTP body', sync: { instanceId, revision: actual.sync.revision } }],
          streams: [wire(first), wire(fallback, 20)],
          opened: [] as Array<{ delta: string | string[] | undefined; resume: boolean }>,
          closed: 0,
          ...(['metadata', 'overflow'].includes(mode) ? { snapshotDelay: 250 } : {}),
        }
        if (mode === 'opening') Object.assign(script, { delays: [300, 0] })
        if (mode === 'metadata-retry') Object.assign(script, { snapshotFailures: 1 })
        if (mode === 'detail-retry')
          Object.assign(script, {
            beforeSnapshot: async () => {
              nativeReadFaults.set(`GET /link/api/tasks/${sessionId}`, [{ status: 503, code: 'fixture-read' }])
            },
          })
        if (mode === 'reconnect')
          Object.assign(script, {
            details: [10, 20, 1, 21].map(offset => ({ ...base.detail, sync: { instanceId, revision: revision + offset } })),
          })
        if (mode === 'scope' || mode === 'scope-no-view')
          Object.assign(script, {
            beforeSnapshot: async (deviceId: string) => {
              expect((await owner.request(`devices/${deviceId}`, { method: 'PATCH', body: { dataScope: 'work' } })).status).toBe(200)
              if (mode === 'scope-no-view') {
                nativeBodyScripts.get(sessionId)!.beforeSnapshot = async () => {
                  expect((await owner.request(`devices/${deviceId}`, { method: 'DELETE' })).status).toBe(200)
                }
              }
            },
          })
        nativeBodyScripts.set(sessionId, script)
        const { invitation } = await owner.json<{ invitation: { payload: string } }>('native/pairings', { method: 'POST', body: {} })
        const result = await invoke({
          operation: 'nativeWorkspace',
          bodyScript: mode,
          sessionId,
          payload: invitation.payload,
          port: host.host.nativePort,
        })
        if (mode === 'overflow') expect(result).toMatchObject({ cause: 'ledger', pending: 8, covered: 0 })
        if (mode === 'repair') expect(result).toMatchObject({ cause: 'projection', pending: 1, covered: 0 })
        if (mode === 'metadata' || mode === 'metadata-retry' || mode === 'detail-retry') {
          expect(result).toMatchObject({ cursorHeld: true, metadataOnly: true, text: '中🙂文', cursor: 3 })
          expect(result.metadataMs).toBeGreaterThanOrEqual(240)
          expect(script.opened).toEqual([{ delta: 'delta-v1', resume: false }])
          if (mode === 'metadata-retry') expect(nativeBodyScripts.get(sessionId)?.snapshotReads).toBe(2)
          if (mode === 'detail-retry') {
            const deviceId = nativeBodyScripts.get(sessionId)?.deviceId
            expect(
              nativeSeen.filter(
                item => item.deviceId === deviceId && item.method === 'GET' && item.path === `/link/api/tasks/${sessionId}`,
              ),
            ).toHaveLength(2)
          }
        } else if (mode === 'host-state') {
          expect(result).toEqual({ foreignIgnored: true, state: 'awake', noLifecycleAck: true, cursor: 3 })
          expect(script.opened).toEqual([{ delta: 'delta-v1', resume: false }])
        } else if (mode === 'opening') {
          expect(result).toEqual({ lateOpeningRejected: true, currentReaderApplied: true })
          expect(script.opened).toEqual([
            { delta: 'delta-v1', resume: false },
            { delta: 'delta-v1', resume: false },
          ])
        } else if (mode === 'reconnect') {
          expect(result).toEqual({
            oldConnectionRejected: true,
            revisionFloorKept: true,
            newerAccepted: true,
            restoredWithoutSigning: true,
          })
          expect(script.opened).toEqual([])
        } else if (mode === 'scope') {
          expect(result).toEqual({
            scope: 'work',
            oldOfferWithdrawn: true,
            oldReadingRejected: true,
            newPublicReadingAllowed: true,
            scopeReason: true,
            windowKept: true,
            noNewSignatures: true,
            expiredWins: true,
            pendingUnchanged: true,
          })
          expect(script.opened).toEqual([{ delta: undefined, resume: false }])
        } else if (mode === 'scope-no-view') {
          expect(result).toEqual({ scopeReason: true, metadataRefused: true, noNewSignatures: true, pendingUnchanged: true })
          const deviceId = nativeBodyScripts.get(sessionId)?.deviceId
          expect(
            nativeSeen.filter(item => item.deviceId === deviceId && item.method === 'GET' && item.path === `/link/api/tasks/${sessionId}`),
          ).toEqual([])
        } else {
          const { repairMs, metadataCancelled, ...facts } = result
          expect(facts).toEqual({
            updates: mode === 'overflow' ? 7 : 1,
            repaired: true,
            oldOfferInvalidated: true,
            fallbackApplied: true,
            secondFailureStops: mode === 'repair',
            cause: mode === 'overflow' ? 'ledger' : 'projection',
            pending: mode === 'overflow' ? 8 : 1,
            covered: 0,
            coveredPrefixCount: 0,
            firstUncoveredKind: mode === 'overflow' ? 'snapshot' : 'body',
          })
          if (mode === 'overflow') {
            expect(repairMs).toBeGreaterThan(0)
            expect(metadataCancelled).toBe(true)
            expect(nativeBodyScripts.get(sessionId)?.delayedMetadata).toEqual({ started: 1, delivered: 0 })
          } else expect([repairMs, metadataCancelled]).toEqual([undefined, undefined])
          expect(script.opened).toEqual([
            { delta: 'delta-v1', resume: false },
            { delta: undefined, resume: false },
          ])
        }
        await expect
          .poll(() => script.closed)
          .toBe(
            mode === 'reconnect'
              ? 0
              : ['metadata', 'metadata-retry', 'detail-retry', 'scope', 'scope-no-view', 'host-state'].includes(mode)
                ? 1
                : 2,
          )
        if (mode === 'opening') expect(nativeBodyScripts.get(sessionId)?.closedBeforeData).toEqual([true, false])
        const output = join(root, 'test-results/native-body-publication')
        await mkdir(output, { recursive: true })
        await writeFile(
          join(output, `${mode}.json`),
          JSON.stringify({ ...result, readers: script.opened, closed: script.closed }, null, 2) + '\n',
        )
      } finally {
        nativeBodyScripts.delete(sessionId)
        await host.close()
      }
    },
    30_000,
  )

  it('discards a native stream probe after its reading intent changed and never probes explicit expiry', async () => {
    expect(await invoke({ operation: 'phoneStreamRecovery' })).toEqual({
      actions: ['contentExpired', 'eventOverflow', 'reconnect'],
      probes: 1,
      staleBefore: true,
      staleAfter: true,
      cancelled: true,
    })
  })
  it('bounds native body read retries to one and cancels them when the current reading disappears', async () => {
    expect(await invoke({ operation: 'phoneBodyReadRetry' })).toEqual({
      attempts: [2, 2, 1, 1, 1, 1],
      failures: ['unavailable', 'failed', 'agentWriteUnknown', 'forbidden', 'expired', 'cancelled'],
    })
  })
  it.each(['end', 'server', 'transport', 'metadata', 'invalid'] as const)(
    'checks the same native connection before treating an %s event failure as offline',
    async failure => {
      const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
      try {
        const owner = await host.enroll({ listener: 'unix' })
        const { invitation } = await owner.json<{ invitation: { payload: string } }>('native/pairings', { method: 'POST', body: {} })
        nativeEventFaults.push(failure)
        const retry = failure === 'end' || failure === 'server'
        expect(
          await invoke(
            { operation: 'nativeWorkspace', eventRecovery: true, payload: invitation.payload, port: host.host.nativePort },
            25_000,
          ),
        ).toEqual({
          eventFailure: 'unavailable',
          leaseStillValid: true,
          metadataRead: retry,
          action: retry ? 'retryEvents' : 'reconnect',
          resumed: retry,
          pending: 1,
          samePending: true,
        })
        expect((await owner.json<{ tasks: unknown[] }>('snapshot')).tasks).toEqual([])
      } finally {
        nativeEventFaults.splice(0)
        nativeReadFaults.delete('GET /link/api/snapshot')
        await host.close()
      }
    },
    30_000,
  )
  it('reads, writes and stops from the actual Swift workspace against a real Host', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const response = await (await host.enroll({ listener: 'unix' })).request('native/pairings', { method: 'POST', body: {} })
      const { invitation } = (await response.json()) as { invitation: { payload: string } }
      const result = await invoke({ operation: 'nativeWorkspace', payload: invitation.payload, port: host.host.nativePort })
      expect(result).toEqual({
        windowRequired: true,
        sameRequest: true,
        cachedList: true,
        pendingCleared: true,
        controlRecovery: true,
        strictControl: true,
        phoneWorkspace: true,
        assistantWrite: true,
      })
      expect((await owner.json<{ tasks: unknown[] }>('snapshot')).tasks).toEqual([])
    } finally {
      await host.close()
    }
  }, 30_000)
  it('judges other computers\u2019 等你处理, names and menu words as the phone list and the desktop do', async () => {
    const at = (minute: number) => `2026-11-01T10:${String(minute).padStart(2, '0')}:00.000Z`
    const long = `${'长'.repeat(79)}\u202e尾巴还有`
    const tasks = [
      {
        id: 'a',
        title: '等批准',
        status: 'waiting-approval',
        updatedAt: at(1),
        cwd: '/secret',
        live: { lastEventAt: at(5), activity: 'tool', detail: 'x' },
      },
      { id: 'b', title: '问一句', status: 'running', pendingQuestions: 1, updatedAt: at(2), live: { lastEventAt: at(6) } },
      { id: 'c', title: '安静', status: 'running', updatedAt: at(3), live: { silent: true, lastEventAt: at(3) } },
      {
        id: 'd',
        title: '卡住',
        status: 'running',
        updatedAt: at(4),
        live: { unrecognized: { at: at(9), method: 'x' }, lastEventAt: at(8) },
      },
      { id: 'e', title: '正在停', status: 'waiting-approval', updatedAt: at(7), live: { activity: 'cancelling' } },
      { id: 'f', title: '在跑', status: 'running', updatedAt: at(8), live: { lastEventAt: at(8) } },
      { id: 'g', title: '归档了', status: 'waiting-approval', updatedAt: at(9), archived: true },
      { id: 'bad id!', title: '格式不对', status: 'waiting-approval', updatedAt: at(9) },
      { id: 'h', title: long, status: 'waiting-approval', updatedAt: at(10) },
      ...Array.from({ length: 60 }, (_, index) => ({
        id: `w${index}`,
        title: `第 ${index} 个`,
        status: 'waiting-approval',
        updatedAt: at(0),
      })),
    ]
    const result = (await invoke({
      operation: 'phoneComputers',
      snapshot: {
        instanceId: 'i',
        revision: 3,
        device: { id: 'dev', status: 'active', scopes: ['view'] },
        tasks,
        approvals: [{ id: 'x' }],
      },
      computers: [
        { id: 'a', hostId: 'aaaa1111', name: 'build-mini' },
        { id: 'b', hostId: 'bbbb2222', name: 'Build-Mini' },
        { id: 'c', hostId: 'cccc3333', name: 'build-m\u0456ni' },
        { id: 'd', hostId: 'dddd4444', name: '王的 MacBook' },
        { id: 'e', hostId: 'eeee5555', name: 'studio' },
      ],
      readings: [
        { id: 'on', name: 'studio', state: 'online', list: { tasks } },
        { id: 'off', name: 'mini', state: 'offline', list: { tasks: tasks.slice(0, 2) } },
        { id: 'gone', name: 'old', state: 'revoked', list: { tasks } },
        { id: 'wrong', name: 'other', state: 'wrong-host', list: { tasks } },
        { id: 'quiet', name: 'quiet', state: 'online', list: { tasks: tasks.slice(5, 6) } },
      ],
    })) as Record<string, unknown> & { items: Array<{ id: string; kind: string; words: string }>; titleLengths: number[] }
    // The same rule as the phone's own 等你处理, newest first, at most 50, the ones it cannot open left out.
    expect(result.items).toHaveLength(50)
    expect(new Set(result.items.map(item => item.id))).toEqual(
      new Set((result.sessionsWaiting as string[]).filter(id => id !== 'bad id!').slice(0, 50)),
    )
    expect(result.items.slice(0, 5).map(item => [item.id, item.kind, item.words])).toEqual([
      ['h', 'approval', '审批'],
      ['d', 'stuck', '没有动静'],
      ['b', 'question', '问题'],
      ['a', 'approval', '审批'],
      ['c', 'stuck', '没有动静'],
    ])
    expect(result.items.map(item => item.id)).not.toContain('e')
    expect(Math.max(...result.titleLengths)).toBe(80)
    expect((result.items[0] as unknown as { title: string }).title).toBe(`${'长'.repeat(79)}尾`)
    expect(result.names).toEqual({
      a: 'build-mini aaaa',
      b: 'Build-Mini bbbb',
      c: 'build-m\u0456ni cccc',
      d: '王的 MacBook',
      e: 'studio',
    })
    const clock = result.clock as string
    expect(result.states).toEqual(['正在连接', '在线', `不在线 · 上次在线 ${clock}`, '已被移除', '不是这台电脑', '正在连接'])
    expect(result.lines).toEqual(['在线 · 等你处理 2', `不在线 · 上次在线 ${clock} · 离线前 3 项`, '已被移除', '在线'])
    expect(result.groups).toEqual([
      { id: 'on', name: 'studio', live: true, count: 50 },
      { id: 'off', name: 'mini', live: false, count: 2 },
    ])
    expect([result.freshFirst, result.freshSame, result.freshNew]).toEqual([false, false, true])
    expect(result.body).toBe('Build-Mini bbbb · 有新的等你处理')
    // The list keeps the rows 等你处理 is judged from: no path, detail or approval.
    const rows = result.rows as { tasks: Array<Record<string, unknown>>; approvals?: unknown }
    expect(rows.approvals).toBeUndefined()
    expect(rows.tasks[0]).toEqual({
      id: 'a',
      title: '等批准',
      status: 'waiting-approval',
      updatedAt: at(1),
      live: { lastEventAt: at(5), activity: 'tool' },
    })
    expect(rows.tasks[3]).toEqual({
      id: 'd',
      title: '卡住',
      status: 'running',
      updatedAt: at(4),
      live: { unrecognized: { at: at(9) }, lastEventAt: at(8) },
    })
    // The App's guards: another watch's token, the selected computer and an unwatched one are dropped; the first reading
    // is a baseline; a switch drops late readings and forgets the selected computer's, so coming back does not notify.
    expect(result.desk).toEqual([
      'dropped',
      'dropped',
      'dropped',
      'kept',
      'kept',
      'notify:y',
      'kept',
      'dropped',
      'dropped',
      'pruned',
      'kept',
      'kept',
      'offline',
    ])
    // A notification leads once, to its own computer and session; a removed computer's lead nowhere; at most 32 kept.
    expect(result.notices).toEqual(['b/s1', 'none', 'none', 'none', 'none'])
  })
  it('watches two real Hosts read-only, one at a time, drops late snapshots, tells unreachable from not that computer, and opens B’s item on B', async () => {
    const first = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    const second = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    try {
      const hosts = []
      const owners = []
      for (const [host, title] of [
        [first, 'Alpha waits'],
        [second, 'Beta waits'],
      ] as const) {
        const owner = await host.enroll({ listener: 'unix' })
        await owner.json('tasks', { method: 'POST', body: { mode: 'chat', prompt: title, requestId: randomUUID() } })
        hosts.push({ port: host.host.nativePort })
        owners.push(owner)
      }
      let before: Array<{ tasks: Array<{ id: string; status: string }> }> = []
      let result: Record<string, unknown> = {}
      nativeSeen.length = 0
      // A Host keeps one pairing sheet at a time: each code is written once the previous one has made its device.
      const codeDir = await mkdtemp(join(tmpdir(), 'latch-watch-codes-'))
      const running = invoke({ operation: 'nativeListWatcher', hosts, codeDir }, 90_000)
      try {
        for (const [index, host] of [first, second].entries())
          for (const name of [`watcher-${index}`, `opener-${index}`]) {
            const before = host.host.security.devices.nativeCandidates().length
            const { invitation } = await owners[index]!.json<{ invitation: { payload: string } }>('native/pairings', {
              method: 'POST',
              body: {},
            })
            await writeFile(join(codeDir, name), invitation.payload, { mode: 0o600 })
            await vi.waitFor(() => expect(host.host.security.devices.nativeCandidates().length).toBe(before + 1), { timeout: 20_000 })
            // The device exists a moment before its sheet is marked done; a code made sooner would join that sheet.
            await new Promise(done => setTimeout(done, 500))
          }
        // B has a session waiting for a decision, from the fake ACP Agent; only now, since one holds back pairing.
        const ownerB = owners[1]!
        await ownerB.confirmedJson('agents', {
          method: 'POST',
          body: { id: 'fake', name: 'Fake agent', command: process.execPath, args: [FAKE_ACP_AGENT] },
        })
        const started = await ownerB.json<{ sessionId: string }>('tasks', {
          method: 'POST',
          body: { harnessId: 'fake', mode: 'agent', prompt: 'permission', requestId: randomUUID() },
        })
        await vi.waitFor(
          async () => {
            const { tasks } = await ownerB.json<{ tasks: Array<{ id: string; status: string }> }>('snapshot')
            expect(tasks.find(task => task.id === started.sessionId)?.status).toBe('waiting-approval')
          },
          { timeout: 15_000 },
        )
        before = await Promise.all(owners.map(owner => owner.json<{ tasks: Array<{ id: string; status: string }> }>('snapshot')))
        await writeFile(join(codeDir, 'waiting'), started.sessionId)
        result = await running
      } finally {
        await running.catch(() => {})
        await rm(codeDir, { recursive: true, force: true })
      }
      expect(result).toMatchObject({
        alternated: true,
        oneConnection: true,
        ownLists: true,
        lateDropped: true,
        silentAfterClose: true,
        secondOnline: false,
        networkClosed: true,
        down: 'offline',
        wrongRoot: 'offline',
        notThat: 'wrong-host',
        notThatEmpty: true,
        backedOff: true,
        seenOnB: true,
        openedOnB: true,
        notOnA: true,
        readOnly: true,
      })
      // What the Hosts received from the watching devices: these two reads only, no write, no event stream, no window.
      const watchers = new Set(result.watcherDevices as string[])
      const sent = nativeSeen.filter(entry => watchers.has(entry.deviceId))
      expect(sent.length).toBeGreaterThan(4)
      expect(new Set(sent.map(entry => `${entry.method} ${entry.path}`))).toEqual(
        new Set(['GET /link/api/native/revocation', 'GET /link/api/snapshot']),
      )
      for (const [index, owner] of owners.entries()) {
        const after = await owner.json<{ tasks: Array<{ id: string; status: string }> }>('snapshot')
        expect(after.tasks.map(task => [task.id, task.status])).toEqual(before[index]!.tasks.map(task => [task.id, task.status]))
        const { devices } = await owner.json<{ devices: Array<{ id: string; native?: { bodyVerifiedUntil?: string } }> }>('devices')
        const phone = devices.find(device => watchers.has(device.id))
        expect(phone).toBeDefined()
        expect(phone?.native?.bodyVerifiedUntil).toBeUndefined()
      }
    } finally {
      await first.close()
      await second.close()
    }
  }, 120_000)
  it('hands a removal over with its verified proof, never dials that computer again, and retires the profile with it', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const { invitation } = await owner.json<{ invitation: { payload: string } }>('native/pairings', { method: 'POST', body: {} })
      const result = await invoke(
        { operation: 'nativeListWatcherRevoked', payload: invitation.payload, port: host.host.nativePort },
        30_000,
      )
      expect(result).toEqual({ proof: true, dialledOnce: true, reportedOnce: true, retired: true, readOnly: true })
    } finally {
      await host.close()
    }
  }, 60_000)
  it('delegates to an Agent and writes its memories from the actual Swift workspace against a real Host', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const agent = await owner.json<{ id: string }>('custom-agents', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          name: '代码审阅',
          description: '只报真实的问题',
          harnessId: 'standard',
          mode: 'chat',
          instructions: 'AGENT INSTRUCTIONS',
          skills: [],
        },
      })
      const automation = await owner.json<{ id: string }>('automations', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          name: '每日检查',
          customAgentId: agent.id,
          prompt: '看一下',
          schedule: { kind: 'daily', time: '09:00' },
          notify: false,
        },
      })
      const response = await owner.request('native/pairings', { method: 'POST', body: {} })
      const { invitation } = (await response.json()) as { invitation: { payload: string } }
      const result = await invoke(
        {
          operation: 'nativeAgents',
          payload: invitation.payload,
          port: host.host.nativePort,
          agentId: agent.id,
          automationId: automation.id,
        },
        30_000,
      )
      expect(result).toEqual({
        delegated: true,
        sameSession: true,
        memoryReceipts: true,
        staleRefused: true,
        general: true,
        cachedTabs: true,
        proposalSaved: true,
        undone: true,
        scheduleSwitched: true,
        generalTopic: true,
      })
      const general = await owner.json<{ memories: Array<{ content: string }> }>('custom-agents/general')
      expect(general.memories.map(memory => memory.content)).toEqual(['回答用中文'])
    } finally {
      await host.close()
    }
  }, 30_000)
  it('runs a schedule now, shows its card and run, saves a schedule proposal after an unknown try and reads 动态 and 资料库 from the actual Swift workspace against a real Host', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    try {
      const owner = await host.enroll({ listener: 'unix' })
      // The fake ACP Agent: `shell-edit` writes files, `schedule …` proposes a schedule through the skills server.
      const saved = await owner.confirmed('agents', {
        method: 'POST',
        body: { id: 'fake-news', name: 'Fake News', command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_MCP: 'dsh' } },
      })
      expect(saved.status).toBe(201)
      const folder = join(host.root, 'news')
      await mkdir(folder, { recursive: true })
      expect((await owner.addFolders({ paths: [folder], name: 'news' })).status).toBeLessThan(300)
      const project = (await owner.json<{ workspaces: Array<{ id: string; name: string }> }>('workspaces')).workspaces.find(
        item => item.name === 'news',
      )!
      const agent = await owner.json<{ id: string }>('custom-agents', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          name: '资讯',
          description: '整理新闻',
          harnessId: 'fake-news',
          mode: 'agent',
          defaultProjectId: project.id,
        },
      })
      const automation = await owner.json<{ id: string }>('automations', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          name: '早间精选',
          customAgentId: agent.id,
          enabled: false,
          projectId: project.id,
          prompt: 'shell-edit',
          schedule: { kind: 'daily', time: '09:00' },
          notify: false,
        },
      })
      const response = await owner.request('native/pairings', { method: 'POST', body: {} })
      const { invitation } = (await response.json()) as { invitation: { payload: string } }
      // The phone's first schedule save never reaches the Host.
      nativeDrop.add('POST /link/api/automations')
      const result = await invoke(
        {
          operation: 'nativeAgentActivity',
          payload: invitation.payload,
          port: host.host.nativePort,
          agentId: agent.id,
          automationId: automation.id,
        },
        60_000,
      )
      expect(result).toEqual({
        ranOnce: true,
        card: true,
        openRun: true,
        unknownThenRetry: true,
        proposalSaved: true,
        decided: true,
        activity: true,
        library: true,
        private: true,
      })
      expect(nativeDrop.size).toBe(0)
    } finally {
      nativeDrop.clear()
      await host.close()
    }
  }, 90_000)
  it('reads 「电脑」 with a missed time, runs it now, and changes the switches from the actual Swift workspace against a real Host', async () => {
    // The Host's clock, moved past a scheduled time while the Mac "sleeps", before the phone pairs.
    let shift = 0
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 }, now: () => Date.now() + shift })
    const report = (body: unknown) => host.raw('unix', 'api/host/state', { method: 'POST', body })
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const saved = await owner.confirmed('agents', {
        method: 'POST',
        body: { id: 'fake-agent', name: 'Fake Agent', command: process.execPath, args: [FAKE_ACP_AGENT] },
      })
      expect(saved.status).toBe(201)
      const agent = await owner.json<{ id: string }>('custom-agents', {
        method: 'POST',
        body: { requestId: randomUUID(), name: '晨报助手', description: '每天早上写一页晨报', harnessId: 'standard' },
      })
      const at = new Date(Date.now() + 10 * 60_000)
      const pad = (value: number) => String(value).padStart(2, '0')
      const automation = await owner.json<{ id: string; nextRunAt: string }>('automations', {
        method: 'POST',
        body: {
          requestId: randomUUID(),
          name: '晨报',
          customAgentId: agent.id,
          prompt: '写今天的晨报',
          schedule: { kind: 'daily', time: `${pad(at.getHours())}:${pad(at.getMinutes())}` },
          notify: false,
        },
      })
      expect((await report({ state: 'sleeping' })).status).toBe(200)
      shift = Date.parse(automation.nextRunAt) - Date.now() + 5 * 60_000
      await expect
        .poll(async () => (await owner.json<{ missed: unknown[] }>(`custom-agents/${agent.id}/computer`)).missed.length, {
          timeout: 15_000,
        })
        .toBe(1)
      expect((await report({ state: 'awake' })).status).toBe(200)
      // Back to the real clock for the phone's pairing and window; the missed time and its cause are recorded.
      shift = 0
      const response = await owner.request('native/pairings', { method: 'POST', body: {} })
      const { invitation } = (await response.json()) as { invitation: { payload: string } }
      // The phone's first change of 通知 never reaches the Host.
      nativeDrop.add(`PATCH /link/api/custom-agents/${agent.id}`)
      const result = await invoke(
        {
          operation: 'nativeAgentComputer',
          payload: invitation.payload,
          port: host.host.nativePort,
          agentId: agent.id,
          automationId: automation.id,
        },
        60_000,
      )
      expect(result).toEqual({ missed: true, notifications: true, changed: true, unknownThenRetry: true, ranNow: true, private: true })
      expect(nativeDrop.size).toBe(0)
      const stored = (
        await owner.json<{ customAgents: Array<{ id: string; notifications?: unknown; keepAwakeForSchedules?: boolean }> }>('snapshot')
      ).customAgents.find(item => item.id === agent.id)!
      expect(stored.notifications).toEqual({ completed: false, failed: true, waiting: true })
      expect(stored.keepAwakeForSchedules).toBe(true)
    } finally {
      nativeDrop.clear()
      await host.close()
    }
  }, 90_000)

  it('stops a subagent, steers, retries, forks, changes a setting, clears context, searches and manages sessions from the actual Swift workspace', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    try {
      const owner = await host.enroll({ listener: 'unix' })
      // This Host looks up no command by name, so no agent installed on this computer can be found or started.
      await owner.confirmedJson('agents', {
        method: 'POST',
        body: {
          id: 'fake',
          name: 'Fake agent',
          command: process.execPath,
          args: [FAKE_ACP_AGENT],
          env: {
            FAKE_ACP_STATE: join(host.root, 'acp-state.json'),
            FAKE_ACP_CAPS: 'steer',
            FAKE_ACP_MODES: 'read-only,auto',
            FAKE_ACP_CONFIG: 'options',
          },
        },
      })
      const response = await owner.request('native/pairings', { method: 'POST', body: {} })
      const { invitation } = (await response.json()) as { invitation: { payload: string } }
      const result = await invoke({ operation: 'nativeActions', payload: invitation.payload, port: host.host.nativePort })
      expect(result).toEqual({
        window: true,
        subagent: true,
        steer: true,
        retry: true,
        fork: true,
        config: true,
        clear: true,
        search: true,
        menu: true,
      })
      expect((await owner.json<{ tasks: unknown[] }>('snapshot')).tasks).toEqual([])
    } finally {
      await host.close()
    }
  }, 60_000)
  it('holds a write as unknown on the phone only when the Host may have taken it: the same 5xx rule as the page', async () => {
    const result = await invoke({ operation: 'phoneRefusals' })
    expect(result.notAccepted).toEqual([...NOT_ACCEPTED_5XX].sort())
    // agent-start-failed, agent-refused and a handshake timeout accepted nothing; other 5xx and 408 are unknown; 4xx is definite.
    expect(result.unknown).toEqual([false, false, false, true, true, true, false, true])
    expect(result.refusal).toBe('Flaky Agent 启动失败：进程退出（退出码 1）')
    expect(result.bare).toEqual([true, true])
  })
  it('derives the composer’s attachment decisions: reasons, limits, refusal classes, the tray and metadata-free images', async () => {
    const result = await invoke({ operation: 'phoneAttachments' })
    // The Host's own limits per kind: a file over one stream goes in parts.
    expect(result.limits).toEqual(['图片 5 MB 内 · 文字文件 256 KB 内 · 每条 8 个', '文字文件 10 MB 内 · 每条 8 个', ''])
    expect(result.unavailable).toEqual([
      '',
      '这个 Harness 不接收图片和文件。',
      '这个 Harness 不接收图片和文件。',
      '正在读取这个 Harness 能收的附件…',
      '没能读取这个 Harness 能收的附件，稍后再试。',
    ])
    expect(result.revision).toEqual(['ready:-', 'ready:'])
    expect(result.malformedCaps).toBe(true)
    expect(result.kinds).toEqual(['image', 'image', 'text', 'text', 'text', '-', '-', '-'])
    expect(result.admit).toEqual([
      'ok',
      '「big.log」超过 256 KB，没有添加。可以添加：图片 5 MB 内 · 文字文件 256 KB 内 · 每条 8 个。',
      '「huge.log」超过 10 MB，没有添加。可以添加：文字文件 10 MB 内 · 每条 8 个。',
      // An original larger than the image limit is re-encoded first; only one past what the phone reads is refused.
      'ok',
      '「IMG_2.heic」超过 50 MB，没有添加。可以添加：图片 5 MB 内 · 文字文件 256 KB 内 · 每条 8 个。',
      '这个 Harness 不接收图片。',
      '「deck.pdf」不能添加：只收图片和文字文件。',
      '空文件不能添加。',
      '每条消息最多添加 8 个附件。',
      '这个 Harness 不接收图片和文件。',
    ])
    expect(result.admitBytes).toEqual([
      '「nul.txt」不是 UTF-8 文字文件，没有添加。',
      '「latin.txt」不是 UTF-8 文字文件，没有添加。',
      'ok',
      '「big.jpg」超过 5 MB，没有添加。可以添加：图片 5 MB 内 · 文字文件 256 KB 内 · 每条 8 个。',
    ])
    expect(result.classes).toEqual(['refused', 'refused', 'refused', 'retry', 'released', 'confirm', 'retry'])
    expect(result.heldBack).toEqual(['排队的消息不能带附件，本轮结束后再发送。', '追加的消息不能带附件，本轮结束后再发送。', '', ''])
    // A pick that yields nothing always says why; only a cancel is silent.
    expect(result.picks).toEqual(['', '没有收到选中的文件，请再选一次。', '没有收到选中的文件，请再选一次。', ''])
    expect(result.startSelection).toEqual([
      '{"harnessId":"fake","mode":"agent","model":{"model":"m","providerId":"p"},"workspaceId":"default"}',
      'none',
    ])
    expect(result.names).toEqual(['IMG_0001.jpg', 'gpj.txt', '图片.png'])
    // The file and camera paths keep pixels only; the picker's copy is gone after one read; nothing else is written.
    expect(result.loader).toEqual({
      file: [],
      fileName: 'IMG_9001.jpg',
      camera: [],
      cameraName: '照片.jpg',
      bigRead: false,
      bigSize: 300000,
      left: ['note.md'],
      purged: 2,
      afterPurge: [],
    })
    expect(result.hugeImage).toBe('图片超过 4000 万像素，没有添加。')
    expect(result.keys).toEqual(['~new', '~topic:agt_1', 'ses_1'])
    expect(result.locked).toEqual([true, false, true, false, true])
    // Closing the sheet lets go only when nothing is starting, opening, covering it or unconfirmed for it.
    expect(result.dropsOnClose).toEqual([true, false, false, false, false, true])
    expect(result.send).toEqual(['moved', 'moved', 'snd0000000000000000000', 'gone'])
    expect(result.trayAdded).toBe(8)
    expect(result.trayNote).toBe('每条消息最多添加 8 个附件。')
    expect(result.tray).toEqual({
      waiting: true,
      ready: 8,
      mismatch: true,
      statuses: [
        'refused:当前 Harness 只接受 256 KB 以内的文本附件。',
        'failed:附件上传已中断。',
        'unknown',
        'failed:上传已取消，可以重试。',
        'confirm:这个文件可能含有密钥。',
      ],
      blocked: true,
      removed: 'att0000000000000000000',
      released: ['已在 设置 › 设备 里释放，请移除后重新添加'],
      cleared: 7,
      empty: true,
      badRef: true,
    })
    expect(result.header).toEqual({
      keys: ['name', 'requestId', 'selection', 'sessionId', 'size'],
      requestId: true,
      size: 10,
      selection: ['harnessId', 'mode', 'workspaceId'],
      mode: 'agent',
    })
    expect(result.pendingCount).toBe(2)
    expect(result.memory).toEqual({
      unfinishedBefore: 2,
      dropped: true,
      smaller: true,
      unfinishedAfter: 1,
      removedUpload: true,
      staged: ['等待上传的附件已占用 48 MB，请先发送或移除一些附件。', 'ok'],
    })
    // A GIF is listed but not previewed: Quick Look stays with text and PNG/JPEG; a malformed reference is left out.
    expect(result.chips).toEqual(['shot.png|true|200 KB|true', 'anim.gif|true|1 KB|false'])
    expect(result.image).toEqual({
      sourceMetadata: ['gps', 'make', 'comment'],
      metadata: [],
      ext: 'jpg',
      fits: true,
      // Noise is the worst case for JPEG: it steps down from 2048 until it fits.
      longSide: 1600,
      alphaExt: 'png',
      alphaMetadata: [],
      tooBig: true,
    })
  })
  it('uploads in bounded chunks and in parts, resumes and aborts by requestId, sends with a message and reads back from the actual Swift workspace', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    try {
      const owner = await host.enroll({ listener: 'unix' })
      for (const [id, caps] of [
        ['fake', 'images,embedded'],
        ['plain', ''],
      ])
        await owner.confirmedJson('agents', {
          method: 'POST',
          body: { id, name: id, command: process.execPath, args: [FAKE_ACP_AGENT], env: { FAKE_ACP_CAPS: caps } },
        })
      const response = await owner.request('native/pairings', { method: 'POST', body: {} })
      const { invitation } = (await response.json()) as { invitation: { payload: string } }
      const result = await invoke({ operation: 'nativeAttachments', payload: invitation.payload, port: host.host.nativePort }, 60_000)
      expect(result).toEqual({
        window: true,
        freshReason: '发出第一条消息后可添加文件',
        reported: 'ready:it',
        caps: '图片 5 MB 内 · 文字文件 10 MB 内 · 每条 8 个',
        sameRequest: true,
        cancel: true,
        oversize: true,
        chunked: { kept: true, again: true },
        largeImage: true,
        resume: { unknown: true, fromPart: true, kept: true },
        cancelParts: { stopped: true, fromStart: true, kept: true },
        leftovers: { secret: 'attachment-secret', secretNamed: true, earlyStopped: true },
        sent: ['IMG_0001.jpg', 'notes.md'],
        readBack: true,
        plainReason: '这个 Harness 不接收图片和文件。',
        plainRefusal: 'attachments-unsupported:refused',
        earlyRefusal: 'attachments-unsupported',
        cancelMid: { stopped: true, afterCancel: 0, partial: true },
        queue: 'queue-attachments-unsupported',
      })
      // Nothing the phone began is left unfinished on the Host: every cancel and removed row aborted its upload.
      const folder = join(host.dataDir, 'attachments', '_uploads')
      const records = await Promise.all(
        (await readdir(folder)).map(
          async name => JSON.parse(await readFile(join(folder, name, 'meta.json'), 'utf8')) as Record<string, unknown>,
        ),
      )
      expect(records.filter(record => !record.done && !record.failed)).toEqual([])
    } finally {
      await host.close()
    }
  }, 90_000)
  it('runs the App’s stop and search flows: a refused stop clears, and no earlier query’s hits show under a new one', async () => {
    const result = await invoke({ operation: 'phoneFlows' })
    // Refused: cleared. Answered: kept until the Host settles it. Pressed again meanwhile: not sent. Another connection: untouched.
    expect(result.stops).toEqual(['failed:', 'ok:b', 'not sent:b', 'failed:bc'])
    expect(result.sent).toBe(3)
    // Five busy answers for a new query: an empty list with the Host's words, never the old query's hits.
    expect(result.busyOther).toEqual({
      loadingHits: [],
      hits: [],
      error: '正在完成一次正文搜索，请稍后再试。',
      asked: 5,
      paused: 4,
      loading: false,
    })
    // The same query keeps what it found.
    expect(result.busySame).toEqual({ loadingHits: ['old'], hits: ['old'], error: '', asked: 5, paused: 4, loading: false })
    expect(result.afterBusy).toEqual({ loadingHits: [], hits: ['new'], error: '', asked: 2, paused: 1, loading: false })
  })
  it('derives the session actions the phone offers and the writes it sends for them', async () => {
    const at = (minute: number) => `2026-11-01T10:${String(minute).padStart(2, '0')}:00.000Z`
    const result = await invoke({
      operation: 'phoneActions',
      subagents: [
        {
          message: { id: 's1', role: 'tool', subagent: { title: 'Test runner', status: 'running', stoppable: true, steps: [{ id: 'x' }] } },
          canStop: true,
        },
        {
          message: { id: 's2', role: 'tool', subagent: { title: 'Test runner', status: 'running', stoppable: true, steps: [] } },
          requested: true,
          canStop: true,
        },
        {
          message: { id: 's3', role: 'tool', subagent: { title: 'Linter', status: 'waiting', stopping: true, stoppable: true, steps: [] } },
          canStop: true,
        },
        { message: { id: 's4', role: 'tool', subagent: { title: 'Docs', status: 'done', steps: [] } }, canStop: true },
        { message: { id: 's5', role: 'tool', subagent: { title: 'Plain', stoppable: true, steps: [] } }, canStop: false },
        { message: { id: 's6', role: 'tool', toolName: 'shell' } },
      ],
      detail: {
        messages: [
          { id: 'm1', role: 'user', text: '[Latch] 撤销了上一轮的改动\n\n先读一下' },
          { id: 'm2', role: 'tool', state: 'completed', tool: { kind: 'read' } },
          { id: 'm3', role: 'assistant', text: '读完了' },
          { id: 'm4', role: 'user', text: '改一下' },
          { id: 'm5', role: 'tool', state: 'completed', tool: { kind: 'edit' }, startedAt: at(1) },
          { id: 'm6', role: 'tool', state: 'failed', tool: { kind: 'execute', output: 'exit 1' }, startedAt: at(1) },
          { id: 'm7', role: 'tool', state: 'running', tool: { kind: 'other' }, startedAt: at(1) },
          { id: 'm8', role: 'tool', state: 'failed', startedAt: null, tool: { kind: 'edit', decision: { outcome: 'rejected' } } },
          { id: 'm9', role: 'assistant', text: '改好了' },
        ],
      },
      resend: [
        { text: 'plain' },
        { text: '源会话的记录\n\n继续', forkContext: { prefixLength: 8 }, nativeFork: true },
        { text: '源会话的记录\n\n继续', forkContext: { prefixLength: 8 } },
        { text: '😀接着', importContext: { prefixLength: 2 } },
        { text: '[Latch] 只有说明' },
      ],
      followUps: [
        { status: 'idle', detail: {}, queues: true },
        { status: 'running', detail: { steer: true }, queues: false },
        { status: 'waiting-approval', detail: {}, queues: true },
        { status: 'running', detail: {}, queues: false },
      ],
      harness: { level: 'L3' },
      launchConfigs: [
        {
          summary: { mode: 'agent', level: 'L3' },
          config: [
            { id: 'thinking', category: 'thought_level', source: 'launch', currentValue: 'high', options: [{ value: 'high', name: '高' }] },
          ],
        },
        {
          summary: { mode: 'agent', level: 'L3' },
          permission: {
            modeTiers: {
              ask: { tier: 'plan', name: 'Ask' },
              plan: { tier: 'plan', name: 'Plan' },
              agent: { tier: 'ask', name: 'Agent' },
              force: { tier: 'never', name: 'Agent --force' },
            },
          },
          config: [
            {
              id: 'mode',
              category: 'mode',
              source: 'launch',
              currentValue: 'force',
              options: [
                { value: 'ask', name: 'Ask native' },
                { value: 'plan', name: 'Plan native' },
                { value: 'agent', name: 'Agent native' },
                { value: 'force', name: 'Force native' },
              ],
            },
          ],
        },
        {
          summary: { mode: 'agent', level: 'L3' },
          config: [{ id: 'thinking', category: 'thought_level', currentValue: 'high', options: [{ value: 'high', name: '高' }] }],
        },
      ],
      config: {
        summary: { mode: 'agent', level: 'L3' },
        permission: {
          modeTiers: {
            plan: { tier: 'plan' },
            default: { tier: 'ask', line: '每一步先问你' },
            edits: { tier: 'rule' },
            judge: { tier: 'model' },
            yolo: { tier: 'never' },
          },
        },
        config: [
          {
            id: 'mode',
            category: 'mode',
            currentValue: 'yolo',
            options: [
              { value: 'default', name: 'Default' },
              { value: 'plan', name: 'Plan' },
              { value: 'edits', name: 'Accept edits' },
              { value: 'judge', name: 'Auto' },
              { value: 'yolo', name: 'Bypass' },
              { value: 'odd', name: 'Odd' },
            ],
          },
          {
            id: 'model',
            category: 'model',
            currentValue: 'small',
            options: [
              { value: 'small', name: 'Small' },
              { value: 'large', name: 'Large' },
              { value: 'large', name: 'Again' },
            ],
          },
          { id: 'effort', category: 'thought_level', currentValue: 'high', options: [{ value: 'high', name: '高' }] },
          { id: 'other', category: 'model_config', currentValue: 'a', options: [{ value: 'a', name: 'A' }] },
        ],
      },
      menuTasks: [
        { id: 'a', title: '空闲', status: 'idle', offered: true },
        { id: 'b', title: '运行', status: 'running', pinned: true, offered: true },
        { id: 'c', title: '运行中清空', status: 'running', offered: true, clearing: true },
        { id: 'd', title: '已归档', status: 'idle', archived: true },
      ],
      catalog: {
        harnesses: [
          {
            id: 'standard',
            status: 'ready',
            modes: ['chat', 'agent'],
            capabilities: { models: { owner: 'latch' }, permission: { enforcement: 'latch' } },
          },
          { id: 'codex', status: 'ready', modes: ['agent'], capabilities: { models: { owner: 'harness' } } },
        ],
        workspaces: [
          { id: 'latch', name: 'latch' },
          { id: 'site', name: '官网' },
        ],
        providers: [{ id: 'p', name: 'P', models: ['m1', 'm2'] }],
        defaults: { harnessId: 'standard', workspaceId: 'latch', model: { providerId: 'p', model: 'm1' } },
      },
      forkSource: { harnessId: 'codex', workspaceId: 'site', mode: 'agent', providerId: 'p', model: 'm2' },
      forkCatalog: {
        harnesses: [
          {
            id: 'standard',
            status: 'ready',
            modes: ['chat', 'agent'],
            level: 'L1',
            capabilities: { display: { label: 'Latch' }, models: { owner: 'latch' }, permission: { enforcement: 'latch' } },
          },
          {
            id: 'codex',
            status: 'ready',
            modes: ['agent'],
            level: 'L3',
            capabilities: { display: { label: 'Codex' }, models: { owner: 'harness' } },
            permission: { modeTiers: { read: { tier: 'plan' }, ask: { tier: 'ask' }, auto: { tier: 'model' }, full: { tier: 'never' } } },
            catalogue: {
              options: [
                {
                  id: 'model',
                  category: 'model',
                  currentValue: 'small',
                  options: [
                    { value: 'small', name: 'Small' },
                    { value: 'large', name: 'Large' },
                  ],
                },
                {
                  id: 'effort',
                  category: 'thought_level',
                  currentValue: 'medium',
                  options: [
                    { value: 'low', name: '低' },
                    { value: 'medium', name: '中' },
                    { value: 'high', name: '高' },
                  ],
                },
                {
                  id: 'mode',
                  category: 'mode',
                  currentValue: 'ask',
                  options: [
                    { value: 'read', name: 'Read' },
                    { value: 'ask', name: 'Ask' },
                    { value: 'auto', name: 'Auto' },
                    { value: 'full', name: 'Full' },
                  ],
                },
              ],
              perModel: [
                {
                  model: 'large',
                  options: [{ id: 'effort', category: 'thought_level', currentValue: 'high', options: [{ value: 'high', name: '高' }] }],
                },
              ],
            },
          },
          {
            id: 'other',
            status: 'ready',
            modes: ['agent'],
            level: 'L3',
            capabilities: { display: { label: 'Other' }, models: { owner: 'harness' } },
            permission: { modeTiers: { safe: { tier: 'ask' }, yolo: { tier: 'never' } } },
            catalogue: {
              options: [{ id: 'm', category: 'mode', currentValue: 'safe', options: [{ value: 'safe' }, { value: 'yolo' }] }],
              perModel: [],
            },
          },
          {
            id: 'unread',
            status: 'ready',
            modes: ['agent'],
            level: 'L3',
            capabilities: { display: { label: 'Unread' }, models: { owner: 'harness' } },
            permission: { modeTiers: {} },
          },
        ],
        workspaces: [{ id: 'latch', name: 'latch' }],
        providers: [{ id: 'p', name: 'P', models: ['m1', 'm2'], modelCapabilities: { m2: { thinking: ['low', 'high'] } } }],
        defaults: { harnessId: 'standard', workspaceId: 'latch', model: { providerId: 'p', model: 'm1' } },
      },
      agentSource: {
        summary: { harnessId: 'codex', workspaceId: 'latch', mode: 'agent' },
        permission: {
          expectedMode: 'auto',
          modeTiers: { read: { tier: 'plan' }, ask: { tier: 'ask' }, auto: { tier: 'model' }, full: { tier: 'never' } },
        },
        config: [
          {
            id: 'model',
            category: 'model',
            currentValue: 'large',
            options: [
              { value: 'small', name: 'Small' },
              { value: 'large', name: 'Large' },
            ],
          },
          { id: 'effort', category: 'thought_level', currentValue: 'high', options: [{ value: 'high', name: '高' }] },
          {
            id: 'mode',
            category: 'mode',
            currentValue: 'auto',
            options: [
              { value: 'ask', name: 'Ask' },
              { value: 'auto', name: 'Auto' },
            ],
          },
        ],
      },
      routedSource: {
        summary: { harnessId: 'codex', workspaceId: 'latch', mode: 'agent', modelRoute: { providerId: 'p', model: 'm2' } },
        config: [{ id: 'effort', category: 'thought_level', currentValue: 'high', options: [{ value: 'high', name: '高' }] }],
      },
      builtinSource: {
        summary: { harnessId: 'standard', workspaceId: 'latch', mode: 'agent', providerId: 'p', model: 'm2', effort: 'high' },
      },
      chatSource: { summary: { harnessId: 'standard', mode: 'chat', providerId: 'p', model: 'm1' } },
      startCatalog: {
        harnesses: [
          {
            id: 'standard',
            status: 'ready',
            modes: ['chat', 'agent'],
            capabilities: { models: { owner: 'latch' }, permission: { enforcement: 'latch' } },
          },
          { id: 'codex', status: 'ready', modes: ['agent'], capabilities: { models: { owner: 'harness', wires: ['chat-completions'] } } },
        ],
        workspaces: [{ id: 'latch', name: 'latch' }],
        providers: [{ id: 'p', name: 'P', kind: 'openai-compatible', models: ['m1', 'm2'] }],
        defaults: { harnessId: 'codex', workspaceId: 'latch', model: { providerId: 'p', model: 'm2' } },
      },
      setupDefaults: {
        harnessId: 'codex',
        workspaceId: 'latch',
        model: { providerId: 'p', model: 'm2' },
        gateway: { providerId: 'p', model: 'm1' },
      },
      stopsDetail: {
        messages: [
          { id: 's1', role: 'tool', subagent: { title: 'a', stoppable: true, steps: [] } },
          {
            id: 'p',
            role: 'tool',
            subagent: {
              title: 'b',
              steps: [{ id: 's3', role: 'tool', subagent: { title: 'c', stoppable: true, stopping: true, steps: [] } }],
            },
          },
          { id: 's4', role: 'tool', subagent: { title: 'd', status: 'done', steps: [] } },
        ],
      },

      forked: { forkOf: { taskId: 'ses_source', title: '源会话', turn: 3, upToMessageId: 'm4', prefixLength: 10 } },
      search: {
        hits: [
          {
            sessionId: 'ses_1',
            messageId: 'm1',
            title: '修 relay',
            snippet: '😀 改了 relay 的超时',
            match: { start: 6, end: 11 },
            archived: false,
          },
          { sessionId: 'ses_2', messageId: 'm2', title: '', snippet: 'relay', match: { start: 3, end: 99 }, archived: true },
          { sessionId: '../x', messageId: 'm3', title: 'bad', snippet: 'x', match: { start: 0, end: 1 } },
        ],
        truncated: true,
      },
      tasks: [
        { id: 'old', title: 'Relay 旧', archived: true, updatedAt: at(1) },
        { id: 'new', title: '新的', archived: true, updatedAt: at(9) },
        { id: 'live', title: 'Relay', updatedAt: at(5) },
      ],
      approvals: [
        {
          risk: 'R1',
          standard: true,
          options: [
            { id: 'o1', kind: 'allow_once', label: 'Allow' },
            { id: 'o2', kind: 'allow_always', label: 'Always' },
            { id: 'o3', kind: 'reject_once', label: 'Reject' },
            { id: 'o4', kind: 'reject_always', label: '一直拒绝' },
          ],
        },
        {
          risk: 'R1',
          standard: false,
          options: [
            { id: 'o1', kind: 'allow_once' },
            { id: 'o3', kind: 'reject_once' },
            { id: 'o4', kind: 'reject_always', label: 'Never' },
          ],
        },
        {
          risk: 'R2',
          elevated: true,
          options: [
            { id: 'o1', kind: 'allow_once' },
            { id: 'o2', kind: 'allow_always' },
            { id: 'o3', kind: 'reject_once' },
          ],
        },
        {
          advisory: true,
          risk: 'R2',
          options: [
            { id: 'allow', kind: 'allow_once' },
            { id: 'always', kind: 'allow_always' },
            { id: 'reject', kind: 'reject_once' },
            { id: 'never', kind: 'reject_always', label: 'Never' },
          ],
        },
        {
          risk: 'R1',
          standard: true,
          toolName: 'write\u202Efile',
          options: [
            { id: 'o1', kind: 'allow_once' },
            { id: 'o2', kind: 'allow_always' },
          ],
        },
        {
          risk: 'R1',
          standard: true,
          toolName: 'write',
          tool: { locations: ['src/a\u200B.ts'] },
          options: [{ id: 'o2', kind: 'allow_always' }],
        },
      ],
    })
    expect(result.subagents).toEqual([
      { id: 's1', title: 'Test runner', status: '运行中', canStop: true, stopping: false, waiting: false, steps: 1 },
      { id: 's2', title: 'Test runner', status: '正在停止…', canStop: false, stopping: true, waiting: false, steps: 0 },
      { id: 's3', title: 'Linter', status: '正在停止…', canStop: false, stopping: true, waiting: false, steps: 0 },
      { id: 's4', title: 'Docs', status: '已完成', canStop: false, stopping: false, waiting: false, steps: 0 },
      { id: 's5', title: 'Plain', status: null, canStop: false, stopping: false, waiting: false, steps: 0 },
      null,
    ])
    expect(result.turnActions).toEqual([
      { copy: '读完了', retry: null, warning: null, fork: 'm3' },
      {
        copy: '改好了',
        retry: '改一下',
        warning:
          '上一次已经执行了 2 个操作：修改 1 个文件、运行 1 条命令。上一次有 1 个操作结果未知，可能已经执行。重新发送后，Harness 可能再次执行它们。',
        fork: 'm9',
      },
    ])
    expect(result.latestRunning).toEqual({ copy: null, retry: null, warning: null, fork: null })
    expect(result.readOnly).toEqual({ copy: '改好了', retry: null, warning: null, fork: null })
    expect(result.resend).toEqual(['plain', '继续', '源会话的记录\n\n继续', '接着', ''])
    expect(result.followUp).toEqual(['send', 'steer', 'queue', 'none'])
    expect(result.controls).toEqual([
      // The main rows are asking, the model's and never; reading and the rules' go under 更多, a mode with no tier is left out.
      {
        kind: 'permission',
        id: 'mode',
        label: '不再询问',
        amber: true,
        rows: ['只看不改+', '先问你', '按规则放行+', '由模型判断', '不再询问*'],
      },
      { kind: 'model', id: 'model', label: 'Small', amber: false, rows: ['Small*', 'Large'] },
      { kind: 'thinking', id: 'effort', label: '高', amber: false, rows: ['高*'] },
    ])
    expect(result.chatControls).toEqual(['model', 'thinking'])
    expect(result.launchControls).toEqual([
      [
        {
          kind: 'thinking',
          id: 'thinking',
          label: '高',
          amber: false,
          rows: ['高*'],
          source: 'launch',
          note: '启动设置 · 未独立读回',
          noteDetail: '这项设置通过进程启动参数应用；Agent 没有独立报告该参数的有效值。',
        },
      ],
      [
        {
          kind: 'permission',
          id: 'mode',
          label: 'Agent --force',
          amber: true,
          rows: ['Ask+', 'Plan+', 'Agent', 'Agent --force*'],
          source: 'launch',
          note: '启动设置 · 未独立读回',
          noteDetail: '这项设置通过进程启动参数应用；Agent 没有独立报告该参数的有效值。',
        },
      ],
      [{ kind: 'thinking', id: 'thinking', label: '高', amber: false, rows: ['高*'] }],
    ])
    expect(result.configWrites).toEqual([
      {
        method: 'POST',
        path: '/link/api/tasks/ses_1/config',
        body: { configId: 'model', value: 'large', requestId: '<id>' },
        words: '切换结果待确认',
      },
      'refused',
      'refused',
      'refused',
      'refused',
      {
        method: 'POST',
        path: '/link/api/tasks/ses_1/config',
        body: { configId: 'mode', value: 'yolo', requestId: '<id>' },
        words: '切换结果待确认',
      },
      'refused',
      {
        method: 'POST',
        path: '/link/api/tasks/ses_1/config',
        body: { configId: 'thinking', value: 'high', requestId: '<id>' },
        words: '切换结果待确认',
      },
    ])
    expect(result.menus).toEqual([
      [['重命名', '置顶'], ['清空上下文'], ['归档'], ['删除']],
      [['重命名', '取消置顶'], ['清空上下文（这一轮结束后才能清空上下文）'], ['归档'], ['删除（运行中的会话需要先停止）']],
      [['重命名', '置顶'], ['保留上下文'], ['归档'], ['删除（运行中的会话需要先停止）']],
      [['重命名', '置顶'], ['取消归档'], ['删除']],
    ])
    expect(result.noRunMenu).toBe(0)
    expect(result.listMenu).toEqual(['重命名', '置顶', '归档', '删除'])
    expect(result.deleteQuestion).toEqual([
      '删除「修 relay」及其全部记录？此操作无法撤销。',
      '删除「未命名会话」及其全部记录？此操作无法撤销。',
    ])
    // Plain requests as the web sends them: no requestId, nothing kept; limits counted in UTF-16 units.
    expect(result.sessionWrites).toEqual([
      { method: 'PATCH', path: '/link/api/tasks/ses_1', body: { title: '新名字' } },
      'refused',
      { method: 'PATCH', path: '/link/api/tasks/ses_1', body: { title: '长'.repeat(120) } },
      'refused',
      { method: 'PATCH', path: '/link/api/tasks/ses_1', body: { pinned: true } },
      { method: 'PATCH', path: '/link/api/tasks/ses_1', body: { archived: false } },
      { method: 'DELETE', path: '/link/api/tasks/ses_1', body: {} },
      'refused',
    ])
    expect(result.fork).toEqual({
      origin: '从「源会话」第 2 轮分叉',
      harness: 'codex',
      workspace: 'site',
      model: '',
      fields: {
        prompt: '请接着这个会话继续。',
        harnessId: 'codex',
        workspaceId: 'site',
        mode: 'agent',
        forkOf: { taskId: 'ses_source', upToMessageId: 'm4' },
      },
      words: {
        method: 'POST',
        path: '/link/api/tasks',
        body: expect.objectContaining({ forkOf: { taskId: 'ses_source', upToMessageId: 'm4' } }),
        words: '分叉结果待确认',
      },
      from: ['ses_source', '从「源会话」第 3 轮分叉'],
    })
    const place = { harnessId: 'codex', workspaceId: 'latch', mode: 'agent' }
    expect(result.plans).toEqual({
      // The same Harness keeps the model, its level (as that model reported it) and the exact row.
      same: {
        missed: [],
        fields: {
          ...place,
          config: [
            { configId: 'model', value: 'large' },
            { configId: 'effort', value: 'high' },
            { configId: 'mode', value: 'auto' },
          ],
        },
        rows: ['', '高', '由模型判断'],
      },
      // Another Harness takes the widest row no wider than the source's and says what it could not keep.
      other: {
        missed: ['没有沿用来源会话的模型「Large」与思考「高」：Other 在这里不能选。', '权限「由模型判断」→ 更严的「先问你」'],
        fields: { ...place, harnessId: 'other', config: [{ configId: 'm', value: 'safe' }] },
        rows: ['', '', '先问你'],
      },
      unread: {
        missed: ['来源会话的模型「Large」、思考「高」与权限「由模型判断」要等读到 Unread 的选项后才能沿用。'],
        fields: { ...place, harnessId: 'unread' },
        rows: ['', '', ''],
      },
      // The service Latch forwarded the same Harness to goes with it and shows in the model row.
      routed: {
        missed: ['没有沿用来源会话的思考「高」：Codex 在这里不能选。'],
        fields: { ...place, model: { providerId: 'p', model: 'm2' } },
        rows: ['m2', '', ''],
      },
      routedElsewhere: {
        missed: ['没有沿用来源会话的模型「m2」与思考「高」：Other 在这里不能选。'],
        fields: { ...place, harnessId: 'other' },
        rows: ['', '', ''],
      },
      builtin: {
        missed: [],
        fields: { ...place, harnessId: 'standard', model: { providerId: 'p', model: 'm2', effort: 'high' } },
        rows: ['m2', '高', ''],
      },
      builtinPicked: {
        missed: ['没有沿用来源会话的思考「高」：Latch 在这里不能选。'],
        fields: { ...place, harnessId: 'standard', model: { providerId: 'p', model: 'm1' } },
        rows: ['m1', '', ''],
      },
      builtinToAgent: {
        missed: ['没有沿用来源会话的模型「m2」：Codex 在这里不能选。'],
        fields: { ...place, config: [{ configId: 'effort', value: 'high' }] },
        rows: ['', '高', ''],
      },
      fromChat: {
        missed: ['没有沿用来源会话的模型「m1」：Codex 在这里不能选。', '来源不读写文件，用 Codex 的默认项'],
        fields: place,
        rows: ['', '', ''],
      },
    })
    // A Harness with its own models is given none, not even one forced into the choice; one on Latch's services gets the default.
    expect(result.starts).toEqual([
      { default: '', fields: null, forced: null },
      { default: 'm2', fields: { providerId: 'p', model: 'm2' }, forced: { providerId: 'p', model: 'm2' } },
    ])
    expect(result.startDefault).toBe('')
    expect(result.preparedStart).toEqual({ providerId: 'p', model: 'm1' })
    expect(result.preparedBuiltIn).toBe('m2')
    expect(result.preparedThenOwn).toEqual({ providerId: 'p', model: 'm1' })
    expect(result.preparedThenChanged).toEqual({ providerId: 'p', model: 'm1' })
    expect(result.ownThenPrepared).toEqual({ prompt: 'x', harnessId: 'codex', mode: 'agent', workspaceId: 'latch', ownModel: true })
    expect(result.projectBeforePrepared).toBe('m2')
    expect(result.preparedHandoff).toEqual({ kind: 'new-session', mode: 'chat', harnessId: 'codex' })
    // A stop goes on failure and once the Host shows the subagent stopping or no longer stoppable, nested rows too.
    expect(result.stops).toEqual([['s1', 's2', 's3', 's4'], ['s1', 's3', 's4'], ['s1']])
    expect(result.search).toEqual({
      hits: [
        ['ses_1', '修 relay', '😀 改了 ', 'relay', ' 的超时', ''],
        ['ses_2', '', 'relay', '', '', 'archived'],
      ],
      truncated: true,
    })
    expect(result.queries).toEqual(['relay', '', '', ''])
    expect(result.archived).toEqual(['new', 'old'])
    expect(result.archivedFound).toEqual(['old'])
    expect(result.approvals).toEqual([
      { allow: '允许', option: 'o1', more: ['o2:这个会话都允许这类操作:true', 'o4:一直拒绝:false'], hidden: false, places: [] },
      { allow: '', option: '', more: ['o4:Never:false'], hidden: false, places: [] },
      { allow: '允许', option: 'o1', more: [], hidden: false, places: [] },
      { allow: '允许', option: 'allow', more: ['never:始终拒绝:false'], hidden: false, places: [] },
      // A request that may read as something else keeps the broadest choices out of reach; the drawer demotes its allow.
      { allow: '允许', option: 'o1', more: [], hidden: true, places: [] },
      // A place is shown as it is, so a hidden character there counts and is drawn marked.
      { allow: '这个会话都允许这类操作', option: 'o2', more: [], hidden: true, places: ['src/a\\u{200B}.ts'] },
    ])
  })
  it('derives the review, 提交, editing, handoff and notice decisions the phone shows and the writes it sends for them', async () => {
    const at = (m: string) => `2026-11-01T${m}:00.000Z`
    const counts = (sessionId: string, pending: number, sent = 0, claimed = 0) => ({
      sessionId,
      pending,
      sent,
      claimed,
      reviewed: 0,
      revision: 3,
    })
    const task = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      title: id,
      status: 'idle',
      mode: 'agent',
      updatedAt: at('12:00'),
      ...extra,
    })
    const note = (id: string, extra?: Record<string, unknown>) => ({
      id,
      root: 'default',
      path: 'a.ts',
      range: { start: 2, end: 3 },
      side: 'new',
      anchor: { scope: 'turn', linesHash: 'h', lines: ['two', 'three'] },
      text: '改这里',
      status: 'pending',
      createdBy: { deviceId: 'd', name: 'n' },
      createdAt: at('10:00'),
      updatedAt: at('10:00'),
      ...extra,
    })
    const lines = [
      ...Array.from({ length: 10 }, (_, i) => ({
        kind: 'context',
        text: i === 1 ? 'two' : i === 2 ? 'three' : `line ${i + 1}`,
        oldLine: i + 1,
        newLine: i + 1,
      })),
      { kind: 'remove', text: 'old eleven', oldLine: 11 },
      { kind: 'add', text: 'new eleven', newLine: 11 },
      ...Array.from({ length: 10 }, (_, i) => ({ kind: 'context', text: `tail ${i + 12}`, oldLine: i + 12, newLine: i + 12 })),
    ]
    const current = ['a', 'unique line that is long enough here', 'x', 'y', '}', 'z', '}', 'w']
    const result = await invoke({
      operation: 'phoneReview',
      snapshot: {
        catalog: { features: { changes: true } },
        device: { dataScope: 'all' },
        tasks: [
          task('ses_new'),
          task('ses_old', { updatedAt: at('10:30') }),
          task('ses_notes', { updatedAt: at('09:00') }),
          task('ses_chat', { mode: 'chat' }),
          task('ses_running', { status: 'running' }),
          task('ses_target', { title: '目标' }),
          task('ses_source', { title: '来源会话' }),
          task('ses_target2'),
          task('ses_archived', { archived: true }),
        ],
        reviewNotes: [counts('ses_notes', 0, 1)],
        handoffs: [
          {
            id: 'h1',
            sourceSessionId: 'ses_source',
            targetSessionId: 'ses_target',
            status: 'started',
            returnScope: 'summary',
            updatedAt: at('11:00'),
          },
          {
            id: 'h2',
            sourceSessionId: 'ses_gone',
            targetSessionId: 'ses_target2',
            status: 'started',
            returnScope: 'none',
            updatedAt: at('11:00'),
          },
        ],
      },
      shortcuts: [
        { task: task('a'), unread: true, turns: [{ turnId: 't', state: 'settled', files: 3 }], counts: null },
        { task: task('a'), unread: false, turns: [{ turnId: 't', state: 'settled', files: 3 }], counts: null },
        { task: task('a'), unread: true, turns: [{ turnId: 't', state: 'settled', files: 3, undone: true }], counts: null },
        { task: task('a'), unread: false, turns: null, counts: counts('a', 2) },
        { task: task('a'), unread: false, turns: [{ turnId: 't', state: 'running' }], counts: counts('a', 0, 0, 1) },
        { task: task('a', { status: 'running' }), unread: true, turns: [{ turnId: 't', state: 'settled', files: 3 }], counts: null },
        { task: task('a', { mode: 'chat' }), unread: true, turns: [{ turnId: 't', state: 'settled', files: 3 }], counts: null },
      ],
      current,
      locate: [
        { start: 2, end: 2, lines: ['unique line that is long enough here'] },
        { start: 4, end: 4, lines: ['unique line that is long enough here'] },
        { start: 6, end: 6, lines: ['}'] },
        { start: 1, end: 1, lines: ['gone entirely from the file now'] },
        { start: 6, end: 6, lines: ['y'] },
      ],
      fileDetail: { hunks: [{ oldStart: 1, oldLines: 21, newStart: 1, newLines: 21, lines }] },
      notes: {
        notes: [
          note('n1'),
          note('n2', {
            range: { start: 40, end: 41 },
            anchor: { scope: 'turn', linesHash: 'h', lines: ['nowhere at all in this file', 'x'] },
          }),
          note('n3', { status: 'sent', messageId: 'm' }),
          note('n4', { sending: true }),
          note('n5', { queueId: 'q1' }),
          note('n6', { status: 'agent-claimed', messageId: 'm' }),
          note('n7', { status: 'reviewed', messageId: 'm' }),
        ],
        revision: 3,
        openSends: [
          { id: 'send_1', noteIds: ['n4'] },
          { id: 'send_2', noteIds: ['n5'], queue: true, queueId: 'q1' },
        ],
      },
      list: {
        scope: 'turn',
        files: [
          { root: 'default', path: 'src/z.ts', status: 'M', add: 1, del: 1 },
          { root: 'default', path: 'a.ts', status: 'M', byCommand: true },
          { root: 'default', path: 'src/deep/b.ts', status: 'A', secret: true },
          { root: 'default', path: 'README.md', status: 'M', large: true },
        ],
        totals: { files: 4, add: 1, del: 1 },
      },
      empties: [
        { scope: 'turn', files: [], running: true },
        { scope: 'turn', files: [] },
        { scope: 'uncommitted', files: [] },
        { scope: 'session', files: [], unavailable: 'git-failed' },
        { scope: 'turn', files: [{ root: 'r', path: 'p' }] },
      ],
      git: {
        branch: 'main',
        head: 'abc',
        upstream: 'origin/main',
        ahead: 0,
        behind: 0,
        staged: [{ path: 'a.ts', status: 'M' }],
        unstaged: [{ path: 'b.ts', status: 'D' }],
        untracked: ['c.ts'],
        conflicted: [],
        hooks: ['pre-commit'],
        filters: false,
        remote: 'origin',
      },
      gitClean: {
        branch: 'main',
        head: 'abc',
        upstream: 'origin/main',
        ahead: 2,
        behind: 0,
        staged: [],
        unstaged: [{ path: 'b.ts', status: 'M' }],
        untracked: [],
        conflicted: [],
        hooks: [],
        filters: false,
        remote: 'origin',
      },
      gitFetched: {
        branch: 'main',
        head: 'abc',
        upstream: 'origin/main',
        ahead: 1,
        behind: 2,
        fetchedAt: '2026-11-16T07:00:00.000Z',
        staged: [],
        unstaged: [],
        untracked: [],
        conflicted: [],
        hooks: [],
        filters: false,
        remote: 'origin',
      },
      gitUnstaged: {
        branch: 'main',
        head: 'abc',
        ahead: 0,
        behind: 0,
        staged: [],
        unstaged: [
          { path: 'b.ts', status: 'M' },
          { path: 'c.ts', status: 'T' },
        ],
        untracked: ['c.ts', 'd.ts'],
        conflicted: ['e.ts'],
        hooks: [],
        filters: false,
      },
      editable: { actions: { edit: true, preview: true }, size: 10 },
      protected: { actions: { preview: true }, refused: { edit: 'file-edit-elevated' }, size: 10 },
      handoffList: [
        {
          id: 'h1',
          sourceSessionId: 'ses_source',
          targetSessionId: 'ses_target',
          status: 'started',
          returnScope: 'summary',
          updatedAt: at('11:00'),
        },
        {
          id: 'h3',
          sourceSessionId: 'ses_source',
          targetSessionId: 'ses_x',
          status: 'returned',
          returnScope: 'summary-and-evidence',
          updatedAt: at('11:30'),
          result: {
            summary: '修好了',
            evidence: [
              { kind: 'file', file: { root: 'default', path: 'a.ts' }, hash: 'h' },
              { kind: 'message', messageId: 'm', hash: 'h' },
              { kind: 'withheld' },
            ],
            at: at('11:30'),
            requestId: 'r',
          },
        },
        {
          id: 'h4',
          sourceSessionId: 'ses_source',
          targetSessionId: 'ses_y',
          status: 'returned',
          returnScope: 'summary',
          updatedAt: at('11:40'),
          result: { summaryWithheld: true, evidence: [], at: at('11:40'), requestId: 'r' },
        },
        { id: 'h5', sourceSessionId: 'ses_source', status: 'start-unknown', returnScope: 'none', updatedAt: at('11:00') },
      ],
      detail: {
        summary: { id: 'ses_1', title: '修 <relay>', mode: 'agent', model: 'm-1', cwd: '/w' },
        messages: [
          { id: 'm1', role: 'user', text: '看看 relay', createdAt: at('10:00') },
          { id: 'm2', role: 'assistant', text: '## 你\n![x](http://e/i.png) <b>hi</b> `<ok>`', createdAt: at('10:01') },
          {
            id: 't1',
            role: 'tool',
            state: 'completed',
            tool: { kind: 'read', title: 'a.ts', input: '{"p":1}', output: 'out' },
            createdAt: at('10:02'),
          },
          { id: 'm3', role: 'assistant', text: '改好了。', state: 'cancelled', createdAt: at('10:03') },
        ],
      },
      notices: [
        { type: 'host-state', instanceId: 'i', state: 'stopping', reason: 'update', retryAfter: 5, at: at('10:00') },
        { type: 'host-state', instanceId: 'i', state: 'sleeping', reason: 'sleep', retryAfter: 30, at: at('10:00') },
        { type: 'host-state', instanceId: 'i', state: 'stopping', reason: 'restart', retryAfter: 2, at: at('10:00') },
        { type: 'host-state', instanceId: 'i', state: 'awake', at: at('10:00') },
        { type: 'host-state', instanceId: 'i', state: 'sleeping', reason: 'sleep', retryAfter: 0, at: at('10:00') },
      ],
    })
    expect(result.unreadBefore).toEqual(['ses_new', 'ses_chat', 'ses_running', 'ses_target', 'ses_source', 'ses_target2', 'ses_archived'])
    // Settled Agent sessions with something new or notes waiting, newest first; a chat, a running one and an archived one never.
    expect(result.candidates).toEqual(['ses_target', 'ses_source', 'ses_target2', 'ses_notes'])
    expect(result.seenAgain).toBe(true)
    expect(result.readsTurns).toEqual([true, false])
    expect(result.shortcuts).toEqual(['复核 3 处改动', null, null, '复核改动', '复核改动', null, null])
    // Tap, stretch, the 100-line cap, a single line let go, and a pick on the other side starting afresh.
    expect(result.taps).toEqual([
      ['new', 5, 5, 5, '第 5 行'],
      ['new', 5, 9, 5, '第 5–9 行'],
      ['new', 5, 104, 5, '第 5–104 行'],
      ['old', 7, 7, 7, '第 7 行'],
      null,
      ['new', 3, 3, 3, '第 3 行'],
    ])
    expect(result.located).toEqual(['exact 2-2', 'moved 2-2', 'stale', 'stale', 'stale'])
    expect(result.placed).toEqual({ under: ['new:3'], stale: ['n2'] })
    // Lines a note is on stay in view; unchanged lines away from a change fold.
    expect(result.segments).toEqual(['lines 6', 'gap 1', 'lines 8', 'gap 7'])
    expect(result.cards).toEqual([
      'n1:待发:true',
      'n2:待发:true',
      'n3:已发送:false',
      'n4:发送中:false',
      'n5:已排队:true',
      'n6:Agent 称已修:false',
      'n7:你已复核:false',
    ])
    expect(result.tally).toEqual([['n1', 'n2', 'n5'], 1, 1, 1, 2])
    expect(result.open).toEqual(['send_1', 'n4'])
    expect(result.feet).toEqual([
      'note(label: "第 2–3 行")',
      'send(label: "发给 Agent (3)", count: 3, disabled: false)',
      'send(label: "排到下一轮", count: 3, disabled: false)',
      'send(label: "本轮结束后发", count: 3, disabled: true)',
      'send(label: "发给 Agent (3)", count: 3, disabled: true)',
      'unknown(sending: 1)',
      'deliver(status: nil, running: false)',
      'deliver(status: Optional("Agent 在修订 2 条反馈"), running: true)',
      'none(status: nil, running: false)',
      'deliver(status: nil, running: false)',
    ])
    expect(result.files).toEqual(['src/deep/b.ts', 'src/z.ts', 'a.ts', 'README.md'])
    expect(result.empty).toEqual([
      ['还没有改动文件', ''],
      ['这一轮没有改动文件', ''],
      ['没有未提交的改动', ''],
      ['读不到 Git 状态', '本轮和这个会话不受影响。'],
      [],
    ])
    expect(result.paths).toEqual([
      '/link/api/tasks/ses_1/changes?scope=uncommitted',
      '/link/api/tasks/ses_1/changes/file?scope=turn&turn=t%201&root=default&path=src%2Fa%20b%26c.ts&context=100000',
      'refused',
    ])
    const writes = result.noteWrites as unknown[]
    expect(writes[0]).toEqual({
      method: 'POST',
      path: '/link/api/tasks/ses_1/review-notes',
      body: {
        requestId: '<id>',
        root: 'default',
        path: 'a.ts',
        range: { start: 2, end: 3 },
        side: 'new',
        scope: 'turn',
        turnId: 'turn_1',
        lines: ['two', 'three'],
        text: '这里不对',
      },
    })
    // A snippet that does not match the range, an empty note and a status only a person may not set are never sent.
    expect([writes[1], writes[2], writes[5], writes[8]]).toEqual(['refused', 'refused', 'refused', 'refused'])
    expect(writes.slice(9).map(write => (write as { path: string }).path)).toEqual([
      '/link/api/tasks/ses_1/review-notes/sends/send_1/retry',
      '/link/api/tasks/ses_1/review-notes/sends/send_1/abandon',
    ])
    expect((writes[7] as { body: unknown }).body).toEqual({ requestId: '<id>', noteIds: ['n1', 'n2'], queue: true })
    // Another session's send is never settled by this list, nor is one whose note the list does not have.
    expect(result.held).toEqual([true, false, false, false, true])
    // Hidden, format and bidirectional characters are drawn, as the web's VisibleText; a tab stays a tab.
    expect(result.visible).toEqual(['a\\u{200B}b', '\\u{61C}x', '\\u{FEFF}y', '\\u{202E}evil', '\\u{2066}i\\u{2069}', 'tab\tok', '\\u{1}'])
    // `..` in an encoded file name is fine; a `..` segment, or a query on another route, is not.
    expect(result.readable).toEqual([true, false, false, true])
    // The Host's shaping (files/edit.ts shapeContent), ported: its own cases, a CRLF file keeps one CR per line, and
    // 核对并放下 says 已保存 only when the shaped bytes are the file, else only that the file is not this text now.
    expect(result.shapes).toEqual([
      true,
      true,
      true,
      'a\\r\\nb\\r\\nc\\r\\n',
      'a\\nb\\nc',
      [0xef, 0xbb, 0xbf],
      0,
      true,
      'x\\r\\ny\\r\\n',
      true,
      true,
      true,
      false,
      '已保存',
      '文件现在不是你的修改',
      '不能核对，到电脑上看',
    ])
    const delivery = result.delivery as Record<string, unknown>
    expect(delivery.groups).toEqual([['修改 a.ts'], ['删除 b.ts'], ['未跟踪 c.ts'], []])
    expect(delivery.primary).toEqual(['提交 1 个文件', '暂存全部', '推送 2 个提交', '暂存全部'])
    expect(delivery.stageAll).toEqual(['b.ts', 'c.ts', 'd.ts', 'e.ts'])
    // Behind only as of a fetch: without one, nothing says the branch is up to date.
    expect(delivery.aheadBehind).toEqual(['已推送', '领先 2', '领先 1 · 落后 2'])
    expect(delivery.foot).toEqual(['只提交已暂存的 · 未暂存的 2 个文件不提交', '1 个文件未暂存'])
    expect(delivery.copy).toEqual(['Agent 正在改这个文件夹', '变基进行中，在终端里完成', '这台电脑正在安装更新', ''])
    // The draft gets the hook's last 80 lines in a fence its own backticks cannot close.
    const excerpt = delivery.excerpt as string
    expect(excerpt.startsWith('提交钩子 pre-commit 没通过，退出码 1，没有生成提交：\n\n````text\nline 12\n')).toBe(true)
    expect(excerpt.endsWith('line 90\n```\n````')).toBe(true)
    expect((delivery.writes as unknown[])[2]).toEqual({
      method: 'POST',
      path: '/link/api/tasks/ses_1/git/commit',
      body: { requestId: '<id>', message: 'fix: a', skipHooks: true },
    })
    expect((delivery.writes as unknown[])[3]).toBe('refused')
    expect(delivery.timeouts).toEqual([630, 270, 15])
    // The web's rule: a commit settles on a receipt answer (`replay`) alone, a push also on a failure read from the remote;
    // git-detached and a stage keep it unknown. A save is settled by file-changed, not by an expired handle.
    expect(delivery.retryAnswers).toEqual([true, true, false, true, true, false, true, true, false, false, true, false, false])
    expect(delivery.pendingPaths).toEqual({ 'a.ts': 'unstage', 'b.ts': 'unstage' })
    expect(result.edit).toEqual([
      {
        method: 'PUT',
        path: '/link/api/tasks/ses_1/files/AAAAAAAAAAAAAAAAAAAAAA',
        body: { requestId: '<id>', baseHash: 'a'.repeat(64), content: 'new\n' },
      },
      'refused',
      'refused',
      true,
      false,
      false,
      createHash('sha256').update('abc').digest('hex'),
      // Mixed line endings and text past the 1 MiB body are not offered for editing.
      false,
      false,
      // 核对并放下: a CRLF file holding the save's text is saved; other text is not.
      true,
      false,
      '文件已在别处修改',
    ])
    const handoffs = result.handoffs as Record<string, unknown>
    expect(handoffs.crumb).toEqual(['ses_source', '来自 来源会话', 'listed'])
    expect(handoffs.crumbUnlisted).toBe('来自另一个会话')
    expect(handoffs.awaiting).toEqual(['ses_target'])
    expect(handoffs.status).toEqual(['代码会话在做', '已交回', '已交回', '结果未知'])
    expect([handoffs.returnable, handoffs.returnableRunning]).toEqual(['h1', ''])
    expect(handoffs.results).toEqual([
      ['h3', '修好了', 'a.ts,代码会话里的一条消息,无权查看'],
      ['h4', 'withheld', ''],
    ])
    expect(handoffs.summary).toBe('改好了。')
    expect(handoffs.materials).toEqual([
      `你 · 看看 relay ${createHash('sha256').update('看看 relay').digest('hex').slice(0, 8)}`,
      `回复 · ## 你 ${createHash('sha256').update('## 你\n![x](http://e/i.png) <b>hi</b> `<ok>`').digest('hex').slice(0, 8)}`,
      `回复 · 改好了。 ${createHash('sha256').update('改好了。').digest('hex').slice(0, 8)}`,
    ])
    expect(handoffs.quoted).toBe('先看这个\n\n> 结论一\n>\n> 结论二\n\n')
    expect((handoffs.create as { body: unknown }).body).toEqual({
      requestId: '<id>',
      sourceSessionId: 'ses_source',
      target: { kind: 'new-session', projectId: 'ws_1', harnessId: 'fake', mode: 'agent' },
      materials: [{ kind: 'message', messageId: 'm1', hash: 'b'.repeat(64) }],
      requirements: '修好它',
      decisions: [],
      returnScope: 'summary',
      locale: 'zh-CN',
    })
    expect((handoffs.createExisting as { body: { target: unknown } }).body.target).toEqual({ kind: 'session', sessionId: 'ses_2' })
    expect(handoffs.createEmpty).toBe('refused')
    expect((handoffs.return as { body: unknown }).body).toEqual({ requestId: '<id>', summary: '完成', evidence: [] })
    expect((handoffs.returnEvidence as { body: { evidence: unknown } }).body.evidence).toEqual([
      { kind: 'message', messageId: 'm2', hash: 'h' },
    ])
    expect(handoffs.listPath).toBe('/link/api/handoffs?sessionId=ses_1')
    // The web's words for each announced stop; awake and an out-of-range wait are not notices.
    expect(result.notices).toEqual([
      '工作室 Mac 上的 Latch 正在更新 / 更新完成后自动重连',
      '工作室 Mac 已休眠（<clock> 起） / 唤醒后自动重连',
      '工作室 Mac 上的 Latch 正在重启 / 几秒后自动重连',
      '',
      '',
    ])
    expect(result.noticeRetry).toBe(5)
    const markdown = result.markdown as string
    expect(markdown.replace(/^- 导出于：.*$/mu, '- 导出于：<time>')).toBe(
      '# 修 <relay>\n\n- Harness：Fake\n- 模型：m-1\n- 模式：Agent\n- 项目：`/w`\n- 导出于：<time>\n\n## 你\n\n看看 relay\n\n## Agent\n\n'
        + '\\## 你\n\\![x](http://e/i.png) &lt;b>hi&lt;/b> `<ok>`\n\n<details>\n<summary>工具：a.ts（已完成）</summary>\n\n参数：\n\n```json\n{"p":1}\n```\n\n'
        + '输出：\n\n```\nout\n```\n\n</details>\n\n## Agent\n\n改好了。\n\n_已停止，保留了部分回复。_\n',
    )
    expect((result.markdownUpTo as string).endsWith('`<ok>`\n')).toBe(true)
    expect(result.menu).toEqual(['重命名', '置顶', '复制为 Markdown', '归档', '删除'])
  })
  it('shapes a saved text exactly as the Host does, for 核对并放下', async () => {
    const files = ['a\nb\n', 'a\r\nb\r\n', '\ufeffa\r\nb\r\n', 'a\rb', 'a\r\r\nb\r\n', '\ufeff', '', 'a\nb', 'a\r\nb\nc', 'x\ufeffy\n'].map(
      text => Buffer.from(text, 'utf8'),
    )
    files.push(Buffer.from('a\u0000b', 'utf8'), Buffer.from([0xff, 0xfe, 0x00]))
    const contents = ['a\nb\n', 'a\nb', 'a\r\nb\r\n', '\ufeffhi\n', '', 'x\r\r\ny', 'lone\rcr\n', 'in\ufeffside\n', 'a\u0000b']
    const result = await invoke({ operation: 'fileShape', files: files.map(file => file.toString('base64')), contents })
    const expected = files.map(file => {
      const shape = textShape(file)
      if (!shape) return null
      const shaped = contents.map(content => shapeContent(content, shape))
      return {
        shape: { bom: shape.bom, eol: shape.eol, finalNewline: shape.finalNewline, mixed: shape.mixed },
        shaped: shaped.map(bytes => bytes.toString('base64')),
        settled: shaped.map(bytes => Buffer.compare(bytes, file) === 0),
      }
    })
    expect(result.files).toEqual(expected)
  })
  it('reviews a turn, writes and sends a note, stages, sees a hook refuse a commit, commits, edits a file and hands off from the actual Swift workspace', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'latch-swift-review-'))
    const home = join(scratch, 'home')
    await mkdir(home)
    const host = await startTestHost({
      native: { host: '127.0.0.1', port: 0 },
      gitDelivery: {
        home,
        hostEnv: { HOME: home, USER: 'tester', PATH: '/usr/bin:/bin', TMPDIR: scratch },
        shell: async () => ({ file: '/bin/sh', argv: ['-sh'] }),
      },
    })
    try {
      const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' }
      const git = (...args: string[]) => execFileSync('git', args, { cwd: host.workspaceRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
      git('init', '-q', '-b', 'main')
      git('config', 'user.name', 'Tester')
      git('config', 'user.email', 'tester@example.invalid')
      await writeFile(join(host.workspaceRoot, 'tracked.txt'), 'committed\n')
      git('add', '.')
      git('commit', '-q', '-m', 'first')
      // Slow enough that a one-second wait loses the answer, so a commit stays truly pending.
      await writeFile(
        join(host.workspaceRoot, '.git', 'hooks', 'pre-commit'),
        '#!/bin/sh\nsleep 3\necho "phone hook says no" >&2\nexit 1\n',
      )
      await chmod(join(host.workspaceRoot, '.git', 'hooks', 'pre-commit'), 0o755)
      // A remote whose hook is slow enough that a push's answer can be lost.
      const remote = join(scratch, 'remote.git')
      execFileSync('git', ['init', '-q', '--bare', remote], { env })
      await writeFile(join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\nsleep 3\nexit 0\n')
      await chmod(join(remote, 'hooks', 'pre-receive'), 0o755)
      git('remote', 'add', 'origin', remote)
      const owner = await host.enroll({ listener: 'unix' })
      await owner.confirmedJson('agents', {
        method: 'POST',
        body: { id: 'fake', name: 'Fake agent', command: process.execPath, args: [FAKE_ACP_AGENT] },
      })
      const response = await owner.request('native/pairings', { method: 'POST', body: {} })
      const { invitation } = (await response.json()) as { invitation: { payload: string } }
      // Between the fixture's steps this side takes the phone's run scope away and gives it back.
      const handshake = join(scratch, 'handshake')
      await mkdir(handshake)
      let done = false
      const devices = host.host.security.devices
      const phone = () => devices.list().find(device => device.name === 'Swift review fixture')!
      let scopes: string[] = []
      const watch = (async () => {
        const seen = new Set<string>()
        while (!done) {
          for (const [name, answer] of [
            ['drop-run', 'dropped'],
            ['restore-run', 'restored'],
            ['drop-run-push', 'dropped-push'],
            ['restore-run-push', 'restored-push'],
            ['detach', 'detached'],
          ] as const) {
            if (seen.has(name) || !existsSync(join(handshake, name))) continue
            seen.add(name)
            if (name === 'detach') git('checkout', '-q', '--detach')
            else if (name.startsWith('drop-run')) {
              scopes = [...phone().scopes]
              await devices.setScopes(phone().id, { scopes: ['view'] }, { listener: 'unix' }, 'lpc-local')
            } else await devices.setScopes(phone().id, { scopes: scopes as never }, { listener: 'unix' }, 'lpc-local')
            await writeFile(join(handshake, answer), '')
          }
          await new Promise(resolve => setTimeout(resolve, 50))
        }
      })()
      const result = await invoke(
        { operation: 'nativeReview', payload: invitation.payload, port: host.host.nativePort, handshake },
        60_000,
      ).finally(() => {
        done = true
      })
      await watch
      expect(result).toMatchObject({
        shortcut: '复核 2 处改动',
        notes: ['已发送'],
        // The same send again is the Host's receipt: one message, not two.
        feedbackMessages: 1,
        claimed: ['Agent 称已修'],
        primary: '暂存全部',
        primaryStaged: '提交 1 个文件',
        hooks: ['pre-commit'],
        // Unknown, then refused without run (still unknown), then answered from the receipt and settled.
        lostCommit: ['refused-or-unknown', 'pending', 'refused git-hook-failed replay', 'settled'],
        // A 403 keeps the push unknown; with HEAD detached the retry is answered from the receipt, not `git-detached`.
        lostPush: ['refused-unknown', 'pending', 'done', 'settled'],
        checked: [true, false],
        hook: ['git-hook-failed', 'pre-commit', 1, true],
        excerpt: true,
        replay: 'git-hook-failed',
        commit: true,
        pendingAfter: 0,
        editOffered: true,
        saved: 'ok',
        stale: ['file-changed', '文件已在别处修改'],
        handoff: ['started', 'target'],
        handoffListed: 1,
        window: true,
      })
      expect(result.stagedAfterHook).toEqual(result.staged)
      // The commit made from the phone is the repository's; the web reads the same.
      expect(git('log', '-1', '--format=%s').toString().trim()).toBe('fix: phone')
      expect((await owner.json<{ tasks: Array<{ id: string }> }>('snapshot')).tasks.length).toBe(2)
    } finally {
      await host.close()
      await rm(scratch, { recursive: true, force: true })
    }
  }, 90_000)
  it('derives the tabs, 我的 Agent and 应用 the phone shows, and the memory writes it sends', async () => {
    const at = (minute: number) => `2026-11-01T10:${String(minute).padStart(2, '0')}:00.000Z`
    const review = `agt_${'1'.repeat(8)}-1111-4111-8111-${'1'.repeat(12)}`
    const daily = `agt_${'2'.repeat(8)}-2222-4222-8222-${'2'.repeat(12)}`
    const docs = `agt_${'3'.repeat(8)}-3333-4333-8333-${'3'.repeat(12)}`
    const memory = { id: `mem_${'4'.repeat(8)}-4444-4444-8444-${'4'.repeat(12)}`, revision: 3, content: '旧的' }
    const schedule = `auto_${'5'.repeat(8)}-5555-4555-8555-${'5'.repeat(12)}`
    const proposal = (n: number, extra: Record<string, unknown>) => ({
      id: `prp_${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`,
      origin: 'agent',
      external: false,
      state: 'pending',
      createdAt: at(1),
      updatedAt: at(1),
      ...extra,
    })
    const proposals = [
      proposal(6, { content: 'use pnpm\u202e', reason: '它说过', origin: 'user', source: { sessionId: 'a', messageId: 'm1' } }),
      proposal(7, { content: '读到的', external: true, state: 'saved', source: { sessionId: 'a', requestId: 'req-2' } }),
      proposal(8, { content: '不要了', state: 'dismissed', source: { sessionId: 'a', messageId: 'gone' } }),
      proposal(9, { content: '别的话题', source: { sessionId: 'b' } }),
      { ...proposal(6, { content: 'x', source: { sessionId: 'a' } }), id: 'prp_bad' },
    ]
    const mem = (n: number) =>
      `mem_${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`
    const previous = (id: string) => ({ id, content: '以前的', revision: 1, createdAt: at(1), updatedAt: at(1) })
    const harnesses = [
      {
        id: 'standard',
        status: 'ready',
        modes: ['agent', 'chat'],
        agentContext: 'private',
        capabilities: { display: { label: 'Latch' }, models: { owner: 'latch' }, permission: { enforcement: 'latch' } },
      },
      {
        id: 'codex',
        status: 'ready',
        modes: ['agent'],
        agentContext: 'first-turn',
        capabilities: { display: { label: 'Codex' }, models: { owner: 'harness' } },
      },
      { id: 'plain', status: 'ready', modes: ['agent'], capabilities: { display: { label: 'Plain' }, models: { owner: 'harness' } } },
      {
        id: 'offered',
        status: 'ready',
        modes: ['agent'],
        agentContext: 'first-turn',
        offer: { presetId: 'x' },
        capabilities: { display: { label: 'Offered' } },
      },
    ]
    const catalog = {
      features: { customAgents: true, singleAgentChat: true, automations: true },
      harnesses,
      providers: [{ id: 'svc', name: 'Svc', models: ['m1', 'm2'] }],
      workspaces: [
        { id: 'default', name: '默认文件夹' },
        { id: 'latch', name: 'latch' },
      ],
      skills: [{ id: 'review', pluginId: 'kit', name: '审阅清单' }],
      sessionFolders: true,
      defaults: {},
    }
    const snapshot = {
      device: { status: 'active', scopes: ['view', 'run'], dataScope: 'all' },
      catalog,
      approvals: [],
      agentChats: { general: { state: 'ready', sessionId: 'g' }, [review]: { state: 'ready', sessionId: 'b' } },
      customAgents: [
        {
          id: review,
          name: '代码审阅',
          description: '只报真实的问题\n第二行',
          harnessId: 'codex',
          mode: 'agent',
          defaultProjectId: 'latch',
          available: true,
          skillCount: 2,
          avatar: { kind: 'face', bracket: 'curly', eyes: 'arc', hue: 'plum' },
        },
        {
          id: daily,
          name: '每日简报',
          description: '',
          instructions: '\n  汇总依赖\n其余',
          harnessId: 'standard',
          mode: 'chat',
          model: { providerId: 'svc', model: 'm2' },
          available: true,
          canAutomate: true,
          // A picture this App does not show yet: the Agent stays in the list, drawn with the face kept beside it.
          avatar: { kind: 'image', image: 'a'.repeat(64), bracket: 'square', eyes: 'oval', hue: 'moss' },
        },
        {
          id: docs,
          name: '文档整理',
          description: '整理',
          harnessId: 'gone',
          mode: 'agent',
          available: false,
          unavailableReason: '没有安装。',
          defaultProjectId: 'removed',
          // A value this App does not know draws as 通用's grey face.
          avatar: { kind: 'face', bracket: 'round', eyes: 'dot', hue: 'red' },
        },
      ],
      automations: [
        {
          id: schedule,
          revision: 4,
          name: '依赖检查',
          customAgentId: daily,
          schedule: { kind: 'weekdays', time: '09:00' },
          enabled: true,
          state: 'ready',
          lastRun: { state: 'completed' },
        },
        {
          id: 'auto_b',
          name: '周报',
          customAgentId: daily,
          schedule: { kind: 'weekly', day: 5, time: '17:30' },
          enabled: false,
          state: 'paused',
        },
        { id: 'auto_c', name: '早报', schedule: { kind: 'daily', time: '08:00' }, enabled: false, state: 'off' },
      ],
      apps: [
        { pluginId: 'release-check', appId: 'main', title: '发布检查', pluginName: '发布检查', status: 'ready' },
        { pluginId: 'old', appId: 'main', title: '停用的', pluginName: '旧', status: 'disabled' },
      ],
      tasks: [
        { id: 'a', title: '新', status: 'idle', updatedAt: at(9), agent: { customAgentId: review } },
        { id: 'b', title: '旧', status: 'idle', updatedAt: at(1), agent: { customAgentId: review } },
        { id: 'c', title: '归档', status: 'idle', updatedAt: at(5), archived: true, agent: { customAgentId: review } },
        { id: 'd', title: '通用的', status: 'idle', updatedAt: at(3) },
        { id: 'e', title: '已删除的 Agent', status: 'idle', updatedAt: at(4), agent: { customAgentId: docs.replace('3', '9') } },
        { id: 'g', title: '和通用', status: 'running', updatedAt: at(7), generalChat: true },
        { id: 'r', title: '定时的运行', status: 'idle', updatedAt: at(10), agent: { customAgentId: review }, automationId: schedule },
      ],
      agentProposals: { general: { pending: 2, at: at(3) } },
    }
    const waiting = { ...snapshot, tasks: [{ id: 'w', status: 'waiting-approval', updatedAt: at(2) }] }
    const mine = (id: string, extra: Record<string, unknown>) => ({ id, updatedAt: at(5), agent: { customAgentId: review }, ...extra })
    const faceCase = (tasks: object[], available = true, approvals: object[] = []) => ({
      snapshot: { tasks, approvals },
      id: review,
      available,
    })
    const result = await invoke({
      operation: 'phoneAgents',
      snapshot,
      generalCatalogs: [
        { ...catalog, defaults: { harnessId: 'codex' } },
        { ...catalog, harnesses: harnesses.filter(item => item.id !== 'standard') },
        { ...catalog, harnesses: harnesses.map(item => (item.id === 'standard' ? { ...item, status: 'unavailable' } : item)) },
      ],
      memoryOwner: review,
      memory,
      proposals: { proposals },
      topicDetail: {
        summary: { id: 'a' },
        messages: [
          { id: 'm1', role: 'user', text: '记住：use pnpm' },
          { id: 'm2', role: 'assistant', text: '好' },
          { id: 'm3', role: 'user', text: '看看', requestId: 'req-2' },
          { id: 'm4', role: 'assistant', text: '看了' },
        ],
        memoryRefusals: [{ requestId: 'req-3', reason: '内容像是密钥或凭据，没有记下。' }],
      },
      memoryDetail: {
        memories: [
          {
            ...previous(mem(1)),
            source: { origin: 'agent', external: true, sessionId: 'a', proposalId: proposals[1]!.id, proposedAt: at(1) },
          },
          previous(mem(2)),
        ],
        memoryChanges: [
          { memoryId: mem(2), operation: 'update', at: at(2), previous: previous(mem(2)) },
          { memoryId: mem(3), operation: 'delete', at: at(2), previous: previous(mem(3)) },
          { memoryId: mem(1), operation: 'delete', at: at(1), previous: previous(mem(1)) },
        ],
      },
      faceCases: [
        faceCase([]),
        faceCase([mine('r', { status: 'running' })]),
        faceCase([mine('r', { status: 'running' }), mine('w', { status: 'waiting-approval' })]),
        faceCase([mine('q', { status: 'running', pendingQuestions: 1 })]),
        faceCase([{ id: 'x', status: 'running', updatedAt: at(5), agent: { customAgentId: daily } }]),
        faceCase([], false),
        faceCase([mine('r', { status: 'running' })], false),
        faceCase([mine('f', { status: 'failed' })]),
        faceCase([mine('f', { status: 'idle', runOutcome: 'failed', updatedAt: at(1) }), mine('g', { status: 'idle', updatedAt: at(2) })]),
        faceCase([mine('f', { status: 'failed', archived: true })]),
      ],
      snapshots: [
        { catalog: { features: {} }, device: { dataScope: 'all' }, tasks: [], approvals: [] },
        snapshot,
        { ...snapshot, apps: [snapshot.apps[1]] },
        { ...snapshot, device: { ...snapshot.device, dataScope: 'work' }, customAgents: undefined },
        { ...snapshot, customAgents: undefined },
        waiting,
        {
          ...waiting,
          tasks: [{ id: 'w', status: 'running', updatedAt: at(2), live: { activity: 'cancelling' } }],
          approvals: [{ sessionId: 'w' }],
        },
        // A topic of 我的 Agent waits on you: 我的 Agent's dot, never Code's.
        { ...snapshot, tasks: [{ id: 'aw', status: 'waiting-approval', updatedAt: at(2), agent: { customAgentId: review } }] },
      ],
      unsplit: { ...snapshot, catalog: { ...catalog, features: {} } },
    })
    expect(result.tabs).toEqual([
      ['Code', '设置'],
      ['Code', '我的 Agent', '应用', '设置'],
      ['Code', '我的 Agent', '设置'],
      ['Code', '我的 Agent', '应用', '设置'],
      ['Code', '我的 Agent', '应用', '设置'],
      ['Code', '我的 Agent', '应用', '设置'],
      ['Code', '我的 Agent', '应用', '设置'],
      ['Code', '我的 Agent', '应用', '设置'],
    ])
    // The dot shows only away from Code, and a stop already asked for answers what waits.
    expect(result.dots).toEqual([
      [false, false],
      [false, false],
      [false, false],
      [false, false],
      [false, false],
      [true, false],
      [false, false],
      [false, false],
    ])
    expect(result.agentDots).toEqual([...Array.from({ length: 7 }, () => [false, false]), [true, false]])
    // Code lists Code's sessions only: an Agent's topics and a conversation with 通用 are 我的 Agent's, as on the web.
    expect(result.spaces).toEqual(['agents', 'agents', 'agents', 'code', 'agents', 'agents', 'agents'])
    expect(result.codeTasks).toEqual(['d'])
    expect(result.agentTasks).toEqual(['a', 'b', 'c', 'e', 'g', 'r'])
    expect(result.unsplit).toEqual([7, 0])
    expect(result.elsewhere).toEqual([true, false, false])
    // Outside a content window a phone shows nothing of an Agent, whatever the snapshot holds.
    expect(result.access).toEqual([
      ['hidden', 'hidden'],
      ['ready', 'closed'],
      ['ready', 'closed'],
      ['locked', 'locked'],
      ['confirming', 'closed'],
      ['ready', 'closed'],
      ['ready', 'closed'],
      ['ready', 'closed'],
    ])
    expect(result.generalDefaults).toEqual([
      {
        harness: 'standard',
        block: '',
        fields: {
          prompt: '你好',
          customAgentId: 'general',
          harnessId: 'standard',
          mode: 'agent',
          workspaceId: 'default',
          model: { providerId: 'svc', model: 'm1' },
        },
      },
      { harness: 'standard', block: 'Latch 内置暂不可用', fields: null },
      { harness: 'standard', block: 'Latch 内置暂不可用', fields: null },
    ])
    expect(result.entries).toEqual([
      {
        id: 'general',
        name: '通用',
        general: true,
        duty: '没选别的 Agent 的会话都带上它',
        runs: '内置 · 每个会话自己选 Harness',
        place: null,
        available: true,
        reason: null,
        avatar: ['round', 'dot', 'neutral'],
        face: 'idle',
      },
      {
        id: review,
        name: '代码审阅',
        general: false,
        duty: '只报真实的问题',
        runs: 'Codex',
        place: 'latch',
        available: true,
        reason: null,
        avatar: ['curly', 'arc', 'plum'],
        face: 'idle',
      },
      {
        id: daily,
        name: '每日简报',
        general: false,
        duty: '汇总依赖',
        runs: 'Latch · m2',
        place: '家',
        available: true,
        reason: null,
        avatar: ['square', 'oval', 'moss'],
        face: 'idle',
      },
      {
        id: docs,
        name: '文档整理',
        general: false,
        duty: '整理',
        runs: 'gone',
        place: '项目已移除',
        available: false,
        reason: '没有安装。',
        avatar: ['round', 'dot', 'neutral'],
        face: 'resting',
      },
    ])
    // The face from the Agent's own sessions: 等你处理, 运行中, 休息, then a failure of its latest unarchived session.
    // At most three faces move a squint or a looping prop at once, and the places pass around all ten.
    expect(result.slots).toEqual({ peak: 3, turns: 10, fourthWaits: true, afterRelease: true })
    expect(result.faces).toEqual(['idle', 'running', 'waiting', 'waiting', 'idle', 'resting', 'running', 'failed', 'idle', 'idle'])
    expect(result.harnesses).toEqual(['standard', 'codex'])
    expect(result.choices).toEqual([
      { harness: 'codex', workspace: 'latch', model: '' },
      { harness: 'standard', workspace: 'default', model: 'm2' },
      { harness: '', workspace: 'default', model: '' },
    ])
    expect(result.blockers).toEqual(['', '', '没有安装。'])
    expect(result.offline).toBe('Mac 不在线，恢复后再发')
    expect(result.cannotRun).toBe('这台设备不能开始会话')
    expect(result.fields).toEqual([
      { prompt: '看一下', customAgentId: review, harnessId: 'codex', mode: 'agent', workspaceId: 'latch' },
      // The start folder is sent as picked; the Host takes it over the Agent's own project.
      {
        prompt: '看一下',
        customAgentId: daily,
        harnessId: 'standard',
        mode: 'chat',
        workspaceId: 'default',
        model: { providerId: 'svc', model: 'm2' },
      },
      null,
    ])
    // A stale client pick cannot move an Agent to another Harness, or reuse its model there.
    expect((result.changedHarness as unknown[]).slice(0, 2)).toEqual((result.fields as unknown[]).slice(0, 2))
    // History is sorted separately; the Host's slot deliberately points to the older surviving session.
    expect(result.topics).toEqual([
      { open: ['g'], archived: [], current: 'g' },
      { open: ['r', 'a', 'b'], archived: ['c'], current: 'b' },
      { open: [], archived: [], current: null },
      { open: [], archived: [], current: null },
    ])
    expect(result.topicWords).toEqual(['', '', '', '', '', '运行中', ''])
    expect(result.placeholder).toBe('给 代码审阅 发消息…')
    expect(result.generalChoice).toEqual(['standard', '', 'm1'])
    expect(result.generalFields).toEqual([
      {
        prompt: '你好',
        customAgentId: 'general',
        harnessId: 'standard',
        mode: 'agent',
        workspaceId: 'default',
        model: { providerId: 'svc', model: 'm1' },
      },
      null,
    ])
    expect(result.generalBlockers).toEqual(['', 'Latch 内置暂不可用', 'Mac 不在线，恢复后再发'])
    expect(result.kits).toEqual(['2 个技能 · 全部插件', '全部已启用的技能 · 全部插件', '全部已启用的技能 · 全部插件'])
    expect(result.owners).toEqual(['代码审阅', '代码审阅', '代码审阅', '', '已删除的 Agent', '通用', '代码审阅'])
    // Outside a window nothing of an Agent shows, and closing one takes the lists and proposal counts out of memory.
    expect(result.closedWindow).toEqual([0, 0, 0])
    expect(result.ownersClosed).toEqual(['我的 Agent', '我的 Agent', '我的 Agent', '', '我的 Agent', '我的 Agent', '我的 Agent'])
    // Hidden characters are drawn, never kept; each proposal goes after its turn, an unknown turn and a refusal after the last.
    const ids = proposals.map(item => item.id)
    expect(result.proposals).toEqual({
      parsed: [
        [ids[0], 'use pnpm\\u{202E}', '它说过', 'user', '', 'pending'],
        [ids[1], '读到的', '', 'agent', 'external', 'saved'],
        [ids[2], '不要了', '', 'agent', '', 'dismissed'],
        [ids[3], '别的话题', '', 'agent', '', 'pending'],
      ],
      pending: [ids[0], ids[3]],
      placed: { m1: [ids[0]], m3: [ids[1], ids[2], 'refused:req-3'] },
      refused: [['refused:req-3', '内容像是密钥或凭据，没有记下。', 'refused']],
      origins: ['你说的', '它推断的'],
      effects: ['已生效', '清空上下文后生效'],
      signature: [`2:${at(3)}`, '-:'],
    })
    expect(result.memoryChanges).toEqual({ deleted: [mem(3)], edited: [false, true], sources: [['它推断的', 'external', 'a'], null] })
    const decisions = result.decisions as Array<Record<string, unknown> | string>
    expect(decisions[0]).toMatchObject({
      method: 'POST',
      path: `/link/api/custom-agents/${review}/proposals/prp_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d/save`,
      words: '提议的结果待确认',
      kind: `proposal(owner: "${review}")`,
    })
    expect(decisions[1]).toMatchObject({
      path: '/link/api/custom-agents/general/proposals/prp_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d/dismiss',
    })
    expect(decisions[2]).toBe('refused')
    expect(decisions[3]).toMatchObject({
      method: 'POST',
      path: `/link/api/custom-agents/${review}/memories/${memory.id}/undo`,
      body: { baseRevision: 3 },
    })
    expect(decisions[4]).toMatchObject({
      method: 'DELETE',
      path: `/link/api/custom-agents/${review}/memories/${memory.id}/undo`,
      body: { baseRevision: 2 },
    })
    expect(decisions[5]).toMatchObject({
      method: 'POST',
      path: `/link/api/automations/${schedule}/enabled`,
      body: { enabled: false, baseRevision: 4 },
      words: '定时任务的开关结果待确认',
      kind: `schedule(id: "${schedule}")`,
    })
    expect(decisions[6]).toBe('refused')
    for (const write of decisions.filter(item => typeof item !== 'string')) {
      const { body, requestId } = write as { body: { requestId: string }; requestId: string }
      expect(body.requestId).toBe(requestId)
    }
    expect(result.scheduleBlockers).toEqual([
      '这个 Agent 现在不能用于定时任务。',
      '',
      '',
      'Mac 不在线，恢复后再改',
      '这台设备只能查看定时任务：它没有开始会话的权限。',
    ])
    expect(result.manualScheduleBlockers).toEqual(['', '没有安装。', '这台设备只能查看定时任务：它没有开始会话的权限。'])
    expect(result.automations).toEqual([[], ['依赖检查', '周报'], []])
    expect(result.generalAutomations).toEqual(['早报'])
    expect(result.schedules).toEqual(['工作日 09:00 · 已开启 · 完成', '每周五 17:30 · 已暂停 · 没有运行', '每天 08:00 · 已关闭 · 没有运行'])
    expect(result.skills).toEqual(['全部已启用的技能', '不用技能', '审阅清单、gone:x'])
    expect(result.apps).toEqual([['release-check/main', '发布检查', '插件 · 发布检查']])
    const writes = result.memoryWrites as Array<Record<string, unknown> | string>
    const base = `/link/api/custom-agents/${review}/memories`
    expect(writes[0]).toMatchObject({ method: 'POST', path: base, body: { content: '用 pnpm' }, words: '记忆的修改结果待确认' })
    expect(writes[1]).toMatchObject({ method: 'PATCH', path: `${base}/${memory.id}`, body: { content: '改过', baseRevision: 3 } })
    expect(writes[2]).toMatchObject({ method: 'DELETE', path: `${base}/${memory.id}` })
    for (const write of writes.slice(0, 3)) {
      const { body, requestId } = write as { body: { requestId: string }; requestId: string }
      expect(body.requestId).toBe(requestId)
    }
    expect(writes.slice(3)).toEqual(['refused', 'refused', 'refused', 'refused'])
    expect(
      (result.pendingKinds as Array<{ words: string; kind: string; prompt: string | null }>).map(item => [
        item.words,
        item.kind,
        item.prompt,
      ]),
    ).toEqual([
      ['提交结果待确认', 'start', 'x'],
      ['第一条消息结果待确认', `topic(owner: "${review}")`, 'x'],
      ['提交结果待确认', 'session(id: "ses_1")', 'x'],
      ['切换结果待确认', 'session(id: "ses_1")', null],
      ['第一条消息结果待确认', 'topic(owner: "general")', 'x'],
    ])
    // 放弃这次提交 settles a message its session already lists by requestId as delivered; nothing else counts.
    expect(result.delivered).toEqual([true, false, false, false, false])
    // A queue item with the same text is only named (it may be another device's); returned text never replaces what was typed.
    expect(result.queued).toEqual(['waiting', 'parked', '', '', ''])
    expect(result.joined).toEqual(['回来的', '新写的\n\n回来的'])
  })
  it('keeps a page on its own owner, gives a held topic back once, retries a start only where it can open, and drops stale or closed proposal reads', async () => {
    const owner = `agt_${'1'.repeat(8)}-1111-4111-8111-${'1'.repeat(12)}`
    const at = (minute: number) => `2026-11-01T10:${String(minute).padStart(2, '0')}:00.000Z`
    const result = await invoke({
      operation: 'phoneAgentPages',
      owner,
      snapshot: {
        catalog: { features: { singleAgentChat: true } },
        agentChats: { [owner]: { state: 'ready', sessionId: 'old' }, general: { state: 'starting' } },
      },
      tasks: [
        { id: 'new', updatedAt: at(9), agent: { customAgentId: owner } },
        { id: 'old', updatedAt: at(1), agent: { customAgentId: owner } },
        { id: 'code', updatedAt: at(8) },
        { id: 'theirs', updatedAt: at(7), agent: { customAgentId: owner.replace('1', '2') } },
      ],
      proposals: {
        proposals: [
          {
            id: `prp_${'3'.repeat(8)}-3333-4333-8333-${'3'.repeat(12)}`,
            content: '用 pnpm',
            origin: 'user',
            external: false,
            state: 'pending',
            source: { sessionId: 'new' },
          },
        ],
      },
    })
    expect(result.shown).toEqual(['old', '', 'starting', '', ''])
    expect(result.history).toEqual([
      ['agents', ''],
      ['agents', 'current'],
      ['code', ''],
      ['code', ''],
    ])
    // An unknown start empties the input, so 放弃这次提交 gives the text back once.
    expect(result.prompts).toEqual(['', '你好', '你好', '你好', ''])
    expect(result.abandonable).toEqual(['你好', '', ''])
    expect(result.retried).toEqual([
      [false, true, true],
      [false, false, true],
      [true, true, true],
      [true, true, true],
      [true, true, true],
    ])
    expect(result.topicOwners).toEqual([owner, ''])
    expect(result.held).toEqual([true, true, true, true])
    // Only the latest read is adopted; clearing (lock, window closed) drops a read in flight; a closed window adopts nothing.
    expect(result.store).toEqual([false, true, true, false, true, false, true])
    // After the window expires, the sheet closes what it showed and never reads (and so never verifies) again.
    expect(result.contentChange).toEqual(['close', 'reload', 'none'])
  })
  it('words, places and stacks result cards, schedule proposals, 动态 and 资料库 as the web does, and drops them with the window', async () => {
    const owner = `agt_${'1'.repeat(8)}-1111-4111-8111-${'1'.repeat(12)}`
    const schedule = `auto_${'a'.repeat(8)}-aaaa-4aaa-8aaa-${'a'.repeat(12)}`
    const memory = `prp_${'3'.repeat(8)}-3333-4333-8333-${'3'.repeat(12)}`
    const proposed = `prp_${'4'.repeat(8)}-4444-4444-8444-${'4'.repeat(12)}`
    const on = (day: string, time: string) => `2026-11-${day}T${time}:00.000Z`
    const card = (id: string, extra: Record<string, unknown>) => ({
      id,
      automationId: schedule,
      owner,
      name: '早间‮精选',
      trigger: 'manual',
      runAt: on('13', '09:00'),
      ...extra,
    })
    const snapshot = {
      catalog: {
        sessionFolders: true,
        workspaces: [
          { id: 'default', name: '默认文件夹' },
          { id: 'app', name: 'App' },
          { id: 'off', name: 'Off', unavailable: 'removed' },
        ],
      },
      customAgents: [{ id: owner, defaultProjectId: 'app', canAutomate: true, available: true, revision: 2, memoryCount: 1 }],
      automations: [{ id: schedule, customAgentId: owner, state: 'ready', revision: 1, enabled: true }],
      agentResults: { [owner]: { unbound: 2, at: on('13', '11:00') } },
      agentProposals: { [owner]: { pending: 1, at: on('13', '11:30') } },
      tasks: [
        { id: 't1', agent: { customAgentId: owner }, status: 'idle', updatedAt: on('13', '10:11') },
        { id: 'run1', agent: { customAgentId: owner }, automationId: schedule, status: 'idle', updatedAt: on('13', '10:04') },
        {
          id: 'generalRun',
          automationId: `auto_${'c'.repeat(8)}-cccc-4ccc-8ccc-${'c'.repeat(12)}`,
          status: 'idle',
          updatedAt: on('13', '10:04'),
        },
      ],
    }
    const projects = [
      { id: 'default', name: '默认文件夹' },
      { id: 'app', name: 'App' },
      { id: 'multi', name: 'Multi', folders: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
      { id: 'code', name: 'Latch', codeRoot: true },
    ]
    const result = await invoke({
      operation: 'phoneAgentActivity',
      owner,
      now: on('13', '12:00'),
      snapshot,
      savedProposals: {
        proposals: [
          {
            id: proposed,
            kind: 'schedule',
            schedule: { name: '早间精选', plan: { kind: 'weekly', day: 1, time: '20:30' } },
            content: '整理',
            origin: 'agent',
            external: false,
            state: 'saved',
            automationId: schedule,
            source: { sessionId: 't1' },
          },
        ],
      },
      locationCases: [
        {
          catalog: { sessionFolders: false, workspaces: projects },
          harness: { id: 'codex', projectFolders: { access: 'all', max: 2 }, capabilities: { display: { label: 'Codex' } } },
        },
        { catalog: { sessionFolders: true, workspaces: projects }, harness: null },
      ],
      sameNames: [
        {
          id: 'same',
          automationId: schedule,
          owner,
          name: 'n',
          outcome: 'completed',
          at: on('13', '10:00'),
          files: [
            { root: 'a', path: 'f.md', change: 'created' },
            { root: 'b', path: 'f.md', change: 'created' },
          ],
        },
      ],
      streaming: { ...snapshot, tasks: [{ ...snapshot.tasks[0], status: 'running' }, snapshot.tasks[1]] },
      results: [
        card('r3', { outcome: 'failed', at: on('13', '10:20'), failure: { reason: '没有权限', code: 'http-401' } }),
        card('r1', {
          outcome: 'completed',
          at: on('13', '10:05'),
          sessionId: 'run1',
          topicId: 't1',
          reply: '一\n二\n三\n四\n五',
          files: [
            { root: 'r', path: 'a​b.md', change: 'created' },
            { root: 'r', path: 'gone.md', change: 'deleted' },
          ],
          filesMore: 2,
        }),
        card('r2', { outcome: 'failed', at: on('13', '10:15'), sessionId: 'missing', failure: { reason: '超时' } }),
        card('r4', {
          outcome: 'interrupted',
          at: on('13', '09:00'),
          automationId: `auto_${'b'.repeat(8)}-bbbb-4bbb-8bbb-${'b'.repeat(12)}`,
          contentRemoved: true,
        }),
        { id: 'broken', owner },
      ],
      detail: {
        summary: { id: 't1' },
        messages: [
          { id: 'm1', role: 'user', text: '你好', createdAt: on('13', '10:00') },
          { id: 'a1', role: 'assistant', text: '在', createdAt: on('13', '10:01') },
          { id: 'm2', role: 'user', text: '再来', createdAt: on('13', '10:10') },
          { id: 'a2', role: 'assistant', text: '好', createdAt: on('13', '10:11') },
        ],
      },
      proposals: {
        proposals: [
          { id: memory, content: '用 pnpm', origin: 'user', external: false, state: 'pending', source: { sessionId: 't1' } },
          {
            id: proposed,
            kind: 'schedule',
            schedule: { name: '早间精选', plan: { kind: 'weekly', day: 1, time: '20:30' } },
            content: '\n  整理今天的 AI 新闻\n第二行',
            origin: 'agent',
            external: true,
            state: 'pending',
            source: { sessionId: 't1' },
          },
          {
            id: `prp_${'5'.repeat(8)}-5555-4555-8555-${'5'.repeat(12)}`,
            kind: 'later',
            content: 'x',
            origin: 'agent',
            state: 'pending',
            source: { sessionId: 't1' },
          },
        ],
      },
      activity: {
        items: [
          { kind: 'result', id: 'e1', at: on('13', '11:00'), resultId: 'r1', name: '早间精选', outcome: 'completed', topicId: 't1' },
          { kind: 'run', id: 'e2', at: on('13', '10:00'), automationId: schedule, name: '早间精选', state: 'running', sessionId: 'run1' },
          { kind: 'memory', id: 'e3', at: on('10', '08:00'), change: 'deleted', memoryId: 'mem_1' },
          {
            kind: 'proposal',
            id: 'e4',
            at: on('10', '07:00'),
            proposalId: proposed,
            proposal: 'schedule',
            state: 'pending',
            sessionId: 't1',
          },
          { kind: 'topic', id: 'e5', at: '2026-10-24T08:00:00.000Z', sessionId: 't1', title: '' },
          { kind: 'run', id: 'e6', at: '2026-10-23T08:00:00.000Z', automationId: schedule, name: '周报', state: 'missed' },
          { kind: 'later', id: 'e7', at: '2026-10-22T08:00:00.000Z' },
        ],
      },
      library: {
        groups: [
          {
            sessionId: 'run1',
            title: '早间精选',
            at: on('13', '10:05'),
            automationId: schedule,
            items: [
              { kind: 'file', sessionId: 'run1', root: 'r', path: 'out/news.md', change: 'created', at: on('13', '10:05') },
              { kind: 'file', sessionId: 'run1', root: 'r', path: 'old.md', change: 'deleted', at: on('13', '10:05') },
              {
                kind: 'attachment',
                sessionId: 'run1',
                messageId: 'm1',
                attachment: { id: 'att_1', name: '图.png', kind: 'image' },
                at: on('13', '10:00'),
              },
            ],
            more: 3,
          },
          { sessionId: 't1', title: '', at: on('13', '10:00'), items: [] },
        ],
      },
    })
    const step = `runNow(automationId: "${schedule}")`
    expect(result.results).toEqual([
      expect.objectContaining({ id: 'r4', outcome: '已中断', tone: 'warn', removed: true, run: null, step: null }),
      expect.objectContaining({
        id: 'r1',
        name: '早间\\u{202E}精选',
        outcome: '已完成',
        tone: 'done',
        preview: ['一\n二\n三\n四…', true],
        files: [
          ['a\\u{200B}b.md', '新增', ''],
          ['gone.md', '已删除', 'deleted'],
        ],
        more: 2,
        run: 'run1',
        step: null,
      }),
      expect.objectContaining({
        id: 'r2',
        outcome: '失败',
        tone: 'failed',
        reason: '超时',
        run: null,
        step,
        stepOffline: true,
        stepViewOnly: true,
      }),
      expect.objectContaining({ id: 'r3', outcome: '失败', reason: '没有权限', step: null }),
    ])
    // Each card after the last turn that began before its run settled; one before every turn stands first.
    expect(result.placed).toEqual({ '': ['r4'], m1: ['r1'], m2: ['r2', 'r3'] })
    // At most three in one place, the rest counted for 「还有 N 条结果」.
    expect(result.stack).toEqual([1, ['r1', 'r2', 'r3']])
    expect(result.runNow).toEqual([
      expect.objectContaining({
        method: 'POST',
        path: `/link/api/automations/${schedule}/run`,
        words: '立即运行结果待确认',
        kind: `run(id: "${schedule}")`,
      }),
      'refused',
    ])
    expect(result.signature).toEqual([`2:${on('13', '11:00')}:present`, '0::absent'])
    expect(result.waiting).toEqual([true, false])
    // A proposal of an unknown kind is left out; a schedule proposal is no memory and 记忆 does not list it.
    expect(result.proposals).toEqual([
      [memory, 'memory', '用 pnpm'],
      [proposed, 'schedule', '早间精选 · 每周一 20:30'],
    ])
    expect(result.memoryPending).toEqual([memory])
    expect(result.inputLine).toBe('整理今天的 AI 新闻')
    expect(result.locations).toEqual(['app', 'off', 'default'])
    expect(result.location).toBe('app')
    expect(result.homeLocation).toBe('default')
    expect(result.formBlockers).toEqual(['先选工作位置', '这个项目已不可用。', '', 'Mac 不在线，恢复后再改'])
    const creates = result.creates as Array<{ body: Record<string, unknown> } | string>
    expect(creates[0]).toMatchObject({
      method: 'POST',
      path: '/link/api/automations',
      words: '定时任务的保存结果待确认',
      kind: 'scheduleCreate',
      body: {
        name: '早间精选',
        prompt: '整理今天的 AI 新闻\n第二行',
        schedule: { kind: 'weekly', day: 1, time: '20:30' },
        notify: true,
        proposalId: proposed,
        customAgentId: owner,
        projectId: 'app',
      },
    })
    expect((creates[1] as { body: Record<string, unknown> }).body).not.toHaveProperty('customAgentId')
    expect((creates[1] as { body: Record<string, unknown> }).body).not.toHaveProperty('projectId')
    expect(creates[2]).toBe('refused')
    expect(creates[3]).toMatchObject({ body: { enabled: false, customAgentId: owner } })
    expect((creates[3] as { body: Record<string, unknown> }).body).not.toHaveProperty('projectId')
    expect(result.heldCreate).toEqual([true, true])
    // 动态: words and states only, never a memory's or a proposal's text; each row leads where it happened.
    expect(result.activity).toEqual([
      ['定时结果', '早间精选', '已完成', 'done', 'session:t1'],
      ['定时', '早间精选', '运行中', 'running', 'session:run1'],
      ['记忆 −1', '', '', 'neutral', 'memory'],
      ['提议定时', '', '等你决定', 'warn', 'session:t1'],
      ['新话题', '未命名会话', '', 'neutral', 'session:t1'],
      ['定时', '周报', '错过', 'warn', ''],
    ])
    expect(result.buckets).toEqual([
      ['今天', ['e1', 'e2']],
      ['本周', ['e3', 'e4']],
      ['更早', ['e5', 'e6']],
    ])
    expect(result.library).toEqual([
      [
        '早间精选',
        true,
        [
          ['out/news.md', '新增', 'r', 'out/news.md', true, false],
          ['old.md', '已删除', 'r', 'old.md', false, false],
          ['图.png', '你给的', '@attachment', 'att_1', true, true],
        ],
        3,
      ],
      ['未命名会话', false, [], 0],
    ])
    expect(result.paths).toEqual([
      `/link/api/custom-agents/${owner}/activity`,
      `/link/api/custom-agents/${owner}/library?before=2026-11-01T10%3A00%3A00.000Z%7Cres%3Aauto_1%7Cx`,
      'refused',
      'refused',
      'refused',
    ])
    expect(result.readable).toEqual([true, false, false])
    const [still, streaming] = result.activitySignature as string[]
    expect(streaming).toContain('t1:live')
    expect(still).not.toContain('live')
    // A later page joins only the load it continues; a closed window adopts nothing, and a lock drops what was read.
    expect(result.paged).toEqual([true, true, false, true, ['a2', 'c'], false, true])
    expect(result.storeAfterClear).toBe(false)
    // 加载更多 right after a reload began asks for nothing; the reload's own next page can be read once it lands.
    expect(result.reload).toEqual([true, true])
    // A retry settles only on a replayed receipt, or agent-proposal-decided for a proposal's own writes; the Host's words
    // are shown for every other refusal, and a save the Host shows as saved is done.
    expect(result.writes).toEqual({
      handles: [true, true, true, true, false],
      answered: [true, true, false, true, false, false],
      outcomes: ['done', 'changed', 'changed', '最多保存 64 个定时任务。', 'changed', 'changed', '没有完成。'],
      check: ['已保存为定时任务', '没有保存，可以再保存一次', '这条提议已不在了', '还没有处理，可以再选一次', '已按电脑上现在的状态显示'],
      words: ['记忆提议的结果待确认', '定时提议的结果待确认', '提议的结果待确认', '定时任务的保存结果待确认', '立即运行结果待确认'],
      owners: [owner, owner, ''],
    })
    // The owner's home stays available independently of Code's folder setting; project restrictions remain visible.
    expect(result.locations2).toEqual([
      [
        ['app', '', false],
        ['multi', 'Codex 最多使用 2 个文件夹', false],
        ['code', '', true],
        ['default', '', false],
      ],
      [
        ['app', '', false],
        ['multi', '', false],
        ['code', '', true],
        ['default', '', false],
      ],
    ])
    // A run of 通用's schedule names no Agent: it opens in Code.
    expect(result.home).toEqual(['agents', 'code', 'code'])
    expect(result.fileIds).toBe(2)
    // Taking the window down drops the Agents, schedules, counts, proposals and waiting cards, and a read in flight.
    expect(result.takeDown).toEqual([true, true, true, true, true, true, true, true])
    expect(result.private).toBe(true)
  })
  it('words 「电脑」 as the web does, writes the switches on the revision seen, and drops the computer with the window', async () => {
    const owner = `agt_${'1'.repeat(8)}-1111-4111-8111-${'1'.repeat(12)}`
    const other = `agt_${'2'.repeat(8)}-2222-4222-8222-${'2'.repeat(12)}`
    const daily = `auto_${'a'.repeat(8)}-aaaa-4aaa-8aaa-${'a'.repeat(12)}`
    const weekly = `auto_${'b'.repeat(8)}-bbbb-4bbb-8bbb-${'b'.repeat(12)}`
    const now = '2026-11-13T12:00:00.000Z'
    // The web's `whenWords`, by this machine's clock as the Swift fixture reads it.
    const when = (at: string) => {
      const date = new Date(at),
        today = new Date(now)
      const key = (value: Date) => `${value.getFullYear()}-${value.getMonth()}-${value.getDate()}`
      const offset = (days: number) => key(new Date(today.getFullYear(), today.getMonth(), today.getDate() + days))
      const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
      if (key(date) === offset(0)) return `今天 ${clock}`
      if (key(date) === offset(1)) return `明天 ${clock}`
      if (key(date) === offset(-1)) return `昨天 ${clock}`
      const year = date.getFullYear() === today.getFullYear() ? '' : `${date.getFullYear()}年`
      return `${year}${date.getMonth() + 1}月${date.getDate()}日 ${clock}`
    }
    const snapshot = {
      device: { dataScope: 'all' },
      catalog: { features: { customAgents: true, automations: true } },
      computer: { desktop: false, wokeAt: '2026-11-13T10:00:00.000Z' },
      customAgents: [
        { id: owner, revision: 3, notifications: { completed: false, failed: true, waiting: true }, keepAwakeForSchedules: true },
        { id: other, revision: 1 },
      ],
      automations: [
        { id: daily, customAgentId: owner, revision: 1, lastRun: { at: '2026-11-12T08:00:00.000Z', state: 'missed' } },
        { id: weekly, customAgentId: owner, revision: 2 },
      ],
      tasks: [],
    }
    const result = await invoke({
      operation: 'phoneAgentComputer',
      owner,
      now,
      snapshot,
      computer: {
        computer: snapshot.computer,
        missed: [
          { automationId: daily, name: '晨报', at: '2026-11-13T08:00:00.000Z', cause: 'sleep' },
          { automationId: weekly, name: '周\u202E报', at: '2026-11-12T20:00:00.000Z', cause: 'unknown' },
          { automationId: daily, name: '晨报', at: '2026-11-12T08:00:00.000Z', cause: 'off' },
          { automationId: daily, name: '晨报', at: '2026-11-11T08:00:00.000Z', cause: 'later' },
          { automationId: 'auto_bad', name: '坏', at: '2026-11-11T08:00:00.000Z', cause: 'sleep' },
        ],
      },
      awake: { computer: { desktop: true, keepAwake: 'schedule' }, missed: [] },
    })
    expect(result.online).toEqual({
      status: '在线',
      tone: 'done',
      awakeFor: null,
      woke: when('2026-11-13T10:00:00.000Z'),
      missedTotal: 3,
      missed: [
        {
          name: '晨报',
          times: [`${when('2026-11-13T08:00:00.000Z')}：Mac 在睡眠`, `${when('2026-11-12T08:00:00.000Z')}：Mac 关机或 Latch 没有运行`],
        },
        { name: '周\\u{202E}报', times: [`${when('2026-11-12T20:00:00.000Z')}：睡眠、关机或 Latch 没有运行`] },
      ],
      keepAwakeNote: 'Latch 应用没有运行，现在不起作用',
    })
    expect(result.sleeping).toMatchObject({ status: '睡眠中', tone: 'neutral', keepAwakeNote: null, missedTotal: 3 })
    expect(result.offline).toEqual({
      status: '不在线',
      tone: 'warn',
      awakeFor: null,
      woke: null,
      missedTotal: 0,
      missed: [],
      keepAwakeNote: null,
    })
    expect(result.awake).toMatchObject({
      status: '保持唤醒中',
      tone: 'done',
      awakeFor: '定时任务快到点了',
      keepAwakeNote: null,
      woke: null,
    })
    expect(result.unparsed).toBe(true)
    expect(result.path).toBe(`/link/api/custom-agents/${owner}/computer`)
    expect(result.badPath).toBe('refused')
    expect(result.notifications).toEqual([
      { label: '完成', on: false },
      { label: '失败', on: true },
      { label: '需要你处理', on: true },
    ])
    expect(result.keepAwake).toBe(true)
    const writes = result.writes as Record<string, { body: Record<string, unknown> } & Record<string, unknown>>
    expect(writes.keepAwake).toMatchObject({
      method: 'PATCH',
      path: `/link/api/custom-agents/${owner}`,
      body: { keepAwakeForSchedules: true, baseRevision: 3 },
      words: '保持唤醒的开关结果待确认',
      kind: `agent(id: "${owner}")`,
      handled: true,
    })
    // Exactly these keys: nothing else of the Agent goes with a switch.
    const requestId = expect.stringMatching(/^[A-Za-z0-9_-]{16,80}$/u)
    expect(writes.keepAwake!.body).toEqual({ keepAwakeForSchedules: true, baseRevision: 3, requestId })
    expect(writes.backToDefault).toMatchObject({
      method: 'PATCH',
      path: `/link/api/custom-agents/${owner}`,
      words: '通知开关的结果待确认',
      handled: true,
    })
    expect(writes.backToDefault!.body).toEqual({ notifications: null, baseRevision: 3, requestId })
    expect(writes.firstOff).toMatchObject({ path: `/link/api/custom-agents/${other}` })
    expect(writes.firstOff!.body).toEqual({ notifications: { completed: true, failed: true, waiting: false }, baseRevision: 1, requestId })
    // Free; then each of: a switch being written, busy, this Agent's held change, another pending write, offline, view only.
    expect(result.locked).toEqual([false, true, true, true, true, true, true])
    // backToDefault turns 完成 on, firstOff turns 需要你处理 off, keep-awake is no notification; one the Host has is none.
    expect(result.heldKind).toEqual(['completed', 'waiting', null, 'none'])
    expect(writes.general).toBe('refused')
    expect(result.held).toEqual({ keepAwake: true, notifications: true })
    expect(result.blocker).toEqual(['Mac 不在线，恢复后再改', '这台设备只能查看：它没有开始会话的权限。', null])
    expect(result.shown).toEqual([true, false, false])
    expect(result.private).toEqual([true, true, true])
    expect(result.signature).toEqual([true, true, true])
    expect(result.when).toEqual(
      [
        '2026-11-13T09:00:00.000Z',
        '2026-11-14T09:00:00.000Z',
        '2026-11-12T09:00:00.000Z',
        '2026-11-01T09:00:00.000Z',
        '2025-11-01T09:00:00.000Z',
      ].map(when),
    )
  })

  it('derives 接入已有会话 the phone shows: the entry, 继续用, the list and preview, the writes and the marks', async () => {
    const harness = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      status: 'ready',
      capabilities: { display: { label: id === 'codex' ? 'Codex' : id === 'pi' ? 'Pi' : 'Latch', mark: id } },
      ...extra,
    })
    const catalog = (features: Record<string, unknown> = { historyImport: 1 }) => ({
      features,
      workspaces: [
        { id: 'default', name: '默认文件夹' },
        { id: 'app', name: 'App', path: '/work/app', folders: [{ id: 'f1', path: '/work/app' }] },
      ],
      harnesses: [
        harness('standard'),
        harness('codex', { history: { list: true, rebuild: true } }),
        harness('pi', { history: { rebuild: true } }),
        harness('gone', { status: 'missing', history: { list: true, rebuild: true } }),
      ],
    })
    const device = (scopes: string[], dataScope: string) => ({ scopes, dataScope })
    const handle = (n: string) => `hh_${n.repeat(32)}`
    const prefix = '用户：登录坏了\n助手：看 auth.ts 😀\n'
    const result = await invoke({
      operation: 'phoneHistory',
      snapshots: [
        { catalog: catalog(), device: device(['view', 'run'], 'all'), choose: 'app' },
        { catalog: catalog(), device: device(['view', 'run'], 'work'), choose: 'app' },
        { catalog: catalog({}), device: device(['view', 'run'], 'all'), choose: 'app' },
        { catalog: catalog(), device: device(['view'], 'all'), choose: 'app' },
        { catalog: catalog(), device: device(['view', 'run'], 'all'), choose: 'default' },
        { catalog: catalog(), device: device(['view', 'run'], 'all') },
        { catalog: { ...catalog(), harnesses: [harness('standard')] }, device: device(['view', 'run'], 'all'), choose: 'app' },
      ],
      tasks: [
        { id: 'ses_lost', harnessId: 'pi', imported: { from: 'codex', mode: 'native' } },
        { id: 'ses_text', harnessId: 'pi', imported: { from: 'other', mode: 'text', prefixLength: 10, fromTaskId: 'ses_lost' } },
        { id: 'ses_plain', harnessId: 'standard' },
      ],
      project: { id: 'app', name: 'App', path: '/work/app', folders: [{ id: 'f1', path: '/work/app' }] },
      list: {
        rows: [
          { handle: handle('a'), title: 'Web build', updatedAt: '2026-11-11T08:00:00.000Z', subdir: 'web/' },
          { handle: handle('b'), title: 'Login', subdir: '', importedTaskId: 'task-1' },
          { handle: 'hh_bad', title: 'Not a handle', subdir: '' },
        ],
        otherFolders: 2,
        scanned: 5,
        truncated: true,
      },
      preview: {
        previewId: `hp_${'c'.repeat(32)}`,
        title: 'Web build',
        model: 'gpt-5.5',
        turns: 2,
        truncated: false,
        messages: [
          { role: 'user', text: 'Fix it' },
          { role: 'tool', text: 'Run printenv', outputHidden: true, status: 'completed' },
          { role: 'tool', text: 'Run tests', outputHidden: true, status: 'failed' },
          { role: 'assistant', text: 'Done', clipped: true },
          { role: 'system', text: 'never shown' },
        ],
      },
      message: { role: 'user', text: `${prefix}接着改`, importContext: { from: 'Codex', prefixLength: prefix.length } },
    })
    expect(result.entries).toEqual([['codex:Codex'], 'locked', 'locked', 'hidden', 'hidden', 'hidden', 'hidden'])
    // The source as it was, then every other ready Harness that takes a text rebuild; the lost session's own first.
    expect(result.targets).toEqual(['codex:native', 'pi:text'])
    expect(result.rebuildTargets).toEqual(['pi:text', 'codex:text'])
    expect(result.rebuilt).toBe('ses_text')
    expect(result.offers).toEqual([true, false, false, false])
    expect(result.views).toEqual([
      'loading',
      `rows ${handle('a')},${handle('b')} 2 true`,
      'empty 3',
      'not-supported',
      'login',
      'failed Codex 当前不可用',
      'failed 暂时无法连接这台电脑。',
      'invalid',
    ])
    expect(result.folders).toEqual(['web/', 'app'])
    expect(result.imported).toEqual(['', 'task-1'])
    expect(result.others).toEqual(['', '另有 2 个在项目的其他文件夹里 · 尚未支持'])
    expect(result.preview).toEqual(['gpt-5.5 · 2 轮', ['Fix it', '完成 · 输出已隐藏', '失败 · 输出已隐藏', 'Done …'], false, true])
    expect(result.previewFailures).toEqual(['busy', 'expired', 'failed 不行'])
    expect(result.reads).toEqual([
      ['/link/api/history/list', 45],
      'refused',
      ['/link/api/history/previews', 90],
      'refused',
      `/link/api/history/previews/hp_${'e5'.repeat(16)}`,
      'refused',
    ])
    const writes = result.writes as Array<Record<string, unknown> | string>
    expect(writes[0]).toEqual({
      method: 'POST',
      path: '/link/api/history/imports',
      body: { previewId: `hp_${'e5'.repeat(16)}`, harnessId: 'codex' },
      sameId: true,
      words: '接入结果未确认',
      import: true,
    })
    expect(writes[1]).toMatchObject({ body: { fromTaskId: 'task-1', harnessId: 'pi' }, sameId: true, import: true })
    expect(writes.slice(2)).toEqual(['refused', 'refused', 'refused'])
    expect(result.attempt).toEqual([true, true, true])
    // A retry refused for a closed preview (nothing came in) or a deleted session (it came in, then went) is settled.
    expect(result.answered).toEqual([true, false, false, true, true, false, true])
    expect(result.outcomes).toEqual(['open task-9', 'busy', 'expired', 'failed Pi 当前不可用', 'not done', 'deleted since'])
    expect(result.receiptPath).toEqual([true, true])
    const other = `hp_${'f6'.repeat(16)}`
    expect(result.closer).toEqual([[], [other], [], [other], [`hp_${'e5'.repeat(16)}`], ['16']])
    expect(result.marks).toEqual([
      ['已接入', '从 Codex 接入 · 原样加载', false],
      ['已接入 · 按文字重建', '从 other 接入 · 按文字重建，不是原样恢复', true],
      null,
    ])
    expect(result.seed).toEqual([true, false, false])
    expect(result.seedWords).toBe('按文字重建，不是原样恢复 · 第一条消息会把重建的对话文字一起发给 DeepSeek')
    // The Host counts in UTF-16 units: the emoji's two count, and the person's words start right after.
    expect(result.fold).toEqual(['按 Codex 会话的文字重建', prefix, '接着改'])
    expect(result.resend).toBe('接着改')
    expect(result.promptSession).toEqual(['task-1', '', ''])
    expect(result.lost).toBe('这个 Harness 已找不到原来的会话，换个新会话继续')
  })
  it('lists, previews, brings in and rebuilds a session from the actual Swift workspace through the fake agent’s own adapter', async () => {
    const scratch = await realpath(await mkdtemp(join(tmpdir(), 'latch-swift-history-')))
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    try {
      const main = join(scratch, 'app')
      const other = join(scratch, 'docs')
      for (const folder of [main, join(main, 'web'), other]) await mkdir(folder, { recursive: true })
      const history = await writeFakeHistory(scratch, [
        {
          sessionId: 'ext-web',
          cwd: join(main, 'web'),
          title: 'Web build',
          updatedAt: '2026-11-11T08:00:00.000Z',
          updates: fakeConversation(),
        },
        { sessionId: 'ext-rebuild', cwd: main, title: 'Rebuild me', updatedAt: '2026-11-10T08:00:00.000Z', updates: fakeConversation() },
        { sessionId: 'ext-phone', cwd: main, title: 'Phone notes', updatedAt: '2026-11-09T08:00:00.000Z', updates: fakeConversation() },
        { sessionId: 'ext-busy', cwd: main, title: 'Open in a terminal', updatedAt: '2026-11-08T08:00:00.000Z', busy: true, updates: [] },
        { sessionId: 'ext-other', cwd: other, title: 'Docs session', updates: [] },
      ])
      const owner = await host.enroll({ listener: 'unix' })
      const env = {
        FAKE_ACP_CONFIG: 'options',
        FAKE_ACP_MODES: 'read-only,workspace-write,agent,agent-full-access',
        FAKE_ACP_INITIAL_MODE: 'agent-full-access',
        FAKE_ACP_CAPS: 'list,load,resume,close,delete,dirs',
        FAKE_ACP_STATE: join(scratch, 'codex-state.json'),
        FAKE_ACP_HISTORY_FILE: history,
      }
      const codex = await owner.confirmed('agents', {
        method: 'POST',
        body: { id: 'codex', name: 'Codex', presetId: 'codex', command: process.execPath, args: [FAKE_ACP_AGENT], env },
      })
      expect(codex.status).toBe(201)
      const fake = await owner.confirmed('agents', {
        method: 'POST',
        body: {
          id: 'fake',
          name: 'Fake',
          command: process.execPath,
          args: [FAKE_ACP_AGENT],
          env: { FAKE_ACP_STATE: join(scratch, 'fake-state.json') },
        },
      })
      expect(fake.status).toBe(201)
      const added = await owner.addFolders({ paths: [main, other] })
      expect(added.status).toBe(201)
      const projectId = ((await added.json()) as { workspace: { id: string } }).workspace.id
      const response = await owner.request('native/pairings', { method: 'POST', body: {} })
      const { invitation } = (await response.json()) as { invitation: { payload: string } }
      const result = await invoke(
        { operation: 'nativeHistory', payload: invitation.payload, port: host.host.nativePort, projectId },
        90_000,
      )
      expect(result).toEqual({
        window: true,
        sources: ['codex'],
        sourcesRoute: ['codex'],
        titles: ['Web build', 'Rebuild me', 'Phone notes', 'Open in a terminal'],
        otherFolders: 1,
        busy: 'busy',
        // Words and tool titles only; nothing of a tool's output or the thinking.
        preview: [expect.arrayContaining(['user', 'assistant', 'tool']), false],
        sameSession: true,
        receipt: [true, true],
        mark: '已接入',
        importedMode: 'native',
        ticked: true,
        expired: 'expired',
        already: true,
        targets: ['codex:native', 'fake:text'],
        rebuilt: ['已接入 · 按文字重建', true],
        closed: 'expired',
        pendingAfter: 0,
      })
      const tasks = (await owner.json<{ tasks: Array<{ imported?: { mode: string } }> }>('snapshot')).tasks
      expect(tasks.map(task => task.imported?.mode).toSorted()).toEqual(['native', 'text'])
    } finally {
      await host.close()
      await rm(scratch, { recursive: true, force: true })
    }
  }, 120_000)
  it('rejects noncanonical base64url, trailing bytes and unsafe integers without trapping', async () => {
    expect(await invoke({ base64url: 'Zm9v' })).toEqual({ base64url: 'Zm9v', base32: 'mzxw6' })
    for (const base64url of ['A', 'Zh', 'Zg==', 'Z g', 'Zg\n']) await expect(invoke({ base64url })).rejects.toThrow('rejected')
    for (const hex of ['ffffffffffffffff', '0020000000000000', '000000000000000100'])
      await expect(invoke({ operation: 'reader', hex, size: 8 })).rejects.toThrow('rejected')
  })
})
