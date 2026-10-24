import { useCallback, useEffect, useRef, useState } from 'react'
import { isAcceptableDeviceName, type Device, type DeviceScope, type EnrollmentInfo, type EnrollmentView } from '@latch/protocol'
import { api, ApiError, errorMessage } from './api.ts'
import {
  base64urlDecode,
  browserKeySupport,
  deviceFingerprint,
  enrollSigningText,
  generateDeviceKey,
  saveDeviceKey,
  signText,
  type DeviceKeyRecord,
} from './deviceKey.ts'
import { DEVICE_NAME_INVALID_TEXT } from './securityCopy.ts'
import { currentShell } from './shell.ts'

/**
 * A pairing invitation arrives as `#pair=<code>` in the URL fragment. It is read
 * once at module load, kept in memory only, and removed from the address bar
 * before any request. Old `#token=` links are dropped unused.
 */
function captureFragment(): string | null {
  if (typeof location === 'undefined' || !location.hash) return null
  const fragment = new URLSearchParams(location.hash.slice(1))
  if (!fragment.has('pair') && !fragment.has('token')) return null
  const pair = fragment.get('pair')?.trim() ?? ''
  try {
    history.replaceState(null, '', `${location.pathname}${location.search}`)
  } catch {
    /* The fragment is still never sent to the server. */
  }
  return /^[A-Za-z0-9_-]{1,64}$/.test(pair) ? pair : null
}

let invitation = captureFragment()
export const pendingInvitation = () => invitation

export const BASE_SCOPES: DeviceScope[] = ['view', 'run', 'approve:standard']

/** A device name to submit or show: the old one only when the security-text rule would leave it unchanged. */
export function acceptableName(name: string | undefined): string | undefined {
  return name !== undefined && isAcceptableDeviceName(name) ? name.trim() : undefined
}

export function defaultDeviceName(legacyName?: string): string {
  const legacy = acceptableName(legacyName)
  if (legacy) return legacy
  if (currentShell()) return 'Latch 桌面端'
  return typeof navigator !== 'undefined' && /Android|iPhone|iPad/i.test(navigator.userAgent) ? '我的手机' : '我的浏览器'
}

/** The name an enrollment submits: the default when left empty, null when the security-text rule would escape it. */
export function enrollmentName(typed: string, legacyName?: string): string | null {
  const name = typed.trim()
  if (name === '') return defaultDeviceName(legacyName)
  return isAcceptableDeviceName(name) ? name : null
}

export type EnrollmentStep =
  | { kind: 'loading' }
  | { kind: 'load-failed'; message: string }
  | { kind: 'old-host' }
  | { kind: 'unsupported' }
  | { kind: 'invitation-required' }
  | { kind: 'form' }
  | { kind: 'submitting' }
  | { kind: 'waiting'; enrollment: EnrollmentView }
  | { kind: 'completing' }
  /** The device exists, but the first snapshot after `complete` failed; retrying reads it again. */
  | { kind: 'confirm-failed'; message: string }
  | { kind: 'denied' }
  | { kind: 'expired' }
  | { kind: 'mismatch' }

export interface EnrollmentRequestForm {
  name: string
  admin: boolean
  offlineCode?: string
}

interface Flight {
  enrollment: EnrollmentView
  nonce: string
  key?: DeviceKeyRecord
}

const enrollmentPath = (id: string) => `enrollments/${encodeURIComponent(id)}`

/** `GET enrollment-info` failed: a Host from before device confirmation has no enrollment API at all (404). */
export function infoFailureStep(cause: unknown): EnrollmentStep {
  return cause instanceof ApiError && cause.status === 404 ? { kind: 'old-host' } : { kind: 'load-failed', message: errorMessage(cause) }
}

/**
 * What the first snapshot after a completed enrollment showed. `credential-not-stored`: the Host refused the new
 * credential, so the browser did not keep the cookie.
 */
export type EnrolledResult = { status: 'connected' } | { status: 'credential-not-stored' } | { status: 'failed'; message: string }

/** The step after a completed enrollment; null once connected (the workspace replaces this page). */
export function enrolledStep(result: EnrolledResult): EnrollmentStep | null {
  if (result.status === 'connected') return null
  // The page's reason now explains the missing cookie; only a new enrollment can help.
  if (result.status === 'credential-not-stored') return { kind: 'form' }
  return { kind: 'confirm-failed', message: result.message }
}

