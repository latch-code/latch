import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Page } from '@playwright/test'
import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import type { Device, FileMetadata, TaskDetail, WorkspaceInfo } from '@latch/protocol'
import type { HarnessPlugin } from '@latch/sdk'
import { browserLaunchOptions, enrollBrowser } from './helpers/browser.ts'
import { startTestHost } from './helpers/host.ts'
import { closeActiveFile, settleShell } from './helpers/layout.ts'

async function showList(page: Page, width: number) {
  if (width === 900) {
    const button = page.getByRole('button', { name: '打开会话列表', exact: true })
    if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click()
    await page.locator('#session-navigation.is-open').waitFor()
  }
}

describe('preview authority reduction', () => {
  it.each([
    [1440, 'txt'],
    [900, 'docx'],
  ] as const)(
    '%s clears an open workspace %s on the actual scope snapshot without metadata polling, and reauthorizes a work artifact',
    async (width, kind) => {
      const artifact = 'A legitimate session artifact written by the actual workspace tool.',
        marker = 'Workspace private preview must disappear on access reduction.',
        provider: HarnessPlugin = {
          id: 'preview-access-provider',
          name: 'Local access fixture',
          description: '',
          version: '1',
          activate(context) {
            context.registerProvider({
              id: 'preview-access-provider',
              name: 'Local access fixture',
              model: 'fixture',
              async *stream({ messages }) {
                if (!messages.some(message => message.role === 'tool')) {
                  yield {
                    type: 'tool-call',
                    call: { id: 'write-allowed', name: 'write_file', arguments: { path: 'allowed.txt', content: artifact } },
                  }
                  yield { type: 'finish', reason: 'tool-calls' }
                } else {
                  yield { type: 'text', text: '工作产物：[allowed.txt](allowed.txt)。' }
                  yield { type: 'finish', reason: 'stop' }
                }
              },
            })
          },
        },
        host = await startTestHost({ demo: false, providerId: provider.id, plugins: [provider] }),
        browser = await chromium.launch(browserLaunchOptions()),
        context = await browser.newContext({
          viewport: { width, height: 1000 },
          colorScheme: width === 900 ? 'dark' : 'light',
          reducedMotion: 'reduce',
        })
      context.setDefaultTimeout(15_000)
      try {
        const owner = await host.enroll({ listener: 'unix' }),
          source = join(host.root, 'access-project')
        await mkdir(source)
        const privateName = 'private.' + kind
        await writeFile(
          join(source, privateName),
          kind === 'txt'
            ? marker
            : zipSync({
                '[Content_Types].xml': strToU8(
                  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
                ),
                '_rels/.rels': strToU8(
                  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="doc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
                ),
                'word/document.xml': strToU8(
                  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>'
                    + marker
                    + '</w:t></w:r></w:p><w:sectPr/></w:body></w:document>',
                ),
              }),
        )
        const added = await owner.addFolders({ name: '预览权限项目', paths: [source] })
        expect(added.status).toBe(201)
        const project = ((await added.json()) as { workspace: WorkspaceInfo }).workspace,
          created = await owner.json<{ sessionId: string }>('tasks', {
            method: 'POST',
            body: { prompt: '写入这次会话允许查看的产物', requestId: randomUUID(), mode: 'agent', workspaceId: project.id },
          }),
          detail = () => owner.json<TaskDetail>('tasks/' + created.sessionId)
        await expect.poll(async () => (await detail()).approvals[0]?.toolName).toBe('write_file')
        const approval = (await detail()).approvals[0]!
        await owner.json('approvals/' + approval.id, { method: 'POST', body: { decision: 'allow', requestId: randomUUID() } })
        await expect.poll(async () => (await detail()).summary.runOutcome).toBe('completed')
        await expect.poll(async () => (await detail()).messages.some(message => message.outputsPending), { timeout: 10_000 }).toBe(false)
        const page = await context.newPage(),
          deviceName = '预览范围 ' + kind
        await page.route(/\/link\/api\/files\/[^/]+\/meta(?:\?|$)/u, route => route.abort())
        await enrollBrowser(page, host, { name: deviceName, scopes: ['view', 'run'] })
        const device = (await owner.json<{ devices: Device[] }>('devices')).devices.find(device => device.name === deviceName)!
        expect(device.dataScope).toBe('work')
        await showList(page, width)
        await page.locator(`[data-task-id="${created.sessionId}"]`).click()
        const artifactLink = page
            .getByRole('region', { name: '这一轮改动的文件', exact: true })
            .locator('button.summary-file', { hasText: 'allowed.txt' }),
          preview = page.getByRole('region', { name: '文件预览', exact: true })
        // The card's row opens the change; the file itself is one button away.
        const openArtifact = async () => {
          const toggle = page.getByRole('button', { name: '显示文件', exact: true })
          if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
          await artifactLink.click()
          await page.getByRole('region', { name: '文件历史改动', exact: true }).getByRole('button', { name: '预览', exact: true }).click()
        }
        await openArtifact()
        await preview.getByText(artifact, { exact: true }).waitFor()
        await closeActiveFile(page)
        const allSnapshot = page.waitForResponse(
          async response =>
            response.url().endsWith('/link/api/snapshot')
            && response.ok()
            && ((await response.json()) as { device: { dataScope: string } }).device.dataScope === 'all',
        )
        expect((await owner.confirmed('devices/' + device.id, { method: 'PATCH', body: { dataScope: 'all' } })).status).toBe(200)
        await allSnapshot
        await settleShell(page)
        await showList(page, width)
        await page
          .getByRole('region', { name: '预览权限项目', exact: true })
          .getByRole('button', { name: '在 预览权限项目 中新建会话', exact: true })
          .click()
        await page.keyboard.press('Alt+Shift+e')
        const tree = page.getByRole('region', { name: '项目文件', exact: true })
        await tree.getByRole('treeitem', { name: privateName, exact: true }).click()
        const frame = kind === 'docx' ? page.frameLocator('iframe[title="文档预览"]') : undefined
        if (frame) await frame.getByText(marker, { exact: true }).waitFor()
        else await preview.getByText(marker, { exact: true }).waitFor()
        const originalFrame = kind === 'docx' ? page.frames().find(frame => frame.url().includes('/preview-frame/office.html')) : undefined
        if (kind === 'docx') expect(originalFrame).toBeDefined()
        let metaRequests = 0
        page.on('request', request => {
          if (/\/link\/api\/files\/[^/]+\/meta$/u.test(request.url())) metaRequests++
        })
        await page.evaluate(() => {
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
        })
        expect(await page.evaluate(() => document.hidden)).toBe(true)
        const scopeSnapshot = page.waitForResponse(
          async response =>
            response.url().endsWith('/link/api/snapshot')
            && response.request().method() === 'GET'
            && response.ok()
            && ((await response.json()) as { device: { dataScope: string } }).device.dataScope === 'work',
        )
        expect((await owner.request('devices/' + device.id, { method: 'PATCH', body: { dataScope: 'work' } })).status).toBe(200)
        await scopeSnapshot
        // This fails on the old authority lifecycle even though the Host already rejected further access.
        await expect.poll(() => page.getByText(marker, { exact: true }).count()).toBe(0)
        await expect.poll(() => page.locator('iframe[title="文档预览"]').count()).toBe(0)
        if (originalFrame) expect(originalFrame.isDetached()).toBe(true)
        expect(metaRequests).toBe(0)
        const requests: string[] = []
        page.on('request', request => {
          if (request.method() === 'POST' && request.url().endsWith('/tasks/' + created.sessionId + '/files/resolve'))
            requests.push('resolve')
          else if (request.method() === 'GET' && /\/link\/api\/files\/[A-Za-z0-9_-]{22}(?:\?|$)/u.test(request.url()))
            requests.push('bytes')
        })
        await showList(page, width)
        await page.locator(`[data-task-id="${created.sessionId}"]`).click()
        const resolved = page.waitForResponse(
          response =>
            response.request().method() === 'POST'
            && response.url().endsWith('/tasks/' + created.sessionId + '/files/resolve')
            && (response.request().postDataJSON() as { paths?: string[] }).paths?.includes('allowed.txt') === true,
        )
        await openArtifact()
        const reauthorized = await resolved
        expect(reauthorized.ok()).toBe(true)
        expect(((await reauthorized.json()) as { files: Array<{ status: string; file: FileMetadata }> }).files[0]?.status).toBe('ok')
        await preview.getByText(artifact, { exact: true }).waitFor()
        expect(requests[0]).toBe('resolve')
        expect(requests).toContain('bytes')
        expect((await owner.json<{ devices: Device[] }>('devices')).devices.find(item => item.id === device.id)?.dataScope).toBe('work')
        expect(metaRequests).toBe(0)
      } finally {
        await context.close()
        await browser.close()
        await host.close()
      }
    },
  )
})
