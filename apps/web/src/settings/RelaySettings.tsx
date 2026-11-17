import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { Cloud, FileUp, Radio, Server } from 'lucide-react'
import type { NativeLinkInfo, NativeRelayProfile, NativeRelayTest } from '@latch/protocol'
import {
  ActionMenu,
  Button,
  Checkbox,
  CopyButton,
  Dialog,
  Icon,
  InlineNotice,
  MoreGlyph,
  IconButton,
  SegmentedControl,
  StatusWord,
  Switch,
  TextField,
  Tooltip,
  type IconComponent,
  type StatusTone,
} from '@latch/ui'
import { api, inlineError, isUncertain } from '../core/api.ts'
import { useInlineConfirmation, withConfirmation } from '../core/confirmations.ts'
import { CONFIRMATION_COPY } from '../core/securityCopy.ts'
import { ConfirmationContent } from '../components/InlineConfirm.tsx'
import { TerminalFillButton } from '../components/TerminalFillButton.tsx'
import type { DeviceAccess } from '../core/permissions.ts'
import { IconTile, SettingsGroup, SettingsRow } from './common.tsx'
import { relaySetupCommands } from './relayCommands.ts'

/**
 * A relay file: version 1 is a self-hosted node exported by the relay CLI (pinned TLS key); version 2 is an edge node
 * exported by apps/relay-edge (relay key and its origins). Either may carry a registration key, which this page sends to
 * this Mac's Host and never shows.
 */
export function readRelayProfile(text: string): NativeRelayProfile {
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
export async function relayKeyHash(profile: NativeRelayProfile): Promise<string> {
  if (!('relayKey' in profile)) return profile.spkiHash.slice(0, 8)
  const bytes = Uint8Array.from(profile.relayKey.match(/../gu)!, byte => Number.parseInt(byte, 16))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest.slice(0, 4), byte => byte.toString(16).padStart(2, '0')).join('')
}

const KIND: Record<'self' | 'edge', { label: string; icon: IconComponent }> = {
  edge: { label: 'Cloudflare Workers', icon: Cloud },
  self: { label: 'Linux 服务器', icon: Server },
}
const REGION: Record<string, string> = { 'apac-ne': '东京', 'apac-se': '新加坡' }
const hostOf = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
const at = (time: number | undefined) => (time === undefined ? '' : new Date(time).toLocaleString())

type Relay = NativeLinkInfo['relays'][number]
/** A relay's state: a few words in the tone they mean, the detail in the hover. */
function relayState(relay: Relay): { tone: StatusTone; word: string; detail?: string } {
  switch (relay.status) {
    case 'connected':
      return {
        tone: 'done',
        word: relay.latencyMs === undefined ? '已连接' : `已连接 · ${relay.latencyMs} ms`,
        ...(relay.connectedAt === undefined ? {} : { detail: `连上于 ${at(relay.connectedAt)}` }),
      }
    case 'mismatch':
      return { tone: 'failed', word: '密钥不符', detail: '中继给出的密钥与文件里的不一致' }
    case 'refused':
      return { tone: 'failed', word: '登记被拒绝', detail: '注册令牌不对，或中继已满' }
    case 'waiting':
      return { tone: 'warn', word: '连不上', ...(relay.retryAt === undefined ? {} : { detail: `下次重试 ${at(relay.retryAt)}` }) }
    case 'attention':
      return { tone: 'warn', word: '需要检查', detail: '同一天两次路由冲突' }
    case 'disabled':
      return { tone: 'neutral', word: '已停用' }
    default:
      return { tone: 'running', word: '连接中' }
  }
}

