import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { TaskDetail } from '@latch/protocol'
import type { HarnessPlugin, ToolCall } from '@latch/sdk'
import type { TestDevice } from '@latch/testkit'
import { expect, vi } from 'vitest'
import type { TestHost } from './host.ts'
import { openPanelTab } from './layout.ts'

export const REVIEW = '核对发布前的性能回归'
export const FOLLOW_UP = '对照上次基线，给出发布建议。'
const REVIEW_MODEL = 'review-fixture'
export const samples = Array.from({ length: 420 }, (_, i) => `checkout,build-21,${i + 1},${410 + (i % 37)},${560 + (i % 64)}`).join('\n')

export const reviewPlugin: HarnessPlugin = {
  id: REVIEW_MODEL,
  name: '发布核对',
  version: '1',
  description: '',
  activate(ctx) {
    ctx.registerSkill({ id: 'compare', name: '性能比对', description: '核对发布性能', content: '比对相同样本量的延迟，给出可复核的结论。' })
    ctx.registerProvider({
      id: REVIEW_MODEL,
      name: '验收模型',
      model: 'local',
      async *stream({ messages }) {
        const last = messages.at(-1)
        const turn = messages.filter(message => message.role === 'user').length
        const after = last?.toolCallId
        let call: ToolCall | undefined
        if (last?.role === 'user') {
          call =
            turn === 1
              ? { id: 'list', name: 'list_files', arguments: { path: '.' } }
              : { id: 'previous', name: 'read_file', arguments: { path: 'previous.csv' } }
        } else if (after === 'list') {
          call = { id: 'summary', name: 'read_file', arguments: { path: 'summary.md' } }
        } else if (after === 'summary') {
          call = { id: 'samples', name: 'read_file', arguments: { path: 'samples.csv' } }
        } else if (after === 'previous' && last?.isError) {
          call = { id: 'baseline', name: 'read_file', arguments: { path: 'baseline.csv' } }
        }
        // Model reports and measured message bytes are independent. The first request has no usage report.
        if (call?.id !== 'list') {
          const inputs = messages.filter(message => message.role === 'tool').length
          yield { type: 'usage', inputTokens: 1800 + inputs * 320, outputTokens: 36 }
        }
        if (call) {
          yield { type: 'tool-call', call }
          yield { type: 'finish', reason: 'tool-calls' }
        } else {
          yield {
            type: 'text',
            text:
              turn === 1
                ? '结账路径的尾部延迟升高。已核对摘要和 420 条样本，下一步需要与上次发布的基线比对。'
                : '上次发布的 P95 为 480 ms，这次有多个样本超过 560 ms。建议先核查结账路径的慢请求，再安排发布。',
          }
          yield { type: 'finish', reason: 'stop' }
        }
      },
    })
  },
}

export async function reviewSession(host: TestHost, owner: TestDevice) {
  await Promise.all([
    writeFile(join(host.workspaceRoot, 'summary.md'), '上线说明：结账路径需复核 P95。样本见 samples.csv，上次基线见 baseline.csv。'),
    writeFile(join(host.workspaceRoot, 'samples.csv'), samples),
    writeFile(join(host.workspaceRoot, 'baseline.csv'), 'route,build,p95_ms\ncheckout,build-20,480'),
  ])
  const { sessionId } = await owner.json<{ sessionId: string }>('tasks', {
    body: { requestId: randomUUID(), harnessId: 'standard', model: { providerId: REVIEW_MODEL, model: 'local' }, prompt: REVIEW },
  })
  const detail = () => owner.json<TaskDetail>(`tasks/${sessionId}`)
  await vi.waitFor(async () => expect((await detail()).summary.status).toBe('idle'), { timeout: 15_000 })
  await owner.json(`tasks/${sessionId}/prompt`, { body: { requestId: randomUUID(), prompt: FOLLOW_UP } })
  await vi.waitFor(async () => expect((await detail()).summary.status).toBe('idle'), { timeout: 15_000 })
  return await detail()
}

export async function openContextPanel(page: Page, panel: Locator) {
  const toggle = page.getByRole('button', { name: '侧边面板', exact: true })
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
  await openPanelTab(page, '上下文')
  await panel.waitFor()
}

export function requestBar(panel: Locator, sequence: number) {
  return panel
    .getByRole('group', { name: '上下文演变', exact: true })
    .getByRole('button', { name: new RegExp(`^第 ${sequence} 次请求[：:]`, 'u') })
}

export async function selectFourthRequest(panel: Locator) {
  const bar = requestBar(panel, 4)
  if ((await bar.getAttribute('aria-pressed')) !== 'true') await bar.click()
  await expect.poll(() => bar.getAttribute('aria-pressed')).toBe('true')
  const composition = panel.getByRole('region', { name: '请求组成', exact: true })
  const metric = (label: string) => composition.getByText(label, { exact: true }).locator('xpath=following-sibling::dd[1]')
  expect(await metric('此时占得最多').textContent()).toMatch(/^工具定义/u)
  expect(await metric('较上次增长最多').textContent()).toMatch(/^工具结果增加/u)
  expect(await metric('输入 token').textContent()).toBe('2,760')
  expect(await metric('输出 token').textContent()).toBe('36')
}

export async function visibleReadingTarget(target: Locator) {
  await expect
    .poll(() =>
      target.evaluate(element => {
        const rect = element.getBoundingClientRect()
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
        return !!hit && element.contains(hit)
      }),
    )
    .toBe(true)
}

export async function jumpToLargestResult(page: Page, panel: Locator, session: TaskDetail) {
  const step = session.contextSteps?.find(item => item.sequence === 4)
  const result = step?.toolContributions?.largest[0]
  expect(result?.inclusion).toBe('new')
  const message = session.messages.find(item => item.role === 'tool' && item.contextToolId === result?.source?.resultId)
  expect(message).toMatchObject({ role: 'tool', toolName: 'read_file', text: samples })
  expect(step?.toolContributions?.added[0]?.source).toEqual(result?.source)
  const row = page.locator(`.transcript .tool-card[data-message-id="${message!.id}"]`)
  expect(await row.locator('xpath=ancestor::*[@hidden="until-found"]').count()).toBeGreaterThan(0)
  const links = panel.locator('.context-tool-result-link').and(panel.getByRole('button', { name: '查看工具输出：read_file', exact: true }))
  expect(await links.count()).toBe(2)
  const largest = links.filter({ hasText: `${result!.bytes.toLocaleString('zh-CN')} B` })
  await largest.click()
  const target = row.getByRole('button', { name: /samples\.csv/u })
  await visibleReadingTarget(target)
  expect(await row.locator('xpath=ancestor::*[@hidden="until-found"]').count()).toBe(0)
  return target
}
