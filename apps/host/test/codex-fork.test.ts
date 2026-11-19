import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { FAKE_ACP_AGENT, FAKE_CODEX_APP_SERVER } from '@latch/testkit'
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
  const events = async (event: string) =>
    (await readFile(log, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .filter(line => (JSON.parse(line) as { event: string }).event === event).length
  const archived = () => events('archived')
  const deleted = () => events('deleted')
  return { owner, start, send, replies, notes, turnEnd, detail, archived, deleted }
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

test('a Codex that forks the whole thread despite the turn named is caught, its copy deleted, and the text record sent', async () => {
  const h = await codexHost({ FAKE_CODEX_FORK_WHOLE: '1' })
  const source = await h.start({ prompt: 'alpha' })
  await h.send(source, 'beta')
  const edited = await h.start({ prompt: 'recall', forkOf: { taskId: source, upToMessageId: await h.turnEnd(source, 1) } })
  expect(await h.notes(edited)).toEqual([
    'Codex 没有用它自己的记录分叉：分叉出的线程没有停在这一轮。这次以文字带上来源会话到这一轮为止的记录。',
  ])
  // The text record goes with the new words, to a thread of its own.
  expect(await h.replies(edited)).toEqual([expect.stringMatching(/^echo: 以下是会话「alpha」到第 1 轮为止的记录/u)])
  expect(await h.deleted()).toBe(1)
  expect(await h.archived()).toBe(0)
})

test('archives the wrong fork when Codex will not delete it, and says so', async () => {
  const h = await codexHost({ FAKE_CODEX_FORK_WHOLE: '1', FAKE_CODEX_DELETE_FAIL: 'locked' })
  const source = await h.start({ prompt: 'alpha' })
  await h.send(source, 'beta')
  const edited = await h.start({ prompt: 'recall', forkOf: { taskId: source, upToMessageId: await h.turnEnd(source, 1) } })
  expect(await h.notes(edited)).toEqual([
    'Codex 没有用它自己的记录分叉：分叉出的线程没有停在这一轮，Codex 没有删除它，已归档。这次以文字带上来源会话到这一轮为止的记录。',
  ])
  expect(await h.archived()).toBe(1)
})

test('says so when the wrong fork could be neither deleted nor archived', async () => {
  const h = await codexHost({ FAKE_CODEX_FORK_WHOLE: '1', FAKE_CODEX_DELETE_FAIL: 'locked', FAKE_CODEX_ARCHIVE_FAIL: '1' })
  const source = await h.start({ prompt: 'alpha' })
  await h.send(source, 'beta')
  const edited = await h.start({ prompt: 'recall', forkOf: { taskId: source, upToMessageId: await h.turnEnd(source, 1) } })
  expect(await h.notes(edited)).toEqual([
    'Codex 没有用它自己的记录分叉：分叉出的线程没有停在这一轮，而且没能删除或归档，它留在 Codex 自己的会话列表里。这次以文字带上来源会话到这一轮为止的记录。',
  ])
})

test('a conversation that comes back to Codex goes on from the Codex thread it left, told only what was said since', async () => {
  const h = await codexHost()
  await h.owner.confirmedJson('agents', { body: { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT] } })
  const last = async (sessionId: string) => (await h.detail(sessionId)).messages.at(-1)!.id
  const first = await h.start({ prompt: 'alpha' })
  await h.send(first, 'beta')
  // On to another Harness, which is told the record, then back.
  const away = await h.start({
    harnessId: 'fake',
    prompt: 'delta',
    forkOf: { taskId: first, upToMessageId: await last(first), moved: true },
  })
  const left = await last(away)
  // What either session is told after the conversation left it is not this conversation's.
  await h.send(first, 'stray')
  await h.send(away, 'astray')
  const back = await h.start({ prompt: 'omega', forkOf: { taskId: away, upToMessageId: left, moved: true } })
  const opening = (await h.detail(back)).messages.find(item => item.role === 'user')
  expect(opening).toMatchObject({ nativeFork: true })
  expect(await h.notes(back)).toEqual([])
  // Codex is sent what the other Harness heard and said, not its own two turns again.
  const [heard] = await h.replies(back)
  // (The other Harness here echoes what it was sent, so its reply quotes the record; the turns told begin at its own.)
  expect(heard).toMatch(/^echo: 以下是你离开之后[^\n]*\n<会话记录>\n\n你：\ndelta\n/u)
  expect(heard).toMatch(/omega$/u)
  expect(heard).not.toContain('stray')
  // Its thread is a fork of the one it left: the two turns are in its own record.
  await h.send(back, 'recall')
  expect((await h.replies(back)).at(-1)).toMatch(/^remembers: alpha \| beta \| 以下是你离开之后/u)
  // The thread it left is as it was.
  await h.send(first, 'recall')
  expect((await h.replies(first)).at(-1)).toBe('remembers: alpha | beta | stray')
})

test('a Codex that cannot fork the thread it left is sent the whole record instead', async () => {
  const h = await codexHost({ FAKE_CODEX_NO_CLIENT_ID: '1' })
  await h.owner.confirmedJson('agents', { body: { id: 'fake', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT] } })
  const last = async (sessionId: string) => (await h.detail(sessionId)).messages.at(-1)!.id
  const first = await h.start({ prompt: 'alpha' })
  const away = await h.start({
    harnessId: 'fake',
    prompt: 'delta',
    forkOf: { taskId: first, upToMessageId: await last(first), moved: true },
  })
  const back = await h.start({ prompt: 'omega', forkOf: { taskId: away, upToMessageId: await last(away), moved: true } })
  expect((await h.detail(back)).messages.find(item => item.role === 'user')?.nativeFork).toBeUndefined()
  const [heard] = await h.replies(back)
  expect(heard).toContain('alpha')
  expect(heard).toContain('delta')
  expect(heard).not.toContain('以下是你离开之后')
})
