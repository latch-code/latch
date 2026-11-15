// A harness's subscription limits (`src/quota.ts`): what each program's own report becomes, and what the runtime keeps
// of it. Driven against the fake app-server and the fake ACP agent: no network, no model, no real program.
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bridge, HarnessDriver, HarnessPlugin } from '@latch/sdk'
import type { DriverTaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT, FAKE_CODEX_APP_SERVER } from '@latch/testkit'
import {
  createAcpAgentPlugin,
  forgetCommandLookups,
  resolveCommand,
  setCommandSearch,
  setLoginPrograms,
  type AgentRecord,
} from '../src/index.ts'
import { readQuotaCommand } from '../src/login.ts'
import { antigravityQuotaCommand, readAntigravityUsage } from '../src/profiles/antigravity-quota.ts'
import {
  QuotaFacts,
  claudeErrorQuota,
  claudeRateLimit,
  claudeUsageQuota,
  codexQuota,
  codexQuotaUpdate,
  grokQuota,
  harnessQuota,
  maskAccount,
} from '../src/quota.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  setCommandSearch(undefined)
  setLoginPrograms(undefined)
  forgetCommandLookups()
})

const NOW = Date.parse('2026-11-15T03:00:00.000Z')
const HOUR = 3_600_000
const seconds = (ms: number) => Math.floor(ms / 1000)
const iso = (ms: number) => new Date(seconds(ms) * 1000).toISOString()

/** `GetAccountRateLimitsResponse` as Codex 0.167's own schema gives it (`codex app-server generate-ts`). */
const codexRead = (now: number) => ({
  ordinaryUsageAllowed: true,
  rateLimits: {
    limitId: 'codex',
    limitName: null,
    normalModelSlug: null,
    primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: seconds(now + 2 * HOUR) },
    secondary: { usedPercent: 68, windowDurationMins: 10080, resetsAt: seconds(now + 143 * HOUR) },
    credits: { hasCredits: false, unlimited: false, balance: '0' },
    individualLimit: null,
    spendControlReached: null,
    planType: 'plus',
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: 'codex',
      limitName: null,
      normalModelSlug: null,
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: seconds(now + 2 * HOUR) },
      secondary: { usedPercent: 68, windowDurationMins: 10080, resetsAt: seconds(now + 143 * HOUR) },
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      planType: 'plus',
      rateLimitReachedType: null,
    },
    codex_other_model: {
      limitId: 'codex_other_model',
      limitName: 'A model name of the vendor',
      normalModelSlug: 'other-model',
      primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: seconds(now + HOUR) },
      secondary: null,
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      planType: 'plus',
      rateLimitReachedType: null,
    },
  },
  rateLimitResetCredits: null,
  accountId: 'acct_0123456789',
  rateLimitUpsell: { headline: 'Upgrade for more' },
})
const codexAccount = { account: { type: 'chatgpt', email: 'nirvana@fastmail.com', planType: 'plus', workspaceName: 'A workspace' } }

describe('masking an account', () => {
  it('keeps the first character of each side and the last label, and nothing of anything that is not one address', () => {
    expect(maskAccount('nirvana@fastmail.com')).toBe('n•••@f•••.com')
    expect(maskAccount('  A.B+tag@Mail.Example.ORG ')).toBe('A•••@m•••.org')
    expect(maskAccount('李雷@例子.测试')).toBe('李•••@例•••')
    expect(maskAccount('person@localhost')).toBe('p•••@l•••')
    for (const text of ['', 'no address', 'a@b@c.com', 'two words@example.com', '@example.com', 'person@', 42, null, undefined])
      expect(maskAccount(text)).toBeUndefined()
    expect(maskAccount(`${'x'.repeat(400)}@example.com`)).toBeUndefined()
  })
})

