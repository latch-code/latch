// 检查更新 in the sidebar's foot (`shell/UpdateCheck.tsx`, `core/build.ts`): the page's build against the one the Host
// serves now and the one it started beside, and the desktop app's own updater; one answer, its icon state and the one
// thing it offers.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildStatus, buildStatusWords, readServedBuild, type BuildStatus } from '../src/core/build.ts'
import { UpdateCheckBody } from '../src/shell/UpdateCheck.tsx'

afterEach(() => {
  vi.unstubAllGlobals()
})

const page = '20261116T101500Z-abcdef'
const older = '20261115T080000Z-123456'
const newer = '20261116T120000Z-fedcba'
const status = (input: Partial<Parameters<typeof buildStatus>[0]>) =>
  buildStatus({ page, host: page, served: page, checking: false, ...input })
const body = (value: BuildStatus, extra: { restart?: () => void; openAbout?: () => void } = {}) =>
  renderToStaticMarkup(createElement(UpdateCheckBody, { status: value, computer: '这台 Mac', ...extra }))

describe('检查更新', () => {
  it('is quiet and names the build when page, Host and served page are the same', () => {
    const current = status({})
    expect(current).toEqual({ kind: 'current', build: page })
    expect(buildStatusWords(current)).toEqual({ tooltip: '已是最新 · 构建 abcdef', dot: false })
    expect(body(current)).toContain('已是最新')
    expect(body(current)).not.toContain('<button')
  })

  it('spins while it checks, whether the read or the desktop updater is still out', () => {
    expect(status({ checking: true }).kind).toBe('checking')
    expect(status({ app: { state: 'checking' } }).kind).toBe('checking')
    expect(buildStatusWords({ kind: 'checking' }).dot).toBe(false)
  })

  it('offers a reload when the Host serves a newer page than this one, or started beside one', () => {
    for (const value of [status({ served: newer }), status({ host: newer, served: newer })]) {
      expect(value).toEqual({ kind: 'page' })
      expect(buildStatusWords(value).dot).toBe(true)
      expect(body(value)).toMatch(/有新版页面.*重新载入<\/button>/u)
    }
  })

  it('offers 重启 Latch only where the app on that Mac can restart its Host, and says how elsewhere', () => {
    const value = status({ host: older })
    expect(value).toEqual({ kind: 'host' })
    expect(buildStatusWords(value)).toEqual({ tooltip: 'Latch 服务是旧版本 · 重启 Latch', dot: true })
    const app = body(value, { restart: () => {} })
    expect(app).toContain('这台 Mac 上的 Latch 还是旧版本')
    expect(app).toMatch(/重启 Latch<\/button>/u)
    const browser = body(value)
    expect(browser).not.toMatch(/重启 Latch<\/button>/u)
    expect(browser).toContain('重启 Latch 后才能用新功能')
  })

  it('hands a release of the desktop app to Settings › 关于, before anything about builds', () => {
    for (const state of ['available', 'downloading', 'ready', 'waiting', 'installing'] as const) {
      const value = status({ host: older, app: { state, version: '0.2.0' } })
      expect(value).toEqual({ kind: 'app', version: '0.2.0' })
      expect(buildStatusWords(value)).toEqual({ tooltip: 'Latch 0.2.0 可更新', dot: true })
    }
    expect(body({ kind: 'app', version: '0.2.0' }, { openAbout: () => {} })).toMatch(/0\.2\.0 可更新.*查看<\/button>/u)
    // Nothing on its way: the builds decide.
    expect(status({ app: { state: 'up-to-date' } }).kind).toBe('current')
    expect(status({ app: { state: 'failed' } }).kind).toBe('current')
  })

  it('compares nothing in a page without a build, and says when the served build could not be read', () => {
    expect(status({ page: '', host: undefined })).toEqual({ kind: 'dev' })
    expect(buildStatusWords({ kind: 'dev' }).dot).toBe(false)
    const failed = status({ served: null })
    expect(failed).toEqual({ kind: 'failed', build: page })
    expect(buildStatusWords(failed)).toEqual({ tooltip: '未能检查 · 构建 abcdef', dot: false })
    // Before the first read, nothing has failed.
    expect(status({ served: undefined }).kind).toBe('current')
  })

  it('reads the served build afresh and takes only a build ID', async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    const answer = (value: unknown, ok = true) =>
      vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        calls.push([url, init])
        return { ok, json: async () => value }
      })
    answer({ build: newer })
    expect(await readServedBuild()).toBe(newer)
    expect(calls[0]).toEqual(['/link/build.json', { cache: 'no-store', credentials: 'same-origin' }])
    answer({ build: 'latest' })
    expect(await readServedBuild()).toBeNull()
    answer({ build: newer }, false)
    expect(await readServedBuild()).toBeNull()
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline')
    })
    expect(await readServedBuild()).toBeNull()
  })
})