/** Whether a refused enrollment request should be repeated without `admin` (an invitation may not allow it). */
export function retryWithoutAdmin(error: unknown, requestedAdmin: boolean, withInvitation: boolean): boolean {
  if (!requestedAdmin || !withInvitation || !(error instanceof ApiError)) return false
  return (
    (error.status === 400 && error.code === 'scope-not-grantable')
    || (error.status === 403 && error.code !== 'invitation-required' && error.code !== 'invitation-invalid')
  )
}

/** The browser (or desktop shell) side of device enrollment: request, wait for the Host's local confirmation, sign, complete. */
export function useEnrollment(onEnrolled: () => Promise<EnrolledResult>) {
  const [info, setInfo] = useState<EnrollmentInfo | null>(null)
  const [step, setStep] = useState<EnrollmentStep>({ kind: 'loading' })
  const [error, setError] = useState('')
  const flight = useRef<Flight | null>(null)
  const alive = useRef(true)
  const shell = currentShell()

  const load = useCallback(async () => {
    setStep({ kind: 'loading' })
    setError('')
    try {
      const next = await api<EnrollmentInfo>('enrollment-info', { noRenew: true })
      if (!alive.current) return
      setInfo(next)
      if (!shell && !browserKeySupport()) setStep({ kind: 'unsupported' })
      else if (next.invitationRequired && invitation === null) setStep({ kind: 'invitation-required' })
      else setStep({ kind: 'form' })
    } catch (cause) {
      if (alive.current) setStep(infoFailureStep(cause))
    }
  }, [shell])

  useEffect(() => {
    alive.current = true
    void load()
    const leave = () => {
      const active = flight.current
      if (active && active.enrollment.status === 'pending') {
        void fetch(`/link/api/${enrollmentPath(active.enrollment.id)}`, {
          method: 'DELETE',
          credentials: 'same-origin',
          keepalive: true,
        }).catch(() => {})
      }
    }
    // An invitation link opened in a tab that already shows this page changes only the fragment.
    const fragment = () => {
      const captured = captureFragment()
      if (captured !== null && flight.current === null) {
        invitation = captured
        void load()
      }
    }
    window.addEventListener('pagehide', leave)
    window.addEventListener('hashchange', fragment)
    return () => {
      alive.current = false
      window.removeEventListener('pagehide', leave)
      window.removeEventListener('hashchange', fragment)
      leave()
    }
  }, [load])

  /** After `complete` the device exists: a failed first snapshot is retried, never a second enrollment. */
  const confirm = useCallback(async () => {
    setStep({ kind: 'completing' })
    setError('')
    const next = enrolledStep(await onEnrolled())
    if (alive.current && next) setStep(next)
  }, [onEnrolled])

  const finish = useCallback(async () => {
    const active = flight.current
    if (!active || !info) return
    setStep({ kind: 'completing' })
    try {
      let body: { signature?: string } = {}
      if (active.key) {
        // Stored before completing: a credential whose key could not be kept would be unrenewable.
        await saveDeviceKey(active.key)
        body = { signature: await signText(active.key.privateKey, enrollSigningText(info.hostId, active.enrollment.id, active.nonce)) }
      }
      const { device } = await api<{ device: Device }>(`${enrollmentPath(active.enrollment.id)}/complete`, {
        method: 'POST',
        body,
        noRenew: true,
      })
      flight.current = null
      if (active.key)
        await saveDeviceKey({ ...active.key, deviceId: device.id }).catch(() => {
          /* Renewal falls back to the snapshot's device id. */
        })
    } catch (cause) {
      if (!alive.current) return
      flight.current = null
      if (cause instanceof ApiError && cause.code === 'fingerprint-mismatch') setStep({ kind: 'mismatch' })
      else if (cause instanceof ApiError && cause.code === 'enrollment-denied') setStep({ kind: 'denied' })
      else if (cause instanceof ApiError && cause.code === 'enrollment-expired') setStep({ kind: 'expired' })
      else {
        setError(errorMessage(cause))
        setStep({ kind: 'form' })
      }
      return
    }
    await confirm()
  }, [info, confirm])

  const submit = useCallback(
    async (form: EnrollmentRequestForm) => {
      if (!info) return
      const name = enrollmentName(form.name, info.legacy?.name)
      if (name === null) {
        setError(DEVICE_NAME_INVALID_TEXT)
        return
      }
      setStep({ kind: 'submitting' })
      setError('')
      try {
        const key = shell ? undefined : await generateDeviceKey(info.hostId)
        const offlineCode = form.offlineCode?.trim()
        const create = (admin: boolean) =>
          api<{ enrollment: EnrollmentView }>('enrollments', {
            method: 'POST',
            noRenew: true,
            body: {
              name,
              ...(key ? { publicKey: key.publicKeySpki } : {}),
              // The desktop shell enrolls on the Host's own socket, whose defaults are all scopes.
              ...(shell ? {} : { scopes: [...BASE_SCOPES, ...(admin ? ['admin' as const] : [])] }),
              ...(invitation ? { invitation } : {}),
              ...(offlineCode ? { offlineCode } : {}),
            },
          })
        let created: { enrollment: EnrollmentView }
        try {
          created = await create(form.admin)
        } catch (cause) {
          if (!retryWithoutAdmin(cause, form.admin, invitation !== null)) throw cause
          created = await create(false)
        }
        invitation = null
        const enrollment = created.enrollment
        if (!alive.current) return
        if (key) {
          const local = await deviceFingerprint(base64urlDecode(key.publicKeySpki))
          if (local !== enrollment.fingerprint) {
            void api(enrollmentPath(enrollment.id), { method: 'DELETE', noRenew: true }).catch(() => {})
            setStep({ kind: 'mismatch' })
            return
          }
        }
        flight.current = { enrollment, nonce: enrollment.nonce ?? '', ...(key ? { key } : {}) }
        if (enrollment.status === 'approved') await finish()
        else setStep({ kind: 'waiting', enrollment })
      } catch (cause) {
        if (!alive.current) return
        if (cause instanceof ApiError && cause.code === 'fingerprint-mismatch') {
          setStep({ kind: 'mismatch' })
          return
        }
        setError(errorMessage(cause))
        setStep({ kind: 'form' })
      }
    },
    [info, shell, finish],
  )

  const waitingId = step.kind === 'waiting' ? step.enrollment.id : null
  useEffect(() => {
    if (waitingId === null) return
    let stopped = false
    const timer = setInterval(() => {
      void (async () => {
        try {
          const { enrollment } = await api<{ enrollment: EnrollmentView }>(enrollmentPath(waitingId), { noRenew: true })
          const active = flight.current
          if (stopped || !active || active.enrollment.id !== enrollment.id) return
          active.enrollment = { ...active.enrollment, status: enrollment.status, expiresAt: enrollment.expiresAt }
          if (enrollment.status === 'pending') return
          stopped = true
          if (enrollment.status === 'approved') await finish()
          else if (enrollment.status === 'denied') {
            flight.current = null
            setStep({ kind: 'denied' })
          } else if (enrollment.status === 'expired') {
            flight.current = null
            setStep({ kind: 'expired' })
          } else if (enrollment.status === 'completed') {
            flight.current = null
            await confirm()
          } else {
            flight.current = null
            setStep({ kind: 'form' })
          }
        } catch (cause) {
          if (stopped) return
          // A restarted Host forgets pending enrollments.
          if (cause instanceof ApiError && (cause.code === 'enrollment-not-found' || cause.code === 'enrollment-expired')) {
            stopped = true
            flight.current = null
            setStep({ kind: 'expired' })
          } else if (cause instanceof ApiError && cause.code === 'enrollment-cancelled') {
            stopped = true
            flight.current = null
            setError(errorMessage(cause))
            setStep({ kind: 'form' })
          } else if (Date.now() > Date.parse(flight.current?.enrollment.expiresAt ?? '') + 5000) {
            stopped = true
            flight.current = null
            setStep({ kind: 'expired' })
          }
        }
      })()
    }, 1000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [waitingId, finish, confirm])

  const cancel = useCallback(() => {
    const active = flight.current
    flight.current = null
    setStep({ kind: 'form' })
    if (active) void api(enrollmentPath(active.enrollment.id), { method: 'DELETE', noRenew: true }).catch(() => {})
  }, [])

  const restart = useCallback(() => {
    setError('')
    setStep(info ? { kind: 'form' } : { kind: 'loading' })
    if (!info) void load()
  }, [info, load])

  return { info, step, error, submit, cancel, restart, reload: load, retryConfirm: confirm, electron: shell !== null }
}
