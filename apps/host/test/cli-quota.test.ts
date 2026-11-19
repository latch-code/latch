// DeepSeek Harness's DeepSeek balance, read by the Host with that CLI's own key (src/cli-quota.ts; docs/HARNESSES.md#额度).
// Every key below is fake; every home is a temporary directory; the vendor is a local server behind a fetch that checks
// the request was meant for DeepSeek's fixed origin.
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, HarnessQuota } from '@latch/protocol'
import { FAKE_ACP_AGENT } from '@latch/testkit'
import { balanceReport, deepSeekKeyOf, fetchDeepSeekBalance, readDshKey } from '../src/cli-quota.ts'
import type { FetchLike } from '../src/egress.ts'
import { startTestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const KEY = `sk-${'a1b2c3d4'.repeat(4)}`
const uid = process.getuid!()
const credentials = (key = KEY) => `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${key}\n`

async function temp(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

/** A home with `~/.dsh/.credentials.yaml` (0600) and the given other files under it. */
async function home(files: Record<string, string> = {}, key = credentials()): Promise<string> {
  const root = await temp('latch-cli-quota-home-')
  await mkdir(join(root, '.dsh', 'profiles', 'acp'), { recursive: true })
  await writeFile(join(root, '.dsh', '.credentials.yaml'), key, { mode: 0o600 })
  for (const [path, text] of Object.entries(files)) await writeFile(join(root, path), text)
  return root
}

describe('the credentials document', () => {
  it('yields only a DeepSeek key under `refs`, in the layout DeepSeek Harness writes', () => {
    expect(deepSeekKeyOf(credentials())).toBe(KEY)
    expect(deepSeekKeyOf(`# saved by the Models page\nversion: 1\nrefs:\n  OTHER: x\n  DEEPSEEK_API_KEY: "${KEY}"\n`)).toBe(KEY)
    expect(deepSeekKeyOf(`version: 1\nrecords:\n  a/b:\n    kind: api-key\nrefs:\n  DEEPSEEK_API_KEY: '${KEY}'\n`)).toBe(KEY)
  })

  it.each([
    ['no version', `refs:\n  DEEPSEEK_API_KEY: ${KEY}\n`],
    ['the flat pre-release layout', `DEEPSEEK_API_KEY: ${KEY}\n`],
    ['a key outside refs', `version: 1\nother:\n  DEEPSEEK_API_KEY: ${KEY}\n`],
    ['a base URL beside the key', `${credentials()}  DEEPSEEK_BASE_URL: https://elsewhere.example\n`],
    ['a value that is not a DeepSeek key', credentials('!security find-generic-password -ws deepseek')],
    ['a block scalar', `version: 1\nrefs:\n  DEEPSEEK_API_KEY: |\n    ${KEY}\n`],
    ['a repeated name', `${credentials()}  DEEPSEEK_API_KEY: ${KEY}\n`],
  ])('yields nothing for %s', (_case, text) => {
    expect(deepSeekKeyOf(text)).toBeUndefined()
  })
})

describe('reading the key from a home', () => {
  const official = async () => 'official' as const
  const read = async (root: string, env: Record<string, string> = {}, cwd?: string) =>
    readDshKey({ home: root, env, cwd: cwd ?? (await temp('latch-cli-quota-cwd-')), uid, config: official })

  it('reads the fixed file of a home that sends nothing elsewhere', async () => {
    expect(await read(await home())).toEqual({ key: KEY })
  })

  it.each([
    ['DSH_HOME moves the home', {}, { DSH_HOME: '/elsewhere' }],
    ['DEEPSEEK_BASE_URL is in the environment', {}, { DEEPSEEK_BASE_URL: 'https://elsewhere.example' }],
    ['the home .env sets DEEPSEEK_BASE_URL', { '.dsh/.env': 'DEEPSEEK_BASE_URL=https://x\n' }, {}],
    ['the acp profile’s .env sets DEEPSEEK_BASE_URL', { '.dsh/profiles/acp/.env': 'DEEPSEEK_BASE_URL=https://x\n' }, {}],
  ])('reads nothing when %s', async (_case, files, env) => {
    expect(await read(await home(files), env)).toBe('none')
  })

  it("reads nothing when DeepSeek Harness's own composition says a plugin of the key is not as shipped, and asks it last", async () => {
    let asked = 0
    const changed = async () => {
      asked++
      return 'changed' as const
    }
    expect(await readDshKey({ home: await home(), env: {}, uid, config: changed })).toBe('none')
    expect(asked).toBe(1)
    // A setting it already refuses for is never sent to DeepSeek Harness to judge.
    expect(await readDshKey({ home: await home(), env: { DSH_HOME: '/elsewhere' }, uid, config: changed })).toBe('none')
    expect(asked).toBe(1)
  })

  it('skips a session folder whose .env points DeepSeek elsewhere, or is a link, without judging the home', async () => {
    const root = await home()
    const cwd = await temp('latch-cli-quota-project-')
    await writeFile(join(cwd, '.env'), 'DEEPSEEK_BASE_URL=https://x\n')
    expect(await read(root, {}, cwd)).toBe('skip')
    const linked = await temp('latch-cli-quota-project-')
    await symlink(join(cwd, '.env'), join(linked, '.env'))
    expect(await read(root, {}, linked)).toBe('skip')
    const quiet = await temp('latch-cli-quota-project-')
    await writeFile(join(quiet, '.env'), 'OTHER=1\n')
    expect(await read(root, {}, quiet)).toEqual({ key: KEY })
  })

  it('checks no folder when there is no session, and every setting of the home still', async () => {
    expect(await readDshKey({ home: await home(), env: {}, uid, config: official })).toEqual({ key: KEY })
    expect(await readDshKey({ home: await home({ '.dsh/.env': 'DEEPSEEK_BASE_URL=https://x\n' }), env: {}, uid, config: official })).toBe(
      'none',
    )
    expect(await readDshKey({ home: await home(), env: { DSH_HOME: '/elsewhere' }, uid, config: official })).toBe('none')
  })

  it('reads nothing from a file others can read, a link, a link to the home, another owner’s files, or no file', async () => {
    const loose = await home()
    await chmod(join(loose, '.dsh', '.credentials.yaml'), 0o644)
    expect(await read(loose)).toBe('none')

    const outside = await temp('latch-cli-quota-outside-')
    await writeFile(join(outside, 'creds.yaml'), credentials(), { mode: 0o600 })
    const linkedFile = await home()
    await rm(join(linkedFile, '.dsh', '.credentials.yaml'))
    await symlink(join(outside, 'creds.yaml'), join(linkedFile, '.dsh', '.credentials.yaml'))
    expect(await read(linkedFile)).toBe('none')

    const linkedHome = await temp('latch-cli-quota-home-')
    await symlink(join(await home(), '.dsh'), join(linkedHome, '.dsh'))
    expect(await read(linkedHome)).toBe('none')

    expect(await readDshKey({ home: await home(), env: {}, cwd: outside, uid: uid + 1, config: official })).toBe('none')

    const empty = await temp('latch-cli-quota-home-')
    expect(await read(empty)).toBe('none')
  })
})

describe('asking DeepSeek', () => {
  const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })

  it('sends the key only in the header of a GET to the fixed balance URL, and follows no redirect', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = []
    const fetch: FetchLike = async (url, init) => {
      seen.push({ url, init })
      return answer(200, { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '110.00' }] })
    }
    expect(await fetchDeepSeekBalance(KEY, fetch, AbortSignal.timeout(1000))).toEqual({
      windows: [],
      whole: true,
      balanceCents: 11_000,
      currency: 'CNY',
      limited: false,
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe('https://api.deepseek.com/user/balance')
    expect(seen[0]!.init).toMatchObject({ method: 'GET', redirect: 'manual', headers: { authorization: `Bearer ${KEY}` } })
  })

  it('stops reading an answer past 16 KiB and takes it as nothing to report', async () => {
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(4096).fill(32))
      },
    })
    const fetch: FetchLike = async () => new Response(endless, { status: 200 })
    expect(await fetchDeepSeekBalance(KEY, fetch, AbortSignal.timeout(1000))).toBeNull()
    expect(pulled).toBeLessThan(10)
  })

  it('takes a refusal as nothing to report, and anything unfinished as no answer', async () => {
    const once =
      (response: Response | Error): FetchLike =>
      async () => {
        if (response instanceof Error) throw response
        return response
      }
    const signal = AbortSignal.timeout(1000)
    expect(await fetchDeepSeekBalance(KEY, once(answer(401, { error: 'no' })), signal)).toBeNull()
    expect(await fetchDeepSeekBalance(KEY, once(answer(403, {})), signal)).toBeNull()
    expect(await fetchDeepSeekBalance(KEY, once(answer(200, 'not json')), signal)).toBeNull()
    expect(await fetchDeepSeekBalance(KEY, once(answer(302, '', { location: 'https://elsewhere.example/' })), signal)).toBeUndefined()
    expect(await fetchDeepSeekBalance(KEY, once(answer(503, {})), signal)).toBeUndefined()
    expect(await fetchDeepSeekBalance(KEY, once(new TypeError(`fetch failed for ${KEY}`)), signal)).toBeUndefined()
  })

  it('reads the balance with money in it, and an account DeepSeek says cannot be used as at its limit', () => {
    expect(
      balanceReport({
        is_available: false,
        balance_infos: [
          { currency: 'USD', total_balance: '0.00' },
          { currency: 'CNY', total_balance: '3.456', granted_balance: '0', topped_up_balance: '3.456' },
        ],
      }),
    ).toMatchObject({ balanceCents: 346, currency: 'CNY', limited: true })
    expect(balanceReport({ is_available: true, balance_infos: [{ currency: 'EUR', total_balance: '1' }] })).toBeUndefined()
  })
})

