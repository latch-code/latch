import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const { createLocale } = require('../src/locale.cjs')
const { menuTemplate } = require('../src/menu.cjs')
const { externalLinkDialog } = require('../src/proxy.cjs')

it('uses the language in the native menu and dialog and remembers a validated choice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'latch-desktop-locale-'))
  const menu = () => menuTemplate({ packaged: true, onCheckForUpdates: () => {} })
  try {
    let languages = ['en-US', 'zh-TW']
    const locale = createLocale(directory, () => languages)
    await locale.load()
    expect(menu()[1].label).toBe('Edit')
    languages = ['fr', 'zh-TW', 'en-US']
    expect(locale.set('system', 'en')).toBe(true)
    expect(menu()[0].submenu).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'check-for-updates', label: '检查更新…' })]))
    expect(locale.set('en', 'zh-CN')).toBe(false)
    expect(locale.set('untrusted text', 'en')).toBe(false)
    expect(locale.set('en', 'en')).toBe(true)
    expect(menu()[0].submenu).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'check-for-updates', label: 'Check for Updates…' })]),
    )
    expect(externalLinkDialog('https://example.test/')).toMatchObject({
      detail: 'https://example.test/',
      buttons: ['Open', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    })

    await expect.poll(() => readFile(join(directory, 'locale.json'), 'utf8').catch(() => '')).toBe('"en"')
    await createLocale(directory, () => ['zh-CN']).load()
    expect(menu()[1].label).toBe('Edit')
  } finally {
    await rm(directory, { recursive: true, force: true })
    await createLocale(directory, () => ['zh-CN']).load()
  }
})
