import { useCallback, useEffect, useRef, useState } from 'react'

import {
  settleLogin,
  type AgentProbeResult,
  type HarnessInfo,
  type HarnessLogin,
  type HarnessLoginCheck,
  type HarnessLoginStatus,
} from '@latch/protocol'
import { AlertGlyph, Button, CircleCheckGlyph, CopyButton, Icon, InlineNotice, RefreshGlyph, Spinner, TerminalGlyph } from '@latch/ui'
import { api, inlineError } from '../core/api.ts'
import { readHarnessCatalogue, readNeedsLogin } from '../composer/harnessCatalogue.tsx'
import { loginRuns, useLoginRun, type LoginRunState, type LoginSurface } from '../panel/terminal/loginRuns.ts'
import { VisibleText } from './VisibleText.tsx'

/** The harness's own CLI warns this long before a stored login ends; the page says so as early. */
const ENDS_SOON_MS = 10 * 24 * 60 * 60_000

/** `11 月 12 日`, the day a login ends. */
export function loginEndDay(expiresAt: string): string {
  const date = new Date(expiresAt)
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
}

/** A stored login that ends within the warning window, or already has. */
export function loginEndsSoon(expiresAt: string | undefined, now = Date.now()): boolean {
  const at = expiresAt ? Date.parse(expiresAt) : Number.NaN
  return Number.isFinite(at) && at - now < ENDS_SOON_MS
}

/**
 * The last test start found no login while the program's own check says there is one, as when a stored login is no longer
 * accepted: a session would be refused, so the page treats it as a login to redo.
 */
export function loginDoubted(status: HarnessLoginCheck['status'] | undefined, probe: Pick<AgentProbeResult, 'login'> | undefined): boolean {
  return status === 'authenticated' && probe?.login === 'unauthenticated'
}

/** `pushed`: what a running process had pushed when the page asked, which the Host's answer already took into account. */
interface AskedLogin {
  value: HarnessLoginCheck
  pushed: HarnessLogin['reported']
}

/** The Host's answer, unless a running process pushed something since; before any answer, the push alone. */
export function shownLogin(asked: AskedLogin | undefined, reported: HarnessLogin['reported']): Partial<HarnessLoginCheck> {
  if (asked) return settleLogin(asked.value, asked.pushed, reported)
  return reported ? { status: reported.status, ...(reported.label ? { label: reported.label } : {}) } : {}
}

/** Asks the Host what the harness says about its login; no answer is undefined. */
function askLogin(harnessId: string, fresh: boolean): Promise<HarnessLoginCheck | undefined> {
  return api<HarnessLoginCheck>(`harnesses/${encodeURIComponent(harnessId)}/login-status`, {
    method: 'POST',
    body: fresh ? { fresh } : {},
  }).catch(() => undefined)
}

/**
 * What a row says of a login command run in a Latch terminal. A command that left with code 0 only ended: the harness
 * itself says whether that was a login (`verdict`, undefined until it answered), and one that cannot say stays 已结束.
 */
export function loginRunWord(
  state: LoginRunState | undefined,
  verdict: { asked: boolean; status?: HarnessLoginStatus | undefined },
): '登录中' | '已登录' | '已结束' | '失败' | undefined {
  if (state === undefined) return undefined
  if (state === 'running') return '登录中'
  if (state === 'failed') return '失败'
  if (!verdict.asked) return '登录中'
  if (verdict.status === 'authenticated') return '已登录'
  return verdict.status === 'unauthenticated' ? undefined : '已结束'
}

/**
 * What the harness says about its login: the Host's answer, asked once when it is chosen and again each time this window
 * comes back, since logging in happens in another, or a newer push from a running process of it. Anything but a clear
 * answer stays `unknown` and the page says nothing.
 *
 * `probe`: the last test start, which runs the program too. One that ends while the page is open and reads the login
 * otherwise than shown is newer, so the Host is asked again.
 */
