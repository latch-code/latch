import { useState } from 'react'
import { flushSync } from 'react-dom'
import { describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { Button, Dialog, LayerHistory, Modal, Sheet, SheetSurface, TextField } from '../src/index.ts'

function Project({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false)
  const close = () => {
    setOpen(false)
    onClose?.()
  }
  return (
    <>
      <Button
        onClick={() => {
          setOpen(true)
        }}>
        添加项目…
      </Button>
      <Dialog
        open={open}
        onClose={close}
        title="添加项目"
        size="lg"
        footer={
          <>
            <Button size="md" onClick={close}>
              取消
            </Button>
            <Button variant="primary" size="md">
              添加
            </Button>
          </>
        }>
        <TextField label="路径" placeholder="/Users/me/code/latch-app" />
      </Dialog>
    </>
  )
}

/** A docked security surface, open from the start. */
function Dock() {
  const [open, setOpen] = useState(true)
  return (
    <Dialog
      open={open}
      onClose={() => {
        setOpen(false)
      }}
      placement="dock"
      secure
      bare
      icon={<span data-testid="tile" />}
      title="允许一次高风险操作"
      footer={
        <Button
          size="md"
          onClick={() => {
            setOpen(false)
          }}>
          取消
        </Button>
      }>
      已打开系统确认窗口。
    </Dialog>
  )
}

describe('dialog', () => {
  it('opens on its first input, keeps Tab inside, closes on Escape and gives focus back to its opener', async () => {
    const closed = vi.fn()
    const screen = await render(<Project onClose={closed} />)
    const opener = screen.getByRole('button', { name: '添加项目…' })
    await userEvent.click(opener)
    const dialog = screen.getByRole('dialog', { name: '添加项目' })
    await expect.element(dialog).toBeVisible()
    await expect.element(screen.getByRole('textbox', { name: '路径' })).toHaveFocus()
    // 路径 → 取消 → 添加, then around to the header's close button: never out of the dialog.
    await userEvent.keyboard('{Tab}{Tab}')
    await expect.element(screen.getByRole('button', { name: '添加', exact: true })).toHaveFocus()
    await userEvent.keyboard('{Tab}')
    await expect.element(screen.getByRole('button', { name: '关闭' })).toHaveFocus()
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}')
    await expect.element(screen.getByRole('button', { name: '添加', exact: true })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(closed).toHaveBeenCalledOnce()
    await expect.element(screen.getByRole('dialog', { name: '添加项目' })).not.toBeInTheDocument()
    await expect.element(opener).toHaveFocus()
  })

  it('closes on a press on the scrim, never on a press inside', async () => {
    const closed = vi.fn()
    const screen = await render(<Project onClose={closed} />)
    await userEvent.click(screen.getByRole('button', { name: '添加项目…' }))
    await userEvent.click(screen.getByText('路径'))
    expect(closed).not.toHaveBeenCalled()
    // The dialog element is a frame the size of its surface, so only the scrim around it targets the element itself.
    const dialog = screen.getByRole('dialog').element()
    dialog.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(closed).toHaveBeenCalled()
  })

  it('keeps the 56px header and footer on a single dialog surface with 16px corners', async () => {
    const screen = await render(<Project />)
    await userEvent.click(screen.getByRole('button', { name: '添加项目…' }))
    const dialog = screen.getByRole('dialog').element()
    const surface = dialog.querySelector('.ui-dialog-surface')!
    const style = getComputedStyle(surface)
    expect([style.borderTopLeftRadius, style.width, style.backgroundColor]).toEqual(['16px', '560px', 'rgb(255, 255, 255)'])
    // Layout sizes: the dialog scales from .985 while it opens.
    expect(surface.querySelector<HTMLElement>('.ui-dialog-header')!.offsetHeight).toBe(56)
    const footer = surface.querySelector<HTMLElement>('.ui-dialog-footer')!
    expect([footer.offsetHeight, getComputedStyle(footer).backgroundColor, getComputedStyle(footer).boxShadow]).toEqual([
      56,
      'rgba(0, 0, 0, 0)',
      'none',
    ])
    const body = getComputedStyle(surface.querySelector('.ui-dialog-body')!)
    expect([body.paddingTop, body.paddingInlineStart]).toEqual(['4px', '24px'])
    // It opens from a scale of .985 over --m-sheet, over a scrim that blurs the page by 4px.
    expect([getComputedStyle(dialog).transitionDuration.split(', ')[0], getComputedStyle(dialog, '::backdrop').backdropFilter]).toEqual([
      '0.26s',
      'blur(4px)',
    ])
    await expect.poll(() => getComputedStyle(dialog).scale).toBe('1')
  })

  it('docks 400 wide above the bottom edge with its state tile, and marks a security surface', async () => {
    const screen = await render(<Dock />)
    const dialog = screen.getByRole('dialog', { name: '允许一次高风险操作' })
    await expect.element(dialog).toBeVisible()
    const element = dialog.element()
    expect(element.dataset.placement).toBe('dock')
    expect(element.dataset.secure).toBe('')
    await vi.waitFor(() => {
      expect(getComputedStyle(element).translate).toMatch(/^(?:none|0px)$/u)
    })
    const surface = element.querySelector<HTMLElement>('.ui-dialog-surface')!
    expect(getComputedStyle(surface).width).toBe('400px')
    expect(Math.round(innerHeight - surface.getBoundingClientRect().bottom)).toBe(24)
    const tile = element.querySelector<HTMLElement>('.ui-dialog-icon')!
    expect([tile.offsetWidth, tile.offsetHeight]).toEqual([36, 36])
    expect(tile.querySelector('[data-testid="tile"]')).not.toBeNull()
    expect(getComputedStyle(element.querySelector('.ui-dialog-body')!).paddingTop).toBe('20px')
    await userEvent.keyboard('{Escape}')
    await expect.element(screen.getByRole('dialog', { name: '允许一次高风险操作' })).not.toBeInTheDocument()
    expect(getComputedStyle(element).transitionDuration).toBe('0s')
  })
})

function Settings() {
  const [open, setOpen] = useState(true)
  return (
    <Sheet
      open={open}
      title="运行设置"
      onClose={() => {
        setOpen(false)
      }}
      action={
        <Button
          onClick={() => {
            setOpen(false)
          }}>
          完成
        </Button>
      }>
      <p>模型与项目</p>
    </Sheet>
  )
}

/** A sheet with a picker's sheet opened from it, as the phone's new-session sheet opens its pickers. */
function Nested({ large = false }: { large?: boolean } = {}) {
  const [outer, setOuter] = useState(true)
  const [inner, setInner] = useState(false)
  return (
    <Sheet
      open={outer}
      detent={large ? 'large' : 'medium'}
      title="新会话"
      onClose={() => {
        setOuter(false)
      }}>
      <Button
        onClick={() => {
          setInner(true)
        }}>
        模型
      </Button>
      <Sheet
        open={inner}
        title="模型"
        onClose={() => {
          setInner(false)
        }}>
        <p>模型列表</p>
      </Sheet>
    </Sheet>
  )
}

describe('bottom sheet', () => {
  it('is a modal titled by its header, with the one close button on the left that closes it, and focus on its content', async () => {
    const screen = await render(<Settings />)
    const sheet = screen.getByRole('dialog', { name: '运行设置' })
    await expect.element(sheet).toBeVisible()
    await expect.element(screen.getByRole('button', { name: '完成' })).toHaveFocus()
    const close = screen.getByRole('button', { name: '关闭' }).element()
    expect(
      close.getBoundingClientRect().left - sheet.element().querySelector('.ui-sheet-surface')!.getBoundingClientRect().left,
    ).toBeLessThan(24)
    await userEvent.click(close)
    await expect.element(screen.getByRole('dialog', { name: '运行设置' })).not.toBeInTheDocument()
  })

  it("ends the action on the 16px column of the sheet's body", async () => {
    const screen = await render(<Settings />)
    const sheet = screen.getByRole('dialog', { name: '运行设置' }).element()
    const surface = sheet.querySelector('.ui-sheet-surface')!.getBoundingClientRect()
    expect(Math.round(surface.right - screen.getByRole('button', { name: '完成' }).element().getBoundingClientRect().right)).toBe(16)
  })

  it('ends a long title in an ellipsis between the close button and the action, which keep their whole width', async () => {
    const title = '修复设置页保存模型服务之后 API Key 会被清空，并且补上回归测试与说明'
    const screen = await render(
      <div style={{ width: 390 }}>
        <SheetSurface
          title={title}
          onClose={() => {}}
          action={
            <Button variant="primary" disabled>
              开始
            </Button>
          }
        />
      </div>,
    )
    const cancel = screen.getByRole('button', { name: '关闭' }).element().getBoundingClientRect()
    const start = screen.getByRole('button', { name: '开始' }).element().getBoundingClientRect()
    const heading = screen.getByRole('heading', { name: title }).element()
    const box = heading.getBoundingClientRect()
    expect(cancel.right).toBeLessThanOrEqual(box.left)
    expect(box.right).toBeLessThanOrEqual(start.left)
    // The words are cut, not squeezed: each button keeps the width of its own text.
    expect(heading.scrollWidth).toBeGreaterThan(heading.clientWidth)
    for (const name of ['关闭', '开始']) {
      const button = screen.getByRole('button', { name }).element()
      expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth)
    }
  })

  it('keeps a short title in the middle between two sides of the same width', async () => {
    const screen = await render(
      <div style={{ width: 390 }}>
        <SheetSurface title="新会话" onClose={() => {}} action={<Button variant="primary">开始</Button>} />
      </div>,
    )
    const header = screen.container.querySelector('.ui-sheet-header')!.getBoundingClientRect()
    const box = screen.getByRole('heading', { name: '新会话' }).element().getBoundingClientRect()
    // The header's inner box starts 8 and ends 16 from its edges, so its middle is 4 left of the sheet's.
    expect(Math.abs(box.left + box.width / 2 - (header.left + 8 + (header.width - 24) / 2))).toBeLessThan(1)
  })

  it('stands a form at 92% of the window with the large detent, whatever it holds, and opens at most 65% by default', async () => {
    const tall = <p style={{ height: '2000px' }}>任务</p>
    const screen = await render(
      <>
        <Sheet open title="新会话" detent="large" onClose={() => {}}>
          <p>任务</p>
        </Sheet>
        <Sheet open title="运行设置" onClose={() => {}}>
          {tall}
        </Sheet>
      </>,
    )
    const height = (name: string) =>
      Math.round(screen.getByRole('dialog', { name }).element().querySelector('.ui-sheet-surface')!.getBoundingClientRect().height)
    await expect.element(screen.getByRole('dialog', { name: '新会话' })).toBeVisible()
    await vi.waitFor(() => {
      expect(height('新会话')).toBe(Math.round(innerHeight * 0.92))
      expect(height('运行设置')).toBe(Math.round(innerHeight * 0.65))
    })
    expect(screen.getByRole('dialog', { name: '新会话' }).element().getAttribute('data-detent')).toBe('large')
  })

  it('keeps a nested picker at its own height inside a large form sheet', async () => {
    const screen = await render(<Nested large />)
    const outer = screen.getByRole('dialog', { name: '新会话' }).element().querySelector('.ui-sheet-surface')!
    await userEvent.click(screen.getByRole('button', { name: '模型' }))
    const inner = screen.getByRole('dialog', { name: '模型' })
    await expect.element(inner).toBeVisible()
    const height = () => inner.element().querySelector('.ui-sheet-surface')!.getBoundingClientRect().height
    expect(height()).toBeLessThanOrEqual(innerHeight * 0.65)
    expect(Math.round(outer.getBoundingClientRect().height)).toBe(Math.round(innerHeight * 0.92))
  })

  it('holds a place in the page navigation while open, which closes it, and gives it back when closed otherwise', async () => {
    const open = vi.fn<(close: () => void) => () => void>()
    const release = vi.fn()
    let back: (() => void) | undefined
    open.mockImplementation(close => {
      back = close
      return release
    })
    function Layered() {
      const [shown, setShown] = useState(false)
      return (
        <LayerHistory value={open}>
          <Button
            onClick={() => {
              setShown(true)
            }}>
            打开
          </Button>
          <Sheet
            open={shown}
            title="会话操作"
            onClose={() => {
              setShown(false)
            }}>
            <p>操作</p>
          </Sheet>
        </LayerHistory>
      )
    }
    const screen = await render(<Layered />)
    expect(open).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: '打开' }))
    await expect.element(screen.getByRole('dialog', { name: '会话操作' })).toBeVisible()
    expect(open).toHaveBeenCalledTimes(1)
    // Going back closes it as its close button would.
    back?.()
    await expect.element(screen.getByRole('dialog', { name: '会话操作' })).not.toBeInTheDocument()
    expect(release).toHaveBeenCalledTimes(1)
    // Closed from the sheet itself, it gives its place back.
    await userEvent.click(screen.getByRole('button', { name: '打开' }))
    await expect.element(screen.getByRole('dialog', { name: '会话操作' })).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: '关闭' }))
    await expect.element(screen.getByRole('dialog', { name: '会话操作' })).not.toBeInTheDocument()
    expect(open).toHaveBeenCalledTimes(2)
    expect(release).toHaveBeenCalledTimes(2)
  })

  it('closes only the innermost sheet on Escape, keeping the sheet it was opened from', async () => {
    const screen = await render(<Nested />)
    // Each opens from a press, as the browser groups dialogs that open without one and closes them together.
    await userEvent.click(screen.getByRole('button', { name: '模型' }))
    await expect.element(screen.getByRole('dialog', { name: '模型' })).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await expect.element(screen.getByRole('dialog', { name: '模型' })).not.toBeInTheDocument()
    await expect.element(screen.getByRole('dialog', { name: '新会话' })).toBeVisible()
  })

  it('reports a browser close only to its own sheet, including when both closes are queued together', async () => {
    const outerClosed = vi.fn()
    const innerClosed = vi.fn()
    const screen = await render(
      <Sheet open title="新会话" onClose={outerClosed}>
        <Sheet open title="模型" onClose={innerClosed}>
          模型列表
        </Sheet>
      </Sheet>,
    )
    const outer = screen.getByRole('dialog', { name: '新会话' }).element() as HTMLDialogElement
    const inner = screen.getByRole('dialog', { name: '模型' }).element() as HTMLDialogElement
    inner.close()
    await expect.poll(() => innerClosed.mock.calls.length).toBe(1)
    expect(outerClosed).not.toHaveBeenCalled()
    expect(outer.open).toBe(true)

    inner.showModal()
    const delivered = Promise.all(
      [inner, outer].map(
        dialog =>
          new Promise<void>(resolve => {
            dialog.addEventListener('close', () => resolve(), { once: true })
          }),
      ),
    )
    // The inner close will reach React while the outer dialog is already closed too.
    inner.close()
    outer.close()
    await delivered
    expect(innerClosed).toHaveBeenCalledTimes(2)
    expect(outerClosed).toHaveBeenCalledOnce()
  })

  it('lets only the outermost modal dim and blur the page: one opened over it brings no scrim of its own', async () => {
    const screen = await render(<Nested />)
    await userEvent.click(screen.getByRole('button', { name: '模型' }))
    const inner = screen.getByRole('dialog', { name: '模型' }).element()
    const outer = screen.getByRole('dialog', { name: '新会话' }).element()
    await expect.element(inner).toBeVisible()
    expect([outer.hasAttribute('data-stacked'), inner.hasAttribute('data-stacked')]).toEqual([false, true])
    expect(getComputedStyle(inner, '::backdrop').backdropFilter).toBe('none')
    expect(getComputedStyle(outer, '::backdrop').backdropFilter).toBe('blur(4px)')
  })

  it('closes when its top is dragged down past a third of its height', async () => {
    const screen = await render(<Settings />)
    const sheet = screen.getByRole('dialog', { name: '运行设置' })
    await expect.element(sheet).toBeVisible()
    const top = sheet.element().querySelector<HTMLElement>('.ui-sheet-top')!
    const box = top.getBoundingClientRect()
    const at = (y: number) => ({ bubbles: true, pointerId: 1, clientX: box.left + 8, clientY: y })
    top.dispatchEvent(new PointerEvent('pointerdown', at(box.top + 4)))
    top.dispatchEvent(new PointerEvent('pointermove', at(box.top + 300)))
    top.dispatchEvent(new PointerEvent('pointerup', at(box.top + 300)))
    await expect.element(screen.getByRole('dialog', { name: '运行设置' })).not.toBeInTheDocument()
  })
})

