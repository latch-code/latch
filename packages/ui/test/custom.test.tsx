import { afterEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { Badge, Button, Checkbox, CUSTOM_TOKENS, InlineNotice, Kbd, StatusWord, Switch, TextField } from '../src/index.ts'

/*
 * A customisation writes values of CUSTOM_TOKENS on the root, in the `custom` layer, and nothing else. These tests
 * write far worse than a valid document ever could (every token, on the root, on every ancestor and on the elements
 * themselves) and compare what a security surface or a pinned mark computes before and after.
 */

const PROPERTIES = [
  'color',
  'backgroundColor',
  'borderTopColor',
  'borderBottomColor',
  'borderTopLeftRadius',
  'borderTopRightRadius',
  'borderBottomLeftRadius',
  'borderBottomRightRadius',
  'boxShadow',
  'outlineColor',
  'fontSize',
  'lineHeight',
  'fontFamily',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'marginTop',
  'marginLeft',
  'rowGap',
  'columnGap',
  'width',
  'height',
  'minHeight',
  'opacity',
  'display',
  'visibility',
  'fill',
  'stroke',
] as const

/** What an element and everything in it computes, with the two pseudo-elements and the customisable tokens themselves. */
function computed(root: Element): string[] {
  const rows: string[] = []
  for (const element of [root, ...root.querySelectorAll('*')])
    for (const pseudo of [undefined, '::before', '::after']) {
      const style = getComputedStyle(element, pseudo)
      rows.push(
        [...PROPERTIES.map(name => style[name]), ...(pseudo ? [] : CUSTOM_TOKENS.map(name => style.getPropertyValue(name).trim()))].join(
          '|',
        ),
      )
    }
  return rows
}

/** A value no document could carry, by what the token holds. */
function hostile(name: string, round: 0 | 1): string {
  if (name.startsWith('--sh-')) return round === 0 ? 'none' : '0 0 0 9999px rgb(255, 0, 0)'
  if (/^--(?:r|fs|lh|density)-/u.test(name)) return round === 0 ? '0px' : '400px'
  return round === 0 ? 'transparent' : 'rgb(255, 0, 0)'
}

function inject(round: 0 | 1): () => void {
  const declarations = (important: boolean) =>
    CUSTOM_TOKENS.map(name => `${name}: ${hostile(name, round)}${important ? ' !important' : ''};`).join(' ')
  const style = document.createElement('style')
  style.textContent = `
    @layer custom { :root { ${declarations(false)} } }
    :root, body { ${declarations(true)} }
    * { ${declarations(true)} }
    @layer security { :root, * { ${declarations(true)} } }`
  document.head.append(style)
  const inline = [document.documentElement, document.body]
  for (const element of inline) for (const name of CUSTOM_TOKENS) element.style.setProperty(name, hostile(name, round))
  return () => {
    style.remove()
    for (const element of inline) for (const name of CUSTOM_TOKENS) element.style.removeProperty(name)
  }
}

function Controls() {
  return (
    <>
      <Button variant="primary">允许</Button>
      <Button variant="secondary">拒绝</Button>
      <Button variant="ghost" size="xs">
        详情
      </Button>
      <Button variant="danger">移除</Button>
      <Switch label="可以批准" checked onCheckedChange={() => {}} />
      <Checkbox label="记住" checked onChange={() => {}} />
      <TextField label="名称" value="手机" onChange={() => {}} />
      <StatusWord tone="waiting">等你处理</StatusWord>
      <StatusWord tone="running">运行中</StatusWord>
      <StatusWord tone="failed">失败</StatusWord>
      <Badge>R2</Badge>
      <Kbd>⌘⏎</Kbd>
      <InlineNotice tone="warn" title="结果未知" action={<Button size="xs">重试同一请求</Button>}>
        可能已经执行
      </InlineNotice>
    </>
  )
}

function Surfaces() {
  return (
    <div id="ancestor">
      <section id="secure" data-secure="">
        <Controls />
        <InlineNotice tone="error" secure title="没有连接">
          重新连接后再批准
        </InlineNotice>
      </section>
      <section id="pinned" data-lock="">
        <Controls />
      </section>
      <section id="marks">
        <StatusWord tone="warn">不先问你</StatusWord>
        <StatusWord tone="warn">权限没确认</StatusWord>
        <StatusWord tone="warn">来自外部内容</StatusWord>
        <StatusWord tone="warn">结果未知</StatusWord>
        <StatusWord tone="waiting">等你处理</StatusWord>
        <StatusWord tone="failed">失败</StatusWord>
        <InlineNotice tone="warn" title="结果未知">
          重试沿用同一请求
        </InlineNotice>
        <InlineNotice tone="error" title="没有保存">
          请重试
        </InlineNotice>
        {/* A bare button takes its text from its parent (`font: inherit`), which follows the customised root. */}
        <button type="button" data-lock="">
          结果未知 · 重试
        </button>
      </section>
      <section id="free">
        <Button variant="primary">发送</Button>
        <StatusWord tone="running">运行中</StatusWord>
        <StatusWord tone="neutral">已停用</StatusWord>
        <InlineNotice tone="neutral">已保存</InlineNotice>
      </section>
    </div>
  )
}

const PINNED = ['#secure', '#pinned', '#marks > *']

describe('customisation and the security surfaces', () => {
  let restore: (() => void) | undefined
  afterEach(() => {
    restore?.()
    restore = undefined
    delete document.documentElement.dataset.theme
    delete document.documentElement.dataset.density
  })

  for (const theme of ['light', 'dark'] as const)
    for (const round of [0, 1] as const)
      it(`computes the same on every security surface and pinned mark under hostile token values (${theme}, round ${round})`, async () => {
        document.documentElement.dataset.theme = theme
        await render(<Surfaces />)
        const targets = PINNED.flatMap(selector => [...document.querySelectorAll(selector)])
        expect(targets.length).toBeGreaterThanOrEqual(10)
        const before = targets.map(computed)
        const free = document.querySelector('#free')!
        const freeBefore = computed(free)
        restore = inject(round)
        const ancestor = document.querySelector<HTMLElement>('#ancestor')!
        for (const name of CUSTOM_TOKENS) ancestor.style.setProperty(name, hostile(name, round))
        expect(targets.map(computed)).toEqual(before)
        // The same injection does change what is not pinned: the comparison above is not vacuous.
        expect(computed(free)).not.toEqual(freeBefore)
      })

  it('pins the words that speak of safety or wait for the person, and no others', async () => {
    await render(<Surfaces />)
    const pinned = (selector: string) =>
      [...document.querySelectorAll(selector)].map(element => element.closest('[data-secure], [data-lock]') !== null)
    expect(pinned('#marks > *')).toEqual([true, true, true, true, true, true, true, true, true])
    expect(pinned('#free > *')).toEqual([false, false, false, false])
    // A pinned mark is not a security surface: nothing treats it as one (the background layer, plugin pages).
    expect(document.querySelectorAll('#marks [data-secure], #pinned [data-secure]').length).toBe(0)
  })

  it('gives a locked button the product size, not the one its parent inherited from a customised root', async () => {
    await render(<Surfaces />)
    const button = document.querySelector<HTMLElement>('#marks > button')!
    const size = () => [getComputedStyle(button).fontSize, getComputedStyle(button).lineHeight]
    expect(size()).toEqual(['14px', '20px'])
    document.documentElement.style.setProperty('--fs-ui', '15px')
    document.documentElement.style.setProperty('--lh-ui', '22px')
    try {
      // The page around it follows the root; the locked button does not.
      expect(getComputedStyle(document.querySelector('#free')!).fontSize).toBe('15px')
      expect(size()).toEqual(['14px', '20px'])
    } finally {
      document.documentElement.style.removeProperty('--fs-ui')
      document.documentElement.style.removeProperty('--lh-ui')
    }
  })

  it('keeps the product density inside a pinned part of a compact page', async () => {
    await render(<Surfaces />)
    document.documentElement.dataset.density = 'compact'
    const row = (selector: string) => getComputedStyle(document.querySelector(selector)!).getPropertyValue('--density-row').trim()
    expect([row('#free'), row('#pinned'), row('#marks > *')]).toEqual(['8px', '12px', '12px'])
  })
})
