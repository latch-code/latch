import { chromium, type Browser, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { AppSnapshot, CustomAgent, CustomAgentDetail, MemoryProposalList } from '@latch/protocol'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { noHorizontalOverflow, reachable } from './helpers/layout.ts'
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
const latestTurn = (page: Page) => page.locator('.transcript .turn').last()
const opacity = (row: Locator) => row.evaluate(element => getComputedStyle(element).opacity)

async function expectFooterBefore(footer: Locator, card: Locator) {
  const [actions, proposal] = await Promise.all([footer.boundingBox(), card.boundingBox()])
  expect(actions).not.toBeNull()
  expect(proposal).not.toBeNull()
  expect(proposal!.y - actions!.y - actions!.height).toBeGreaterThanOrEqual(8)
}

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

    // The first message starts the topic. An ordinary reply's actions still overlay the space after the turn.
    await place(page, '我的 Agent').click()
    await page
      .getByRole('navigation', { name: '我的 Agent', exact: true })
      .getByRole('button', { name: /^资料助手/u })
      .first()
      .click()
    const input = page.getByRole('textbox', { name: '给资料助手发消息', exact: true })
    await input.fill('你好')
    await input.press('Meta+Enter')
    const topicId = () =>
      owner.json<AppSnapshot>('snapshot').then(snapshot => snapshot.tasks.find(task => task.agent?.customAgentId === agent.id))
    const idle = () => expect.poll(async () => (await topicId())?.status).toBe('idle')
    const reply = page.getByRole('textbox', { name: '继续对话', exact: true })
    const footer = latestTurn(page).locator('.turn-footer')
    // The first turn mounts the fake ACP's local MCP servers before the settled footer appears.
    await footer.locator('time').waitFor()
    await idle()
    expect(
      await footer.evaluate(element => element.getBoundingClientRect().top - element.closest('.turn')!.getBoundingClientRect().bottom),
    ).toBeGreaterThan(0)

    // The Agent calls propose_memory. The latest turn's actions clear the pending and saved card.
    await reply.fill('propose 摘要不超过一页')
    await reply.press('Meta+Enter')
    const inferred = proposalRow(page, '摘要不超过一页')
    await inferred.getByText('它推断的').waitFor()
    expect(await inferred.getByText('来自外部内容').count()).toBe(0)
    expect((await owner.json<CustomAgentDetail>(`custom-agents/${agent.id}`)).memories).toEqual([])
    await idle()
    await footer.locator('time').waitFor()
    await page.mouse.move(0, 0)
    await expect.poll(() => opacity(footer)).toBe('0')
    await expectFooterBefore(footer, inferred)
    await latestTurn(page).locator('.message-assistant').last().hover()
    await expect.poll(() => opacity(footer)).toBe('1')
    await expectFooterBefore(footer, inferred)
    await page.screenshot({ path: `${OUT}/rows-pending-1440.png` })

    // 保存: only the Host's answer shows it saved, with when it takes effect on this external Harness.
    await inferred.getByRole('button', { name: '保存', exact: true }).click()
    await inferred.getByText('已保存').waitFor()
    await inferred.getByText('清空上下文后生效').waitFor()
    await page.mouse.move(0, 0)
    await expect.poll(() => opacity(footer)).toBe('0')
    await footer.getByRole('button', { name: '复制', exact: true }).focus()
    await expect.poll(() => opacity(footer)).toBe('1')
    await expectFooterBefore(footer, inferred)
    await page.screenshot({ path: `${OUT}/rows-saved-1440.png` })

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
      ['摘要不超过一页', 'agent', false, 'saved'],
      ['我用 pnpm', 'user', false, 'pending'],
      ['页面说每天汇报', 'agent', true, 'pending'],
    ])
    // 不要 another.
    await mine.getByRole('button', { name: '不要', exact: true }).click()
    await mine.getByText('不要了').waitFor()
    const decided = await owner.json<MemoryProposalList>(`custom-agents/${agent.id}/proposals`)
    expect(decided.proposals.map(item => item.state)).toEqual(['saved', 'dismissed', 'pending'])
    await page.screenshot({ path: `${OUT}/rows-decided-1440.png` })

    // 记忆: the pending one on top with the same buttons, the saved one with its source and a link to its topic.
    await page.locator('.topbar').getByRole('button', { name: '资料助手 的资料', exact: true }).click()
    const panel = page.getByRole('region', { name: '资料助手 的资料', exact: true })
    await panel.getByRole('tab', { name: '记忆', exact: true }).click()
    const pending = panel.getByRole('region', { name: '提议' })
    await pending.getByText('页面说每天汇报').waitFor()
    await pending.getByRole('button', { name: '保存', exact: true }).waitFor()
    const memories = panel.getByRole('list', { name: '记忆' })
    await memories.getByText('摘要不超过一页', { exact: true }).waitFor()
    await memories.getByText('它推断的').waitFor()
    const topic = (await owner.json<AppSnapshot>('snapshot')).tasks.find(task => task.agent?.customAgentId === agent.id)!
    await memories.getByRole('button', { name: topic.title }).waitFor()
    await expect.poll(() => panel.getByRole('tab', { name: '记忆', exact: true }).getAttribute('aria-selected')).toBe('true')
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
        const sized = await browser.newContext({
          viewport: { width, height },
          hasTouch: width < 1024,
          colorScheme: scheme,
          reducedMotion: 'reduce',
        })
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
        const latestProposal = proposalRow(view, '页面说每天汇报')
        await latestProposal.scrollIntoViewIfNeeded()
        await still(view)
        const turn = latestTurn(view)
        const actions = turn.locator('.turn-footer')
        await expectFooterBefore(actions, latestProposal)
        if (width < 1024) {
          expect(await opacity(actions)).toBe('1')
          expect(await opacity(turn.locator('.message-meta'))).toBe('1')
          await reachable(actions.getByRole('button', { name: '复制', exact: true }))
          await reachable(latestProposal.getByRole('button', { name: '保存', exact: true }))
        }
        await noHorizontalOverflow(view)
        await view.screenshot({ path: `${OUT}/rows-${width}-${scheme}.png` })
        if (width === 390 && scheme === 'dark') {
          const past = view.locator('.transcript .turn').filter({ hasText: 'propose 摘要不超过一页' })
          const pastReply = past.locator('.message-assistant').last()
          const pastActions = past.locator('.turn-footer')
          const saved = proposalRow(view, '摘要不超过一页')
          await pastReply.scrollIntoViewIfNeeded()
          await expect.poll(() => opacity(pastActions)).toBe('0')
          await pastReply.tap()
          await expect.poll(() => opacity(pastActions)).toBe('1')
          await expectFooterBefore(pastActions, saved)
          await pastReply.tap()
          await expect.poll(() => opacity(pastActions)).toBe('0')
        }
        await view.locator('.topbar').getByRole('button', { name: '资料助手 的资料', exact: true }).first().click()
        const profile = view.getByRole('region', { name: '资料助手 的资料', exact: true })
        await profile.getByRole('tab', { name: '记忆', exact: true }).click()
        await profile.getByRole('region', { name: '提议' }).waitFor()
        await expect.poll(() => profile.getByRole('tab', { name: '记忆', exact: true }).getAttribute('aria-selected')).toBe('true')
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
