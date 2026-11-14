import { expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { setTimeout as pause } from 'node:timers/promises'
import { pairingStagePage } from './helpers/iosPairingStage.ts'

it('exposes only the public pairing phase and cannot trigger pairing or change the phase through HTTP', async () => {
  const page = await pairingStagePage()
  try {
    expect(new URL(page.url).hostname).toBe('127.0.0.1')
    expect(await (await fetch(new URL('phase', page.url))).json()).toEqual({ phase: 'idle' })
    page.show('paste-ready')
    expect(await (await fetch(new URL('phase', page.url))).json()).toEqual({ phase: 'paste-ready' })
    expect((await fetch(new URL('phase', page.url), { method: 'POST', body: 'cleanup' })).status).toBe(405)
    expect((await fetch(new URL('pair', page.url))).status).toBe(404)
    expect(await (await fetch(new URL('phase', page.url))).json()).toEqual({ phase: 'paste-ready' })
    page.show('cleanup')
    expect(await (await fetch(new URL('phase', page.url))).json()).toEqual({ phase: 'cleanup' })
  } finally {
    await page.close()
  }
  await expect(fetch(page.url)).rejects.toThrow()
})

const probe = process.env.LATCH_IOS_STAGE_PROBE
it.skipIf(!probe)('holds only public phases for an actual browser wait probe', async () => {
  if (!probe) return
  const page = await pairingStagePage()
  try {
    await writeFile(probe + '.info', page.url + '\n')
    const readyBy = Date.now() + 60_000
    while (!existsSync(probe + '.start') && Date.now() < readyBy) await pause(50)
    expect(existsSync(probe + '.start')).toBe(true)
    page.show('off-control')
    await pause(20_000)
    page.show('paste-ready')
    await writeFile(probe + '.ready', String(Date.now()))
    const doneBy = Date.now() + 30_000
    while (!existsSync(probe + '.done') && Date.now() < doneBy) await pause(50)
    expect(existsSync(probe + '.done')).toBe(true)
  } finally {
    await page.close()
  }
})
