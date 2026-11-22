import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { Cloud, FileUp, Radio, Server } from 'lucide-react'
import {
  parseRelayFile,
  RELAY_FILE_BYTES,
  RELAY_LOCATIONS,
  type NativeLinkInfo,
  type NativeRelayFile,
  type NativeRelayProfile,
  type NativeRelayTest,
  type RelayLocation,
} from '@latch/protocol'
import {
  ActionMenu,
  Button,
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
  ValuePicker,
  type IconComponent,
  type MenuTriggerProps,
  type StatusTone,
} from '@latch/ui'
import { api, ApiError, inlineError, isUncertain } from '../core/api.ts'
import { useInlineConfirmation, withConfirmation } from '../core/confirmations.ts'
import { CONFIRMATION_COPY } from '../core/securityCopy.ts'
import { ConfirmationContent } from '../components/InlineConfirm.tsx'
import { TerminalFillButton } from '../components/TerminalFillButton.tsx'
import type { DeviceAccess } from '../core/permissions.ts'
import { IconTile, SettingsGroup, SettingsRow } from './common.tsx'
import { canOpenSystemSettings, LocalNetworkNote, LocalNetworkOpen } from './LocalNetworkHint.tsx'
import { RELAYS_DIR, relaySetupCommands, validRelayName } from './relayCommands.ts'
import { localLatchCommand } from '../core/commands.ts'
import { currentLocale, defineCopy, formatNumber, useLocale } from '../core/i18n.ts'
import { readHiddenRelayIds, setRelayHidden } from './relayVisibility.ts'