describe('a modal that only an answer may end', () => {
  function Question({ onClose }: { onClose: () => void }) {
    const [answering, setAnswering] = useState(false)
    return (
      <Modal label="问题" dismissible={!answering} onClose={onClose}>
        <Button
          onClick={() => {
            setAnswering(true)
          }}>
          开始询问
        </Button>
      </Modal>
    )
  }

  it('stays through repeated Escape, even once it became undismissible while open', async () => {
    const onClose = vi.fn()
    const view = await render(<Question onClose={onClose} />)
    await view.getByRole('button', { name: '开始询问' }).click()
    const dialog = document.querySelector('dialog')!
    await expect.element(view.getByRole('dialog', { name: '问题' })).toHaveAttribute('closedby', 'none')
    for (let press = 0; press < 4; press++) {
      await userEvent.keyboard('{Escape}')
      expect(dialog.open).toBe(true)
    }
    expect(onClose).not.toHaveBeenCalled()
  })

  it('opens again where the browser closes it anyway, with focus back inside', async () => {
    const onClose = vi.fn()
    const view = await render(<Question onClose={onClose} />)
    await view.getByRole('button', { name: '开始询问' }).click()
    await expect.element(view.getByRole('dialog', { name: '问题' })).toHaveAttribute('closedby', 'none')
    const dialog = document.querySelector('dialog')!
    dialog.close()
    await vi.waitFor(() => {
      expect(dialog.open).toBe(true)
    })
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('still reports a browser-made close when it may be dismissed', async () => {
    const onClose = vi.fn()
    await render(
      <Modal label="问题" onClose={onClose}>
        <Button>好</Button>
      </Modal>,
    )
    document.querySelector('dialog')!.close()
    await vi.waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce()
    })
  })

  it('reports one browser close when a controlled close and reopen still have their close event queued', async () => {
    const onClose = vi.fn()
    let setOpen: (open: boolean) => void = () => {}
    function Controlled() {
      const [open, changeOpen] = useState(true)
      setOpen = changeOpen
      return (
        <Dialog open={open} title="问题" onClose={onClose}>
          内容
        </Dialog>
      )
    }
    const view = await render(<Controlled />)
    const dialog = view.getByRole('dialog').element() as HTMLDialogElement
    const delivered = vi.fn()
    dialog.addEventListener('close', delivered)
    // Keep all three operations in one task so neither close event can arrive before the real close.
    flushSync(() => setOpen(false))
    flushSync(() => setOpen(true))
    dialog.close()
    await expect.poll(() => delivered.mock.calls.length).toBeGreaterThanOrEqual(2)
    await expect.poll(() => onClose.mock.calls.length).toBe(1)
  })
})
