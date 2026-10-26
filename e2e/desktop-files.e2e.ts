import { strToU8, zipSync } from 'fflate'
import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HarnessPlugin } from '@latch/sdk'
import { writeHostState } from '@latch/host/host-state'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { startTestHost } from './helpers/host.ts'

/** What the test records in main instead of showing Finder or Quick Look, opening an app or the browser. */
interface ShellRecord {
  shown: string[]
  previewed: Array<[string, string]>
  opened: string[]
  external: string[]
}

const PEM_HEADER = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ')
const REPLY = [
  '已完成：',
  '',
  '- [deck.pptx](out/deck.pptx)',
  '- [paper.pdf](out/paper.pdf)',
  '- [letter.docx](letter.docx)',
  '- [page.html](page.html)',
  '- [.env](.env)',
  '- [outside.md](../outside.md)',
  '- [missing.md](missing.md)',
  '- [slow.md](slow.md)',
  '',
  '同一份演示文稿也在 `out/deck.pptx`；构建用 `npm run build`，`notes.ts` 还没有写。',
].join('\n')
/** How long the Host takes to resolve slow.md, so the menu opens with 「正在检查…」 first. */
const SLOW_MS = 2_500

function shellEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(desktopShellEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition')
    await new Promise(done => setTimeout(done, 100))
  }
}

async function captureThemes(page: Page, name: string) {
  await page.screenshot({ path: `test-results/${name}.png`, animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: `test-results/${name}-dark.png`, animations: 'disabled' })
  await page.emulateMedia({ colorScheme: 'light' })
}

