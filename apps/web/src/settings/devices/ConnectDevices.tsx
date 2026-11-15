import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AppWindow, Link, QrCode } from 'lucide-react'
import type { NativeLinkInfo, NativeRelayProfile } from '@latch/protocol'
import { Button, Icon, InlineNotice, LaptopGlyph, LockGlyph, PhoneGlyph } from '@latch/ui'
import { api, inlineError } from '../../core/api.ts'
import { withConfirmation } from '../../core/confirmations.ts'
import { describeFailure, DEVICES_COPY as COPY } from '../../core/securityCopy.ts'
import type { LatchShell } from '../../core/shell.ts'
import { IconTile, NoteLine, SettingsGroup, SettingsRow } from '../common.tsx'
import { WaitingDevices } from './WaitingDevices.tsx'

/** The note after 在浏览器中打开 says what happens next, so it goes once that has had time to happen. */
const OPENED_NOTE_MS = 15_000
/** The copied link lives ten minutes; its line goes with it. */
const COPIED_NOTE_MS = 10 * 60_000

type ShellAction = NonNullable<LatchShell['openInBrowser']>
/** Stands in for an action this shell does not have; its row is not drawn, so it is never pressed. */
const missing: ShellAction = () => Promise.resolve({ ok: false, status: 409, error: 'browser-open-unsupported', message: '' })

/**
 * A button that asks the Latch app's main process for something it keeps from the page (a link, the browser it opens):
 * busy while main answers, then one line saying what happened, or the failure from the fixed catalogue. The page never
 * receives the link itself, so there is nothing here to show or copy again: a second press asks for a new one.
 */
function useShellAction(run: ShellAction, failure: string, keepMs: number) {
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!done) return undefined
    const timer = window.setTimeout(() => {
      setDone(false)
    }, keepMs)
    return () => {
      clearTimeout(timer)
    }
  }, [done, keepMs])
  const start = async () => {
    setBusy(true)
    setDone(false)
    setError('')
    try {
      const result = await run()
      if (result.ok) setDone(true)
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
      setError(describeFailure(502, failure, ''))
    } finally {
      setBusy(false)
    }
  }
  return { busy, done, error, start }
}

/** One way of connecting: what it is, one line about it, and its button. */
function ConnectRow({
  icon,
  title,
  note,
  dim,
  action,
}: {
  icon: typeof AppWindow
  title: string
  note: string
  dim?: boolean
  action?: ReactNode
}) {
  return <SettingsRow leading={<IconTile icon={icon} />} title={title} description={note} dim={dim} trailing={action} />
}

/** What a shell action left: its line while it holds, or its failure. */
function ActionLine({ done, text, error }: { done: boolean; text: string; error: string }) {
  if (error)
    return (
      <InlineNotice tone="error" secure>
        {error}
      </InlineNotice>
    )
  if (!done) return null
  return (
    <p className="device-connect-said" role="status">
      <Icon icon={Link} size={14} />
      <span>{text}</span>
    </p>
  )
}

/**
 * 连接新设备, on the Latch app on this Mac with 管理 only, listing only the ways that work in this build: this Mac's
 * browser (the app opens it with a one-time link in the fragment), another computer while the Host has an HTTPS entry
 * and the app can copy its link, and the phone as one line (no installable iPhone app yet; the QR stays reachable for one
 * built from source). Devices waiting to be let in follow while the pairing sheet is closed. Elsewhere this is one line
 * saying where new devices are connected.
 */
export function ConnectNew({
  local,
  computer,
  openInBrowser,
  copyLink,
  pairing,
  onPair,
}: {
  /** The Latch app on this Mac, with 管理. */
  local: boolean
  computer: string
  openInBrowser: ShellAction | undefined
  copyLink: ShellAction | undefined
  pairing: boolean
  onPair: () => void
}) {
  if (!local)
    return (
      <SettingsGroup title={COPY.connectTitle}>
        <SettingsRow
          title={
            <span className="device-pair-elsewhere">
              <Icon icon={LockGlyph} size={12} />
              {COPY.pairElsewhere(computer)}
            </span>
          }
        />
      </SettingsGroup>
    )
  return (
    <SettingsGroup title={COPY.connectTitle} secure bare>
      <ConnectRows openInBrowser={openInBrowser} copyLink={copyLink} onPair={onPair} />
      {!pairing && <WaitingDevices place="page" />}
    </SettingsGroup>
  )
}