/** 连上 / 密钥相符 / 注册 / 手机已拿到, each done, failed or still to come. */
export function RelaySteps({ test, busy = false }: { test: NativeRelayTest | null; busy?: boolean }) {
  const reached = test ? ['none', 'identity', 'registered'].indexOf(test.reached) : -1
  const failedAt = !test?.failure ? -1 : test.failure === 'refused' ? 2 : test.failure === 'mismatch' ? 1 : 0
  const steps: Array<[string, boolean, boolean]> = [
    [test?.latencyMs === undefined ? '连上' : `连上 ${test.latencyMs} ms`, reached >= 1, failedAt === 0],
    ['密钥相符', reached >= 1, failedAt === 1],
    ['注册', reached >= 2, failedAt === 2],
    ['手机已拿到', test?.deliveredAt !== undefined, false],
  ]
  const first = steps.findIndex(([, done, failed]) => !done && !failed)
  return (
    <span className="relay-steps" role="status">
      {steps.map(([label, done, failed], index) => (
        <StatusWord key={label} tone={failed ? 'failed' : done ? 'done' : busy && index === first ? 'running' : 'neutral'}>
          {label}
        </StatusWord>
      ))}
    </span>
  )
}

const FAILURE = {
  'native-relay-key-mismatch': 'mismatch',
  'native-relay-registration-refused': 'refused',
  'native-relay-unconfirmed': 'unreachable',
} as const

/**
 * 设置 › 中继: whether phones reach this Mac directly, then each relay of the person's own (and the official one, once the
 * compiled list has nodes) with its state and a ⋯ menu, and 添加中继. Only this Mac's local administrator changes anything;
 * other admin devices read the list.
 */
