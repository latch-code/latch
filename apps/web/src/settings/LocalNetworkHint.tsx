import type { MouseEvent } from 'react'
import type { LocalNetworkAccess } from '@latch/protocol'
import { ButtonLink, StatusWord, Tooltip } from '@latch/ui'
import { defineCopy, useLocale } from '../core/i18n.ts'
import { currentShell } from '../core/shell.ts'

/** The desktop app lets exactly this one system-settings address through (apps/desktop/src/proxy.cjs). */
export const LOCAL_NETWORK_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork'

const COPY = defineCopy(
  {
    denied: '本地网络未允许',
    open: '打开系统设置',
    path: '系统设置 › 隐私与安全性 › 本地网络',
    detail: '打开 Latch 的「本地网络」开关后，同一 Wi‑Fi 的手机才能直接连接这台 Mac。',
    sourceScript: 'scripts/desktop.sh',
    sourceDetail: '用 pnpm 启动 Latch 时无法获得本地网络权限。请用 scripts/desktop.sh 启动，见 README「安装与首次运行」。',
  },
  {
    denied: 'Local Network not allowed',
    open: 'Open System Settings',
    path: 'System Settings › Privacy & Security › Local Network',
    detail: 'Turn on Local Network for Latch so phones on the same Wi‑Fi can connect to this Mac directly.',
    sourceScript: 'scripts/desktop.sh',
    sourceDetail:
      'When started with pnpm, Latch cannot get Local Network access. Start Latch with scripts/desktop.sh as described in the README.',
  },
)

/** Only this Mac's own desktop window can open System Settings; a browser, a phone or another computer reads the path. */
export function canOpenSystemSettings(local: boolean): boolean {
  const shell = currentShell()
  return local && shell !== null && shell.remote !== true
}

const refused = (state: LocalNetworkAccess | undefined): state is 'denied' | 'unreadable' => state === 'denied' || state === 'unreadable'

/**
 * A desktop app with the guide opens the page through its one call, which also shows the guide over System Settings;
 * the link stays for an older shell. The press is spent once, so the link does not follow.
 */
export function openLocalNetworkSettings(event: Pick<MouseEvent, 'preventDefault'>): void {
  const local = currentShell()?.localNetwork
  if (!local) return
  event.preventDefault()
  void local.openSettings().catch(() => {})
}

/** 「打开系统设置」: the Local Network page, through the desktop app's one allowed system-settings address. */
export function LocalNetworkOpen({ state, openable }: { state: LocalNetworkAccess | undefined; openable: boolean }) {
  useLocale()
  if (!refused(state) || !openable) return null
  return (
    <ButtonLink
      variant="secondary"
      size="xs"
      href={LOCAL_NETWORK_SETTINGS}
      target="_blank"
      rel="noopener noreferrer"
      onClick={openLocalNetworkSettings}>
      {COPY.open}
    </ButtonLink>
  )
}

/**
 * 「本地网络未允许」 when the Host reports Local Network access refused or its neighbour table unreadable, details on hover.
 * Where the page cannot open System Settings it names the path instead; a source run also names the script that gets
 * the Host access.
 */
export function LocalNetworkNote({
  state,
  openable,
  source,
}: {
  state: LocalNetworkAccess | undefined
  openable: boolean
  source: boolean
}) {
  useLocale()
  if (!refused(state)) return null
  return (
    <span className="local-network-hint" data-testid="local-network-hint" data-state={state}>
      <Tooltip content={COPY.detail}>
        <span>
          <StatusWord tone="warn">{COPY.denied}</StatusWord>
        </span>
      </Tooltip>
      {!openable && <span className="local-network-path">{COPY.path}</span>}
      {source && (
        <Tooltip content={COPY.sourceDetail}>
          <code className="local-network-script">{COPY.sourceScript}</code>
        </Tooltip>
      )}
    </span>
  )
}

/** Both on one line, for the pairing sheet. */
export function LocalNetworkHint(props: { state: LocalNetworkAccess | undefined; openable: boolean; source: boolean }) {
  if (!refused(props.state)) return null
  return (
    <span className="local-network-line">
      <LocalNetworkNote {...props} />
      <LocalNetworkOpen state={props.state} openable={props.openable} />
    </span>
  )
}
