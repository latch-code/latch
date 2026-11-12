import { describe, expect, it } from 'vitest'
import { BrowserLabels } from '../src/plugins/tools/browser/labels.ts'

const TAB = `brw_${'a'.repeat(22)}`

describe('the label on a browser approval card', () => {
  it('names the page and the element from what the last read said', () => {
    const labels = new BrowserLabels()
    // Before any read it says what it can: the reference.
    expect(labels.summary('browser_click', { tabId: TAB, ref: 'e1' })).toBe('点击 e1')
    labels.learn('browser_open', { url: '5173' }, `已在 ${TAB} 打开 http://localhost:5173/：“页”`)
    labels.learn(
      'browser_read',
      { tabId: TAB },
      '页面："设置" http://localhost:5173/settings\n- button "保存" [e1]\n- textbox "名字" [e2]\n- checkbox [e3]',
    )
    expect(labels.summary('browser_click', { tabId: TAB, ref: 'e1' })).toBe('在 localhost:5173 点击 "保存"')
    expect(labels.summary('browser_click', { tabId: TAB, ref: 'e3', double: true })).toBe('在 localhost:5173 双击 checkbox')
    expect(labels.summary('browser_type', { tabId: TAB, ref: 'e2', text: 'Latch 测试', submit: true })).toBe(
      '在 localhost:5173 往 "名字" 输入 8 个字并按回车',
    )
    expect(labels.summary('browser_key', { tabId: TAB, key: 'Enter' })).toBe('在 localhost:5173 按 Enter')
    expect(labels.summary('browser_navigate', { tabId: TAB, action: 'reload' })).toBe('在 localhost:5173 重新载入')
    // A tool that only reads has nothing to add to its title.
    expect(labels.summary('browser_read', { tabId: TAB })).toBeUndefined()
    // A new document voids the old references.
    labels.learn('browser_navigate', { tabId: TAB, url: 'http://localhost:3000/' }, '已打开')
    expect(labels.summary('browser_click', { tabId: TAB, ref: 'e1' })).toBe('在 localhost:3000 点击 e1')
  })

  it('cuts a long name the page gave short', () => {
    const labels = new BrowserLabels()
    labels.learn('browser_read', { tabId: TAB }, `页面："x" http://localhost:5173/\n- button "${'很'.repeat(80)}" [e1]`)
    expect(labels.summary('browser_click', { tabId: TAB, ref: 'e1' })).toBe(`在 localhost:5173 点击 "${'很'.repeat(39)}…"`)
  })
})
