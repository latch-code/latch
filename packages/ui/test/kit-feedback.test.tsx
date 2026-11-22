import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import {
  Button,
  CopyButton,
  Group,
  Kbd,
  Modal,
  ModalHeader,
  Popover,
  ProgressBar,
  Row,
  Scrim,
  Toast,
  Tooltip,
  keyGlyphs,
} from '../src/index.ts'

describe('keyGlyphs and the tooltip words', () => {
  it('writes a shortcut for the platform', async () => {
    expect(keyGlyphs('mod+shift+k', true)).toBe('⌘⇧K')
    expect(keyGlyphs('mod+shift+k', false)).toBe('Ctrl+Shift+K')
    expect(keyGlyphs('alt+mod+b', true)).toBe('⌥⌘B')
    expect(keyGlyphs('enter', true)).toBe('⏎')
    const screen = await render(<Kbd keys="shift+esc" />)
    expect(screen.container.textContent).toMatch(/Esc$/u)
  })

  it('reads 标签 (⌘X) after a 400ms wait', async () => {
    const screen = await render(
      <Tooltip content="侧边面板" shortcut="⌘B" describe={false}>
        <button type="button">面板</button>
      </Tooltip>,
    )
    await screen.getByRole('button', { name: '面板' }).hover()
    expect(screen.container.querySelector('[role="tooltip"]')?.matches(':popover-open')).toBe(false)
    await expect.poll(() => screen.container.querySelector('[role="tooltip"]')?.matches(':popover-open')).toBe(true)
    expect(screen.container.querySelector('[role="tooltip"]')?.textContent).toBe('侧边面板(⌘B)')
  })
})

describe('CopyButton', () => {
  it('morphs to a check and says 已复制 anchored to the button for a second', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    try {
      const screen = await render(<CopyButton text="路径" label="复制路径" />)
      await screen.getByRole('button', { name: '复制路径' }).click()
      expect(writeText).toHaveBeenCalledWith('路径')
      const bubble = screen.container.querySelector<HTMLElement>('.ui-copied')!
      await expect.poll(() => bubble.matches(':popover-open')).toBe(true)
      expect(bubble.textContent).toBe('已复制')
      expect(screen.container.querySelector('.latch-glyph-check')).not.toBeNull()
      await expect.element(screen.getByRole('status')).toHaveTextContent('已复制')
      await expect.poll(() => bubble.matches(':popover-open'), { timeout: 1600 }).toBe(false)
    } finally {
      writeText.mockRestore()
    }
  })

  it('copies through a selection when the Clipboard API refuses, and gives focus back', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
    const copied: string[] = []
    const execCommand = vi.spyOn(document, 'execCommand').mockImplementation(command => {
      copied.push(`${command}:${(document.activeElement as HTMLTextAreaElement).value}`)
      return true
    })
    try {
      const screen = await render(<CopyButton text="路径" />)
      const button = screen.getByRole('button', { name: '复制' })
      await button.click()
      await expect.element(screen.getByRole('status')).toHaveTextContent('已复制')
      expect(copied).toEqual(['copy:路径'])
      expect(document.querySelector('textarea')).toBeNull()
      expect(document.activeElement).toBe(button.element())
    } finally {
      writeText.mockRestore()
      execCommand.mockRestore()
    }
  })

  it('never looks like a success when both ways of copying fail', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
    const execCommand = vi.spyOn(document, 'execCommand').mockReturnValue(false)
    try {
      const screen = await render(<CopyButton text="路径" />)
      await screen.getByRole('button', { name: '复制' }).click()
      const bubble = screen.container.querySelector<HTMLElement>('.ui-copied')!
      await expect.poll(() => bubble.textContent).toBe('复制不可用，请手动选择')
      expect(screen.container.querySelector('.latch-glyph-check')).toBeNull()
    } finally {
      writeText.mockRestore()
      execCommand.mockRestore()
    }
  })
})

describe('ProgressBar', () => {
  it('is an indeterminate 2px line that completes and goes', async () => {
    const screen = await render(<ProgressBar active />)
    const bar = screen.getByRole('progressbar')
    expect(bar.element().getBoundingClientRect().height).toBe(2)
    expect(bar.element().hasAttribute('aria-valuenow')).toBe(false)
    await screen.rerender(<ProgressBar active={false} />)
    expect(bar.element().getAttribute('data-state')).toBe('done')
    await expect.poll(() => screen.container.querySelector('.ui-progress')).toBeNull()
  })
})

describe('Group and Row', () => {
  it('gives rows and whatever else it holds the inner padding', async () => {
    const screen = await render(
      <Group title="通用">
        <Row title="主题" description="跟随系统">
          <button type="button">改</button>
        </Row>
        <p>说明</p>
      </Group>,
    )
    const row = screen.container.querySelector('.ui-row')!
    const note = screen.getByText('说明').element()
    for (const element of [row, note]) expect(getComputedStyle(element).padding).toBe('12px 16px')
    expect(row.getBoundingClientRect().height).toBeGreaterThanOrEqual(52)
    expect(getComputedStyle(screen.container.querySelector('.ui-group-card')!).borderRadius).toBe('12px')
  })
})

describe('Toast', () => {
  it('stands at the bottom centre and goes after 2.2 seconds', async () => {
    let elapsed = 0
    const start = performance.now()
    const screen = await render(
      <Toast
        placement="bottom"
        onDismiss={() => {
          elapsed = performance.now() - start
        }}>
        已处理
      </Toast>,
    )
    const toast = screen.getByRole('status').element()
    await expect.poll(() => innerHeight - toast.getBoundingClientRect().bottom).toBe(24)
    const box = toast.getBoundingClientRect()
    expect(Math.abs((box.left + box.right) / 2 - innerWidth / 2)).toBeLessThan(1)
    await expect.poll(() => elapsed, { timeout: 4000 }).toBeGreaterThanOrEqual(2190)
  })
})