describe('what a client may be sent', () => {
  const base = { state: 'ok', observedAt: '2026-11-15T03:00:00.000Z' }

  it('drops a window of a kind it does not know and every piece of free text, and keeps the rest', () => {
    const parsed = harnessQuota.parse({
      ...base,
      windows: [
        { kind: 'weekly', usedPercent: 68, resetsAt: '2026-11-21T02:00:00.000Z', label: 'Weekly · all models', note: 'upgrade now' },
        { kind: 'monthly-mystery', usedPercent: 10 },
        { kind: 'five-hour', usedPercent: 'a lot', resetsAt: 'soon' },
        'not a window',
      ],
      plan: 'Plus (legacy, grandfathered)',
      account: 'nirvana@fastmail.com',
      banner: 'Upgrade for more',
    })
    expect(parsed).toEqual({
      ...base,
      windows: [{ kind: 'weekly', usedPercent: 68, resetsAt: '2026-11-21T02:00:00.000Z' }, { kind: 'five-hour' }],
    })
    expect(
      harnessQuota.parse({ ...base, windows: [{ kind: 'weekly', usedPercent: 1 }], plan: 'plus', account: 'n•••@f•••.com' }),
    ).toMatchObject({
      plan: 'plus',
      account: 'n•••@f•••.com',
    })
  })

  it('keeps a model group of the fixed set and drops a window of any other group', () => {
    const windows = [
      { kind: 'weekly', group: 'gemini', usedPercent: 1 },
      { kind: 'weekly', group: 'Gemini 4 Argon', usedPercent: 98 },
    ]
    expect(harnessQuota.parse({ ...base, windows }).windows).toEqual([{ kind: 'weekly', group: 'gemini', usedPercent: 1 }])
  })

  it('is nothing without a window, or with a state outside the set', () => {
    expect(harnessQuota.safeParse({ ...base, windows: [{ kind: 'unknown' }] }).success).toBe(false)
    expect(harnessQuota.safeParse({ ...base, windows: [{ kind: 'weekly', usedPercent: 1 }], state: 'fine' }).success).toBe(false)
  })
})

describe('Codex', () => {
  it("reads the plan's own bucket: windows told apart by their length, the plan, and the address masked", () => {
    expect(codexQuota(codexRead(NOW), codexAccount, NOW)).toEqual({
      windows: [
        { kind: 'five-hour', usedPercent: 12, resetsAt: iso(NOW + 2 * HOUR) },
        { kind: 'weekly', usedPercent: 68, resetsAt: iso(NOW + 143 * HOUR) },
      ],
      whole: true,
      plan: 'plus',
      account: 'n•••@f•••.com',
      limited: false,
    })
  })

  it('labels a window of another length by its minutes and leaves out one with no length', () => {
    const read = codexRead(NOW)
    read.rateLimitsByLimitId.codex.primary = { usedPercent: 40.26, windowDurationMins: 1440, resetsAt: seconds(NOW + HOUR) }
    read.rateLimitsByLimitId.codex.secondary = { usedPercent: 5, windowDurationMins: null as unknown as number, resetsAt: 0 }
    expect(codexQuota(read, { account: { type: 'apiKey' } }, NOW)?.windows).toEqual([
      { kind: 'rolling', usedPercent: 40.3, resetsAt: iso(NOW + HOUR), windowMinutes: 1440 },
    ])
  })

  it('takes a rolling update of that bucket as an addition, and no other bucket', () => {
    const update = { ...codexRead(NOW).rateLimits, primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: seconds(NOW + HOUR) } }
    expect(codexQuotaUpdate({ rateLimits: { ...update, secondary: null, planType: null } }, NOW)).toEqual({
      windows: [{ kind: 'five-hour', usedPercent: 31, resetsAt: iso(NOW + HOUR) }],
    })
    expect(codexQuotaUpdate({ rateLimits: { ...update, limitId: 'codex_other_model' } }, NOW)).toBeUndefined()
    expect(codexQuotaUpdate({ rateLimits: { ...update, rateLimitReachedType: 'rate_limit_reached' } }, NOW)?.limited).toBe(true)
    expect(codexQuotaUpdate({ rateLimits: 'nothing' }, NOW)).toBeUndefined()
  })
})

