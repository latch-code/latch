import { expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { StatusSlot } from '../src/index.ts'
import { onTouchScreen } from './helpers.ts'

it('keeps the status of a row with actions on a touch screen', async () => {
  await onTouchScreen(async () => {
    const screen = await render(
      <div data-status-row="" style={{ width: 200 }}>
        <StatusSlot status="time" time="2 分钟" actions={<button type="button">归档</button>} />
      </div>,
    )
    const slot = screen.container.querySelector('.ui-status-slot')!
    const actions = screen.container.querySelector('.ui-status-swap-actions')!
    expect(getComputedStyle(slot).opacity).toBe('1')
    expect(getComputedStyle(actions).display).toBe('none')
  })
})
