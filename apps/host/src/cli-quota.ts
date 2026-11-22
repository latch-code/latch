/**
 * The one place Latch reads a Harness CLI's own credential: the DeepSeek API key DeepSeek Harness keeps for its
 * `llm-deepseek-api-key` route, used once per read for the balance DeepSeek's API documents
 * (`GET https://api.deepseek.com/user/balance`, `Authorization: Bearer <key>`; api-docs.deepseek.com).
 *
 * Where the key goes, and nowhere else:
 * 1. `readDshKey` reads `~/.dsh/.credentials.yaml` (fixed path; refused when `DSH_HOME` moves the home) through a file
 *    descriptor opened without following links, owned by this user and unreadable by others, and returns the value of
 *    `refs.DEEPSEEK_API_KEY` as a string in memory.
 * 2. `fetchDeepSeekBalance` puts it in one request header to the fixed origin, over TLS, through the Host's outbound
 *    policy with no allowance and no redirects. Nothing of the request or its failure is logged, thrown or kept.
 * 3. Only numbers leave this module: the balance in hundredths and its currency, and whether DeepSeek says the account
 *    can still be used.
 *
 * Any setting that could send DeepSeek Harness's key to another address ends the read before the key file is opened:
 * such a key may not be DeepSeek's. Its plugin layers are judged by DeepSeek Harness's own composition
 * (`dsh-config.ts`): the DeepSeek, credentials and account plugins must be as its official bundles ship them, and a
 * plugin another layer adds may not name them, an address, a key or credential. `DEEPSEEK_BASE_URL` in its `.env` files, which that composition does not read, is
 * checked here. The key is never refreshed, rewritten or retried; a refusal ends in nothing to report.
 */
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { QuotaReport } from '@latch/harness-acp'
import type { DshConfigVerdict } from './dsh-config.ts'
import type { FetchLike } from './egress.ts'

/** DeepSeek's API origin, as the `deepseek` model-service preset names it. */
export const DEEPSEEK_ORIGIN = 'https://api.deepseek.com'
const BALANCE_URL = `${DEEPSEEK_ORIGIN}/user/balance`
/** DeepSeek Harness's own home, and the profile Latch's preset starts (`dsh --profile acp`). */
const DSH_DIR = '.dsh'
const DSH_PROFILE = 'acp'
const MAX_FILE_BYTES = 64 * 1024
const MAX_BODY_BYTES = 16 * 1024
/** What a DeepSeek API key looks like; anything else is not sent. */
const DEEPSEEK_KEY = /^sk-[A-Za-z0-9]{16,128}$/u
/** Words in a `.env` file that point DeepSeek Harness's DeepSeek route at another address or another key. */
const REDIRECTING = /baseURL|DEEPSEEK_BASE_URL|apiKeyEnv/u
/** The plugins whose layers decide where the key goes (`dshConfigCheck`). */
export const DSH_KEY_PLUGINS = ['llm-deepseek', 'credentials', 'llm-pi-ai', 'deepseek-account'] as const

type Read = { text: string } | 'absent' | 'refused'

/**
 * A file's text, read through one descriptor that was opened without following a link at the last component and checked
 * after opening: a regular file owned by `uid`, at most 64 KiB, and with `privateOnly` no group or other permission.
 */
async function readOwnFile(path: string, uid: number, privateOnly: boolean): Promise<Read> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'refused'
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.uid !== uid || info.size > MAX_FILE_BYTES) return 'refused'
    if (privateOnly && (info.mode & 0o077) !== 0) return 'refused'
    const text = await handle.readFile('utf8')
    return text.length > MAX_FILE_BYTES ? 'refused' : { text }
  } catch {
    return 'refused'
  } finally {
    await handle.close().catch(() => {})
  }
}

/** A directory that is itself a directory (not a link) owned by `uid`; `absent` when it does not exist. */
async function ownDirectory(path: string, uid: number): Promise<'ok' | 'absent' | 'refused'> {
  try {
    const info = await lstat(path)
    return info.isDirectory() && !info.isSymbolicLink() && info.uid === uid ? 'ok' : 'refused'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'refused'
  }
}

/**
 * `refs.DEEPSEEK_API_KEY` of the credentials document, in the one layout DeepSeek Harness writes (`version: 1`, then a
 * `refs:` mapping of `NAME: value` lines indented by two spaces). Anything outside that shape, a `DEEPSEEK_BASE_URL`
 * among the references, or a value that is not a DeepSeek key, is undefined: nothing is sent.
 */
