import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { ResizeHandle, type ResizePhase } from '../src/index.ts'

/** A column on the left with its handle on its end edge; widths are clamped by the owner, as the page does. */
function Column({ onChange }: { onChange?: (width: number, phase: ResizePhase) => void }) {
  const [width, setWidth] = useState(264)
  const [collapsed, setCollapsed] = useState(false)
  return (
    <div style={{ position: 'relative', height: 200 }}>
      <ResizeHandle
        label="调整侧栏宽度"
        value={collapsed ? 0 : width}
        min={220}
        max={480}
        collapsed={collapsed}
        style={{ top: 0, bottom: 0, left: (collapsed ? 0 : width) - 3 }}
        onResize={(next, phase) => {
          onChange?.(next, phase)
          setWidth(Math.round(Math.min(480, Math.max(220, next))))
          setCollapsed(false)
        }}
        onReset={() => {
          setWidth(264)
        }}
        onToggle={() => {
          setCollapsed(value => !value)
        }}
      />
    </div>
  )
}

const pointer = (type: string, x: number, init: PointerEventInit = {}) =>
  new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: x, clientY: 100, button: 0, ...init })

describe('resize handle', () => {
  it('resizes a bottom pane with the vertical arrows', async () => {
    const onResize = vi.fn()
    const onReset = vi.fn()
    const screen = await render(
      <ResizeHandle
        label="调整终端高度"
        orientation="horizontal"
        edge="start"
        value={220}
        min={140}
        max={520}
        onResize={onResize}
        onReset={onReset}
      />,
    )
    const handle = screen.getByRole('separator', { name: '调整终端高度' })
    await expect.element(handle).toHaveAttribute('aria-orientation', 'horizontal')
    expect(getComputedStyle(handle.element()).cursor).toBe('row-resize')
    await userEvent.tab()
    await userEvent.keyboard('{ArrowUp}{Shift>}{ArrowDown}{/Shift}{Home}{End}')
    expect(onResize.mock.calls).toEqual([
      [228, 'commit'],
      [188, 'commit'],
      [140, 'commit'],
      [520, 'commit'],
    ])
    await userEvent.keyboard('{Enter}')
    expect(onReset).toHaveBeenCalledOnce()
  })

  it('is a named vertical separator that the arrows, Home, End and Enter drive', async () => {
    const screen = await render(<Column />)
    const handle = screen.getByRole('separator', { name: '调整侧栏宽度' })
    await expect.element(handle).toHaveAttribute('aria-orientation', 'vertical')
    await expect.element(handle).toHaveAttribute('aria-valuenow', '264')
    await expect.element(handle).toHaveAttribute('aria-valuemin', '220')
    await expect.element(handle).toHaveAttribute('aria-valuemax', '480')
    await userEvent.tab()
    expect(document.activeElement).toBe(handle.element())
    await userEvent.keyboard('{ArrowRight}')
    await expect.element(handle).toHaveAttribute('aria-valuenow', '272')
    await userEvent.keyboard('{Shift>}{ArrowLeft}{/Shift}')
    await expect.element(handle).toHaveAttribute('aria-valuenow', '240')
    await userEvent.keyboard('{End}')
    await expect.element(handle).toHaveAttribute('aria-valuenow', '480')
    await userEvent.keyboard('{Home}')
    await expect.element(handle).toHaveAttribute('aria-valuenow', '220')
    await userEvent.keyboard('{Enter}')
    await expect.element(handle).toHaveAttribute('aria-valuetext', '已收起')
    // A shut column opens one step past its minimum from the keyboard, as its edge is dragged out.
    await userEvent.keyboard('{ArrowRight}')
    await expect.element(handle).toHaveAttribute('aria-valuenow', '228')
  })

  it('reports the width under the pointer while dragging and once more on release, holding the pointer and the selection', async () => {
    const changes: Array<[number, ResizePhase]> = []
    const screen = await render(<Column onChange={(width, phase) => changes.push([width, phase])} />)
    const handle = screen.getByRole('separator', { name: '调整侧栏宽度' }).element()
    if (!(handle instanceof HTMLElement)) throw new Error('Expected the handle to be an HTML element')
    const capture = vi.spyOn(handle, 'setPointerCapture').mockImplementation(() => {})
    handle.dispatchEvent(pointer('pointerdown', 264))
    expect(capture).toHaveBeenCalledWith(1)
    expect(document.documentElement.dataset.resizing).toBe('')
    await expect.poll(() => handle.hasAttribute('data-dragging')).toBe(true)
    handle.dispatchEvent(pointer('pointermove', 300))
    handle.dispatchEvent(pointer('pointermove', 120))
    handle.dispatchEvent(pointer('pointerup', 130))
    expect(changes).toEqual([
      [300, 'drag'],
      [120, 'drag'],
      [130, 'commit'],
    ])
    expect(document.documentElement.dataset.resizing).toBeUndefined()
    await expect.poll(() => handle.hasAttribute('data-dragging')).toBe(false)
    // Another button, or moves after the release, report nothing.
    handle.dispatchEvent(pointer('pointermove', 400))
    handle.dispatchEvent(pointer('pointerdown', 264, { button: 2 }))
    expect(changes).toHaveLength(3)
  })

  it('ends a drag at the last reported size when the capture is lost or the handle goes away mid-drag', async () => {
    const changes: Array<[number, ResizePhase]> = []
    const screen = await render(<Column onChange={(width, phase) => changes.push([width, phase])} />)
    const handle = screen.getByRole('separator', { name: '调整侧栏宽度' }).element()
    if (!(handle instanceof HTMLElement)) throw new Error('Expected the handle to be an HTML element')
    vi.spyOn(handle, 'setPointerCapture').mockImplementation(() => {})
    handle.dispatchEvent(pointer('pointerdown', 264))
    handle.dispatchEvent(pointer('pointermove', 320))
    // A lost capture carries no position of its own.
    handle.dispatchEvent(pointer('lostpointercapture', 0))
    expect(changes).toEqual([
      [320, 'drag'],
      [320, 'commit'],
    ])
    changes.length = 0
    await expect.poll(() => handle.getAttribute('aria-valuenow')).toBe('320')
    handle.dispatchEvent(pointer('pointerdown', 320))
    handle.dispatchEvent(pointer('pointermove', 360))
    await screen.unmount()
    expect(changes).toEqual([
      [360, 'drag'],
      [360, 'commit'],
    ])
    expect(document.documentElement.dataset.resizing).toBeUndefined()
  })

  it('resets on a double click', async () => {
    const screen = await render(<Column />)
    const handle = screen.getByRole('separator', { name: '调整侧栏宽度' })
    await userEvent.tab()
    await userEvent.keyboard('{End}')
    await expect.element(handle).toHaveAttribute('aria-valuenow', '480')
    await userEvent.dblClick(handle)
    await expect.element(handle).toHaveAttribute('aria-valuenow', '264')
  })

  it('draws its line in line-strong only after a 300ms hover, at once with keyboard focus, and takes no room', async () => {
    const screen = await render(<Column />)
    const handle = screen.getByRole('separator', { name: '调整侧栏宽度' }).element()
    const line = () => getComputedStyle(handle, '::after')
    expect([line().opacity, line().width, line().backgroundColor]).toEqual(['0', '1px', 'rgba(18, 18, 28, 0.14)'])
    expect(getComputedStyle(handle).position).toBe('absolute')
    expect(getComputedStyle(handle).cursor).toBe('col-resize')
    await userEvent.hover(handle)
    // The hover waits before the line shows, so passing over the edge does not flicker.
    expect(line().transitionDelay).toBe('0.3s')
    await userEvent.unhover(handle)
    await userEvent.tab()
    expect(line().transitionDelay).toBe('0s')
    await expect.poll(() => line().opacity).toBe('1')
  })
})
