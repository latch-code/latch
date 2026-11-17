import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AppWindow, Link, QrCode } from 'lucide-react'
import type { NativeLinkInfo, NativeRelayProfile } from '@latch/protocol'
import { Button, Icon, InlineNotice, LaptopGlyph, LockGlyph, PhoneGlyph, SegmentedControl, Switch, Tooltip } from '@latch/ui'
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

/**
 * A relay file: version 1 is a self-hosted node exported by the relay CLI (pinned TLS key); version 2 is an edge node
 * exported by apps/relay-edge (relay key and its origins). Either may carry a registration key, which this page sends to
 * this Mac's Host and never shows.
 */
function readRelayProfile(text: string): NativeRelayProfile {
  const file = JSON.parse(text) as { version?: unknown; profile?: Record<string, unknown> } | null
  const profile = file?.profile
  const origin = (value: unknown) => {
    if (typeof value !== 'string' || value.length > 512) throw new Error('Invalid relay origin')
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || value !== `${url.origin}/`) throw new Error('Invalid relay origin')
    return value
  }
  const hex = (value: unknown, size: number) => {
    if (typeof value !== 'string' || !new RegExp(`^[a-f0-9]{${size}}$`, 'u').test(value)) throw new Error('Invalid relay profile')
    return value
  }
  const registration = profile?.registrationKey
  if (!profile || (registration !== undefined && (typeof registration !== 'string' || !/^lrt1\.[A-Za-z0-9_-]{43}$/u.test(registration))))
    throw new Error('Invalid relay profile')
  const shared = { url: origin(profile.url), relayId: hex(profile.relayId, 32) }
  const key = registration === undefined ? {} : { registrationKey: registration as string }
  if (file?.version === 1) return { ...shared, spkiHash: hex(profile.spkiHash, 64), ...key }
  if (file?.version !== 2 || profile.kind !== 'edge') throw new Error('Invalid relay profile')
  const extra = profile.extraUrls
  if (extra !== undefined && (!Array.isArray(extra) || extra.length < 1 || extra.length > 3)) throw new Error('Invalid relay profile')
  const shard = profile.shard
  if (shard !== undefined && (!Number.isInteger(shard) || (shard as number) < 0 || (shard as number) > 15))
    throw new Error('Invalid relay profile')
  return {
    ...shared,
    kind: 'edge',
    relayKey: hex(profile.relayKey, 64),
    ...(extra ? { extraUrls: (extra as unknown[]).map(origin) } : {}),
    ...(shard === undefined ? {} : { shard: shard as number }),
    ...key,
  }
}

/** The short key hash the Mac's confirmation sheet shows (Host `relayKeyHash`): compare the two before approving. */
async function relayKeyHash(profile: NativeRelayProfile): Promise<string> {
  if (!('relayKey' in profile)) return profile.spkiHash.slice(0, 8)
  const bytes = Uint8Array.from(profile.relayKey.match(/../gu)!, byte => Number.parseInt(byte, 16))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest.slice(0, 4), byte => byte.toString(16).padStart(2, '0')).join('')
}

const RELAY_STATUS = {
  connecting: '正在连接',
  connected: '已连接',
  waiting: '无法连接',
  attention: '需要检查',
  refused: '登记被拒绝',
  off: '已关闭',
} as const
const RELAY_KIND = { self: '自建服务器', edge: 'Workers' } as const
const REGION: Record<string, string> = { 'apac-ne': '东京', 'apac-se': '新加坡' }
const hostOf = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
const since = (at: number | undefined) => (at === undefined ? undefined : `上次连接 ${new Date(at).toLocaleString()}`)

/**
 * 中继: the official relay (尚未部署, or a switch) and the person's own relays, with one order of preference. Changes are
 * this Mac's local administrator's; other devices see the state only.
 */
