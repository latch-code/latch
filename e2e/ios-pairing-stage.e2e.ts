import { expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { setTimeout as pause } from 'node:timers/promises'
import { pairingStagePage } from './helpers/iosPairingStage.ts'
import { chromium } from 'playwright'
import { browserLaunchOptions } from './helpers/browser.ts'

it('acknowledges only the current public control from its own page, once per stage', async () => {
  const acknowledgements: string[] = []
  const page = await pairingStagePage({
    acknowledge: async stage => {
      acknowledgements.push(stage)
    },
  })
  const state = async () => (await (await fetch(new URL('phase', page.url))).json()) as { phase: string; version: number }
  const ack = (value: unknown, origin = new URL(page.url).origin) =>
    fetch(new URL('ack', page.url), {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(value),
    })
  try {
    await page.show('on-control')
    const first = await state()
    expect((await ack(first, 'https://example.invalid')).status).toBe(403)
    expect((await ack({ ...first, phase: 'off-control' })).status).toBe(409)
    expect((await ack(first)).status).toBe(204)
    expect((await ack(first)).status).toBe(409)
    await page.show('off-control')
    const second = await state()
    expect((await ack({ ...second, version: first.version })).status).toBe(409)
    expect((await ack(second)).status).toBe(204)
    await page.show('paste-ready')
    expect((await ack(await state())).status).toBe(409)
    await page.show('on-control')
    expect((await ack(first)).status).toBe(409)
    expect((await ack(await state())).status).toBe(204)
    expect(acknowledgements).toEqual(['on-control', 'off-control', 'on-control'])
  } finally {
    await page.close()
  }
})

it('waits for the old acknowledgement before exposing the next control stage', async () => {
  let release: (() => void) | undefined
  let calls = 0
  const page = await pairingStagePage({
    acknowledge: async () => {
      calls++
      await new Promise<void>(resolve => {
        release = resolve
      })
    },
  })
  try {
    await page.show('on-control')
    const value: unknown = await (await fetch(new URL('phase', page.url))).json()
    const sent = fetch(new URL('ack', page.url), {
      method: 'POST',
      headers: { origin: new URL(page.url).origin, 'content-type': 'application/json' },
      body: JSON.stringify(value),
    })
    await expect.poll(() => calls).toBe(1)
    let moved = false
    const next = page.show('off-control').then(() => {
      moved = true
    })
    await Promise.resolve()
    expect(moved).toBe(false)
    expect((await (await fetch(new URL('phase', page.url))).json()).phase).toBe('on-control')
    release?.()
    expect((await sent).status).toBe(204)
    await next
    expect((await (await fetch(new URL('phase', page.url))).json()).phase).toBe('off-control')
  } finally {
    release?.()
    await page.close()
  }
})

it('offers ordinary browser buttons only for the active operator acknowledgement', async () => {
  const acknowledged: string[] = []
  const page = await pairingStagePage({
    acknowledge: async value => {
      acknowledged.push(value)
    },
  })
  const browser = await chromium.launch(browserLaunchOptions())
  try {
    const tab = await browser.newPage()
    await tab.goto(page.url)
    expect(await tab.getByRole('button', { name: '已打开共享' }).isVisible()).toBe(false)
    await page.show('on-control')
    await tab.getByRole('button', { name: '已打开共享' }).click()
    await expect.poll(() => acknowledged).toEqual(['on-control'])
    expect(await tab.getByRole('button', { name: '已打开共享' }).isEnabled()).toBe(false)
    await page.show('off-control')
    await tab.getByRole('button', { name: '已关闭共享' }).click()
    await expect.poll(() => acknowledged).toEqual(['on-control', 'off-control'])
    await page.show('paste-ready')
    await tab.getByRole('status').filter({ hasText: 'paste-ready' }).waitFor()
    expect(await tab.getByRole('button', { name: '已关闭共享' }).isVisible()).toBe(false)
  } finally {
    await browser.close()
    await page.close()
  }
})

it('exposes only the public pairing phase and cannot trigger pairing or change the phase through HTTP', async () => {
  const page = await pairingStagePage()
  try {
    expect(new URL(page.url).hostname).toBe('127.0.0.1')
    expect(await (await fetch(new URL('phase', page.url))).json()).toEqual({ phase: 'idle' })
    await page.show('paste-ready')
    expect(await (await fetch(new URL('phase', page.url))).json()).toEqual({ phase: 'paste-ready' })
    expect((await fetch(new URL('phase', page.url), { method: 'POST', body: 'cleanup' })).status).toBe(405)
    expect((await fetch(new URL('pair', page.url))).status).toBe(404)
    expect(await (await fetch(new URL('phase', page.url))).json()).toEqual({ phase: 'paste-ready' })
    await page.show('cleanup')
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
    await page.show('off-control')
    await pause(20_000)
    await page.show('paste-ready')
    await writeFile(probe + '.ready', String(Date.now()))
    const doneBy = Date.now() + 30_000
    while (!existsSync(probe + '.done') && Date.now() < doneBy) await pause(50)
    expect(existsSync(probe + '.done')).toBe(true)
  } finally {
    await page.close()
  }
})
