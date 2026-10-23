import { describe, expect, it } from 'vitest'
import { checkExceptions, checkPackageManagerPin, parsePackageManagerPin, PUBLIC_REGISTRY, utcDate } from '../scripts/supply-chain.ts'

const LOCKFILE = `lockfileVersion: '9.0'

packages:

  cordis@4.0.0-rc.12:
    resolution: {integrity: sha512-AAAA}

  '@scope/pkg@1.2.3':
    resolution: {integrity: sha512-AAAA}

  '@scope/pkg@1.2.4':
    resolution: {integrity: sha512-AAAA}

  undici-types@6.21.0:
    resolution: {integrity: sha512-AAAA}
`

const TODAY = '2026-10-24'

function group(entries: string[], fields: { reason?: string, reviewer?: string, expires?: string } = {}): string {
  const { reason = 'locked before the seven-day rule', reviewer = 'owner', expires = '2026-10-28' } = fields
  const comment = [reason && `  # reason: ${reason}`, reviewer && `  # reviewer: ${reviewer}`, expires && `  # expires: ${expires}`].filter(Boolean)
  return [...comment, ...entries.map(entry => `  - '${entry}'`)].join('\n')
}

function workspace(lists: Partial<Record<'minimumReleaseAgeExclude' | 'trustPolicyExclude', string[]>>): string {
  return ['packages:', '  - .', ...Object.entries(lists).flatMap(([setting, groups]) => [`${setting}:`, ...groups]), ''].join('\n')
}

const problemsOf = (yaml: string, today = TODAY) => checkExceptions(yaml, LOCKFILE, today).problems

describe('supply-chain exceptions', () => {
  it('accepts exact versions that carry a reason, reviewer and expiry date', () => {
    const report = checkExceptions(workspace({
      minimumReleaseAgeExclude: [group(['cordis@4.0.0-rc.12', '@scope/pkg@1.2.3 || 1.2.4'])],
      trustPolicyExclude: [group(['undici-types@6.21.0'], { expires: '2027-01-20' })],
    }), LOCKFILE, TODAY)
    expect(report.problems).toEqual([])
    expect(report.groups.map(({ setting, reviewer, expires, entries }) => ({ setting, reviewer, expires, entries }))).toEqual([
      { setting: 'minimumReleaseAgeExclude', reviewer: 'owner', expires: '2026-10-28', entries: ['cordis@4.0.0-rc.12', '@scope/pkg@1.2.3 || 1.2.4'] },
      { setting: 'trustPolicyExclude', reviewer: 'owner', expires: '2027-01-20', entries: ['undici-types@6.21.0'] },
    ])
  })

  it('stays valid through its expiry date and fails from the next UTC day', () => {
    const yaml = workspace({ minimumReleaseAgeExclude: [group(['cordis@4.0.0-rc.12'], { expires: '2026-10-28' })] })
    expect(problemsOf(yaml, '2026-10-28')).toEqual([])
    expect(problemsOf(yaml, '2026-10-29')).toEqual([expect.stringContaining('已于 2026-10-28 到期')])
    expect(utcDate(new Date('2026-10-28T23:59:59+08:00'))).toBe('2026-10-28')
  })

  it.each(['cordis', '@scope/*', 'cordis@^4.0.0', 'cordis@4.x', 'cordis@>=4.0.0-rc.12', 'cordis@latest', 'cordis@4.0.0-rc.12 || ^4'])(
    'rejects %s, which would also admit future releases', entry => {
      expect(problemsOf(workspace({ minimumReleaseAgeExclude: [group([entry])] }))).toEqual([expect.stringContaining(`${entry} 不是 name@精确版本`)])
    })

  it('requires every group to state a reason, a reviewer and a real date', () => {
    expect(problemsOf(workspace({ minimumReleaseAgeExclude: [group(['cordis@4.0.0-rc.12'], { reviewer: '' })] })))
      .toEqual([expect.stringContaining('缺少 reviewer:')])
    expect(problemsOf(workspace({ minimumReleaseAgeExclude: [group(['cordis@4.0.0-rc.12'], { reason: '' })] })))
      .toEqual([expect.stringContaining('缺少 reason:')])
    expect(problemsOf(workspace({ minimumReleaseAgeExclude: [group(['cordis@4.0.0-rc.12'], { expires: '2026-11-31' })] })))
      .toEqual([expect.stringContaining('YYYY-MM-DD')])
    expect(problemsOf(workspace({ minimumReleaseAgeExclude: ["  - 'cordis@4.0.0-rc.12'"] })))
      .toEqual([expect.stringContaining('cordis@4.0.0-rc.12 前缺少 reason:、reviewer: 与 expires: 注释')])
  })

  it('rejects an expiry date more than 90 days ahead', () => {
    const yaml = (expires: string) => workspace({ trustPolicyExclude: [group(['undici-types@6.21.0'], { expires })] })
    expect(problemsOf(yaml('2027-01-22'))).toEqual([])
    expect(problemsOf(yaml('2027-01-23'))).toEqual([expect.stringContaining('超过 90 天')])
  })

  it('reports exceptions for versions that are no longer in the lockfile', () => {
    expect(problemsOf(workspace({ minimumReleaseAgeExclude: [group(['cordis@4.0.0-rc.11', '@scope/pkg@1.2.3 || 1.2.5'])] }))).toEqual([
      expect.stringContaining('cordis@4.0.0-rc.11 不在 pnpm-lock.yaml 中'),
      expect.stringContaining('@scope/pkg@1.2.5 不在 pnpm-lock.yaml 中'),
    ])
    expect(checkExceptions(workspace({ minimumReleaseAgeExclude: [group(['cordis@4.0.0-rc.12'])] }), undefined, TODAY).problems)
      .toEqual(['找不到 pnpm-lock.yaml，无法核对例外'])
  })

  it('applies each comment block to the entries below it until the next block', () => {
    const report = checkExceptions(workspace({
      minimumReleaseAgeExclude: [
        group(['cordis@4.0.0-rc.12'], { reason: 'first', expires: '2026-10-30' }),
        group(['@scope/pkg@1.2.3', '@scope/pkg@1.2.4'], { reason: 'second', expires: '2026-10-20' }),
      ],
    }), LOCKFILE, TODAY)
    expect(report.groups.map(({ reason, entries }) => ({ reason, entries }))).toEqual([
      { reason: 'first', entries: ['cordis@4.0.0-rc.12'] },
      { reason: 'second', entries: ['@scope/pkg@1.2.3', '@scope/pkg@1.2.4'] },
    ])
    expect(report.problems).toEqual([expect.stringContaining('「second」 已于 2026-10-20 到期')])
  })

  it('joins indented continuation lines into the field above', () => {
    const yaml = workspace({ minimumReleaseAgeExclude: [
      '  # reason: first line', '  #   second line', '  # reviewer: owner', '  # expires: 2026-10-28', "  - 'cordis@4.0.0-rc.12'",
    ] })
    expect(checkExceptions(yaml, LOCKFILE, TODAY).groups[0]!.reason).toBe('first line second line')
  })

  it('rejects duplicates, inline lists and comments that do not start with a field', () => {
    expect(problemsOf(workspace({ minimumReleaseAgeExclude: [group(['cordis@4.0.0-rc.12', 'cordis@4.0.0-rc.12'])] })))
      .toEqual([expect.stringContaining('cordis@4.0.0-rc.12 重复')])
    expect(problemsOf("packages:\n  - .\nminimumReleaseAgeExclude: cordis@4.0.0-rc.12\n")).toEqual(['minimumReleaseAgeExclude 必须是逐行列出的列表'])
    expect(problemsOf(workspace({ minimumReleaseAgeExclude: [`  # approved\n${group(['cordis@4.0.0-rc.12'])}`] })))
      .toEqual([expect.stringContaining('例外注释必须以 reason: 开头')])
  })
})

