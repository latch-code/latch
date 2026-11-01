import { useEffect, useState } from 'react'
import { isNativeListener, type WaitingEnrollmentView } from '@latch/protocol'
import { ConnectionDetails } from '../../components/ConnectionDetails.tsx'
import { VisibleText } from '../../components/VisibleText.tsx'
import { api, ApiError } from '../../core/api.ts'
import { CONNECTION_DETAILS_COPY, WAITING_DEVICES_COPY as COPY } from '../../core/securityCopy.ts'

const POLL_MS = 1000

/**
 * Who is asking to connect, in the Mac's panel: the system sheet gives only the name a device chose, so this is where its
 * code can be compared with the code on its page. A QR phone shows no code to compare with: its check is the question
 * after the confirmation, so only the sheet, which already names it, folds the rest for it. The Host lists these only to
 * this Mac's admins.
 */
export function WaitingDevices({ place }: { place: 'page' | 'sheet' }) {
  const [waiting, setWaiting] = useState<WaitingEnrollmentView[]>([])
  useEffect(() => {
    let active = true
    let timer: number | undefined
    const load = async () => {
      try {
        const answer = await api<{ enrollments?: WaitingEnrollmentView[] }>('enrollments')
        if (active) setWaiting(Array.isArray(answer.enrollments) ? answer.enrollments : [])
      } catch (cause) {
        // An older Host has no list: stop asking. Anything else is asked again on the next tick.
        if (cause instanceof ApiError && cause.status === 404) clearInterval(timer)
      }
    }
    void load()
    timer = window.setInterval(() => {
      void load()
    }, POLL_MS)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [])
  const shown = place === 'sheet' ? waiting : waiting.filter(item => !isNativeListener(item.listener))
  if (shown.length === 0) return null
  return (
    <>
      {shown.map(item => {
        const phone = isNativeListener(item.listener)
        const details = (
          <ConnectionDetails
            {...(phone ? {} : { code: item.fingerprint, codeNote: CONNECTION_DETAILS_COPY.compareOnDevice })}
            {...(item.reason ? { reason: item.reason } : {})}
            {...(item.scopes ? { scopes: item.scopes } : {})}
            {...(item.dataScope ? { dataScope: item.dataScope } : {})}
          />
        )
        if (phone)
          return (
            <div key={item.id} className="device-waiting-phone" data-secure="">
              {details}
            </div>
          )
        return (
          <div key={item.id} className="device-waiting" role="status" data-secure="">
            <p className="device-waiting-title">
              「<VisibleText text={item.name} />」{COPY.asking}
            </p>
            <p className="device-waiting-note">{item.status === 'approved' ? COPY.approved : COPY.confirm}</p>
            {item.scopes?.includes('admin') && (
              <p className="device-waiting-note" data-tone="warn">
                {COPY.canManage}
              </p>
            )}
            {details}
          </div>
        )
      })}
    </>
  )
}