const COPY = defineCopy(
  {
    serverKind: '自己的服务器',
    tokyo: '东京',
    singapore: '新加坡',
    edgeUnavailable: '这台电脑上的 Latch 关闭了 Cloudflare Workers 转发服务。',
    connected: '已连接',
    keyMismatch: '密钥不符',
    differentKey: '转发服务的密钥与文件里的不一致',
    rejected: '注册被拒绝',
    rejectedReason: '注册令牌不对，或转发服务已满',
    unreachable: '连不上',
    needsAttention: '需要检查',
    routeConflict: '同一天两次路由冲突',
    turnedOff: '已停用',
    invalidAddress: '地址无效',
    invalidAddressReason: '地址不符合连接簿格式，手机无法使用；移除后用新的转发服务文件添加',
    unimplemented: '尚未实现',
    connecting: '连接中',
    testConnected: '连上',
    sameKey: '密钥相符',
    registration: '注册',
    bookSigning: '签发连接信息',
    signed: '这台 Mac 已签发',
    direct: '直接连接',
    directUnavailable: '首次连接手机时，在这台 Mac 的「设置 › 设备」里显示二维码。',
    listening: '已开启',
    off: '未开启',
    official: '官方转发服务',
    closed: '已关闭',
    preferred: '优先使用',
    officialKind: '官方',
    ownKind: '自己的',
    more: '更多',
    test: '测试',
    enable: '启用',
    disable: '停用',
    remove: '移除',
    removeRelay: '从这台 Mac 移除',
    relayFileReadFailed: '无法读取这台 Mac 上的转发服务文件。',
    readyToAdd: '未添加',
    hideRelay: '从列表隐藏',
    fileSaveFailed: '已连接，配置文件未能保存到 ~/.latch/relays。',
    removedAfterAdd: '本次添加已完成。该转发服务已从这台 Mac 移除。',
    unknown: '添加结果待确认',
    giveUp: '放弃',
    retry: '重试',
    savedAddresses: '已保存的地址目录',
    addRelay: '添加转发服务',
    copyCommand: '复制命令',
    dropFile: '等待配置文件',
    review: '核对并连接',
    name: '名称',
    nameRule: '小写字母、数字与连字符',
    location: '位置',
    automatic: '自动',
    locations: {
      apac: '亚太',
      'apac-ne': '亚太东北',
      'apac-se': '亚太东南',
      wnam: '北美西部',
      enam: '北美东部',
      sam: '南美',
      weur: '西欧',
      eeur: '东欧',
      oc: '大洋洲',
      afr: '非洲',
      me: '中东',
    },
    configure: '配置',
    port: '端口',
    certificate: '证书链',
    privateKey: '私钥',
    chooseFile: '选择文件',
    relaysFolderDetail:
      '这个文件夹里的配置会列在这里。选择文件时按 ⌘⇧G 可输入路径。共用 Workers 转发服务时，运营者私下分发 .json 配置，自己保管 .admin-header 管理文件。',
    logIn: '登录',
    deploy: '部署',
    connect: '连接',
    server: '服务器',
    deployFromServer: '在服务器上的 Latch 源码目录运行',
    domain: '服务器地址',
    existingFile: '已有配置文件',
    back: '返回',
    done: '完成',
    previousUnknown: '上次的添加结果待确认',
    serverBuildFile: '安装版尚未附带转发服务程序。部署后选择「已有配置文件」添加。',
    invalidFile: '请选择由转发服务导出的连接配置。',
    address: '地址',
    key: '密钥',
    registrationToken: '注册令牌',
    included: '已包含',
    none: '无',
    confirmConnect: '确认并连接',
    connectedLatency: (latency: number) => `已连接 · ${formatNumber(latency)} ms`,
    connectedAt: (time: string) => `连上于 ${time}`,
    retryAt: (time: string) => `下次重试 ${time}`,
    testLatency: (latency: number) => `连上 ${formatNumber(latency)} ms`,
    directAddress: (address: string) => `这台 Mac 正在 ${address} 等待同一网络的手机连接。`,
    relayAddresses: (address: string, count: number, key: string) =>
      `${address}${count > 1 ? ` 等 ${formatNumber(count)} 个地址` : ''} · 密钥 ${key}`,
    relayActions: (name: string) => `${name} 的操作`,
    edgeRelayUnavailable: 'Cloudflare Workers 转发服务尚未实现。',
  },
  {
    serverKind: 'Your own server',
    tokyo: 'Tokyo',
    singapore: 'Singapore',
    edgeUnavailable: 'Latch on this computer has Cloudflare Workers relays turned off.',
    connected: 'Connected',
    keyMismatch: 'Key mismatch',
    differentKey: 'The relay’s key does not match the key in the file',
    rejected: 'Registration refused',
    rejectedReason: 'The registration token is incorrect, or the relay is full',
    unreachable: 'Unreachable',
    needsAttention: 'Needs attention',
    routeConflict: 'Two route conflicts on the same day',
    turnedOff: 'Turned off',
    invalidAddress: 'Invalid address',
    invalidAddressReason: 'The address is outside the address-book format, so phones can’t use it; remove it and add a new relay file',
    unimplemented: 'Not implemented',
    connecting: 'Connecting',
    testConnected: 'Connected',
    sameKey: 'Key matched',
    registration: 'Registration',
    bookSigning: 'Sign connection details',
    signed: 'Signed on this Mac',
    direct: 'Direct connection',
    directUnavailable: 'For the first phone connection, show the QR code in Settings › Devices on this Mac.',
    listening: 'On',
    off: 'Off',
    official: 'Official relay',
    closed: 'Off',
    preferred: 'Preferred',
    officialKind: 'Official',
    ownKind: 'Self-hosted',
    more: 'More',
    test: 'Test',
    enable: 'Turn on',
    disable: 'Turn off',
    remove: 'Remove',
    removeRelay: 'Remove from this Mac',
    relayFileReadFailed: 'Couldn’t read relay files on this Mac.',
    readyToAdd: 'Not added',
    hideRelay: 'Hide from list',
    fileSaveFailed: 'Connected. The relay file couldn’t be saved to ~/.latch/relays.',
    removedAfterAdd: 'The add request completed. This relay has been removed from this Mac.',
    unknown: 'Relay setup hasn’t been confirmed',
    giveUp: 'Abandon',
    retry: 'Retry',
    savedAddresses: 'Saved address books',
    addRelay: 'Add relay',
    copyCommand: 'Copy command',
    dropFile: 'Waiting for a relay file',
    review: 'Review and connect',
    name: 'Name',
    nameRule: 'Lowercase letters, digits and hyphens',
    location: 'Location',
    automatic: 'Automatic',
    locations: {
      apac: 'Asia-Pacific',
      'apac-ne': 'Northeast Asia-Pacific',
      'apac-se': 'Southeast Asia-Pacific',
      wnam: 'Western North America',
      enam: 'Eastern North America',
      sam: 'South America',
      weur: 'Western Europe',
      eeur: 'Eastern Europe',
      oc: 'Oceania',
      afr: 'Africa',
      me: 'Middle East',
    },
    configure: 'Configure',
    port: 'Port',
    certificate: 'Certificate chain',
    privateKey: 'Private key',
    chooseFile: 'Choose file',
    relaysFolderDetail:
      'Files in this folder appear here. Press ⌘⇧G in the file picker to enter a path. To share a Workers relay, the operator privately distributes the .json profile and keeps the .admin-header management file.',
    logIn: 'Log in',
    deploy: 'Deploy',
    connect: 'Connect',
    server: 'Server',
    deployFromServer: 'Run from the Latch source folder on the server',
    domain: 'Domain',
    existingFile: 'Use a relay file',
    back: 'Back',
    done: 'Done',
    previousUnknown: 'Previous relay setup hasn’t been confirmed',
    serverBuildFile: 'The installer doesn’t include the relay server yet. Deploy the relay, then select “Use a relay file.”',
    invalidFile: 'This file isn’t a connection configuration exported by a relay.',
    address: 'Address',
    key: 'Key',
    registrationToken: 'Registration token',
    included: 'Included',
    none: 'None',
    confirmConnect: 'Confirm and connect',
    connectedLatency: (latency: number) => `Connected · ${formatNumber(latency)} ms`,
    connectedAt: (time: string) => `Connected ${time}`,
    retryAt: (time: string) => `Next retry ${time}`,
    testLatency: (latency: number) => `Connected in ${formatNumber(latency)} ms`,
    directAddress: (address: string) => `This Mac is listening at ${address} for phones on the same network.`,
    relayAddresses: (address: string, count: number, key: string) =>
      `${address}${count > 1 ? ` and ${formatNumber(count - 1)} more` : ''} · Key ${key}`,
    relayActions: (name: string) => `Actions for ${name}`,
    edgeRelayUnavailable: 'Cloudflare Workers relays aren’t supported yet.',
  },
)

