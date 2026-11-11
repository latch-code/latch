// A stand-in for the GitHub CLI, for tests only: it answers the few `gh` commands 交付 runs from a JSON state file and
// never touches the network. Every call is appended to calls.jsonl. It refuses, and records a violation, when it is
// asked for a token (`gh auth token`) or finds anything token-like in its environment: Latch must never read or pass one.
// Usage (through the shim `installFakeGh` writes): node fake-gh.mjs <state dir> <gh arguments…>
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [dir, ...args] = process.argv.slice(2)
const statePath = join(dir, 'state.json')
const state = JSON.parse(readFileSync(statePath, 'utf8'))

function violation(text) {
  appendFileSync(join(dir, 'violations.log'), `${text}\n`)
  process.stderr.write(`fake gh: ${text}\n`)
  process.exit(99)
}

const TOKEN_NAME = /TOKEN|SECRET|PASSWORD|API_?KEY|CREDENTIAL/iu
const TOKEN_VALUE = /\b(?:gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|lmg1\.)/u
for (const [name, value] of Object.entries(process.env)) {
  if (TOKEN_NAME.test(name)) violation(`token-like variable ${name} in the environment`)
  if (value && TOKEN_VALUE.test(value)) violation(`token-like value in ${name}`)
}
if (args.includes('auth') && (args.includes('token') || args.includes('--show-token') || args.includes('-t')))
  violation('asked for the token')
for (const arg of args) if (TOKEN_VALUE.test(arg)) violation('token-like argument')

appendFileSync(
  join(dir, 'calls.jsonl'),
  `${JSON.stringify({ args, cwd: process.cwd(), prompt: process.env.GH_PROMPT_DISABLED ?? null })}\n`,
)

/** `--name value` or `--name=value`. */
function option(name) {
  for (let at = 0; at < args.length; at++) {
    if (args[at] === `--${name}`) return args[at + 1]
    if (args[at].startsWith(`--${name}=`)) return args[at].slice(name.length + 3)
  }
  return undefined
}
const positional = args.filter(
  (arg, at) => !arg.startsWith('-') && !(at > 0 && /^--(?:repo|json|state|limit|job|method|hostname|jq)$/u.test(args[at - 1])),
)
const out = text => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
const fail = (text, code = 1) => {
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`)
  process.exit(code)
}
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2))

if (positional[0] === 'auth' && positional[1] === 'status') {
  const host = option('hostname')
  const known = host === 'github.com' || (state.hosts ?? []).includes(host)
  if (!known || !state.loggedIn) fail(`You are not logged into any accounts on ${host}`)
  if ((state.expiredHosts ?? []).includes(host))
    fail(`${host}\n  X Failed to log in to ${host} account tester (keyring)\n  - The token in keyring is invalid.`)
  process.stderr.write(`${host}\n  ✓ Logged in to ${host} account tester (keyring)\n  - Token: gho_************************************\n`)
  process.exit(0)
}
if (!state.loggedIn)
  fail(
    'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.',
    4,
  )

const repo = option('repo')
const [command, sub] = positional
if (repo !== undefined && repo !== state.repo) fail(`GraphQL: Could not resolve to a Repository with the name '${repo}'. (repository)`)

const view = (pr, fields) => {
  const all = { ...pr }
  delete all.lineComments
  if (!fields) return all
  return Object.fromEntries(fields.split(',').map(field => [field, all[field] ?? null]))
}

if (command === 'repo' && sub === 'view') {
  if (positional[2] !== state.repo) fail(`GraphQL: Could not resolve to a Repository with the name '${positional[2]}'. (repository)`)
  out(JSON.stringify({ defaultBranchRef: { name: state.defaultBranch } }))
} else if (command === 'pr' && sub === 'list') {
  const head = option('head')
  const list = state.prs.filter(pr => pr.state === 'OPEN' && (head === undefined || pr.headRefName === head))
  out(JSON.stringify(list.map(pr => view(pr, option('json')))))
} else if (command === 'pr' && sub === 'create') {
  const head = option('head'),
    base = option('base'),
    title = option('title'),
    bodyFile = option('body-file')
  if (!head || !base || !title || !bodyFile) fail('fake gh: create needs --head, --base, --title and --body-file')
  if (!existsSync(bodyFile)) fail('fake gh: the body file is missing')
  const body = readFileSync(bodyFile, 'utf8')
  appendFileSync(join(dir, 'bodies.log'), `${JSON.stringify(body)}\n`)
  if (state.createFails) fail(state.createFails)
  const open = state.prs.find(pr => pr.state === 'OPEN' && pr.headRefName === head)
  if (open) fail(`a pull request for branch "${head}" into branch "${open.baseRefName}" already exists:\n${open.url}`)
  const number = state.nextNumber++
  const url = `https://${state.repo}/pull/${number}`
  state.prs.push({
    number,
    url,
    title,
    state: 'OPEN',
    isDraft: args.includes('--draft'),
    reviewDecision: '',
    headRefName: head,
    baseRefName: base,
    headRefOid: state.headSha ?? null,
    isCrossRepository: false,
    statusCheckRollup: [],
    reviews: [],
    comments: [],
    lineComments: [],
  })
  save()
  // Made on GitHub, and the answer is late: the caller cannot tell whether it was.
  if (state.createDelayMs) await new Promise(resolve => setTimeout(resolve, state.createDelayMs))
  out(`\nCreating pull request for ${head} into ${base} in ${state.repo.split('/').slice(1).join('/')}\n\n${url}`)
} else if (command === 'pr' && sub === 'view') {
  const pr = state.prs.find(item => String(item.number) === positional[2])
  if (!pr) fail(`GraphQL: Could not resolve to a PullRequest with the number of ${positional[2]}. (repository.pullRequest)`)
  // The discussion as the Host's --jq keeps it: the newest 100 of each, and how many there are.
  if (option('jq') !== undefined && option('json') === 'reviews,comments')
    out(
      JSON.stringify({ reviews: pr.reviews.slice(-100), comments: pr.comments.slice(-100), total: pr.reviews.length + pr.comments.length }),
    )
  else out(JSON.stringify(view(pr, option('json'))))
} else if (command === 'api') {
  const match = /^repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/comments(?:\?.*)?$/u.exec(positional[1] ?? '')
  if (!match || `${option('hostname')}/${match[1]}/${match[2]}` !== state.repo || option('method') !== 'GET')
    fail('fake gh: unexpected api call')
  const pr = state.prs.find(item => String(item.number) === match[3])
  if (!pr) fail('HTTP 404: Not Found', 1)
  // Newest first when asked so, as GitHub answers `sort=created&direction=desc`, at most `per_page`.
  const query = new URLSearchParams(positional[1].split('?')[1] ?? '')
  const list = [...(pr.lineComments ?? [])]
  if (query.get('direction') === 'desc') list.reverse()
  out(JSON.stringify(list.slice(0, Number(query.get('per_page') ?? 30))))
} else if (command === 'run' && sub === 'view') {
  const job = option('job')
  if (!args.includes('--log-failed')) fail('fake gh: only --log-failed is answered')
  const log = state.logs?.[job]
  if (log === undefined)
    fail(`HTTP 404: Not Found (https://api.github.com/repos/${state.repo.split('/').slice(1).join('/')}/actions/jobs/${job})`)
  out(log)
} else fail(`fake gh: unexpected command ${args.join(' ')}`)
