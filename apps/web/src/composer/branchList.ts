import type { BranchListing } from '@latch/protocol'

/** Rows drawn at once; the search still looks through every branch the Host listed. */
const BRANCH_ROWS = 100

export type BranchGroup = 'local' | 'worktrees'

export interface BranchRow {
  name: string
  current: boolean
  /** Held by another worktree: shown, never chosen. */
  checkedOut: boolean
}

export interface BranchRows {
  rows: BranchRow[]
  /** Matching branches in this group beyond the display limit. */
  hidden: number
}

/** A name matches when it holds the query anywhere, ignoring case. */
export function matches(name: string, query: string): boolean {
  const typed = query.trim().toLowerCase()
  return typed === '' || name.toLowerCase().includes(typed)
}

/** Keep the Host's order within each group, applying the display limit after searching it. */
export function branchRows(listing: BranchListing, query: string, group: BranchGroup, limit = BRANCH_ROWS): BranchRows {
  const matching = listing.branches.filter(branch => (branch.checkedOut ? 'worktrees' : 'local') === group && matches(branch.name, query))
  const rows = matching.slice(0, limit).map(branch => ({
    name: branch.name,
    current: branch.name === listing.current,
    checkedOut: branch.checkedOut === true,
  }))
  return { rows, hidden: matching.length - rows.length }
}

/** Keep the cached rows and the Host's ordering after a confirmed switch. */
export function withCurrentBranch({ branches, detached: _detached, ...listing }: BranchListing, current: string): BranchListing {
  const others = branches.filter(branch => branch.name !== current).toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { ...listing, current, branches: others.length < branches.length ? [{ name: current }, ...others] : others }
}

/** What Enter in the search field switches to: the first row it can switch to that is not the current branch. */
export function enterChoice(rows: readonly BranchRow[]): BranchRow | undefined {
  return rows.find(row => !row.current && !row.checkedOut)
}

/**
 * One switch as this page holds it: under way, without an answer (the same request is retried), or refused with the
 * Host's reason. Only the Host's answer moves the chip.
 */
export type SwitchState =
  | { state: 'idle' }
  | { state: 'switching'; branch: string; requestId: string }
  | { state: 'unknown'; branch: string; requestId: string }
  | { state: 'refused'; branch: string; message: string }

/** Whether a row can be pressed now: never the current one, one another worktree holds, or while a switch is under way. */
export function choosable(row: BranchRow, switching: SwitchState): boolean {
  return !row.current && !row.checkedOut && switching.state !== 'switching'
}
