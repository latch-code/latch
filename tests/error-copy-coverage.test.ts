import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { appErrorCodes, catalogCodes, classify, scanErrorCopy } from '../scripts/error-copy-coverage.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

describe('error copy coverage', () => {
  it('finds codes thrown directly, through wrappers in this file or another, and from refusal tables', () => {
    const files = {
      'apps/host/src/a.ts': [
        "import { AppError } from '@latch/sdk'",
        'const refuse = (code: string, message: string) => new AppError(409, code, message)',
        "export function denied(code: string): AppError { return new AppError(403, code, '不行') }",
        "throw new AppError(400, 'plain-code', '原因')",
        "throw refuse(ok ? 'wrapped-a' : 'wrapped-b', '原因')",
        "const TABLE = { missing: { status: 404, code: 'table-missing', message: '找不到' } }",
        'const failure = TABLE[status]',
        'throw new AppError(failure.status, failure.code, failure.message)',
        "const REASONS = { 'keyed-one': '一', 'keyed-two': '二' } as const",
        'const keyed = (reason: keyof typeof REASONS) => new AppError(400, reason, REASONS[reason])',
      ].join('\n'),
      'apps/host/src/b.ts': [
        "import { denied } from './a.ts'",
        "throw denied('imported-wrapper')",
        'throw new AppError(500, other.code, other.message)',
      ].join('\n'),
    }
    const { codes, unresolved } = appErrorCodes(files)
    expect([...codes.keys()].sort()).toEqual([
      'imported-wrapper',
      'keyed-one',
      'keyed-two',
      'plain-code',
      'table-missing',
      'wrapped-a',
      'wrapped-b',
    ])
    expect(unresolved).toEqual([{ where: 'apps/host/src/b.ts:3', expression: 'other.code' }])
  })

  it('reads the catalogue and fails a security-class code without an entry', () => {
    const catalog = catalogCodes(
      [
        ...['FIXED', 'EXTRA_FAILURES', 'FIXED_SHARED'].map(name => `const ${name} = defineCopy({ 'known-${name}': '知' }, {})`),
        "const HOST_REFUSALS = defineCopy({ 'item-secret': '密' }, {})",
        "const FAMILY_FALLBACK = [['presence-', () => '']]",
        "export function describeFailure(code: string) { switch (code) { case 'egress-denied': return '' } }",
      ].join('\n'),
    )
    const report = classify(
      new Map([
        ['item-secret', ['a:1']],
        ['presence-new', ['a:2']],
        ['egress-denied', ['a:3']],
        ['note-secret', ['a:4']],
        ['task-running', ['a:5']],
      ]),
      catalog,
    )
    expect(report.catalogued).toEqual(['egress-denied', 'item-secret', 'presence-new'])
    expect(report.hostText).toEqual(['task-running'])
    expect(report.missing).toEqual([{ code: 'note-secret', where: ['a:4'] }])
  })

  it('has an entry for every security-class code the Host throws, and names every code site', async () => {
    const report = await scanErrorCopy(ROOT)
    expect(report.missing).toEqual([])
    expect(report.unresolved).toEqual([])
    // The scan reaches the codes the page words itself: an empty or broken scan cannot pass.
    expect(report.catalogued).toEqual(
      expect.arrayContaining(['renewal-required', 'device-revoked', 'terminal-scope', 'workspace-permission']),
    )
    expect(report.hostText.length).toBeGreaterThan(300)
  })
})
