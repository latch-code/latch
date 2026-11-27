import { useState } from 'react'
import { CircleHelp, LogOut } from 'lucide-react'
import type { AgentProbeResult, HarnessInfo } from '@latch/protocol'
import { Button, AlertGlyph, CircleCheckGlyph, RefreshGlyph } from '@latch/ui'
import { ConfirmDialog } from '../components/overlays.tsx'
import { HarnessLoginSteps, loginDoubted, loginEndDay, loginEndsSoon, useLoginStatus } from '../components/HarnessLogin.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { api, errorMessage, MessageError } from '../core/api.ts'
import type { LoginSurface } from '../panel/terminal/loginRuns.ts'
import { IconTile, SettingsGroup, SettingsRow } from './common.tsx'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    maybeExpired: '登录可能已失效',
    loggedIn: '已登录',
    loggedOut: '已退出登录',
    notLoggedIn: '还没登录',
    unknown: '登录状态未知',
    testDisagrees: '测试启动说还没登录',
    login: '登录',
    check: '重新检查',
    logout: '退出登录',
    switchAccount: '换账号',
    expires: (day: string) => `${day}到期`,
    confirmLogout: (name: string) =>
      `退出 ${name} 的登录？之后要重新登录才能开始会话。这台 Mac 上别处用的是同一份登录时，那里也会退出。有会话正在运行时不能退出。`,
  },
  {
    maybeExpired: 'Login may have expired',
    loggedIn: 'Logged in',
    loggedOut: 'Logged out',
    notLoggedIn: 'Not logged in',
    unknown: 'Login status unknown',
    testDisagrees: 'Launch test says not logged in',
    login: 'Login',
    check: 'Check again',
    logout: 'Log out',
    switchAccount: 'Switch account',
    expires: (day: string) => `Expires ${day}`,
    confirmLogout: (name: string) =>
      `Log out of ${name}? To start sessions again, you’ll need to log in. Other apps on this Mac that share this login will also be signed out. Wait for running sessions to finish before logging out.`,
  },
)

/**
 * Whether a harness is logged in, by its own word, how to log in again, and logging out where it offers that. Shown only
 * for a harness Latch knows something about its login for.
 */
export function LoginGroup({
  harness,
  allowed,
  surface,
  probe,
}: {
  harness: HarnessInfo
  allowed: boolean
  surface: LoginSurface
  /** The last test start's result. */
  probe?: AgentProbeResult | undefined
}) {
  const login = harness.login
  const { status, label, expiresAt, check } = useLoginStatus(harness, allowed, probe)
  const [checking, setChecking] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [switching, setSwitching] = useState(false)
  // The harness may not say it again once the process that logged out is gone, but this page just did it.
  const [left, setLeft] = useState(false)
  if (!login) return null
  const name = harness.capabilities.display.label
  const signedIn = status === 'authenticated'
  const doubted = loginDoubted(status, probe)
  const soon = signedIn && loginEndsSoon(expiresAt)
  const runnable = login.methods !== undefined || login.command !== undefined
  const title = doubted
    ? COPY.maybeExpired
    : signedIn
      ? COPY.loggedIn
      : left
        ? COPY.loggedOut
        : status === 'unauthenticated'
          ? COPY.notLoggedIn
          : COPY.unknown
  const details = [signedIn && label, signedIn && expiresAt && COPY.expires(loginEndDay(expiresAt)), doubted && COPY.testDisagrees].filter(
    (part): part is string => Boolean(part),
  )
  const steps = (!signedIn || switching || doubted) && (runnable || login.note)
  return (
    <SettingsGroup
      title={COPY.login}
      meta={
        login.checkable && allowed ? (
          <Button
            variant="ghost"
            size="xs"
            icon={RefreshGlyph}
            loading={checking}
            onClick={() => {
              setChecking(true)
              void check(true).finally(() => {
                setChecking(false)
              })
            }}>
            {COPY.check}
          </Button>
        ) : undefined
      }>
      <SettingsRow
        leading={
          <IconTile
            icon={
              signedIn ? (soon || doubted ? AlertGlyph : CircleCheckGlyph) : status === 'unauthenticated' || left ? AlertGlyph : CircleHelp
            }
          />
        }
        title={title}
        description={details.length ? <VisibleText text={details.join(' · ')} /> : undefined}
        trailing={
          signedIn && login.logout && allowed ? (
            <Button
              size="sm"
              variant="ghost"
              icon={LogOut}
              onClick={() => {
                setLeaving(true)
              }}>
              {COPY.logout}
            </Button>
          ) : signedIn && runnable && !switching && !doubted ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSwitching(true)
              }}>
              {COPY.switchAccount}
            </Button>
          ) : undefined
        }
      />
      {steps && (
        <div className="settings-card-body">
          <HarnessLoginSteps harnessId={harness.id} account={harness.account} login={login} surface={surface} onEnded={() => check(true)} />
        </div>
      )}
      {leaving && (
        <ConfirmDialog
          title={COPY.logout}
          danger
          confirmLabel={COPY.logout}
          message={COPY.confirmLogout(name)}
          onClose={() => {
            setLeaving(false)
          }}
          onConfirm={async () => {
            try {
              await api(`harnesses/${encodeURIComponent(harness.id)}/logout`, { method: 'POST', body: {} })
            } catch (cause) {
              throw new MessageError(errorMessage(cause), { cause })
            }
            setLeft(true)
            await check(true)
          }}
        />
      )}
    </SettingsGroup>
  )
}
