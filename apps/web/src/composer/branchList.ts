import type { BranchChoice, BranchListing } from '@latch/protocol'

/** Rows drawn at once; the search still looks through every branch the Host listed. */
const BRANCH_ROWS = 100

export interface BranchRow {
  name: string
  current: boolean
  /** Held by another worktree: shown, never chosen. */
  checkedOut: boolean
}

export interface BranchRows {
  rows: BranchRow[]
  /** Matching branches not drawn, plus those the Host left out of its listing. */
  hidden: number
}

/** A name matches when it holds the query anywhere, ignoring case. */
export function matches(name: string, query: string): boolean {
  const typed = query.trim().toLowerCase()
  return typed === '' || name.toLowerCase().includes(typed)
}

/**
 * The rows of the list: the Host's order (the current branch first, then by name), narrowed by the query, at most
 * `limit` drawn. What the Host could not list (`more`) counts as hidden only while nothing is typed: it may or may not
 * match a query.
 */
export function branchRows(listing: BranchListing, query: string, limit = BRANCH_ROWS): BranchRows {
  const matching = listing.branches.filter((branch: BranchChoice) => matches(branch.name, query))
  const rows = matching.slice(0, limit).map(branch => ({
    name: branch.name,
    current: branch.name === listing.current,
    checkedOut: branch.checkedOut === true,
  }))
  const hidden = matching.length - rows.length + (query.trim() === '' ? (listing.more ?? 0) : 0)
  return { rows, hidden }
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