/** A local stand-in for DeepSeek, reached only through a fetch that insists on DeepSeek's own URL. */
async function fakeDeepSeek(reply: () => { status: number; body: unknown }) {
  const requests: Array<{ authorization: string | undefined }> = []
  const server = createServer((request: IncomingMessage, response) => {
    requests.push({ authorization: request.headers.authorization })
    const { status, body } = reply()
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const port = (server.address() as { port: number }).port
  const urls: string[] = []
  const fetch: FetchLike = async (url, init) => {
    urls.push(url)
    if (url !== 'https://api.deepseek.com/user/balance') throw new Error('not DeepSeek')
    return globalThis.fetch(`http://127.0.0.1:${port}/user/balance`, init)
  }
  return { requests, urls, fetch }
}

/** Every file below `directory`, read whole. */
async function everything(directory: string): Promise<string> {
  let text = ''
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true }))
    if (entry.isFile()) text += await readFile(join(entry.parentPath, entry.name), 'utf8').catch(() => '')
  return text
}

it('shows DeepSeek Harness’s balance after a turn, once in five minutes, on record and nowhere with its key; a refusal takes it away', async () => {
  const root = await temp('latch-cli-quota-host-')
  const bin = join(root, 'bin')
  await mkdir(bin)
  await writeFile(
    join(bin, 'dsh'),
    `#!/bin/sh\nif [ "$1" = --version ]; then echo 0.2.2-rc.1; exit 0; fi\nexport FAKE_ACP_PROCESS_MODE=1 FAKE_ACP_CONFIG=options FAKE_ACP_MODES=read-only,workspace-write,danger-full-access FAKE_ACP_INITIAL_MODE=read-only\nexec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"\n`,
  )
  await chmod(join(bin, 'dsh'), 0o755)
  const person = await home()
  let status = 200
  const vendor = await fakeDeepSeek(() =>
    status === 200
      ? { status, body: { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '110.00' }] } }
      : { status, body: { error: { message: 'Authentication Fails' } } },
  )
  const lines: string[] = []
  const dataDir = join(root, 'data')
  const options = {
    demo: false,
    dataDir,
    workspaceRoot: join(root, 'project'),
    log: (line: string) => void lines.push(line),
    commandDirectories: () => [bin],
    loginPrograms: (name: string) => (name === 'dsh' ? join(bin, 'dsh') : undefined),
    detectPreset: (preset: { id: string }) => (preset.id === 'dsh' ? { found: true, path: join(bin, 'dsh') } : { found: false }),
    cliQuota: { home: person, fetch: vendor.fetch },
  }
  let t = await startTestHost(options)
  let closed = false
  cleanups.push(() => (closed ? undefined : t.close()))
  let owner = await t.enroll({ listener: 'unix' })
  await owner.confirmedJson('agents', {
    body: { id: 'dsh', name: 'DeepSeek Harness', presetId: 'dsh', command: 'dsh', args: ['--profile', 'acp'], env: {} },
  })
  const harness = async () => (await owner.json<AppSnapshot>('snapshot')).catalog?.harnesses.find(item => item.id === 'dsh')
  const quotaOf = async (): Promise<HarnessQuota | undefined> => (await harness())?.quota
  expect((await harness())?.capabilities.models.quota).toBe(true)
  expect(await quotaOf()).toBeUndefined()
  // Everything the device hears from here on.
  const listening = new AbortController()
  const stream = await owner.request('events', { signal: listening.signal })
  let heard = ''
  const reader = stream.body!.getReader()
  const decoder = new TextDecoder()
  const reading = (async () => {
    for (;;) {
      const next = await reader.read()
      if (next.done) return
      heard += decoder.decode(next.value, { stream: true })
    }
  })().catch(() => {})
  // Opening a session reads nothing; the end of its turn does.
  const { sessionId } = await owner.confirmedJson<{ sessionId: string }>('tasks', {
    body: { prompt: 'echo hi', requestId: randomUUID(), harnessId: 'dsh' },
  })
  await vi.waitFor(async () => expect(await quotaOf()).toBeDefined(), { timeout: 8_000, interval: 20 })
  expect(await quotaOf()).toEqual({ windows: [], balanceCents: 11_000, currency: 'CNY', state: 'ok', observedAt: expect.any(String) })
  expect(vendor.urls).toEqual(['https://api.deepseek.com/user/balance'])
  expect(vendor.requests).toEqual([{ authorization: `Bearer ${KEY}` }])

  // A second turn within five minutes asks nothing.
  await owner.json(`tasks/${sessionId}/prompt`, { method: 'POST', body: { prompt: 'echo again', requestId: randomUUID() } })
  await vi.waitFor(async () => {
    const messages = (await owner.json<{ messages: Array<{ role: string }> }>(`tasks/${sessionId}`)).messages
    expect(messages.filter(message => message.role === 'assistant').length).toBeGreaterThanOrEqual(2)
  })
  expect(vendor.requests).toHaveLength(1)

  // On record: which Harness, and nothing of the key, the balance or the account.
  const audit = await everything(join(dataDir, 'audit'))
  expect(audit).toContain('"agent.quota.read"')
  expect(audit).toContain('"presetId":"dsh"')
  await vi.waitFor(() => expect(heard.length).toBeGreaterThan(0))
  listening.abort()
  await reading
  expect(heard).not.toContain(KEY)
  const sent = JSON.stringify(await owner.json<AppSnapshot>('snapshot'))
  const kept = `${await everything(dataDir)}\n${lines.join('\n')}`
  for (const text of [sent, kept]) expect(text).not.toContain(KEY)
  expect(lines.join('\n')).not.toContain('11000')

  // Kept with the Harness's sessions: after a restart the last balance and its time are there before any new read.
  const before = await quotaOf()
  await t.close()
  closed = true
  t = await startTestHost(options)
  closed = false
  owner = await t.enroll({ listener: 'unix' })
  expect(await quotaOf()).toEqual(before)
  expect(vendor.requests).toHaveLength(1)

  // A session in a folder whose .env could send the key elsewhere asks nothing and leaves the balance shown.
  await writeFile(join(root, 'project', '.env'), 'DEEPSEEK_BASE_URL=https://elsewhere.example\n')
  const skipped = await owner.confirmedJson<{ sessionId: string }>('tasks', {
    body: { prompt: 'echo in a redirecting folder', requestId: randomUUID(), harnessId: 'dsh' },
  })
  await vi.waitFor(async () =>
    expect((await owner.json<{ summary: { status: string } }>(`tasks/${skipped.sessionId}`)).summary.status).toBe('idle'),
  )
  await new Promise(resolve => setTimeout(resolve, 200))
  expect(vendor.requests).toHaveLength(1)
  expect(await quotaOf()).toEqual(before)
  await rm(join(root, 'project', '.env'))
  await t.close()
  closed = true
  t = await startTestHost(options)
  closed = false
  owner = await t.enroll({ listener: 'unix' })

  // A refused key ends in nothing shown, and is not asked again within the floor.
  status = 401
  const next = await owner.confirmedJson<{ sessionId: string }>('tasks', {
    body: { prompt: 'echo once more', requestId: randomUUID(), harnessId: 'dsh' },
  })
  await vi.waitFor(async () => expect(await quotaOf()).toBeUndefined(), { timeout: 8_000, interval: 20 })
  expect(vendor.requests).toHaveLength(2)
  expect(next.sessionId).toBeTruthy()
  expect(`${await everything(dataDir)}\n${lines.join('\n')}`).not.toContain(KEY)
})