export function deepSeekKeyOf(text: string): string | undefined {
  const lines = text.split(/\r?\n/u)
  if (!lines.some(line => /^version:\s*1\s*$/u.test(line))) return undefined
  let inRefs = false
  const refs = new Map<string, string>()
  for (const line of lines) {
    if (/^\s*(?:#.*)?$/u.test(line)) continue
    if (!line.startsWith(' ')) {
      inRefs = /^refs:\s*$/u.test(line)
      continue
    }
    if (!inRefs) continue
    const match = /^ {2}([A-Za-z_][A-Za-z0-9_]*):\s*(?:"([^"\\]*)"|'([^']*)'|([^\s#'"]+))\s*$/u.exec(line)
    if (!match) return undefined
    const name = match[1]!
    if (refs.has(name)) return undefined
    refs.set(name, match[2] ?? match[3] ?? match[4] ?? '')
  }
  if (refs.has('DEEPSEEK_BASE_URL')) return undefined
  const key = refs.get('DEEPSEEK_API_KEY')
  return key !== undefined && DEEPSEEK_KEY.test(key) ? key : undefined
}

/** Whether a layer that could change the route's address or key name is silent: absent, or present and silent. */
async function silent(path: string, uid: number): Promise<boolean> {
  // One that cannot be read, or is a link, could say anything.
  const read = await readOwnFile(path, uid, false)
  return read === 'absent' || (read !== 'refused' && !REDIRECTING.test(read.text))
}

/**
 * DeepSeek Harness's key for its DeepSeek route. `none`: there is none to use for this home (no key, a home that is not
 * the fixed one, a file that fails its checks, or a setting of the home that could point the route elsewhere).
 * `skip`: this session's folder could point it elsewhere (its `.env`, which DeepSeek Harness also reads), which says
 * nothing about the home. `env` is what DeepSeek Harness inherits: the Host's environment and the login shell's. Without
 * `cwd` (someone looking at the limits, with no session) there is no folder to check: the home's checks are all of it.
 */
export async function readDshKey(input: {
  home: string
  env: Readonly<Record<string, string | undefined>>
  cwd?: string
  uid: number
  /** What DeepSeek Harness's own composition says of `DSH_KEY_PLUGINS`, asked only when everything else allows the read. */
  config: () => Promise<DshConfigVerdict>
}): Promise<{ key: string } | 'none' | 'skip'> {
  const { home, env, cwd, uid } = input
  if (env.DSH_HOME?.trim() || env.DEEPSEEK_BASE_URL !== undefined) return 'none'
  const dir = join(home, DSH_DIR)
  if ((await ownDirectory(dir, uid)) !== 'ok') return 'none'
  for (const path of [join(dir, '.env'), join(dir, 'profiles', DSH_PROFILE, '.env')]) if (!(await silent(path, uid))) return 'none'
  if (cwd !== undefined && !(await silent(join(cwd, '.env'), uid))) return 'skip'
  if ((await input.config()) !== 'official') return 'none'
  const read = await readOwnFile(join(dir, '.credentials.yaml'), uid, true)
  if (read === 'absent' || read === 'refused') return 'none'
  const key = deepSeekKeyOf(read.text)
  return key ? { key } : 'none'
}

const amount = z.string().regex(/^\d{1,9}(?:\.\d{1,6})?$/u)
const balance = z.object({
  is_available: z.boolean(),
  balance_infos: z.array(z.object({ currency: z.enum(['CNY', 'USD']), total_balance: amount })).max(8),
})

/** DeepSeek's answer as a report: the balance with money in it first (else the first), and whether it can be used. */
export function balanceReport(value: unknown): QuotaReport | undefined {
  const parsed = balance.safeParse(value)
  if (!parsed.success) return undefined
  const infos = parsed.data.balance_infos
  const chosen = infos.find(info => Number(info.total_balance) > 0) ?? infos[0]
  const cents = chosen ? Math.round(Number(chosen.total_balance) * 100) : undefined
  return {
    windows: [],
    whole: true,
    ...(chosen && cents !== undefined && Number.isSafeInteger(cents) && cents <= 1_000_000_000
      ? { balanceCents: cents, currency: chosen.currency }
      : {}),
    limited: !parsed.data.is_available,
  }
}

/** The body as text, read a chunk at a time and given up past `MAX_BODY_BYTES`: undefined then, or with no body. */
async function boundedText(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader()
  if (!reader) return undefined
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_BODY_BYTES) return undefined
      chunks.push(next.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

/**
 * The balance for `key`: `null` when DeepSeek refused the key (401, 403) or answered in another shape, `undefined` when
 * the read did not finish. The key is only ever in the header of this one request.
 */
export async function fetchDeepSeekBalance(key: string, fetch: FetchLike, signal: AbortSignal): Promise<QuotaReport | null | undefined> {
  let response: Response
  try {
    response = await fetch(BALANCE_URL, {
      method: 'GET',
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      redirect: 'manual',
      signal,
    })
  } catch {
    return undefined
  }
  try {
    if (response.status === 401 || response.status === 403) return null
    if (response.status !== 200) return undefined
    const text = await boundedText(response)
    if (text === undefined) return null
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return null
    }
    const report = balanceReport(value)
    return report?.balanceCents === undefined ? null : report
  } catch {
    return undefined
  } finally {
    if (response.body && !response.body.locked) await response.body.cancel().catch(() => {})
  }
}