/**
 * A relay file: version 1 is a self-hosted node exported by the relay CLI (pinned TLS key); version 2 is an edge node
 * exported by apps/relay-edge (relay key and its origins). Either may carry a registration key, which this page sends to
 * this Mac's Host and never shows.
 */
export function readRelayProfile(text: string): NativeRelayProfile {
  const read = parseRelayFile(text, URL)
  if ('profile' in read) return read.profile
  throw new Error('Invalid relay profile')
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
  self: {
    get label() {
      return COPY.serverKind
    },
    icon: Server,
  },
}
const regionName = (region: string) => (region === 'apac-ne' ? COPY.tokyo : region === 'apac-se' ? COPY.singapore : region)
const hostOf = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
const at = (time: number) => new Date(time).toLocaleString(currentLocale())

type Relay = NativeLinkInfo['relays'][number]
type AddedRelayInfo = NativeLinkInfo & { addedRelayId?: string; fileSaveFailed?: true }
type RelayCandidate = {
  requestId: string
  profile?: NativeRelayProfile
  file?: NativeRelayFile
  kind: 'self' | 'edge'
  urls: string[]
  hash: string
  fullKey?: string
  token: boolean
}
type RelayProgress = {
  requestId: string
  test: NativeRelayTest | null
  busy: boolean
  uncertain?: boolean
  completed?: boolean
  relayId?: string
  fileSaveFailed?: boolean
  message?: string
}

function fileCandidate(file: NativeRelayFile): RelayCandidate {
  return {
    requestId: crypto.randomUUID(),
    file,
    kind: file.kind,
    urls: file.urls,
    hash: file.keyHash,
    token: file.hasRegistrationKey,
  }
}

const relayMenuTrigger = (props: MenuTriggerProps) => <IconButton {...props} size="sm" icon={MoreGlyph} label={COPY.more} />

/** A relay's state: a few words in the tone they mean, the detail in the hover. */
function relayState(relay: Relay): { tone: StatusTone; word: string; detail?: string } {
  switch (relay.status) {
    case 'connected':
      return {
        tone: 'done',
        word: relay.latencyMs === undefined ? COPY.connected : COPY.connectedLatency(relay.latencyMs),
        ...(relay.connectedAt === undefined ? {} : { detail: COPY.connectedAt(at(relay.connectedAt)) }),
      }
    case 'mismatch':
      return { tone: 'failed', word: COPY.keyMismatch, detail: COPY.differentKey }
    case 'refused':
      return { tone: 'failed', word: COPY.rejected, detail: COPY.rejectedReason }
    case 'waiting':
      return { tone: 'warn', word: COPY.unreachable, ...(relay.retryAt === undefined ? {} : { detail: COPY.retryAt(at(relay.retryAt)) }) }
    case 'attention':
      return { tone: 'warn', word: COPY.needsAttention, detail: COPY.routeConflict }
    case 'disabled':
      return { tone: 'neutral', word: COPY.turnedOff }
    case 'unsupported':
      return { tone: 'neutral', word: COPY.unimplemented, detail: COPY.edgeUnavailable }
    case 'invalid':
      return { tone: 'failed', word: COPY.invalidAddress, detail: COPY.invalidAddressReason }
    default:
      return { tone: 'running', word: COPY.connecting }
  }
}

