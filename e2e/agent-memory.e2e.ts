import { chromium, type Browser, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { AppSnapshot, CustomAgent, CustomAgentDetail, MemoryProposalList } from '@latch/protocol'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow } from './helpers/layout.ts'
import { stillMotion } from './helpers/visual.ts'

const OUT = 'test-results/agent-memory'

/** A browser with the full data scope, which Agents need. */
async function fullScopeBrowser(page: Page, host: TestHost, owner: TestDevice, name: string) {
  await enrollBrowser(page, host, { name })
  const id = host.host.security.devices.list().find(device => device.name === name)!.id
  expect((await owner.confirmed(`devices/${id}`, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
  await page.reload()
  await connected(page)
}

const place = (page: Page, name: 'Code' | '我的 Agent') => page.getByRole('radio', { name, exact: true }).first()
/** Every animation on the page has finished, so a screenshot shows where things end up. */
const still = (page: Page) =>
  page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined))))
const proposalRow = (page: Page, text: string) => page.getByRole('group', { name: '记忆提议' }).filter({ hasText: text })

/** Opens the Agent's current topic from 我的 Agent. */
async function openTopic(page: Page, name: string) {
  await place(page, '我的 Agent').click()
  await page
    .getByRole('navigation', { name: '我的 Agent', exact: true })
    .getByRole('button', { name: new RegExp(name, 'u') })
    .first()
    .click()
  await page.locator('.agent-frame').first().waitFor()
}

