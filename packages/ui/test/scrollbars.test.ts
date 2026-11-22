import { afterEach, describe, expect, it } from 'vitest'

import { revealScrollbarsWhileScrolling } from '../src/index.ts'

describe('revealScrollbarsWhileScrolling', () => {
  let stop = () => {}
  afterEach(() => {
    stop()
    document.body.replaceChildren()
  })

  it('marks an element only while it scrolls', async () => {
    stop = revealScrollbarsWhileScrolling()
    const list = document.createElement('div')
    list.style.cssText = 'height: 40px; overflow-y: auto'
    list.append(Object.assign(document.createElement('div'), { style: 'height: 200px' }))
    document.body.append(list)
    expect(list.classList.contains('ui-scrolling')).toBe(false)
    list.scrollTop = 60
    await expect.poll(() => list.classList.contains('ui-scrolling')).toBe(true)
    await expect.poll(() => list.classList.contains('ui-scrolling'), { timeout: 3000 }).toBe(false)
  })
})
