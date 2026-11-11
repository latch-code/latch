// The pull request step of 交付 (docs/GIT-DELIVERY.md#pr-与检查): what your `gh` prints, read into the shapes the 交付
// tab shows. Nothing here runs a program; `git-delivery.ts` runs `gh` as you and hands its output here. Everything a
// person may read is stripped of control sequences and redacted first.
import { z } from 'zod'
import { AppError } from '@latch/sdk'
import type {
  GitCheck,
  GitCheckState,
  GitPrBinding,
  GitPrComment,
  GitPrStatus,
  GitPullRequest,
  GitReviewDecision,
  GitReviewState,
} from '@latch/protocol'
import { redactSecrets } from '@latch/core/node-kit'

/** A failed job's log: at most this many of its last lines, and this many bytes. */
export const LOG_LINES = 200
export const LOG_BYTES = 32 * 1024
/** One review or comment's text. */
export const COMMENT_LIMIT = 8 * 1024
/** Reviews and comments together, and checks. */
const DISCUSSION_LIMIT = 200
const CHECKS_LIMIT = 200
export const TITLE_LIMIT = 256
export const BODY_LIMIT = 64 * 1024

const NAME = /^[A-Za-z0-9_.-]{1,100}$/u
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::\d{1,5})?$/u
/** The URL of a pull request as `gh` prints it and the session metadata keeps it. */
export const PR_URL = /^https:\/\/([A-Za-z0-9.-]+(?::\d{1,5})?)\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})\/pull\/(\d{1,9})$/u

/** A GitHub repository: `gh --repo` takes `full`. */
export interface GhRepo {
  host: string
  owner: string
  name: string
  full: string
}

function repo(host: string, owner: string, name: string, ssh = false): GhRepo | undefined {
  const bare = name.replace(/\.git$/u, '')
  if (!HOST.test(host) || !NAME.test(owner) || !NAME.test(bare) || owner.startsWith('.') || bare.startsWith('.')) return undefined
  const lower = host.toLowerCase()
  // An SSH alias for GitHub (`github.com-work` in ~/.ssh/config) is still GitHub; a name with a dot after it is another
  // host altogether (github.com-evil.example.dev).
  const known = (ssh && /^github\.com-[A-Za-z0-9_-]+$/u.test(lower)) || lower === 'ssh.github.com' ? 'github.com' : lower
  return { host: known, owner, name: bare, full: `${known}/${owner}/${bare}` }
}

/**
 * The repository a remote's URL names, in the forms Git takes: `https://host/owner/repo(.git)`, `ssh://[user@]host[:port]/
 * owner/repo`, `git://host/owner/repo` and `user@host:owner/repo`. Anything else (a local path, a nested path) is not a
 * repository `gh` can work with.
 */
export function repoOfUrl(url: string): GhRepo | undefined {
  const text = url.trim()
  if (!text || /[\s\u0000-\u001f\u007f]/u.test(text)) return undefined
  const full = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/]+)\/([^/]+)\/([^/]+?)\/?$/u.exec(text)
  if (full) {
    // ssh://host:22/…: the port is the SSH one, not part of the GitHub host; https on 443 is the host itself.
    const ssh = text.startsWith('ssh:') || text.startsWith('git:')
    const host = ssh ? full[1]!.replace(/:\d+$/u, '') : text.startsWith('https:') ? full[1]!.replace(/:443$/u, '') : full[1]!
    return repo(host, full[2]!, full[3]!, ssh)
  }
  const scp = /^(?:[^@/:]+@)?([^/:]+):([^/]+)\/([^/]+?)\/?$/u.exec(text)
  if (scp) return repo(scp[1]!, scp[2]!, scp[3]!, true)
  return undefined
}

/**
 * A host `gh` may be run against without asking it first: GitHub and GitHub Enterprise Cloud. Any other host (a GitHub
 * Enterprise Server) only when `gh` already has a login for it; a remote naming some other host is not GitHub.
 */
export function knownGitHub(host: string): boolean {
  return host === 'github.com' || /^[a-z0-9-]+\.ghe\.com$/u.test(host)
}

