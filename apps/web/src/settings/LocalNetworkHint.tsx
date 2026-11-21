import type { MouseEvent } from 'react'
import type { LocalNetworkAccess } from '@latch/protocol'
import { ButtonLink, StatusWord, Tooltip } from '@latch/ui'
import { defineCopy, useLocale } from '../core/i18n.ts'
import { currentShell } from '../core/shell.ts'

/** The desktop app lets exactly this one system-settings address through (apps/desktop/src/proxy.cjs). */
export const LOCAL_NETWORK_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork'
const SOURCE_DESKTOP_COMMAND = 'corepack pnpm desktop'

const COPY = defineCopy(
  {
    denied: '本地网络未允许',
    unreadable: '无法读取本地网络信息',
    open: '打开系统设置',
    path: '系统设置 › 隐私与安全性 › 本地网络',
    detail: '检查这台 Mac 的「本地网络」权限。安装版找 Latch，终端直接启动时找终端应用。',
    sourceDetail: '换启动方式前，先停止同一数据目录的 Host。关窗口后它仍会运行。然后在终端进入 Latch 源码目录，运行',
  },
  {
    denied: 'Local Network not allowed',
    unreadable: 'Can’t read local network information',
    open: 'Open System Settings',
    path: 'System Settings › Privacy & Security › Local Network',
    detail:
      'Check Local Network access on this Mac. Look for Latch if installed, or your terminal app if launched directly from a terminal.',
    sourceDetail:
      'Stop the Host for this data directory before switching. Closing the window leaves it running. In a terminal, go to the Latch checkout and run',
  },
)

/** Only this Mac's own desktop window can open System Settings; a browser, a phone or another computer reads the path. */
export function canOpenSystemSettings(local: boolean): boolean {
  const shell = currentShell()
  return local && shell?.platform === 'darwin' && shell.remote !== true
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
 * Distinguish a system refusal from a neighbour table the Host could not read. A source run also shows how to relaunch.
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
          <StatusWord tone="warn">{state === 'denied' ? COPY.denied : COPY.unreadable}</StatusWord>
        </span>
      </Tooltip>
      {!openable && <span className="local-network-path">{COPY.path}</span>}
      {source && (
        <span className="local-network-path">
          {COPY.sourceDetail} <code className="local-network-script">{SOURCE_DESKTOP_COMMAND}</code>
        </span>
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
