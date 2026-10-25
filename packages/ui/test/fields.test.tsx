import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { Kbd, SearchField, TextField } from '../src/index.ts'
import { onTouchScreen } from './helpers.ts'

describe('text fields', () => {
  it('labels the input, describes it with its hint, and turns an error into the description and a red ring', async () => {
    const screen = await render(
      <div>
        <TextField label="设备名称" hint="只在这台 Host 的设备列表里显示。" />
        <TextField label="地址" defaultValue="api.example" error="地址要以 https:// 开头。" />
      </div>,
    )
    const name = screen.getByRole('textbox', { name: '设备名称' })
    await expect.element(name).toHaveAccessibleDescription('只在这台 Host 的设备列表里显示。')
    await expect.element(name).not.toHaveAttribute('aria-invalid')
    const address = screen.getByRole('textbox', { name: '地址' })
    await expect.element(address).toHaveAttribute('aria-invalid', 'true')
    await expect.element(address).toHaveAccessibleDescription('地址要以 https:// 开头。')
    expect(getComputedStyle(address.element()).boxShadow).toContain('rgb(160, 29, 20)')
  })

  it('raises a focused field and rings it in the focus colour whenever it has focus', async () => {
    const screen = await render(<TextField label="设备名称" />)
    const field = screen.getByRole('textbox', { name: '设备名称' })
    await userEvent.click(field)
    await expect.poll(() => getComputedStyle(field.element()).backgroundColor).toBe('rgb(255, 255, 255)')
    await expect.poll(() => getComputedStyle(field.element()).boxShadow).toContain('rgb(36, 97, 224)')
  })
})

function Search() {
  const [query, setQuery] = useState('')
  return <SearchField label="搜索会话" value={query} onValueChange={setQuery} trailing={<Kbd>⌘K</Kbd>} />
}

describe('search field', () => {
  it('shows its key while empty, a clear button once there is text, and clears on Escape', async () => {
    const screen = await render(<Search />)
    const input = screen.getByRole('searchbox', { name: '搜索会话' })
    await expect.element(screen.getByText('⌘K')).toBeVisible()
    // The glyph sits 6 from the text, the gap between an icon and its text inside a control.
    const glyph = input.element().parentElement?.querySelector('.ui-search-glyph')?.getBoundingClientRect()
    expect(glyph && input.element().getBoundingClientRect().left - glyph.right).toBe(6)
    await userEvent.fill(input, '设置')
    await expect.element(screen.getByText('⌘K')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '清除搜索' }))
    await expect.element(input).toHaveValue('')
    await expect.element(input).toHaveFocus()
    await userEvent.fill(input, '设置')
    await userEvent.keyboard('{Escape}')
    await expect.element(input).toHaveValue('')
  })

  it('draws the ghost search as a row on the ground: nothing at rest, the raised well and its ring only under focus', async () => {
    const screen = await render(
      <div style={{ width: 240 }}>
        <SearchField variant="ghost" label="搜索会话" value="" onValueChange={() => {}} trailing={<Kbd>⌘K</Kbd>} />
      </div>,
    )
    const input = screen.getByRole('searchbox', { name: '搜索会话' })
    const field = input.element().parentElement!
    const style = getComputedStyle(field)
    expect([style.backgroundColor, style.boxShadow, field.getBoundingClientRect().height]).toEqual(['rgba(0, 0, 0, 0)', 'none', 36])
    // The glyph is a row's 16 icon, 8 from the start and 8 from the text.
    const glyph = field.querySelector('.ui-search-glyph')!.getBoundingClientRect()
    const box = field.getBoundingClientRect()
    expect([glyph.width, glyph.left - box.left, input.element().getBoundingClientRect().left - glyph.right]).toEqual([16, 8, 8])
    await userEvent.click(input)
    await expect.poll(() => getComputedStyle(field).backgroundColor).toBe('rgb(255, 255, 255)')
    await expect.poll(() => getComputedStyle(field).boxShadow).toContain('rgb(36, 97, 224)')
  })

  it('keeps a 44×44 target around its 24px clear button on touch screens', async () => {
    await onTouchScreen(async () => {
      const screen = await render(<SearchField label="搜索会话" value="设置" onValueChange={() => {}} />)
      const clear = screen.getByRole('button', { name: '清除搜索' }).element()
      const target = getComputedStyle(clear, '::after')
      expect([clear.getBoundingClientRect().width, target.width, target.height, target.position]).toEqual([24, '44px', '44px', 'absolute'])
      // The target is centred on the button.
      expect([target.top, target.left]).toEqual(['-10px', '-10px'])
    })
  })
})
