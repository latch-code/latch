import { describe, expect, it } from 'vitest'
import type { BranchListing } from '@latch/protocol'
import { branchRows, choosable, enterChoice, matches, withCurrentBranch } from '../src/composer/branchList.ts'

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

  it('keeps the Host’s order within each group and applies the display limit to each separately', () => {
    const local = branchRows(listing, '', 'local')
    expect(local.rows.map(row => row.name)).toEqual(['fix/studio-sidebar-history-scroll', 'feature/One', 'release/history-2'])
    expect(local.rows[0]).toMatchObject({ current: true, checkedOut: false })
    expect(local.hidden).toBe(0)
    expect(branchRows(listing, '', 'worktrees', 1)).toEqual({
      rows: [{ name: 'main', current: false, checkedOut: true }],
      hidden: 0,
    })
    const cut = branchRows(listing, '', 'local', 2)
    expect(cut.rows).toHaveLength(2)
    expect(cut.hidden).toBe(1)
  })

  it('searches all listed branches in the selected group before applying the limit', () => {
    const found = branchRows(listing, 'history', 'local', 1)
    expect(found.rows.map(row => row.name)).toEqual(['fix/studio-sidebar-history-scroll'])
    expect(found.hidden).toBe(1)
    expect(branchRows(listing, 'one', 'local', 1).rows.map(row => row.name)).toEqual(['feature/One'])
    expect(branchRows(listing, 'main', 'worktrees', 1).rows.map(row => row.name)).toEqual(['main'])
    expect(branchRows(listing, 'main', 'local')).toEqual({ rows: [], hidden: 0 })
    expect(branchRows(listing, 'one', 'worktrees')).toEqual({ rows: [], hidden: 0 })
  })

  it('switches on Enter to the first match that is neither the current branch nor held elsewhere', () => {
    expect(enterChoice(branchRows(listing, 'history', 'local').rows)?.name).toBe('release/history-2')
    expect(enterChoice(branchRows(listing, 'main', 'worktrees').rows)).toBeUndefined()
    expect(enterChoice(branchRows(listing, '', 'local').rows)?.name).toBe('feature/One')
  })

  it('marks a confirmed branch first, keeps other branches, and drops the detached HEAD label', () => {
    const detached = { detached: 'abcdef1', branches: [...listing.branches, { name: '中文分支' }], more: 3 }
    expect(withCurrentBranch(detached, '中文分支')).toEqual({
      current: '中文分支',
      branches: [
        { name: '中文分支' },
        { name: 'feature/One' },
        { name: 'fix/studio-sidebar-history-scroll' },
        { name: 'main', checkedOut: true },
        { name: 'release/history-2' },
      ],
      more: 3,
    })
  })

  it('takes no second press while a switch is under way', () => {
    const [current, other] = branchRows(listing, '', 'local').rows
    const [held] = branchRows(listing, '', 'worktrees').rows
    expect(choosable(other, { state: 'idle' })).toBe(true)
    expect(choosable(other, { state: 'refused', branch: 'main', message: '…' })).toBe(true)
    expect(choosable(other, { state: 'switching', branch: 'release/history-2', requestId: 'r' })).toBe(false)
    expect(choosable(current, { state: 'idle' })).toBe(false)
    expect(choosable(held, { state: 'idle' })).toBe(false)
  })
})
