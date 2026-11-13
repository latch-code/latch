import { useLayoutEffect, useState, type CSSProperties } from 'react'
import { flushSync } from 'react-dom'
import { describe, expect, it, vi } from 'vitest'
import { cdp, commands, page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { Button, InlineNotice, PlusGlyph } from '../src/index.ts'
import { emulateMedia, press } from './helpers.ts'

const painted = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
const width = (element: Element) => element.getBoundingClientRect().width

describe('button width while work is pending', () => {
  it('does not force a measurement on unchanged buttons during unrelated parent commits', async () => {
    let update: (value: number) => void
    function StreamingParent() {
      const [tick, setTick] = useState(0)
      useLayoutEffect(() => {
        update = setTick
      }, [])
      return (
        <section style={{ width: tick % 2 ? 960 : 1000 }}>
          <p>{'Streaming words '.repeat((tick % 10) + 1)}</p>
          {Array.from({ length: 16 }, (_, index) => (
            <Button key={index}>Action {index}</Button>
          ))}
        </section>
      )
    }
    const screen = await render(<StreamingParent />)
    await painted()
    const buttons = Array.from(screen.container.querySelectorAll<HTMLButtonElement>('button'))
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!
    let reads = 0
    for (const button of buttons)
      Object.defineProperty(button, 'offsetWidth', {
        configurable: true,
        get() {
          reads++
          return original.get!.call(this)
        },
      })
    const samples: number[] = []
    try {
      await cdp().send('Emulation.setCPUThrottlingRate', { rate: 4 })
      for (let tick = 1; tick <= 50; tick++) {
        const start = performance.now()
        flushSync(() => update(tick))
        samples.push(performance.now() - start)
        await painted()
      }
      const sorted = samples.toSorted((a, b) => a - b)
      await commands.writeFile(
        'test-results/button-width/performance.json',
        JSON.stringify(
          {
            cpuRate: 4,
            buttons: buttons.length,
            commits: samples.length,
            reads,
            medianMs: sorted[25],
            p95Ms: sorted[47],
            maxMs: sorted.at(-1),
            samples,
          },
          null,
          2,
        ),
      )
      expect(reads).toBe(0)
    } finally {
      await cdp().send('Emulation.setCPUThrottlingRate', { rate: 1 })
      for (const button of buttons) Reflect.deleteProperty(button, 'offsetWidth')
    }
  })

  it('preserves caller minWidth while idle, during work, and after returning idle', async () => {
    const content = (held = false, minWidth: CSSProperties['minWidth'] = 180) => (
      <Button style={{ minWidth }} loading={held} loadingLabel="…">
        保存
      </Button>
    )
    const screen = await render(content())
    const button = screen.getByRole('button').element()
    expect(button.style.minWidth).toBe('180px')
    expect(width(button)).toBeGreaterThanOrEqual(180)
    await screen.rerender(content(true, 220))
    expect(width(button)).toBeGreaterThanOrEqual(220)
    await screen.rerender(content(false, '12rem'))
    expect(button.style.minWidth).toBe('12rem')
    expect(width(button)).toBeGreaterThanOrEqual(12 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize))
    await screen.rerender(content(false, 'max-content'))
    expect(button.style.minWidth).toBe('max-content')
    await screen.rerender(content(true, 'max-content'))
    expect(button.style.minWidth).toBe('max-content')
  })

  it('keeps the widest running label through pending and done, then restores the natural idle width', async () => {
    const screen = await render(<Button icon={PlusGlyph}>保存设置</Button>)
    const button = screen.getByRole('button').element()
    const initial = width(button)
    await screen.rerender(
      <Button icon={PlusGlyph} loading loadingLabel="正在保存这台电脑的全部设置">
        保存设置
      </Button>,
    )
    await painted()
    const busy = width(button)
    expect(busy).toBeGreaterThan(initial)
    await screen.rerender(
      <Button icon={PlusGlyph} pending>
        保存设置
      </Button>,
    )
    expect(width(button)).toBeGreaterThanOrEqual(busy - 1)
    await screen.rerender(
      <Button icon={PlusGlyph} done doneLabel="好">
        保存设置
      </Button>,
    )
    expect(width(button)).toBeGreaterThanOrEqual(busy - 1)
    await screen.rerender(<Button icon={PlusGlyph}>保存设置</Button>)
    expect(Math.abs(width(button) - initial)).toBeLessThan(1)
  })

  it('refreshes idle width after locale and font metrics change without needing a parent rerender', async () => {
    const screen = await render(
      <div>
        <Button>Review</Button>
      </div>,
    )
    const button = screen.getByRole('button').element()
    await screen.rerender(
      <div>
        <Button>检查并保存更改</Button>
      </div>,
    )
    await painted()
    const translated = width(button)
    button.style.fontSize = '24px'
    button.style.fontFamily = 'monospace'
    await document.fonts.ready
    await painted()
    const changed = width(button)
    expect(changed).toBeGreaterThan(translated)
    await screen.rerender(
      <div>
        <Button loading loadingLabel="…">
          检查并保存更改
        </Button>
      </div>,
    )
    expect(width(button)).toBeGreaterThanOrEqual(changed - 1)
  })

  it('keeps a visible width across hiding, and learns the natural width when first shown', async () => {
    const content = (hidden: boolean, busy = false) => (
      <div hidden={hidden}>
        <Button loading={busy} loadingLabel="…">
          连接这个浏览器
        </Button>
      </div>
    )
    const screen = await render(content(true))
    const button = screen.container.querySelector('button')!
    expect(width(button)).toBe(0)
    await screen.rerender(content(false))
    await painted()
    const visible = width(button)
    await screen.rerender(content(true))
    await painted()
    await screen.rerender(content(false, true))
    expect(width(button)).toBeGreaterThanOrEqual(visible - 1)
  })

  it('follows container resizing while idle and keeps a block button fitted while busy', async () => {
    const content = (size: number, busy = false) => (
      <div style={{ width: size }}>
        <Button block loading={busy} loadingLabel="…">
          保存设置
        </Button>
      </div>
    )
    const screen = await render(content(400))
    const button = screen.getByRole('button').element()
    await screen.rerender(content(280))
    await painted()
    expect(width(button)).toBe(280)
    await screen.rerender(content(280, true))
    expect(width(button)).toBe(280)
    await screen.rerender(content(220, true))
    await painted()
    expect(width(button)).toBe(220)
    await screen.rerender(content(360, true))
    await painted()
    expect(width(button)).toBe(360)
  })

  it('does not create resize loops and keeps inactive semantics under reduced motion', async () => {
    const errors: string[] = []
    const onError = (event: ErrorEvent) => {
      if (event.message.includes('ResizeObserver')) errors.push(event.message)
    }
    window.addEventListener('error', onError)
    const clicked = vi.fn()
    try {
      await emulateMedia({ 'prefers-reduced-motion': 'reduce' }, async () => {
        const screen = await render(
          <Button disabled tooltip="请先填写名称" onClick={clicked}>
            添加服务
          </Button>,
        )
        const button = screen.getByRole('button')
        await userEvent.tab()
        await expect.element(button).toHaveFocus()
        press(button)
        await screen.rerender(
          <Button loading loadingLabel="…" disabled onClick={clicked}>
            添加服务
          </Button>,
        )
        await painted()
        press(button)
        await screen.rerender(
          <Button pending onClick={clicked}>
            添加服务
          </Button>,
        )
        await painted()
        press(button)
        await screen.rerender(
          <Button done doneLabel="已添加" onClick={clicked}>
            添加服务
          </Button>,
        )
        await painted()
        press(button)
        expect(clicked).not.toHaveBeenCalled()
        expect(errors).toEqual([])
      })
    } finally {
      window.removeEventListener('error', onError)
    }
  })

  it('does not accumulate padding when the caller uses a content box', async () => {
    const errors: string[] = []
    const onError = (event: ErrorEvent) => {
      if (event.message.includes('ResizeObserver')) errors.push(event.message)
    }
    window.addEventListener('error', onError)
    const box: CSSProperties = { boxSizing: 'content-box', paddingInline: '7.25px', border: '0.5px solid' }
    try {
      const screen = await render(<Button style={box}>保存</Button>)
      await screen.rerender(
        <Button style={box} loading loadingLabel="正在保存全部设置">
          保存
        </Button>,
      )
      await painted()
      const button = screen.getByRole('button').element()
      const wide = width(button)
      for (let frame = 0; frame < 5; frame++) await painted()
      expect(width(button)).toBe(wide)
      await screen.rerender(
        <Button style={box} done doneLabel="好">
          保存
        </Button>,
      )
      await painted()
      expect(Math.abs(width(button) - wide)).toBeLessThan(1)
      expect(errors).toEqual([])
    } finally {
      window.removeEventListener('error', onError)
    }
  })

  it('renders normal, running, pending, completed and unavailable controls at three widths and both themes', async () => {
    const content = (working: boolean) => (
      <section style={{ padding: 16 }}>
        <h2>按钮状态</h2>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'start' }}>
          <Button variant="primary" icon={PlusGlyph}>
            添加服务
          </Button>
          <Button loading={working} loadingLabel="检测中…">
            检测本机连接
          </Button>
          <Button pending={working}>在本机确认</Button>
          <Button icon={PlusGlyph} done={working} doneLabel="已添加">
            添加模型服务
          </Button>
          <Button disabled tooltip="请先填写名称">
            暂不可用
          </Button>
        </div>
        <div style={{ marginTop: 24, maxWidth: 360 }}>
          <Button block pending={working}>
            连接这台电脑
          </Button>
          <InlineNotice tone="error" title="未能连接服务" action={<Button>重试</Button>} />
        </div>
      </section>
    )
    const screen = await render(content(false))
    await painted()
    await screen.rerender(content(true))
    try {
      for (const viewport of [320, 768, 1440]) {
        await page.viewport(viewport, 600)
        for (const theme of ['light', 'dark'] as const)
          await emulateMedia({ 'prefers-color-scheme': theme, 'prefers-reduced-motion': 'reduce' }, async () => {
            await painted()
            expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth)
            await page.screenshot({ path: `../../../test-results/button-width/controls-${viewport}-${theme}.png` })
          })
      }
    } finally {
      await page.viewport(1280, 800)
    }
  })
})