describe('Claude Agent', () => {
  // `SDKRateLimitInfo` as @anthropic-ai/claude-agent-sdk 0.3.318 types it; the adapter forwards it whole.
  const warning = { status: 'allowed_warning', resetsAt: seconds(NOW + 2 * HOUR), rateLimitType: 'five_hour', utilization: 0.91 }

  it('reads a status and a reset time for one window, and never a figure', () => {
    expect(claudeRateLimit(warning, NOW)).toEqual({ windows: [{ kind: 'five-hour', resetsAt: iso(NOW + 2 * HOUR), state: 'near' }] })
    expect(claudeRateLimit({ ...warning, status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: NOW + 30 * HOUR }, NOW)).toEqual({
      windows: [{ kind: 'weekly-opus', resetsAt: iso(NOW + 30 * HOUR), state: 'limited' }],
    })
    // Fine again: only the kind, which clears what was said of it before.
    expect(claudeRateLimit({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: seconds(NOW + HOUR) }, NOW)).toEqual({
      windows: [{ kind: 'five-hour' }],
    })
  })

  it('leaves out a window type it does not know, and a reset time that cannot be right', () => {
    expect(claudeRateLimit({ ...warning, rateLimitType: 'overage' }, NOW)).toBeUndefined()
    expect(claudeRateLimit({ ...warning, rateLimitType: undefined }, NOW)).toBeUndefined()
    expect(claudeRateLimit({ ...warning, status: 'throttled' }, NOW)).toBeUndefined()
    expect(claudeRateLimit({ ...warning, resetsAt: 12 }, NOW)).toEqual({ windows: [{ kind: 'five-hour', state: 'near' }] })
  })

  it('finds it on a usage update and on the error of a turn refused for the limit', () => {
    expect(
      claudeUsageQuota({ sessionUpdate: 'usage_update', used: 1, _meta: { '_claude/rateLimit': warning } }, NOW)?.windows[0]?.state,
    ).toBe('near')
    expect(claudeUsageQuota({ sessionUpdate: 'usage_update', used: 1 }, NOW)).toBeUndefined()
    expect(claudeErrorQuota({ errorKind: 'rate_limit', rateLimit: { ...warning, status: 'rejected' } }, NOW)?.windows[0]?.state).toBe(
      'limited',
    )
    expect(claudeErrorQuota({ errorKind: 'overloaded', rateLimit: warning }, NOW)).toBeUndefined()
  })
})

describe('Grok Build', () => {
  // `BillingConfigResponse`, field names as in xai-org/grok-build's billing extension and the 1.0.77 binary.
  const billing = {
    config: {
      creditUsagePercent: 41.5,
      currentPeriod: { type: 'monthly', start: iso(NOW - 200 * HOUR), end: iso(NOW + 500 * HOUR) },
      monthlyLimit: { val: 30000 },
      used: { val: 12450 },
      onDemandCap: { val: 0 },
      onDemandUsed: { val: 0 },
      prepaidBalance: { val: 1234 },
      isUnifiedBillingUser: true,
      billingPeriodStart: iso(NOW - 200 * HOUR),
      billingPeriodEnd: iso(NOW + 500 * HOUR),
      history: [],
    },
    onDemandEnabled: false,
    subscriptionTier: 'SuperGrok',
  }

  it('reads one figure for the billing period, the tier when it is a known one, and the prepaid balance', () => {
    expect(grokQuota(billing, NOW)).toEqual({
      windows: [{ kind: 'billing-period', usedPercent: 41.5, resetsAt: iso(NOW + 500 * HOUR) }],
      whole: true,
      plan: 'supergrok',
      balanceCents: 1234,
    })
    expect(grokQuota({ ...billing, subscriptionTier: 'A tier invented later' }, NOW)?.plan).toBeUndefined()
  })

  it('is nothing without a figure', () => {
    expect(grokQuota({ ...billing, config: { ...billing.config, creditUsagePercent: null } }, NOW)).toBeUndefined()
    expect(grokQuota({ error: 'Authentication required to fetch billing data' }, NOW)).toBeUndefined()
  })
})

/**
 * The output of `agy -p /usage --output-format json`, recorded from agy 1.5.8 on 2026-11-15: its structure and field
 * names as printed; the texts, fractions and times are placeholders.
 */