export function useLoginStatus(
  harness: Pick<HarnessInfo, 'id' | 'login'> | undefined,
  allowed: boolean,
  probe?: Pick<AgentProbeResult, 'checkedAt' | 'login'>,
) {
  const [answer, setAnswer] = useState<AskedLogin & { id: string }>()
  const id = allowed && harness?.login?.checkable ? harness.id : undefined
  const reported = harness?.login?.reported
  const pushed = useRef(reported)
  useEffect(() => {
    pushed.current = reported
  }, [reported])
  // Only the latest question's reply is shown: an earlier one may have been answered before the login changed.
  const asked = useRef(0)
  const check = useCallback(
    async (fresh = false): Promise<HarnessLoginStatus | undefined> => {
      if (!id) return undefined
      const then = pushed.current
      const round = ++asked.current
      const reply = await askLogin(id, fresh)
      if (reply && round === asked.current) setAnswer({ id, value: reply, pushed: then })
      return reply?.status
    },
    [id],
  )
  useEffect(() => {
    void check()
  }, [check])
  const { status, label, expiresAt } = shownLogin(answer?.id === id ? answer : undefined, reported)
  const probedAt = probe?.checkedAt
  const probed = probe?.login
  const seenProbe = useRef(probedAt)
  useEffect(() => {
    if (probedAt === seenProbe.current) return
    seenProbe.current = probedAt
    if ((probed === 'authenticated' || probed === 'unauthenticated') && probed !== status) void check(true)
  }, [check, probed, probedAt, status])
  useEffect(() => {
    if (status !== 'unauthenticated') return
    const again = () => {
      void check(true)
    }
    window.addEventListener('focus', again)
    return () => {
      window.removeEventListener('focus', again)
    }
  }, [check, status])
  return { status, label, expiresAt, check }
}

/**
 * One way to log in: the command as a person would type it, and on this computer a terminal that runs it: one of Latch's
 * own, or where the Host offers this device none, the default terminal app.
 */
function LoginCommand({
  harnessId,
  command,
  method,
  name,
  surface,
  onEnded,
}: {
  harnessId: string
  command: string
  /** One the harness advertised; absent for the preset's own command. */
  method?: string
  name?: string
  surface: LoginSurface
  /** The command left with code 0: asks the harness whether it is logged in now. */
  onEnded: () => Promise<HarnessLoginStatus | undefined>
}) {
  const run = useLoginRun(harnessId, method)
  const [opened, setOpened] = useState(false)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState('')
  /** What the harness said after a command ended, by that command's terminal. */
  const [verdict, setVerdict] = useState<{ terminalId: string; status: HarnessLoginStatus | undefined }>()
  const asked = useRef<string | undefined>(undefined)
  const ended = useRef(onEnded)
  useEffect(() => {
    ended.current = onEnded
  }, [onEnded])
  const terminalId = run?.terminal.id
  const state = run?.state
  useEffect(() => {
    if (state !== 'ended' || terminalId === undefined || asked.current === terminalId) return
    asked.current = terminalId
    void ended.current().then(status => {
      setVerdict({ terminalId, status })
    })
  }, [state, terminalId])
  const open = async () => {
    setOpening(true)
    setError('')
    try {
      if (surface.kind === 'latch')
        await loginRuns.start({
          harnessId,
          ...(method ? { method } : {}),
          ...(surface.sessionId !== undefined ? { sessionId: surface.sessionId } : {}),
        })
      else {
        await api(`harnesses/${encodeURIComponent(harnessId)}/login-terminal`, { method: 'POST', body: method ? { method } : {} })
        setOpened(true)
      }
    } catch (cause) {
      setError(inlineError(cause))
    } finally {
      setOpening(false)
    }
  }
  const word = loginRunWord(state, { asked: verdict?.terminalId === terminalId, status: verdict?.status })
  return (
    <>
      {name && (
        <p className="harness-login-method">
          <VisibleText text={name} />
        </p>
      )}
      <div className="harness-login-command">
        <code>
          <VisibleText text={command} />
        </code>
        <CopyButton text={command} label="复制登录命令" size="xs" />
        {surface.kind !== 'none' && (
          <Button size="xs" variant="secondary" icon={TerminalGlyph} loading={opening} onClick={() => void open()}>
            在终端里登录
          </Button>
        )}
        {word && (
          <span className="harness-login-state" data-state={word === '失败' ? 'failed' : undefined} role="status">
            {word === '登录中' ? (
              <Spinner size={12} />
            ) : (
              <Icon icon={word === '失败' ? AlertGlyph : word === '已登录' ? CircleCheckGlyph : TerminalGlyph} size={12} />
            )}
            {word}
          </span>
        )}
      </div>
      {opened && (
        <p>
          <Icon icon={TerminalGlyph} size={12} />
          登录后回到这里
        </p>
      )}
      {error && (
        <p className="harness-login-error" role="alert">
          {error}
        </p>
      )}
    </>
  )
}

