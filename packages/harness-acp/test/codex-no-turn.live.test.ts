// The installed Codex (`LATCH_CODEX_GATEWAY_BINARY`) in a temporary CODEX_HOME, with no login and no paid turn: a thread
// is opened on Latch's provider (which starts no model call), deleted through the wire, and must be gone from Codex's own
// record, its pictures with it; a thread with one turn against a local fake model is deleted by a plain process of the
// same home, as a deletion runs once the session's process has ended; a provider of the person's own named as Latch's is
// refused before any thread; the hooks Codex reports are read without their commands. Only booleans and counts are
// printed.
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { codexProfile } from '../src/profiles/codex.ts'
import { CodexWire } from '../src/wires/codex.ts'
import { MCP_STATUS_METHOD } from '../src/protocol.ts'
import { startFakeModels } from '@latch/testkit'

const binary = process.env.LATCH_CODEX_GATEWAY_BINARY
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A Codex of its own: an empty home (and HOME), on Latch's provider at an address nothing listens on. */
async function realCodex(config = '', reuse?: string, baseURL = 'http://127.0.0.1:9/v1') {
  const root = reuse ?? (await realpath(await mkdtemp(join(tmpdir(), 'latch-codex-delete-live-'))))
  if (!reuse) cleanups.push(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'codex-home')
  const project = join(root, 'project')
  await mkdir(home, { recursive: true })
  await mkdir(project, { recursive: true })
  if (config) await writeFile(join(home, 'config.toml'), config)
  const place = { baseURL, models: [{ id: 'latch-live-model' }], file: (name: string) => join(root, name) }
  const gateway = codexProfile.gateway as { deliver(place: unknown, route: unknown, catalog?: string): { args: string[] } }
  const { args } = gateway.deliver(place, { model: 'latch-live-model' }, undefined)
  const env: Record<string, string> = { CODEX_HOME: home, HOME: root, PATH: process.env.PATH ?? '', TMPDIR: root, LMG_TOKEN: 'unused' }
  const notes: Array<{ method: string; params: unknown }> = []
  const wire = CodexWire.spawn(
    { command: binary!, args, cwd: project, env, maxLineBytes: 16 * 1024 * 1024, redact: text => text },
    { request: async () => ({}), notification: (method, params) => void notes.push({ method, params }), exit: () => {} },
    { model: 'latch-live-model', models: ['latch-live-model'], modelCapabilities: {} } as never,
  )
  cleanups.push(async () => void (await wire.stop('kill', 2_000).catch(() => {})))
  await wire.request('initialize', {}, 60_000)
  return { wire, home, project, notes, root }
}

/** The same home's Codex as a deletion runs it: no route, no `-c`, in an empty folder of its own. */
async function plainCodex(root: string) {
  const empty = join(root, 'empty')
  await mkdir(empty, { recursive: true })
  const env: Record<string, string> = { CODEX_HOME: join(root, 'codex-home'), HOME: root, PATH: process.env.PATH ?? '', TMPDIR: root }
  const wire = CodexWire.spawn(
    { command: binary!, args: [], cwd: empty, env, maxLineBytes: 16 * 1024 * 1024, redact: text => text },
    { request: async () => ({}), notification: () => {}, exit: () => {} },
  )
  cleanups.push(async () => void (await wire.stop('kill', 2_000).catch(() => {})))
  await wire.request('initialize', {}, 60_000)
  return wire
}

