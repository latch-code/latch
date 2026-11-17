import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { ModeStrip, PickerBoard, Popover, ValuePicker, type MenuTriggerProps } from '../src/index.ts'
import { GALLERY_MODES, GALLERY_SOURCES, galleryLevels } from './gallery/Boards.tsx'
import { press } from './helpers.ts'

const stripTrigger = (props: MenuTriggerProps) => (
  <button {...props} type="button">
    权限
  </button>
)

function Strip({ onChoose, initial = 'ask' }: { onChoose: (value: string) => void; initial?: string }) {
  const [value, setValue] = useState(initial)
  return (
    <Popover label="权限" trigger={stripTrigger}>
      <ModeStrip
        label="什么时候问你？"
        value={value}
        options={GALLERY_MODES.map(mode => (mode.value === 'rule' ? { ...mode, disabledReason: '这台设备不能改' } : mode))}
        onChoose={next => {
          setValue(next)
          onChoose(next)
        }}
      />
    </Popover>
  )
}

const shown = () => document.querySelector('.ui-mode-strip-name')?.textContent
const line = () => document.querySelector('.ui-mode-strip-line')?.textContent

describe('the mode strip', () => {
  it('opens on the chosen mode, previews with the arrows and hover without choosing, and chooses with Enter', async () => {
    const onChoose = vi.fn()
    const screen = await render(<Strip onChoose={onChoose} />)
    await screen.getByRole('button', { name: '权限' }).click()
    const ask = screen.getByRole('radio', { name: '先问你' })
    await expect.element(ask).toHaveFocus()
    await expect.element(ask).toHaveAttribute('aria-checked', 'true')
    expect(shown()).toBe('先问你')
    const height = document.querySelector<HTMLElement>('.ui-mode-strip')!.offsetHeight
    await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}')
    // Moved to the loosest mode: previewed, in amber, not chosen.
    const never = screen.getByRole('radio', { name: '不再询问' })
    await expect.element(never).toHaveFocus()
    expect(shown()).toBe('不再询问')
    expect(line()).toBe('改文件、运行命令都不再问你。')
    expect(never.element().hasAttribute('data-preview')).toBe(true)
    expect(getComputedStyle(never.element()).color).not.toBe(getComputedStyle(ask.element()).color)
    expect(onChoose).not.toHaveBeenCalled()
    // Layout size, not the opening's scale.
    expect(document.querySelector<HTMLElement>('.ui-mode-strip')!.offsetHeight).toBe(height)
    await userEvent.hover(screen.getByRole('radio', { name: '只看不改' }))
    expect(shown()).toBe('只看不改')
    await userEvent.keyboard('{Enter}')
    expect(onChoose).toHaveBeenCalledWith('never')
  })

  it('keeps a mode that cannot be chosen focusable, with its reason, and never chooses it', async () => {
    const onChoose = vi.fn()
    const screen = await render(<Strip onChoose={onChoose} />)
    await screen.getByRole('button', { name: '权限' }).click()
    const rule = screen.getByRole('radio', { name: '按规则放行' })
    await expect.element(rule).toHaveAttribute('aria-disabled', 'true')
    press(rule)
    await userEvent.keyboard('{ArrowRight}{Enter}')
    expect(onChoose).not.toHaveBeenCalled()
    await expect.element(rule).toHaveAccessibleDescription(/这台设备不能改/u)
  })
})

function Board({
  onLevel = () => {},
  onItem = () => {},
}: {
  onLevel?: (item: string | undefined, level: string) => void
  onItem?: (item: string) => void
}) {
  const [value, setValue] = useState<string | undefined>('lab/beta')
  return (
    <ValuePicker
      label="模型"
      value="face"
      options={[{ value: 'face', label: value ?? '' }]}
      onValueChange={() => {}}
      width="lg"
      panel={
        <PickerBoard
          label="模型"
          levelsLabel="思考"
          sources={GALLERY_SOURCES}
          value={value}
          levels={galleryLevels}
          onItem={next => {
            setValue(next)
            onItem(next)
          }}
          onLevel={onLevel}
          keyCaps={index => `⌘${index + 1}`}
          pickIndex={event => (event.metaKey && /^Digit[1-9]$/u.test(event.code) ? Number(event.code.slice(5)) - 1 : undefined)}
        />
      }
    />
  )
}

const board = () => document.querySelector<HTMLElement>('.ui-board')!
const levelNames = () => Array.from(document.querySelectorAll('.ui-board-level'), level => level.getAttribute('aria-label'))

