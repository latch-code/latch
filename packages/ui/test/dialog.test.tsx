import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { Button, Dialog, Sheet, TextField } from '../src/index.ts'

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
        size="form"
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

  it('draws the 56px header, the 24px body and the 64px footer on a raised surface with 16px corners', async () => {
    const screen = await render(<Project />)
    await userEvent.click(screen.getByRole('button', { name: '添加项目…' }))
    const surface = screen.getByRole('dialog').element().querySelector('.ui-dialog-surface')!
    const style = getComputedStyle(surface)
    expect(style.borderTopLeftRadius).toBe('16px')
    expect(style.width).toBe('560px')
    // Layout sizes: the dialog scales from 98% while it opens.
    expect(surface.querySelector<HTMLElement>('.ui-dialog-header')!.offsetHeight).toBe(56)
    expect(surface.querySelector<HTMLElement>('.ui-dialog-footer')!.offsetHeight).toBe(64)
    expect(getComputedStyle(surface.querySelector('.ui-dialog-body')!).paddingTop).toBe('24px')
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

describe('bottom sheet', () => {
  it('is a modal titled by its header, with 取消 on the left that closes it', async () => {
    const screen = await render(<Settings />)
    const sheet = screen.getByRole('dialog', { name: '运行设置' })
    await expect.element(sheet).toBeVisible()
    await expect.element(screen.getByRole('button', { name: '完成' })).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: '取消' }))
    await expect.element(screen.getByRole('dialog', { name: '运行设置' })).not.toBeInTheDocument()
  })

  it("starts 取消's text and ends the action on the 16px column of the sheet's body, with 取消 at the regular weight", async () => {
    const screen = await render(<Settings />)
    const sheet = screen.getByRole('dialog', { name: '运行设置' }).element()
    const surface = sheet.querySelector('.ui-sheet-surface')!.getBoundingClientRect()
    const cancel = screen.getByRole('button', { name: '取消' }).element()
    const words = document.createRange()
    words.selectNodeContents(cancel)
    expect(Math.round(words.getBoundingClientRect().left - surface.left)).toBe(16)
    expect(Math.round(surface.right - screen.getByRole('button', { name: '完成' }).element().getBoundingClientRect().right)).toBe(16)
    expect(getComputedStyle(cancel).fontWeight).toBe('400')
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
