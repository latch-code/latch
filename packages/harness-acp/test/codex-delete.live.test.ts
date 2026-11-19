// The installed Codex (`LATCH_CODEX_GATEWAY_BINARY`) in a temporary CODEX_HOME, with no login and no turn: a thread is
// opened on Latch's provider (which starts no model call), deleted through the wire, and must be gone from Codex's own
// record, its pictures with it. Only booleans and counts are printed.
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { codexProfile } from '../src/profiles/codex.ts'
import { CodexWire } from '../src/wires/codex.ts'

const binary = process.env.LATCH_CODEX_GATEWAY_BINARY
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A Codex of its own: an empty home (and HOME), on Latch's provider at an address nothing listens on. */
async function realCodex(config = '') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-codex-delete-live-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'codex-home')
  const project = join(root, 'project')
  await mkdir(home)
  await mkdir(project)
  if (config) await writeFile(join(home, 'config.toml'), config)
  const place = { baseURL: 'http://127.0.0.1:9/v1', models: [{ id: 'latch-live-model' }], file: (name: string) => join(root, name) }
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
  return { wire, home, project, notes }
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
