import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { startRealHarnessHost, systemNotes, type RealHarnessHost } from './helpers/real-harnesses.ts'

/**
 * Codex's image tool, for real: the person's own `codex` (`LATCH_CODEX_GATEWAY_BINARY`), signed in, on its own model,
 * asked once for a tiny picture (`LATCH_CODEX_IMAGE_REAL=1`; one paid image generation). The picture must reach the
 * session as the reply's image attachment, whichever way Codex hands it over (`result` or `savedPath` + `fs/readFile`).
 */

const REAL = process.env.LATCH_CODEX_IMAGE_REAL === '1' && !!process.env.LATCH_CODEX_GATEWAY_BINARY

let live: RealHarnessHost

beforeAll(async () => {
  if (REAL) live = await startRealHarnessHost({ real: true })
}, 120_000)

afterAll(async () => {
  await live?.close()
})

if (!REAL) it.skip('draws a picture Codex generated (LATCH_CODEX_IMAGE_REAL=1 and the Codex path not set)', () => {})
else
  it('keeps a picture Codex generated as the reply image', async () => {
    const created = await live.owner.confirmed('tasks', {
      method: 'POST',
      body: {
        harnessId: 'codex',
        prompt: 'Use your image generation tool to make a tiny flat blue square icon. Then reply with only: done.',
        requestId: randomUUID(),
      },
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const done: TaskDetail = await live.firstTurn(((await created.json()) as { sessionId: string }).sessionId, 300_000)
    const pictures = done.messages.flatMap(message =>
      message.role === 'assistant' ? (message.attachments ?? []).filter(item => item.kind === 'image') : [],
    )
    const row = done.messages.find(message => message.tool?.title === '生成图片')
    // Only counts and booleans: the reply's words stay out of the log.
    console.info(
      JSON.stringify({
        status: done.summary.status,
        toolRow: !!row,
        pictures: pictures.length,
        mime: pictures[0]?.mime,
        sized: !!pictures[0]?.width,
      }),
    )
    expect(done.summary.status, systemNotes(done)).toBe('idle')
    expect(pictures.length, systemNotes(done)).toBeGreaterThan(0)
    expect(pictures[0]!.mime).toMatch(/^image\/(png|jpeg|webp)$/u)
  }, 360_000)
