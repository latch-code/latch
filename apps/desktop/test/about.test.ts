import { createRequire } from 'node:module'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { ABOUT_CSP, ABOUT_URL, aboutPage, aboutResponse, parseAboutAppearance } = require('../src/about.cjs') as {
  ABOUT_CSP: string
  ABOUT_URL: string
  aboutPage(input: { version: string; icon?: string }): string
  aboutResponse(request: Request, input: { version: string; icon?: string }): Response | undefined
  parseAboutAppearance(value: unknown): { background: string; css: string } | undefined
}

it('accepts only a resolved scheme with four opaque colours for the native window', () => {
  const colors = '#010203 #fafafa #adadad #636363'
  for (const scheme of ['light', 'dark']) {
    const theme = parseAboutAppearance(`${scheme} ${colors}`)
    expect(theme?.background).toBe('#010203')
    expect(theme?.css).toContain(`color-scheme:${scheme}`)
  }
  for (const bad of [
    null,
    {},
    colors,
    `system ${colors}`,
    `dark ${colors} extra`,
    'dark red #ffffff #ffffff #ffffff',
    'dark #000000 #000000 #000000 #fff;}',
  ])
    expect(parseAboutAppearance(bad)).toBeUndefined()
})

it('writes a static page: no script, nothing loaded but its inlined mark, and the version as text only', () => {
  const icon = `data:image/png;base64,${Buffer.from('png').toString('base64')}`
  const page = aboutPage({ version: '1.2.3<script>alert(1)</script>', icon })
  expect(page).toContain(`content="${ABOUT_CSP}"`)
  expect(ABOUT_CSP).toContain("default-src 'none'")
  expect(ABOUT_CSP).not.toMatch(/script-src|connect-src|https?:/u)
  expect(page).not.toMatch(/<script|<a |<link|<iframe|https?:\/\//u)
  expect(page).toContain('1.2.3&#60;script&#62;')
  expect(page).toContain(`<img src="${icon}"`)
  // Anything that is not an inlined PNG is left out, never written into the page.
  for (const bad of ['https://example.com/x.png', 'data:image/svg+xml;base64,AAAA', 'data:image/png;base64,AA"onerror="x'])
    expect(aboutPage({ version: '1.0.0', icon: bad })).not.toContain('<img')
})

it('answers only a GET of its own address, with the policy as a header', async () => {
  const input = { version: '1.0.0' }
  const response = aboutResponse(new Request(ABOUT_URL), input)
  expect(response?.headers.get('content-security-policy')).toBe(ABOUT_CSP)
  expect(await response?.text()).toBe(aboutPage(input))
  for (const request of [new Request(ABOUT_URL, { method: 'POST' }), new Request(`${ABOUT_URL}?x`), new Request('latch://app/link/')])
    expect(aboutResponse(request, input)).toBeUndefined()
})
