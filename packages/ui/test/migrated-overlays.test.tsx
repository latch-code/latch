import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { Button, ConfirmDialog, Modal, ModalHeader, PromptDialog, TextField } from '../src/index.ts'

function ContentModal({ variant }: { variant: 'dialog' | 'sheet' | 'page' }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>打开</Button>
      {open && (
        <Modal label="项目页面" variant={variant} onClose={() => setOpen(false)}>
          <ModalHeader title="项目页面" onClose={() => setOpen(false)} />
          <div className="ui-modal-body">
            <TextField label="名称" />
            <Button onClick={() => setOpen(false)}>完成</Button>
          </div>
        </Modal>
      )}
    </>
  )
}

describe('shared content modal and async dialogs', () => {
  it.each(['dialog', 'sheet', 'page'] as const)('%s keeps focus inside and restores it after Escape', async variant => {
    const screen = await render(<ContentModal variant={variant} />)
    const opener = screen.getByRole('button', { name: '打开', exact: true })
    await opener.click()
    await expect.element(screen.getByRole('textbox', { name: '名称', exact: true })).toHaveFocus()
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}')
    await expect.element(screen.getByRole('button', { name: '关闭', exact: true })).toHaveFocus()
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}')
    await expect.element(screen.getByRole('button', { name: '完成', exact: true })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    await expect.element(screen.getByRole('dialog', { name: '项目页面', exact: true })).not.toBeInTheDocument()
    await expect.element(opener).toHaveFocus()
  })

  it('shows a rejected operation in place and permits a real retry', async () => {
    const confirm = vi.fn().mockRejectedValueOnce(new Error('执行端暂时不可用')).mockResolvedValueOnce(undefined)
    const close = vi.fn()
    const screen = await render(
      <ConfirmDialog title="移除项目" message="文件不受影响" confirmLabel="移除" onConfirm={confirm} onClose={close} />,
    )
    await screen.getByRole('button', { name: '移除', exact: true }).click()
    await expect.element(screen.getByText('执行端暂时不可用', { exact: true })).toBeVisible()
    expect(close).not.toHaveBeenCalled()
    await screen.getByRole('button', { name: '移除', exact: true }).click()
    await expect.poll(() => close.mock.calls.length).toBe(1)
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('submits trimmed text through the shared prompt form', async () => {
    const submit = vi.fn(async () => {})
    const close = vi.fn()
    const screen = await render(<PromptDialog title="重命名" label="新名称" initial="原名称" onSubmit={submit} onClose={close} />)
    await screen.getByRole('textbox', { name: '新名称', exact: true }).fill('  新项目  ')
    await userEvent.keyboard('{Enter}')
    await expect.poll(() => submit.mock.calls.length).toBe(1)
    expect(submit).toHaveBeenCalledWith('新项目')
    expect(close).toHaveBeenCalledOnce()
  })
})
