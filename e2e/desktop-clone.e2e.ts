import { _electron, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WorkspaceInfo } from '@latch/protocol'
import { desktopShellEnvironment } from '@latch/host/desktop-host'
import { latchEnv } from '@latch/host/env'
import { writeHostState } from '@latch/host/host-state'
import { startTestHost } from './helpers/host.ts'
import { closeSettings, openSection, openSettings, tooltipText } from './helpers/layout.ts'

const OUT = 'test-results/desktop-clone'

/** The Git the Host's clone runs: found where the Host finds it. */
function hostGit(): string {
  for (const candidate of ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/Library/Developer/CommandLineTools/usr/bin/git'])
    if (existsSync(candidate)) return candidate
  throw new Error('no Git')
}

/**
 * Bare repositories served by a stand-in `ssh` that runs `git upload-pack` on them, on a shell whose PATH starts with it:
 * `git@example.test:<name>.git` goes through Git's ssh transport without a network. While `hang` exists it waits first.
 */
async function servedRepositories(root: string) {
  const served = join(root, 'served'),
    bin = join(root, 'bin'),
    work = join(root, 'work'),
    hang = join(root, 'hang'),
    home = join(root, 'home')
  await Promise.all([served, bin, work, home].map(dir => mkdir(dir)))
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' }
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, stdio: 'ignore' })
  git(work, 'init', '-q', '-b', 'main')
  await writeFile(join(work, 'readme.txt'), 'hello\n')
  git(work, 'add', '.')
  git(work, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'first')
  for (const name of ['widgets.git', 'gadgets.git']) {
    git(served, 'init', '-q', '--bare', '-b', 'main', name)
    git(work, 'push', '-q', join(served, name), 'main')
  }
  const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`
  await writeFile(
    join(bin, 'ssh'),
    [
      '#!/bin/sh',
      `if [ -f ${quote(hang)} ]; then sleep 30; fi`,
      'for last; do :; done',
      `path=$(printf '%s' "$last" | sed -e "s/^git-upload-pack '//" -e "s/'$//")`,
      `cd ${quote(served)} && exec ${quote(hostGit())} upload-pack "$path"`,
      '',
    ].join('\n'),
  )
  await chmod(join(bin, 'ssh'), 0o755)
  await writeFile(join(bin, 'shell'), `#!/bin/sh\nPATH=${quote(`${bin}:/usr/bin:/bin`)}; export PATH\nexec /bin/sh "$@"\n`)
  await chmod(join(bin, 'shell'), 0o755)
  return { home, hang, shell: async () => ({ file: join(bin, 'shell'), argv: ['sh'] }) }
}

