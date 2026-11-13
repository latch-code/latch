import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppSnapshot, CatalogueRead, HarnessInfo } from '@latch/protocol'
import { FAKE_CODEX_APP_SERVER } from '@latch/testkit'
import { startTestHost, type TestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function folder(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'latch-catalogue-')))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  return path
}

/** Codex direct on the fake app-server, saved and confirmed on this Mac; `models` names what each model/list offers. */
async function codexHost(env: Record<string, string> = {}, on: { root?: string; dataDir?: string; save?: boolean } = {}) {
  const root = on.root ?? (await folder())
  const logFile = join(root, 'codex.log')
  const models = join(root, 'models')
  await mkdir(join(root, 'bin'), { recursive: true })
  const exports = Object.entries({ FAKE_ACP_LOG: logFile, FAKE_ACP_MODELS_FILE: models, ...env })
    .map(([name, value]) => `export ${name}='${value}'`)
    .join('\n')
  const command = join(root, 'bin', 'codex')
  await writeFile(command, `#!/bin/sh\n${exports}\nexec '${process.execPath}' '${FAKE_CODEX_APP_SERVER}' "$@"\n`)
  await chmod(command, 0o755)
  const options = { demo: false, ...(on.dataDir ? { dataDir: on.dataDir } : {}) }
  const t = await startTestHost(options)
  let open = true
  cleanups.push(async () => {
    if (open) await t.close()
  })
  const desktop = await t.enroll({ listener: 'unix' })
  if (on.save !== false)
    await desktop.confirmedJson('agents', { body: { id: 'codex', name: 'Codex', presetId: 'codex', command, args: [], env: {} } })
  // Another device that may start sessions: it reads as the desktop app does.
  const phone = await t.enroll({ scopes: ['view', 'run'] })
  const lines = async () =>
    (await readFile(logFile, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as { event: string; method?: string })
  const starts = async () => (await lines()).filter(line => line.event === 'start').length
  const harness = async () => (await phone.json<AppSnapshot>('snapshot')).catalog!.harnesses.find(item => item.id === 'codex')!
  const read = (auto: boolean) =>
    phone.json<{ ran: boolean; catalogueRead?: CatalogueRead }>('agents/codex/catalogue', { method: 'POST', body: { auto } })
  const close = async () => {
    open = false
    await t.close()
  }
  return { t, root, phone, desktop, starts, lines, harness, read, models, close }
}

const listed = (harness: HarnessInfo) =>
  harness.catalogue?.options.find(option => option.category === 'model')?.options.map(item => item.value)

async function audit(t: TestHost): Promise<Array<{ action: string; detail: Record<string, unknown> }>> {
  return (await readFile(join(t.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
}

describe("reading Codex's own model list before a session", () => {
  it('reads it by selection once per definition, with model/list and no thread, and keeps it', async () => {
    const { t, starts, lines, harness, read } = await codexHost()
    expect((await harness()).catalogueRead).toEqual({ when: 'select', modes: false })
    expect(await starts()).toBe(0)

    expect(await read(true)).toMatchObject({ ran: true, catalogueRead: { last: { ok: true } } })
    const known = await harness()
    expect(listed(known)).toEqual(['gpt-fake', 'gpt-fake-mini'])
    expect(known.catalogue).toMatchObject({ source: 'check' })
    // The default is the one Codex marks so, and each model carries its own thinking levels.
    expect(known.catalogue!.options.find(option => option.category === 'model')?.currentValue).toBe('gpt-fake')
    expect(known.catalogue!.perModel.map(entry => [entry.model, entry.options[0]!.options.map(item => item.value)])).toEqual([
      ['gpt-fake', ['low', 'medium', 'high']],
      ['gpt-fake-mini', ['low', 'medium']],
    ])
    expect((await lines()).filter(line => line.event === 'recv').map(line => line.method)).toEqual([
      'initialize',
      'config/read',
      'model/list',
    ])

    // Kept: selecting it again, here or on another page, starts nothing.
    expect(await read(true)).toMatchObject({ ran: false })
    expect(await starts()).toBe(1)
    const records = (await audit(t)).filter(record => record.action.startsWith('agent.catalogue.'))
    expect(records.map(record => [record.action, record.detail])).toEqual([
      ['agent.catalogue.requested', { agentId: 'codex', auto: true }],
      ['agent.catalogue.read', { agentId: 'codex', ok: true }],
    ])
  })

  it('reads again when a person refreshes, and replaces the list', async () => {
    const { starts, harness, read, models } = await codexHost()
    await read(true)
    const first = (await harness()).catalogue!.reportedAt
    await writeFile(models, 'gpt-fake-mini')
    expect(await read(false)).toMatchObject({ ran: true })
    const known = await harness()
    expect(listed(known)).toEqual(['gpt-fake-mini'])
    expect(known.catalogue!.options.find(option => option.category === 'model')?.currentValue).toBe('gpt-fake-mini')
    expect(known.catalogue!.reportedAt >= first).toBe(true)
    expect(await starts()).toBe(2)
  })

  it('keeps a failed read with its reason, does not read it again by selection, and reads when asked', async () => {
    const { starts, harness, read } = await codexHost({ FAKE_CODEX_LIST_ERROR: 'login' })
    expect(await read(true)).toMatchObject({ ran: true })
    const failed = await harness()
    expect(failed.catalogue).toBeUndefined()
    expect(failed.catalogueRead?.last).toMatchObject({ ok: false, message: expect.stringContaining('login') })
    expect(await read(true)).toMatchObject({ ran: false })
    expect(await starts()).toBe(1)
    expect(await read(false)).toMatchObject({ ran: true })
    expect(await starts()).toBe(2)
  })

  it('never runs a definition this Mac has not confirmed, by selection or when asked', async () => {
    const dataDir = await folder()
    const saved = await codexHost({}, { dataDir })
    await saved.close()
    // As saved before definitions were bound to the program confirmed on this Mac.
    const file = join(dataDir, 'settings.json')
    const settings = JSON.parse(await readFile(file, 'utf8'))
    for (const agent of settings.agents) delete agent.confirmedCommand
    await writeFile(file, JSON.stringify(settings))
    const { t, starts, read, phone } = await codexHost({}, { root: saved.root, dataDir, save: false })
    expect(await read(true)).toMatchObject({ ran: false })
    const asked = await phone.request('agents/codex/catalogue', { method: 'POST', body: { auto: false } })
    expect(asked.status).toBe(409)
    expect(await asked.json()).toMatchObject({ error: 'harness-unconfirmed' })
    expect(await starts()).toBe(0)
    expect((await audit(t)).filter(record => record.action === 'agent.catalogue.requested')).toEqual([])
  })
})