const agyUsage = (now: number, change: (groups: Array<Record<string, unknown>>) => unknown = groups => groups) => {
  const bucket = (id: string, window: string, left: number, ahead: number, extra: Record<string, unknown> = {}) => ({
    id,
    name: 'Limit Remaining',
    ...extra,
    window,
    remaining_fraction: left,
    reset_time: iso(now + ahead),
  })
  return JSON.stringify({
    conversation_id: '',
    status: 'SUCCESS',
    response: 'The same report as text',
    duration_seconds: 0,
    num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
    command: {
      name: 'usage',
      data: {
        description: 'A description',
        groups: change([
          {
            name: 'Gemini Models',
            description: 'A description',
            buckets: [bucket('gemini-weekly', 'weekly', 1, 100 * HOUR), bucket('gemini-5h', '5h', 0.75, 2 * HOUR)],
          },
          {
            name: 'Claude and GPT models',
            description: 'A description',
            buckets: [bucket('3p-weekly', 'weekly', 0.4, 100 * HOUR), bucket('3p-5h', '5h', 0.1, 3 * HOUR)],
          },
          {
            name: 'Gemini 4 Argon',
            description: 'A description',
            buckets: [bucket('gemini-argon-wtu-weekly', 'weekly', 0.02, 100 * HOUR, { description: 'A description' })],
          },
        ]),
      },
    },
  })
}