describe('Popover side', () => {
  function Sample({ top }: { top: number }) {
    return (
      <div style={{ position: 'fixed', top }}>
        <Popover
          label="选择"
          side="auto"
          maxHeight={100}
          trigger={menu => (
            <button type="button" ref={menu.ref} onClick={menu.onClick}>
              打开
            </button>
          )}>
          <div style={{ height: 300 }}>内容</div>
        </Popover>
      </div>
    )
  }

  it('opens toward the side with more room and caps its height', async () => {
    const screen = await render(<Sample top={innerHeight - 40} />)
    await screen.getByRole('button', { name: '打开' }).click()
    const layer = screen.container.querySelector<HTMLElement>('.ui-popover')!
    await expect.poll(() => layer.dataset.side).toBe('top')
    expect(layer.getBoundingClientRect().height).toBeLessThanOrEqual(100)
    expect(layer.scrollHeight).toBeGreaterThan(100)
  })

  it('opens below when that has more room', async () => {
    const screen = await render(<Sample top={8} />)
    await screen.getByRole('button', { name: '打开' }).click()
    const layer = screen.container.querySelector<HTMLElement>('.ui-popover')!
    await expect.poll(() => layer.dataset.side).toBe('bottom')
  })

  it('above its trigger, grows away from it in the frame its content grows, clamped from that frame', async () => {
    const screen = await render(
      <div style={{ position: 'fixed', top: innerHeight - 60 }}>
        <Popover
          label="选择"
          side="auto"
          maxHeight={240}
          trigger={menu => (
            <button type="button" ref={menu.ref} onClick={menu.onClick}>
              打开
            </button>
          )}>
          <div id="grows" style={{ height: 20 }}>
            读取中
          </div>
        </Popover>
      </div>,
    )
    const trigger = screen.getByRole('button', { name: '打开' }).element()
    await screen.getByRole('button', { name: '打开' }).click()
    const layer = screen.container.querySelector<HTMLElement>('.ui-popover')!
    await expect.poll(() => layer.dataset.side).toBe('top')
    // The list arrives: read the boxes in the same task, before any frame could place the layer again.
    document.querySelector<HTMLElement>('#grows')!.style.height = '600px'
    const box = layer.getBoundingClientRect()
    expect(box.bottom).toBeLessThanOrEqual(trigger.getBoundingClientRect().top)
    expect(box.height).toBeLessThanOrEqual(240)
  })
})

describe('Modal exit', () => {
  function Sample({ secure = false, secret = false }: { secure?: boolean; secret?: boolean }) {
    const [open, setOpen] = useState(true)
    return (
      <>
        <Button
          onClick={() => {
            setOpen(true)
          }}>
          打开
        </Button>
        {open && (
          <Modal
            label="窗口"
            secure={secure}
            onClose={() => {
              setOpen(false)
            }}>
            <ModalHeader
              title="标题"
              onClose={() => {
                setOpen(false)
              }}
            />
            <div className="ui-modal-body" id="unique-body">
              {secret ? <input type="password" aria-label="密钥" defaultValue="x" /> : <p>内容</p>}
            </div>
          </Modal>
        )}
      </>
    )
  }
  const ghost = () => document.querySelector<HTMLElement>('.ui-modal-ghost')

  // A modal the last test left open plays its exit when cleanup unmounts it.
  beforeEach(async () => {
    await expect.poll(ghost, { timeout: 2000 }).toBeNull()
  })

  it('leaves a still, inert picture that plays out and goes, with focus back at once', async () => {
    const screen = await render(<Sample />)
    await page.getByRole('button', { name: '关闭' }).click()
    await expect.poll(ghost).not.toBeNull()
    const picture = ghost()!
    expect(picture.getAttribute('aria-hidden')).toBe('true')
    expect(picture.inert).toBe(true)
    expect(picture.querySelector('[id]')).toBeNull()
    expect(picture.tagName).toBe('DIV')
    expect(getComputedStyle(picture).pointerEvents).toBe('none')
    expect(picture.getAnimations({ subtree: true }).length).toBeGreaterThan(0)
    // Nothing in the page can reach it, and the button under it takes the press.
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
    await screen.getByRole('button', { name: '打开' }).click()
    await expect.element(page.getByRole('dialog')).toBeVisible()
    await expect.poll(ghost, { timeout: 800 }).toBeNull()
  })

  it('leaves no picture of a security surface or of a secret in a field', async () => {
    for (const props of [{ secure: true }, { secret: true }]) {
      const screen = await render(<Sample {...props} />)
      await page.getByRole('button', { name: '关闭' }).click()
      await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(ghost()).toBeNull()
      await screen.unmount()
    }
  })

  it('leaves no picture of a page, and none for the rehearsal of an unmount', async () => {
    const screen = await render(
      <Modal label="页面" variant="page" onClose={() => {}}>
        页面
      </Modal>,
    )
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(ghost()).toBeNull()
    await screen.unmount()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(ghost()).toBeNull()
  })
})

describe('Scrim', () => {
  it('fades out after it closes, taking no press meanwhile', async () => {
    const dismissed = vi.fn()
    const screen = await render(<Scrim open label="关闭列表" onDismiss={dismissed} />)
    const scrim = screen.getByRole('button', { name: '关闭列表' })
    await scrim.click()
    expect(dismissed).toHaveBeenCalledOnce()
    await screen.rerender(<Scrim open={false} label="关闭列表" onDismiss={dismissed} />)
    expect(scrim.element().hasAttribute('data-leaving')).toBe(true)
    await expect.poll(() => screen.container.querySelector('.ui-scrim')).toBeNull()
  })
})
