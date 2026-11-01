import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, SquareTerminal } from 'lucide-react'
import type { HarnessInfo, HarnessLogin, HarnessLoginStatus } from '@latch/protocol'
import { Button, CopyButton } from '@latch/ui'
import { api, inlineError } from '../core/api.ts'

/**
 * What the harness's own status command says, asked once when it is chosen and again each time this window comes back,
 * since logging in happens in another. Anything but a clear answer stays `unknown` and the page says nothing.
 */
function useLoginStatus(harness: Pick<HarnessInfo, 'id' | 'login'> | undefined, allowed: boolean) {
  const [status, setStatus] = useState<{ id: string; value: HarnessLoginStatus }>()
  const id = allowed && harness?.login?.checkable ? harness.id : undefined
  const check = useCallback(
    async (fresh = false) => {
      if (!id) return
      const reply = await api<{ status: HarnessLoginStatus }>(`harnesses/${encodeURIComponent(id)}/login-status`, {
        method: 'POST',
        body: fresh ? { fresh } : {},
      }).catch(() => undefined)
      if (reply) setStatus({ id, value: reply.status })
    },
    [id],
  )
  useEffect(() => {
    void check()
  }, [check])
  const value = status?.id === id ? status?.value : undefined
  useEffect(() => {
    if (value !== 'unauthenticated') return
    const again = () => {
      void check(true)
    }
    window.addEventListener('focus', again)
    return () => {
      window.removeEventListener('focus', again)
    }
  }, [check, value])
  return { status: value, check }
}

/** The harness's own login command, and on this computer a way to run it in a terminal. Latch never logs in for a person. */
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
  const [opened, setOpened] = useState(false)
  const [opening, setOpening] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const open = async () => {
    setOpening(true)
    setError('')
    try {
      await api(`harnesses/${encodeURIComponent(harnessId)}/login-terminal`, { method: 'POST', body: {} })
      setOpened(true)
    } catch (cause) {
      setError(inlineError(cause))
    } finally {
      setOpening(false)
    }
  }
  return (
    <div className="harness-login">
      <div className="harness-login-command">
        <code>{login.command}</code>
        <CopyButton text={login.command} label="复制登录命令" size="xs" />
        {terminal && (
          <Button size="xs" variant="secondary" icon={SquareTerminal} loading={opening} onClick={() => void open()}>
            在终端里登录
          </Button>
        )}
        {onCheck && (
          <Button
            size="xs"
            variant="ghost"
            icon={RefreshCw}
            loading={checking}
            onClick={() => {
              setChecking(true)
              void onCheck().finally(() => {
                setChecking(false)
              })
            }}>
            重新检查
          </Button>
        )}
      </div>
      {login.note && <p>{login.note}</p>}
      {!terminal && <p>在这台 Mac 的终端里运行这条命令。</p>}
      {opened && <p>在打开的终端里登录，完成后回到这里。</p>}
      {error && (
        <p className="harness-login-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/** Above a new session's composer: only once the harness itself said it is not logged in, and sending stays possible. */
export function DraftLoginNotice({
  harness,
  allowed,
  terminal,
}: {
  harness: HarnessInfo | undefined
  allowed: boolean
  terminal: boolean
}) {
  const { status, check } = useLoginStatus(harness, allowed)
  if (status !== 'unauthenticated' || !harness?.login) return null
  return (
    <section className="setup-card harness-login-card" role="status" aria-label="登录">
      <strong>{harness.capabilities.display.label} 还没登录</strong>
      <HarnessLoginSteps harnessId={harness.id} login={harness.login} terminal={terminal} onCheck={() => check(true)} />
    </section>
  )
}