export function RelaySettings({ access }: { access: DeviceAccess }) {
  const manage = access.admin && access.local
  const [info, setInfo] = useState<NativeLinkInfo | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [tests, setTests] = useState<Record<string, { test: NativeRelayTest | null; busy: boolean }>>({})
  const reload = async (signal?: AbortSignal) => {
    try {
      const value = await api<NativeLinkInfo>('native/info', signal ? { signal } : {})
      if (!signal?.aborted) setInfo(value)
    } catch {
      // The main settings connection owns connection feedback.
    }
  }
  useEffect(() => {
    const controller = new AbortController()
    void reload(controller.signal)
    const timer = window.setInterval(() => void reload(controller.signal), 5000)
    return () => {
      window.clearInterval(timer)
      controller.abort()
    }
  }, [])
  const run = async (operation: () => Promise<NativeLinkInfo>) => {
    setBusy(true)
    setError('')
    try {
      setInfo(await operation())
    } catch (cause) {
      setError(inlineError(cause))
    } finally {
      setBusy(false)
    }
  }
  const test = async (relayId: string) => {
    setTests(current => ({ ...current, [relayId]: { test: null, busy: true } }))
    try {
      const result = await api<NativeRelayTest>(`native/relays/${relayId}/test`, { method: 'POST', body: {} })
      setTests(current => ({ ...current, [relayId]: { test: result, busy: false } }))
    } catch (cause) {
      setTests(current => ({ ...current, [relayId]: { test: { reached: 'none', failure: 'unreachable' }, busy: false } }))
      setError(inlineError(cause))
    }
  }
  if (!info) return null
  const official = info.official
  const direct = info.listening
  return (
    <>
      <SettingsGroup>
        <SettingsRow
          leading={<IconTile icon={Radio} />}
          title="直连"
          record
          trailing={
            <Tooltip
              content={direct ? `同一网络的手机直接连 ${direct.host}:${direct.port}，不经过中继` : '这台 Mac 现在没有等待手机的局域网入口'}>
              <span data-testid="relay-direct">
                <StatusWord tone={direct ? 'done' : 'neutral'}>{direct ? '可用' : '未开启'}</StatusWord>
              </span>
            </Tooltip>
          }
        />
        {official?.deployed && (
          <SettingsRow
            leading={<IconTile icon={Cloud} />}
            title="官方中继"
            record
            description={official.enabled ? official.nodes.map(node => `${REGION[node.region] ?? node.region}`).join(' · ') : '已关闭'}
            trailing={
              <Switch
                label="官方中继"
                checked={official.enabled}
                disabled={!manage || busy}
                onCheckedChange={enabled => void run(() => api('native/official-relay', { method: 'PUT', body: { enabled } }))}
              />
            }
          />
        )}
        {official?.deployed && official.enabled && info.relays.length > 0 && (
          <SettingsRow
            title="优先使用"
            trailing={
              <SegmentedControl
                label="优先使用"
                value={official.ownFirst ? 'own' : 'official'}
                disabled={!manage || busy}
                options={[
                  { value: 'official', label: '官方' },
                  { value: 'own', label: '自己的' },
                ]}
                onValueChange={value =>
                  void run(() => api('native/official-relay', { method: 'PUT', body: { ownFirst: value === 'own' } }))
                }
              />
            }
          />
        )}
        {info.relays.map(relay => {
          const state = relayState(relay)
          const kind = KIND[relay.kind ?? 'self']
          const shown = tests[relay.relayId]
          return (
            <div key={relay.relayId} className="relay-row" data-testid="relay-own">
              <SettingsRow
                leading={<IconTile icon={kind.icon} />}
                title={kind.label}
                record
                dim={relay.status === 'disabled'}
                description={
                  <Tooltip
                    content={`${relay.url}${relay.addresses && relay.addresses > 1 ? ` 等 ${relay.addresses} 个地址` : ''} · 密钥 ${relay.keyHash ?? ''}`}>
                    <span>{hostOf(relay.url)}</span>
                  </Tooltip>
                }
                trailing={
                  <span className="relay-row-end">
                    <Tooltip content={state.detail}>
                      <span>
                        <StatusWord tone={state.tone}>{state.word}</StatusWord>
                      </span>
                    </Tooltip>
                    {manage ? (
                      <ActionMenu
                        label={`${kind.label} 的操作`}
                        placement="bottom-end"
                        trigger={props => <IconButton {...props} size="sm" icon={MoreGlyph} label="更多" />}
                        sections={[
                          {
                            id: 'relay',
                            items: [
                              { id: 'test', label: '测试', onSelect: () => void test(relay.relayId) },
                              {
                                id: 'toggle',
                                label: relay.status === 'disabled' ? '启用' : '停用',
                                onSelect: () =>
                                  void run(() =>
                                    api(`native/relays/${relay.relayId}`, {
                                      method: 'PATCH',
                                      body: { disabled: relay.status !== 'disabled' },
                                    }),
                                  ),
                              },
                              {
                                id: 'remove',
                                label: '移除',
                                danger: true,
                                onSelect: () => void run(() => api(`native/relays/${relay.relayId}`, { method: 'DELETE' })),
                              },
                            ],
                          },
                        ]}
                      />
                    ) : null}
                  </span>
                }
              />
              {shown && (
                <div className="relay-row-test">
                  <RelaySteps
                    test={shown.test ? { ...shown.test, ...(relay.deliveredAt ? { deliveredAt: relay.deliveredAt } : {}) } : null}
                    busy={shown.busy}
                  />
                </div>
              )}
            </div>
          )
        })}
        {info.pendingRelay && manage && (
          <SettingsRow
            title="添加结果待确认"
            description={hostOf(info.pendingRelay.url)}
            trailing={
              <span className="relay-row-end">
                <Button
                  disabled={busy}
                  onClick={() => void run(() => api(`native/relay-requests/${info.pendingRelay!.requestId}`, { method: 'DELETE' }))}>
                  放弃
                </Button>
                {info.pendingRelay.canRetry && (
                  <Button onClick={() => setAdding(true)} disabled={busy}>
                    重试
                  </Button>
                )}
              </span>
            }
          />
        )}
        {info.directory && (
          <SettingsRow
            title="已保存的地址目录"
            trailing={
              manage ? (
                <Button disabled={busy} onClick={() => void run(() => api('native/directory', { method: 'DELETE' }))}>
                  移除
                </Button>
              ) : undefined
            }
          />
        )}
      </SettingsGroup>
      {manage && (
        <div className="relay-add">
          <Button variant="primary" onClick={() => setAdding(true)} disabled={busy}>
            添加中继
          </Button>
        </div>
      )}
      {error && (
        <InlineNotice tone="error" secure>
          {error}
        </InlineNotice>
      )}
      {manage && (
        <AddRelay
          open={adding}
          sourceCheckout={info.sourceCheckout === true}
          pending={info.pendingRelay?.canRetry ? info.pendingRelay.requestId : undefined}
          delivered={id => info.relays.find(relay => relay.relayId === id)?.deliveredAt}
          onClose={() => {
            setAdding(false)
            void reload()
          }}
          onInfo={setInfo}
        />
      )}
    </>
  )
}