function SavedRoutes({ manage }: { manage: boolean }) {
  const file = useRef<HTMLInputElement>(null)
  const [info, setInfo] = useState<NativeLinkInfo | null>(null)
  const [candidate, setCandidate] = useState<{ requestId: string; profile: NativeRelayProfile; hash: string } | null>(null)
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
  const official = (body: { enabled?: boolean; ownFirst?: boolean }) =>
    void run(() => api<NativeLinkInfo>('native/official-relay', { method: 'PUT', body }))
  const add = (body: { requestId: string; profile?: NativeRelayProfile }) =>
    void run(
      () =>
        withConfirmation(confirmation =>
          api<NativeLinkInfo>('native/relays', { method: 'POST', body, ...(confirmation ? { confirmation } : {}) }),
        ),
      true,
    )
  if (!info) return null
  const pending = info.pendingRelay
  const deployed = info.official?.deployed ?? false
  const officialState = info.official?.nodes.map(node => `${REGION[node.region] ?? node.region} ${RELAY_STATUS[node.status]}`).join(' · ')
  return (
    <div className="settings-card device-saved-list" data-secure="" data-testid="relay-settings">
      <input
        ref={file}
        type="file"
        accept=".json,application/json"
        hidden
        data-testid="relay-file"
        onChange={event => {
          const chosen = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (!chosen || busy) return
          setError('')
          setCandidate(null)
          if (chosen.size > 4096) {
            setError('这个文件不是中继导出的连接配置。')
            return
          }
          setBusy(true)
          void chosen
            .text()
            .then(async text => {
              const profile = readRelayProfile(text)
              setCandidate({ requestId: crypto.randomUUID(), profile, hash: await relayKeyHash(profile) })
            })
            .catch(() => {
              setError('这个文件不是中继导出的连接配置。')
            })
            .finally(() => setBusy(false))
        }}
      />
      <div className="device-saved" data-testid="relay-official">
        <span className="device-saved-text">
          <b>官方中继</b>
          <Tooltip
            content={
              deployed
                ? 'Latch 提供，运行在 Cloudflare。看得到：IP、时间、流量大小，路由标识、哪条路由被接通、通行证字段。看不到：会话内容'
                : '官方中继还没有上线'
            }>
            <span>{!deployed ? '尚未部署' : info.official?.enabled ? officialState || '已开启' : '已关闭'}</span>
          </Tooltip>
        </span>
        {deployed && (
          <Switch
            label="官方中继"
            checked={info.official?.enabled ?? false}
            disabled={!manage || busy}
            onCheckedChange={enabled => official({ enabled })}
          />
        )}
      </div>
      {deployed && info.official?.enabled && info.relays.length > 0 && (
        <div className="device-saved">
          <span className="device-saved-text">
            <b>优先使用</b>
          </span>
          <SegmentedControl
            label="优先使用"
            value={info.official.ownFirst ? 'own' : 'official'}
            disabled={!manage || busy}
            options={[
              { value: 'official', label: '官方', title: '先试官方中继，再试自己的' },
              { value: 'own', label: '自己的', title: '先试自己的中继，再试官方' },
            ]}
            onValueChange={value => official({ ownFirst: value === 'own' })}
          />
        </div>
      )}
      {info.relays.map(relay => (
        <div key={relay.relayId} className="device-saved" data-testid="relay-own">
          <span className="device-saved-text">
            <b>{RELAY_KIND[relay.kind ?? 'self']}</b>
            <span title={relay.url}>{hostOf(relay.url)}</span>
            <Tooltip content={since(relay.connectedAt)}>
              <span>{RELAY_STATUS[relay.status]}</span>
            </Tooltip>
          </span>
          {manage && (
            <Button
              disabled={busy}
              onClick={() => {
                remove(`native/relays/${relay.relayId}`)
              }}>
              {COPY.remove}
            </Button>
          )}
        </div>
      ))}
      {manage && (
        <div className="device-saved">
          <span className="device-saved-text">
            <b>自己的中继</b>
          </span>
          <Button disabled={busy || Boolean(pending)} onClick={() => file.current?.click()}>
            添加自己的中继
          </Button>
        </div>
      )}
      {manage && candidate && !pending && (
        <div className="device-saved" data-testid="relay-candidate">
          <span className="device-saved-text">
            <b>{`添加中继 · ${RELAY_KIND['kind' in candidate.profile ? 'edge' : 'self']}`}</b>
            <span title={candidate.profile.url}>
              {[candidate.profile.url, ...('extraUrls' in candidate.profile ? (candidate.profile.extraUrls ?? []) : [])]
                .map(hostOf)
                .join('、')}
            </span>
            <Tooltip content={'relayKey' in candidate.profile ? candidate.profile.relayKey : candidate.profile.spkiHash}>
              <span>{`密钥 ${candidate.hash}`}</span>
            </Tooltip>
          </span>
          <Button disabled={busy} onClick={() => setCandidate(null)}>
            取消
          </Button>
          <Button loading={busy} onClick={() => add(candidate)}>
            验证并添加
          </Button>
        </div>
      )}
      {manage && pending && (
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
      {info.directory && (
        <div className="device-saved">
          <span className="device-saved-text">
            <b>{COPY.savedDirectory}</b>
          </span>
          {manage && (
            <Button
              disabled={busy}
              onClick={() => {
                remove('native/directory')
              }}>
              {COPY.remove}
            </Button>
          )}
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
      <SavedRoutes manage={canManageRoutes} />
    </SettingsGroup>
  )
}