describe.skipIf(process.env.HARNESS_ELECTRON_E2E !== '1' || process.platform !== 'darwin')('native desktop shell: files in a reply', () => {
  it('shows, previews and opens only what the Host allowed, with the real path, after the audit, and never navigates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-electron-files-'))
    const plugin: HarnessPlugin = {
      id: 'e2e-desktop-files',
      name: '文件引用测试模型',
      version: '1.0.0',
      description: '只在测试中使用。',
      activate(context) {
        context.registerProvider({
          id: 'e2e-desktop-files',
          name: '文件引用测试模型',
          model: 'e2e',
          async *stream() {
            yield { type: 'text', text: REPLY }
            yield { type: 'finish', reason: 'stop' }
          },
        })
      },
    }
    const testHost = await startTestHost({
      demo: true,
      uiDir: resolve('dist/web'),
      presenceMode: 'manual',
      plugins: [plugin],
      fileHooks: {
        async afterResolve(path) {
          if (path.endsWith('slow.md')) await new Promise(done => setTimeout(done, SLOW_MS))
        },
      },
    })
    const { host } = testHost
    let application: ElectronApplication | undefined
    try {
      const workspace = await realpath(testHost.workspaceRoot)
      await mkdir(join(workspace, 'out'), { recursive: true })
      await writeFile(join(workspace, 'out', 'deck.pptx'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]))
      await writeFile(join(workspace, 'out', 'paper.pdf'), '%PDF-1.7\n')
      await writeFile(
        join(workspace, 'letter.docx'),
        zipSync({
          '[Content_Types].xml': strToU8(
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
          ),
          '_rels/.rels': strToU8(
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="doc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
          ),
          'word/document.xml': strToU8(
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Desktop document</w:t></w:r></w:p><w:sectPr/></w:body></w:document>',
          ),
        }),
      )
      await writeFile(join(workspace, 'page.html'), '<p>x</p>')
      await writeFile(join(workspace, '.env'), `KEY=1\n${PEM_HEADER}\n`)
      await writeFile(join(workspace, '..', 'outside.md'), '# outside')
      await writeFile(join(workspace, 'slow.md'), '# slow')
      await writeHostState(testHost.dataDir, {
        version: 2,
        pid: process.pid,
        hostId: host.hostId,
        instanceId: host.instanceId,
        socketPath: host.socketPath,
        loopbackOrigin: host.loopbackOrigin,
        tlsOrigin: host.tlsOrigin ?? null,
        startedAt: new Date().toISOString(),
        dataDir: testHost.dataDir,
      })
      await mkdir('test-results', { recursive: true })
      application = await _electron.launch({
        args: [
          resolve('apps/desktop/src/main.cjs'),
          `--latch-host-state=${join(testHost.dataDir, 'host.json')}`,
          `--latch-user-data=${join(root, 'electron')}`,
          '--use-mock-keychain',
        ],
        cwd: process.cwd(),
        env: shellEnvironment(),
        timeout: 30_000,
      })
      const page = await application.firstWindow()
      page.setDefaultTimeout(20_000)
      // The preload exposes the file actions next to the folder actions, as functions only.
      expect(
        await page.evaluate(() => {
          const shell: { files: object } = Reflect.get(globalThis, 'latchShell')
          return { files: Object.keys(shell.files), frozen: Object.isFrozen(shell.files) }
        }),
      ).toEqual({ files: ['protocolVersion', 'inspect', 'known', 'reveal', 'quickLook', 'open'], frozen: true })

      await page.getByRole('heading', { name: '连接到 Latch' }).waitFor()
      await page.getByRole('textbox', { name: '设备名称' }).fill('桌面端文件')
      await page.getByRole('button', { name: '请求本机确认' }).click()
      await testHost.presence.waitForRequest(15_000)
      testHost.presence.approveNext()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()

      // Finder, Quick Look, the default app and the browser are recorded in main instead of being used.
      await application.evaluate(({ BrowserWindow, shell }) => {
        const record: ShellRecord = { shown: [], previewed: [], opened: [], external: [] }
        Object.assign(globalThis, { shellRecord: record })
        shell.showItemInFolder = (path: string) => {
          record.shown.push(path)
        }
        shell.openPath = async (path: string) => {
          record.opened.push(path)
          return ''
        }
        shell.openExternal = async (url: string) => {
          record.external.push(url)
        }
        BrowserWindow.prototype.previewFile = function previewFile(path: string, name?: string) {
          record.previewed.push([path, name ?? ''])
        }
      })
      const record = () => application!.evaluate((): ShellRecord => Reflect.get(globalThis, 'shellRecord'))

      const { sessionId } = await host.bridge.createTask({
        prompt: '生成文件',
        requestId: randomUUID(),
        mode: 'chat',
        model: { providerId: 'e2e-desktop-files', model: 'e2e' },
      })
      await waitFor(async () => (await host.bridge.detail(sessionId)).summary.status === 'idle')
      await page.locator(`[data-task-id="${sessionId}"]`).click()
      // A chip by its whole text: `deck.pptx` (a link) and `out/deck.pptx` (inline code) are two chips.
      const chip = (name: string) =>
        page.locator('[data-file-chip]').filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'u') })
      await chip('deck.pptx').waitFor()
      const start = page.url()
      // Each chip has its own menu, named after the file; a closing one may still be fading out.
      const menuOf = (name: string) => page.getByRole('menu', { name: `文件：${name.slice(name.lastIndexOf('/') + 1)}`, exact: true })
      let menu = menuOf('deck.pptx')
      const open = async (name: string) => {
        menu = menuOf(name)
        await chip(name).click({ button: 'right' })
        await menu.waitFor()
      }
      const close = async () => {
        await page.keyboard.press('Escape')
        await menu.waitFor({ state: 'hidden' })
      }
      const items = () => menu.getByRole('menuitem').allTextContents()
      const choose = async (name: string, item: string) => {
        await open(name)
        await menu.getByRole('menuitem', { name: item, exact: true }).click()
        await menu.waitFor({ state: 'hidden' })
        // Main takes one native action at a time, at least 500 ms apart.
        await new Promise(done => setTimeout(done, 600))
      }

      // Inline code that names a file becomes a chip once the Host says so; other code stays code.
      await chip('out/deck.pptx').waitFor()
      await page.locator('.message-content code').filter({ hasText: 'npm run build' }).waitFor()
      await page.locator('.message-content code').filter({ hasText: 'notes.ts' }).waitFor()
      await open('out/deck.pptx')
      expect(await items()).toEqual(['用默认应用打开', '在访达中显示', '复制路径'])
      await close()

      // A PDF: every action, in the order of the menu, and the path to copy.
      await open('paper.pdf')
      expect(await items()).toEqual(['快速查看', '用默认应用打开', '在访达中显示', '复制路径'])
      await captureThemes(page, 'native-desktop-file-menu')
      await close()
      const paper = join(workspace, 'out', 'paper.pdf')
      await choose('paper.pdf', '快速查看')
      await waitFor(async () => (await record()).previewed.length === 1)
      expect((await record()).previewed).toEqual([[paper, 'paper.pdf']])
      expect(host.security.audit.lastOf('file.quicklook')).toMatchObject({ target: sessionId, detail: { type: 'pdf' } })
      // A presentation opens with its app; Quick Look is not offered for it yet, and the menu says why.
      await open('deck.pptx')
      expect(await items()).toEqual(['用默认应用打开', '在访达中显示', '复制路径'])
      await menu.getByText('快速查看暂不用于这种文件：还没有确认系统的预览不会加载文件里引用的网络资源。').waitFor()
      await close()
      const deck = join(workspace, 'out', 'deck.pptx')
      await choose('deck.pptx', '用默认应用打开')
      await waitFor(async () => (await record()).opened.length === 1)
      expect((await record()).opened).toEqual([deck])
      expect(host.security.audit.lastOf('file.open')).toMatchObject({
        target: sessionId,
        actor: { listener: 'unix' },
        detail: { type: 'pptx' },
      })
      await choose('deck.pptx', '在访达中显示')
      await waitFor(async () => (await record()).shown.length === 1)
      expect((await record()).shown).toEqual([deck])

      // The primary double click opens the in-app preview, and never invokes a native action.
      await chip('paper.pdf').dblclick()
      await page.getByRole('region', { name: '文件预览', exact: true }).waitFor()
      expect((await record()).previewed).toHaveLength(1)
      await page.getByRole('button', { name: '关闭文件', exact: true }).click()

      // So does a Word document.
      await open('letter.docx')
      expect(await items()).toEqual(['用默认应用打开', '在访达中显示', '复制路径'])
      await close()
      // A web page and a likely secret: shown in Finder only, with one line saying why.
      await open('page.html')
      expect(await items()).toEqual(['在访达中显示', '复制路径'])
      await menu.getByText('网页和 SVG 用浏览器打开时可以联网，Latch 不直接打开；可以在访达中显示后自己打开。').waitFor()
      // The lock marks what Latch refuses on purpose, never a plain failure.
      expect(await menu.locator('.ui-menu-footer-note svg').getAttribute('class')).toContain('lucide-lock')
      await close()
      await open('.env')
      expect(await items()).toEqual(['在访达中显示', '复制路径'])
      await menu.getByText('这个文件可能含密钥，不提供快速查看和打开。').waitFor()
      await captureThemes(page, 'native-desktop-file-menu-secret')
      await close()
      // Outside the session's folder, or not there at all: only the path to copy, and the reason.
      await open('outside.md')
      expect(await items()).toEqual(['复制路径'])
      await menu.getByText('这个文件不在会话的文件夹里，Latch 不替你打开它。复制路径后，可以在访达中按 ⇧⌘G 前往。').waitFor()
      await captureThemes(page, 'native-desktop-file-menu-outside')
      await close()
      // 复制路径 copies the whole path on this computer, from the session's folder, ready for Finder's 「前往文件夹」.
      await page.evaluate(() => {
        const state = window as Window & { copied?: string[] }
        state.copied = []
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async (value: string) => {
              state.copied!.push(value)
            },
          },
        })
      })
      const folder = (await host.bridge.detail(sessionId)).summary.cwd!
      await choose('outside.md', '复制路径')
      await choose('deck.pptx', '复制路径')
      await waitFor(async () => (await page.evaluate(() => (window as Window & { copied?: string[] }).copied?.length)) === 2)
      expect(await page.evaluate(() => (window as Window & { copied?: string[] }).copied)).toEqual([
        join(dirname(folder), 'outside.md'),
        join(folder, 'out', 'deck.pptx'),
      ])
      await open('missing.md')
      await menu.getByText('找不到这个文件。').waitFor()
      expect(await menu.locator('.ui-menu-footer-note svg').getAttribute('class')).toContain('lucide-circle-alert')
      await close()

      // A Host slower than 400 ms: the menu opens with 「正在检查…」 and fills in when the answer comes.
      menu = menuOf('slow.md')
      await chip('slow.md').click({ button: 'right' })
      await menu.waitFor()
      await menu.getByText('正在检查…').waitFor()
      expect(await items()).toEqual(['复制路径'])
      await captureThemes(page, 'native-desktop-file-menu-checking')
      try {
        await menu.getByRole('menuitem', { name: '用默认应用打开', exact: true }).waitFor({ timeout: SLOW_MS + 5_000 })
      } catch (cause) {
        await page.screenshot({ path: 'test-results/native-file-check-failure.png', animations: 'disabled' })
        throw cause
      }
      expect(await menu.getByText('正在检查…').count()).toBe(0)
      await close()

      // An action that fails reopens the menu with the reason, marked as a failure rather than a refusal.
      await application.evaluate(({ shell }) => {
        shell.openPath = async () => 'No application knows how to open this file'
      })
      await new Promise(done => setTimeout(done, 600))
      await open('letter.docx')
      await menu.getByRole('menuitem', { name: '用默认应用打开', exact: true }).click()
      // It closes as the item is chosen and comes back with the reason once main answers.
      await menu.getByText('没有找到能打开这个文件的应用。').waitFor()
      expect(await menu.locator('.ui-menu-footer-note svg').getAttribute('class')).toContain('lucide-circle-alert')
      await captureThemes(page, 'native-desktop-file-menu-failed')
      await close()
      expect(host.security.audit.lastOf('file.open')?.detail).toMatchObject({ type: 'docx' })
      // Main takes the next native action at least 500 ms after this one.
      await new Promise(done => setTimeout(done, 600))

      // A real Office preview loads only the public latch-frame bootstrap and cannot borrow the main bridge.
      await chip('letter.docx').click()
      const frame = page.frameLocator('iframe[title="文档预览"]')
      await frame.getByText('Desktop document', { exact: true }).waitFor()
      const documentFrame = page.frames().find(frame => frame.url().startsWith('latch-frame://preview/office.html'))!
      expect(documentFrame).toBeDefined()
      expect(await documentFrame.evaluate(() => typeof Reflect.get(globalThis, 'latchShell'))).toBe('undefined')
      expect(
        await documentFrame.evaluate(() => {
          try {
            void parent.document.body
            return false
          } catch {
            return true
          }
        }),
      ).toBe(true)
      expect(
        await documentFrame.evaluate(async () => {
          try {
            await fetch('latch://app/link/api/snapshot')
            return false
          } catch {
            return true
          }
        }),
      ).toBe(true)
      await captureThemes(page, 'native-desktop-document-frame')
      await page.getByRole('button', { name: '关闭文件', exact: true }).click()

      // Preview bytes pass through Host adjudication; native actions remain in main.
      const direct = await page.evaluate(async id => {
        const response = await fetch(`/link/api/tasks/${id}/files/resolve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ paths: ['out/deck.pptx'] }),
        })
        const body = (await response.json()) as { files: Array<{ file: { handle: string } }> }
        const handle = body.files[0]!.file.handle
        const bytes = await fetch(`/link/api/files/${handle}`, { headers: { range: 'bytes=0-3' } })
        const local = await fetch(`/link/api/files/${handle}/local`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: id, action: 'open' }),
        })
        return {
          status: response.status,
          bytes: Array.from(new Uint8Array(await bytes.arrayBuffer())),
          range: bytes.headers.get('content-range'),
          contentStatus: bytes.status,
          attachment: bytes.headers.get('content-disposition')?.startsWith('attachment;'),
          nativeStatus: local.status,
          native: await local.json(),
        }
      }, sessionId)
      expect(direct).toEqual({
        status: 200,
        contentStatus: 206,
        bytes: [80, 75, 3, 4],
        range: 'bytes 0-3/8',
        attachment: true,
        nativeStatus: 403,
        native: { error: 'shell-managed', message: '文件操作由 Latch 桌面端管理' },
      })
      const bridge = await page.evaluate(async id => {
        const shell: { files: Record<string, (...args: unknown[]) => Promise<unknown>> } = Reflect.get(globalThis, 'latchShell')
        return {
          escape: await shell.files.open!(id, '../../../../etc/hosts'),
          badSession: await shell.files.open!('../x', 'out/deck.pptx'),
          badHandle: await shell.files.reveal!(id, { handle: '../etc' }),
          notText: await shell.files.inspect!(id, { handle: 'AAAAAAAAAAAAAAAAAAAAAA' }),
          tooMany: await shell.files.known!(
            id,
            Array.from({ length: 65 }, (_, index) => `${index}.md`),
          ),
          known: await shell.files.known!(id, ['out/deck.pptx', 'missing.md', '../outside.md']),
        }
      }, sessionId)
      expect(bridge).toEqual({
        escape: { status: 'refused', code: 'file-outside-folders' },
        badSession: { status: 'failed', code: 'invalid' },
        badHandle: { status: 'failed', code: 'invalid' },
        notText: { status: 'failed', code: 'invalid' },
        tooMany: { status: 'failed', code: 'invalid' },
        known: { status: 'ok', known: ['out/deck.pptx'] },
      })

      expect(page.url()).toBe(start)
      expect(application.windows()).toHaveLength(1)
      const final = await record()
      expect(final.external).toEqual([])
      expect(final.opened).toEqual([deck])
      expect(final.shown).toEqual([deck])

      // A saved project can use real workspace handles before it has any sessions.
      const owner = await testHost.enroll({ listener: 'unix' })
      const projectRoot = join(root, 'standalone-project')
      await mkdir(projectRoot)
      await writeFile(join(projectRoot, 'notes.txt'), 'Workspace preview before the first message.\n')
      const added = await owner.addFolders({ name: '文件项目', paths: [projectRoot] })
      expect(added.status).toBe(201)
      await page.reload()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      await page.getByRole('button', { name: '在 文件项目 中新建会话', exact: true }).click()
      await page.getByRole('button', { name: '浏览项目文件', exact: true }).click()
      const tree = page.getByRole('region', { name: '项目文件', exact: true })
      await tree.getByRole('treeitem', { name: 'notes.txt', exact: true }).click()
      const preview = page.getByRole('region', { name: '文件预览', exact: true })
      await preview.getByText('Workspace preview before the first message.', { exact: true }).waitFor()
      await preview.getByRole('button', { name: '文件操作', exact: true }).click()
      await page.getByRole('menuitem', { name: '在访达中显示', exact: true }).click()
      await waitFor(async () => (await record()).shown.length === 2)
      expect((await record()).shown.at(-1)).toBe(await realpath(join(projectRoot, 'notes.txt')))
      expect((await host.bridge.listTasks()).length).toBe(1)
      await page.screenshot({ path: 'test-results/native-workspace-files.png', animations: 'disabled' })
    } finally {
      await application?.close()
      await testHost.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