function ConnectRows({
  openInBrowser,
  copyLink,
  onPair,
}: {
  openInBrowser: ShellAction | undefined
  copyLink: ShellAction | undefined
  onPair: () => void
}) {
  const browser = useShellAction(openInBrowser ?? missing, 'browser-open-failed', OPENED_NOTE_MS)
  const link = useShellAction(copyLink ?? missing, 'copy-link-failed', COPIED_NOTE_MS)
  return (
    <>
      <div className="settings-card">
        {openInBrowser && (
          <ConnectRow
            icon={AppWindow}
            title={COPY.thisBrowser}
            note={COPY.thisBrowserNote}
            action={
              <Button
                loading={browser.busy}
                onClick={() => {
                  void browser.start()
                }}>
                {COPY.browser}
              </Button>
            }
          />
        )}
        {copyLink && (
          <ConnectRow
            icon={LaptopGlyph}
            title={COPY.otherComputer}
            note={COPY.otherComputerNote}
            action={
              <Button
                icon={Link}
                loading={link.busy}
                onClick={() => {
                  void link.start()
                }}>
                {COPY.copyLink}
              </Button>
            }
          />
        )}
        <ConnectRow
          icon={PhoneGlyph}
          title={COPY.phone}
          note={COPY.phoneNote}
          dim
          action={
            <Button variant="ghost" icon={QrCode} className="device-connect" onClick={onPair}>
              {COPY.phoneQr}
            </Button>
          }
        />
      </div>
      <ActionLine done={browser.done} text={COPY.browserOpened} error={browser.error} />
      <ActionLine done={link.done} text={COPY.linkCopied} error={link.error} />
    </>
  )
}

function readRelayProfile(text: string): NativeRelayProfile {
  const file = JSON.parse(text) as { version?: unknown; profile?: Partial<NativeRelayProfile> } | null
  const profile = file?.profile
  if (
    file?.version !== 1
    || typeof profile?.url !== 'string'
    || profile.url.length > 512
    || typeof profile.relayId !== 'string'
    || !/^[a-f0-9]{32}$/u.test(profile.relayId)
    || typeof profile.spkiHash !== 'string'
    || !/^[a-f0-9]{64}$/u.test(profile.spkiHash)
    || (profile.registrationKey !== undefined
      && (typeof profile.registrationKey !== 'string' || !/^lrt1\.[A-Za-z0-9_-]{43}$/u.test(profile.registrationKey)))
  )
    throw new Error('Invalid relay profile')
  const url = new URL(profile.url)
  if (url.protocol !== 'https:' || url.username || url.password || profile.url !== `${url.origin}/`) throw new Error('Invalid relay origin')
  return {
    url: profile.url,
    relayId: profile.relayId,
    spkiHash: profile.spkiHash,
    ...(profile.registrationKey === undefined ? {} : { registrationKey: profile.registrationKey }),
  }
}

const RELAY_STATUS = { connecting: '正在连接', connected: '已连接', waiting: '等待重连', attention: '需要检查' } as const