describe('Antigravity', () => {
  it('reads what is used of each window of the two general groups, and leaves out a group it has no name for', () => {
    expect(readAntigravityUsage(agyUsage(NOW), NOW)).toEqual({
      windows: [
        { kind: 'weekly', group: 'gemini', usedPercent: 0, resetsAt: iso(NOW + 100 * HOUR) },
        { kind: 'five-hour', group: 'gemini', usedPercent: 25, resetsAt: iso(NOW + 2 * HOUR) },
        { kind: 'weekly', group: 'claude-gpt', usedPercent: 60, resetsAt: iso(NOW + 100 * HOUR) },
        { kind: 'five-hour', group: 'claude-gpt', usedPercent: 90, resetsAt: iso(NOW + 3 * HOUR) },
      ],
      whole: true,
    })
    // One model's own group is 98% used; its name is the vendor's, so neither it nor its figure is shown.
    expect(JSON.stringify(readAntigravityUsage(agyUsage(NOW), NOW))).not.toContain('98')
  })

  it('leaves out a window it does not know, and is nothing when no known group is left', () => {
    const odd = agyUsage(NOW, groups => [{ ...groups[0], buckets: [{ window: 'monthly', remaining_fraction: 0.5 }] }])
    expect(readAntigravityUsage(odd, NOW)).toBeUndefined()
    expect(
      readAntigravityUsage(
        agyUsage(NOW, groups => [groups[2]]),
        NOW,
      ),
    ).toBeUndefined()
  })

  it('refuses any other shape whole, and a run that started a turn', () => {
    const recorded = JSON.parse(agyUsage(NOW)) as Record<string, unknown> & {
      command: { data: { groups: Array<Record<string, unknown>> } }
    }
    expect(readAntigravityUsage('Usage: 25% of your 5-hour limit', NOW)).toBeUndefined()
    expect(readAntigravityUsage(JSON.stringify({ ...recorded, num_turns: 1 }), NOW)).toBeUndefined()
    expect(readAntigravityUsage(JSON.stringify({ ...recorded, command: { ...recorded.command, name: 'model' } }), NOW)).toBeUndefined()
    expect(readAntigravityUsage(JSON.stringify({ groups: recorded.command.data.groups }), NOW)).toBeUndefined()
    const percent = agyUsage(NOW, groups => [{ ...groups[0], buckets: [{ window: 'weekly', remaining_fraction: 75 }] }])
    expect(readAntigravityUsage(percent, NOW)).toBeUndefined()
  })

  /** `agy` in `bin`: the fake ACP agent, except that `-p /usage` prints `output` and `--version` a version. */
  async function agy(root: string, output: string, env: Record<string, string> = {}): Promise<{ bin: string; seen: string }> {
    const bin = join(root, 'bin')
    await mkdir(bin, { recursive: true })
    const seen = join(root, 'seen')
    const exports = Object.entries(env)
      .map(([name, value]) => `export ${name}='${value}'`)
      .join('\n')
    await writeFile(
      join(bin, 'agy'),
      [
        '#!/bin/sh',
        `if [ "$1" = --version ]; then printf '1.5.8\\n'; exit 0; fi`,
        `if [ "$1" = -p ]; then printf '%s|%s\\n' "$*" "$AGY_CLI_DISABLE_AUTO_UPDATE" >> '${seen}'; printf 'a notice on stderr\\n' >&2; printf '%s' '${output}'; exit 0; fi`,
        exports,
        `exec '${process.execPath}' '${FAKE_ACP_AGENT}' "$@"`,
        '',
      ].join('\n'),
    )
    await chmod(join(bin, 'agy'), 0o755)
    return { bin, seen }
  }

  it('runs as a status command does: only once the Host may run programs, without a secret in the arguments, and reads standard output alone', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-quota-cmd-')))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const now = Date.now()
    const { bin, seen } = await agy(root, agyUsage(now))
    setCommandSearch(() => [bin])
    forgetCommandLookups()
    const record: AgentRecord = {
      id: 'agy',
      name: 'Antigravity',
      presetId: 'antigravity',
      command: 'agy',
      args: [],
      env: {},
      enabled: true,
    }
    // A test Host may not run the person's programs.
    expect(await readQuotaCommand(record, antigravityQuotaCommand, now)).toBeUndefined()
    await expect(readFile(seen, 'utf8')).rejects.toThrow()
    setLoginPrograms(resolveCommand)
    expect((await readQuotaCommand(record, antigravityQuotaCommand, now))?.windows).toHaveLength(4)
    expect(await readFile(seen, 'utf8')).toBe('-p /usage --output-format json|true\n')
    expect(antigravityQuotaCommand.timeoutMs).toBe(20_000)
  })

  it('is run beside a session when it opens and no more than once in five minutes, without holding the turn', async () => {
    const now = Date.now()
    const t = await computer('agy', 'antigravity', { FAKE_ACP_CONFIG: 'options', FAKE_ACP_MODES: 'default,accept-edits,auto' }, root =>
      agy(root, agyUsage(now)),
    )
    expect(t.bridge.quota?.()).toBeUndefined()
    const first = await t.start('echo hi')
    expect(first.summary.status).toBe('idle')
    await vi.waitFor(() => expect(t.bridge.quota?.()).toBeDefined())
    expect(t.bridge.quota!()).toMatchObject({
      windows: [
        { kind: 'five-hour', group: 'gemini', usedPercent: 25 },
        { kind: 'weekly', group: 'gemini', usedPercent: 0 },
        { kind: 'five-hour', group: 'claude-gpt', usedPercent: 90 },
        { kind: 'weekly', group: 'claude-gpt', usedPercent: 60 },
      ],
      state: 'near',
    })
    await t.send(first.summary.id, 'echo again')
    await t.send(first.summary.id, 'echo once more')
    expect((await readFile(join(t.root, 'seen'), 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  it('says nothing, and fails nothing, when the command fails', async () => {
    const t = await computer('agy', 'antigravity', { FAKE_ACP_CONFIG: 'options', FAKE_ACP_MODES: 'default,accept-edits,auto' }, root =>
      agy(root, 'authentication required'),
    )
    const first = await t.start('echo hi')
    expect(first.summary.status).toBe('idle')
    await vi.waitFor(async () => expect(await readFile(join(t.root, 'seen'), 'utf8')).toContain('/usage'))
    expect(t.bridge.quota?.()).toBeUndefined()
    expect(JSON.stringify(first.messages)).not.toContain('authentication')
  })
})

describe('what is kept', () => {
  const live = {}
  const weekly = (usedPercent: number, resetsAt = iso(NOW + 100 * HOUR)) => ({ kind: 'weekly' as const, usedPercent, resetsAt })

  it('holds a window until it resets, also after the process that reported it is gone', () => {
    const facts = new QuotaFacts()
    facts.note(
      live,
      { windows: [weekly(68), { kind: 'five-hour', usedPercent: 85, resetsAt: iso(NOW + HOUR) }], whole: true, plan: 'plus' },
      NOW,
    )
    expect(facts.snapshot(NOW)).toEqual({
      windows: [{ kind: 'five-hour', usedPercent: 85, resetsAt: iso(NOW + HOUR) }, weekly(68)],
      plan: 'plus',
      state: 'near',
      observedAt: new Date(NOW).toISOString(),
    })
    facts.gone(live)
    expect(facts.snapshot(NOW + 2 * HOUR)).toMatchObject({ windows: [weekly(68)], state: 'ok' })
    expect(facts.snapshot(NOW + 101 * HOUR)).toBeUndefined()
  })

  it('holds a window without a reset time only while its process runs', () => {
    const facts = new QuotaFacts()
    facts.note(live, { windows: [{ kind: 'five-hour', state: 'limited' }] }, NOW)
    expect(facts.snapshot(NOW + 1000 * HOUR)).toMatchObject({ windows: [{ kind: 'five-hour', state: 'limited' }], state: 'limited' })
    facts.gone(live)
    expect(facts.snapshot(NOW)).toBeUndefined()
  })

  it('takes the newest word on each window, whichever process said it, and forgets everything on a logout', () => {
    const facts = new QuotaFacts()
    const other = {}
    facts.note(
      live,
      { windows: [weekly(68), { kind: 'five-hour', state: 'near', resetsAt: iso(NOW + HOUR) }], account: 'n•••@f•••.com' },
      NOW,
    )
    facts.note(other, { windows: [weekly(70), { kind: 'five-hour' }] }, NOW + 1)
    // The other process said the five-hour window is fine, which is newer than the warning.
    expect(facts.snapshot(NOW + 2)).toMatchObject({ windows: [weekly(70)], state: 'ok' })
    facts.note(live, { windows: [], limited: true }, NOW + 3)
    expect(facts.snapshot(NOW + 4)).toMatchObject({ state: 'limited', account: 'n•••@f•••.com' })
    facts.clear()
    expect(facts.snapshot(NOW + 5)).toBeUndefined()
  })
})

// ---- The runtime, against the fakes ------------------------------------------------------------------------------------

let requests = 0
const rid = () => `quota-${++requests}`

async function activate(plugin: HarnessPlugin): Promise<HarnessDriver> {
  const drivers: HarnessDriver[] = []
  const disposers: Array<() => void | Promise<void>> = []
  await plugin.activate({
    registerHarness: driver => void drivers.push(driver),
    registerProvider: () => {},
    registerTool: () => {},
    registerClientPanel: () => {},
    registerSkill: () => {},
    registerTransport: () => {},
    registerUiPanel: () => {},
    onDispose: dispose => void disposers.push(dispose),
  })
  cleanups.push(async () => {
    for (const dispose of disposers.reverse()) await dispose()
  })
  return drivers[0]!
}

interface LogEntry {
  event: string
  method?: string | null
  params?: Record<string, unknown>
}

/** A computer whose only command is `command`: the fake app-server for `codex`, the fake ACP agent for anything else. */
async function computer(
  command: string,
  presetId: string | undefined,
  env: Record<string, string>,
  install?: (root: string) => Promise<unknown>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-quota-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const bin = join(root, 'bin')
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'data')
  const tmpRoot = join(root, 'run-tmp')
  await mkdir(bin)
  await mkdir(workspace)
  await mkdir(tmpRoot, { mode: 0o700 })
  const logFile = join(root, 'agent.log')
  const exports = Object.entries({
    FAKE_ACP_LOG: logFile,
    FAKE_ACP_STATE: join(root, 'state.json'),
    FAKE_CODEX_STATE: join(root, 'threads.json'),
    FAKE_ACP_CAPS: 'resume',
    ...env,
  })
    .map(([name, value]) => `export ${name}='${value}'`)
    .join('\n')
  const fixture = command === 'codex' ? FAKE_CODEX_APP_SERVER : FAKE_ACP_AGENT
  await writeFile(join(bin, command), `#!/bin/sh\n${exports}\nexec '${process.execPath}' '${fixture}' "$@"\n`)
  await chmod(join(bin, command), 0o755)
  setCommandSearch(() => [bin])
  // A command of the test's own making runs its extra commands too, as the start script lets a Host.
  if (install) {
    await install(root)
    await writeFile(join(bin, command), (await readFile(join(bin, command), 'utf8')).replace('#!/bin/sh\n', `#!/bin/sh\n${exports}\n`))
    setLoginPrograms(resolveCommand)
  }
  forgetCommandLookups()
  const record: AgentRecord = {
    id: `quota-${++requests}`,
    name: 'Fake',
    ...(presetId ? { presetId } : {}),
    command,
    args: [],
    env: {},
    enabled: true,
  }
  const driver = await activate(
    createAcpAgentPlugin(record, { cancelGraceMs: 2_000, stopGraceMs: 200, restartDelayMs: 0, requestTimeoutMs: 5_000, log: () => {} }),
  )
  let ahead = 0
  const open = async (): Promise<Bridge> => {
    const bridge = driver.create({
      dataDir,
      workspaceRoot: workspace,
      tmpRoot,
      workspaces: () => [workspace],
      providerId: 'unused',
      registry: {
        acquire() {
          throw new Error('unused')
        },
      },
      securityEvent: () => {},
      clock: () => Date.now() + ahead,
    })
    cleanups.push(() => bridge.close())
    await bridge.start()
    return bridge
  }
  const bridge = await open()
  const settled = async (id: string): Promise<DriverTaskDetail> => {
    await vi.waitFor(async () => expect(['running', 'waiting-approval']).not.toContain((await bridge.detail(id)).summary.status), {
      timeout: 8_000,
      interval: 10,
    })
    return bridge.detail(id)
  }
  return {
    bridge,
    root,
    dataDir,
    open,
    /** Moves the runtime's clock ahead. */
    later(ms: number) {
      ahead += ms
    },
    async start(prompt: string): Promise<DriverTaskDetail> {
      const { launchHash } = await bridge.launchPreview!({ cwd: workspace })
      return settled((await bridge.createTask({ prompt, requestId: rid(), cwd: workspace, expectedLaunchHash: launchHash })).sessionId)
    },
    async send(id: string, text: string): Promise<DriverTaskDetail> {
      await bridge.prompt(id, text, rid())
      return settled(id)
    },
    async log(): Promise<LogEntry[]> {
      return (await readFile(logFile, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as LogEntry)
    },
  }
}

const received = (log: LogEntry[], method: string) => log.filter(entry => entry.event === 'recv' && entry.method === method)

/** Every file below `directory`, read whole. */
async function everything(directory: string): Promise<string> {
  let text = ''
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true }))
    if (entry.isFile()) text += await readFile(join(entry.parentPath, entry.name), 'utf8').catch(() => '')
  return text
}

describe('Codex over its app-server', () => {
  it('asks nothing before a session; with one, reads the limits once on that process, then merges what each turn pushes', async () => {
    const now = Date.now()
    const pushed = {
      ...codexRead(now).rateLimits,
      primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: seconds(now + 2 * HOUR) },
    }
    const t = await computer('codex', 'codex', {
      FAKE_CODEX_RATE_LIMITS: JSON.stringify(codexRead(now)),
      FAKE_CODEX_RATE_LIMITS_UPDATE: JSON.stringify({ ...pushed, secondary: null, planType: null }),
    })
    expect(t.bridge.quota?.()).toBeUndefined()
    expect((await t.log()).filter(entry => entry.event === 'rate-limits-read')).toHaveLength(0)

    const first = await t.start('echo hi')
    expect(first.summary.status).toBe('idle')
    await vi.waitFor(() => expect(t.bridge.quota?.()?.windows[0]?.usedPercent).toBe(31))
    expect(t.bridge.quota!()).toEqual({
      windows: [
        { kind: 'five-hour', usedPercent: 31, resetsAt: iso(now + 2 * HOUR) },
        { kind: 'weekly', usedPercent: 68, resetsAt: iso(now + 143 * HOUR) },
      ],
      plan: 'plus',
      // The fake's account is person@example.com.
      account: 'p•••@e•••.com',
      state: 'ok',
      observedAt: expect.any(String),
    })
    const log = await t.log()
    const reads = log.filter(entry => entry.event === 'rate-limits-read')
    expect(reads).toHaveLength(1)
    expect(reads[0]!.params).toEqual({ excludeResetCreditDetails: true })
    // The read ran no turn of its own.
    expect(received(log, 'turn/start')).toHaveLength(1)

    // Past its reset a window says nothing of the one that began then.
    t.later(3 * HOUR)
    expect(t.bridge.quota!()?.windows).toEqual([{ kind: 'weekly', usedPercent: 68, resetsAt: iso(now + 143 * HOUR) }])

    // Memory only: nothing of it is in the data directory, and a runtime started over that directory knows nothing.
    const stored = await everything(t.dataDir)
    for (const word of ['usedPercent', 'five-hour', 'weekly', 'p•••', 'person@example.com', 'resetsAt']) expect(stored).not.toContain(word)
    await t.bridge.close()
    expect((await t.open()).quota?.()).toBeUndefined()
  })

  it('shows nothing for a Codex that has no such request', async () => {
    const t = await computer('codex', 'codex', {})
    expect((await t.start('echo hi')).summary.status).toBe('idle')
    await vi.waitFor(async () => expect((await t.log()).filter(entry => entry.event === 'rate-limits-read')).toHaveLength(1))
    expect(t.bridge.quota?.()).toBeUndefined()
  })
})