/**
 * How to log in: the logins the harness advertised, else the preset's command, and on this computer a terminal that runs
 * one. Latch never logs in for a person.
 */
export function HarnessLoginSteps({
  harnessId,
  login,
  surface,
  onCheck,
  onEnded: ended,
  onLoggedIn,
}: {
  harnessId: string
  login: HarnessLogin
  /** Where the Host can run the command for this device. */
  surface: LoginSurface
  /** Asks again and gives the answer, behind 重新检查; absent where the caller has its own button, or none. */
  onCheck?: () => Promise<HarnessLoginStatus | undefined>
  /** The same question once a login command ended, for a caller that shows the answer itself; `onCheck` when absent. */
  onEnded?: () => Promise<HarnessLoginStatus | undefined>
  /** A login command ended and the harness itself now says it is logged in. */
  onLoggedIn?: (() => void) | undefined
}) {
  const [checking, setChecking] = useState(false)
  const methods = login.methods ?? []
  const runnable = methods.length > 0 || login.command !== undefined
  const { checkable } = login
  // A harness that cannot say is not asked: its command having ended is all there is to show.
  const recheck = ended ?? onCheck
  const onEnded = useCallback(async () => {
    const status = recheck ? await recheck() : checkable ? (await askLogin(harnessId, true))?.status : undefined
    if (status === 'authenticated') onLoggedIn?.()
    return status
  }, [recheck, checkable, harnessId, onLoggedIn])
  return (
    <div className="harness-login">
      {methods.map(method => (
        <LoginCommand
          key={method.id}
          harnessId={harnessId}
          command={method.command}
          method={method.id}
          {...(methods.length > 1 ? { name: method.name } : {})}
          surface={surface}
          onEnded={onEnded}
        />
      ))}
      {login.command && <LoginCommand harnessId={harnessId} command={login.command} surface={surface} onEnded={onEnded} />}
      {login.note && <p>{login.note}</p>}
      {runnable && surface.kind === 'none' && <p>在这台 Mac 的终端里运行这条命令。</p>}
      {onCheck && (
        <div className="harness-login-command">
          <Button
            size="xs"
            variant="ghost"
            icon={RefreshGlyph}
            loading={checking}
            onClick={() => {
              setChecking(true)
              void onCheck().finally(() => {
                setChecking(false)
              })
            }}>
            重新检查
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * Above a new session's composer: once the harness itself said it is not logged in, or that its login ends soon. A
 * harness that cannot be asked says so when reading its lists is refused for want of a login, and is asked again by
 * reading them again. Sending stays possible either way.
 */
export function DraftLoginNotice({
  harness,
  allowed,
  surface,
  onRead,
}: {
  harness: HarnessInfo | undefined
  allowed: boolean
  surface: LoginSurface
  /** Brings the Host's catalog here after a read. */
  onRead?: (() => void | Promise<void>) | undefined
}) {
  const { status, expiresAt, check } = useLoginStatus(harness, allowed)
  const login = harness?.login
  const refused = readNeedsLogin(harness)
  // A Harness Latch knows no login of still says it has none; the row then only offers to look again.
  if (!harness || (!login && !refused)) return null
  const name = harness.capabilities.display.label
  if (status === 'unauthenticated' || refused) {
    const readable = refused && allowed && harness.offer === undefined
    /** The program's own answer where it has one; otherwise whether its lists can be read now. */
    const recheck = async (): Promise<HarnessLoginStatus | undefined> => {
      const [answer, read] = await Promise.all([
        check(true),
        readable ? readHarnessCatalogue(harness, false).catch(() => undefined) : undefined,
      ])
      if (readable) await onRead?.()
      return answer ?? (read?.last?.ok === false && read.last.loginRequired ? 'unauthenticated' : undefined)
    }
    // A harness read only when asked is not started because a command ended: 重新检查 asks.
    const bySelf = harness.catalogueRead?.when === 'select'
    return (
      <section className="setup-card harness-login-card" role="status" aria-label="登录">
        <strong>{name} 还没登录</strong>
        <HarnessLoginSteps
          harnessId={harness.id}
          login={login ?? {}}
          surface={surface}
          onCheck={recheck}
          onEnded={() => (bySelf ? recheck() : check(true))}
        />
      </section>
    )
  }
  if (status === 'authenticated' && expiresAt && loginEndsSoon(expiresAt))
    return <InlineNotice tone="warn" title={`${name} 的登录 ${loginEndDay(expiresAt)}到期`} />
  return null
}