describe('packageManager pin', () => {
  const digest = Buffer.alloc(64, 0xab)
  const pinned = `pnpm@11.28.6+sha512.${digest.toString('hex')}`
  const registry = (document: unknown) => async (url: string) => {
    expect(url).toBe(`${PUBLIC_REGISTRY}/pnpm/11.28.6`)
    return document
  }
  const published = (integrity: Buffer, version = '11.28.6') => ({ name: 'pnpm', version, dist: { integrity: `sha512-${integrity.toString('base64')}` } })

  it('accepts a pin whose sha512 is the integrity the public registry publishes', async () => {
    expect(await checkPackageManagerPin(pinned, registry(published(digest)))).toEqual({ pin: { version: '11.28.6', sha512: digest.toString('hex') }, problems: [] })
  })

  it('rejects a hash or version that differs from the registry', async () => {
    expect((await checkPackageManagerPin(pinned, registry(published(Buffer.alloc(64, 0xcd))))).problems).toEqual([expect.stringContaining('sha512 与')])
    expect((await checkPackageManagerPin(pinned, registry(published(digest, '11.28.7'))))).toMatchObject({ problems: [expect.stringContaining('不一致')] })
  })

  it('requires an exact pnpm version with a sha512', () => {
    expect(parsePackageManagerPin('pnpm@11.28.6')).toBeUndefined()
    expect(parsePackageManagerPin(`yarn@4.5.0+sha512.${digest.toString('hex')}`)).toBeUndefined()
    expect(parsePackageManagerPin(`pnpm@11.28.6+sha256.${digest.toString('hex').slice(0, 64)}`)).toBeUndefined()
    expect(parsePackageManagerPin(undefined)).toBeUndefined()
  })

  it('fails closed when the registry cannot be read or answers something else', async () => {
    expect((await checkPackageManagerPin(pinned, async () => { throw new Error('offline') })).problems).toEqual([expect.stringContaining('offline')])
    expect((await checkPackageManagerPin(pinned, registry({ name: 'pnpm', version: '11.28.6', dist: {} }))).problems).toEqual([expect.stringContaining('无法从')])
    expect((await checkPackageManagerPin('pnpm@11.28.6', registry({}))).problems).toEqual([expect.stringContaining('packageManager 必须写成')])
  })
})
