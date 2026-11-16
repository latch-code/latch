import { Fragment, useEffect, useState } from 'react'
import type { AppSnapshot, HarnessInfo } from '@latch/protocol'
import { Button, Modal, ModalHeader, SegmentedControl } from '@latch/ui'
import { HarnessTile } from '../components/BrandTile.tsx'
import { harnessName } from '../composerChoice.ts'
import { hostNow, useTicker } from '../core/hostClock.ts'
import { hostView, type DeviceAccess } from '../core/permissions.ts'
import { LimitWindow } from './LimitWindow.tsx'
import { harnessLimits, LIMIT_WORDS } from './limits.ts'
import { closeUsage, openUsage, useUsageRequest, type UsageRequest, type UsageView as View } from './surface.ts'
import { UsageView } from './UsageView.tsx'

const VIEWS: ReadonlyArray<{ value: View; label: string }> = [
  { value: 'limits', label: '额度' },
  { value: 'usage', label: '用量' },
]

/** Who is asking: Host, device, data scope and scopes. */
function audienceOf(snapshot: AppSnapshot, access: DeviceAccess): string {
  return JSON.stringify([
    hostView(snapshot)?.hostId,
    snapshot.instanceId,
    snapshot.device.id,
    snapshot.device.dataScope,
    [...access.scopes].toSorted(),
  ])
}

/**
 * The Harnesses the 额度 view lists: those that run on their own login (a subscription can have limits), and any that
 * reported limits; the ones with limits first, then those that can report them but have not yet. Those whose program
 * never reports limits are named together in one line at the end.
 */
function limitHarnesses(harnesses: readonly HarnessInfo[], now: number) {
  const own = harnesses.filter(harness => harness.quota || (harness.capabilities.models.owner === 'harness' && harness.status === 'ready'))
  const listed = own
    .filter(harness => harness.quota || harness.capabilities.models.quota)
    .map(harness => {
      const limits = harnessLimits(harness.quota, now)
      return limits ? { harness, limits } : { harness }
    })
    .toSorted((a, b) => Number(!a.limits) - Number(!b.limits))
  const silent = own.filter(harness => !harness.quota && !harness.capabilities.models.quota)
  return { listed, silent }
}

/**
 * 额度与用量: one surface for a Harness's subscription limits and for what model requests used. Opened by click from the
 * composer's chip (scoped to that Harness or service), from the global entry and by its shortcut. A dialog that fits its
 * content under a fixed top edge on a wide window, so a switch of view grows or shrinks it downward only; the shared
 * sheet on a phone. Mounted once by the shell.
 */
export function UsageSurface({
  snapshot,
  access,
  offline,
  phone,
}: {
  snapshot: AppSnapshot
  access: DeviceAccess
  offline: boolean
  phone: boolean
}) {
  const request = useUsageRequest()
  // A new audience starts the body afresh: nothing read for the last one is shown while the new reads are on their way.
  const audience = audienceOf(snapshot, access)
  const viewing = access.scopes.has('view')
  // A device that may no longer view has nothing here: the surface closes rather than waiting to come back.
  useEffect(() => {
    if (!viewing) closeUsage()
  }, [viewing])
  if (!viewing || !request) return null
  return (
    <Modal label="额度与用量" variant={phone ? 'sheet' : 'dialog'} size="xl" className="usage-surface" onClose={closeUsage}>
      <UsageBody key={audience} request={request} snapshot={snapshot} offline={offline} phone={phone} />
    </Modal>
  )
}

function UsageBody({
  request,
  snapshot,
  offline,
  phone,
}: {
  request: UsageRequest
  snapshot: AppSnapshot
  offline: boolean
  phone: boolean
}) {
  const usageOffered = snapshot.catalog?.features?.modelUsage === true
  const view: View = usageOffered ? request.view : 'limits'
  const views = usageOffered && (
    <SegmentedControl
      label="视图"
      size="md"
      className="usage-views"
      value={view}
      options={VIEWS}
      onValueChange={next => {
        openUsage({ view: next })
      }}
    />
  )
  // Opened on one Harness or one service: a row says which, with the way to all of them.
  const scoped =
    view === 'limits' && request.harnessId
      ? {
          name: harnessName(
            snapshot.catalog?.harnesses.find(harness => harness.id === request.harnessId)
              ?? ({ capabilities: { display: { label: request.harnessId } } } as HarnessInfo),
          ),
          label: '全部 Harness',
        }
      : view === 'usage' && request.providerId
        ? { name: snapshot.catalog?.providers.find(item => item.id === request.providerId)?.name ?? request.providerId, label: '全部服务' }
        : undefined
  return (
    <>
      <ModalHeader title="额度与用量" onClose={closeUsage} actions={phone ? undefined : views} />
      <div className="ui-modal-body usage-body" data-view={view}>
        {phone && views}
        {scoped && (
          <div className="usage-scope">
            <span className="usage-scope-name">只看 {scoped.name}</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                openUsage({ view })
              }}>
              {scoped.label}
            </Button>
          </div>
        )}
        {view === 'limits' ? (
          <LimitsView request={request} harnesses={snapshot.catalog?.harnesses ?? []} offline={offline} />
        ) : (
          <UsageView request={request} snapshot={snapshot} />
        )}
      </div>
    </>
  )
}

function LimitsView({ request, harnesses, offline }: { request: UsageRequest; harnesses: readonly HarnessInfo[]; offline: boolean }) {
  useTicker('minute')
  // A window past its reset is gone at once, not at the next minute.
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
    if (!Number.isFinite(nextReset)) return undefined
    const timer = setTimeout(() => expire(version => version + 1), Math.max(0, nextReset - hostNow()) + 1)
    return () => clearTimeout(timer)
  }, [nextReset])
  const { listed, silent } = limitHarnesses(harnesses, now)
  const shown = request.harnessId ? listed.filter(item => item.harness.id === request.harnessId) : listed
  const quiet = request.harnessId ? silent.filter(harness => harness.id === request.harnessId) : silent
  return (
    <div className="usage-limits">
      {offline && <p className="usage-muted">连接中断，显示上次收到的额度</p>}
      {shown.length === 0 && quiet.length === 0 && <p className="usage-muted">没有用自己登录的 Harness</p>}
      {shown.map(({ harness, limits }) => (
        <section className="usage-harness" key={harness.id} aria-label={harnessName(harness)}>
          <header className="usage-harness-head">
            <HarnessTile harness={harness} size={20} />
            <h3>{harnessName(harness)}</h3>
            {limits && limits.facts.length > 0 && (
              <span className="usage-facts">
                {limits.facts.map((fact, index) => (
                  <Fragment key={fact}>
                    {index > 0 && <span aria-hidden="true">·</span>}
                    <span className={fact === limits.who ? 'usage-fact-who' : 'usage-fact'}>{fact}</span>
                  </Fragment>
                ))}
              </span>
            )}
          </header>
          {limits ? (
            <div className="usage-windows">
              {limits.account && (
                <p className="usage-account" data-state="limited">
                  额度{LIMIT_WORDS.limited}
                </p>
              )}
              {limits.windows.map((window, index) => (
                <Fragment key={window.key}>
                  {window.group && window.group !== limits.windows[index - 1]?.group && <p className="usage-group">{window.group}</p>}
                  <LimitWindow view={window} />
                </Fragment>
              ))}
            </div>
          ) : (
            <p className="usage-muted">尚未报告额度</p>
          )}
        </section>
      ))}
      {quiet.length > 0 && (
        <p className="usage-silent">
          <span>不报告额度</span>
          <span>{quiet.map(harnessName).join('、')}</span>
        </p>
      )}
    </div>
  )
}
