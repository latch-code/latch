import { useEffect, useState } from 'react'
import { ChartNoAxesColumn } from 'lucide-react'
import { Icon, Popover } from '@latch/ui'
import type { HarnessInfo } from '@latch/protocol'
import { HarnessTile } from '../components/BrandTile.tsx'
import { harnessName } from '../composerChoice.ts'
import { QuotaPanel } from '../composer/HarnessQuota.tsx'
import { quotaView } from '../composer/harnessQuota.ts'
import { hostNow, useTicker } from '../core/hostClock.ts'
import type { ShellState } from './useShellLayout.tsx'

function QuotaContents({ harnesses, offline }: { harnesses: readonly HarnessInfo[]; offline: boolean }) {
  useTicker('minute')
  const [, expire] = useState(0)
  const now = hostNow()
  const nextReset = Math.min(
    ...harnesses.flatMap(
      harness =>
        harness.quota?.windows.flatMap(window => {
          const at = Date.parse(window.resetsAt ?? '')
          return at > now && at <= now + 61_000 ? [at] : []
        }) ?? [],
    ),
  )
  useEffect(() => {
    if (!Number.isFinite(nextReset)) return
    const timer = setTimeout(() => expire(version => version + 1), Math.max(0, nextReset - hostNow()) + 1)
    return () => clearTimeout(timer)
  }, [nextReset])
  const reports = harnesses.flatMap(harness => {
    const view = quotaView(harness.quota, now)
    return view ? [{ harness, view }] : []
  })
  return (
    <div className="host-quota-content">
      {offline && <p className="host-quota-note">连接中断，显示上次收到的额度。</p>}
      {reports.length === 0 && <p className="host-quota-note">尚未收到有效额度。</p>}
      {reports.map(({ harness, view }) => (
        <section className="host-quota-harness" key={harness.id} aria-label={harnessName(harness)}>
          <h3>
            <HarnessTile harness={harness} size={20} />
            {harnessName(harness)}
          </h3>
          {view.state === 'limited' && view.rows.every(row => row.state !== 'limited') && <p className="host-quota-limit">额度已用尽</p>}
          <QuotaPanel view={view} showUsed />
        </section>
      ))}
    </div>
  )
}

/** The Harness limits behind one click: the shared popover, a sheet on a phone. */
function QuotaControl({
  harnesses,
  offline,
  appearance,
}: {
  harnesses: readonly HarnessInfo[]
  offline: boolean
  appearance: 'icon' | 'row' | 'tab'
}) {
  return (
    <Popover
      label="Harness 额度"
      size="md"
      side="auto"
      align={appearance === 'row' ? 'start' : 'end'}
      trigger={props => (
        <button
          {...props}
          type="button"
          className={appearance === 'tab' ? 'phone-tab host-quota-trigger' : 'host-quota-trigger'}
          data-quota-appearance={appearance}
          aria-label="额度">
          <Icon icon={ChartNoAxesColumn} size={appearance === 'tab' ? 20 : 16} />
          {appearance !== 'icon' && <span>额度</span>}
        </button>
      )}>
      <QuotaContents harnesses={harnesses} offline={offline} />
    </Popover>
  )
}

export function ShellQuota({ shell, appearance = 'icon' }: { shell: ShellState; appearance?: 'icon' | 'row' | 'tab' }) {
  const { snapshot, access, route, space, connection } = shell
  if (!access.scopes.has('view')) return null
  return (
    <QuotaControl
      key={JSON.stringify([
        snapshot.host?.hostId,
        snapshot.device.id,
        snapshot.device.dataScope,
        snapshot.device.scopes,
        route.entry,
        space,
      ])}
      harnesses={snapshot.catalog?.harnesses ?? []}
      offline={connection === 'offline' || connection === 'reconnecting'}
      appearance={appearance}
    />
  )
}