/** The fake ACP agent as the Claude profile expects its adapter: a version it takes and the modes it reads back. */
const CLAUDE = {
  FAKE_ACP_CONFIG: 'options',
  FAKE_ACP_MODES: 'default,acceptEdits,plan,auto,bypassPermissions',
  FAKE_ACP_VERSION: '0.101.0',
}

describe('Claude Agent over its adapter', () => {
  const limit = (now: number, status: string, type = 'five_hour') =>
    JSON.stringify({ status, rateLimitType: type, resetsAt: seconds(now + 2 * HOUR), utilization: 0.93 })

  it('shows a warning with its window and reset time, no figure, and clears it when the window is fine again', async () => {
    const now = Date.now()
    const t = await computer('fake-agent', 'claude-agent', CLAUDE)
    const first = await t.start(`limit ${limit(now, 'allowed_warning')}`)
    expect(first.summary.status).toBe('idle')
    expect(t.bridge.quota!()).toEqual({
      windows: [{ kind: 'five-hour', resetsAt: iso(now + 2 * HOUR), state: 'near' }],
      state: 'near',
      observedAt: expect.any(String),
    })
    // The session's own usage is still read from the same update.
    expect(first.usageReport).toMatchObject({ contextUsed: 10, contextSize: 100 })
    await t.send(first.summary.id, `limit ${limit(now, 'allowed')}`)
    expect(t.bridge.quota!()).toBeUndefined()
    // Latch never asks Claude for its usage: every prompt it received is one this test sent.
    const prompts = received(await t.log(), 'session/prompt').map(entry => JSON.stringify(entry.params?.prompt))
    expect(prompts).toHaveLength(2)
    for (const prompt of prompts) expect(prompt).not.toContain('/usage')
  })

  it('reads the limit off a turn refused for it', async () => {
    const now = Date.now()
    const t = await computer('fake-agent', 'claude-agent', CLAUDE)
    const refused = await t.start(`limit refuse ${limit(now, 'rejected', 'seven_day')}`)
    expect(refused.summary.status).toBe('failed')
    expect(t.bridge.quota!()).toMatchObject({ windows: [{ kind: 'weekly', state: 'limited' }], state: 'limited' })
  })

  it('takes none of it from an agent whose profile names no such report', async () => {
    const now = Date.now()
    const t = await computer('fake-agent', undefined, {})
    expect((await t.start(`limit ${limit(now, 'rejected')}`)).summary.status).toBe('idle')
    expect(t.bridge.quota!()).toBeUndefined()
  })
})