type Way = 'edge' | 'self' | 'file'

/** One command the person runs: shown, copied, or typed in at the prompt of a Latch terminal on this Mac's desktop. */
function Command({ command }: { command: string }) {
  return (
    <span className="relay-command">
      <code>{command}</code>
      <span className="command-actions">
        <CopyButton text={command} label="复制命令" size="xs" />
        <TerminalFillButton command={command} detached />
      </span>
    </span>
  )
}

function Step({ index, title, children }: { index: number; title: string; children: ReactNode }) {
  return (
    <li className="relay-step">
      <span className="relay-step-index">{index}</span>
      <span className="relay-step-body">
        <b>{title}</b>
        {children}
      </span>
    </li>
  )
}

/**
 * 添加中继: choose how the relay runs, follow its three steps (log in, deploy, connect), or bring a relay file; then the
 * check card and 确认并连接, which asks for this Mac's local confirmation and shows the progress line.
 */
function AddRelay({
  open,
  sourceCheckout,
  pending,
  delivered,
  onClose,
  onInfo,
}: {
  open: boolean
  /** The Host runs from a source checkout, where the guided commands exist. */
  sourceCheckout: boolean
  /** A request whose result is unknown: 重试 continues it with the same request ID and no file. */
  pending: string | undefined
  delivered: (relayId: string) => number | undefined
  onClose: () => void
  onInfo: (info: NativeLinkInfo) => void
}) {
  const file = useRef<HTMLInputElement>(null)
  const [way, setWay] = useState<Way | null>(null)
  const [region, setRegion] = useState<'ne' | 'se'>('ne')
  const [loggedIn, setLoggedIn] = useState(false)
  const [server, setServer] = useState('')
  const [domain, setDomain] = useState('')
  const [candidate, setCandidate] = useState<{ requestId: string; profile: NativeRelayProfile; hash: string } | null>(null)
  const [rejected, setRejected] = useState(false)
  const [progress, setProgress] = useState<{
    requestId: string
    test: NativeRelayTest | null
    busy: boolean
    uncertain?: boolean
    relayId?: string
    message?: string
  } | null>(null)
  // The dialog replaces its children at the phone breakpoint, but the confirmation must stay with the request.
  const confirmationId = useId()
  const confirmation = useInlineConfirmation(confirmationId, open && progress?.busy === true, 2)
  const awaitingConfirmation = confirmation?.view.phase === 'waiting'
  const reset = () => {
    confirmation?.actions.dismiss()
    setWay(null)
    setCandidate(null)
    setRejected(false)
    setProgress(null)
    setLoggedIn(false)
  }
  const read = async (chosen: File | undefined) => {
    setRejected(false)
    setCandidate(null)
    setProgress(null)
    if (!chosen) return
    try {
      if (chosen.size > 4096) throw new Error('too large')
      const profile = readRelayProfile(await chosen.text())
      setCandidate({ requestId: crypto.randomUUID(), profile, hash: await relayKeyHash(profile) })
    } catch {
      setRejected(true)
    }
  }
  const connect = async ({ requestId, profile }: { requestId: string; profile?: NativeRelayProfile }) => {
    confirmation?.actions.dismiss()
    const body = { requestId, ...(profile ? { profile } : {}) }
    setProgress({ requestId, test: null, busy: true })
    try {
      const info = await withConfirmation(confirmation =>
        api<NativeLinkInfo>('native/relays', { method: 'POST', body, ...(confirmation ? { confirmation } : {}) }),
      )
      onInfo(info)
      const relayId = body.profile?.relayId ?? info.relays.at(-1)?.relayId
      const added = info.relays.find(relay => relay.relayId === relayId)
      setProgress({
        requestId,
        test: { reached: 'registered', ...(added?.deliveredAt ? { deliveredAt: added.deliveredAt } : {}) },
        busy: false,
        ...(relayId ? { relayId } : {}),
      })
    } catch (cause) {
      const code = (cause as { code?: string }).code as keyof typeof FAILURE | undefined
      const failure = code && code in FAILURE ? FAILURE[code] : undefined
      const uncertain = failure === undefined && isUncertain(cause)
      setProgress({
        requestId,
        test: failure ? { reached: failure === 'refused' ? 'identity' : 'none', failure } : null,
        busy: false,
        uncertain,
        message: uncertain ? '添加结果待确认' : inlineError(cause),
      })
    }
  }
  const drop = (event: DragEvent) => {
    event.preventDefault()
    void read(event.dataTransfer.files[0])
  }
  const relayId = progress?.relayId
  const shown = progress && relayId && delivered(relayId) ? { ...progress.test!, deliveredAt: delivered(relayId)! } : progress?.test
  const fileStep = (
    <div className="relay-drop" data-testid="relay-drop" onDragOver={event => event.preventDefault()} onDrop={drop}>
      <Icon icon={FileUp} size={16} />
      <span>拖入中继文件</span>
      <Button size="sm" onClick={() => file.current?.click()}>
        选择文件
      </Button>
      <input
        ref={file}
        type="file"
        accept=".json,application/json"
        hidden
        data-testid="relay-file"
        onChange={event => {
          const chosen = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          void read(chosen)
        }}
      />
    </div>
  )
  const commands = way === 'edge' || way === 'self' ? relaySetupCommands(way, { region, server, domain }) : undefined
  const steps =
    way === 'edge' && commands ? (
      <ol className="relay-steps-list">
        <Step index={1} title="登录">
          {commands.login.map(command => (
            <Command key={command} command={command} />
          ))}
          <Checkbox checked={loggedIn} onChange={event => setLoggedIn(event.currentTarget.checked)} label="已登录" />
        </Step>
        <Step index={2} title="部署">
          <SegmentedControl
            label="地区"
            value={region}
            options={[
              { value: 'ne', label: '东京' },
              { value: 'se', label: '新加坡' },
            ]}
            onValueChange={setRegion}
          />
          {commands.deploy.map(command => (
            <Command key={command} command={command} />
          ))}
        </Step>
        <Step index={3} title="连接">
          {fileStep}
        </Step>
      </ol>
    ) : way === 'self' && commands ? (
      <ol className="relay-steps-list">
        <Step index={1} title="登录">
          <TextField
            label="服务器"
            placeholder="user@server"
            value={server}
            onChange={event => setServer(event.currentTarget.value.trim())}
          />
          {commands.login.map(command => (
            <Command key={command} command={command} />
          ))}
        </Step>
        <Step index={2} title="部署">
          <TextField
            label="域名"
            placeholder="relay.example.com"
            value={domain}
            onChange={event => setDomain(event.currentTarget.value.trim().toLowerCase())}
          />
          {commands.deploy.map(command => (
            <Command key={command} command={command} />
          ))}
        </Step>
        <Step index={3} title="连接">
          {commands.fetch.map(command => (
            <Command key={command} command={command} />
          ))}
          {fileStep}
        </Step>
      </ol>
    ) : way === 'file' ? (
      fileStep
    ) : null
  return (
    <Dialog
      open={open}
      size="lg"
      secure
      className="relay-add-dialog"
      title={way === null ? '添加中继' : way === 'file' ? '已有中继文件' : KIND[way].label}
      onClose={() => {
        if (awaitingConfirmation) confirmation.actions.cancel()
        if (!progress?.busy && !progress?.uncertain) reset()
        onClose()
      }}
      footer={
        way !== null && !progress?.relayId ? (
          <Button onClick={reset} disabled={progress?.busy || progress?.uncertain}>
            返回
          </Button>
        ) : progress?.relayId ? (
          <Button
            variant="primary"
            onClick={() => {
              reset()
              onClose()
            }}>
            完成
          </Button>
        ) : undefined
      }>
      {pending && way === null && !progress && (
        <div className="relay-check">
          <b>上次的添加结果待确认</b>
          <Button variant="primary" onClick={() => void connect({ requestId: pending })}>
            重试
          </Button>
        </div>
      )}
      {way === null && !progress && (
        <div className="relay-ways" data-testid="relay-ways">
          {(['edge', 'self', 'file'] as const).map(option => {
            // The guided steps run this checkout's commands; an installed app has none yet, so only a file works there.
            const missing = option !== 'file' && !sourceCheckout
            const row = (
              <button
                key={option}
                type="button"
                className="relay-way"
                aria-disabled={missing || undefined}
                onClick={() => {
                  if (!missing) setWay(option)
                }}>
                <IconTile icon={option === 'file' ? FileUp : KIND[option].icon} />
                <span>{option === 'file' ? '已有中继文件' : KIND[option].label}</span>
                {missing && <StatusWord>尚未实现</StatusWord>}
              </button>
            )
            return missing ? (
              <Tooltip key={option} content="引导部署需要 Latch 的命令行工具，安装版还没有提供；部署好后用「已有中继文件」添加">
                {row}
              </Tooltip>
            ) : (
              row
            )
          })}
        </div>
      )}
      {!candidate && steps}
      {rejected && (
        <InlineNotice tone="error" secure>
          这个文件不是中继导出的连接配置。
        </InlineNotice>
      )}
      {candidate && (
        <div className="relay-check" data-testid="relay-candidate">
          <SettingsRow
            leading={<IconTile icon={KIND['kind' in candidate.profile ? 'edge' : 'self'].icon} />}
            title={KIND['kind' in candidate.profile ? 'edge' : 'self'].label}
            record
          />
          <dl className="relay-facts">
            <dt>地址</dt>
            <dd>
              {[candidate.profile.url, ...('extraUrls' in candidate.profile ? (candidate.profile.extraUrls ?? []) : [])].map(url => (
                <span key={url}>{hostOf(url)}</span>
              ))}
            </dd>
            <dt>密钥</dt>
            <dd>
              <Tooltip content={'relayKey' in candidate.profile ? candidate.profile.relayKey : candidate.profile.spkiHash}>
                <span>{candidate.hash}</span>
              </Tooltip>
            </dd>
            <dt>注册令牌</dt>
            <dd>{candidate.profile.registrationKey ? '已包含' : '无'}</dd>
          </dl>
          {progress ? (
            <>
              <RelaySteps test={shown ?? null} busy={progress.busy && !awaitingConfirmation} />
              {progress.message && (
                <InlineNotice tone={progress.uncertain ? 'warn' : 'error'} secure>
                  {progress.message}
                </InlineNotice>
              )}
              {!progress.busy && !progress.relayId && (
                <Button variant="primary" onClick={() => void connect(candidate)}>
                  重试
                </Button>
              )}
            </>
          ) : (
            <Button variant="primary" onClick={() => void connect(candidate)}>
              确认并连接
            </Button>
          )}
        </div>
      )}
      {!candidate && progress && (
        <div className="relay-check">
          <RelaySteps test={shown ?? null} busy={progress.busy && !awaitingConfirmation} />
          {progress.message && (
            <InlineNotice tone={progress.uncertain ? 'warn' : 'error'} secure>
              {progress.message}
            </InlineNotice>
          )}
          {!progress.busy && !progress.relayId && (
            <Button variant="primary" onClick={() => void connect({ requestId: progress.requestId })}>
              重试
            </Button>
          )}
        </div>
      )}
      {confirmation && (
        <div className="inline-confirm" data-secure="">
          {awaitingConfirmation && (
            <InlineNotice tone="warn" secure>
              {CONFIRMATION_COPY.waiting}
            </InlineNotice>
          )}
          <ConfirmationContent view={confirmation.view} actions={confirmation.actions} />
        </div>
      )}
    </Dialog>
  )
}