/** Two repositories are the same, as GitHub compares names (case-insensitively). */
export function sameRepo(a: GhRepo, b: GhRepo): boolean {
  return a.full.toLowerCase() === b.full.toLowerCase()
}

/** The repository and number of a pull request's URL. */
export function repoOfPr(url: string): { repo: GhRepo; number: number } | undefined {
  const match = PR_URL.exec(url)
  if (!match) return undefined
  const found = repo(match[1]!, match[2]!, match[3]!)
  return found && { repo: found, number: Number(match[4]) }
}

/** Text a person may read: escape sequences and carriage-return overwrites resolved, control characters gone, redacted. */
export function plainText(text: string): string {
  return redactSecrets(
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/gu, '')
      .split('\n')
      .map(line => line.slice(line.lastIndexOf('\r', line.length - 2) + 1).replace(/\r$/u, ''))
      .join('\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, ''),
  )
}

function capped(text: string, limit: number): string {
  const clean = plainText(text).trim()
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean
}

/** One line of a name: no newlines, at most `limit` characters. */
function oneLine(text: string, limit = 200): string {
  return capped(text.replace(/\s+/gu, ' '), limit)
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/u

/**
 * `gh run view --log-failed`: `<job>\t<step>\t<time> <text>` lines become the text under a `[step]` line for each step;
 * the runner's group markers go. Then the last `LOG_LINES` lines and `LOG_BYTES` bytes, redacted.
 */
export function logExcerpt(output: string): { text: string; truncated?: true } {
  const lines: string[] = []
  let step: string | undefined
  for (const raw of plainText(output).split('\n')) {
    const parts = raw.split('\t')
    let text = raw
    if (parts.length >= 3) {
      if (parts[1] !== step) {
        step = parts[1]!
        lines.push(`[${step}]`)
      }
      text = parts.slice(2).join('\t')
    }
    text = text.replace(TIMESTAMP, '')
    if (/^##\[(?:group|endgroup)\]/u.test(text)) continue
    lines.push(text.replace(/^##\[error\]/u, 'error: ').replace(/^##\[warning\]/u, 'warning: '))
  }
  const all = lines.join('\n').replace(/\s+$/u, '').split('\n')
  let kept = all.slice(-LOG_LINES)
  let truncated = kept.length < all.length
  while (kept.length > 1 && Buffer.byteLength(kept.join('\n')) > LOG_BYTES) {
    kept = kept.slice(1)
    truncated = true
  }
  let text = kept.join('\n')
  if (Buffer.byteLength(text) > LOG_BYTES) {
    text = Buffer.from(text).subarray(-LOG_BYTES).toString('utf8').replace(/^�+/u, '')
    truncated = true
  }
  return { text, ...(truncated ? { truncated: true as const } : {}) }
}

const login = z.object({ login: z.string().max(100) }).nullish()
const time = z.string().max(40).nullish()
const checkRun = z.object({
  __typename: z.literal('CheckRun'),
  name: z.string().max(1000).nullish(),
  workflowName: z.string().max(1000).nullish(),
  status: z.string().max(40).nullish(),
  conclusion: z.string().max(40).nullish(),
  startedAt: time,
  completedAt: time,
  detailsUrl: z.string().max(2048).nullish(),
})
const statusContext = z.object({
  __typename: z.literal('StatusContext'),
  context: z.string().max(1000).nullish(),
  state: z.string().max(40).nullish(),
  startedAt: time,
})
const rollupItem = z.union([checkRun, statusContext, z.object({ __typename: z.string() })])
const review = z.object({
  author: login,
  state: z.string().max(40).nullish(),
  body: z.string().max(1_000_000).nullish(),
  submittedAt: time,
})
const comment = z.object({ author: login, body: z.string().max(1_000_000).nullish(), createdAt: time })
const prView = z.object({
  number: z.number().int().positive(),
  url: z.string().regex(PR_URL),
  title: z.string().max(10_000).nullish(),
  state: z.string().max(40),
  isDraft: z.boolean().nullish(),
  reviewDecision: z.string().max(40).nullish(),
  headRefOid: z.string().max(64).nullish(),
  headRefName: z.string().max(1000),
  baseRefName: z.string().max(1000),
  statusCheckRollup: z.array(rollupItem).max(10_000).nullish(),
  reviews: z.array(review).max(10_000).nullish(),
  comments: z.array(comment).max(10_000).nullish(),
})
const prListItem = z.object({
  number: z.number().int().positive(),
  url: z.string().regex(PR_URL),
  headRefName: z.string().max(1000),
  baseRefName: z.string().max(1000),
  isCrossRepository: z.boolean().nullish(),
})
const lineComment = z.object({
  user: login,
  path: z.string().max(4096).nullish(),
  line: z.number().int().nullish(),
  original_line: z.number().int().nullish(),
  body: z.string().max(1_000_000).nullish(),
  created_at: time,
})
const repoView = z.object({ defaultBranchRef: z.object({ name: z.string().max(1000) }).nullish() })

/** The fields `gh pr view --json` is asked for. */
export const PR_FIELDS = 'number,url,title,state,isDraft,reviewDecision,headRefOid,headRefName,baseRefName,statusCheckRollup'
export const PR_LIST_FIELDS = 'number,url,headRefName,baseRefName,isCrossRepository'

function parsed<T>(schema: z.ZodType<T>, stdout: string): T {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    throw ghUnreadable()
  }
  const result = schema.safeParse(value)
  if (!result.success) throw ghUnreadable()
  return result.data
}

const ghUnreadable = () => new AppError(502, 'gh-failed', 'gh 的输出无法读取。')

const STATUS: Record<string, GitPrStatus> = { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' }
const DECISION: Record<string, GitReviewDecision> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes-requested',
  REVIEW_REQUIRED: 'review-required',
}
const REVIEW: Record<string, GitReviewState> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes-requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
}
const JOB_URL = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/actions\/runs\/\d{1,20}\/job\/(\d{1,20})(?:[/?#]|$)/u

/** A failed Actions job of this repository: its ID, when the details URL is one. */
function jobOf(url: string, where: GhRepo | undefined): string | undefined {
  const match = JOB_URL.exec(url)
  if (!match || !where) return undefined
  const found = repo(match[1]!, match[2]!, match[3]!)
  return found && sameRepo(found, where) ? match[4] : undefined
}

function checkOf(item: z.infer<typeof rollupItem>, where: GhRepo | undefined): GitCheck | undefined {
  if (item.__typename === 'StatusContext') {
    const parsedStatus = statusContext.safeParse(item)
    if (!parsedStatus.success) return undefined
    const status = parsedStatus.data
    const state: GitCheckState =
      status.state === 'SUCCESS' ? 'pass' : status.state === 'FAILURE' || status.state === 'ERROR' ? 'fail' : 'pending'
    return { name: oneLine(status.context ?? '') || '状态', state, ...(status.startedAt ? { startedAt: status.startedAt } : {}) }
  }
  const parsedRun = checkRun.safeParse(item)
  if (!parsedRun.success) return undefined
  const run = parsedRun.data
  let state: GitCheckState
  if (run.status !== 'COMPLETED') state = 'pending'
  else if (run.conclusion === 'SUCCESS') state = 'pass'
  else if (run.conclusion === 'NEUTRAL' || run.conclusion === 'SKIPPED' || run.conclusion === 'STALE') state = 'skipped'
  else state = 'fail'
  const job = state === 'fail' && run.detailsUrl ? jobOf(run.detailsUrl, where) : undefined
  const workflow = run.workflowName ? oneLine(run.workflowName) : ''
  return {
    name: oneLine(run.name ?? '') || '检查',
    ...(workflow ? { workflow } : {}),
    state,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.completedAt && state !== 'pending' ? { completedAt: run.completedAt } : {}),
    ...(job ? { job } : {}),
  }
}

export interface PrView {
  pr: GitPullRequest
  checks: GitCheck[]
}

/** `gh pr view --json`: the pull request and its head commit's checks; failed jobs only of `where`. */
export function readPrView(stdout: string, where?: GhRepo): PrView {
  const view = parsed(prView, stdout)
  const checks = (view.statusCheckRollup ?? []).flatMap(item => checkOf(item, where) ?? []).slice(0, CHECKS_LIMIT)
  const head = view.headRefOid && /^[0-9a-f]{40,64}$/u.test(view.headRefOid) ? view.headRefOid : undefined
  const decision = view.reviewDecision ? DECISION[view.reviewDecision] : undefined
  return {
    pr: {
      number: view.number,
      url: view.url,
      title: oneLine(view.title ?? '', TITLE_LIMIT),
      base: oneLine(view.baseRefName),
      head: oneLine(view.headRefName),
      state: STATUS[view.state] ?? 'open',
      draft: !!view.isDraft,
      ...(decision ? { reviewDecision: decision } : {}),
      ...(head ? { headSha: head } : {}),
    },
    checks,
  }
}

/** Reviews and conversation comments kept from each list (the newest), and each body's characters before parsing. */
export const DISCUSSION_EACH = 100
/** The `--jq` that keeps a pull request's discussion small whatever its size: the newest of each, bodies cut. */
export const DISCUSSION_JQ = `{reviews: [.reviews[-${DISCUSSION_EACH}:][] | {author, state, submittedAt, body: ((.body // "")[:${COMMENT_LIMIT + 1}])}], comments: [.comments[-${DISCUSSION_EACH}:][] | {author, createdAt, body: ((.body // "")[:${COMMENT_LIMIT + 1}])}], total: ((.reviews | length) + (.comments | length))}`
/** The same for line comments, which `gh api` asks for newest first. */
export const LINE_COMMENTS_JQ = `[.[] | {user, path, line, original_line, created_at, body: ((.body // "")[:${COMMENT_LIMIT + 1}])}]`

const discussionView = z.object({
  reviews: z.array(review).max(10_000).nullish(),
  comments: z.array(comment).max(10_000).nullish(),
  total: z.number().int().nonnegative().nullish(),
})

/** `gh pr view --json reviews,comments --jq DISCUSSION_JQ`: the items, and how many there were in all. */
export function readDiscussion(stdout: string): { items: GitPrComment[]; total: number } {
  const view = parsed(discussionView, stdout)
  const discussion: GitPrComment[] = []
  for (const item of view.reviews ?? []) {
    const state = item.state ? REVIEW[item.state] : undefined
    const body = capped(item.body ?? '', COMMENT_LIMIT)
    // A COMMENTED review without words only holds line comments, which are listed one by one.
    if (!state || (state === 'commented' && !body)) continue
    discussion.push({
      kind: 'review',
      author: oneLine(item.author?.login ?? '') || 'ghost',
      review: state,
      body,
      ...(item.submittedAt ? { at: item.submittedAt } : {}),
    })
  }
  for (const item of view.comments ?? []) {
    discussion.push({
      kind: 'comment',
      author: oneLine(item.author?.login ?? '') || 'ghost',
      body: capped(item.body ?? '', COMMENT_LIMIT),
      ...(item.createdAt ? { at: item.createdAt } : {}),
    })
  }
  const shown = (view.reviews?.length ?? 0) + (view.comments?.length ?? 0)
  return { items: discussion, total: Math.max(view.total ?? shown, shown) }
}

/** `gh api …/pulls/:n/comments`: line comments. */
export function readLineComments(stdout: string): GitPrComment[] {
  return parsed(z.array(lineComment).max(10_000), stdout).map(item => {
    const line = item.line ?? item.original_line
    return {
      kind: 'line' as const,
      author: oneLine(item.user?.login ?? '') || 'ghost',
      ...(item.path ? { path: oneLine(item.path, 1024) } : {}),
      ...(typeof line === 'number' && line > 0 ? { line } : {}),
      body: capped(item.body ?? '', COMMENT_LIMIT),
      ...(item.created_at ? { at: item.created_at } : {}),
    }
  })
}

/** Line comments asked for at most: the newest. */
export const LINE_COMMENTS = 100

/** Oldest first, at most `DISCUSSION_LIMIT` (the newest kept); `capped` when anything was left out. */
export function discussionOf(items: GitPrComment[], leftOut = false): { items: GitPrComment[]; capped: boolean } {
  const sorted = items.toSorted((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))
  return { items: sorted.slice(-DISCUSSION_LIMIT), capped: leftOut || sorted.length > DISCUSSION_LIMIT }
}

/** A branch name the session metadata holds for display: 1–256 characters, no control characters. */
export function storableName(name: string): boolean {
  // eslint-disable-next-line no-control-regex
  return name.length >= 1 && name.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(name)
}

/**
 * `gh pr list --head <branch> --state open --json`: whether this repository's branch already has an open pull request
 * (same repository, not a fork), decided before anything about it is checked; `open` holds those the session metadata
 * can store. One that exists but cannot be stored is never a reason to make a second.
 */
export function readPrList(stdout: string, branch: string, where: GhRepo): { open: GitPrBinding[]; exists: boolean } {
  const ours = parsed(z.array(prListItem).max(1000), stdout).filter(item => {
    if (item.headRefName !== branch || item.isCrossRepository) return false
    const found = repoOfPr(item.url)
    return !!found && sameRepo(found.repo, where)
  })
  const open = ours
    .filter(item => storableName(item.baseRefName) && storableName(item.headRefName))
    .map(item => ({ number: item.number, url: item.url, base: item.baseRefName, head: item.headRefName }))
  return { open, exists: ours.length > 0 }
}

export function readDefaultBranch(stdout: string): string | undefined {
  const name = parsed(repoView, stdout).defaultBranchRef?.name
  return name && BRANCH.test(name) ? name : undefined
}

/** The URL `gh pr create` prints last. */
export function createdUrl(stdout: string): string | undefined {
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => PR_URL.test(line))
    .at(-1)
}

/** A branch name `gh` takes as `--base` or `--head`: no option, no spaces, nothing Git refuses outright. */
export const BRANCH = /^(?!-)(?!.*(?:\.\.|@\{|\/\/|\.lock(?:\/|$)))[A-Za-z0-9._/+-]{1,200}(?<![/.])$/u

/** A title for `--title=`: one line, no control characters. */
export function validTitle(title: string): boolean {
  // eslint-disable-next-line no-control-regex
  return title.trim().length > 0 && title.length <= TITLE_LIMIT && !/[\u0000-\u001f\u007f]/u.test(title)
}

/**
 * Why `gh` did not do it, from its exit code and (English) messages; its output does not go to clients except a short
 * redacted excerpt of a refused creation.
 */
export function ghFailure(outcome: { code: number | null; stderr: string; stdout?: string }, creating = false): AppError {
  const text = outcome.stderr
  if (outcome.code === 127 || /(?:^|\s)gh: (?:command )?not found|exec: gh: not found|command not found: gh/u.test(text))
    return new AppError(409, 'gh-missing', '这台电脑上找不到 gh（GitHub CLI）。')
  if (
    outcome.code === 4
    || /gh auth login|not logged in|authentication required|HTTP 401|Bad credentials|token .* (?:invalid|expired)|Failed to log in/iu.test(
      text,
    )
  )
    return new AppError(409, 'gh-logged-out', 'gh 没有登录 GitHub。在终端里运行 gh auth login。')
  if (/Could not resolve to a Repository|HTTP 404|repository not found|none of the git remotes/iu.test(text))
    return new AppError(409, 'gh-no-remote', '这个远端不是 GitHub 上的仓库。')
  if (/could not resolve host|connection refused|connection reset|i\/o timeout|network is unreachable|TLS handshake|dial tcp/iu.test(text))
    return new AppError(502, 'gh-unreachable', '连不上 GitHub。')
  if (creating) {
    if (/already exists/iu.test(text)) return new AppError(409, 'pr-exists-elsewhere', '这个分支已有 PR，但不在推送远端的仓库里打开着。')
    const tail = plainText(text).trim().split('\n').slice(-20).join('\n').slice(-4096)
    return new AppError(422, 'pr-create-failed', `PR 没有创建（退出码 ${outcome.code ?? '无'}）。`, {
      exitCode: outcome.code ?? -1,
      ...(tail ? { tail } : {}),
    })
  }
  return new AppError(502, 'gh-failed', `gh 没有完成（退出码 ${outcome.code ?? '无'}）。`, { exitCode: outcome.code ?? -1 })
}
