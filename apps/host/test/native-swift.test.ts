import { execFileSync, spawn } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { connect, createServer } from 'node:net'
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
  PADDING,
  PaddingClock,
  paddingBucket,
} from '@latch/link-wire'
import { nodeCrypto } from '@latch/link-client/crypto'
import { FAKE_ACP_AGENT, fakeConversation, swiftFixturePath, testHarness, writeFakeHistory } from '@latch/testkit'
import {
  AGENT_PRESETS,
  BUILTIN_HELPER_CARD,
  NOT_ACCEPTED_5XX,
  TEAM_RETURN_HEADING,
  pairRoute,
  type AppSnapshot,
  type TaskDetail,
  type CustomAgent,
  type HarnessInfo,
  type HostCatalog,
} from '@latch/protocol'
import { startTestHost } from './helpers/host.ts'
import { startNativeHost } from '../src/native.ts'
import { NativeNetwork } from '../src/native-network.ts'
import { nativeComparisonCode } from '../src/auth.ts'
import { loadOrCreateHostIdentity } from '../src/identity.ts'
import { base32 } from '../src/crypto.ts'
import { shapeContent, textShape } from '../src/files/edit.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
/** Every request the Hosts' native listeners received, by the device that sent it, as the Host saw it. */
const nativeSeen = vi.hoisted(() => [] as Array<{ deviceId: string; method: string; path: string }>)
/** `METHOD path` of requests the native listener answers 503 once without passing on: a write the Host never saw. */
const nativeDrop = vi.hoisted(() => new Set<string>())
/** `METHOD path` of requests the native listener holds once for the given milliseconds before passing on. */
const nativeDelays = vi.hoisted(() => new Map<string, number>())
const nativeReadFaults = vi.hoisted(() => new Map<string, Array<{ status: number; code: string }>>())
const nativeEventFaults = vi.hoisted(() => [] as Array<'end' | 'server' | 'transport' | 'metadata' | 'invalid'>)
const nativeMalformedSuccess = vi.hoisted(() => new Set<string>())
const nativeWorkAnswerGate = vi.hoisted(() => new Map<string, string>())
const nativeWorkLostAccess = vi.hoisted(() => new Map<string, number>())
const nativeSnapshotRace = vi.hoisted(() => ({
  current: undefined as
    | { markers?: string; itemId?: string; reads: number; firstRevision?: number; lockOpen?: boolean; sessionList?: boolean }
    | undefined,
}))
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
        completingList?: { revision?: number }
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
          const work = nativeSnapshotRace.current
          if (work && key === 'GET /link/api/snapshot') {
            const end = res.end.bind(res)
            res.end = ((...args: Parameters<typeof res.end>) => {
              if (res.statusCode !== 200 || typeof args[0] !== 'string') return end(...args)
              const snapshot = JSON.parse(args[0]) as AppSnapshot
              const read = ++work.reads
              const base = (work.firstRevision ??= snapshot.revision ?? 0)
              const privateRow = read >= (work.lockOpen ? 2 : 4)
              const restarted = !work.lockOpen && read >= 5
              const item = {
                id: work.itemId,
                title: 'Public before scope change',
                sessionIds: [],
                updatedAt: '2026-11-18T00:00:00.000Z',
                revision: privateRow ? 2 : 1,
                board: { group: 'todo' },
                ...(privateRow ? { private: true } : {}),
              }
              const response = JSON.stringify(
                work.sessionList
                  ? {
                      ...snapshot,
                      revision: base,
                      tasks: read < 3 ? [] : [{ id: 'available-session', title: 'Available after startup' }],
                      tasksComplete: read < 3 ? undefined : true,
                    }
                  : {
                      ...snapshot,
                      instanceId: restarted ? 'fixture-restarted' : snapshot.instanceId,
                      revision: restarted ? 1 : base + Math.max(0, read - (work.lockOpen ? 1 : 2)),
                      device: { ...snapshot.device, dataScope: privateRow ? 'work' : read === 3 ? 'files' : 'all' },
                      catalog: { ...snapshot.catalog, features: { ...snapshot.catalog?.features, workItems: true, workItemTurns: true } },
                      items: restarted ? [] : [item],
                    },
              )
              const markers = work.markers
              if (!markers || read !== 2) return end(response)
              // The candidate holds a usable but older response while the selected connection adopts two checkpoints.
              void (async () => {
                await writeFile(join(markers, 'candidate-read'), '')
                for (let i = 0; i < 200 && !res.destroyed; i++) {
                  if (existsSync(join(markers, 'release-candidate'))) {
                    end(response)
                    return
                  }
                  await new Promise(resolve => setTimeout(resolve, 25))
                }
                res.destroy()
              })().catch(() => res.destroy())
              return res
            }) as typeof res.end
          }
          if (nativeWorkLostAccess.has(key)) {
            const writeHead = res.writeHead.bind(res),
              end = res.end.bind(res)
            let denied: number | undefined
            res.writeHead = ((...args: Parameters<typeof res.writeHead>) => {
              if (args[0] >= 200 && args[0] < 300) {
                denied = nativeWorkLostAccess.get(key)
                if (denied !== undefined) {
                  nativeWorkLostAccess.delete(key)
                  args[0] = denied
                }
              }
              return writeHead(...args)
            }) as typeof res.writeHead
            res.end = ((...args: Parameters<typeof res.end>) =>
              denied === undefined
                ? end(...args)
                : end(JSON.stringify({ error: 'device-access-changed', message: 'Access changed before the reply' }))) as typeof res.end
          }
          if (nativeWorkAnswerGate.has(key)) {
            const end = res.end.bind(res)
            res.end = ((...args: Parameters<typeof res.end>) => {
              if (res.statusCode < 200 || res.statusCode >= 300) return end(...args)
              const folder = nativeWorkAnswerGate.get(key)
              if (folder === undefined) return end(...args)
              nativeWorkAnswerGate.delete(key)
              void (async () => {
                await writeFile(join(folder, 'response-ready'), '')
                for (let i = 0; i < 250 && !res.destroyed; i++) {
                  if (existsSync(join(folder, 'release-response'))) {
                    end(...args)
                    await writeFile(join(folder, 'response-sent'), '')
                    return
                  }
                  await new Promise(resolve => setTimeout(resolve, 10))
                }
                res.destroy()
              })().catch(() => res.destroy())
              return res
            }) as typeof res.end
          }
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
              if (metadataScript.completingList && typeof args[0] === 'string') {
                const value = JSON.parse(args[0]) as AppSnapshot
                metadataScript.completingList.revision ??= value.revision ?? 0
                value.revision = metadataScript.completingList.revision
                if (count.started === 1) {
                  value.tasks = []
                  delete value.tasksComplete
                }
                args[0] = JSON.stringify(value)
              }
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
          const delay = nativeDelays.get(key)
          if (delay !== undefined) {
            nativeDelays.delete(key)
            await new Promise(resolve => setTimeout(resolve, delay))
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
  it('keeps a fork on its source account when the account is disabled or removed', async () => {
    const defaultHarness = { id: 'codex', status: 'ready', modes: ['chat'] }
    const disabled = { id: 'work', account: true, status: 'unavailable', modes: ['chat'] }
    const account = 'account-123456789abcdef012345678'
    const cursor = 'cursor-key-b4475dbd-3205-4256-bb7b-02de9fa63b49'
    const catalog = { defaults: { harnessId: 'codex', mode: 'chat' }, harnesses: [defaultHarness, disabled] }
    const forkAccountCases = [disabled.id, account, cursor, 'codex-2'].map(harnessId => ({
      catalog,
      source: { harnessId, mode: 'chat' },
    }))
    const blocker = '原来选择的账号现在不能开始。请选择可用的 Harness。'
    expect(await invoke({ operation: 'phoneProjection', forkAccountCases })).toEqual({
      choices: [
        { harnessId: disabled.id, blocker },
        { harnessId: account, blocker },
        { harnessId: cursor, blocker },
        { harnessId: 'codex', blocker: '' },
      ],
    })
  })

  it('uses the selected Harness account for native model choices, thinking and quotas', async () => {
    const reasoning = (id: string, levels: string[]) => ({
      id,
      category: 'thought_level',
      currentValue: levels[0],
      options: levels.map(value => ({ value, name: value })),
    })
    const account = (id: string, name: string, models: string[]) => ({
      id,
      presetId: 'codex',
      account: id !== 'codex',
      status: 'ready',
      quota: { state: 'ok', windows: [{ kind: 'weekly', usedPercent: 10 }] },
      capabilities: { display: { label: name, mark: 'codex' }, models: { owner: 'harness', quota: true, wires: ['responses'] } },
      catalogue: {
        options: [
          { id: 'model', category: 'model', currentValue: 'shared', options: models.map(value => ({ value, name: value })) },
          reasoning('default-effort', id === 'codex' ? ['personal-standard'] : ['work-standard']),
        ],
        perModel: [
          { model: models[1], options: [reasoning(`effort-${id}`, id === 'codex' ? ['personal-low'] : ['work-low', 'work-high'])] },
        ],
      },
    })
    const harnesses = [account('codex', 'Codex', ['shared', 'personal']), account('codex-2', 'Codex · 工作', ['shared', 'work'])]
    const catalog = {
      harnesses,
      providers: [{ id: 'gateway', name: 'Gateway', kind: 'openai-responses', models: ['project-model'] }],
      workspaces: [{ id: 'project', defaultModel: { providerId: 'gateway', model: 'project-model' } }],
    }
    const source = { summary: { harnessId: 'codex', mode: 'chat' }, config: harnesses[0]!.catalogue.options }
    const workPicks = [
      { configId: 'model', value: 'work' },
      { configId: 'effort-codex-2', value: 'work-high' },
    ]
    expect(await invoke({ operation: 'phoneProjection', catalog, accountHarness: 'codex-2', otherHarness: 'codex', source })).toEqual({
      models: ['shared', 'work'],
      thinking: ['work-low', 'work-high'],
      start: { harnessId: 'codex-2', prompt: 'test', mode: 'chat', ownModel: true, config: workPicks },
      fork: {
        harnessId: 'codex-2',
        prompt: 'test',
        mode: 'chat',
        ownModel: true,
        config: workPicks,
        forkOf: { taskId: 'source', upToMessageId: 'turn' },
      },
      nextModel: { harnessId: 'codex-2', prompt: 'test', mode: 'chat', ownModel: true, config: [{ configId: 'model', value: 'shared' }] },
      thinkingAfterModelChange: ['work-standard'],
      other: { harnessId: 'codex', prompt: 'test', mode: 'chat', ownModel: true },
      thinkingAfterAccountChange: ['personal-standard'],
      projectRoutes: ['own', 'project-model'],
      limits: [
        ['codex', 'Codex'],
        ['codex-2', 'Codex · 工作'],
      ],
      widget: [
        ['codex', 'Codex'],
        [expect.stringMatching(/^widget-[a-f0-9]{32}$/u), expect.stringMatching(/^Codex · [A-F0-9]{4}$/u)],
      ],
    })
  })

  it('shows one local prompt until its own Host echo and keeps a resumed run off the previous reply', async () => {
    const summary = { id: 'selected', runId: 'new' }
    const previous = { role: 'user', id: 'old-prompt', text: 'same', turnId: 'old', requestId: 'different-request' }
    const current = { ...previous, id: 'new-prompt', requestId: 'fixture-request-id', turnId: 'new' }
    const detail = { summary, messages: [previous] }
    const attempt = { active: true, pending: true, fields: { prompt: 'same' }, detail }
    const submissionCases = [
      attempt,
      { ...attempt, detail: { summary, messages: [previous, current] } },
      { ...attempt, active: false },
      { ...attempt, pending: false },
      { ...attempt, session: 'other' },
      { ...attempt, detail: { ...detail, summary: { ...summary, id: 'other' } } },
      { ...attempt, fields: { prompt: 'same', queue: true } },
      { ...attempt, fields: { prompt: 'same', steer: true } },
      { ...attempt, active: false, detail: { summary, messages: [{ ...current, turn: { endedAt: '2026-01-02' } }] } },
      { ...attempt, active: false, detail: { summary, messages: [{ ...current, imported: true }] } },
      { ...attempt, active: false, detail: { summary: { id: 'selected' }, messages: [{ role: 'user', id: 'legacy' }] } },
    ]
    expect(await invoke({ operation: 'phoneProjection', submissionCases })).toEqual({
      answers: [
        ['same', '正在发送…', ''],
        ['', '', 'new-prompt'],
        ['', '', ''],
        ['', '', ''],
        ['', '', ''],
        ['', '', ''],
        ['', '正在排队…', ''],
        ['', '正在追加…', ''],
        ['', '', ''],
        ['', '', ''],
        ['', '', 'legacy'],
      ],
    })
  })

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
  it('fades only a scrollable transcript while reading history and preserves that position across keyboard and reply changes', async () => {
    const step = (height: number, viewport: number, offset: number, drag = 0) => ({ height, viewport, offset, drag })
    const transcriptFrames = [
      step(300, 600, -120, 1), // Short transcript pulled down past its start.
      step(620, 600, -90, 1), // Only 20 points actually remain to scroll.
      step(900, 600, 0), // Open a long transcript at the end.
      step(900, 600, 300),
      step(900, 600, 200, 1), // Leave the end.
      step(900, 400, 200), // Keyboard opens while reading history.
      step(1000, 400, 200), // A reply grows without moving the reader.
      step(1000, 400, 540), // Keep controls until the near-end threshold is crossed.
      step(1000, 400, 600), // The last line and its actions are fully visible.
      step(1100, 400, 600), // Follow growth while already at the end.
      step(1100, 400, 700),
      step(1100, 400, 450), // A layout adjustment moves the offset again after the resize has finished.
      step(1100, 400, 700),
      { height: 1100, viewport: 400, offset: 450 }, // iOS 17 has no scroll phase and infers a history read from the offset.
      step(1100, 1200, -100), // A larger viewport fits all the text again.
      step(1800, 400, 1400),
      step(900, 400, 1400), // A long reply folds, leaving the old offset past all the content.
    ]
    const history = [true, false]
    const latest = [false, false]
    const follow = [false, true]
    expect(await invoke({ operation: 'phoneProjection', transcriptFrames })).toEqual({
      positions: [
        latest,
        latest,
        follow,
        latest,
        history,
        history,
        history,
        history,
        latest,
        follow,
        latest,
        follow,
        latest,
        history,
        latest,
        latest,
        follow,
      ],
    })
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
  it('completes native file mentions at the caret and sends only intact, byte-exact file markers', async () => {
    const path = '资料/Café notes.md'
    const marker = `@default:${path}`
    const prefix = '🙂 查一下\n'
    const edited = `${prefix}${marker} 后缀`
    const inlinePrefix = '@输出-1 111'
    const inlineMarker = `${inlinePrefix} ${marker} `
    const result = await invoke({
      operation: 'phoneFileMentionTokens',
      path,
      drafts: [
        { text: '@' },
        { text: `${prefix}@资后缀`, caret: prefix.length + 2 },
        { text: 'name@example.org' },
        { text: '@src@file' },
        { text: ' @file ' },
        { text: '@🙂', caret: 2 },
        { text: '@src', caret: 2, length: 1 },
        { text: '@src', current: '@doc' },
        { text: `${inlinePrefix}@` },
        { text: `${inlinePrefix}@eden.proxy.ts`, previous: `${inlinePrefix}@eden` },
        { text: '🙂正文@查后续', caret: '🙂正文@查'.length },
        { text: 'review@code' },
        { text: '```text\n@file' },
      ],
      spacing: ['🙂 @a 111 @a ', '🙂  @a  @a  end', '  @a\n\t@a\tend', '@a @a '],
      markers: [
        marker,
        `(前)${marker} \n${marker}\t`,
        `a${marker}`,
        `${marker}x`,
        marker.normalize('NFD'),
        `\n${marker}\u3000`,
        `[引用回复 s/m@0]\n> ${marker}`,
      ],
    })
    expect(result).toEqual({
      edits: [
        { query: '', text: `${marker} `, caret: marker.length + 1 },
        { query: '资', text: edited, caret: prefix.length + marker.length + 1 },
        null,
        null,
        null,
        null,
        null,
        { query: 'src', text: null, caret: null },
        { query: '', text: inlineMarker, caret: inlineMarker.length },
        { query: 'eden.proxy.ts', text: inlineMarker, caret: inlineMarker.length },
        { query: '查', text: `🙂正文 ${marker} 后续`, caret: `🙂正文 ${marker} `.length },
        { query: 'code', text: `review ${marker} `, caret: `review ${marker} `.length },
        null,
      ],
      retained: [true, true, false, false, false, true, false],
      visible: ['🙂■111■', '🙂 ■ ■ end', '  ■\n\t■\tend', '■■'],
      selection: [
        [13, 16],
        [3, 26],
        [10, 0],
      ],
    })
  })
  it('routes native member mentions to one round of the newest lead team and blocks unavailable recipients', async () => {
    const members = [
      ['a', '查 接口', 's1'],
      ['b', '查 接口', 's2'],
      ['c', '查-接口-2', 's3'],
      ['d', '检查输出', 'missing'],
      ['e', '文档', ''],
    ].map(([id, name, sessionId]) => ({
      itemId: id,
      name,
      sessionId: sessionId || undefined,
      title: `工作 ${id}`,
      harnessId: 'codex',
      state: 'done',
    }))
    const team = { id: 'new', leadSessionId: 'lead', createdAt: '2026-11-21', state: 'returned', members }
    const snapshot = {
      catalog: { features: { teams: true } },
      device: { status: 'active', scopes: ['view', 'run'], dataScope: 'work' },
      tasks: ['lead', 's1', 's2', 's3'].map(id => ({ id, status: id === 's3' ? 'running' : 'idle' })),
      teams: [team, { ...team, id: 'elsewhere', leadSessionId: 'other' }, { ...team, id: 'old', createdAt: '2026-11-20' }],
    }
    const quote = '[引用回复 ses/m@0]\n> output:  @查-接口-2  +  @检查输出'
    const terminal = 'Terminal 1\n```text\nlogs:  @查-接口-2  keep\n```'
    const filename = 'file @查-接口-2 notes.md'
    const fileRefs = { files: [{ root: 'default', path: filename, name: filename }], truncated: false }
    const drafts = [
      { text: `@default:${filename} 看看这个文件`, materials: true, fileRefs },
      { text: quote },
      { text: '> 日志里提到了 @查-接口 随后退出' },
      { text: terminal },
      { text: `@查-接口 修复\n${quote}\n\n${terminal}` },
      { text: 'email@查-接口 再试' },
      { text: '@查-接口-2 再试  @查-接口\n@查-接口-2 一遍' },
      { text: '@查-接口' },
      { text: '@检查输出 修复' },
      { text: '@查-接口 修复', materials: true },
      { text: `@查-接口 ${'🙂'.repeat(2001)}` },
    ]
    const result = await invoke({ operation: 'phoneMentionRecipients', snapshot, query: '工作 b', drafts })
    expect(result).toMatchObject({
      team: 'new',
      rows: [
        ['@查-接口', null],
        ['@查-接口-2', null],
        ['@查-接口-2-2', '还在做上一件'],
        ['@检查输出', '会话已归档'],
        ['@文档', '没有开始过'],
      ],
      matches: ['b'],
      rounds: [
        null,
        null,
        null,
        null,
        { ids: ['a'], prompt: `修复\n${quote}\n\n${terminal}`, reason: null },
        null,
        { ids: ['b', 'a'], prompt: '再试 \n 一遍', reason: null },
        { ids: ['a'], prompt: '', reason: '写下要成员做的事' },
        { ids: ['d'], reason: '工作 d · 会话已归档' },
        { ids: ['a'], reason: '派给成员只带文字' },
        { ids: ['a'], reason: '最多 4,000 个字符' },
      ],
    })
    const open = await invoke({
      operation: 'phoneMentionRecipients',
      snapshot: { ...snapshot, teams: [{ ...team, state: 'returning' }] },
      drafts: [{ text: '@查-接口 继续' }],
    })
    expect(open.rounds).toEqual([{ ids: ['a'], prompt: '继续', reason: '工作 a · 这一轮还没结束' }])
  })
  it('offers linked sessions and visible Agent chats as native discussion recipients, with a single removable target', async () => {
    const agentId = 'agt_11111111-1111-4111-8111-111111111111'
    const item = {
      id: 'itm_AAAAAAAAAAAAAAAAAAAAAA',
      title: '办事',
      revision: 1,
      updatedAt: '2026-11-21T00:00:00.000Z',
      sessionIds: ['linked', 'missing'],
    }
    const snapshot = {
      catalog: { features: { workItems: true, workItemTurns: true, customAgents: true, singleAgentChat: true } },
      device: { status: 'active', scopes: ['view', 'run'], dataScope: 'all' },
      tasks: [
        { id: 'linked', title: 'API 联调' },
        { id: 'other', title: '其他会话' },
      ],
      customAgents: [{ id: agentId, name: 'API 助手' }],
      agentChats: { general: { state: 'ready', sessionId: 'existing' } },
    }
    const run = (scope: string) =>
      invoke({
        operation: 'phoneMentionRecipients',
        item,
        snapshot: { ...snapshot, device: { ...snapshot.device, dataScope: scope } },
        query: 'api',
      })
    expect(await run('all')).toEqual({
      rows: [
        ['API 联调', null],
        ['通用', null],
        ['API 助手', '还没有聊天'],
      ],
      matches: ['API 联调', 'API 助手'],
      text: '后面的正文',
      caret: 0,
    })
    expect((await run('work')).rows).toEqual([['API 联调', null]])
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
        name: '简报助手',
        description: '每周整理发布摘要',
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
    expect(rows[2]!.body).toMatchObject({ name: '简报助手', description: '每周整理发布摘要', harnessId: 'standard' })
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
  it('keeps a full bulk padding uplink inside the outer cover for its first three seconds, then sends it unclocked', async () => {
    type Pacing = {
      overflowAtMs: number | null
      maxBufferedBytes: number
      cells: Array<[number, number, number]>
      bulkBytes: number
      buckets: number[]
    }
    const shaped = (await invoke({ operation: 'paddingPacer', queued: 67_108_864, pacerOpenedMs: 3500, durationMs: 6000 })) as Pacing
    expect(shaped.overflowAtMs).toBeNull()
    expect(shaped.maxBufferedBytes).toBeLessThanOrEqual(65_536)
    const early = shaped.cells.filter(([at]) => at < PADDING.bulkDelayMs),
      late = shaped.cells.filter(([at]) => at >= PADDING.bulkDelayMs)
    // Clocked first, never a burst: one cell per slot, small ones on the active 40 ms grid; large mode, from the 5 s boundary
    // 1.5 s in, keeps the 250 ms grid until 3.5 s, so the outer cover drains it.
    expect(early.every(([at, size]) => (at + 3500) % (size === PADDING.large ? 250 : PADDING.activeMs) === 0)).toBe(true)
    expect(early.filter(([at]) => at < 1500).every(([, size]) => size === PADDING.small)).toBe(true)
    expect(early.filter(([at]) => at >= 1500).every(([, size]) => size === PADDING.large)).toBe(true)
    expect(new Set(early.map(([at]) => at)).size).toBe(early.length)
    // Then the queue goes as fast as the token bucket allows: its 4 MiB burst at once, whole large cells only.
    expect(late[0]![0]).toBe(PADDING.bulkDelayMs)
    expect(late.filter(([at]) => at === PADDING.bulkDelayMs).length).toBe(PADDING.bulkBurst / PADDING.large)
    expect(late.every(([, size]) => size === PADDING.large)).toBe(true)
    // After the burst, the rest follows at the token rate.
    const after = late.filter(([at]) => at > PADDING.bulkDelayMs && at <= PADDING.bulkDelayMs + 1000).length * PADDING.large
    expect(after).toBeGreaterThan(PADDING.bulkRate - 2 * PADDING.large)
    expect(after).toBeLessThanOrEqual(PADDING.bulkRate + PADDING.large)
    // The same queue unclocked from the cover's start would overflow it at once: the delay is what keeps it whole.
    const unshaped = (await invoke({ operation: 'paddingPacer', queued: 4_194_304, pacerOpenedMs: 0, durationMs: 100 })) as Pacing
    expect(unshaped.overflowAtMs).toBe(0)
    expect(shaped.buckets).toEqual([0, 262_145, 327_681, 8_388_608].map(paddingBucket))
  })
  it('keeps a control connection on its active beat inside the outer cover, with the framer stalled, and its queue bound', async () => {
    type Pacing = { overflowAtMs: number | null; maxBufferedBytes: number; cells: Array<[number, number, number]> }
    // A queue that never drains (the worst case) and a 5 s boundary 1.5 s in: large mode begins inside the cover.
    for (const stalls of [
      [],
      [[400, 560]],
      [
        [1500, 1580],
        [2000, 2080],
      ],
    ]) {
      const shaped = (await invoke({
        operation: 'paddingPacer',
        bulk: false,
        queued: 67_108_864,
        pacerOpenedMs: 3500,
        durationMs: 6000,
        stalls,
      })) as Pacing
      expect(shaped.overflowAtMs).toBeNull()
      expect(shaped.maxBufferedBytes).toBeLessThanOrEqual(65_536)
      const covered = shaped.cells.filter(([at]) => at < 3500),
        after = shaped.cells.filter(([at]) => at >= 3500)
      expect(covered.filter(([, size]) => size === PADDING.large).every(([at]) => (at + 3500) % 250 === 0)).toBe(true)
      // Past 3.5 s large cells take the 40 ms grid: about 400 KiB/s, one per slot.
      expect(after.every(([at, size]) => size === PADDING.large && (at + 3500) % PADDING.activeMs === 0)).toBe(true)
      expect(after.length).toBeGreaterThan(2500 / PADDING.activeMs - 2)
    }
    // A full 64 KiB queue, as the Host's windows let NIO write it, drains on the active grid without a burst.
    const queue = (await invoke({ operation: 'paddingBeat', openedMs: 100_000, durationMs: 4000, writes: [[100_010, 65_536]] })) as {
      cells: Array<[number, number]>
      maxQueued: number
    }
    expect(queue.maxQueued).toBe(65_536)
    const carrying = queue.cells.filter(
      ([at]) => at < 100_010 + Math.ceil(65_536 / (PADDING.small - 3)) * PADDING.activeMs + PADDING.activeMs,
    )
    expect(carrying.every(([at], index) => index === 0 || at - carrying[index - 1]![0] === PADDING.activeMs)).toBe(true)
    expect(carrying.length).toBeGreaterThanOrEqual(Math.ceil(65_536 / (PADDING.small - 3)))
  })
  it('beats every 40 ms while the phone is in use and every 250 ms otherwise, as the Host clock does', async () => {
    type Script = {
      openedMs: number
      durationMs: number
      writes?: Array<[number, number]>
      protects?: number[]
      stalls?: Array<[number, number]>
    }
    const swift = async (script: Script) =>
      ((await invoke({ operation: 'paddingBeat', ...script })) as { cells: Array<[number, number]> }).cells
    // The Host's clock under the same script and timer rule: a write or protect re-arms to the next 40 ms slot.
    const host = (script: Script) => {
      const clock = new PaddingClock('host', script.openedMs),
        cells: Array<[number, number]> = []
      let queued = 0,
        wake = (Math.floor(script.openedMs / PADDING.idleMs) + 1) * PADDING.idleMs
      const rearm = (now: number) => (wake = Math.min(wake, (Math.floor(now / PADDING.activeMs) + 1) * PADDING.activeMs))
      for (let now = script.openedMs; now < script.openedMs + script.durationMs; now++) {
        for (const [at, bytes] of script.writes ?? []) if (at === now) ((queued += bytes), rearm(now))
        for (const at of script.protects ?? []) if (at === now) (clock.protect(now), rearm(now))
        if (now < wake || (script.stalls ?? []).some(([from, to]) => now >= from && now < to)) continue
        const next = clock.next(now, queued)
        if (next.size) {
          queued -= Math.min(queued, next.size - 3)
          cells.push([now, next.size])
        }
        wake = now + next.wait
      }
      return cells
    }
    const tap: Script = { openedMs: 100_000, durationMs: 6000, writes: [[100_510, 300]], stalls: [[101_005, 101_205]] }
    const cells = await swift(tap)
    expect(cells).toEqual(host(tap))
    // Idle: the 250 ms grid. The tap goes in the next 40 ms slot, not the next 250 ms one.
    expect(cells.filter(([at]) => at < 100_510).every(([at]) => at % PADDING.idleMs === 0)).toBe(true)
    expect(cells.find(([at]) => at >= 100_510)).toEqual([100_520, PADDING.small])
    // Active for 2 s after the last queued byte: 40 ms slots; the stalled timer sends one cell, not the slots it missed.
    const active = cells.filter(([at]) => at >= 100_520 && at <= 102_520 && at !== 101_205)
    expect(active.every(([at]) => at % PADDING.activeMs === 0)).toBe(true)
    expect(cells.filter(([at]) => at >= 101_005 && at < 101_205)).toEqual([])
    expect(cells.filter(([at]) => at >= 101_005 && at < 101_240)).toEqual([[101_205, PADDING.small]])
    expect(new Set(cells.map(([at]) => at)).size).toBe(cells.length)
    // Then idle again.
    expect(cells.filter(([at]) => at > 102_560).every(([at]) => at % PADDING.idleMs === 0)).toBe(true)
    expect(cells.every(([, size]) => size === PADDING.small)).toBe(true)
    // A protect hold keeps the 40 ms grid with small cells for 15 s; large mode waits for a 5 s boundary outside it.
    const held: Script = {
      openedMs: 200_000,
      durationMs: 22_000,
      protects: [200_500],
      writes: [
        [209_990, 40_000],
        [219_990, 40_000],
      ],
    }
    const heldCells = await swift(held)
    expect(heldCells).toEqual(host(held))
    expect(
      heldCells
        .filter(([at]) => at >= 200_520 && at < 215_500)
        .every(([at, size]) => at % PADDING.activeMs === 0 && size === PADDING.small),
    ).toBe(true)
    const large = heldCells.filter(([at]) => at >= 220_000 && at < 220_400)
    expect(large).toHaveLength(10)
    expect(large.every(([at, size]) => at % PADDING.activeMs === 0 && size === PADDING.large)).toBe(true)
    expect(heldCells.filter(([at]) => at < 220_000).some(([, size]) => size === PADDING.large)).toBe(false)
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
      available: [vectors.relayId, '33'.repeat(16)],
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
  it('bounds each relay handshake step and the full dial even while verified steps advance', async () => {
    expect(await invoke({ operation: 'relayHandshakeDeadline' })).toEqual({
      progressing: [8, 15, 22, 24, 24],
      stalled: 8,
      joinedOriginKept: true,
    })
  })
  it('races the origins of one edge node to a single claimant at a time, returning the first and leaking none', async () => {
    const result = await invoke({
      operation: 'edgeRace',
      scenarios: [
        [
          { delay: 5, valid: true },
          { delay: 5, valid: true },
        ],
        [
          { delay: 5, valid: false },
          { delay: 5, valid: true },
        ],
        [
          { delay: 1200, valid: true },
          { delay: 5, valid: true },
        ],
        [
          { delay: 5, valid: false },
          { delay: 5, valid: false },
        ],
        [
          { delay: 30, valid: true },
          { delay: 0, valid: true },
          { delay: 0, valid: true },
        ],
        // The claimant stalls after claiming: its claim lapses with its connection and the refused origin dials again.
        [
          { delay: 0, valid: true, stall: 300 },
          { delay: 0, valid: true },
        ],
        // The relay never supplies SPLICED: release its claim and let another origin dial.
        [
          { delay: 0, valid: true, hang: true },
          { delay: 0, valid: true },
        ],
      ],
    })
    expect(result).toEqual({
      rows: [
        { winner: 'o0.example', fast: true },
        { winner: 'o1.example', fast: true },
        // The silent first attempt cancels promptly when the second one succeeds.
        { winner: 'o1.example', fast: true },
        { winner: '', fast: true },
        { winner: 'o0.example', fast: true },
        { winner: 'o1.example', fast: true },
        { winner: 'o1.example', fast: true },
      ],
      // Only one origin per node holds the claim at a time, so there is never a second connection to close.
      closed: 0,
    })
  })
  it('cancels the pre-dial and staggered attempts and closes a late success before returning', async () => {
    expect(await invoke({ operation: 'edgeRaceCancellation' })).toEqual({
      winner: false,
      preCancelledWinner: false,
      dialled: 1,
      cancelled: true,
      claimed: false,
      closed: 1,
    })
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
  it('matches the Mac pairing comparison code using the phone keys and fresh enrollment', async () => {
    const { pairing } = JSON.parse(await readFile(join(root, 'packages/testkit/vectors/link-v1.json'), 'utf8')) as {
      pairing: { connectionSpki: string; verificationSpki: string }
    }
    const { connectionSpki, verificationSpki } = pairing
    const request = { host: 'host_fixture', enrollment: 'enr_fixture', nonce: 'nonce_fixture_90000', connectionSpki, verificationSpki }
    const codes = []
    for (const update of [
      {},
      { host: 'another_Mac' },
      { enrollment: 'another_enrollment' },
      { nonce: 'another_nonce' },
      { connectionSpki: verificationSpki },
      { verificationSpki: connectionSpki },
    ]) {
      const input = { ...request, ...update }
      const mac = nativeComparisonCode(
        input.host,
        input.enrollment,
        input.nonce,
        Buffer.from(input.connectionSpki, 'hex').toString('base64url'),
        Buffer.from(input.verificationSpki, 'hex').toString('base64url'),
      )
      expect(await invoke({ ...input, operation: 'pairingComparison' })).toEqual({ code: mac })
      codes.push(mac)
    }
    expect(codes[0]).toBe('036278')
    expect(new Set(codes).size).toBe(codes.length)
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
  it('compares the routed Swift enrollment with the Mac prompt before approval and reconnects with the enrolled device certificate', async () => {
    // The physical route is simulated; the QR, TLS sockets, enrollment, confirmation and registered connection are real protocol flows.
    const gate = vi
      .spyOn(NativeNetwork.prototype, 'pairingNearby')
      .mockImplementation(async (opening, gateway, compareCode) =>
        opening.pairing && opening.listener.listener === 'native-direct' && gateway === undefined && compareCode
          ? { compareCode: true }
          : false,
      )
    const host = await startTestHost({
      native: { host: '127.0.0.1', port: 0 },
      nativeNearby: undefined,
      nativeNetwork: async () => {
        throw new Error('No physical network in this fixture')
      },
    })
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const { invitation } = await owner.json<{ invitation: { payload: string } }>('native/pairings', { method: 'POST', body: {} })
      host.presence.mode = 'manual'
      const marker = join(host.root, 'swift-comparison-digest')
      const compareOnMac = async () => {
        await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 8_000 })
        const preview = host.presence.requests.at(-1)!.preview
        expect(preview.subject.form).toBe('device.enroll-native-compare')
        const code = /^核对手机上的 ([0-9]{6})，相同才允许连接这台 Mac$/u.exec(preview.reason)?.[1]
        expect(code).toBeDefined()
        expect((await readFile(marker)).equals(createHash('sha256').update(code!).digest())).toBe(true)
        host.presence.approveNext()
      }
      const [result] = await Promise.all([
        invoke({ operation: 'nativePair', payload: invitation.payload, port: host.host.nativePort, comparisonMarker: marker }),
        compareOnMac(),
      ])
      expect(gate).toHaveBeenCalledOnce()
      expect(result.registeredSnapshot).toBe(200)
      expect(host.host.security.devices.get(String(result.deviceId))).toMatchObject({ status: 'active', listener: 'native-direct' })
    } finally {
      gate.mockRestore()
      await host.close()
    }
  }, 20_000)
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
  it('addresses only the chosen local personal agent and requires a matching confirmed mention receipt', async () => {
    const owner = 'agt_11111111-1111-1111-1111-111111111111'
    const target = 'agt_22222222-2222-2222-2222-222222222222'
    const remote = 'agt_33333333-3333-3333-3333-333333333333'
    expect(
      await invoke({
        operation: 'phoneAgents',
        mentionOwner: owner,
        target,
        snapshot: {
          catalog: { features: { customAgents: true, agentMentions: true } },
          device: { dataScope: 'all' },
          customAgents: [
            { id: owner, name: '写作' },
            { id: target, name: '架构师' },
            { id: remote, name: '架构师', workComputer: { hostId: 'b'.repeat(52), agentId: target } },
          ],
        },
      }),
    ).toEqual({
      choices: ['general', target],
      query: [target],
      token: '架',
      quoted: false,
      email: false,
      path: `/link/api/custom-agents/${owner}/mentions`,
      onlyText: ['requestId', 'target', 'text'],
      acknowledged: true,
      uncertain: false,
      crossed: false,
      self: false,
    })
  })
  it('opens only the current recipient chat and labels only the approval and permissions on the exchange', async () => {
    const target = 'agt_22222222-2222-2222-2222-222222222222'
    const remote = 'agt_33333333-3333-3333-3333-333333333333'
    const base = {
      id: 'mention',
      requestId: 'request',
      sourceAgentId: 'general',
      targetAgentId: target,
      targetSessionId: 'chat',
      initiator: 'agent',
      status: 'waiting-approval',
      text: 'Review',
    }
    const approval = { id: 'approval', runId: 'run' }
    const input = {
      operation: 'phoneAgents',
      owner: 'general',
      snapshot: {
        catalog: { features: { customAgents: true, singleAgentChat: true } },
        device: { status: 'active', scopes: ['view'], dataScope: 'all' },
        customAgents: [{ id: target }, { id: remote, workComputer: { hostId: 'b'.repeat(52), agentId: target } }],
        agentChats: { [target]: { state: 'ready', sessionId: 'chat' }, [remote]: { state: 'ready', sessionId: 'remote' } },
        tasks: [
          { id: 'chat', agent: { customAgentId: target }, status: 'waiting-approval', runId: 'run' },
          { id: 'remote', agent: { customAgentId: remote } },
        ],
        approvals: [
          { id: 'unrelated-approval', sessionId: 'chat' },
          { id: 'approval', sessionId: 'chat' },
        ],
      },
    }
    const detail = {
      summary: input.snapshot.tasks[0],
      messages: [
        { id: 'u1', role: 'user' },
        { id: 'reply-1', role: 'assistant', text: 'Original answer' },
        { id: 'u2', role: 'user' },
        { id: 'reply-2', role: 'assistant', text: 'Later answer' },
      ],
      approvals: input.snapshot.approvals,
    }
    expect(
      await invoke({
        ...input,
        detail,
        consultations: [
          { ...base, approval, consultationMode: 'own-permissions' },
          { ...base, approval: { ...approval, runId: 'old-run' } },
          { ...base, approval: { ...approval, id: 'old-approval' } },
          ...['completed', 'failed', 'interrupted'].map(status => ({
            ...base,
            status,
            initiator: 'person',
            consultationMode: 'own-permissions',
          })),
          { ...base, consultationMode: 'text-only', targetMessageId: 'u1', reply: { messageId: 'reply-1', more: true } },
          { ...base, targetMessageId: 'u1', reply: { messageId: 'reply-2' } },
          { ...base, approval, targetMessageId: 'u1' },
          { ...base, targetMessageId: 'u2' },
          { ...base, targetSessionId: 'previous' },
          { ...base, targetSessionId: undefined },
          { ...base, targetAgentId: remote, targetSessionId: 'remote' },
        ],
      }),
    ).toEqual({
      receipts: [
        { action: '在对方聊天查看审批', mode: 'own-permissions', record: 'approval' },
        {},
        {},
        ...Array.from({ length: 3 }, () => ({ action: '打开对方聊天' })),
        { action: '在对方聊天查看完整回复', mode: 'text-only', record: 'reply-1' },
        { action: '在对方聊天查看回复' },
        { action: '在对方聊天查看审批' },
        { action: '在对方聊天查看本轮消息', record: 'u2' },
        {},
        {},
        {},
      ],
    })
    expect(await invoke({ ...input, detail, after: { ...input.snapshot, approvals: [] }, consultations: [{ ...base, approval }] })).toEqual(
      { receipts: [{ action: '在对方聊天查看审批' }] },
    )
    const restricted = { ...input.snapshot, device: { ...input.snapshot.device, dataScope: 'work' } }
    expect(await invoke({ ...input, detail, after: restricted, consultations: [{ ...base, approval }] })).toEqual({
      receipts: [{ action: '在对方聊天查看审批' }],
    })
    expect(
      await invoke({ ...input, detail, after: { ...input.snapshot, agentChats: {} }, consultations: [{ ...base, targetMessageId: 'u1' }] }),
    ).toEqual({ receipts: [{ action: '在对方聊天查看本轮消息' }] })
  })
  it('does not report locally cleared private Agent data as an unconfirmed Host write', async () => {
    expect(
      await invoke({
        operation: 'phoneAgents',
        privateProjectionProbe: true,
        snapshot: { catalog: { features: { customAgents: true } }, device: { dataScope: 'all' }, customAgents: [] },
        restricted: { catalog: { features: { customAgents: true } }, device: { dataScope: 'work' } },
      }),
    ).toEqual({
      initial: 'ready',
      offlineCache: 'ready',
      loading: 'loading',
      refreshing: 'ready',
      restricted: 'locked',
      retainedTab: true,
      unsupportedTab: false,
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
  it('nests only authorized team members of the same visible mobile shelf and never drops orphaned or cyclic rows', async () => {
    const workspaces = [
      { id: 'p', name: 'Shared' },
      { id: 'other', name: 'Elsewhere' },
    ]
    const of = (teamId: string, leadSessionId = 'lead') => ({ teamOf: { teamId, leadSessionId } })
    const row = (id: string, day: number, more: Record<string, unknown> = {}) => ({
      id,
      title: id,
      workspaceId: 'p',
      updatedAt: `2026-11-${day}T00:00:00Z`,
      ...more,
    })
    const tasks = [
      row('branch', 20, { worktree: { branch: 'latch/x' }, forkOf: { taskId: 'lead' } }),
      row('second', 18, of('first-team')),
      row('unlisted', 17, of('first-team')),
      row('other-team', 16, of('another')),
      row('first', 15, of('first-team')),
      row('lead', 14),
      row('waiting', 13, { ...of('first-team'), status: 'waiting-approval' }),
      row('cross', 12, { ...of('first-team'), workspaceId: 'other' }),
      row('orphan', 11, of('private', 'hidden')),
    ]
    const snapshot = {
      catalog: { workspaces },
      tasks,
      teams: [{ id: 'first-team', members: [{ sessionId: 'hidden' }, { sessionId: 'first' }, { sessionId: 'second' }] }],
      instanceId: 'host',
      revision: 1,
    }
    const detail = (summary: Record<string, unknown>) => ({ summary, sync: { instanceId: 'host', revision: 2 } })
    const { answers } = (await invoke({
      operation: 'phoneProjection',
      teamShelfCases: [
        { snapshot },
        { snapshot: { ...snapshot, teams: [] } },
        { snapshot, query: 'second' },
        { snapshot, closed: true, detail: detail(tasks[1]!) },
        { snapshot, offline: true },
        { snapshot, detail: detail(row('second', 18, of('wrong', 'hidden'))) },
        { snapshot, detail: detail(row('second', 18)) },
        { snapshot: { catalog: { workspaces }, tasks: tasks.map(task => ({ ...task, archived: true })) }, archived: true },
        {
          snapshot: {
            catalog: { workspaces },
            tasks: [row('a', 18, of('t', 'b')), row('b', 17, of('t', 'a')), row('c', 16, of('t', 'a')), row('self', 15, of('t', 'self'))],
          },
        },
      ],
    })) as {
      answers: {
        rows: { shelf: string; id: string; parent: string; count: number; last: boolean }[]
        hasTeams: boolean
        linked: string[]
      }[]
    }
    const [nested, fallback, search, closed, offline, replaced, omitted, archived, cycle] = answers
    expect(nested!.rows.map(row => row.id)).toEqual([
      'waiting',
      'branch',
      'lead',
      'first',
      'second',
      'unlisted',
      'other-team',
      'orphan',
      'cross',
    ])
    expect(nested!.rows.find(row => row.id === 'lead')?.count).toBe(4)
    expect(nested!.rows.filter(row => row.last).map(row => row.id)).toEqual(['other-team'])
    expect(nested!.rows.filter(row => row.parent).map(row => row.parent)).toEqual(['lead', 'lead', 'lead', 'lead'])
    expect(nested!.rows.find(row => row.id === 'waiting')?.shelf).toBe('waiting')
    expect(fallback!.rows.filter(row => row.parent).map(row => row.id)).toEqual(['second', 'unlisted', 'first', 'other-team'])
    expect(search!.rows).toEqual([{ shelf: 'project:p', id: 'second', parent: '', count: 0, last: false }])
    for (const hidden of [closed!, offline!]) {
      expect(hidden.hasTeams).toBe(false)
      expect(hidden.linked).toEqual([])
      expect(hidden.rows.every(row => !row.parent && !row.count)).toBe(true)
    }
    for (const refresh of [replaced, omitted]) expect(refresh!.rows).toEqual(nested!.rows)
    expect(archived!.rows.some(row => row.id === 'cross' && !row.parent)).toBe(true)
    expect(cycle!.rows.map(row => [row.id, row.parent])).toEqual([
      ['a', ''],
      ['b', ''],
      ['c', ''],
      ['self', ''],
    ])
  })
  it('shows every authorized session immediately and groups the same rows when team relationships arrive', async () => {
    const tasks = [
      { id: 'approval', status: 'waiting-approval' },
      { id: 'run', status: 'running' },
      { id: 'lead', workspaceId: 'p' },
      { id: 'member', workspaceId: 'p', teamOf: { teamId: 'team', leadSessionId: 'lead' } },
    ]
    const snapshot = {
      catalog: { workspaces: [{ id: 'p', name: 'project' }] },
      tasks,
      teams: [{ id: 'team', members: [{ sessionId: 'member' }] }],
    }
    const result = await invoke({
      operation: 'phoneProjection',
      teamShelfCases: [{ snapshot, closed: true }, { snapshot, readingTeams: true }, { snapshot }, { snapshot, offline: true }],
    })
    const { answers } = result as { answers: { rows: { id: string; parent: string }[] }[] }
    for (const frame of answers) expect(frame.rows.map(row => row.id).sort()).toEqual(['approval', 'lead', 'member', 'run'])
    expect(answers[2]?.rows.find(row => row.id === 'member')?.parent).toBe('lead')
    for (const frame of [answers[0], answers[1], ...answers.slice(3)]) expect(frame?.rows.every(row => row.parent === '')).toBe(true)
  })
  it('reveals folded projects during search and restores the folds for each computer and shelf identity', async () => {
    const shelf = 'project:shared'
    const result = await invoke({
      operation: 'phoneProjection',
      query: '对话',
      workspaces: [{ id: 'shared', name: '对话' }],
      tasks: [
        { id: 'code', title: '实现搜索', workspaceId: 'shared', updatedAt: '2026-01-03T00:00:00Z' },
        { id: 'approval', title: '审批', workspaceId: 'shared', status: 'waiting-approval', updatedAt: '2026-01-02T00:00:00Z' },
        { id: 'chat', title: '记录', mode: 'chat', updatedAt: '2026-01-01T00:00:00Z' },
        { id: 'archived', title: '旧会话', workspaceId: 'shared', archived: true },
      ],
      shelfDisclosure: [
        { computer: 'mac', shelf },
        { computer: 'mac', shelf, toggle: true },
        { computer: 'mac', shelf, filtering: true },
        { computer: 'mac', shelf: 'other' },
        { computer: 'mini', shelf },
        { computer: 'mac', shelf },
        { computer: 'mac', shelf, toggle: true },
      ],
    })
    expect(result).toEqual({
      collapsed: [false, true, false, false, false, true, false],
      shelves: [
        { id: shelf, tasks: ['code', 'approval'] },
        { id: 'other', tasks: ['chat'] },
      ],
    })
  })
  it('lets quiet phone runs keep going without a decision, including on an older Host', async () => {
    const now = '2026-11-01T10:30:00Z'
    const lastEventAt = '2026-11-01T10:27:00Z'
    const live = { activity: 'model', lastEventAt, silent: true }
    const running = { status: 'running', live }
    const modelText = '等模型回应 · 3 分钟没有新内容'
    const commandText = '检查构建 · 3 分钟没有输出'
    const oldHostText = '3 分钟没有新输出'
    const unsupported = 'Codex 发来不支持的请求'
    expect(
      await invoke({
        operation: 'phoneProjection',
        hostNow: now,
        runStatusCases: [
          { detail: { summary: running } },
          { detail: { summary: { ...running, live: { ...live, activity: 'command', commandName: '检查构建' } } } },
          { detail: { summary: { status: 'running' }, lastOutputAt: lastEventAt } },
          { detail: { summary: { ...running, pendingQuestions: 1 }, questions: [{}] } },
          { detail: { summary: { ...running, status: 'waiting-approval' }, approvals: [{}] } },
          { detail: { summary: { ...running, live: { ...live, unrecognized: { at: lastEventAt } } } } },
          { detail: { summary: { ...running, live: { ...live, activity: 'cancelling' } } } },
          { detail: { summary: running }, stopping: true },
        ],
      }),
    ).toEqual({
      answers: [
        { text: modelText, helper: modelText, tone: 'passive', topic: '运行中' },
        { text: commandText, helper: commandText, tone: 'passive', topic: '运行中' },
        { text: oldHostText, helper: oldHostText, tone: 'passive', topic: '运行中' },
        { text: '等你回答', helper: '等你点头', tone: 'quiet', topic: '等你处理' },
        { text: '需要你允许', helper: '等你点头', tone: 'quiet', topic: '等你处理' },
        { text: unsupported, helper: unsupported, tone: 'amber', topic: '等你处理' },
        { text: '正在停止…', helper: '在停下', tone: 'plain', topic: '正在停止' },
        { text: '正在停止…', helper: '在停下', tone: 'plain', topic: '运行中' },
      ],
    })
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
        { toolName: 'write_file', risk: 'R1', tool: { toolTitle: '保存报告', input: '{"path":"report.md"}' } },
        { toolName: 'write_file', risk: 'R1', tool: { title: '保存报告', locations: ['docs/report.md'] } },
        {
          toolName: 'write_file',
          risk: 'R1',
          tool: { toolTitle: '写入文件', diffs: [{ path: 'src/new.ts', newText: 'private diff text' }] },
        },
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
        {
          toolName: 'apply_patch',
          risk: 'R1',
          tool: { kind: 'edit', title: 'apply_patch', locations: ['src/review.ts', 'src/files.ts'] },
        },
        {
          toolName: 'apply_patch',
          risk: 'R1',
          reason: 'unprojected explanation',
          arguments: '{"path":"unprojected.ts"}',
          tool: { input: '{"path":"unprojected.ts"}' },
        },
        {
          toolName: 'apply_patch',
          risk: 'R1',
          tool: { kind: 'edit', locations: ['src/odd\u202e\n\t.ts'] },
        },
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
    expect(result.promptTooLong).toEqual([true, false, true, true])
    // Backing out of Face ID is quiet; a sheet that failed says so, and neither reads as a lost connection.
    expect(result.faceId).toEqual([true, true, false, true, false, false])
    // Trust is set once when the phone is connected: signing a content window never asks for the person by itself.
    expect(result.verificationAsksPresence).toBe(false)
    // Face ID only when the person turned it on; without it, a window that ran out opens again with no tap.
    expect(result.unlock).toEqual([
      { reopen: '查看', symbol: 'eye', atExpiry: true },
      { reopen: '用 Face ID 查看', symbol: 'faceid', atExpiry: false },
    ])
    expect(result.teamListRead).toEqual([
      ['automatic', 'automatic', 'ready', 'automatic'],
      ['onRequest', 'automatic', 'ready', 'onRequest'],
    ])
    expect(result.rows).toEqual(['waiting', 'waiting', 'running', 'silent', 'stopping', 'ended:已强制停止:2', 'failed', 'read', 'read'])
    // A list that may be stale draws nothing live; a run that has already ended still says how.
    expect(result.frozen).toEqual(['frozen', 'frozen', 'frozen', 'frozen', 'frozen', 'ended:已强制停止:2', 'failed', 'read', 'read'])
    expect(result.shelves).toEqual([
      { label: '等你处理', ids: ['b', 'a'] },
      // What is at work comes next, across projects, newest first; a stop being asked for is still at work.
      { label: '运行中', ids: ['e', 'd', 'c'] },
      // A session an assistant ran stays listed, to be read.
      { label: '对话', ids: ['i', 'g', 'f'] },
    ])
    // As the web's waitKind, rowMark and activityWords: what a waiting row asks, the mark on its icon, what a run does.
    expect(result.waits).toEqual(['审批', '1 个问题', '', '', '', '', '', '', ''])
    expect(result.marks).toEqual([
      ['waiting', 'waiting', 'running', 'silent', 'running', 'unknown', 'failed', '', ''],
      ['waiting', 'waiting', 'running', 'silent', 'running', 'unknown', 'failed', 'unread', 'unread'],
    ])
    expect(result.activities).toEqual(['在跑命令', '在等模型', '在启动', '在用工具', '排队', '排队：DeepSeek', '运行中'])
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
    expect(result.status).toEqual({ text: '命令运行中 · pnpm test', clock: '1:00', tone: 'plain' })
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
      { heading: '保存报告', canAllow: true, option: '', refusal: '', clause: '' },
      { heading: '保存报告 docs/report.md', canAllow: true, option: '', refusal: '', clause: '' },
      { heading: '写入文件 src/new.ts', canAllow: true, option: '', refusal: '', clause: '' },
      { heading: '写入 src/a.ts 等 3 处', canAllow: true, option: '', refusal: '', clause: '' },
      { heading: '写入文件 · write_file', canAllow: true, option: 'o1', refusal: '', clause: '' },
      // As the web: an ordinary step offers what the Host gave, so its only allow is the session-wide one.
      { heading: '写入文件 · write_file', canAllow: true, option: 'o2', refusal: '', clause: '' },
      { heading: '写入文件 · write_file', canAllow: true, option: '', refusal: '', clause: '在项目文件夹之外' },
      { heading: '运行命令 · shell', canAllow: true, option: '', refusal: '', clause: '' },
      { heading: '写入文件 · write_file', canAllow: true, option: '', refusal: '', clause: '高风险' },
      { heading: '子 Agent 跑测试 · Edit a.txt', canAllow: true, option: '', refusal: '', clause: '' },
      { heading: '修改文件 · apply_patch · src/review.ts 等 2 处', canAllow: true, option: '', refusal: '', clause: '' },
      { heading: '修改文件 · apply_patch', canAllow: true, option: '', refusal: '', clause: '' },
      { heading: '修改文件 · apply_patch · src/odd\\u{202E}\\u{A}\\u{9}.ts', canAllow: true, option: '', refusal: '', clause: '' },
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
  it('admits a routed private direct hint on a live LAN while excluding local, broadcast, link-local, shared and public destinations', async () => {
    const lan = { address: '0a000004', mask: 'ffffff00' }
    const targets = [
      '0a00000a', // Same LAN.
      '0a01000a', // Another private subnet.
      '0a01000b', // Another address of this phone.
      '0a000000',
      '0a0000ff',
      '7f000001',
      'a9fe0101',
      '64400001',
      '08080808',
      'e00000fb',
    ]
    const round = { operation: 'directPeers', rows: [lan], own: [lan.address, '0a01000b'], targets }
    expect(await invoke(round)).toEqual({
      local: [true, false, false, false, false, false, false, false, false, false],
      routed: [true, true, false, false, false, false, false, false, false, false],
    })
    expect(await invoke({ ...round, rows: [], targets: ['0a01000a'] })).toEqual({ local: [false], routed: [false] })
    expect(
      await invoke({
        ...round,
        rows: [{ address: 'fd000000000000010000000000000004', mask: 'ffffffffffffffff0000000000000000' }],
        targets: ['fd000000000000020000000000000005', 'fe800000000000000000000000000001', 'fd000ec2000000000000000000000254'],
      }),
    ).toEqual({ local: [false, false, false], routed: [true, false, false] })
  })
  it('reuses an installed direct hint only on the current network, within the signed deadline and without renewing it on a retry', async () => {
    expect(await invoke({ operation: 'directHintLifetime' })).toEqual({
      sameRequest: true,
      confirmed: 600,
      retry: 600,
      onlyQR: 120,
      shortBook: 60,
      removedFromBook: true,
      expired: true,
      newNetwork: true,
      wrongPort: true,
    })
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

    // Path-aware invalidation: modifying/adding/removing an unused backup relay never cancels an active direct or unchanged relay transfer!
    const relay0Hex = relays[0]!.relayId.toString('hex')
    expect(
      await invoke({
        ...input,
        installedKind: 'relay',
        installedPathId: relay0Hex,
        previous: encode({ relays: relays.slice(1) }),
        current: encode({ generation: 2 }),
      }),
    ).toEqual({ migrate: true, invalidates: true })
    expect(
      await invoke({
        ...input,
        installedKind: 'direct',
        installedPathId: 'lan',
        current: encode({ generation: 2, relays: relays.slice(1) }),
      }),
    ).toEqual({ migrate: true, invalidates: false })
    expect(
      await invoke({
        ...input,
        installedKind: 'direct',
        installedPathId: 'lan',
        current: encode({ generation: 2, discoveryKey: Buffer.alloc(32, 5) }),
      }),
    ).toEqual({ migrate: true, invalidates: true })
    expect(
      await invoke({
        ...input,
        installedKind: 'relay',
        installedPathId: relay0Hex,
        current: encode({ generation: 2, relays: [relays[0]!] }),
      }),
    ).toEqual({ migrate: true, invalidates: false })
    expect(
      await invoke({
        ...input,
        installedKind: 'relay',
        installedPathId: relay0Hex,
        current: encode({ generation: 2, discoveryKey: Buffer.alloc(32, 5) }),
      }),
    ).toEqual({ migrate: true, invalidates: false })
    expect(
      await invoke({
        ...input,
        installedKind: 'relay',
        installedPathId: relay0Hex,
        current: encode({ generation: 2, relays: [relays[1]!] }),
      }),
    ).toEqual({ migrate: true, invalidates: true })
    expect(
      await invoke({
        ...input,
        installedKind: 'relay',
        installedPathId: relay0Hex,
        current: encode({
          generation: 2,
          relays: relays.map((r, idx) => (idx === 0 ? { ...r, spkiHash: Buffer.alloc(32, 6) } : r)),
        }),
      }),
    ).toEqual({ migrate: true, invalidates: true })

    // Explicit self-signed X.509 verification on iOS rejects CA-signed leaf certificates missing their chain even when SPKI and Subject==Issuer match!
    const derElem = (tag: number, ...parts: readonly Uint8Array[]): Buffer => {
      const val = Buffer.concat(parts)
      const len = val.length < 128 ? [val.length] : val.length < 256 ? [0x81, val.length] : [0x82, val.length >> 8, val.length & 255]
      return Buffer.concat([Buffer.from([tag, ...len]), val])
    }
    const seq = (...parts: readonly Uint8Array[]) => derElem(0x30, ...parts)
    const leafPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const caPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const leafSpki = leafPair.publicKey.export({ type: 'spki', format: 'der' })
    const leafSpkiHash = createHash('sha256').update(leafSpki).digest('hex')
    const algId = seq(derElem(0x06, Buffer.from('2a8648ce3d040302', 'hex')))
    const sameDn = seq(derElem(0x31, seq(derElem(0x06, Buffer.from('550403', 'hex')), derElem(0x0c, Buffer.from('relay.latch.invalid')))))
    const validity = seq(derElem(0x17, Buffer.from('260101000000Z')), derElem(0x17, Buffer.from('280101000000Z')))
    const tbs = seq(
      derElem(0xa0, derElem(0x02, Buffer.from([2]))),
      derElem(0x02, Buffer.from([7])),
      algId,
      sameDn,
      validity,
      sameDn,
      leafSpki,
    )
    const genuineDer = seq(tbs, algId, derElem(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, leafPair.privateKey)])))
    const caSignedDer = seq(tbs, algId, derElem(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, caPair.privateKey)])))
    expect(await invoke({ operation: 'selfSignedVerify', certDer: genuineDer.toString('hex'), spkiHash: leafSpkiHash })).toEqual({
      verified: true,
    })
    expect(await invoke({ operation: 'selfSignedVerify', certDer: caSignedDer.toString('hex'), spkiHash: leafSpkiHash })).toEqual({
      verified: false,
    })
    expect(await invoke({ operation: 'selfSignedVerify', certDer: genuineDer.toString('hex'), spkiHash: '0'.repeat(64) })).toEqual({
      verified: false,
    })
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
  it('keeps two computers with the same device ID isolated through concurrent saves, locking, signed retirement and local removal', async () => {
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
        confirmedLocalRemoval: true,
      })
      const [alpha, beta] = input.profiles
      const alphaId = `${alpha!.device.hostId}-${deviceId}`
      const betaId = `${beta!.device.hostId}-${deviceId}`
      const selection = (change: Record<string, unknown> = {}, folder = 'selection') =>
        invoke({ operation: 'preferredComputer', key: input.key, directory: join(temporary, folder), ...change })
      // Each call starts a fresh process. Both signed address books have no routes.
      expect(await selection({ legacyProfiles: input.profiles })).toEqual({ preferred: alphaId })
      expect(await selection({ remember: alphaId })).toEqual({ preferred: alphaId })
      expect(await selection({ remember: betaId })).toEqual({ preferred: betaId })
      // A book refresh still holds the profile it read before the switch.
      expect(await selection({ refresh: beta })).toEqual({ preferred: betaId })
      expect(await selection()).toEqual({ preferred: betaId })
      expect(await selection({ forget: betaId })).toEqual({ preferred: alphaId })
      expect(await selection()).toEqual({ preferred: alphaId })
      expect(await selection({ forget: alphaId })).toEqual({ preferred: '' })
      expect(await selection()).toEqual({ preferred: '' })
      await selection({ legacyProfiles: input.profiles, remember: betaId }, 'remove-other')
      expect(await selection({ forget: alphaId }, 'remove-other')).toEqual({ preferred: betaId })
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
  it('settles both native HTTP/2 futures if stream creation fails before installing a response handler', async () => {
    expect(await invoke({ operation: 'http2StreamOpening' })).toEqual({
      openFailed: true,
      responseFailed: true,
      parentActive: true,
      laterResponse: 42,
    })
  })

  it('reconnects the phone: retry and relay timing, path filter, background hold and PING liveness rules', async () => {
    expect(await invoke({ operation: 'reconnectRules' })).toEqual({
      initialListRecovers: true,
      backoff: true,
      relayDelay: true,
      winners: true,
      filter: true,
      ring: true,
      holdWithdrawsAtOnce: true,
      holdExpires: true,
      holdLockTearsDown: true,
      holdResumes: true,
      drafts: {
        windowHidesText: true,
        recreatedFieldKeepsDraft: true,
        editingCanClear: true,
        resetRejectsOldWriter: true,
        onlyPermittedCodeEditsOffline: true,
      },
      presentation: {
        boundedRelayRetry: true,
        graceBlocksRequests: true,
        failedOrExpiredShowsOffline: true,
        replacementIgnoresOldCallbacks: true,
        clearedOpeningIgnoresOldCallbacks: true,
      },
      liveness: { silentClosedAtMs: 20_000, answeredStaysOpen: true, routeProbe: true },
    })
  })
  it('reconnects the phone: late direct wins, relay upgrades to direct, the window is rechecked and nothing is resent', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    // Refuses every dial at once, as a vanished LAN address does.
    const refused = createServer(socket => socket.destroy())
    // Forwards to the Host until the fixture writes the marker, then goes quiet without closing: a peer that stopped answering.
    const nativePort = host.host.nativePort!
    const markers = await mkdtemp(join(tmpdir(), 'latch-swift-silent-'))
    const silentMarker = join(markers, 'silent')
    const silent = createServer(client => {
      const upstream = connect(nativePort, '127.0.0.1')
      const open = () => !existsSync(silentMarker)
      client.on('data', (chunk: Buffer) => open() && upstream.write(chunk))
      upstream.on('data', (chunk: Buffer) => open() && client.write(chunk))
      const end = () => {
        client.destroy()
        upstream.destroy()
      }
      client.on('error', end).on('close', end)
      upstream.on('error', end).on('close', end)
    })
    await Promise.all([refused, silent].map(server => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))))
    const port = (server: typeof refused) => (server.address() as { port: number }).port
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const { invitation } = await owner.json<{ invitation: { payload: string } }>('native/pairings', { method: 'POST', body: {} })
      nativeSeen.length = 0
      nativeDrop.add('PATCH /link/api/devices/current')
      nativeDelays.set('GET /link/api/custom-agents/general', 800)
      const result = await invoke(
        {
          operation: 'nativeReconnect',
          payload: invitation.payload,
          port: host.host.nativePort,
          faultPort: port(refused),
          silentPort: port(silent),
          silentMarker,
        },
        60_000,
      )
      expect(result).toMatchObject({
        lateDirectWins: true,
        rememberedInstalledDirectOnly: true,
        emptyBrowseLeavesNoMemory: true,
        relayStartsAtOnce: true,
        relayCooldown: { ordinaryDialSkipsCooling: true, readyRelayPreferred: true, onlyRelayRetried: true, directStillCools: true },
        upgrade: {
          relayOnlyRefused: true,
          installedDirect: true,
          builtBeforeTeardown: true,
          sameWindow: true,
          readNotInterrupted: true,
          waitedForReadToSettle: true,
          unknownKept: true,
          directNotUpgradedAgain: true,
          installs: 2,
        },
        holdRecheck: true,
        revocationFirst: true,
        liveness: { answeredStaysOpen: true, silentClosed: true, backupInstalled: true, staleLossIgnored: true },
      })
      // The timeline holds phase names, path kinds and numbers only.
      const timeline = JSON.stringify(result.timeline)
      for (const secret of ['127.0.0.1', String(nativePort), 'lan-late', invitation.payload]) expect(timeline).not.toContain(secret)
      expect(result.phases).toEqual(
        expect.arrayContaining(['foreground', 'candidates', 'connect:direct', 'qualify:direct', 'install:direct']),
      )
      expect(result.phases).not.toContain('install:relay')
      const seen = (method: string, path: string) => nativeSeen.filter(entry => entry.method === method && entry.path === path).length
      // The unknown write went out once; neither the upgrade nor the recheck sent it again.
      expect(seen('PATCH', '/link/api/devices/current')).toBe(1)
      expect(nativeDrop.size).toBe(0)
      // Every challenge was used by a verification: an early challenge is never fetched beside a held window.
      expect(seen('POST', '/link/api/native/verification/challenge')).toBe(result.verifications)
      expect(seen('POST', '/link/api/native/verification')).toBe(result.verifications)
      // The upgrade's qualify and the return from the background each rechecked the window.
      expect(seen('POST', '/link/api/native/verification/resume')).toBeGreaterThanOrEqual(2)
      // After the revocation both requests of the next qualify reached the Host; the snapshot was still never adopted.
      const revokedAt = nativeSeen.findLastIndex(entry => entry.method === 'DELETE' && entry.path === '/link/api/devices/current')
      const after = nativeSeen.slice(revokedAt + 1).map(entry => `${entry.method} ${entry.path}`)
      expect(after).toEqual(expect.arrayContaining(['GET /link/api/native/revocation', 'GET /link/api/snapshot']))
    } finally {
      nativeDrop.clear()
      nativeDelays.clear()
      await Promise.all([refused, silent].map(server => new Promise(resolve => server.close(resolve))))
      await rm(markers, { recursive: true, force: true })
      await host.close()
    }
  }, 90_000)
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
          ...(mode === 'metadata' ? { completingList: {} } : {}),
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
          if (mode === 'metadata') expect(result.lateNoticeKeptSession).toBe(true)
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
  it('keeps a Swift round to two team members unconfirmed after a lost answer without posting it twice', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    let route = ''
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        body: { mode: 'agent', prompt: 'Lead', requestId: randomUUID() },
      })
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
      const { team } = await owner.json<{ team: { id: string; members: Array<{ sessionId: string }> } }>(`tasks/${sessionId}/team`, {
        body: {
          requestId: randomUUID(),
          tasks: ['Frontend', 'Tests'].map(name => ({
            name,
            title: name,
            prompt: name,
            harnessId: 'standard',
            model: { providerId: 'demo', model: 'demo' },
          })),
        },
      })
      await expect
        .poll(async () => (await owner.json<{ team: { state: string } }>(`teams/${team.id}`)).team.state, { timeout: 15_000 })
        .toBe('returned')
      const { invitation } = await owner.json<{ invitation: { payload: string } }>('native/pairings', { method: 'POST', body: {} })
      route = `POST /link/api/teams/${team.id}/rounds`
      nativeMalformedSuccess.add(route)
      expect(
        await invoke({ operation: 'nativeWorkspace', payload: invitation.payload, port: host.host.nativePort, mentionLead: sessionId }),
      ).toEqual({
        retainedUntilReleased: true,
        noPending: true,
        keptEditedDraft: true,
        clearedOriginal: true,
      })
      expect(nativeSeen.filter(call => call.method + ' ' + call.path === route)).toHaveLength(1)
      expect((await owner.json<{ team: { round: number } }>(`teams/${team.id}`)).team.round).toBe(2)
      for (const member of team.members) {
        const detail = await owner.json<TaskDetail>(`tasks/${member.sessionId}`)
        expect(detail.messages.filter(message => message.role === 'user' && message.text === 'Continue reviewing.')).toHaveLength(1)
      }
    } finally {
      nativeMalformedSuccess.delete(route)
      await host.close()
    }
  }, 30_000)
  it('checks a lost Swift work post to a custom Agent without waking its chat twice', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    let route = ''
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const { item } = await owner.json<{ item: { id: string } }>('work/items', { body: { title: 'Mobile work', requestId: randomUUID() } })
      const agent = await owner.json<{ id: string }>('custom-agents', {
        body: {
          requestId: randomUUID(),
          name: '审阅',
          description: '检查讨论',
          instructions: 'Read the discussion.',
          harnessId: 'standard',
          mode: 'chat',
          skills: [],
        },
      })
      const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
        body: { requestId: randomUUID(), customAgentId: agent.id, prompt: 'Start this chat.' },
      })
      await expect.poll(async () => (await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).toBe('idle')
      const { invitation } = await owner.json<{ invitation: { payload: string } }>('native/pairings', { method: 'POST', body: {} })
      route = `POST /link/api/work/items/${item.id}/posts`
      nativeMalformedSuccess.add(route)
      expect(
        await invoke({
          operation: 'nativeWorkspace',
          payload: invitation.payload,
          port: host.host.nativePort,
          mentionItem: item.id,
          mentionAgent: agent.id,
        }),
      ).toEqual({
        originalTarget: true,
        samePost: true,
        wrongTargetRejected: true,
        noPending: true,
      })
      expect(nativeSeen.filter(call => call.method + ' ' + call.path === route)).toHaveLength(1)
      expect((await owner.json<{ item: { private: boolean } }>(`work/items/${item.id}`)).item.private).toBe(true)
    } finally {
      nativeMalformedSuccess.delete(route)
      await host.close()
    }
  }, 30_000)
  it('sends chosen project file mentions from the Swift phone on the first message and a follow-up', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const folder = join(host.root, 'mention-project')
      await mkdir(folder)
      await writeFile(join(folder, 'meeting notes.md'), 'A project file.')
      const { workspace } = (await (await owner.addFolders({ paths: [folder] })).json()) as {
        workspace: { id: string; folders: Array<{ id: string }> }
      }
      const { invitation } = await owner.json<{ invitation: { payload: string } }>('native/pairings', { method: 'POST', body: {} })
      const result = await invoke({
        operation: 'nativeWorkspace',
        payload: invitation.payload,
        port: host.host.nativePort,
        mentionProject: workspace.id,
      })
      expect(result).toMatchObject({ blocksQueue: true, blocksSteer: true, oldWindowClosed: true })
      const { messages } = await owner.json<TaskDetail>(`tasks/${result.session}`)
      const root = workspace.folders[0]!.id
      expect(messages.filter(message => message.role === 'user')).toMatchObject(
        ['First', 'Next'].map(word => ({ text: `${word} @${root}:meeting notes.md`, fileRefs: [{ root, path: 'meeting notes.md' }] })),
      )
    } finally {
      await host.close()
    }
  }, 30_000)
  it('browses a session folder through the Swift phone and resolves an unmentioned file inside its verified window', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    try {
      const owner = await host.enroll({ listener: 'unix' })
      await mkdir(join(host.workspaceRoot, '资料 + #'))
      await writeFile(join(host.workspaceRoot, '资料 + #', '验收.md'), 'A file the phone can open.')
      const task = await host.host.bridge.createTask({ prompt: 'hello', requestId: randomUUID(), mode: 'chat' })
      const { invitation } = await owner.json<{ invitation: { payload: string } }>('native/pairings', { method: 'POST', body: {} })
      expect(
        await invoke({
          operation: 'nativeWorkspace',
          payload: invitation.payload,
          port: host.host.nativePort,
          fileBrowserSession: task.sessionId,
        }),
      ).toEqual({
        inlineFiles: ['资料 + #/验收.md'],
        oldPanelClosed: true,
        previewable: true,
        badFolderRejected: true,
        wrongRootRejected: true,
      })
    } finally {
      await host.close()
    }
  }, 30_000)
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
    expect(result.items.slice(0, 4).map(item => [item.id, item.kind, item.words])).toEqual([
      ['h', 'approval', '审批'],
      ['d', 'stuck', '没有动静'],
      ['b', 'question', '问题'],
      ['a', 'approval', '审批'],
    ])
    expect(result.items.map(item => item.id)).not.toContain('c')
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
    expect(result.notices).toEqual(['b/s1', 'none', 'none', 'only-c', 'none', 'b/s3', 'none'])
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
        queueControl: true,
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
  it('bounds phone diagrams and preserves line breaks inside native flowchart labels', async () => {
    const flow = String.raw`flowchart TD
S0["1. 入口接收\nChatCompletions 校验身份与会话"] --> S4{有无动作\n进入分支}
S4 -->|是\n继续| End["保留\\n"]`
    const sequence = String.raw`sequenceDiagram
客户端->>主机: 保留\n原文`
    const quotedEdge = 'graph LR\nA["示例 -- “内部” -->"] -- "命中「动作」" --> B'
    const { diagrams } = await invoke({
      operation: 'phoneRichText',
      diagrams: [flow, quotedEdge, 'graph LR\nA["第 1 行\n第 2 行"]', sequence, 'flowchart TD\nclick A callback', 'x'.repeat(50_001)],
    })
    expect(diagrams).toEqual([
      flow.replaceAll(/(?<!\\)\\n/gu, '<br/>'),
      'graph LR\nA["示例 -- “内部” -->"] -->|命中「动作」| B',
      'graph LR\nA["第 1 行<br/>第 2 行"]',
      sequence,
      null,
      null,
    ])
  })
  it('reads a reply’s Markdown as the web’s blocks: tables, tasks, nesting, literal HTML, formulas and safe links', async () => {
    const result = await invoke({
      operation: 'phoneRichText',
      fileCandidates: [
        'src/app.GO:12:2',
        'main.ts#L3C1',
        'file:///tmp/100%25.md',
        'v1.2.3',
        'npm run test',
        'handler()',
        'https://x.example/a.js:2',
        'file://elsewhere/a.ts',
        'x.go%00.ts',
      ],
      cases: [
        '会话：\n\n| Agent | 角色 | 状态 |\n|---|:---:|---:|\n| `/root` | 主 **Agent** | 运行中 |\n\n后文',
        '- [ ] 待做\n- [x] 完成 ~~旧~~ *斜*\n  - 嵌套\n\n  续段\n1. 一\n2. 二\n   - 内层',
        '<details>\n<summary>标题</summary>\n\n内容 <br> 换行 <!-- 注释 -->\n\n</details>\n\n<div>标记</div>',
        '> 引用\n>\n> ---\n\n---\n# 一\n## 二',
        '[链接](https://a.example) ![网图](https://a.example/x.png)\n\n![截图](out/shot.png)',
        '```swift\nlet a = 1\n\n    缩进\n```',
        '文字\n\n```py\n未关\nx=1',
        '> ```mermaid\n> graph TD\n\n后文',
        '- ~~~mermaid\n  graph TD\n  ~~~',
        '````mermaid\ngraph TD\n```',
        '$$\nE=mc^2\n$$',
        `${'>'.repeat(40)} 太深`,
        '    缩进的代码不算嵌套\n' + ' '.repeat(80) + 'x',
      ],
      links: [
        'https://a.example/x',
        'mailto:a@b.example',
        'javascript:alert(1)',
        'src/app.ts',
        'file:///tmp/a.png',
        '//evil.example',
        'tel:1',
        'http:///x',
      ],
    })
    expect(result.fileCandidates).toEqual(['src/app.GO:12:2', 'main.ts#L3C1', '/tmp/100%.md', null, null, null, null, null, null])
    expect(result.cases).toEqual([
      ['p d0 q0: 会话：', 'table lcr q0: Agent | 角色 | 状态 / `/root` | 主 **Agent** | 运行中', 'p d0 q0: 后文'],
      [
        'todo d1 q0: 待做',
        'done d1 q0: 完成 ~~旧~~ _斜_',
        'bullet d2 q0: 嵌套',
        'more d1 q0: 续段',
        'number 1 d1 q0: 一',
        'number 2 d1 q0: 二',
        'bullet d2 q0: 内层',
      ],
      // A disclosure is its words, a line break breaks the line, a comment says nothing, other markup reads as code.
      ['p d0 q0: 标题', 'p d0 q0: 内容 \n 换行 ', 'code html d0 q0: <div>标记</div>'],
      ['p d0 q1: 引用', 'rule q1', 'rule q0', 'h1 d0 q0: 一', 'h2 d0 q0: 二'],
      // A web picture is never a block to load; a project picture alone in its paragraph is.
      ['p d0 q0: [链接] ![网图]', 'image d0 q0: out/shot.png (截图)'],
      ['code swift d0 q0: let a = 1\n\n    缩进'],
      ['p d0 q0: 文字', 'code py open d0 q0: 未关\nx=1'],
      ['code mermaid open d0 q1: graph TD', 'p d0 q0: 后文'],
      ['code mermaid d1 q0: graph TD'],
      ['code mermaid open d0 q0: graph TD\n```'],
      ['code math d0 q0: E=mc^2'],
      null,
      ['code - d0 q0: 缩进的代码不算嵌套\n' + ' '.repeat(76) + 'x'],
    ])
    expect(result.links).toEqual([
      'web https://a.example/x',
      'web mailto:a@b.example',
      'text',
      'path src/app.ts',
      'path /tmp/a.png',
      'text',
      'text',
      'text',
    ])
  })
  it('draws a team’s returned results from its record: the round’s members, each reply in its own session', async () => {
    const member = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
      itemId: `itm_${id}`,
      sessionId: `ses_${id}`,
      title: `${name} 的任务`,
      name,
      harnessId: 'codex',
      state: 'done',
      said: '你好',
      ...extra,
    })
    const team = {
      id: 'tem_aaaaaaaaaaaaaaaaaaaaaa',
      leadSessionId: 'ses_lead',
      state: 'returned',
      round: 2,
      returnedMessageId: 'm_r2',
      createdAt: 't',
      updatedAt: 't',
      members: [
        member('one', '输出 1'),
        member('two', '', { title: '输出 2 的任务', state: 'unstarted', sessionId: undefined, refusal: '没有安装' }),
        member('three', '输出 3', { state: 'failed' }),
      ],
      rounds: [
        {
          round: 1,
          by: 'person',
          state: 'returned',
          returnedMessageId: 'm_r1',
          createdAt: 't',
          members: [
            { itemId: 'itm_one', state: 'done' },
            { itemId: 'itm_two', state: 'unstarted' },
            { itemId: 'itm_three', state: 'done' },
          ],
        },
        {
          round: 2,
          by: 'agent',
          state: 'returned',
          returnedMessageId: 'm_r2',
          createdAt: 't',
          members: [{ itemId: 'itm_three', state: 'failed', requestId: 'req_2' }],
        },
      ],
    }
    const single = {
      ...team,
      id: 'tem_bbbbbbbbbbbbbbbbbbbbbb',
      round: undefined,
      rounds: undefined,
      returnedMessageId: 'm_single',
      members: [member('four', '输出 4')],
    }
    const result = await invoke({
      operation: 'phoneTeamReturn',
      teams: [team, single],
      messages: [
        { id: 'm_r1', role: 'user', text: 'x' },
        { id: 'm_r2', role: 'user', text: 'x' },
        { id: 'm_single', role: 'user', text: 'x' },
        { id: 'm_lost', role: 'user', text: `${TEAM_RETURN_HEADING}\n\n…` },
        { id: 'm_plain', role: 'user', text: '你好' },
        { id: 'm_r1', role: 'assistant', text: 'x' },
      ],
      session: [
        { role: 'user', text: '开始' },
        { role: 'assistant', text: '第一轮' },
        { role: 'assistant', text: '  ' },
        { role: 'user', text: '再来', requestId: 'req_2' },
        { role: 'assistant', text: '第二轮的草稿' },
        { role: 'assistant', text: '第二轮' },
        { role: 'user', text: '第三次', requestId: 'req_3' },
      ],
      replies: [null, 'req_2', 'req_3', 'req_missing'],
    })
    // The Swift copy of the heading cannot drift from the Host's.
    expect(result.heading).toBe(TEAM_RETURN_HEADING)
    expect(result.cards).toEqual([
      // An earlier round: its members as they ended it, with no first line of a later reply.
      { title: '成员的结果 · 第 1 轮', rows: ['输出 1 done - - ses_one', '输出 2 的任务 unstarted - - -', '输出 3 done - - ses_three'] },
      { title: '成员的结果 · 第 2 轮', rows: ['输出 3 failed 你好 req_2 ses_three'] },
      { title: '成员的结果', rows: ['输出 4 done 你好 - ses_four'] },
      { title: '成员的结果', rows: [] },
      null,
      null,
    ])
    expect(result.replies).toEqual(['第一轮', '第二轮', '', ''])
    expect(result.words).toEqual(['正在开始', '运行中', '等你处理', '已完成', '失败', '已停止', '未回报结果', '没有开始'])
  })
  it('places each 团队分工 card after the turn its latest round came from and says where the results are', async () => {
    const team = (id: string, createdAt: string, extra: Record<string, unknown>) => ({
      id: `tem_${id.repeat(22)}`,
      leadSessionId: 'ses_lead',
      state: 'running',
      createdAt,
      updatedAt: createdAt,
      members: [],
      ...extra,
    })
    const member = (itemId: string, name: string, state: string, extra: Record<string, unknown> = {}) => ({
      itemId,
      sessionId: `ses_${itemId}`,
      name,
      title: `${name} 的任务`,
      harnessId: 'codex',
      state,
      ...extra,
    })
    const returned = team('a', '2026-11-01T09:00:00Z', {
      messageId: 'm_a2',
      state: 'returned',
      returnedMessageId: 'm_ret',
      members: [
        member('one', '审阅', 'done', { said: '好了' }),
        // No name: the title stands for it; a refusal takes the second line from what it said.
        member('two', '', 'unstarted', { title: '写测试', sessionId: undefined, refusal: '没有安装', said: '不该出现' }),
        member('three', '文档', 'failed'),
        { name: '没有 itemId', state: 'done' },
      ],
    })
    const lead = team('e', '2026-11-01T09:00:00Z', {
      messageId: 'm_lead0',
      state: 'stopping',
      goal: '   ',
      rounds: [{ round: 1, by: 'person', state: 'stopping', members: [], createdAt: 't' }],
      members: [member('four', '甲', 'running')],
    })
    const kept = team('d', '2026-11-01T09:30:00Z', {
      messageId: 'm_missing',
      state: 'kept',
      kept: 'stopped',
      goal: '检查 Rust 项目',
      agentDispatch: true,
      members: [member('five', '乙', 'cancelled')],
    })
    const newest = team('b', '2026-11-01T10:00:00Z', {
      messageId: 'm_a2',
      returnedMessageId: 'm_ret_old',
      round: 2,
      agentDispatch: true,
      rounds: [
        { round: 1, by: 'person', state: 'returned', members: [], messageId: 'm_a2', returnedMessageId: 'm_ret_old', createdAt: 't' },
        { round: 2, by: 'agent', state: 'running', members: [], messageId: 'm_steer', createdAt: 't' },
      ],
      members: [
        member('six', '丙', 'running', { startedAt: '2026-11-01T10:00:00Z' }),
        member('seven', '丁', 'waiting', { said: '要你批准' }),
        member('eight', '戊', 'done', { said: '你好' }),
      ],
    })
    const other = { ...team('c', '2026-11-01T08:00:00Z', { messageId: 'm_a1' }), leadSessionId: 'ses_other' }
    const messages = [
      { id: 'm_lead0', role: 'assistant', text: '来源会话的内容' },
      { id: 'm_a1', role: 'user', text: '分一下' },
      { id: 'm_a2', role: 'assistant', text: '好' },
      { id: 'm_ret', role: 'user', text: '结果' },
      { id: 'm_b1', role: 'user', text: '再来' },
      { id: 'm_steer', role: 'user', text: '补一句', steered: true },
      { id: 'm_b2', role: 'assistant', text: '派出去了' },
    ]
    const result = await invoke({
      operation: 'phoneTeamGraph',
      teams: [newest, other, returned, kept, lead],
      session: 'ses_lead',
      newest: newest.id,
      placements: [
        { session: 'ses_lead', messages },
        { session: 'ses_lead', messages: [] },
        { session: 'ses_none', messages },
      ],
      ends: [
        { state: 'running', members: ['running', 'done'] },
        { state: 'running', members: ['done', 'waiting'] },
        // Every member has ended once the results wait: a waiting member there is stale, not the person's to answer.
        { state: 'returning', members: ['waiting'] },
        { state: 'stopping', members: ['running'] },
        { state: 'returned', members: [] },
        { state: 'kept', members: [] },
      ],
    })
    expect(result.placements).toEqual([
      {
        // An assistant message walks back to its prompt; before any prompt, the lead content's turn; a steered message
        // stays in its turn; a message not in the record falls to the last turn; oldest first where two share one.
        m_a1: [returned.id],
        'lead:m_lead0': [lead.id],
        m_b1: [kept.id, newest.id],
      },
      { '': [returned.id, lead.id, kept.id, newest.id] },
      {},
    ])
    expect(result.cards).toEqual([
      {
        id: returned.id,
        title: '团队分工',
        count: '3 个成员',
        round: null,
        by: null,
        end: '已交回',
        endCount: null,
        endWire: 'done',
        kept: null,
        returned: 'm_ret',
        dispatch: false,
        members: ['审阅 done done said 好了 ses_one', '写测试 unstarted none refused 没有安装 -', '文档 failed done said - ses_three'],
      },
      {
        id: lead.id,
        title: '团队分工',
        count: '1 个成员',
        // One round: no chip.
        round: null,
        by: null,
        end: '正在停止…',
        endCount: null,
        endWire: 'idle',
        kept: null,
        returned: null,
        dispatch: false,
        members: ['甲 running flow said - ses_four'],
      },
      {
        id: kept.id,
        title: '检查 Rust 项目',
        count: '1 个成员',
        round: null,
        by: null,
        end: '留在这里',
        endCount: null,
        endWire: 'quiet',
        kept: '已停止',
        returned: null,
        // The switch is said only on the session's newest team.
        dispatch: false,
        members: ['乙 cancelled done said - ses_five'],
      },
      {
        id: newest.id,
        title: '团队分工',
        count: '3 个成员',
        round: '第 2 轮',
        by: 'Agent 派的',
        end: '等你处理',
        endCount: '1/3',
        endWire: 'idle',
        kept: null,
        // An earlier round's message is not where this round's results are.
        returned: null,
        dispatch: true,
        members: ['丙 running flow said - ses_six', '丁 waiting waiting said 要你批准 ses_seven', '戊 done done said 你好 ses_eight'],
      },
    ])
    expect(result.ends).toEqual(['members', 'you', 'pending', 'stopping', 'returned', 'kept'])
    expect(result.words).toEqual(['等成员', '等你处理', '正在停止…', '结果待发', '已交回', '留在这里'])
  })
  it('reads 额度与用量 as the desktop does: windows, pace, balance, failures, silent Harnesses and usage totals', async () => {
    const now = Date.parse('2026-11-19T12:00:00.000Z')
    const at = (seconds: number) => new Date(now + seconds * 1000).toISOString()
    const own = (id: string, label: string, extra: Record<string, unknown> = {}, quota = true) => ({
      id,
      status: 'ready',
      capabilities: { display: { label, mark: id }, models: { owner: 'harness', ...(quota ? { quota: true } : {}) } },
      ...extra,
    })
    const catalog = {
      providers: [{ id: 'deepseek', name: 'DeepSeek' }],
      workspaces: [
        { id: 'default', name: 'default' },
        { id: 'latch', name: 'latch' },
      ],
      harnesses: [
        { id: 'standard', status: 'ready', capabilities: { display: { label: 'Latch' }, models: { owner: 'latch' } } },
        own('claude-agent', 'Claude Agent', { quotaRead: { afterTurn: true } }),
        own('codex', 'Codex', {
          quota: {
            plan: 'pro',
            account: 'n•••@f•••.com',
            state: 'near',
            observedAt: at(-180),
            windows: [
              { kind: 'five-hour', usedPercent: 50, resetsAt: at(2 * 3600) },
              { kind: 'weekly', usedPercent: 85, resetsAt: at(3 * 86400 + 5 * 3600) },
              { kind: 'weekly-opus', usedPercent: 10, resetsAt: at(-3600) },
              { kind: 'weekly-sonnet', usedPercent: 40, resetsAt: at(5 * 86400) },
            ],
          },
        }),
        own('grok', 'Grok Build', {
          quota: {
            plan: 'supergrok',
            state: 'limited',
            observedAt: at(-10),
            balanceCents: 1230,
            currency: 'CNY',
            windows: [{ kind: 'five-hour', usedPercent: 100, resetsAt: at(30) }],
          },
        }),
        own('antigravity', 'Antigravity', {
          quota: {
            state: 'limited',
            observedAt: at(-7200),
            windows: [
              { kind: 'rolling', group: 'gemini', windowMinutes: 300, usedPercent: 0, resetsAt: at(5 * 3600) },
              { kind: 'rolling', group: 'claude-gpt', windowMinutes: 10080, state: 'near', resetsAt: at(86400) },
            ],
          },
        }),
        own('dsh', 'DeepSeek Harness', { quotaRead: { failed: { at: at(-60), reason: 'no-key' } } }),
        own('pi', 'pi', { quotaRead: { failed: { at: at(-60), reason: 'failed' } } }),
        own('goose', 'goose', { quotaRead: { running: true } }),
        own('cursor', 'Cursor', {
          quota: { state: 'ok', observedAt: at(-86400), windows: [{ kind: 'weekly', usedPercent: 20, resetsAt: at(-60) }] },
        }),
        own('opencode', 'OpenCode', {}, false),
        { ...own('qwen', 'Qwen Code', {}, false), status: 'unavailable' },
      ],
    }
    const row = (fields: Record<string, unknown>) => ({
      requests: 0,
      turns: 0,
      failed: 0,
      fallbacks: 0,
      measured: 0,
      partial: { cacheReadTokens: false, cacheWriteTokens: false, reasoningTokens: false },
      cost: [],
      uncosted: 0,
      ...fields,
    })
    const point = (bucket: number, harness: string, by: string, input: number, output: number, cacheRead = 0, cacheBase = 0) => ({
      bucket,
      by,
      harness,
      requests: 1,
      turns: 0,
      measured: 1,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheBase,
    })
    const days = Array.from({ length: 7 }, (_, index) => `2026-11-${13 + index}T00:00:00.000Z`)
    const summary = (period: string, group: string, buckets: string[], rows: unknown[], series: unknown[] = []) => ({
      period,
      group,
      by: 'all',
      from: buckets[0] ?? at(0),
      to: at(0),
      timeZone: 'UTC',
      buckets,
      series,
      hours: [],
      rows,
      projects: [],
      compare: [],
      skipped: 0,
      truncated: false,
    })
    const result = await invoke({
      operation: 'phoneUsage',
      now: at(0),
      catalog,
      summaries: [
        summary(
          '7',
          'harness',
          days,
          [
            row({
              by: 'gateway',
              harness: 'codex',
              requests: 4,
              measured: 4,
              usage: { inputTokens: 8000, outputTokens: 2000 },
              cost: [{ currency: 'USD', micros: 1_200_000 }],
            }),
            row({
              by: 'own',
              harness: 'codex',
              turns: 3,
              measured: 3,
              usage: { inputTokens: 1000, outputTokens: 500 },
              cost: [{ currency: 'USD', micros: 2100, estimated: true }],
            }),
            row({ by: 'own', harness: 'claude-agent', turns: 2 }),
          ],
          [point(0, 'codex', 'gateway', 8000, 2000, 3000, 6000), point(6, 'codex', 'own', 1000, 500)],
        ),
        summary(
          '1',
          'model',
          ['2026-11-19T10:00:00.000Z', '2026-11-19T11:00:00.000Z'],
          [
            row({
              by: 'gateway',
              providerId: 'deepseek',
              model: 'deepseek-chat',
              requests: 1,
              measured: 1,
              usage: { inputTokens: 900, outputTokens: 100 },
              cost: [{ currency: 'CNY', micros: 3_400_000 }],
            }),
            row({ by: 'own', harness: 'codex', model: 'gpt-5', turns: 1, measured: 1, usage: { inputTokens: 3000, outputTokens: 0 } }),
          ],
          [point(1, 'codex', 'own', 3000, 0), point(1, 'codex', 'gateway', 900, 100)],
        ),
        summary('30', 'project', days, [
          row({ by: 'own', harness: 'codex', projectId: 'latch', turns: 1, measured: 1, usage: { inputTokens: 300, outputTokens: 0 } }),
          row({ by: 'own', harness: 'codex', projectId: 'default', turns: 1, measured: 1, usage: { inputTokens: 100, outputTokens: 0 } }),
          row({ by: 'own', harness: 'codex', turns: 1, measured: 1, usage: { inputTokens: 100, outputTokens: 0 } }),
        ]),
        summary('90', 'harness', [], []),
        summary('2', 'harness', [], []),
      ],
    })
    const block = (id: string) => (result.blocks as Array<Record<string, unknown>>).find(item => item.id === id)
    // Those with figures first; the built-in, an unavailable one and one that never reports are not blocks.
    expect((result.blocks as Array<{ id: string }>).map(item => item.id)).toEqual([
      'codex',
      'grok',
      'antigravity',
      'claude-agent',
      'dsh',
      'pi',
      'goose',
      'cursor',
    ])
    expect(result.silent).toEqual(['OpenCode'])
    expect(result.worst).toBe('limited')
    expect(block('codex')).toMatchObject({
      state: 'near',
      facts: ['Pro', 'n•••@f•••.com'],
      balance: null,
      account: false,
      observed: '更新于 3 分钟前',
      // The Opus window is past its reset and goes; the five-hour window lasts past its reset at this rate, the weekly
      // one does not, and the Sonnet one runs out on Sunday.
      windows: [
        { group: null, name: '每 5 小时', state: 'ok', used: '已用 50%', reset: '2 小时后重置', pace: null },
        { group: null, name: '每周', state: 'near', used: '已用 85%', reset: '3 天 5 小时后重置', pace: '按现在的速度约 明天 04:03 用完' },
        { group: null, name: '每周 · Sonnet', state: 'ok', used: '已用 40%', reset: '5 天后重置', pace: '按现在的速度约 周日 12:00 用完' },
      ],
    })
    expect(block('grok')).toMatchObject({
      state: 'limited',
      facts: ['SuperGrok'],
      balance: '余额 ¥12.30',
      account: false,
      windows: [{ name: '每 5 小时', state: 'limited', used: '已用 100%', reset: '即将重置', pace: null }],
    })
    expect(block('antigravity')).toMatchObject({
      state: 'limited',
      account: true,
      observed: '更新于 2 小时前',
      windows: [
        // Nothing used and a whole window to go: not started, so no reset time.
        { group: 'Gemini 模型', name: '每 5 小时', state: 'ok', used: '已用 0%', reset: null, pace: null },
        { group: 'Claude 与 GPT 模型', name: '每 7 天', state: 'near', used: '将用尽', reset: '1 天后重置', pace: null },
      ],
    })
    expect(['claude-agent', 'dsh', 'pi', 'goose', 'cursor'].map(id => [block(id)?.note, block(id)?.retry, block(id)?.reading])).toEqual([
      ['只在对话中报告', false, false],
      ['无 API 密钥', false, false],
      ['读取失败', true, false],
      [null, false, true],
      ['尚未报告额度', false, false],
    ])
    expect(result.summaries).toEqual([
      {
        tokens: '11.5k',
        facts: ['5 轮', '4 次请求', '输入 9k · 输出 2.5k', '缓存命中 50%'],
        costs: ['$1.20'],
        estimated: true,
        empty: false,
        buckets: ['11/13=10000', '11/14=0', '11/15=0', '11/16=0', '11/17=0', '11/18=0', '11/19=1500'],
        // One Harness's gateway and own-login rows are one row; a Harness that reported no tokens says so.
        rows: ['Codex | - | 11.5k | 1.00 | $1.20', 'Claude Agent | - | 未报告 | 0.00 | -'],
      },
      {
        tokens: '4k',
        facts: ['1 轮', '1 次请求', '输入 3.9k · 输出 100'],
        costs: ['¥3.40'],
        estimated: false,
        empty: false,
        buckets: ['10:00=0', '11:00=4000'],
        rows: ['gpt-5 | Codex · 自己登录 | 3k | 0.75 | -', 'deepseek-chat | DeepSeek | 1k | 0.25 | ¥3.40'],
      },
      {
        tokens: '500',
        facts: ['3 轮', '输入 500 · 输出 0'],
        costs: [],
        estimated: false,
        empty: false,
        buckets: ['11/13=0', '11/14=0', '11/15=0', '11/16=0', '11/17=0', '11/18=0', '11/19=0'],
        rows: ['latch | - | 300 | 0.60 | -', '默认文件夹 | - | 100 | 0.20 | -', '其他 | - | 100 | 0.20 | -'],
      },
      { tokens: '0', facts: ['0 次请求'], costs: [], estimated: false, empty: true, buckets: [], rows: [] },
      null,
    ])
    expect(result.tokens).toEqual(['0', '850', '9.1k', '12.4k', '100k', '124k', '999k', '1M', '1.3M'])
    expect(result.costs).toEqual(['$0.0021', '¥12.50', '$1,234.57', '$0.00'])
    // Above a conversation's input once its Harness used a limit up: the window and when the last used-up one starts over.
    expect(result.notices).toEqual([
      '',
      '',
      '',
      'Grok Build 每 5 小时的额度已用完 · 即将重置',
      'Antigravity 的额度已用完',
      '',
      '',
      '',
      '',
      '',
      '',
    ])
  })
  it('writes the quota widgets only an allow-list of the catalog, on the phone’s clock, and reads it back stale after 15 minutes', async () => {
    const hostNow = Date.parse('2026-11-19T12:00:00.000Z')
    // The Host's clock runs two minutes ahead of the phone's.
    const offset = 120
    const host = (seconds: number) => new Date(hostNow + seconds * 1000).toISOString()
    const phone = (seconds: number) => new Date(hostNow - offset * 1000 + seconds * 1000).toISOString()
    const own = (id: string, label: string, quota?: Record<string, unknown>) => ({
      id,
      status: 'ready',
      capabilities: { display: { label, mark: id }, models: { owner: 'harness', quota: true } },
      ...(quota ? { quota } : {}),
    })
    const catalog = {
      providers: [{ id: 'deepseek', name: 'DeepSeek', apiKey: 'sk-provider-secret' }],
      workspaces: [{ id: 'latch', name: 'secret-project', path: '/Users/someone/secret-project' }],
      harnesses: [
        { id: 'standard', status: 'ready', capabilities: { display: { label: 'Latch' }, models: { owner: 'latch' } } },
        own('claude-agent', 'Claude Agent'),
        own('codex', 'Codex', {
          plan: 'pro',
          account: 'n•••@f•••.com',
          balanceCents: 4321,
          currency: 'USD',
          state: 'near',
          observedAt: host(-180),
          extra: 'secret-quota-field',
          windows: [
            { kind: 'five-hour', usedPercent: 50, resetsAt: host(2 * 3600), note: 'secret-window-note' },
            { kind: 'weekly', usedPercent: 85, resetsAt: host(3 * 86400 + 5 * 3600) },
            // Past its reset already: it is not written.
            { kind: 'weekly-opus', usedPercent: 10, resetsAt: host(-3600) },
          ],
        }),
        own('grok', 'Grok Build', {
          plan: 'supergrok',
          state: 'limited',
          observedAt: host(-10),
          balanceCents: 1230,
          currency: 'CNY',
          windows: [{ kind: 'five-hour', usedPercent: 100, resetsAt: host(30) }],
        }),
        own('antigravity', 'Antigravity', {
          state: 'limited',
          observedAt: host(-7200),
          windows: [
            { kind: 'rolling', group: 'gemini', windowMinutes: 300, usedPercent: 0, resetsAt: host(5 * 3600) },
            { kind: 'rolling', group: 'claude-gpt', windowMinutes: 10080, state: 'near', resetsAt: host(86400) },
          ],
        }),
        // Every window has reset, an id that is not one, and a balance alone: none is written.
        own('cursor', 'Cursor', {
          state: 'ok',
          observedAt: host(-86400),
          windows: [{ kind: 'weekly', usedPercent: 20, resetsAt: host(-60) }],
        }),
        own('../escape', 'Escape', {
          state: 'near',
          observedAt: host(0),
          windows: [{ kind: 'weekly', usedPercent: 90, resetsAt: host(60) }],
        }),
        own('dsh', 'DeepSeek Harness', { state: 'ok', observedAt: host(0), balanceCents: 900, currency: 'CNY', windows: [] }),
      ],
    }
    const result = await invoke({
      operation: 'phoneQuotaWidget',
      hostNow: host(0),
      hostOffset: offset,
      chosen: 'antigravity',
      catalog,
      at: [phone(0), phone(12 * 60), phone(12 * 60 + 1)],
    })
    const text = result.text as string
    expect(JSON.parse(text)).toEqual({
      version: 1,
      harnesses: [
        {
          id: 'codex',
          capabilities: { display: { label: 'Codex', mark: 'codex' } },
          quota: {
            state: 'near',
            observedAt: phone(-180),
            windows: [
              { kind: 'five-hour', usedPercent: 50, resetsAt: phone(2 * 3600) },
              { kind: 'weekly', usedPercent: 85, resetsAt: phone(3 * 86400 + 5 * 3600) },
            ],
          },
        },
        {
          id: 'grok',
          capabilities: { display: { label: 'Grok Build', mark: 'grok' } },
          quota: { state: 'limited', observedAt: phone(-10), windows: [{ kind: 'five-hour', usedPercent: 100, resetsAt: phone(30) }] },
        },
        {
          id: 'antigravity',
          capabilities: { display: { label: 'Antigravity', mark: 'antigravity' } },
          quota: {
            state: 'limited',
            observedAt: phone(-7200),
            windows: [
              { kind: 'rolling', windowMinutes: 300, usedPercent: 0, resetsAt: phone(5 * 3600) },
              { kind: 'rolling', windowMinutes: 10080, state: 'near', resetsAt: phone(86400) },
            ],
          },
        },
      ],
    })
    // Every key the file holds, by path: nothing outside the allow-list ever reaches the App Group.
    const allowed = new Set([
      'version',
      'harnesses',
      'harnesses[].id',
      'harnesses[].capabilities',
      'harnesses[].capabilities.display',
      'harnesses[].capabilities.display.label',
      'harnesses[].capabilities.display.mark',
      'harnesses[].quota',
      'harnesses[].quota.state',
      'harnesses[].quota.observedAt',
      'harnesses[].quota.windows',
      'harnesses[].quota.windows[].kind',
      'harnesses[].quota.windows[].windowMinutes',
      'harnesses[].quota.windows[].usedPercent',
      'harnesses[].quota.windows[].state',
      'harnesses[].quota.windows[].resetsAt',
    ])
    const paths = (value: unknown, at: string): string[] =>
      Array.isArray(value)
        ? value.flatMap(item => paths(item, `${at}[]`))
        : value !== null && typeof value === 'object'
          ? Object.entries(value).flatMap(([key, child]) => {
              const path = at ? `${at}.${key}` : key
              return [path, ...paths(child, path)]
            })
          : []
    expect(paths(JSON.parse(text), '').filter(path => !allowed.has(path))).toEqual([])
    for (const secret of ['n•••', 'pro', 'supergrok', '4321', '1230', 'secret', 'sk-', '/Users', 'Cursor', 'escape'])
      expect(text.includes(secret)).toBe(false)
    expect(result.unchanged).toBe(true)
    expect(result.rejected).toEqual([true, true, true])
    const [first, atBoundary, pastBoundary] = result.moments as Array<Array<Record<string, unknown>>>
    // The Harness chosen in the widget's settings comes first; each shows its worst window, then its most used.
    expect(first).toEqual([
      {
        id: 'antigravity',
        name: 'Antigravity',
        mark: 'antigravity',
        state: 'limited',
        account: true,
        stale: true,
        observed: '更新于 2 小时前',
        leading: { name: '每 7 天', state: 'near', used: '将用尽', reset: '1 天后重置', pace: null },
        windows: [
          { name: '每 5 小时', state: 'ok', used: '已用 0%', reset: null, pace: null },
          { name: '每 7 天', state: 'near', used: '将用尽', reset: '1 天后重置', pace: null },
        ],
      },
      {
        id: 'codex',
        name: 'Codex',
        mark: 'codex',
        state: 'near',
        account: false,
        stale: false,
        observed: '更新于 3 分钟前',
        leading: { name: '每周', state: 'near', used: '已用 85%', reset: '3 天 5 小时后重置', pace: '按现在的速度约 明天 04:01 用完' },
        windows: [
          { name: '每 5 小时', state: 'ok', used: '已用 50%', reset: '2 小时后重置', pace: null },
          { name: '每周', state: 'near', used: '已用 85%', reset: '3 天 5 小时后重置', pace: '按现在的速度约 明天 04:01 用完' },
        ],
      },
      {
        id: 'grok',
        name: 'Grok Build',
        mark: 'grok',
        state: 'limited',
        account: false,
        stale: false,
        observed: '更新于刚刚',
        leading: { name: '每 5 小时', state: 'limited', used: '已用 100%', reset: '即将重置', pace: null },
        windows: [{ name: '每 5 小时', state: 'limited', used: '已用 100%', reset: '即将重置', pace: null }],
      },
    ])
    // Fifteen minutes after the Host read Codex's figures they are still current; a second later they are out of date.
    // Grok's only window has reset, so nothing it said holds any longer.
    const brief = (list: Array<Record<string, unknown>>) => list.map(item => [item.id, item.state, item.stale, item.leading === null])
    expect(brief(atBoundary)).toEqual([
      ['antigravity', 'limited', true, false],
      ['codex', 'near', false, false],
      ['grok', null, false, true],
    ])
    expect(brief(pastBoundary).map(item => item[2])).toEqual([true, true, false])
    // Every five minutes for three hours, and when words change kind: after a reset, a minute before one, and on going stale.
    const dates = result.dates as string[]
    expect(dates).toEqual(dates.toSorted())
    expect(dates[0]).toBe(phone(0))
    expect(dates.at(-1)).toBe(phone(3 * 3600))
    for (const moment of [phone(300), phone(31), phone(12 * 60 + 1), phone(-10 + 901), phone(2 * 3600 - 59), phone(2 * 3600 + 1)])
      expect(dates).toContain(moment)
    expect(dates).toHaveLength(37 + 5)
  })
  it('derives the composer’s attachment decisions: reasons, limits, refusal classes, the tray and metadata-free images', async () => {
    const result = await invoke({ operation: 'phoneAttachments' })
    // The Host's own limits, said with a refusal: per kind for a plugin Harness, one file limit where it takes every file.
    expect(result.limits).toEqual([
      '图片 5 MB 内 · 文字文件 256 KB 内 · 每条 8 个',
      '文字文件 25 MB 内 · 每条 8 个',
      '',
      '每个文件 50 MB 内 · 每条 8 个',
    ])
    expect(result.clamped).toEqual([50 * 1024 * 1024, 50 * 1024 * 1024])
    expect(result.unavailable).toEqual([
      '',
      '这个 Harness 不接收图片和文件。',
      '这个 Harness 不接收图片和文件。',
      '正在读取这个 Harness 能收的附件…',
      '没能读取这个 Harness 能收的附件，稍后再试。',
    ])
    expect(result.revision).toEqual(['ready:-', 'ready:'])
    expect(result.malformedCaps).toBe(true)
    // By type before the content is read: SVG and HTML are text, a PDF, a Word file, a video and an archive are files.
    expect(result.kinds).toEqual(['image', 'image', 'text', 'text', 'text', 'file', 'text', 'file', 'text', 'file', 'file'])
    expect(result.admit).toEqual([
      'ok',
      '「big.log」超过 256 KB，没有添加。可以添加：图片 5 MB 内 · 文字文件 256 KB 内 · 每条 8 个。',
      '「huge.log」超过 25 MB，没有添加。可以添加：文字文件 25 MB 内 · 每条 8 个。',
      // An original larger than the image limit is re-encoded first; only one past what the phone reads is refused.
      'ok',
      '「IMG_2.heic」超过 50 MB，没有添加。可以添加：图片 5 MB 内 · 文字文件 256 KB 内 · 每条 8 个。',
      '这个 Harness 不接收图片。',
      '「deck.pdf」不能添加：只收图片和文字文件。',
      '空文件不能添加。',
      '每条消息最多添加 8 个附件。',
      '这个 Harness 不接收图片和文件。',
      '没能读取「bundle.app」，没有添加。',
    ])
    // Where the Host takes every file: any type, text up to the file limit rather than 256 KB, and 50 MB exactly.
    expect(result.admitFiles).toEqual([
      'ok',
      'ok',
      'ok',
      '「clip.mov」超过 50 MB，没有添加。可以添加：每个文件 50 MB 内 · 每条 8 个。',
      '「dump.log」超过 50 MB，没有添加。可以添加：每个文件 50 MB 内 · 每条 8 个。',
    ])
    expect(result.admitSize).toEqual([
      'ok',
      '「big.jpg」超过 5 MB，没有添加。可以添加：图片 5 MB 内 · 文字文件 256 KB 内 · 每条 8 个。',
      'ok',
    ])
    expect(result.takes).toEqual([false, true, false, true])
    expect(result.icons).toEqual(['image', 'text', 'pdf', 'video', 'audio', 'archive', 'document', 'document', 'video'])
    expect(result.classes).toEqual(['refused', 'refused', 'refused', 'retry', 'released', 'confirm', 'retry'])
    expect(result.pastedPng).toEqual([true, true, true, true])
    expect(result.sendOwnership).toEqual([true, true])
    expect(result.renewedWindowImage).toEqual([true, true, true])
    expect(result.sentQuoteParts).toEqual(['literal example', 'moon after@11', '附注', 'red moon@22'])
    expect(result.composerReferences).toEqual({
      display: '📝\n\ufffc\ufffcdone',
      copied: '月🌕\n二行月🌕\n二行',
      ranges: [
        [3, '[引用回复 s/m1@4]\n> 月🌕\n> 二行\n\n'.length],
        [3, 1],
        [4, 0],
      ],
      deletes: [true, true, true, true],
      edges: [true, true, true, true, true],
      sources: [
        ['conversation', '会话', 'Earlier work'],
        ['hook', 'pre-push', '🪝 failed\n```\nnote'],
        ['handoff', '交回结果', '结论一\n\n结论二'],
        ['reply', '回复', '月🌕\n二行'],
      ],
      allVisible: '\ufffc\ufffc\ufffc\ufffcok',
      roundtrip: true,
      deletesHook: true,
      literal: true,
      oldHandoff: true,
      terminal: [
        '终端 1',
        '终端 2 · 最近报错（较早的输出未包含）',
        'Terminal 12',
        'Terminal 1,024 · Latest error (earlier output omitted)',
      ].map(title => [title, 'first 🚧\n```\nlast']),
      terminalExamples: true,
      typedPlaceholder: true,
      ime: [true, true],
    })
    expect(result.conversationReferences).toEqual([
      'A\n〔会话：Earlier work〕\n〔引用原句〕\n> quoted words\nB',
      'roundtrip',
      'removed',
      'located',
      'formatted',
      'second',
      'one reference',
    ])
    expect(result.heldBack).toEqual(['排队的消息不能带附件，本轮结束后再发送。', '追加的消息不能带附件，本轮结束后再发送。', '', ''])
    // A pick that yields nothing always says why; only a cancel is silent.
    expect(result.picks).toEqual(['', '没有收到选中的文件，请再选一次。', '没有收到选中的文件，请再选一次。', ''])
    expect(result.startSelection).toEqual([
      '{"harnessId":"fake","mode":"agent","model":{"model":"m","providerId":"p"},"workspaceId":"default"}',
      'none',
    ])
    expect(result.names).toEqual(['IMG_0001.jpg', 'gpj.txt', '图片.png'])
    // Pictures keep pixels only; any other file is staged and known by its content; the picker's copy is gone after one
    // read; a file past the limit is not read; a launch purges what a lost picker or a staged row left.
    expect(result.loader).toEqual({
      file: [],
      fileName: 'IMG_9001.jpg',
      fileKind: 'image',
      thumbnail: true,
      camera: [],
      cameraName: '照片.jpg',
      bigStaged: false,
      bigKind: 'text',
      bigSize: 300000,
      kinds: {
        'blob.bin': 'file',
        'deck.pdf': 'file',
        'fake.png': 'file',
        'icon.svg': 'text',
        'latin.txt': 'file',
        'note.md': 'text',
        'nul.txt': 'file',
        'page.html': 'text',
        'split.txt': 'text',
      },
      left: [],
      boundary: [50 * 1024 * 1024, -1, 50 * 1024 * 1024 + 1],
      purged: true,
      afterPurge: [],
    })
    // Past 40 megapixels is refused from 照片 and from 文件 alike, never sent as the original with its metadata.
    expect(result.hugeImage).toEqual(['图片超过 4000 万像素，没有添加。', 'image:unstaged:图片超过 4000 万像素，没有添加。'])
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
    // Only a re-encoded picture is declared one; the Host sniffs text and every other file.
    expect(result.declared).toEqual(['image', 'file', 'file'])
    expect(result.declaredHash).toBe(true)
    expect(result.pendingCount).toBe(2)
    // Bytes wait in a private staged file, not in memory, and go with the Host's keeping, the row, the tray or a purge.
    expect(result.stage).toEqual({
      folder: 'latch-attachments',
      random: true,
      backup: true,
      mode: '600',
      hash: true,
      chunk: true,
      past: true,
      readyGone: true,
      removedGone: true,
      clearedGone: true,
      purged: true,
      orphanGone: true,
    })
    expect(result.memory).toEqual({
      unfinishedBefore: 2,
      dropped: true,
      smaller: true,
      unfinishedAfter: 1,
      removedUpload: true,
      staged: ['等待上传的附件已占用 512 MB，请先发送或移除一些附件。', 'ok'],
    })
    // A GIF is listed but not previewed: Quick Look stays with text and PNG/JPEG; a PDF is listed by its type and name;
    // a malformed reference is left out.
    expect(result.chips).toEqual(['shot.png|true|200 KB|true|image', 'anim.gif|true|1 KB|false|image', 'spec.pdf|false|2 MB|false|pdf'])
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
        // Before the agent first started, the Host takes every file by its path: nothing to explain.
        freshReason: '',
        reported: 'ready:it',
        caps: '每个文件 50 MB 内 · 每条 8 个',
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
        // An agent that reads neither natively still gets both kinds, by their path.
        plainReason: '',
        plainOffers: true,
        plainTaken: true,
        earlyRefusal: 'attachment-image-unsupported:refused',
        // A PDF as its own bytes, and text past 256 KB by its path: both declared files, kept as what they are.
        files: ['file', 'application/pdf', 'text', '300000'],
        cancelMid: { stopped: true, afterCancel: 0, partial: true },
        queue: 'accepted',
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
  it('queues only a screenshot from the Swift phone and delivers the original image once after switching sessions', async () => {
    const seen: Array<{ text: string; images: Buffer[] }> = []
    let marker: string
    const model = { providerId: 'screen-fixture', model: 'vision' }
    const host = await startTestHost({
      native: { host: '127.0.0.1', port: 0 },
      demo: false,
      plugins: [
        {
          id: 'screen-fixture',
          name: 'Screenshot fixture',
          description: '',
          version: '1.0.0',
          activate(context) {
            context.registerProvider({
              id: model.providerId,
              name: 'Screenshot fixture',
              model: model.model,
              modelCapabilities: { vision: { vision: true } },
              async *stream({ messages, signal }) {
                const message = messages.findLast(item => item.role === 'user')!
                seen.push({
                  text: message.content,
                  images: (message.attachments ?? []).flatMap(item => (item.type === 'image' ? [Buffer.from(item.data, 'base64')] : [])),
                })
                if (message.content === 'hold this turn')
                  await vi.waitFor(() => expect(signal.aborted || existsSync(marker)).toBe(true), { timeout: 20_000 })
                yield { type: 'text', text: 'Done.' }
                yield { type: 'finish', reason: 'stop' }
              },
            })
          },
        },
      ],
    })
    try {
      marker = join(host.root, 'phone-returned')
      const start = (prompt: string) => host.host.bridge.createTask({ requestId: randomUUID(), prompt, mode: 'chat', model })
      const other = await start('other session')
      await vi.waitFor(async () => expect((await host.host.bridge.detail(other.sessionId)).summary.status).toBe('idle'))
      const target = await start('hold this turn')
      const owner = await host.enroll({ listener: 'unix' })
      const { invitation } = await owner.json<{ invitation: { payload: string } }>('native/pairings', { method: 'POST', body: {} })
      const result = await invoke(
        {
          operation: 'nativeWorkspace',
          payload: invitation.payload,
          port: host.host.nativePort,
          queuedScreenshot: target.sessionId,
          otherSession: other.sessionId,
          returnedMarker: marker,
        },
        25_000,
      )
      expect(typeof result.original).toBe('string')
      const original = Buffer.from(result.original as string, 'base64')
      expect(original.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
      expect(seen).toEqual([
        { text: 'other session', images: [] },
        { text: 'hold this turn', images: [] },
        { text: '', images: [original] },
      ])
      for (const [id, count] of [
        [target.sessionId, 1],
        [other.sessionId, 0],
      ] as const) {
        const detail = await owner.json<TaskDetail>(`tasks/${id}`)
        expect(detail.queue ?? []).toEqual([])
        expect(detail.messages.flatMap(message => message.attachments ?? []).map(ref => ref.id)).toEqual(count ? [result.id] : [])
      }
    } finally {
      await host.close()
    }
  }, 30_000)
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
  it('uses full structured commands and compares only complete file sides in approval details', async () => {
    const line = 'pnpm test\npnpm check:quick'
    const shell = (input: string, argumentsLine?: string) => ({
      toolName: 'shell',
      tool: { kind: 'execute', input },
      arguments: argumentsLine,
    })
    const edit = (diff: object, input?: string) => ({ toolName: 'apply_patch', tool: { kind: 'edit', diffs: [diff], input } })
    const change = { path: 'README.md', oldText: 'one\ntwo\n', newText: 'one\nthree\n' }
    const outsideSandbox = '允许后，这条命令在沙箱之外运行'
    const otherGrants = [outsideSandbox, '还需要访问外部目录']
    const { approvalPresentations } = await invoke({
      operation: 'phoneActions',
      approvalPresentations: [
        shell(JSON.stringify({ command: line, cwd: '/fixture/project', timeout_ms: 5000 })),
        shell('{"command":"pnpm\\u200b test"}'),
        shell(JSON.stringify({ command: line, network: { host: 'example.invalid' } })),
        shell(JSON.stringify({ command: line }), JSON.stringify({ command: 'swift test' })),
        shell(JSON.stringify({ command: line, grants: [outsideSandbox] })),
        shell(JSON.stringify({ command: line, grants: otherGrants })),
        shell(JSON.stringify({ command: line, grants: ['允许后运行这条命令'] })),
        edit(change),
        edit({ path: change.path, newText: change.newText }),
        edit({ path: change.path, newText: change.newText, previous: 'none' }),
        edit({ ...change, newText: 'partial\n…（内容过长，已截断）' }),
        edit(change, JSON.stringify({ grantRoot: '/fixture' })),
      ],
    })
    const empty = { command: '', directory: '', grant: '', details: '', edit: false, hidden: false, stat: [] }
    expect(approvalPresentations).toEqual([
      { ...empty, command: line, directory: '/fixture/project', details: '{"timeout_ms":5000}' },
      { ...empty, command: 'pnpm\u200b test', hidden: true },
      empty,
      empty,
      { ...empty, command: line, grant: 'outsideSandbox' },
      { ...empty, command: line, grant: 'review', details: JSON.stringify({ grants: otherGrants }) },
      { ...empty, command: line, details: '{"grants":["允许后运行这条命令"]}' },
      { ...empty, edit: true, stat: [1, 1] },
      { ...empty, edit: true },
      { ...empty, edit: true, stat: [2, 0] },
      { ...empty, edit: true },
      { ...empty, stat: [1, 1] },
    ])
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
        { status: 'running', detail: { steer: true }, attached: true, queues: true },
        { status: 'running', detail: { steer: true, steerAttachments: true }, attached: true, queues: true },
        { status: 'running', detail: { steer: true, steerAttachments: true }, attached: true, nextTurnOnly: true, queues: true },
        { status: 'running', detail: { steer: true }, queues: true, preferred: 'queue' },
        { status: 'running', detail: { steer: true, steerAttachments: true }, attached: true, queues: true, preferred: 'queue' },
        {
          status: 'running',
          detail: { steer: true, steerAttachments: true },
          attached: true,
          queues: true,
          queueAttachments: false,
          preferred: 'queue',
        },
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
    expect(result.followUp).toEqual([
      ['send', ''],
      ['steer', ''],
      ['queue', ''],
      ['none', ''],
      ['queue', ''],
      ['steer', 'queue'],
      ['queue', ''],
      ['queue', 'steer'],
      ['queue', 'steer'],
      ['steer', ''],
    ])
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
  it('recovers the first native session list and keeps it when an older equal-revision response arrives', async () => {
    const markers = await mkdtemp(join(tmpdir(), 'latch-native-initial-list-'))
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const { invitation } = await owner.json<{ invitation: { payload: string } }>('native/pairings', { method: 'POST', body: {} })
      const race = { markers, reads: 0, sessionList: true }
      nativeSnapshotRace.current = race
      expect(
        await invoke({
          operation: 'nativeWorkspace',
          payload: invitation.payload,
          port: host.host.nativePort,
          initialListMarkers: markers,
        }),
      ).toEqual({ recovered: true, lateReadKeptSession: true, cacheKeptSession: true, windowClosed: true })
      expect(race.reads).toBe(3)
    } finally {
      nativeSnapshotRace.current = undefined
      await host.close()
      await rm(markers, { recursive: true, force: true })
    }
  }, 30_000)

  it('keeps native work-item cache at the accepted checkpoint across waiting writes and a path swap', async () => {
    const markers = await mkdtemp(join(tmpdir(), 'latch-native-work-cache-'))
    try {
      const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
      try {
        const owner = await host.enroll({ listener: 'unix' })
        const { invitation } = await owner.json<{ invitation: { payload: string } }>('native/pairings', { method: 'POST', body: {} })
        const itemId = 'itm_' + 'e'.repeat(22)
        const race = { markers, itemId, reads: 0 }
        nativeSnapshotRace.current = race
        expect(
          await invoke({
            operation: 'nativeWorkspace',
            payload: invitation.payload,
            port: host.host.nativePort,
            workCacheItem: itemId,
            workCacheMarkers: markers,
          }),
        ).toEqual({
          publicCacheExisted: true,
          vaultWasHeld: true,
          acceptedLatestDuringInstall: true,
          offlinePrivateRowWithdrawn: true,
          offlineRevisionKept: true,
          newInstanceResetFloor: true,
        })
        expect(race.reads).toBe(5)
      } finally {
        nativeSnapshotRace.current = undefined
        await host.close()
      }
    } finally {
      await rm(markers, { recursive: true, force: true })
    }
  }, 30_000)

  it('keeps native work-item cache private across a quick lock and offline reopen with a paused vault', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const { invitation } = await owner.json<{ invitation: { payload: string } }>('native/pairings', { method: 'POST', body: {} })
      const itemId = 'itm_' + 'f'.repeat(22)
      const race = { itemId, reads: 0, lockOpen: true }
      nativeSnapshotRace.current = race
      expect(
        await invoke({
          operation: 'nativeWorkspace',
          payload: invitation.payload,
          port: host.host.nativePort,
          workCacheItem: itemId,
          workCacheLockOpen: true,
        }),
      ).toEqual({
        waitedWhileOldVaultHeld: true,
        oldStoreLockedBeforeReopening: true,
        canceledAndProtectedReopensSkipped: true,
        offlinePrivateRowWithdrawn: true,
        offlineRevisionKept: true,
      })
      expect(race.reads).toBe(2)
    } finally {
      nativeSnapshotRace.current = undefined
      await host.close()
    }
  }, 30_000)

  it.each(['malformed', 'access lost'] as const)(
    'closes and reopens native work items and posts once to the intended thread or member after a lost answer: %s',
    async reply => {
      const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
      let patch = '',
        post = '',
        delivery = ''
      try {
        const owner = await host.enroll({ listener: 'unix' })
        const { item } = await owner.json<{ item: { id: string } }>('work/items', {
          method: 'POST',
          body: { title: 'Mobile work item', requestId: randomUUID() },
        })
        const { item: memberItem } = await owner.json<{ item: { id: string } }>('work/items', {
          method: 'POST',
          body: { title: 'Mobile member item', requestId: randomUUID() },
        })
        const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
          method: 'POST',
          body: { mode: 'chat', prompt: 'Discussion target', requestId: randomUUID() },
        })
        await expect.poll(async () => (await owner.json<{ summary: { status: string } }>(`tasks/${sessionId}`)).summary.status).toBe('idle')
        await owner.json(`work/items/${memberItem.id}/sessions`, { method: 'POST', body: { sessionId } })
        const { invitation } = await owner.json<{ invitation: { payload: string } }>('native/pairings', { method: 'POST', body: {} })
        patch = `PATCH /link/api/work/items/${item.id}`
        post = `POST /link/api/work/items/${item.id}/posts`
        delivery = `POST /link/api/work/items/${memberItem.id}/posts`
        if (reply === 'access lost') {
          nativeWorkLostAccess.set(patch, 403)
          nativeWorkLostAccess.set(post, 401)
          nativeWorkLostAccess.set(delivery, 404)
        } else {
          nativeMalformedSuccess.add(patch)
          nativeMalformedSuccess.add(post)
          nativeMalformedSuccess.add(delivery)
        }
        expect(
          await invoke({
            operation: 'nativeWorkspace',
            payload: invitation.payload,
            port: host.host.nativePort,
            workChangesItem: item.id,
            workChangesDenied: reply === 'access lost',
            workMember: sessionId,
            workMemberItem: memberItem.id,
          }),
        ).toEqual({
          closeConfirmedAfterLostAnswer: true,
          reopened: true,
          staleRevisionRefused: true,
          postRetriedOnce: true,
          deliveredToMember: true,
          settled: true,
          posts: [1, 1],
        })
        expect(nativeSeen.filter(call => call.method + ' ' + call.path === delivery)).toHaveLength(1)
        expect(
          nativeSeen.some(call => call.method === 'GET' && call.path.startsWith(`/link/api/work/items/${memberItem.id}/posts/pst_`)),
        ).toBe(true)
      } finally {
        nativeMalformedSuccess.delete(patch)
        nativeMalformedSuccess.delete(post)
        nativeMalformedSuccess.delete(delivery)
        for (const key of [patch, post, delivery]) nativeWorkLostAccess.delete(key)
        await host.close()
      }
    },
    30_000,
  )

  it('withholds a settled work reply when its window expires during removal of the encrypted pending record', async () => {
    const markers = await mkdtemp(join(tmpdir(), 'latch-swift-work-settled-'))
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    let key = ''
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const { item } = await owner.json<{ item: { id: string } }>('work/items', {
        method: 'POST',
        body: { title: 'Private work receipt', requestId: randomUUID() },
      })
      const { invitation } = await owner.json<{ invitation: { payload: string } }>('native/pairings', { method: 'POST', body: {} })
      key = `PATCH /link/api/work/items/${item.id}`
      nativeWorkAnswerGate.set(key, markers)
      expect(
        await invoke({
          operation: 'nativeWorkspace',
          payload: invitation.payload,
          port: host.host.nativePort,
          workSettlementItem: item.id,
          workSettlementMarkers: markers,
        }),
      ).toEqual({
        resultWithdrawn: true,
        alreadySettled: true,
        retryRefused: true,
        blockedDuringSettlement: true,
        stalePendingWithdrawn: true,
        oldWindowRefused: true,
      })
      expect(nativeSeen.filter(call => call.method + ' ' + call.path === key)).toHaveLength(1)
    } finally {
      nativeWorkAnswerGate.delete(key)
      await host.close()
      await rm(markers, { recursive: true, force: true })
    }
  }, 30_000)

  it('keeps native work-item reads on one installed transport across a restored window', async () => {
    const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const { item } = await owner.json<{ item: { id: string } }>('work/items', {
        method: 'POST',
        body: { requestId: randomUUID(), title: 'Native transport work fixture', prompt: 'Read only' },
      })
      const { invitation } = await owner.json<{ invitation: { payload: string } }>('native/pairings', { method: 'POST', body: {} })
      expect(
        await invoke({
          operation: 'nativeWorkspace',
          workTransportItem: item.id,
          payload: invitation.payload,
          port: host.host.nativePort,
        }),
      ).toEqual({
        originalRead: true,
        sameInstanceCheckpoint: true,
        restoredWindow: true,
        withoutNewSignature: true,
        oldEpochWithdrawnDuringInstall: true,
        oldPublicationRejected: true,
        oldCompositionRejected: true,
        currentCompositionAccepted: true,
        closeWithdrawn: true,
      })
    } finally {
      await host.close()
    }
  }, 30_000)

  it('builds an unstarted item without engine settings and accepts only a matching creation acknowledgement', async () => {
    expect(
      await invoke({
        operation: 'phoneWorkItems',
        creationFields: true,
        capabilities: [
          { catalog: { features: { workItems: true, workItemTurns: true } } },
          { catalog: { features: { workItems: true, workItemTurns: true, workItemCreateReceipt: true } } },
        ],
        item: {
          id: `itm_${'m'.repeat(22)}`,
          title: '保存',
          prompt: '要求',
          revision: 1,
          sessionIds: [],
          updatedAt: '2026-10-01T00:00:00Z',
          board: { group: 'todo' },
        },
      }),
    ).toEqual({
      capabilities: [false, true],
      keys: ['prompt', 'requestId', 'title'],
      project: 'two',
      prompt: '要求',
      title: '保存',
      valid: true,
      mismatch: false,
      malformed: false,
      longTitleRejected: true,
    })
  })

  it.each(['lost acknowledgement', 'service unavailable', 'access changed'] as const)(
    'checks a pending mobile work creation without sending a second create (%s)',
    async scenario => {
      const landed = scenario === 'lost acknowledgement'
      const host = await startTestHost({ native: { host: '127.0.0.1', port: 0 } })
      const first = 'POST /link/api/work/items'
      const fault = landed ? nativeMalformedSuccess : nativeDrop
      const from = nativeSeen.length
      try {
        const owner = await host.enroll({ listener: 'unix' })
        const { invitation } = await owner.json<{ invitation: { payload: string } }>('native/pairings', { method: 'POST', body: {} })
        if (scenario === 'access changed') nativeReadFaults.set(first, [{ status: 403, code: 'forbidden' }])
        else fault.add(first)
        expect(
          await invoke({
            operation: 'nativeWorkspace',
            workCreationReceipt: landed,
            payload: invitation.payload,
            port: host.host.nativePort,
          }),
        ).toEqual({
          confirmed: landed,
          cleared: true,
        })
        expect(
          nativeSeen
            .slice(from)
            .filter(row => row.method === 'POST' && row.path.startsWith('/link/api/work/items'))
            .map(row => row.path),
        ).toEqual(['/link/api/work/items', '/link/api/work/items/retry-create'])
        const snapshot = await owner.json<AppSnapshot>('snapshot')
        expect(snapshot.items ?? []).toHaveLength(landed ? 1 : 0)
        expect(snapshot.tasks).toHaveLength(0)
        if (landed) expect(snapshot.items?.[0]).toMatchObject({ title: '移动端草稿', board: { group: 'todo' }, sessionIds: [] })
      } finally {
        fault.delete(first)
        nativeReadFaults.delete(first)
        await host.close()
      }
    },
    30_000,
  )
  it('filters visible mobile work items by title and member project across Host groups', async () => {
    const row = (key: string, title: string, day: string) => ({
      id: `itm_${key.repeat(22)}`,
      title,
      revision: 1,
      updatedAt: `2026-10-${day}T00:00:00Z`,
      sessionIds: [] as string[],
    })
    const snapshot = {
      catalog: {
        features: { workItems: true, workItemTurns: true },
        workspaces: [
          { id: 'alpha', name: 'Alpha' },
          { id: 'mobile', name: 'Mobile', path: '/phone' },
          { id: 'private', name: 'Secret' },
        ],
      },
      tasks: [{ id: 'member', cwd: '/phone/App' }],
      items: [
        {
          ...row('a', 'Fix Search', '21'),
          projectId: 'alpha',
          sessionIds: ['member'],
          board: { group: 'attention', postId: `pst_${'a'.repeat(22)}` },
        },
        { ...row('b', 'Search copy', '20'), projectId: 'default', board: { group: 'todo' } },
        { ...row('c', 'Missing member', '19'), sessionIds: ['not-listed'], board: { group: 'running' } },
        { ...row('d', 'Private search', '18'), private: true, projectId: 'private', board: { group: 'done' } },
      ],
    }
    const { results } = await invoke({
      operation: 'phoneWorkItems',
      snapshot,
      listFilters: [
        { projects: ['mobile'], query: '  search ' },
        { projects: ['alpha', null] },
        { projects: [null] },
        { offline: true, projects: ['mobile'] },
        { privateAllowed: true, projects: ['private'] },
        { projects: ['private'] },
      ],
    })
    const choices = ['Alpha', 'Mobile', '无项目']
    expect(results).toEqual([
      { choices, titles: ['Fix Search'], groups: ['attention'] },
      { choices, titles: ['Fix Search', 'Search copy'], groups: ['attention', 'todo'] },
      { choices, titles: ['Search copy'], groups: ['todo'] },
      { choices, titles: ['Fix Search'], groups: ['unknown'] },
      { choices: ['Alpha', 'Mobile', 'Secret', '无项目'], titles: ['Private search'], groups: ['done'] },
      { choices, titles: ['Fix Search', 'Search copy', 'Missing member'], groups: ['attention', 'todo', 'running'] },
    ])
  })
  it('presents reported work-item facts and withdraws private card text and discussion reasons with the body window', async () => {
    const item = `itm_${'a'.repeat(22)}`
    const secret = `itm_${'b'.repeat(22)}`
    const legacy = `itm_${'c'.repeat(22)}`
    const updatedAt = '2026-11-18T00:00:00Z'
    const later = '2026-11-19T00:00:00Z'
    const base = { id: item, title: '修改输入栏', revision: 1, updatedAt, sessionIds: ['missing', 'visible'] }
    const { open, closed } = await invoke({
      operation: 'phoneWorkItems',
      listRows: true,
      snapshot: {
        catalog: { features: { workItems: true, workItemTurns: true }, workspaces: [{ id: 'mobile', name: '移动端' }] },
        tasks: [
          { id: 'visible', workspaceId: 'mobile', updatedAt: later },
          { id: 'unrelated', workspaceId: 'mobile', updatedAt: '2026-11-20T00:00:00Z' },
        ],
        items: [
          {
            ...base,
            board: { group: 'attention', reason: 'question', postId: `pst_${'b'.repeat(22)}` },
            priority: 'high',
            note: '先核对软键盘',
            tags: ['iOS', '界面', '', 'iOS', 'x'.repeat(25), '可验收'],
          },
          { ...base, id: secret, private: true, board: { group: 'deliver', reason: 'settled' }, priority: 'low' },
          { ...base, id: legacy, sessionIds: [], board: { group: 'deliver' } },
        ],
      },
    })
    const expected = { project: '移动端', updatedAt: Date.parse(later) / 1000, sessions: 2 }
    expect(open).toEqual({
      [item]: {
        ...expected,
        priority: '高优先级',
        note: '先核对软键盘',
        tags: ['iOS', '界面', '可验收'],
        reason: 'question',
      },
      [secret]: expect.objectContaining({ priority: '低优先级', reason: 'settled' }),
      [legacy]: {
        updatedAt: Date.parse(updatedAt) / 1000,
        project: '',
        sessions: 0,
        priority: '',
        note: '',
        tags: [],
        reason: '',
      },
    })
    expect(closed).toMatchObject({ [item]: { ...expected, priority: '', note: '', tags: [], reason: '' } })
    expect(closed).not.toHaveProperty(secret)
  })

  it('keeps native work-item reads within the window, exact turn, decision and commit', async () => {
    const at = '2026-11-18T12:00:00.000Z'
    const sessionId = 'session-code'
    const itemId = `itm_${'a'.repeat(22)}`
    const privateId = `itm_${'b'.repeat(22)}`
    const postId = `pst_${'c'.repeat(22)}`
    const sha = 'a'.repeat(40)
    const messageId = 'reply-selected'
    const userMessageId = 'user-selected'
    const olderMessage = 'user-older'
    const runId = 'run-current'
    const job = '123'
    const item = {
      id: itemId,
      title: '复核手机分屏',
      updatedAt: at,
      note: '只在窗口显示的备注',
      revision: 3,
      threadRevision: 2,
      sessionIds: [sessionId],
      board: { group: 'attention', reason: 'question', postId },
    }
    const privateItem = { ...item, id: privateId, title: '私有待办', private: true }
    const turn = { sessionId, userMessageId, runId }
    const post = {
      id: postId,
      at,
      text: '核对这轮改动',
      delivery: { sessionId, state: 'sent' },
      turn,
      attention: { reason: 'question', decisionId: 'question-selected' },
      reply: { messageId, text: '本轮回复', more: true },
    }
    const detail = {
      summary: { id: sessionId, runId, status: 'waiting-approval', pendingQuestions: 2 },
      messages: [
        { id: olderMessage, role: 'user' },
        { id: 'reply-older', role: 'assistant' },
        { id: userMessageId, role: 'user' },
        { id: 'user-steered', role: 'user', steered: true },
        { id: messageId, role: 'assistant' },
      ],
      questions: [
        { id: 'question-unrelated', state: 'pending' },
        { id: 'question-selected', state: 'pending' },
      ],
    }
    const pr = {
      number: 42,
      title: '修复分屏',
      state: 'open',
      url: 'https://example.invalid/acme/latch/pull/42',
      draft: false,
    }
    const check = { name: 'iPad screenshots', state: 'fail', job }
    const evidence = (headSha?: string) => ({
      entries: [{ sessionId, observedAt: at, state: { head: sha }, pr: { pr: { ...pr, headSha }, checks: [check] } }],
    })
    const result = await invoke({
      operation: 'phoneWorkItems',
      snapshot: {
        catalog: { features: { workItems: true, workItemTurns: true } },
        device: { status: 'active', scopes: ['view'], dataScope: 'files' },
        items: [item, privateItem],
        tasks: [{ id: sessionId, itemId: privateId }],
        workProposals: [{ id: 'private-origin' }],
      },
      privateDetail: { ...privateItem, prompt: '只向有权设备显示' },
      post,
      detail,
      approvalPost: { ...post, attention: { reason: 'approval', decisionId: 'approval-selected' } },
      approvalDetail: {
        ...detail,
        approvals: [
          { id: 'approval-unrelated', sessionId },
          { id: 'approval-selected', sessionId },
        ],
      },
      page: { posts: [post], before: postId, revision: 2 },
      olderPostId: 'pst_' + 'd'.repeat(22),
      reply: { turn, messageId, text: '🧪'.repeat(16_000), nextOffset: 16_000 },
      olderMessage,
      evidence: evidence('b'.repeat(40)),
      equalEvidence: evidence(sha),
      unboundEvidence: { entries: [{ sessionId, observedAt: at, state: { head: sha }, pr: { checks: [] } }] },
      missingSHAEvidence: evidence(),
      discussion: {
        discussion: [
          { author: 'qa', body: '宽'.repeat(3000) },
          { author: 'qa', body: '宽'.repeat(8193) },
        ],
      },
      sha,
      job,
      commit: { sha, files: [{ path: 'src/PhoneNativeReview.swift', status: 'M' }] },
    })
    expect(result).toEqual({
      window: {
        oldHostDisabled: true,
        publicCount: 1,
        openCount: 2,
        closedCount: 1,
        referenceWithdrawn: true,
        postWithdrawn: true,
        noteWithdrawn: true,
        proposalWithdrawn: true,
        oldSnapshotRejected: true,
        privateReadDenied: true,
        invalidRouteRejected: true,
        files: true,
        offlineWithdrawn: true,
        expiredWithdrawn: true,
        sameNetworkNewConnection: true,
      },
      source: {
        startsReadable: true,
        completeMissing: 'unavailable',
        partialMissing: 'unconfirmed',
        withdrawn: true,
        humanPostPreserved: true,
        stillWithdrawnAfterSourceReturns: true,
        keepsEarlierWhileOmitted: true,
        olderCursorRestored: true,
        turn: userMessageId,
        decision: 'question-selected',
        approval: 'approval-selected',
        legacyTurn: userMessageId,
        legacyCannotAnswer: true,
        oldRunRejected: true,
        answeredRejected: true,
        wrongMessageRejected: true,
        pageBefore: postId,
        pageLimit: true,
        offset: 16_000,
        replyMismatch: true,
        replyWrongTurn: true,
        replyWrongOffset: true,
        replyQuery: `/link/api/work/items/${itemId}/posts/${postId}/reply?messageId=%E5%9B%9E%E5%A4%8D%26offset%3D2&offset=16000`,
        routeRejected: true,
        shaRejected: true,
      },
      evidence: {
        deliveryRead: 'POST',
        deliveryIds: [sessionId],
        different: true,
        same: true,
        unbound: true,
        missingSHA: true,
        commentsPreserved: [3000],
        commentLimitApplied: true,
        matchedCheck: 'iPad screenshots',
        wrongCheckRejected: true,
        commitFiles: 1,
        wrongCommitRejected: true,
      },
      reviewWidths: [true, true, true, true],
    })
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
    expect(handoffs.quoted).toBe('先看这个\n\n交回结果：\n> 结论一\n>\n> 结论二\n\n')
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
      destinationCases: [
        {},
        { workComputer: { hostId: 'a'.repeat(52), agentId: daily } },
        { workComputer: { hostId: 'a'.repeat(8), agentId: daily } },
        { workComputer: { hostId: 'a'.repeat(52), agentId: 'general' } },
        { workComputer: null },
      ],
      registrations: [
        ['a'.repeat(52), 'b'.repeat(52)],
        ['a'.repeat(51) + 'b', 'b'.repeat(52)],
        ['a'.repeat(52), 'a'.repeat(52)],
      ].map(([registered, source]) => ({ registered, source, agent: { workComputer: { hostId: 'a'.repeat(52), agentId: daily } } })),
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
    expect(result.destinations).toEqual([
      { route: ['local'], canStart: true },
      { route: ['a'.repeat(52), daily], canStart: false },
      { route: ['invalid'], canStart: false },
      { route: ['invalid'], canStart: false },
      { route: ['invalid'], canStart: false },
    ])
    expect(result.matchedAgents).toEqual([daily, '', ''])
    expect(result.entries).toEqual([
      {
        id: 'general',
        name: '通用',
        general: true,
        duty: '未指定 Agent 时使用',
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
