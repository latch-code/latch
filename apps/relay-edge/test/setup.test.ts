import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { nodeCrypto } from '@latch/link-client/crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runSetup, SetupError, type SetupDeps } from '../scripts/setup-core.ts'
import { wranglerRunner } from '../scripts/wrangler.ts'

const folders: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true })
})

/** A stand-in for wrangler: records every call and answers a deploy with a workers.dev address. */
async function fixture(overrides: Partial<SetupDeps> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'latch-relay-setup-'))
  folders.push(root)
  await writeFile(join(root, 'worker.js'), 'export default {}')
  await writeFile(join(root, 'work.js'), 'export default {}')
  const calls: Array<{ args: string[]; input?: string; config?: string }> = []
  const lines: string[] = []
  const deps: SetupDeps = {
    wrangler: async (args, options) => {
      const config = args.includes('wrangler.jsonc')
        ? await readFile(join(options.cwd, 'wrangler.jsonc'), 'utf8').catch(() => '')
        : undefined
      calls.push({ args, ...(options.input === undefined ? {} : { input: options.input }), ...(config === undefined ? {} : { config }) })
      if (args[0] === 'deploy' && args.includes('wrangler.jsonc'))
        return { code: 0, stdout: 'Uploaded latch-relay-ne\n  https://latch-relay-ne.example-sub.workers.dev\nCurrent Version ID: x' }
      return { code: 0, stdout: '' }
    },
    status: async () => 200,
    publicKey: seed => nodeCrypto.publicKey(seed),
    progress: line => lines.push(line),
    wait: async () => {},
    ...overrides,
  }
  const input = {
    region: 'ne' as const,
    out: join(root, 'relay.json'),
    workerBundle: join(root, 'worker.js'),
    workBundle: join(root, 'work.js'),
    workDir: join(root, 'work'),
  }
  return { root, calls, lines, deps, input }
}

it('deploys, puts every secret through standard input only, and writes a 0600 relay file', async () => {
  const t = await fixture()
  const result = await runSetup(t.input, t.deps)
  expect(result.url).toBe('https://latch-relay-ne.example-sub.workers.dev/')
  expect(t.calls.map(call => call.args.slice(0, 3).join(' '))).toEqual([
    '--version',
    'deploy -c work.wrangler.jsonc',
    'deploy -c wrangler.jsonc',
    'secret put RELAY_SIGNING_SEED',
    'secret put REGISTRATION_TOKEN',
    'secret put ADMIN_TOKEN',
    'deploy -c wrangler.jsonc',
  ])
  const secrets = t.calls.filter(call => call.args[0] === 'secret').map(call => call.input!)
  expect(secrets.every(value => /^[a-f0-9]{64}$/u.test(value))).toBe(true)
  for (const secret of secrets) {
    expect(t.calls.some(call => call.args.join(' ').includes(secret))).toBe(false)
    expect(t.lines.join('\n')).not.toContain(secret)
  }
  // The first deploy has no hostname yet; the second names the workers.dev host it got.
  const configs = t.calls.filter(call => call.args[0] === 'deploy' && call.config).map(call => JSON.parse(call.config!).vars)
  expect(configs[0]).toMatchObject({ NODE_HOSTS: '', LOCATION_HINT: 'apac-ne', OPEN_REGISTRATION: 'false' })
  expect(configs[1]).toMatchObject({ NODE_HOSTS: 'latch-relay-ne.example-sub.workers.dev', RELAY_ID: result.relayId })

  const file = JSON.parse(await readFile(t.input.out, 'utf8')) as { version: number; profile: Record<string, string> }
  expect((await stat(t.input.out)).mode & 0o777).toBe(0o600)
  expect(file.version).toBe(2)
  expect(file.profile).toMatchObject({ relayId: result.relayId, url: result.url, kind: 'edge' })
  const seed = Buffer.from(secrets[0]!, 'hex')
  expect(file.profile.relayKey).toBe(Buffer.from(await nodeCrypto.publicKey(seed)).toString('hex'))
  expect(file.profile.registrationKey).toBe(`lrt1.${Buffer.from(secrets[1]!, 'hex').toString('base64url')}`)
  expect(await readFile(`${t.input.out}.admin-header`, 'utf8')).toBe(`Authorization: Bearer ${secrets[2]}\n`)
  expect((await stat(`${t.input.out}.admin-header`)).mode & 0o777).toBe(0o600)
  // The key's short hash, public, for comparison with the Mac's confirmation sheet; then the acceptance step.
  const short = createHash('sha256').update(Buffer.from(file.profile.relayKey!, 'hex')).digest('hex').slice(0, 8)
  expect(t.lines).toContain(`中继密钥短哈希 ${short}`)
  expect(t.lines.at(-1)).toBe(`下一步：pnpm relay-edge:accept --file ${t.input.out}`)
})

