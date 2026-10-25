import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { Plus, Puzzle } from 'lucide-react'
import { Tile, TileAction, TileChoice, type TileChoiceOption } from '../src/index.ts'
import { press } from './helpers.ts'

const OPTIONS: Array<TileChoiceOption<string>> = [
  { value: 'agent', label: 'Latch 内置', note: 'Agent', tile: <Tile size={40} icon={Puzzle} />, description: '可以读写文件' },
  { value: 'chat', label: 'Latch 内置', note: '只对话', tile: <Tile size={40} icon={Puzzle} />, description: '不读写文件' },
  {
    value: 'codex',
    label: 'Codex',
    note: '仅本机桌面端',
    tile: <Tile size={40} icon={Puzzle} />,
    disabledReason: '只能在执行端电脑上开启',
  },
  { value: 'goose', label: 'goose', note: '完全访问', tile: <Tile size={40} icon={Puzzle} /> },
]

function Harnesses({ initial = 'agent', compact = false }: { initial?: string; compact?: boolean }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <button type="button">之前</button>
      <TileChoice label="Agent" variant={compact ? 'compact' : 'tiles'} value={value} options={OPTIONS} onValueChange={setValue}>
        <TileAction variant={compact ? 'compact' : 'tiles'} icon={Plus} label="添加 Agent" note="5 个可添加" />
      </TileChoice>
    </>
  )
}

describe('tile choice', () => {
  it.each([false, true])('keeps one radio tab stop and arrow selection in compact=%s, skipping what cannot be chosen', async compact => {
    const screen = await render(<Harnesses compact={compact} />)
    const group = screen.getByRole('radiogroup', { name: 'Agent' })
    await expect.element(group).toBeVisible()
    const radios = group.getByRole('radio').elements()
    expect(radios.map(radio => radio.tabIndex)).toEqual([0, -1, -1, -1])
    screen.getByRole('button', { name: '之前' }).element().focus()
    await userEvent.keyboard('{Tab}')
    await expect.element(screen.getByRole('radio', { name: /Agent$/ })).toHaveFocus()
    await userEvent.keyboard('{ArrowRight}')
    await expect.element(screen.getByRole('radio', { name: /只对话/ })).toHaveAttribute('aria-checked', 'true')
    // Codex cannot be chosen: the next arrow goes past it to goose.
    await userEvent.keyboard('{ArrowRight}')
    await expect.element(screen.getByRole('radio', { name: /goose/ })).toHaveFocus()
    await expect.element(screen.getByRole('radio', { name: /goose/ })).toHaveAttribute('aria-checked', 'true')
    await userEvent.keyboard('{Home}')
    await expect.element(screen.getByRole('radio', { name: /Agent$/ })).toHaveAttribute('aria-checked', 'true')
    // The action after the row is its own tab stop, outside the group.
    await userEvent.keyboard('{Tab}')
    await expect.element(screen.getByRole('button', { name: /^添加 Agent/ })).toHaveFocus()
  })

  it('keeps an item that cannot be chosen focusable, says why in its description, and says it under the row when pressed', async () => {
    const screen = await render(<Harnesses />)
    const codex = screen.getByRole('radio', { name: /Codex/ })
    await expect.element(codex).toHaveAttribute('aria-disabled', 'true')
    await expect.element(codex).toHaveAccessibleDescription('只能在执行端电脑上开启')
    const line = () => screen.container.querySelector('.ui-tile-choice-reason')?.closest('.ui-collapse')?.getAttribute('data-state')
    expect(screen.getByRole('status').element().textContent).toBe('')
    expect(line()).toBe('closed')
    press(codex)
    await expect.element(codex).toHaveAttribute('aria-checked', 'false')
    await expect.element(screen.getByRole('status')).toHaveTextContent('只能在执行端电脑上开启')
    // The line opens under the row like a disclosure, so the row above it stays where it is.
    expect(line()).toBe('open')
    await expect.element(screen.container.querySelector<HTMLElement>('.ui-tile-choice-reason')!).toHaveTextContent('只能在执行端电脑上开启')
    // Choosing something else clears it: the line folds away with its words.
    await screen.getByRole('radio', { name: /只对话/ }).click()
    expect(screen.getByRole('status').element().textContent).toBe('')
    await expect.poll(line).toBe('closed')
  })

  it('draws the chosen tile on the neutral selection ground, never ringed, and dims only the tile and name of one that cannot be chosen', async () => {
    const screen = await render(<Harnesses />)
    const chosen = screen.getByRole('radio', { name: /Agent$/ }).element()
    const root = getComputedStyle(document.documentElement)
    const probe = document.createElement('span')
    probe.style.backgroundColor = root.getPropertyValue('--bg-selected-solid')
    document.body.append(probe)
    expect(getComputedStyle(chosen).backgroundColor).toBe(getComputedStyle(probe).backgroundColor)
    probe.remove()
    expect(getComputedStyle(chosen).boxShadow).toBe('none')
    expect(getComputedStyle(chosen.querySelector('.ui-tile-choice-label')!).fontWeight).toBe('500')
    const codex = screen.getByRole('radio', { name: /Codex/ }).element()
    expect(getComputedStyle(codex.querySelector('.ui-tile-choice-tile')!).opacity).toBe('0.45')
    expect(getComputedStyle(codex.querySelector('.ui-tile-choice-note')!).opacity).toBe('1')
  })
})
