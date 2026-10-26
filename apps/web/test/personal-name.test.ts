import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { usePersonalName } from '../src/hooks/usePersonalName.ts'

function Identity({ id, allowed }: { id?: string; allowed: boolean }) {
  return createElement('span', null, usePersonalName(id, allowed, 0) ?? '普通会话')
}
describe('private assistant name presentation', () => {
  it.each([true, false])('renders an ordinary session before any private metadata has loaded (allowed=%s)', allowed => {
    expect(renderToStaticMarkup(createElement(Identity, { allowed }))).toBe('<span>普通会话</span>')
  })
  it('does not require a name or reveal a cached identity when private access is absent', () => {
    expect(renderToStaticMarkup(createElement(Identity, { id: 'asst_11111111-1111-4111-8111-111111111111', allowed: false }))).toBe(
      '<span>普通会话</span>',
    )
  })
})