it('reads no key for a DeepSeek Harness definition that is not the preset’s own command, nor in a Host not given a home', async () => {
  const root = await temp('latch-cli-quota-custom-')
  const bin = join(root, 'bin')
  await mkdir(bin)
  await writeFile(
    join(bin, 'dsh'),
    `#!/bin/sh\nif [ "$1" = --version ]; then echo 0.2.2-rc.1; exit 0; fi\nexport FAKE_ACP_PROCESS_MODE=1 FAKE_ACP_CONFIG=options FAKE_ACP_MODES=read-only,workspace-write,danger-full-access FAKE_ACP_INITIAL_MODE=read-only\nexec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"\n`,
  )
  await chmod(join(bin, 'dsh'), 0o755)
  const vendor = await fakeDeepSeek(() => ({ status: 200, body: { is_available: true, balance_infos: [] } }))
  for (const variant of ['variable', 'no home'] as const) {
    const t = await startTestHost({
      demo: false,
      commandDirectories: () => [bin],
      loginPrograms: (name: string) => (name === 'dsh' ? join(bin, 'dsh') : undefined),
      detectPreset: (preset: { id: string }) => (preset.id === 'dsh' ? { found: true, path: join(bin, 'dsh') } : { found: false }),
      ...(variant === 'no home' ? {} : { cliQuota: { home: await home(), fetch: vendor.fetch } }),
    })
    try {
      const owner = await t.enroll({ listener: 'unix' })
      await owner.confirmedJson('agents', {
        body: {
          id: 'dsh',
          name: 'DeepSeek Harness',
          presetId: 'dsh',
          command: 'dsh',
          args: ['--profile', 'acp'],
          env: variant === 'variable' ? { DSH_TELEMETRY_DISABLED: '1' } : {},
        },
      })
      const harness = async () => (await owner.json<AppSnapshot>('snapshot')).catalog?.harnesses.find(item => item.id === 'dsh')
      expect((await harness())?.capabilities.models.quota).toBeUndefined()
      const { sessionId } = await owner.confirmedJson<{ sessionId: string }>('tasks', {
        body: { prompt: 'echo hi', requestId: randomUUID(), harnessId: 'dsh' },
      })
      await vi.waitFor(async () =>
        expect((await owner.json<{ summary: { status: string } }>(`tasks/${sessionId}`)).summary.status).toBe('idle'),
      )
      expect((await harness())?.quota).toBeUndefined()
    } finally {
      await t.close()
    }
  }
  expect(vendor.requests).toHaveLength(0)
})

