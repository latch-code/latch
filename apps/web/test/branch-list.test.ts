import { describe, expect, it } from 'vitest'
import type { BranchListing } from '@latch/protocol'
import { branchRows, choosable, enterChoice, matches } from '../src/composer/branchList.ts'

const listing: BranchListing = {
  current: 'fix/studio-sidebar-history-scroll',
  branches: [
    { name: 'fix/studio-sidebar-history-scroll' },
    { name: 'feature/One' },
    { name: 'main', checkedOut: true },
    { name: 'release/history-2' },
  ],
  more: 3,
}

describe('the branch list', () => {
  it('matches anywhere in a name, ignoring case and the spaces typed around it', () => {
    expect(matches('fix/studio-sidebar-history-scroll', 'HISTORY')).toBe(true)
    expect(matches('fix/studio-sidebar-history-scroll', '  bar-hist ')).toBe(true)
    expect(matches('main', 'mian')).toBe(false)
    expect(matches('main', '')).toBe(true)
  })

  it('keeps the Host’s order, the current branch first, and counts what it does not draw', () => {
    const all = branchRows(listing, '')
    expect(all.rows.map(row => row.name)).toEqual(['fix/studio-sidebar-history-scroll', 'feature/One', 'main', 'release/history-2'])
    expect(all.rows[0]).toMatchObject({ current: true, checkedOut: false })
    expect(all.rows[2]).toMatchObject({ current: false, checkedOut: true })
    // Three the Host left out, while nothing is typed.
    expect(all.hidden).toBe(3)
    const cut = branchRows(listing, '', 2)
    expect(cut.rows).toHaveLength(2)
    expect(cut.hidden).toBe(5)
    // A search looks through every listed branch, drawn or not; what the Host left out may not match, so it is not counted.
    const found = branchRows(listing, 'history', 1)
    expect(found.rows.map(row => row.name)).toEqual(['fix/studio-sidebar-history-scroll'])
    expect(found.hidden).toBe(1)
    expect(branchRows(listing, 'one').rows.map(row => row.name)).toEqual(['feature/One'])
    expect(branchRows(listing, 'nothing')).toEqual({ rows: [], hidden: 0 })
  })

  it('switches on Enter to the first match that is neither the current branch nor held elsewhere', () => {
    expect(enterChoice(branchRows(listing, 'history').rows)?.name).toBe('release/history-2')
    expect(enterChoice(branchRows(listing, 'main').rows)).toBeUndefined()
    expect(enterChoice(branchRows(listing, '').rows)?.name).toBe('feature/One')
  })

  it('takes no second press while a switch is under way', () => {
    const [current, other, held] = branchRows(listing, '').rows
    expect(choosable(other, { state: 'idle' })).toBe(true)
    expect(choosable(other, { state: 'refused', branch: 'main', message: '…' })).toBe(true)
    expect(choosable(other, { state: 'switching', branch: 'release/history-2', requestId: 'r' })).toBe(false)
    expect(choosable(current, { state: 'idle' })).toBe(false)
    expect(choosable(held, { state: 'idle' })).toBe(false)
  })
})
