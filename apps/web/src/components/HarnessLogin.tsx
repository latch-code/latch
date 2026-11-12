import { useCallback, useEffect, useRef, useState } from 'react'

import { settleLogin, type AgentProbeResult, type HarnessInfo, type HarnessLogin, type HarnessLoginCheck } from '@latch/protocol'
import { Button, CopyButton, Icon, InlineNotice, RefreshGlyph, TerminalGlyph } from '@latch/ui'
import { api, inlineError } from '../core/api.ts'
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
    async (fresh = false) => {
      if (!id) return
      const then = pushed.current
      const round = ++asked.current
      const reply = await api<HarnessLoginCheck>(`harnesses/${encodeURIComponent(id)}/login-status`, {
        method: 'POST',
        body: fresh ? { fresh } : {},
      }).catch(() => undefined)
      if (reply && round === asked.current) setAnswer({ id, value: reply, pushed: then })
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

/** One way to log in: the command as a person would type it, and on this computer a terminal that runs it. */
function LoginCommand({
  harnessId,
  command,
  method,
  name,
  terminal,
}: {
  harnessId: string
  command: string
  /** One the harness advertised; absent for the preset's own command. */
  method?: string
  name?: string
  terminal: boolean
}) {
  const [opened, setOpened] = useState(false)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState('')
  const open = async () => {
    setOpening(true)
    setError('')
    try {
      await api(`harnesses/${encodeURIComponent(harnessId)}/login-terminal`, { method: 'POST', body: method ? { method } : {} })
      setOpened(true)
    } catch (cause) {
      setError(inlineError(cause))
    } finally {
      setOpening(false)
    }
  }
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
        {terminal && (
          <Button size="xs" variant="secondary" icon={TerminalGlyph} loading={opening} onClick={() => void open()}>
            在终端里登录
          </Button>
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
  terminal,
  onCheck,
}: {
  harnessId: string
  login: HarnessLogin
  /** The Host can open a terminal for this device. */
  terminal: boolean
  /** Asks again; absent when the harness has no way to say. */
  onCheck?: () => Promise<void>
}) {
  const [checking, setChecking] = useState(false)
  const methods = login.methods ?? []
  const runnable = methods.length > 0 || login.command !== undefined
  return (
    <div className="harness-login">
      {methods.map(method => (
        <LoginCommand
          key={method.id}
          harnessId={harnessId}
          command={method.command}
          method={method.id}
          {...(methods.length > 1 ? { name: method.name } : {})}
          terminal={terminal}
        />
      ))}
      {login.command && <LoginCommand harnessId={harnessId} command={login.command} terminal={terminal} />}
      {login.note && <p>{login.note}</p>}
      {runnable && !terminal && <p>在这台 Mac 的终端里运行这条命令。</p>}
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
 * Above a new session's composer: once the harness itself said it is not logged in, or that its login ends soon. Sending
 * stays possible either way.
 */
export function DraftLoginNotice({
  harness,
  allowed,
  terminal,
}: {
  harness: HarnessInfo | undefined
  allowed: boolean
  terminal: boolean
}) {
  const { status, expiresAt, check } = useLoginStatus(harness, allowed)
  const login = harness?.login
  if (!harness || !login) return null
  const name = harness.capabilities.display.label
  if (status === 'unauthenticated')
    return (
      <section className="setup-card harness-login-card" role="status" aria-label="登录">
        <strong>{name} 还没登录</strong>
        <HarnessLoginSteps harnessId={harness.id} login={login} terminal={terminal} onCheck={() => check(true)} />
      </section>
    )
  if (status === 'authenticated' && expiresAt && loginEndsSoon(expiresAt))
    return <InlineNotice tone="warn" title={`${name} 的登录 ${loginEndDay(expiresAt)}到期`} />
  return null
}
