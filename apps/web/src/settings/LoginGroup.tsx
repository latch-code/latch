import { useState } from 'react'
import { CircleAlert, CircleCheck, CircleHelp, LogOut, RefreshCw } from 'lucide-react'
import type { AgentProbeResult, HarnessInfo } from '@latch/protocol'
import { Button } from '@latch/ui'
import { ConfirmDialog } from '../components/overlays.tsx'
import { HarnessLoginSteps, loginDoubted, loginEndDay, loginEndsSoon, useLoginStatus } from '../components/HarnessLogin.tsx'
import { VisibleText } from '../components/VisibleText.tsx'
import { api, errorMessage } from '../core/api.ts'
import { IconTile, SettingsGroup, SettingsRow } from './common.tsx'

/**
 * Whether a harness is logged in, by its own word, how to log in again, and logging out where it offers that. Shown only
 * for a harness Latch knows something about its login for.
 */
export function LoginGroup({
  harness,
  allowed,
  terminal,
  probe,
}: {
  harness: HarnessInfo
  allowed: boolean
  terminal: boolean
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
    ? '登录可能已失效'
    : signedIn
      ? '已登录'
      : left
        ? '已退出登录'
        : status === 'unauthenticated'
          ? '还没登录'
          : '登录状态未知'
  const details = [signedIn && label, signedIn && expiresAt && `${loginEndDay(expiresAt)}到期`, doubted && '测试启动说还没登录'].filter(
    (part): part is string => Boolean(part),
  )
  const steps = (!signedIn || switching || doubted) && (runnable || login.note)
  return (
    <SettingsGroup
      title="登录"
      meta={
        login.checkable && allowed ? (
          <Button
            variant="ghost"
            size="xs"
            icon={RefreshCw}
            loading={checking}
            onClick={() => {
              setChecking(true)
              void check(true).finally(() => {
                setChecking(false)
              })
            }}>
            重新检查
          </Button>
        ) : undefined
      }>
      <SettingsRow
        leading={
          <IconTile
            icon={
              signedIn ? (soon || doubted ? CircleAlert : CircleCheck) : status === 'unauthenticated' || left ? CircleAlert : CircleHelp
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
              退出登录
            </Button>
          ) : signedIn && runnable && !switching && !doubted ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSwitching(true)
              }}>
              换账号
            </Button>
          ) : undefined
        }
      />
      {steps && (
        <div className="settings-card-body">
          <HarnessLoginSteps harnessId={harness.id} login={login} terminal={terminal} />
        </div>
      )}
      {leaving && (
        <ConfirmDialog
          title="退出登录"
          danger
          confirmLabel="退出登录"
          message={`退出 ${name} 的登录？之后要重新登录才能开始会话。这台 Mac 上别处用的是同一份登录时，那里也会退出。有会话正在运行时不能退出。`}
          onClose={() => {
            setLeaving(false)
          }}
          onConfirm={async () => {
            try {
              await api(`harnesses/${encodeURIComponent(harness.id)}/logout`, { method: 'POST', body: {} })
            } catch (cause) {
              throw new Error(errorMessage(cause), { cause })
            }
            setLeft(true)
            await check(true)
          }}
        />
      )}
    </SettingsGroup>
  )
}
