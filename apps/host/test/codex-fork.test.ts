import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { FAKE_CODEX_APP_SERVER } from '@latch/testkit'
import type { HarnessInfo, TaskDetail } from '@latch/protocol'
import { startTestHost, type TestHost } from './helpers/host.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A Host whose `codex` is the fake app server, every process sharing one thread store. */
async function codexHost(env: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'latch-codex-fork-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const bin = join(root, 'bin'),
    command = join(bin, 'codex'),
    log = join(root, 'codex.log')
  await mkdir(bin)
  await writeFile(command, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_CODEX_APP_SERVER}' "$@"\n`)
  await chmod(command, 0o755)
  const host: TestHost = await startTestHost({
    dataDir: join(root, 'data'),
    workspaceRoot: join(root, 'default'),
    commandDirectories: () => [bin],
    loginPrograms: (name: string) => (name === 'codex' ? command : undefined),
    detectPreset: (preset: { id: string }) => (preset.id === 'codex' ? { found: true, path: command } : { found: false }),
  })
  cleanups.push(() => host.close())
  const owner = await host.enroll({ listener: 'unix' })
  await owner.confirmedJson('agents', {
    body: {
      id: 'codex',
      presetId: 'codex',
      name: 'Codex',
      command: 'codex',
      args: [],
      env: { FAKE_CODEX_STATE: join(root, 'threads.json'), FAKE_ACP_LOG: log, FAKE_CODEX_VERSION: '0.169.0', ...env },
    },
  })
  const detail = (sessionId: string) => owner.json<TaskDetail>(`tasks/${sessionId}`)
  const settled = (sessionId: string) => expect.poll(async () => (await detail(sessionId)).summary.status, { timeout: 15_000 }).toBe('idle')
  const start = async (body: Record<string, unknown>) => {
    const created = await owner.confirmed('tasks', {
      method: 'POST',
      body: { requestId: randomUUID(), harnessId: 'codex', mode: 'agent', workspaceId: 'default', ...body },
    })
    expect(created.status).toBe(201)
    const { sessionId } = (await created.json()) as { sessionId: string }
    await settled(sessionId)
    return sessionId
  }
  const send = async (sessionId: string, prompt: string) => {
    const sent = await owner.request(`tasks/${sessionId}/prompt`, { method: 'POST', body: { requestId: randomUUID(), prompt } })
    expect(sent.status).toBe(200)
    await settled(sessionId)
  }
  const replies = async (sessionId: string) =>
    (await detail(sessionId)).messages.flatMap(item => (item.role === 'assistant' ? [item.text] : []))
  const notes = async (sessionId: string) => (await detail(sessionId)).messages.flatMap(item => (item.role === 'system' ? [item.text] : []))
  /** The last message of turn `turn` (from 1): where 从这里编辑 on the next turn's message forks. */
  const turnEnd = async (sessionId: string, turn: number) => {
    const messages = (await detail(sessionId)).messages
    const starts = messages.flatMap((item, index) => (item.role === 'user' && !item.steered ? [index] : []))
    return messages[(starts[turn] ?? messages.length) - 1]!.id
  }
  const archived = async () =>
    (await readFile(log, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .filter(line => (JSON.parse(line) as { event: string }).event === 'archived').length
  return { owner, start, send, replies, notes, turnEnd, detail, archived }
}

test("a fork of a Codex session into Codex forks Codex's own thread through the turn, by the message that opened it", async () => {
  const h = await codexHost()
  const harnesses = (await h.owner.json<{ catalog: { harnesses: HarnessInfo[] } }>('snapshot')).catalog.harnesses
  expect(harnesses.find(item => item.id === 'codex')?.capabilities.fork).toBe('native')
  const source = await h.start({ prompt: 'alpha' })
  await h.send(source, 'beta')
  await h.send(source, 'gamma')
  // 从这里编辑 on 「gamma」: the fork goes through the second turn, Codex's record of it, and only the new words are sent.
  const edited = await h.start({ prompt: 'recall', forkOf: { taskId: source, upToMessageId: await h.turnEnd(source, 2) } })
  const first = (await h.detail(edited)).messages.find(item => item.role === 'user')
  expect(first).toMatchObject({ nativeFork: true })
  expect(await h.replies(edited)).toEqual(['remembers: alpha | beta'])
  expect(await h.notes(edited)).toEqual([])
  // The source thread is as it was.
  await h.send(source, 'recall')
  expect((await h.replies(source)).at(-1)).toBe('remembers: alpha | beta | gamma')
})

test('a Codex whose turns do not carry the message falls back to the text record, and says why', async () => {
  const h = await codexHost({ FAKE_CODEX_NO_CLIENT_ID: '1' })
  await fallsBack(h)
})

test('a Codex older than the one checked is not sent the mark, and falls back the same way', async () => {
  await fallsBack(await codexHost({ FAKE_CODEX_VERSION: '0.167.0' }))
})

async function fallsBack(h: Awaited<ReturnType<typeof codexHost>>) {
  const source = await h.start({ prompt: 'alpha' })
  await h.send(source, 'beta')
  const edited = await h.start({ prompt: 'recall', forkOf: { taskId: source, upToMessageId: await h.turnEnd(source, 1) } })
  expect((await h.detail(edited)).messages.find(item => item.role === 'user')?.nativeFork).toBeUndefined()
  expect(await h.notes(edited)).toEqual([
    'Codex 没有用它自己的记录分叉：它的记录里找不到这一轮。这次以文字带上来源会话到这一轮为止的记录。',
  ])
  // The text record goes with the new words, to a thread of its own.
  expect(await h.replies(edited)).toEqual([expect.stringMatching(/^echo: 以下是会话「alpha」到第 1 轮为止的记录/u)])
}

test('a Codex that forks the whole thread despite the turn named is caught, its copy archived, and the text record sent', async () => {
  const h = await codexHost({ FAKE_CODEX_FORK_WHOLE: '1' })
  const source = await h.start({ prompt: 'alpha' })
  await h.send(source, 'beta')
  const edited = await h.start({ prompt: 'recall', forkOf: { taskId: source, upToMessageId: await h.turnEnd(source, 1) } })
  expect(await h.notes(edited)).toEqual([
    'Codex 没有用它自己的记录分叉：分叉出的线程没有停在这一轮。这次以文字带上来源会话到这一轮为止的记录。',
  ])
  // The text record goes with the new words, to a thread of its own.
  expect(await h.replies(edited)).toEqual([expect.stringMatching(/^echo: 以下是会话「alpha」到第 1 轮为止的记录/u)])
  expect(await h.archived()).toBe(1)
})

test('says so when the wrong fork could not be archived either', async () => {
  const h = await codexHost({ FAKE_CODEX_FORK_WHOLE: '1', FAKE_CODEX_ARCHIVE_FAIL: '1' })
  const source = await h.start({ prompt: 'alpha' })
  await h.send(source, 'beta')
  const edited = await h.start({ prompt: 'recall', forkOf: { taskId: source, upToMessageId: await h.turnEnd(source, 1) } })
  expect(await h.notes(edited)).toEqual([
    'Codex 没有用它自己的记录分叉：分叉出的线程没有停在这一轮，而且没能归档，它留在 Codex 自己的会话列表里。这次以文字带上来源会话到这一轮为止的记录。',
  ])
})