function SavedRoutes() {
  const file = useRef<HTMLInputElement>(null)
  const [info, setInfo] = useState<NativeLinkInfo | null>(null)
  const [candidate, setCandidate] = useState<{ requestId: string; profile: NativeRelayProfile } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (busy) return
    const controller = new AbortController()
    let reading = false
    const load = async () => {
      if (reading) return
      reading = true
      try {
        const value = await api<NativeLinkInfo>('native/info', { signal: controller.signal })
        if (!controller.signal.aborted) setInfo(value)
      } catch {
        // The main settings connection owns connection feedback.
      } finally {
        reading = false
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 5000)
    return () => {
      window.clearInterval(timer)
      controller.abort()
    }
  }, [busy])
  const run = async (operation: () => Promise<NativeLinkInfo>, added = false) => {
    setBusy(true)
    setError('')
    try {
      setInfo(await operation())
      if (added) setCandidate(null)
    } catch (cause) {
      setError(inlineError(cause))
    } finally {
      setBusy(false)
    }
  }
  const remove = (path: string) => void run(() => api<NativeLinkInfo>(path, { method: 'DELETE' }))
  const add = (body: { requestId: string; profile?: NativeRelayProfile }) =>
    void run(
      () =>
        withConfirmation(confirmation =>
          api<NativeLinkInfo>('native/relays', { method: 'POST', body, ...(confirmation ? { confirmation } : {}) }),
        ),
      true,
    )
  const pending = info?.pendingRelay
  return (
    <div className="settings-card device-saved-list" data-secure="">
      <input
        ref={file}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={event => {
          const chosen = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (!chosen || busy) return
          setError('')
          setCandidate(null)
          if (chosen.size > 4096) {
            setError('这个文件不是中继 CLI 导出的连接配置。')
            return
          }
          setBusy(true)
          void chosen
            .text()
            .then(text => {
              setCandidate({ requestId: crypto.randomUUID(), profile: readRelayProfile(text) })
            })
            .catch(() => {
              setError('这个文件不是中继 CLI 导出的连接配置。')
            })
            .finally(() => setBusy(false))
        }}
      />
      <div className="device-saved">
        <span className="device-saved-text">
          <b>自建中继</b>
          <span>导入中继 CLI 导出的连接配置</span>
        </span>
        <Button disabled={busy || info === null || Boolean(pending)} onClick={() => file.current?.click()}>
          导入配置
        </Button>
      </div>
      {candidate && !pending && (
        <div className="device-saved">
          <span className="device-saved-text">
            <b>添加中继</b>
            <span title={candidate.profile.url}>{candidate.profile.url}</span>
          </span>
          <Button disabled={busy} onClick={() => setCandidate(null)}>
            取消
          </Button>
          <Button loading={busy} onClick={() => add(candidate)}>
            验证并添加
          </Button>
        </div>
      )}
      {pending && (
        <div className="device-saved">
          <span className="device-saved-text">
            <b>添加结果待确认</b>
            <span title={pending.url}>{pending.url}</span>
          </span>
          <Button
            disabled={busy}
            onClick={() => {
              setCandidate(null)
              remove(`native/relay-requests/${pending.requestId}`)
            }}>
            放弃
          </Button>
          {pending.canRetry && (
            <Button loading={busy} onClick={() => add({ requestId: pending.requestId })}>
              继续验证
            </Button>
          )}
        </div>
      )}
      {info?.relays.map(relay => (
        <div key={relay.relayId} className="device-saved">
          <span className="device-saved-text">
            <b>{COPY.savedRelay}</b>
            <span title={relay.url}>{relay.url}</span>
            <span>{RELAY_STATUS[relay.status]}</span>
          </span>
          <Button
            disabled={busy}
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
            disabled={busy}
            onClick={() => {
              remove('native/directory')
            }}>
            {COPY.remove}
          </Button>
        </div>
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
 * 关于连接, what the rows above do not say: that another computer cannot connect yet (and why, behind ⓘ) and that the
 * phone connects end to end encrypted. Self-hosted relays and any earlier address directory are managed on this Mac.
 */
export function AboutConnection({ entry, canManageRoutes }: { entry: boolean; canManageRoutes: boolean }) {
  return (
    <SettingsGroup title={COPY.about} bare>
      {!entry && <NoteLine brief={COPY.aboutOtherComputerMissing} icon={LaptopGlyph} />}
      <NoteLine brief={COPY.aboutPhone} icon={LockGlyph} />
      {canManageRoutes && <SavedRoutes />}
    </SettingsGroup>
  )
}
