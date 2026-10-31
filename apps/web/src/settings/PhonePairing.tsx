import type { AppSnapshot } from '@latch/protocol'
import { QrCode } from 'lucide-react'
import type { DeviceAccess } from '../core/permissions.ts'
import { PAIRING_COPY } from '../core/securityCopy.ts'
import { IconTile, SettingsGroup, SettingsRow } from './common.tsx'
import { PairingBlocked } from './PairingBlocked.tsx'
import { NativePairingSection } from './NativePhonePairing.tsx'

/**
 * 设置 › 设备 › 连接手机, a security surface: the pairing panel where this device may open one (the desktop app and 管理此
 * Host), else a row with the reason and where to do it, in words. An HTTPS entry for a browser stays with the command
 * line (`pnpm latch device invite`).
 */
export function PairingSection({
  access,
  snapshot,
}: {
  access: DeviceAccess
  /** Names a full-access session that would hold the phone's enrollment back. */
  snapshot?: AppSnapshot
}) {
  if (access.local && access.admin)
    return (
      <>
        {snapshot && <PairingBlocked snapshot={snapshot} />}
        <NativePairingSection />
      </>
    )
  return (
    <SettingsGroup title="连接手机" secure>
      <SettingsRow
        leading={<IconTile icon={QrCode} />}
        title="配对二维码"
        description={!access.local ? PAIRING_COPY.needsDesktop : PAIRING_COPY.needsAdmin}
      />
    </SettingsGroup>
  )
}