/** Only this Host's signing operation is represented by the last step. */
export function RelaySteps({ test, busy = false }: { test: NativeRelayTest | null; busy?: boolean }) {
  const reached = test ? ['none', 'identity', 'registered'].indexOf(test.reached) : -1
  const failedAt = !test?.failure ? -1 : test.failure === 'refused' ? 2 : test.failure === 'mismatch' ? 1 : 0
  const steps: Array<[string, boolean, boolean]> = [
    [test?.latencyMs === undefined ? COPY.testConnected : COPY.testLatency(test.latencyMs), reached >= 1, failedAt === 0],
    [COPY.sameKey, reached >= 1, failedAt === 1],
    [COPY.registration, reached >= 2, failedAt === 2],
    [test?.bookIssuedAt === undefined ? COPY.bookSigning : COPY.signed, test?.bookIssuedAt !== undefined, false],
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

const FAILURE: Partial<Record<string, NativeRelayTest['failure']>> = {
  'native-relay-key-mismatch': 'mismatch',
  'native-relay-registration-refused': 'refused',
  'native-relay-unconfirmed': 'unreachable',
}

/**
 * 设置 › 连接转发: whether phones reach this Mac directly, then each relay of the person's own (and the official one, once the
 * compiled list has nodes) with its state and a ⋯ menu, and 添加转发服务. Only this Mac's local administrator changes anything;
 * other admin devices read the list.
 */
export function RelaySettings({ access, hostId }: { access: DeviceAccess; hostId: string }) {
  useLocale()
  const manage = access.admin && access.local
  const [info, setInfo] = useState<NativeLinkInfo | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [files, setFiles] = useState<NativeRelayFile[]>([])
  const [filesError, setFilesError] = useState(false)
  const [candidate, setCandidate] = useState<RelayCandidate | null>(null)
  const [progress, setProgress] = useState<RelayProgress | null>(null)
  const [hidden, setHidden] = useState(() => readHiddenRelayIds(hostId))
  const [tests, setTests] = useState<Record<string, { test: NativeRelayTest | null; busy: boolean }>>({})
  const infoRead = useRef(0)
  const refresh = useRef<{ info: () => void; files: (force?: boolean) => void } | null>(null)
  const writing = useRef(false)
  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    let infoLoading = 0
    const loadInfo = async () => {
      const read = ++infoRead.current
      infoLoading++
      try {
        const value = await api<NativeLinkInfo>('native/info', { signal })
        if (!signal.aborted && read === infoRead.current) setInfo(value)
      } catch {
        // The main settings connection owns connection feedback.
      } finally {
        infoLoading--
      }
    }
    let filesRead = 0
    let filesLoading = 0
    const loadFiles = async () => {
      if (!manage) return
      const read = ++filesRead
      filesLoading++
      try {
        const value = await api<{ files: NativeRelayFile[] }>('native/relay-files', { signal })
        if (!signal.aborted && read === filesRead) {
          setFiles(value.files)
          setFilesError(false)
        }
      } catch (cause) {
        if (!signal.aborted && read === filesRead) {
          if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) setFiles([])
          setFilesError(true)
        }
      } finally {
        filesLoading--
      }
    }
    const updateVisibleFiles = () => {
      if (!document.hidden && !filesLoading) void loadFiles()
    }
    const updateVisibleInfo = () => {
      if (!document.hidden && !infoLoading) void loadInfo()
    }
    const updateVisible = () => {
      updateVisibleInfo()
      updateVisibleFiles()
    }
    refresh.current = {
      info: () => void loadInfo(),
      files: (force = true) => {
        if (force || !filesLoading) void loadFiles()
      },
    }
    void loadInfo()
    void loadFiles()
    const timer = window.setInterval(updateVisibleInfo, 5000)
    const filesTimer = manage ? window.setInterval(updateVisibleFiles, 30_000) : undefined
    window.addEventListener('focus', updateVisible)
    document.addEventListener('visibilitychange', updateVisible)
    return () => {
      window.clearInterval(timer)
      window.clearInterval(filesTimer)
      window.removeEventListener('focus', updateVisible)
      document.removeEventListener('visibilitychange', updateVisible)
      controller.abort()
      refresh.current = null
    }
  }, [manage])
  const watchingFiles = manage && adding && !candidate && !progress
  useEffect(() => {
    if (!watchingFiles) return
    const look = () => {
      if (!document.hidden) refresh.current?.files(false)
    }
    look()
    const timer = window.setInterval(look, 3000)
    return () => window.clearInterval(timer)
  }, [watchingFiles])
  const adoptInfo = (value: NativeLinkInfo) => {
    infoRead.current++
    setInfo(value)
    refresh.current?.files()
  }
  const hideRelay = (relayId: string, hide: boolean) => setHidden(setRelayHidden(hostId, relayId, hide))
  const run = async (operation: () => Promise<NativeLinkInfo>, after?: () => void) => {
    if (writing.current || progress?.busy) return
    writing.current = true
    setBusy(true)
    setError('')
    try {
      const value = await operation()
      after?.()
      adoptInfo(value)
    } catch (cause) {
      setError(inlineError(cause))
      refresh.current?.info()
      refresh.current?.files()
    } finally {
      writing.current = false
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
  const refusedAccess = info.localNetwork === 'denied' || info.localNetwork === 'unreadable'
  const openable = canOpenSystemSettings(access.local)
  const availableFiles = manage
    ? files.filter(
        found => (found.kind !== 'edge' || info.edgeRelayAvailable) && !info.relays.some(relay => relay.relayId === found.relayId),
      )
    : []
  const configuring = busy || progress?.busy === true
  const canReviewFile = !filesError && !configuring && !progress?.uncertain && !info.pendingRelay
  return (
    <>
      <SettingsGroup>
        <SettingsRow
          leading={<IconTile icon={Radio} />}
          title={COPY.direct}
          record
          description={direct && refusedAccess ? <LocalNetworkNote state={info.localNetwork} openable={openable} /> : undefined}
          trailing={
            direct && refusedAccess ? (
              <LocalNetworkOpen state={info.localNetwork} openable={openable} />
            ) : (
              <Tooltip content={direct ? COPY.directAddress(`${direct.host}:${direct.port}`) : COPY.directUnavailable}>
                <span data-testid="relay-direct">
                  <StatusWord tone="neutral">{direct ? COPY.listening : COPY.off}</StatusWord>
                </span>
              </Tooltip>
            )
          }
        />
        {official?.deployed && (
          <SettingsRow
            leading={<IconTile icon={Cloud} />}
            title={COPY.official}
            record
            description={official.enabled ? official.nodes.map(node => regionName(node.region)).join(' · ') : COPY.closed}
            trailing={
              <Switch
                label={COPY.official}
                checked={official.enabled}
                disabled={!manage || configuring}
                onCheckedChange={enabled => void run(() => api('native/official-relay', { method: 'PUT', body: { enabled } }))}
              />
            }
          />
        )}
        {official?.deployed && official.enabled && info.relays.length > 0 && (
          <SettingsRow
            title={COPY.preferred}
            trailing={
              <SegmentedControl
                label={COPY.preferred}
                value={official.ownFirst ? 'own' : 'official'}
                disabled={!manage || configuring}
                options={[
                  { value: 'official', label: COPY.officialKind },
                  { value: 'own', label: COPY.ownKind },
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
          const relayBusy = configuring || (shown?.busy ?? false)
          return (
            <div key={relay.relayId} className="relay-row" data-testid="relay-own">
              <SettingsRow
                leading={<IconTile icon={kind.icon} />}
                title={kind.label}
                record
                dim={relay.status === 'disabled'}
                description={
                  <Tooltip content={COPY.relayAddresses(relay.url, relay.addresses ?? 1, relay.keyHash ?? '')}>
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
                        label={COPY.relayActions(kind.label)}
                        placement="bottom-end"
                        trigger={relayMenuTrigger}
                        sections={[
                          {
                            id: 'relay',
                            items: [
                              ...(relay.status !== 'invalid' && (relay.kind !== 'edge' || info.edgeRelayAvailable)
                                ? [
                                    {
                                      id: 'test',
                                      label: COPY.test,
                                      disabled: relayBusy,
                                      onSelect: () => void test(relay.relayId),
                                    },
                                  ]
                                : []),
                              ...(relay.status !== 'invalid'
                              && (relay.kind !== 'edge' || info.edgeRelayAvailable || relay.status !== 'disabled')
                                ? [
                                    {
                                      id: 'toggle',
                                      label: relay.status === 'disabled' ? COPY.enable : COPY.disable,
                                      disabled: relayBusy,
                                      onSelect: () =>
                                        void run(() =>
                                          api(`native/relays/${relay.relayId}`, {
                                            method: 'PATCH',
                                            body: { disabled: relay.status !== 'disabled' },
                                          }),
                                        ),
                                    },
                                  ]
                                : []),
                              {
                                id: 'remove',
                                label: COPY.removeRelay,
                                danger: true,
                                disabled: relayBusy,
                                onSelect: () =>
                                  void run(
                                    () => api(`native/relays/${relay.relayId}`, { method: 'DELETE' }),
                                    () => {
                                      hideRelay(relay.relayId, true)
                                      setTests(current => {
                                        const next = { ...current }
                                        delete next[relay.relayId]
                                        return next
                                      })
                                    },
                                  ),
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
                  <RelaySteps test={shown.test ? { ...shown.test, bookIssuedAt: relay.bookIssuedAt } : null} busy={shown.busy} />
                </div>
              )}
            </div>
          )
        })}
        {availableFiles
          .filter(found => !hidden.has(found.relayId))
          .map(found => (
            <div key={found.relayId} className="relay-row" data-testid="relay-local-file">
              <SettingsRow
                className="relay-local-row"
                leading={<IconTile icon={KIND[found.kind].icon} />}
                title={found.name}
                record
                description={
                  <Tooltip content={COPY.relayAddresses(found.urls[0] ?? '', found.urls.length, found.keyHash)}>
                    <span>
                      {KIND[found.kind].label} · {hostOf(found.urls[0] ?? '')}
                    </span>
                  </Tooltip>
                }
                trailing={
                  <span className="relay-row-end">
                    <StatusWord tone="neutral">{COPY.readyToAdd}</StatusWord>
                    <Button
                      size="sm"
                      disabled={!canReviewFile}
                      onClick={() => {
                        setProgress(null)
                        setCandidate(fileCandidate(found))
                        setAdding(true)
                      }}>
                      {COPY.review}
                    </Button>
                    <ActionMenu
                      label={COPY.relayActions(found.name)}
                      placement="bottom-end"
                      trigger={relayMenuTrigger}
                      sections={[
                        {
                          id: 'visibility',
                          items: [{ id: 'hide', label: COPY.hideRelay, onSelect: () => hideRelay(found.relayId, true) }],
                        },
                      ]}
                    />
                  </span>
                }
              />
            </div>
          ))}
        {info.pendingRelay && manage && (
          <SettingsRow
            title={COPY.unknown}
            description={hostOf(info.pendingRelay.url)}
            trailing={
              <span className="relay-row-end">
                <Button
                  disabled={configuring}
                  onClick={() => {
                    const { requestId } = info.pendingRelay!
                    void run(
                      () => api(`native/relay-requests/${requestId}`, { method: 'DELETE' }),
                      () => {
                        if (progress?.requestId === requestId) {
                          setCandidate(null)
                          setProgress(null)
                        }
                      },
                    )
                  }}>
                  {COPY.giveUp}
                </Button>
                {info.pendingRelay.canRetry && (
                  <Button onClick={() => setAdding(true)} disabled={busy}>
                    {COPY.retry}
                  </Button>
                )}
              </span>
            }
          />
        )}
        {info.directory && (
          <SettingsRow
            title={COPY.savedAddresses}
            trailing={
              manage ? (
                <Button disabled={configuring} onClick={() => void run(() => api('native/directory', { method: 'DELETE' }))}>
                  {COPY.remove}
                </Button>
              ) : undefined
            }
          />
        )}
      </SettingsGroup>
      {manage && (
        <div className="relay-add">
          <Button variant="primary" onClick={() => setAdding(true)} disabled={busy}>
            {COPY.addRelay}
          </Button>
        </div>
      )}
      {manage && filesError && (
        <InlineNotice tone="warn" secure>
          {COPY.relayFileReadFailed}{' '}
          <Button size="xs" onClick={() => refresh.current?.files()}>
            {COPY.retry}
          </Button>
        </InlineNotice>
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
          edgeAvailable={info.edgeRelayAvailable === true}
          pending={info.pendingRelay?.canRetry ? info.pendingRelay.requestId : undefined}
          files={availableFiles}
          filesError={filesError}
          candidate={candidate}
          onCandidate={setCandidate}
          progress={progress}
          onProgress={setProgress}
          onCompleted={(relayId, configured) => hideRelay(relayId, !configured)}
          configuredRelay={id => info.relays.find(relay => relay.relayId === id)}
          onClose={() => {
            setAdding(false)
            refresh.current?.info()
            refresh.current?.files()
          }}
          onInfo={adoptInfo}
        />
      )}
    </>
  )
}

type Way = 'edge' | 'self' | 'file'

function Command({ command, copyOnly = false }: { command: string; copyOnly?: boolean }) {
  return (
    <span className="relay-command">
      <code>{command}</code>
      <span className="command-actions">
        <CopyButton text={command} label={COPY.copyCommand} size="xs" />
        {!copyOnly && <TerminalFillButton command={command} detached />}
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
 * 添加转发服务: choose how the relay runs, follow its three steps (log in, deploy, connect), or bring a relay file; then the
 * check card and 确认并连接, which asks for this Mac's local confirmation and shows the progress line.
 */
function AddRelay({
  open,
  sourceCheckout,
  edgeAvailable,
  pending,
  files,
  filesError,
  candidate,
  onCandidate: setCandidate,
  progress,
  onProgress: setProgress,
  onCompleted,
  configuredRelay,
  onClose,
  onInfo,
}: {
  open: boolean
  /** The Host runs from a source checkout, where the guided commands exist. */
  sourceCheckout: boolean
  edgeAvailable: boolean
  /** A request whose result is unknown: 重试 continues it with the same request ID and no file. */
  pending: string | undefined
  files: NativeRelayFile[]
  filesError: boolean
  candidate: RelayCandidate | null
  onCandidate: (candidate: RelayCandidate | null) => void
  progress: RelayProgress | null
  onProgress: (progress: RelayProgress | null) => void
  onCompleted: (relayId: string, configured: boolean) => void
  configuredRelay: (relayId: string) => Relay | undefined
  onClose: () => void
  onInfo: (info: NativeLinkInfo) => void
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [way, setWay] = useState<Way | null>(null)
  const [name, setName] = useState('relay')
  const [location, setLocation] = useState<RelayLocation | 'auto'>('auto')
  const [server, setServer] = useState('')
  const [domain, setDomain] = useState('')
  const [port, setPort] = useState('8443')
  const [cert, setCert] = useState('')
  const [key, setKey] = useState('')
  const [rejected, setRejected] = useState<'file' | 'edge' | null>(null)
  const reading = useRef(0)
  const connecting = useRef(false)
  // The dialog replaces its children at the phone breakpoint, but the confirmation must stay with the request.
  const confirmationId = useId()
  const confirmation = useInlineConfirmation(confirmationId, open && progress?.busy === true, 2)
  const awaitingConfirmation = confirmation?.view.phase === 'waiting'
  const reset = () => {
    reading.current++
    confirmation?.actions.dismiss()
    setWay(null)
    setCandidate(null)
    setRejected(null)
    setProgress(null)
  }
  const read = async (chosen: File | undefined) => {
    const attempt = ++reading.current
    setRejected(null)
    setCandidate(null)
    setProgress(null)
    if (!chosen) return
    try {
      if (chosen.size > RELAY_FILE_BYTES) throw new Error('too large')
      const profile = readRelayProfile(await chosen.text())
      if (attempt !== reading.current) return
      if ('kind' in profile && !edgeAvailable) {
        setRejected('edge')
        return
      }
      const hash = await relayKeyHash(profile)
      if (attempt !== reading.current) return
      setCandidate({
        requestId: crypto.randomUUID(),
        profile,
        kind: 'kind' in profile ? 'edge' : 'self',
        urls: [profile.url, ...('extraUrls' in profile ? (profile.extraUrls ?? []) : [])],
        hash,
        fullKey: 'relayKey' in profile ? profile.relayKey : profile.spkiHash,
        token: profile.registrationKey != null,
      })
    } catch {
      if (attempt === reading.current) setRejected('file')
    }
  }
  const connect = async ({ requestId, profile, file }: Pick<RelayCandidate, 'requestId' | 'profile' | 'file'>) => {
    if (connecting.current) return
    connecting.current = true
    confirmation?.actions.dismiss()
    const body = file
      ? {
          requestId,
          file: file.name,
          fileRelayId: file.relayId,
          fileIdentity: file.fileIdentity,
          ...(file.source === 'legacy' ? { fileSource: 'legacy' } : {}),
        }
      : profile
        ? { requestId, profile, saveFile: true }
        : { requestId }
    const resume = (file || profile) && (pending === requestId || (progress?.requestId === requestId && progress.uncertain))
    const submit = (request: typeof body) =>
      withConfirmation(receipt =>
        api<AddedRelayInfo>('native/relays', { method: 'POST', body: request, ...(receipt ? { confirmation: receipt } : {}) }),
      )
    setProgress({ requestId, test: null, busy: true })
    try {
      // A lost response may have committed even if the selected file no longer exists.
      const info = resume
        ? await submit({ requestId }).catch((cause: unknown) => {
            if (cause instanceof ApiError && cause.code === 'native-relay-request-missing') return submit(body)
            throw cause
          })
        : await submit(body)
      onInfo(info)
      const relayId = info.addedRelayId ?? profile?.relayId ?? file?.relayId
      if (relayId)
        onCompleted(
          relayId,
          info.relays.some(relay => relay.relayId === relayId),
        )
      setProgress({
        requestId,
        test: { reached: 'registered' },
        busy: false,
        completed: true,
        ...(info.fileSaveFailed ? { fileSaveFailed: true } : {}),
        ...(relayId ? { relayId } : {}),
      })
    } catch (cause) {
      const code = cause instanceof ApiError ? cause.code : undefined
      const failure = code && Object.hasOwn(FAILURE, code) ? FAILURE[code] : undefined
      const uncertain = failure === undefined && isUncertain(cause)
      setProgress({
        requestId,
        test: failure ? { reached: failure === 'refused' ? 'identity' : 'none', failure } : null,
        busy: false,
        uncertain,
        message: uncertain ? COPY.unknown : inlineError(cause),
      })
    } finally {
      connecting.current = false
    }
  }
  const drop = (event: DragEvent) => {
    event.preventDefault()
    void read(event.dataTransfer.files[0])
  }
  const relayId = progress?.relayId
  const relay = relayId ? configuredRelay(relayId) : undefined
  const removed = progress?.completed && relayId && !relay
  const progressDetails = progress ? (
    removed ? (
      <InlineNotice tone="warn" secure>
        {COPY.removedAfterAdd}
      </InlineNotice>
    ) : (
      <>
        <RelaySteps
          test={progress.test && relay ? { ...progress.test, bookIssuedAt: relay.bookIssuedAt } : progress.test}
          busy={progress.busy && !awaitingConfirmation}
        />
        {progress.fileSaveFailed && (
          <InlineNotice tone="warn" secure>
            {COPY.fileSaveFailed}
          </InlineNotice>
        )}
        {progress.message && (
          <InlineNotice tone={progress.uncertain ? 'warn' : 'error'} secure>
            {progress.message}
          </InlineNotice>
        )}
      </>
    )
  ) : null
  const listedFiles = files.filter(found => way === 'file' || (found.kind === way && (way !== 'edge' || found.name === name)))
  const fileStep = (
    <>
      {listedFiles.map(found => (
        <div key={found.relayId} className="relay-found" data-testid="relay-found">
          <Icon icon={KIND[found.kind].icon} size={16} />
          <b>{found.name}</b>
          <Tooltip content={found.urls.join(' · ')}>
            <span>{hostOf(found.urls[0] ?? '')}</span>
          </Tooltip>
          <code>{found.keyHash}</code>
          <Button
            size="sm"
            variant="primary"
            disabled={filesError || Boolean(pending)}
            onClick={() => {
              reading.current++
              setRejected(null)
              setCandidate(fileCandidate(found))
            }}>
            {COPY.review}
          </Button>
        </div>
      ))}
      <div className="relay-drop" data-testid="relay-drop" onDragOver={event => event.preventDefault()} onDrop={drop}>
        <Icon icon={FileUp} size={16} />
        <span>{COPY.dropFile}</span>
        <Tooltip content={COPY.relaysFolderDetail}>
          <code className="relay-folder" tabIndex={0}>
            {RELAYS_DIR}
          </code>
        </Tooltip>
        <Button size="sm" onClick={() => fileInput.current?.click()}>
          {COPY.chooseFile}
        </Button>
        <input
          ref={fileInput}
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
    </>
  )
  const commands =
    way === 'self' && sourceCheckout
      ? relaySetupCommands('self', { server, domain, port, cert, key })
      : way === 'edge' && edgeAvailable
        ? relaySetupCommands('edge', { latch: localLatchCommand(), name, location: location === 'auto' ? undefined : location })
        : undefined
  const steps =
    way === 'edge' && commands ? (
      <ol className="relay-steps-list">
        <Step index={1} title={COPY.logIn}>
          {commands.login.map(command => (
            <Command key={command} command={command} />
          ))}
        </Step>
        <Step index={2} title={COPY.deploy}>
          <span className="relay-fields">
            <TextField
              label={COPY.name}
              value={name}
              error={validRelayName(name) ? undefined : COPY.nameRule}
              onChange={event => setName(event.currentTarget.value.trim().toLowerCase())}
            />
            <span className="relay-field">
              <span className="relay-field-label">{COPY.location}</span>
              <ValuePicker
                label={COPY.location}
                value={location}
                options={[
                  { value: 'auto' as const, label: COPY.automatic },
                  ...RELAY_LOCATIONS.map(value => ({ value, label: COPY.locations[value] })),
                ]}
                onValueChange={setLocation}
              />
            </span>
          </span>
          {commands.deploy.map(command => (
            <Command key={command} command={command} />
          ))}
        </Step>
        <Step index={3} title={COPY.connect}>
          {fileStep}
        </Step>
      </ol>
    ) : way === 'self' && commands ? (
      <ol className="relay-steps-list">
        <Step index={1} title={COPY.logIn}>
          <TextField
            label={COPY.server}
            placeholder="user@server"
            value={server}
            onChange={event => setServer(event.currentTarget.value.trim())}
          />
          {commands.login.map(command => (
            <Command key={command} command={command} />
          ))}
        </Step>
        <Step index={2} title={COPY.configure}>
          <span className="relay-fields">
            <TextField
              label={COPY.domain}
              placeholder="relay.example.com"
              value={domain}
              onChange={event => setDomain(event.currentTarget.value.trim().toLowerCase())}
            />
            <TextField
              label={COPY.port}
              inputMode="numeric"
              value={port}
              onChange={event => setPort(event.currentTarget.value.replace(/[^0-9]/gu, '').slice(0, 5))}
            />
            <TextField
              label={COPY.certificate}
              placeholder="/etc/ssl/relay/fullchain.pem"
              value={cert}
              onChange={event => setCert(event.currentTarget.value.trim())}
            />
            <TextField
              label={COPY.privateKey}
              placeholder="/etc/ssl/relay/key.pem"
              value={key}
              onChange={event => setKey(event.currentTarget.value.trim())}
            />
          </span>
          {commands.deploy.length > 0 && (
            <Tooltip content={COPY.deployFromServer}>
              <span className="relay-commands">
                {commands.deploy.map(command => (
                  <Command key={command} command={command} copyOnly />
                ))}
              </span>
            </Tooltip>
          )}
        </Step>
        <Step index={3} title={COPY.connect}>
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
      title={way === null ? COPY.addRelay : way === 'file' ? COPY.existingFile : KIND[way].label}
      onClose={() => {
        if (awaitingConfirmation) confirmation.actions.cancel()
        if (!progress?.busy && !progress?.uncertain) reset()
        onClose()
      }}
      footer={
        (way !== null || candidate) && !progress?.completed ? (
          <Button onClick={reset} disabled={progress?.busy || progress?.uncertain}>
            {COPY.back}
          </Button>
        ) : progress?.completed ? (
          <Button
            variant="primary"
            onClick={() => {
              reset()
              onClose()
            }}>
            {COPY.done}
          </Button>
        ) : undefined
      }>
      {pending && way === null && !candidate && !progress && (
        <div className="relay-check">
          <b>{COPY.previousUnknown}</b>
          <Button variant="primary" onClick={() => void connect({ requestId: pending })}>
            {COPY.retry}
          </Button>
        </div>
      )}
      {way === null && !candidate && !progress && (
        <div className="relay-ways" data-testid="relay-ways">
          {(['edge', 'self', 'file'] as const).map(option => {
            const platformUnavailable = option === 'edge' && !edgeAvailable
            const missing = platformUnavailable || (option !== 'file' && !sourceCheckout)
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
                <span>{option === 'file' ? COPY.existingFile : KIND[option].label}</span>
                {missing && <StatusWord>{COPY.unimplemented}</StatusWord>}
              </button>
            )
            return missing ? (
              <Tooltip key={option} content={platformUnavailable ? COPY.edgeUnavailable : COPY.serverBuildFile}>
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
          {rejected === 'edge' ? `${COPY.edgeRelayUnavailable}${COPY.edgeUnavailable}` : COPY.invalidFile}
        </InlineNotice>
      )}
      {candidate && (
        <div className="relay-check" data-testid="relay-candidate">
          <SettingsRow
            leading={<IconTile icon={KIND[candidate.kind].icon} />}
            title={candidate.file?.name ?? KIND[candidate.kind].label}
            record
          />
          <dl className="relay-facts">
            <dt>{COPY.address}</dt>
            <dd>
              {candidate.urls.map(url => (
                <span key={url}>{hostOf(url)}</span>
              ))}
            </dd>
            <dt>{COPY.key}</dt>
            <dd>
              <Tooltip content={candidate.fullKey}>
                <span>{candidate.hash}</span>
              </Tooltip>
            </dd>
            <dt>{COPY.registrationToken}</dt>
            <dd>{candidate.token ? COPY.included : COPY.none}</dd>
          </dl>
          {progress ? (
            <>
              {progressDetails}
              {!progress.busy && !progress.completed && (
                <Button variant="primary" onClick={() => void connect(candidate)}>
                  {COPY.retry}
                </Button>
              )}
            </>
          ) : (
            <Button variant="primary" onClick={() => void connect(candidate)}>
              {COPY.confirmConnect}
            </Button>
          )}
        </div>
      )}
      {!candidate && progress && (
        <div className="relay-check">
          {progressDetails}
          {!progress.busy && !progress.completed && (
            <Button variant="primary" onClick={() => void connect({ requestId: progress.requestId })}>
              {COPY.retry}
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