describe('the picker board', () => {
  it('opens on the chosen item, and the levels follow the highlight without the board changing size', async () => {
    const screen = await render(<Board />)
    await screen.getByRole('button', { name: /^模型/u }).click()
    await expect.element(screen.getByRole('menuitemradio', { name: 'beta' })).toHaveFocus()
    expect(document.querySelector('.ui-board-source[aria-selected="true"]')?.getAttribute('aria-label')).toBe('Lab · 经 Latch')
    // Rows carry their keys, the first nine only.
    expect(Array.from(document.querySelectorAll('.ui-board-item .ui-kbd'), kbd => kbd.textContent)).toEqual(
      ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(digit => `⌘${digit}`),
    )
    const size = [board().offsetWidth, board().offsetHeight]
    expect(levelNames()).toEqual(['默认', '低', '中', '高'])
    await userEvent.keyboard('{ArrowDown}')
    await expect.element(screen.getByRole('menuitemradio', { name: 'gamma' })).toHaveFocus()
    expect(levelNames()).toEqual(['默认'])
    expect(document.querySelector('.ui-board-note')?.textContent).toBe('用模型默认值')
    expect([board().offsetWidth, board().offsetHeight]).toEqual(size)
  })

  it('keeps the board open on the levels of a chosen item that has them, and closes on a level', async () => {
    const onLevel = vi.fn()
    const onItem = vi.fn()
    const screen = await render(<Board onLevel={onLevel} onItem={onItem} />)
    await screen.getByRole('button', { name: /^模型/u }).click()
    await userEvent.keyboard('{ArrowUp}{Enter}')
    expect(onItem).toHaveBeenCalledWith('lab/alpha')
    await expect.element(screen.getByRole('menuitemradio', { name: '默认' })).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    expect(onLevel).toHaveBeenCalledWith('lab/alpha', 'medium')
    await expect.poll(() => document.querySelector('.ui-board')?.closest('[popover]')?.matches(':popover-open')).toBe(false)
  })

  it('closes on an item without levels, and takes the printed key for a row', async () => {
    const onItem = vi.fn()
    const screen = await render(<Board onItem={onItem} />)
    await screen.getByRole('button', { name: /^模型/u }).click()
    await userEvent.keyboard('{Meta>}3{/Meta}')
    expect(onItem).toHaveBeenCalledWith('lab/gamma')
    await expect.poll(() => document.querySelector('.ui-board')?.closest('[popover]')?.matches(':popover-open')).toBe(false)
  })

  it('goes between the rail, the list and the levels with the arrows, and searches every source by typing', async () => {
    const screen = await render(<Board />)
    await screen.getByRole('button', { name: /^模型/u }).click()
    await userEvent.keyboard('{ArrowRight}')
    await expect.element(screen.getByRole('menuitemradio', { name: '高' })).toHaveFocus()
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}')
    await expect.element(screen.getByRole('tab', { name: 'Lab · 经 Latch' })).toHaveFocus()
    await userEvent.keyboard('{ArrowUp}')
    await expect.element(screen.getByRole('tab', { name: '最近使用' })).toHaveAttribute('aria-selected', 'true')
    expect(Array.from(document.querySelectorAll('.ui-board-item .ui-menu-item-title'), item => item.textContent)).toEqual([
      'alpha-long-model-name-2026-preview',
    ])
    await userEvent.keyboard('{ArrowRight}')
    await userEvent.keyboard('alph')
    const search = screen.getByRole('searchbox', { name: '搜索模型' })
    await expect.element(search).toHaveFocus()
    await expect.element(search).toHaveValue('alph')
    // Across sources, under each source's name.
    expect(Array.from(document.querySelectorAll('.ui-board-item .ui-menu-item-title'), item => item.textContent)).toEqual([
      'alpha-long-model-name-2026-preview',
      'alpha',
    ])
    await userEvent.keyboard('{Escape}')
    await expect.element(search).toHaveValue('')
    expect(document.querySelector('.ui-board')?.closest('[popover]')?.matches(':popover-open')).toBe(true)
    await userEvent.keyboard('{Escape}')
    await expect.poll(() => document.querySelector('.ui-board')?.closest('[popover]')?.matches(':popover-open')).toBe(false)
    await expect.element(screen.getByRole('button', { name: /^模型/u })).toHaveFocus()
  })

  it('keeps focus in the board when the list it was on is replaced while open, so Escape still closes it', async () => {
    function Reading() {
      const [read, setRead] = useState(false)
      const sources = read
        ? [{ id: 'own', label: 'Harness', icon: null, items: [{ value: 'own/large', label: 'Large' }] }]
        : [{ id: 'own', label: 'Harness', icon: null, items: [{ value: 'own', label: '默认模型' }] }]
      return (
        <>
          <ValuePicker
            label="模型"
            value="face"
            options={[{ value: 'face', label: '默认模型' }]}
            onValueChange={() => {}}
            width="lg"
            onOpenChange={open => {
              // As a draft's panel does: opening it starts a read whose answer replaces the rows.
              if (open) setTimeout(() => setRead(true), 50)
            }}
            panel={
              <PickerBoard
                label="模型"
                levelsLabel="思考"
                sources={sources}
                value={read ? undefined : 'own'}
                levels={() => ({ value: 'default', options: [{ value: 'default', label: '默认' }] })}
                onItem={() => {}}
                onLevel={() => {}}
              />
            }
          />
        </>
      )
    }
    const screen = await render(<Reading />)
    await screen.getByRole('button', { name: /^模型/u }).click()
    await expect.element(screen.getByRole('menuitemradio', { name: '默认模型' })).toHaveFocus()
    await expect.element(screen.getByRole('menuitemradio', { name: 'Large' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    await expect.poll(() => document.querySelector('.ui-board')?.closest('[popover]')?.matches(':popover-open')).toBe(false)
    await expect.element(screen.getByRole('button', { name: /^模型/u })).toHaveFocus()
  })

  it('opens on the levels when its trigger asks', async () => {
    const screen = await render(
      <ValuePicker
        label="思考"
        value="face"
        options={[{ value: 'face', label: '高' }]}
        onValueChange={() => {}}
        panel={
          <PickerBoard
            label="模型"
            levelsLabel="思考"
            sources={GALLERY_SOURCES}
            value="lab/beta"
            levels={galleryLevels}
            focus="levels"
            onItem={() => {}}
            onLevel={() => {}}
          />
        }
      />,
    )
    await screen.getByRole('button', { name: /^思考/u }).click()
    await expect.element(page.getByRole('menuitemradio', { name: '高' })).toHaveFocus()
  })

  it('opens on a search asked for (a slash argument), with the field filled and focused', async () => {
    function Asked() {
      const [request, setRequest] = useState<{ query: string; revision: number }>()
      return (
        <>
          <button type="button" onClick={() => setRequest({ query: 'gam', revision: 1 })}>
            ask
          </button>
          <ValuePicker
            label="模型"
            value="face"
            options={[{ value: 'face', label: 'beta' }]}
            onValueChange={() => {}}
            searchRequest={request}
            panel={
              <PickerBoard
                label="模型"
                levelsLabel="思考"
                sources={GALLERY_SOURCES}
                value="lab/beta"
                levels={galleryLevels}
                query={request}
                onItem={() => {}}
                onLevel={() => {}}
              />
            }
          />
        </>
      )
    }
    const screen = await render(<Asked />)
    await screen.getByRole('button', { name: 'ask' }).click()
    const search = screen.getByRole('searchbox', { name: '搜索模型' })
    await expect.element(search).toHaveFocus()
    await expect.element(search).toHaveValue('gam')
    expect(Array.from(document.querySelectorAll('.ui-board-item .ui-menu-item-title'), item => item.textContent)).toEqual(['gamma'])
  })

  it('opens in one place from either of two triggers placed against the same element', async () => {
    const first = (trigger: HTMLElement) => trigger.parentElement!.querySelector<HTMLElement>('.first')!
    const screen = await render(
      <div style={{ display: 'flex', gap: 120, padding: 40 }}>
        {(['first', 'second'] as const).map(name => (
          <ValuePicker
            key={name}
            label={name}
            className={name}
            value="face"
            options={[{ value: 'face', label: name }]}
            onValueChange={() => {}}
            anchor={first}
            panel={<p>panel</p>}
          />
        ))}
      </div>,
    )
    const left = async (name: string) => {
      await screen.getByRole('button', { name: new RegExp(`^${name}`, 'u') }).click()
      await expect.poll(() => document.querySelector('[popover]:popover-open')?.getBoundingClientRect().left).toBeDefined()
      const value = document.querySelector('[popover]:popover-open')!.getBoundingClientRect().left
      await userEvent.keyboard('{Escape}')
      return value
    }
    expect(await left('second')).toBe(await left('first'))
  })
})
