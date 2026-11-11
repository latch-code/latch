import { useEffect, useState } from 'react'
import { QrCode } from 'lucide-react'
import type { NativeLinkInfo } from '@latch/protocol'
import { Button, InlineNotice, Popover } from '@latch/ui'
import { api, inlineError } from '../../core/api.ts'
import { describeFailure, DEVICES_COPY as COPY, NATIVE_LINK_COPY } from '../../core/securityCopy.ts'
import type { LatchShell } from '../../core/shell.ts'
import { WaitingDevices } from './WaitingDevices.tsx'

/** The note after 在浏览器中打开 says what happens next, so it goes once that has had time to happen. */
const OPENED_NOTE_MS = 15_000

/**
 * 连接手机, on the Latch app on this Mac with 管理此 Host only, and the devices waiting to be let in under it while the
 * pairing sheet is closed.
 */
export function ConnectPhone({ pairing, onPair }: { pairing: boolean; onPair: () => void }) {
  return (
    <>
      <Button variant="primary" icon={QrCode} block className="device-connect" onClick={onPair}>
        {NATIVE_LINK_COPY.enable}
      </Button>
      {!pairing && <WaitingDevices place="page" />}
    </>
  )
}

/**
 * 在浏览器中打开, in the desktop app on macOS only. A browser here enrolls over loopback, which takes a one-time invitation;
 * the shell's main process makes one and opens the default browser with it in the fragment, so this page never sees
 * the invitation. Elsewhere the invitation would land on a command line, so nothing is offered.
 */
function OpenInBrowser({ open }: { open: NonNullable<LatchShell['openInBrowser']> }) {
  const [busy, setBusy] = useState(false)
  const [opened, setOpened] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!opened) return undefined
    const timer = window.setTimeout(() => {
      setOpened(false)
    }, OPENED_NOTE_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [opened])
  const run = async () => {
    setBusy(true)
    setOpened(false)
    setError('')
    try {
      const result = await open()
      if (result.ok) setOpened(true)
      else
        setError(
          describeFailure(
            result.status,
            result.error,
            result.message,
            result.retryAfter === undefined ? {} : { retryAfter: result.retryAfter },
          ),
        )
    } catch {
      setError(describeFailure(502, 'browser-open-failed', ''))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="device-foot-browser" data-secure="">
      <Button
        variant="link"
        className="device-foot-link"
        loading={busy}
        onClick={() => {
          void run()
        }}>
        {COPY.browser}
      </Button>
      {opened && (
        <p className="device-foot-note" role="status">
          {COPY.browserOpened}
        </p>
      )}
      {error && (
        <InlineNotice tone="error" secure>
          {error}
        </InlineNotice>
      )}
    </div>
  )
}

/**
 * A relay or address directory saved by an earlier build: nothing can add one now, so this only offers the way to take it
 * back, and only to someone who has one. It is the one place these are named, beside the sentence about relays.
 */
function SavedRoutes() {
  const [info, setInfo] = useState<NativeLinkInfo | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void api<NativeLinkInfo>('native/info').then(
      value => {
        if (active) setInfo(value)
      },
      () => {},
    )
    return () => {
      active = false
    }
  }, [])
  const remove = (path: string) => {
    setError('')
    void api<NativeLinkInfo>(path, { method: 'DELETE' }).then(setInfo, (cause: unknown) => {
      setError(inlineError(cause))
    })
  }
  return (
    <>
      {info?.relays.map(relay => (
        <div key={relay.relayId} className="device-saved">
          <span className="device-saved-text">
            <b>{COPY.savedRelay}</b>
            <span>{relay.url}</span>
          </span>
          <Button
            onClick={() => {
              remove(`native/relays/${relay.relayId}`)
            }}>
            {COPY.remove}
          </Button>
        </div>
      ))}
      {info?.directory && (
        <div className="device-saved">
          <span className="device-saved-text">
            <b>{COPY.savedDirectory}</b>
          </span>
          <Button
            onClick={() => {
              remove('native/directory')
            }}>
            {COPY.remove}
          </Button>
        </div>
      )}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
    </>
  )
}

function AboutConnection({ canManageRoutes }: { canManageRoutes: boolean }) {
  return (
    <Popover
      label={COPY.about}
      title={COPY.about}
      width={280}
      side="top"
      align="start"
      trigger={props => (
        <Button {...props} variant="link" className="device-foot-link">
          {COPY.about}
        </Button>
      )}>
      <p className="device-about">{COPY.aboutBody}</p>
      {canManageRoutes && <SavedRoutes />}
    </Popover>
  )
}

/** The foot of 设置 › 设备: 关于连接, and 在浏览器中打开 where the desktop app can hand a browser its link. */
export function ConnectionFoot({
  canManageRoutes,
  openInBrowser,
}: {
  canManageRoutes: boolean
  openInBrowser: LatchShell['openInBrowser'] | undefined
}) {
  return (
    <div className="device-foot">
      <div className="device-foot-links">
        <AboutConnection canManageRoutes={canManageRoutes} />
        {openInBrowser && <OpenInBrowser open={openInBrowser} />}
      </div>
    </div>
  )
}
