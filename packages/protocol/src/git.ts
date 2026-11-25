/** A local branch of a project folder, as `GET /workspaces/:id/branches` lists it. */
export interface BranchChoice {
  /** The name under `refs/heads/`, exactly as Git has it: only names that can be shown and sent back unchanged are listed. */
  name: string
  /** Checked out in another worktree of the repository: Git switches no second worktree to it. */
  checkedOut?: true
}

/**
 * `GET /workspaces/:id/branches`: the local branches of a project's folder, read from Git's metadata files without
 * running Git. The current branch comes first, then the rest by name.
 */
export interface BranchListing {
  /** The branch HEAD names; absent when HEAD is detached. */
  current?: string
  /** A detached HEAD's commit, its first seven digits. */
  detached?: string
  branches: BranchChoice[]
  /** Branches not listed: past the cap, or names left out (too long, looking like a secret, not a name Git accepts). */
  more?: number
}

/** Current project membership and each folder's verified branch label, including a detached HEAD's short commit. */
export interface ProjectFolderBranches {
  folders: Array<{ id: string; path: string; branch?: string }>
}

/** `POST /workspaces/:id/branches/switch` answered: the folder is now on `branch`. */
export interface BranchSwitchResult {
  branch: string
  /** The commit HEAD names now. */
  head?: string
  /** HEAD was already there: nothing ran. */
  unchanged?: true
  /** The answer this device's same request got before. */
  replay?: true
}

/** What in a repository's configuration keeps a switch from running: a filter driver, or a hook the repository sets. */
export type BranchSwitchConfigKind = 'filter' | 'hook'
