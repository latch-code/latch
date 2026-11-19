import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { startRealHarnessHost, systemNotes, type RealHarnessHost } from './helpers/real-harnesses.ts'

/**
 * Deleting a Codex session for real: the person's own `codex` (`LATCH_CODEX_GATEWAY_BINARY`), signed in, on its own model,
 * in a temporary project, one short prompt (`LATCH_CODEX_DELETE_REAL=1`; one paid turn). Latch deletes the session, and
 * a separate `codex app-server` of the same person must no longer read the thread. Only booleans are printed: the
 * thread's ID, its words and Codex's own files stay out of the log.
 */

const REAL = process.env.LATCH_CODEX_DELETE_REAL === '1' && !!process.env.LATCH_CODEX_GATEWAY_BINARY

let live: RealHarnessHost

beforeAll(async () => {
  if (REAL) live = await startRealHarnessHost({ real: true })
}, 120_000)

afterAll(async () => {
  await live?.close()
})

/** Whether the person's own Codex still reads a thread: `thread/read` on a process that opens nothing. */
async function codexReads(threadId: string): Promise<boolean> {
  const child = spawn(process.env.LATCH_CODEX_GATEWAY_BINARY!, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] })
  let buffer = ''
  const answers = new Map<number, (message: Record<string, unknown>) => void>()
  child.stdout.on('data', chunk => {
    buffer += String(chunk)
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      try {
        const message = JSON.parse(line) as { id?: number }
        if (typeof message.id === 'number') answers.get(message.id)?.(message)
      } catch {
        /* Not an answer. */
      }
    }
  })
  let next = 0
  const send = (method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = next++
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30_000)
      answers.set(id, message => {
        clearTimeout(timer)
        resolve(message)
      })
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  try {
    await send('initialize', {
      clientInfo: { name: 'latch-live', title: 'Latch', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    })
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
    const read = await send('thread/read', { threadId, includeTurns: false })
    return read.result !== undefined && read.error === undefined
  } finally {
    child.kill()
  }
}

if (!REAL) it.skip('deletes a real Codex session’s thread (LATCH_CODEX_DELETE_REAL=1 and the Codex path not set)', () => {})
else
  it('deletes the thread of a real Codex session, and the person’s Codex no longer reads it', async () => {
    const created = await live.owner.confirmed('tasks', {
      method: 'POST',
      body: { harnessId: 'codex', prompt: 'Reply with only the word: ok', requestId: randomUUID() },
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const { sessionId } = (await created.json()) as { sessionId: string }
    const done = await live.firstTurn(sessionId, 180_000)
    expect(done.summary.status, systemNotes(done)).toBe('idle')
    // Latch's own record of the session, in its temporary data folder: the thread it opened in Codex.
    const state = JSON.parse(await readFile(join(live.host.dataDir, 'harnesses', 'codex', 'acp.json'), 'utf8')) as {
      tasks: Record<string, { acp: { acpSessionId?: string } }>
    }
    const thread = state.tasks[sessionId]?.acp.acpSessionId
    expect(typeof thread).toBe('string')
    const before = await codexReads(thread!)
    const removed = await live.owner.request(`tasks/${sessionId}`, { method: 'DELETE' })
    expect(removed.status).toBe(200)
    let after = true
    for (const until = Date.now() + 30_000; after && Date.now() < until;) {
      await new Promise(resolve => setTimeout(resolve, 500))
      after = await codexReads(thread!)
    }
    console.info(JSON.stringify({ turnEnded: true, readBefore: before, deleted: removed.status === 200, readAfter: after }))
    expect(before).toBe(true)
    expect(after).toBe(false)
  }, 300_000)
