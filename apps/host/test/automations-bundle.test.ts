import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { afterEach, expect, test } from 'vitest'
import type { Automation, AutomationDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT, startHostFixture } from '@latch/testkit'
import { hostBundleOptions } from '../scripts/host-bundle.ts'
import type { TestHost } from './helpers/host.ts'

const roots: string[] = [],
  hosts: TestHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0).reverse()) await host.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

test('with an engine enabled, a production bundle keeps a 通用 automation on across a restart and runs it', async () => {
  await mkdir(resolve('test-results'), { recursive: true })
  const root = await mkdtemp(join(resolve('test-results'), 'latch-automation-build-'))
  roots.push(root)
  const outfile = join(root, 'host.mjs')
  await build({ ...(await hostBundleOptions()), entryPoints: [resolve('apps/host/src/server.ts')], outfile, logLevel: 'silent' })
  await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir')
  const module = (await import(pathToFileURL(outfile).href)) as typeof import('../src/server.ts')
  let clock = Date.parse('2026-10-26T08:59:00Z')
  const launch = (dataDir?: string, workspaceRoot?: string) =>
    startHostFixture(
      setup =>
        module.startServer({
          ...setup,
          uiDir: resolve('dist/web'),
          codeRoot: resolve('.'),
          port: 0,
          demo: true,
          rateLimits: 'relaxed',
          nativeNetwork: false,
          now: () => clock,
        }),
      { dataDir, workspaceRoot },
    )
  const first = await launch()
  hosts.push(first)
  const owner = await first.enroll({ listener: 'unix' })
  const engine = await owner.confirmed('agents', {
    method: 'POST',
    body: { id: 'fake-engine', name: 'Fake', command: process.execPath, args: [FAKE_ACP_AGENT], env: {} },
  })
  expect(engine.ok).toBe(true)
  const { id } = await owner.json<Automation>('automations', {
    method: 'POST',
    body: {
      requestId: randomUUID(),
      name: 'Daily',
      prompt: 'Do it',
      schedule: { kind: 'daily', time: '09:00' },
      notify: false,
    },
  })
  await first.host.close()
  const second = await launch(first.dataDir, first.workspaceRoot)
  hosts.push(second)
  const viewer = await second.enroll({ listener: 'unix' })
  const kept = (await viewer.json<AutomationDetail>(`automations/${id}`)).automation
  expect(kept).toMatchObject({ enabled: true, state: 'ready' })
  // The schedule is in this machine's zone, so the time comes from the automation.
  clock = Date.parse(kept.nextRunAt!)
  await expect
    .poll(async () => (await viewer.json<AutomationDetail>(`automations/${id}`)).automation.lastRun?.state, { timeout: 15000 })
    .toBe('completed')
  expect((await viewer.json<AutomationDetail>(`automations/${id}`)).automation).toMatchObject({ enabled: true, state: 'ready' })
}, 40000)
