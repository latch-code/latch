import { useEffect, useState } from 'react'
import { InlineNotice, SwitchRow } from '@latch/ui'
import { InlineConfirm } from '../components/InlineConfirm.tsx'
import { errorMessage, inlineError, isUncertain } from '../core/api.ts'
import { changeRemoteStart, readRemoteStart } from '../core/remoteStart.ts'
import { AUDIT_NOT_RECORDED_TEXT } from '../core/securityCopy.ts'
import { SettingsGroup } from './common.tsx'

/**
 * 手机可以开始新会话. Turning it on needs this Mac's Touch ID, so `raiseBlocked` says why it cannot be turned on from here;
 * turning it off works from any device that manages this Mac and shows at once.
 */
export function RemoteStartRow({ raiseBlocked }: { raiseBlocked?: string }) {
  const [allowed, setAllowed] = useState<boolean | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [auditMissing, setAuditMissing] = useState(false)
  useEffect(() => {
    let live = true
    readRemoteStart().then(
      value => {
        if (live) setAllowed(value)
      },
      (cause: unknown) => {
        if (live) setError(errorMessage(cause))
      },
    )
    return () => {
      live = false
    }
  }, [])
  const change = async (next: boolean) => {
    const before = allowed
    setError('')
    if (next) setPending(true)
    else setAllowed(false)
    try {
      const result = await changeRemoteStart(next)
      setAllowed(result.allowed)
      setAuditMissing(result.auditFailed)
    } catch (cause) {
      setAllowed(before)
      const text = inlineError(cause)
      if (text) setError(text)
      // A change that timed out may have happened: the switch shows what the Host holds, not what it held before.
      if (isUncertain(cause)) void readRemoteStart().then(setAllowed, () => {})
    } finally {
      setPending(false)
    }
  }
  return (
    <SettingsGroup>
      {allowed !== null && (
        <SwitchRow
          className="settings-row"
          title="手机可以开始新会话"
          description={pending ? '等待 Touch ID…' : '关闭后只能查看、允许或停止已有会话'}
          checked={allowed}
          locked={!allowed ? raiseBlocked : undefined}
          disabled={pending}
          onCheckedChange={next => {
            void change(next)
          }}
        />
      )}
      <InlineConfirm active={pending} />
      {auditMissing && <InlineNotice tone="error">{AUDIT_NOT_RECORDED_TEXT}</InlineNotice>}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
    </SettingsGroup>
  )
}