describe('Grok Build', () => {
  it('asks its billing extension on the process of a session, once however many turns end, and never without a session', async () => {
    const now = Date.now()
    const t = await computer('fake-agent', 'grok', {
      FAKE_ACP_BILLING: JSON.stringify({
        config: { creditUsagePercent: 82, currentPeriod: { type: 'monthly', start: iso(now - HOUR), end: iso(now + 300 * HOUR) } },
        onDemandEnabled: false,
        subscriptionTier: 'SuperGrok',
      }),
    })
    expect(t.bridge.quota?.()).toBeUndefined()
    expect(received(await t.log(), '_x.ai/billing')).toHaveLength(0)
    const first = await t.start('echo hi')
    await vi.waitFor(() => expect(t.bridge.quota?.()).toBeDefined())
    expect(t.bridge.quota!()).toEqual({
      windows: [{ kind: 'billing-period', usedPercent: 82, resetsAt: iso(now + 300 * HOUR) }],
      plan: 'supergrok',
      state: 'near',
      observedAt: expect.any(String),
    })
    await t.send(first.summary.id, 'echo again')
    const log = await t.log()
    expect(received(log, '_x.ai/billing')).toHaveLength(1)
    expect(received(log, '_x.ai/billing')[0]!.params).toEqual({})
    expect(received(log, 'session/prompt')).toHaveLength(2)
  })
})
