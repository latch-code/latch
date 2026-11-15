// A real Codex on its own login, through the normal Harness path on a temporary Host: what Latch publishes of its limits.
// Skipped unless the owner allows it and sets LATCH_CODEX_QUOTA_BINARY to the installed `codex`; LATCH_CODEX_QUOTA_OUT
// names a file for the published fields. It sends one tiny prompt, reads nothing of Codex's own files, and writes numbers
// and fixed words only: whether an account label was published, never the label.
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import type { AppSnapshot, TaskDetail } from '@latch/protocol'
import { startTestHost } from './helpers/host.ts'

const binary = process.env.LATCH_CODEX_QUOTA_BINARY

it.skipIf(!binary)(
  'publishes the limits a real Codex reports, as numbers, a plan of the known set and a masked account',
  async () => {
    const t = await startTestHost({ demo: false })
    try {
      const owner = await t.enroll({ listener: 'unix' })
      await owner.confirmedJson('agents', { body: { id: 'codex', name: 'Codex', presetId: 'codex', command: binary, args: [], env: {} } })
      const quota = async () =>
        (await owner.json<AppSnapshot>('snapshot')).catalog?.harnesses.find(harness => harness.id === 'codex')?.quota
      expect(await quota()).toBeUndefined()
      const started = Date.now()
      const { sessionId } = await owner.confirmedJson<{ sessionId: string }>('tasks', {
        body: { prompt: 'Reply with the single word: ok', requestId: randomUUID(), harnessId: 'codex' },
      })
      await vi.waitFor(async () => expect(await quota()).toBeDefined(), { timeout: 90_000, interval: 250 })
      const first = (await quota())!
      const firstAfterMs = Date.now() - started
      await vi.waitFor(async () => expect((await owner.json<TaskDetail>(`tasks/${sessionId}`)).summary.status).not.toBe('running'), {
        timeout: 150_000,
        interval: 500,
      })
      const detail = await owner.json<TaskDetail>(`tasks/${sessionId}`)
      const last = (await quota())!
      const shape = (value: NonNullable<typeof first>) => ({
        windows: value.windows.map(window => ({
          kind: window.kind,
          usedPercent: window.usedPercent,
          windowMinutes: window.windowMinutes,
          resetsInMinutes: window.resetsAt ? Math.round((Date.parse(window.resetsAt) - Date.now()) / 60_000) : undefined,
          state: window.state,
        })),
        plan: value.plan,
        accountPublished: value.account !== undefined,
        accountIsMasked: value.account === undefined ? undefined : /^.•••@.•••(\.[a-z]{2,10})?$/u.test(value.account),
        state: value.state,
      })
      const record = {
        at: new Date().toISOString(),
        sessionStatus: detail.summary.status,
        firstSnapshotAfterMs: firstAfterMs,
        afterThreadOpened: shape(first),
        afterTurnEnded: shape(last),
        publishedKeys: Object.keys(last).sort(),
      }
      if (process.env.LATCH_CODEX_QUOTA_OUT) await writeFile(process.env.LATCH_CODEX_QUOTA_OUT, `${JSON.stringify(record, null, 2)}\n`)
      expect(last.windows.length).toBeGreaterThan(0)
      for (const window of last.windows) expect(window.usedPercent).toBeGreaterThanOrEqual(0)
      expect(JSON.stringify(last)).not.toMatch(/@[a-z0-9-]+\.[a-z]+/iu)
    } finally {
      await t.close()
    }
  },
  240_000,
)