it('stops before deploying anything when wrangler is missing or the relay file exists', async () => {
  const missing = await fixture()
  missing.deps.wrangler = async (_args, options) => {
    await promisify(execFile)(join(missing.root, 'missing-wrangler'), [], { cwd: options.cwd })
    return { code: 0, stdout: '' }
  }
  await expect(runSetup(missing.input, missing.deps)).rejects.toThrow(/没有找到 wrangler/u)
  const existing = await fixture()
  await writeFile(existing.input.out, 'x')
  await expect(runSetup(existing.input, existing.deps)).rejects.toBeInstanceOf(SetupError)
  expect(existing.calls).toEqual([])
  const relative = await fixture()
  await expect(runSetup({ ...relative.input, out: 'relay.json' }, relative.deps)).rejects.toThrow(/绝对路径/u)
})

it('creates the working directory before starting the version check in a real child process', async () => {
  const t = await fixture()
  await expect(stat(t.input.workDir)).rejects.toMatchObject({ code: 'ENOENT' })
  const stub = t.deps.wrangler
  t.deps.wrangler = async (args, options) => {
    if (args[0] === '--version') {
      await promisify(execFile)(process.execPath, ['--disable-sigusr1', '-e', ''], { cwd: options.cwd })
      return { code: 0, stdout: '' }
    }
    return stub(args, options)
  }
  await runSetup(t.input, t.deps)
  expect((await stat(t.input.workDir)).isDirectory()).toBe(true)
})

it('writes no relay file when the node never answers /healthz', async () => {
  const t = await fixture({ status: async () => 503 })
  await expect(runSetup(t.input, t.deps)).rejects.toThrow(/healthz/u)
  await expect(stat(t.input.out)).rejects.toThrow()
})

it('runs an executable with a clean diagnostics environment and discards all secret command output', async () => {
  const t = await fixture()
  const diagnostics = join(t.root, 'inherited.log')
  vi.stubEnv('NODE_DEBUG', 'http,https')
  vi.stubEnv('WRANGLER_LOG', 'debug')
  vi.stubEnv('WRANGLER_LOG_SANITIZE', 'false')
  vi.stubEnv('WRANGLER_LOG_PATH', diagnostics)
  vi.stubEnv('WRANGLER_OUTPUT_FILE_PATH', diagnostics)
  vi.stubEnv('WRANGLER_OUTPUT_FILE_DIRECTORY', t.root)
  const tool = join(t.root, 'wrangler')
  await writeFile(
    tool,
    String.raw`#!/bin/sh
set -eu
case "$1" in
  --version) printf '4.164.0\n' ;;
  deploy) printf 'https://latch-relay-ne.fixture.workers.dev\n' ;;
  secret)
    test "$5" = 'wrangler.jsonc'
    test "$6" = '--env-file'
    test "$7" = '/dev/null'
    test "$WRANGLER_LOG" = 'none'
    test "$WRANGLER_LOG_SANITIZE" = 'true'
    test "$WRANGLER_SEND_METRICS" = 'false'
    test "$NODE_OPTIONS" = '--disable-sigusr1'
    test -z "$(printenv NODE_DEBUG || true)"
    test -z "$(printenv WRANGLER_OUTPUT_FILE_DIRECTORY || true)"
    test "$WRANGLER_OUTPUT_FILE_PATH" = '/dev/null'
    test "$(readlink "$WRANGLER_LOG_PATH")" = '/dev/null'
    input=$(cat)
    printf '%s\n' "$input" >> "$WRANGLER_LOG_PATH"
    printf '%s\n' "$input" >> "$WRANGLER_OUTPUT_FILE_PATH"
    printf '%s\n' "$input"
    printf '%s\n' "$input" >&2
    printf '%s\n' "$3" >> verified.calls
    if [ "$input" = 'synthetic-failure-marker' ]; then exit 23; fi ;;
  *) exit 9 ;;
esac
`,
    { mode: 0o700 },
  )
  const wrangler = wranglerRunner(tool)
  await runSetup(t.input, { ...t.deps, wrangler })
  const cwd = join(t.input.workDir, 'latch-relay-ne')
  expect(await readFile(join(cwd, 'verified.calls'), 'utf8')).toBe('RELAY_SIGNING_SEED\nREGISTRATION_TOKEN\nADMIN_TOKEN\n')
  const failed = await wrangler(['secret', 'put', 'REGISTRATION_TOKEN', '-c', 'wrangler.jsonc'], { cwd, input: 'synthetic-failure-marker' })
  expect(failed).toEqual({ code: 23, stdout: '' })
  expect(t.lines.join('\n')).not.toContain('synthetic-failure-marker')
  await expect(stat(diagnostics)).rejects.toMatchObject({ code: 'ENOENT' })
})
