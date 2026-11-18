import { afterEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { setUiLocale, UI_COPY, useUiLocale } from '../src/locale.ts'

const initialLang = document.documentElement.lang

afterEach(() => {
  setUiLocale(undefined)
  document.documentElement.lang = initialLang
})

function SearchField() {
  useUiLocale()
  return <input aria-label={UI_COPY.search} />
}

describe('the primitive labels', () => {
  it('follows the document while keeping the focused input and its selection', async () => {
    document.documentElement.lang = 'zh-CN'
    const screen = await render(<SearchField />)
    await expect.element(screen.getByRole('textbox', { name: '搜索' })).toBeVisible()
    const input = screen.container.querySelector('input')!
    input.focus()
    input.value = 'draft'
    input.setSelectionRange(1, 4)

    document.documentElement.lang = 'en'
    await expect.element(screen.getByRole('textbox', { name: 'Search' })).toBeVisible()
    expect(screen.container.querySelector('input')).toBe(input)
    expect(document.activeElement).toBe(input)
    expect([input.value, input.selectionStart, input.selectionEnd]).toEqual(['draft', 1, 4])
  })

  it('can pin a language for the gallery and resume following the document', async () => {
    document.documentElement.lang = 'zh-TW'
    const screen = await render(<SearchField />)
    await expect.element(screen.getByRole('textbox', { name: '搜索' })).toBeVisible()

    setUiLocale('en')
    await expect.element(screen.getByRole('textbox', { name: 'Search' })).toBeVisible()
    expect(document.documentElement.lang).toBe('zh-TW')

    setUiLocale(undefined)
    await expect.element(screen.getByRole('textbox', { name: '搜索' })).toBeVisible()
  })
})
