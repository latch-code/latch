import { useRef, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { Suggest } from '../src/index.ts'

function Fixture({ choose = () => {} }: { choose?: (id: string) => void }) {
  const anchor = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(true)
  const [active, setActive] = useState<string>()
  return (
    <>
      <div style={{ height: 420 }} />
      <div ref={anchor} style={{ width: 480 }}>
        <textarea aria-label="消息" onFocus={() => setOpen(true)} aria-controls="suggest" aria-activedescendant={active} />
      </div>
      <Suggest
        id="suggest"
        label="命令"
        anchorRef={anchor}
        open={open}
        activeId={active}
        onDismiss={() => setOpen(false)}
        onActiveChange={setActive}
        onChoose={choose}
        groups={[
          {
            id: 'commands',
            label: 'Codex',
            items: Array.from({ length: 200 }, (_, index) => ({
              id: `command-${index}`,
              label: `/command-${index}`,
              description: index ? '描述' : '当前不可用',
              disabled: index === 0,
              hint: '<目标>',
              source: 'Codex',
            })),
          },
        ]}
        footer="Tab 补全"
      />
      <button type="button">其他入口</button>
    </>
  )
}

describe('input suggestions', () => {
  it('keeps the input focused, shows every option, and suppresses unavailable choices', async () => {
    const choose = vi.fn()
    await render(<Fixture choose={choose} />)
    const input = page.getByRole('textbox', { name: '消息' })
    await input.click()
    await expect.element(page.getByRole('listbox', { name: '命令' })).toBeVisible()
    expect(document.querySelectorAll('.ui-suggest-option')).toHaveLength(200)
    // The driver refuses disabled targets; a synthetic activation must also be harmless.
    document.getElementById('command-0')!.click()
    expect(choose).not.toHaveBeenCalled()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('消息')
    await page.getByRole('option', { name: '/command-1 ', exact: false }).first().click()
    expect(choose).toHaveBeenCalledWith('command-1')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('消息')
  })

  it('anchors above the card without changing layout and closes with an outside press', async () => {
    await render(<Fixture />)
    await page.getByRole('textbox', { name: '消息' }).click()
    const anchor = document.querySelector('textarea')!.parentElement!
    const layer = document.querySelector<HTMLElement>('.ui-suggest')!
    const rectangle = anchor.getBoundingClientRect()
    expect(layer.matches(':popover-open')).toBe(true)
    expect(layer.getBoundingClientRect().width).toBe(rectangle.width)
    expect(layer.getBoundingClientRect().bottom).toBeLessThanOrEqual(rectangle.top - 5)
    await page.getByRole('button', { name: '其他入口' }).click()
    expect(layer.matches(':popover-open')).toBe(false)
    expect(anchor.getBoundingClientRect().top).toBe(rectangle.top)
  })

  it('withdraws a top-layer list when its preserved conversation becomes inert', async () => {
    await render(<Fixture />)
    await page.getByRole('textbox', { name: '消息' }).click()
    const anchor = document.querySelector('textarea')!.parentElement!
    anchor.inert = true
    await expect.poll(() => document.querySelector('.ui-suggest')?.matches(':popover-open')).toBe(false)
    await userEvent.keyboard('2')
    expect(document.querySelector('textarea')!.value).toBe('')
  })
})