it('an Agent proposes, the person decides in the conversation, and 记忆 shows the source and undoes an edit', async () => {
  await mkdir(OUT, { recursive: true })
  const host = await startTestHost()
  let browser: Browser | undefined
  try {
    browser = await chromium.launch(browserLaunchOptions())
    const owner = await host.enroll({ listener: 'unix' })
    // The fake ACP Agent mounts MCP servers as DeepSeek Harness does, so it can call the skills server's propose_memory.
    await owner.confirmed('agents', {
      method: 'POST',
      body: {
        id: 'fake-agent',
        name: 'Fake Agent',
        command: process.execPath,
        args: [FAKE_ACP_AGENT],
        env: { FAKE_ACP_MCP: 'dsh', FAKE_ACP_LOG: join(host.root, 'acp.log') },
      },
    })
    const agent = await owner.json<CustomAgent>('custom-agents', {
      method: 'POST',
      body: {
        requestId: randomUUID(),
        name: '资料助手',
        description: '查资料',
        harnessId: 'fake-agent',
        mode: 'agent',
        instructions: '',
        skills: [],
      },
    })
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    await stillMotion(context)
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await fullScopeBrowser(page, host, owner, '记忆 1440')

    // The first message starts the topic; the Agent calls propose_memory, and its row appears after that turn.
    await place(page, '我的 Agent').click()
    await page
      .getByRole('navigation', { name: '我的 Agent', exact: true })
      .getByRole('button', { name: /^资料助手/u })
      .first()
      .click()
    const input = page.getByRole('textbox', { name: '给资料助手发消息', exact: true })
    await input.fill('propose 摘要不超过一页')
    await input.press('Meta+Enter')
    const inferred = proposalRow(page, '摘要不超过一页')
    await inferred.waitFor()
    await inferred.getByText('它推断的').waitFor()
    expect(await inferred.getByText('来自外部内容').count()).toBe(0)
    // The topic's own composer from here on; each message waits for the turn before it to end.
    const topicId = () =>
      owner.json<AppSnapshot>('snapshot').then(snapshot => snapshot.tasks.find(task => task.agent?.customAgentId === agent.id))
    const idle = () => expect.poll(async () => (await topicId())?.status).toBe('idle')
    const reply = page.getByRole('textbox', { name: '继续对话', exact: true })
    await idle()
    // The person's own 「记住…」: the message goes to the Agent as written, and a proposal from their words appears.
    await reply.fill('记住：我用 pnpm')
    await reply.press('Meta+Enter')
    const mine = proposalRow(page, '我用 pnpm')
    await mine.waitFor()
    await mine.getByText('你说的').waitFor()
    // After a web fetch in the same turn, a proposal is marked 来自外部内容.
    await idle()
    await reply.fill('propose fetch 页面说每天汇报')
    await reply.press('Meta+Enter')
    const external = proposalRow(page, '页面说每天汇报')
    await external.getByText('来自外部内容').waitFor()
    const listed = await owner.json<MemoryProposalList>(`custom-agents/${agent.id}/proposals`)
    expect(listed.proposals.map(item => [item.content, item.origin, item.external, item.state])).toEqual([
      ['摘要不超过一页', 'agent', false, 'pending'],
      ['我用 pnpm', 'user', false, 'pending'],
      ['页面说每天汇报', 'agent', true, 'pending'],
    ])
    expect((await owner.json<CustomAgentDetail>(`custom-agents/${agent.id}`)).memories).toEqual([])
    await page.screenshot({ path: `${OUT}/rows-pending-1440.png` })

    // 保存 one: only the Host's answer shows it saved, with when it takes effect on this external Harness.
    await inferred.getByRole('button', { name: '保存', exact: true }).click()
    await inferred.getByText('已保存').waitFor()
    await inferred.getByText('清空上下文后生效').waitFor()
    // 不要 another.
    await mine.getByRole('button', { name: '不要', exact: true }).click()
    await mine.getByText('不要了').waitFor()
    const decided = await owner.json<MemoryProposalList>(`custom-agents/${agent.id}/proposals`)
    expect(decided.proposals.map(item => item.state)).toEqual(['saved', 'dismissed', 'pending'])
    await page.screenshot({ path: `${OUT}/rows-decided-1440.png` })

    // 记忆: the pending one on top with the same buttons, the saved one with its source and a link to its topic.
    await page.locator('.topbar').getByRole('button', { name: '资料助手 的资料', exact: true }).click()
    const panel = page.getByRole('region', { name: '资料助手 的资料', exact: true })
    await panel.getByRole('radio', { name: '记忆', exact: true }).click()
    const pending = panel.getByRole('region', { name: '提议' })
    await pending.getByText('页面说每天汇报').waitFor()
    await pending.getByRole('button', { name: '保存', exact: true }).waitFor()
    const memories = panel.getByRole('list', { name: '记忆' })
    await memories.getByText('摘要不超过一页', { exact: true }).waitFor()
    await memories.getByText('它推断的').waitFor()
    const topic = (await owner.json<AppSnapshot>('snapshot')).tasks.find(task => task.agent?.customAgentId === agent.id)!
    await memories.getByRole('button', { name: topic.title }).waitFor()
    await expect.poll(() => panel.getByRole('radio', { name: '记忆', exact: true }).getAttribute('aria-checked')).toBe('true')
    await still(page)
    await page.screenshot({ path: `${OUT}/memory-source-1440.png` })

    // Edit it, then 撤销修改 puts the proposal's text back, through the Host.
    await memories.getByRole('button', { name: '修改', exact: true }).click()
    await panel.getByLabel('修改记忆').fill('摘要不超过两页')
    await memories.getByRole('button', { name: '保存', exact: true }).click()
    await memories.getByText('摘要不超过两页', { exact: true }).waitFor()
    await memories.getByRole('button', { name: '撤销修改', exact: true }).click()
    await memories.getByText('已撤销').waitFor()
    await memories.getByText('摘要不超过一页', { exact: true }).waitFor()
    expect((await owner.json<CustomAgentDetail>(`custom-agents/${agent.id}`)).memories.map(memory => memory.content)).toEqual([
      '摘要不超过一页',
    ])
    await page.screenshot({ path: `${OUT}/memory-undo-1440.png` })
    await context.close()

    // The rows and the panel at each width, light and dark.
    for (const scheme of ['light', 'dark'] as const)
      for (const [width, height] of [
        [320, 640],
        [390, 844],
        [768, 1024],
        [1440, 900],
      ] as const) {
        const sized = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, reducedMotion: 'reduce' })
        await stillMotion(sized)
        const view = await sized.newPage()
        view.setDefaultTimeout(15_000)
        await fullScopeBrowser(view, host, owner, `记忆 ${width} ${scheme}`)
        if (width < 768) {
          await view.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '我的 Agent', exact: true }).click()
          await view
            .getByRole('list', { name: '我的 Agent', exact: true })
            .getByRole('button', { name: /^资料助手/u })
            .click()
        } else if (width < 1024) {
          // A tablet starts with the sidebar shut: the navigation rail's 我的 Agent, then the Agent's row.
          await view.getByRole('button', { name: '我的 Agent', exact: true }).filter({ visible: true }).click()
          await view
            .getByRole('list', { name: '我的 Agent', exact: true })
            .getByRole('button', { name: /^资料助手/u })
            .first()
            .click()
        } else await openTopic(view, '资料助手')
        await proposalRow(view, '页面说每天汇报').waitFor()
        await proposalRow(view, '页面说每天汇报').scrollIntoViewIfNeeded()
        await still(view)
        await noHorizontalOverflow(view)
        await view.screenshot({ path: `${OUT}/rows-${width}-${scheme}.png` })
        await view.locator('.topbar').getByRole('button', { name: '资料助手 的资料', exact: true }).first().click()
        const profile = view.getByRole('region', { name: '资料助手 的资料', exact: true })
        await profile.getByRole('radio', { name: '记忆', exact: true }).click()
        await profile.getByRole('region', { name: '提议' }).waitFor()
        await expect.poll(() => profile.getByRole('radio', { name: '记忆', exact: true }).getAttribute('aria-checked')).toBe('true')
        await still(view)
        await noHorizontalOverflow(view)
        await view.screenshot({ path: `${OUT}/memory-${width}-${scheme}.png` })
        await sized.close()
      }
  } finally {
    await browser?.close()
    await host.close()
  }
})