it.skipIf(!binary)(
  'deletes a thread through thread/delete with its pictures, and Codex reads it no more',
  async () => {
    const { wire, home, project } = await realCodex()
    const opened = (await wire.request('session/new', { cwd: project, mcpServers: [] }, 120_000)) as { sessionId: string }
    const thread = opened.sessionId
    // As its image tool keeps a picture, and something else beside it that is not one.
    const pictures = join(home, 'generated_images', thread)
    await mkdir(pictures, { recursive: true })
    await writeFile(join(pictures, 'ig_live.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    await writeFile(join(pictures, 'notes.txt'), 'kept')
    await wire.request('session/delete', { sessionId: thread }, 30_000)
    const left = await readdir(pictures)
    const kept = await readFile(join(pictures, 'notes.txt'), 'utf8').then(
      () => true,
      () => false,
    )
    console.info(JSON.stringify({ deleted: true, pictureGone: !left.includes('ig_live.png'), otherKept: kept }))
    expect(left).toEqual(['notes.txt'])
    // Deleting again: Codex no longer knows it, which is already done.
    await expect(wire.request('session/delete', { sessionId: thread }, 30_000)).resolves.toEqual({})
  },
  180_000,
)

it.skipIf(!binary)(
  'refuses a gateway session when the person’s own config.toml has a provider by Latch’s name, before any thread',
  async () => {
    const { wire, project, home } = await realCodex('[model_providers.latch]\nname = "mine"\nhttp_headers = { "X-Mine" = "1" }\n')
    const refused = await wire.request('session/new', { cwd: project, mcpServers: [] }, 120_000).then(
      () => undefined,
      (error: Error) => error.message,
    )
    const threads = await readdir(join(home, 'sessions')).then(
      entries => entries.length,
      () => 0,
    )
    console.info(JSON.stringify({ refused: !!refused, named: refused?.includes('[model_providers.latch]') === true, rollouts: threads }))
    expect(refused).toContain('[model_providers.latch]')
    // The person's config.toml is as it was.
    expect(await readFile(join(home, 'config.toml'), 'utf8')).toContain('X-Mine')
  },
  180_000,
)

it.skipIf(!binary)(
  'reads the hooks Codex runs without a thread, with no command, path or key',
  async () => {
    const { wire } = await realCodex()
    const answer = (await wire.request(MCP_STATUS_METHOD, {}, 60_000)) as { hooks?: Array<Record<string, unknown>> }
    const keys = new Set((answer.hooks ?? []).flatMap(hook => Object.keys(hook)))
    console.info(JSON.stringify({ listed: Array.isArray(answer.hooks), hooks: answer.hooks?.length ?? 0, keys: [...keys].sort() }))
    expect(Array.isArray(answer.hooks)).toBe(true)
    for (const key of keys) expect(['event', 'source', 'managed', 'enabled', 'trust']).toContain(key)
  },
  120_000,
)

it.skipIf(!binary)(
  'deletes a gateway session’s thread from a plain process of the same home, as a deletion after the session’s process ended',
  async () => {
    const upstream = await startFakeModels({ replyFor: () => ({ text: 'ok' }) })
    cleanups.push(() => upstream.close())
    const { wire, project, root } = await realCodex('', undefined, `${upstream.origin}/v1`)
    const thread = ((await wire.request('session/new', { cwd: project, mcpServers: [] }, 120_000)) as { sessionId: string }).sessionId
    // One turn, so Codex writes the thread's record: a thread with none is one no other process finds.
    const answered = await wire.request('session/prompt', { sessionId: thread, prompt: [{ type: 'text', text: 'hi' }] }, 120_000)
    expect(answered).toMatchObject({ stopReason: 'end_turn' })
    await wire.stop('stop', 5_000)
    const plain = await plainCodex(root)
    // Codex's own read, as the wire sends it: the plain process finds the thread first, so its deletion is a real one.
    const read = (plain as unknown as { send(method: string, params: unknown, ms: number): Promise<unknown> }).send.bind(plain)
    const before = await read('thread/read', { threadId: thread, includeTurns: false }, 30_000).then(
      () => true,
      () => false,
    )
    const deleted = await plain.request('session/delete', { sessionId: thread }, 30_000).then(
      () => true,
      () => false,
    )
    const after = await read('thread/read', { threadId: thread, includeTurns: false }, 30_000).then(
      () => true,
      () => false,
    )
    console.info(
      JSON.stringify({ turnOnLocalModel: upstream.requests.length > 0, readBefore: before, deletedFromPlain: deleted, readAfter: after }),
    )
    expect(before).toBe(true)
    expect(deleted).toBe(true)
    expect(after).toBe(false)
  },
  180_000,
)
