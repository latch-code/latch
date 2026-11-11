import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot } from '@latch/protocol'
import type { UpdateView } from '../src/core/shell.ts'
import { AboutSettings, UpdateArea, type UpdateActions } from '../src/settings/AboutSettings.tsx'

afterEach(() => {
  vi.unstubAllGlobals()
})

const actions: UpdateActions = { check() {}, download() {}, install() {}, cancelWaiting() {}, setAutoDownload() {} }
const release: NonNullable<UpdateView['release']> = {
  version: '0.2.0',
  publishedAt: '2026-11-12T00:00:00.000Z',
  notes: { 'zh-CN': '更快的启动。', en: 'Faster start.' },
  size: 52 * 1024 * 1024,
  plan: 'host',
  incompatiblePlugins: [],
}
const view = (overrides: Partial<UpdateView>): UpdateView => ({
  state: 'idle',
  appVersion: '0.1.0',
  autoDownload: true,
  installAtQuit: false,
  heldPlugins: [],
  ...overrides,
})
const render = (value: UpdateView, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(UpdateArea, { view: value, actions, ...extra }))
/** The text of the primary buttons: blue is for the one action that moves the update on. */
const primaries = (html: string) => [...html.matchAll(/data-variant="primary"[^>]*>(?:<[^>]+>)*([^<]+)/gu)].map(match => match[1])

describe('the update area', () => {
  it('says why a source run cannot update itself and offers nothing to do', () => {
    const html = render(view({ state: 'unsupported', reason: 'development' }))
    expect(html).toContain('源码运行，不支持自动更新')
    expect(html).not.toContain('检查更新')
    expect(html).not.toContain('自动下载更新')
  })

  it('checks, then says it is up to date', () => {
    expect(render(view({ state: 'idle' }))).toContain('检查更新')
    expect(render(view({ state: 'checking' }))).toContain('正在检查…')
    const html = render(view({ state: 'up-to-date', checkedAt: new Date().toISOString() }))
    expect(html).toContain('已是最新版本')
    expect(primaries(html)).toEqual([])
  })

  it('offers the download with its size and Chinese notes', () => {
    const html = render(view({ state: 'available', release }))
    expect(html).toContain('新版本 0.2.0')
    expect(html).toContain('52 MB')
    expect(html).toContain('更快的启动。')
    expect(primaries(html)).toEqual(['下载'])
    expect(html).not.toContain('Faster start.')
  })

  it('shows progress while downloading', () => {
    const html = render(view({ state: 'downloading', release, progress: { received: 26 * 1024 * 1024, total: release.size } }))
    expect(html).toContain('正在下载 0.2.0')
    expect(html).toContain('26 MB / 52 MB')
    expect(html).toContain('role="meter"')
  })

  it('offers restart and install, later and install on next quit when ready', () => {
    const html = render(view({ state: 'ready', release }))
    expect(primaries(html)).toEqual(['重启并安装'])
    expect(html).toContain('稍后')
    expect(html).toContain('下次退出时安装')
    expect(html).toContain('包含 Latch 服务的更新')
    expect(html.split('包含 Latch 服务的更新')).toHaveLength(2)
    const chosen = render(view({ state: 'ready', release: { ...release, plan: 'app' }, installAtQuit: true }))
    expect(chosen).toContain('将在下次退出 Latch 时安装')
    expect(primaries(chosen)).toEqual([])
    expect(render(view({ state: 'ready', release: { ...release, plan: 'app' } }))).toContain('只重启 Latch 应用，会话不受影响')
  })

  it('waits in amber for the sessions it names, with a way to see them and to cancel', () => {
    const html = render(
      view({ state: 'waiting', release, waiting: { count: 3, running: 1, waiting: 1, unknown: 0, queued: 0, terminals: 1, services: 2 } }),
      {
        onOpenSession: () => {},
      },
    )
    expect(html).toContain('data-tone="waiting"')
    expect(html).toContain('等 3 项结束')
    expect(html).toContain('运行中 1 · 等你处理 1 · 终端命令 1 · 本地服务 2（随终端结束）')
    expect(html).toContain('查看')
    expect(html).toContain('取消')
    expect(primaries(html)).toEqual([])
  })

  it('says what failed, that this version keeps working, and offers a retry', () => {
    const cases: Array<[NonNullable<UpdateView['failure']>, string]> = [
      [{ stage: 'check', code: 'offline' }, '无法检查更新，当前版本照常可用'],
      [{ stage: 'check', code: 'signature' }, '更新信息无法验证，已忽略'],
      [{ stage: 'download', code: 'interrupted' }, '下载中断，当前版本照常可用'],
      [{ stage: 'verify', code: 'hash-mismatch' }, '下载的文件校验失败，已删除，没有安装'],
      [{ stage: 'install', code: 'installer-failed' }, '安装没有完成，当前版本照常可用，数据未改动'],
      [{ stage: 'install', code: 'host-external' }, '不是由 Latch 应用启动的'],
    ]
    for (const [failure, text] of cases) {
      const html = render(view({ state: 'failed', failure, release }))
      expect(html, failure.code).toContain(text)
      expect(html).toContain('data-tone="failed"')
      expect(html).toContain('重试')
    }
  })

  it('lists plugins the new version turns off, and those an update turned off', () => {
    const html = render(
      view({
        state: 'ready',
        release: { ...release, incompatiblePlugins: [{ id: 'a', name: '日报' }] },
        heldPlugins: [{ id: 'b', name: '周报' }],
      }),
    )
    expect(html).toContain('这些插件与新版本不兼容，安装后会停用，资产保留：日报')
    expect(html).toContain('更新后已停用不兼容的插件：周报')
  })
})

describe('the About page', () => {
  const snapshot = {
    version: '0.1.0',
    hostName: 'Studio',
    tasks: [],
    host: { hostId: 'h', presence: { status: 'available' }, devMode: false },
  } as unknown as AppSnapshot
  const page = (local: boolean) => renderToStaticMarkup(createElement(AboutSettings, { snapshot, access: { legacy: false, local } }))

  it('shows only the Host’s version in a browser or on a phone, with nothing to install', () => {
    const html = page(false)
    expect(html).toContain('版本 0.1.0')
    expect(html).not.toContain('检查更新')
    expect(html).not.toContain('Latch 应用')
  })
})
