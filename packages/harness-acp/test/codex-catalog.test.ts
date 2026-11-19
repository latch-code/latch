import { expect, it } from 'vitest'
import { CODEX_ROUTE_CONTEXT, codexRouteCatalog } from '../src/profiles/codex-catalog.ts'

const bundled = JSON.stringify({ models: [{ slug: 'gpt-known', context_window: 272_000, kept: { as: 'is' } }] })
const slugs = (text: string | undefined) =>
  (JSON.parse(text ?? '{"models":[]}') as { models: Array<{ slug: string; context_window: number; max_context_window?: number }> }).models

it("adds the service's unknown models with their windows and keeps Codex's own entries as they are", () => {
  const catalog = codexRouteCatalog(
    bundled,
    [{ id: 'gpt-known', contextTokens: 64_000 }, { id: 'wide' }, { id: 'declared', contextTokens: 1_000_000 }],
    'declared',
  )
  const models = slugs(catalog)
  expect(models.map(model => model.slug)).toEqual(['gpt-known', 'declared', 'wide'])
  expect(models[0]).toEqual({ slug: 'gpt-known', context_window: 272_000, kept: { as: 'is' } })
  expect(models[1]).toMatchObject({ context_window: 1_000_000, max_context_window: 1_000_000 })
  expect(models[2]).toMatchObject({ context_window: CODEX_ROUTE_CONTEXT, max_context_window: CODEX_ROUTE_CONTEXT })
})

it('builds nothing when Codex knows every model or printed something else', () => {
  expect(codexRouteCatalog(bundled, [{ id: 'gpt-known' }], 'gpt-known')).toBeUndefined()
  expect(codexRouteCatalog('not json', [{ id: 'wide' }], 'wide')).toBeUndefined()
  expect(codexRouteCatalog('{"models":"none"}', [{ id: 'wide' }], 'wide')).toBeUndefined()
})

it("cuts a long list after the session's own model", () => {
  const many = Array.from({ length: 100 }, (_, index) => ({ id: `m${index}` }))
  const models = slugs(codexRouteCatalog(bundled, many, 'm99'))
  expect(models).toHaveLength(33)
  expect(models[1]?.slug).toBe('m99')
})
