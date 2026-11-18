import { createRequire } from 'node:module'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { ABOUT_CSP, aboutPage, aboutUrl } = require('../src/about.cjs') as {
  ABOUT_CSP: string
  aboutPage(input: { version: string; icon?: string }): string
  aboutUrl(input: { version: string; icon?: string }): string
}

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
  expect(Buffer.from(aboutUrl({ version: '1.0.0' }).split(',')[1]!, 'base64').toString('utf8')).toBe(aboutPage({ version: '1.0.0' }))
})