it('reads DeepSeek Harness’s balance when someone looks, with no session and no turn, on record before the key leaves', async () => {
  const root = await temp('latch-cli-quota-look-')
  const bin = join(root, 'bin')
  await mkdir(bin)
  const log = join(root, 'agent.jsonl')
  await writeFile(
    join(bin, 'dsh'),
    `#!/bin/sh\nif [ "$1" = --version ]; then echo 0.2.2-rc.1; exit 0; fi\nexport FAKE_ACP_LOG='${log}' FAKE_ACP_PROCESS_MODE=1 FAKE_ACP_CONFIG=options FAKE_ACP_MODES=read-only,workspace-write,danger-full-access FAKE_ACP_INITIAL_MODE=read-only\nexec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"\n`,
  )
  await chmod(join(bin, 'dsh'), 0o755)
  const vendor = await fakeDeepSeek(() => ({
    status: 200,
    body: { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '3.50' }] },
  }))
  const t = await startTestHost({
    demo: false,
    commandDirectories: () => [bin],
    loginPrograms: (name: string) => (name === 'dsh' ? join(bin, 'dsh') : undefined),
    detectPreset: (preset: { id: string }) => (preset.id === 'dsh' ? { found: true, path: join(bin, 'dsh') } : { found: false }),
    cliQuota: { home: await home(), fetch: vendor.fetch },
  })
  cleanups.push(() => t.close())
  const owner = await t.enroll({ listener: 'unix' })
  await owner.confirmedJson('agents', {
    body: { id: 'dsh', name: 'DeepSeek Harness', presetId: 'dsh', command: 'dsh', args: ['--profile', 'acp'], env: {} },
  })
  const actions: string[] = []
  const append = t.host.security.audit.append.bind(t.host.security.audit)
  vi.spyOn(t.host.security.audit, 'append').mockImplementation(event => {
    actions.push(event.action)
    return append(event)
  })
  const quotaOf = async () => (await owner.json<AppSnapshot>('snapshot')).catalog?.harnesses.find(item => item.id === 'dsh')?.quota
  expect(await owner.json('quota/refresh', { method: 'POST', body: {} })).toEqual({ asked: ['dsh'] })
  await vi.waitFor(async () => expect(await quotaOf()).toMatchObject({ balanceCents: 350, currency: 'USD' }), {
    timeout: 8_000,
    interval: 20,
  })
  expect(actions).toEqual(['agent.quota.requested', 'agent.quota.read'])
  expect(vendor.requests).toEqual([{ authorization: `Bearer ${KEY}` }])
  // No DeepSeek Harness process ran for it.
  expect(await readFile(log, 'utf8').catch(() => '')).toBe('')
  // Even 重试 waits out the five minutes for the vendor.
  await owner.json('quota/refresh', { method: 'POST', body: { ids: ['dsh'], retry: true } })
  await new Promise(resolve => setTimeout(resolve, 200))
  expect(vendor.requests).toHaveLength(1)
})