describe.skipIf(latchEnv(process.env, 'ELECTRON_E2E') !== '1' || process.platform !== 'darwin')('克隆 in the desktop app', () => {
  it('clones into a project, removes a cancelled clone and adds a source folder from the project menu', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-electron-clone-')))
    const served = await servedRepositories(root)
    const parent = join(root, 'projects')
    const docs = join(root, 'docs')
    await mkdir(parent)
    await mkdir(docs)
    const testHost = await startTestHost({
      demo: true,
      hostName: '项目验收电脑',
      gitDelivery: {
        home: served.home,
        hostEnv: { HOME: served.home, USER: 'tester', PATH: '/usr/bin:/bin', TMPDIR: root },
        shell: served.shell,
      },
    })
    const { host } = testHost
    let application: ElectronApplication | undefined
    try {
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
      await mkdir(OUT, { recursive: true })
      application = await _electron.launch({
        args: [
          resolve('apps/desktop/src/main.cjs'),
          `--latch-host-state=${join(testHost.dataDir, 'host.json')}`,
          `--latch-user-data=${join(root, 'electron')}`,
          '--use-mock-keychain',
        ],
        cwd: process.cwd(),
        env: Object.fromEntries(
          Object.entries(desktopShellEnvironment(process.env)).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
        timeout: 30_000,
      })
      const page = await application.firstWindow()
      page.setDefaultTimeout(20_000)
      await page.getByRole('button', { name: '继续', exact: true }).click()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      await page.reload()
      await page.locator('.app-shell[data-connection="connected"]').waitFor()
      // The open panel answers with the folder chosen; main is recorded instead of showing it, and the window counts as
      // focused (the test runner keeps it in the background).
      await application.evaluate(
        ({ BrowserWindow, dialog }, folders) => {
          const panels: unknown[] = []
          Object.assign(globalThis, { clonePanels: panels })
          dialog.showOpenDialog = async (...args: unknown[]) => {
            const options = args.at(-1) as { buttonLabel: string }
            panels.push(options)
            return { canceled: false, filePaths: [options.buttonLabel === '添加' ? folders.docs : folders.parent] }
          }
          BrowserWindow.prototype.isFocused = () => true
        },
        { parent, docs },
      )

      const settings = await openSettings(page)
      await openSection(settings, '项目')
      const clone = async (url: string) => {
        await settings.getByRole('button', { name: '克隆仓库', exact: true }).click()
        const dialog = page.getByRole('dialog', { name: '克隆仓库' })
        await dialog.getByLabel('仓库地址').fill(url)
        await dialog.getByRole('button', { name: '选择位置…', exact: true }).click()
        await dialog.waitFor({ state: 'detached' })
      }

      await clone('git@example.test:widgets.git')
      // Done: like 添加项目, the new project opens in its editor; back on the list it is a row.
      await settings.locator('.project-editor').getByText('widgets', { exact: true }).first().waitFor({ timeout: 30_000 })
      await page.screenshot({ path: join(OUT, 'cloned-editor.png'), animations: 'disabled' })
      await settings.getByRole('button', { name: '项目', exact: true }).click()
      await settings.locator('.clone-status').getByText('已克隆').waitFor()
      await settings.locator('.project-row', { hasText: 'widgets' }).waitFor()
      await page.screenshot({ path: join(OUT, 'cloned.png'), animations: 'disabled' })
      expect(await readFile(join(parent, 'widgets', 'readme.txt'), 'utf8')).toBe('hello\n')
      expect(existsSync(join(parent, 'widgets', '.git', 'hooks'))).toBe(false)
      const panels = await application.evaluate(() => Reflect.get(globalThis, 'clonePanels') as Array<{ title?: string; message?: string }>)
      expect(panels).toEqual([
        expect.objectContaining({ title: '克隆到', message: expect.stringContaining('git@example.test:widgets.git') }),
      ])
      const { workspaces } = (await await page.evaluate(() => fetch('/link/api/workspaces').then(response => response.json()))) as {
        workspaces: WorkspaceInfo[]
      }
      expect(workspaces.find(item => item.name === 'widgets')?.folders?.map(folder => folder.path)).toEqual([join(parent, 'widgets')])
      expect(host.security.audit.lastOf('workspace.added')).toMatchObject({ detail: { via: 'clone' } })
      expect(host.security.audit.lastOf('git.clone.result')).toMatchObject({ detail: { outcome: 'done' } })

      // A clone that waits on the remote, cancelled: the process ends and the folder it made goes.
      await writeFile(served.hang, '')
      await clone('git@example.test:gadgets.git')
      const status = settings.locator('.clone-status')
      await status.getByText('gadgets').waitFor()
      await expect.poll(() => existsSync(join(parent, 'gadgets')), { timeout: 10_000 }).toBe(true)
      await page.screenshot({ path: join(OUT, 'cloning.png'), animations: 'disabled' })
      await status.getByRole('button', { name: '取消', exact: true }).click()
      await status.getByText('已取消').waitFor({ timeout: 30_000 })
      expect(existsSync(join(parent, 'gadgets'))).toBe(false)
      expect((await readdir(parent)).sort()).toEqual(['widgets'])
      expect(host.security.audit.lastOf('git.clone.result')).toMatchObject({
        detail: { outcome: 'cancelled', code: 'clone-cancelled', removed: true },
      })

      await closeSettings(settings)
      const group = page.getByRole('region', { name: 'widgets', exact: true })
      if (!(await group.isVisible())) await page.getByRole('button', { name: '打开会话列表', exact: true }).click()
      await group.getByRole('button', { name: 'widgets 的项目操作', exact: true }).click()
      const editItem = page.getByRole('menuitem', { name: '编辑项目…', exact: true })
      await editItem.waitFor()
      expect(await page.getByRole('menuitem').allTextContents()).toEqual(['新会话', '编辑项目…'])
      await page.screenshot({ path: join(OUT, 'project-menu.png'), animations: 'disabled' })
      await editItem.click()
      const editor = page.getByRole('dialog', { name: '编辑项目', exact: true })
      const folders = editor.getByRole('list', { name: '源文件夹', exact: true }).getByRole('listitem')
      await folders.first().getByText('widgets', { exact: true }).waitFor()
      await editor.getByRole('button', { name: '添加文件夹…', exact: true }).click()
      await folders.nth(1).getByText('docs', { exact: true }).waitFor()
      expect(await application.evaluate(() => Reflect.get(globalThis, 'clonePanels').at(-1))).toMatchObject({
        title: '添加文件夹到「widgets」',
        properties: ['openDirectory', 'createDirectory', 'multiSelections'],
      })
      await page.screenshot({ path: join(OUT, 'project-edit-added.png'), animations: 'disabled' })
      await editor.getByRole('textbox', { name: '项目名称', exact: true }).fill('discarded rename')
      await editor.getByRole('button', { name: '取消', exact: true }).click()
      await group.getByRole('button', { name: '在 widgets 中新建会话', exact: true }).click()
      await page.getByRole('button', { name: '项目摘要：widgets', exact: true }).click()
      const summary = page.getByRole('dialog', { name: '项目摘要：widgets', exact: true })
      const locations = summary.getByRole('listitem')
      await locations.first().locator('.project-summary-branch').getByText('main', { exact: true }).waitFor()
      const ordinary = locations.nth(1)
      const name = ordinary.locator('.project-summary-location')
      expect((await name.innerText()).trim()).toBe('docs')
      expect(await ordinary.locator('.project-summary-branch, .latch-glyph-branch, details').count()).toBe(0)
      const rowHeight = await ordinary.evaluate(row => row.clientHeight)
      expect(await tooltipText(page, name)).toBe(await realpath(docs))
      expect(await ordinary.evaluate(row => row.clientHeight)).toBe(rowHeight)
      expect(await summary.getByRole('button', { name: '添加文件夹…', exact: true }).count()).toBe(0)
      await page.screenshot({ path: join(OUT, 'project-summary-added.png'), animations: 'disabled' })
    } finally {
      await application?.close()
      await testHost.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 180_000)
})
