import { Fragment, useEffect, useState } from 'react'
import type { AppSnapshot, HarnessInfo } from '@latch/protocol'
import { Button, Modal, ModalHeader, SegmentedControl, Spinner } from '@latch/ui'
import { HarnessTile } from '../components/BrandTile.tsx'
import { harnessName } from '../composerChoice.ts'
import { dateTime } from '../format.ts'
import { hostNow, useTicker } from '../core/hostClock.ts'
import { hostView, type DeviceAccess } from '../core/permissions.ts'
import { LimitWindow } from './LimitWindow.tsx'
import { harnessLimits, LIMIT_WORDS } from './limits.ts'
import { closeUsage, openUsage, refreshLimits, useUsageRequest, type UsageRequest, type UsageView as View } from './surface.ts'
import { UsageView } from './UsageView.tsx'
import { defineCopy, useLocale } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    only: (name: string) => `只看 ${name}`,
    quota: '额度',
    usage: '用量',
    title: '额度与用量',
    view: '视图',
    allHarnesses: '全部 Harness',
    allServices: '全部服务',
    reading: '正在读取额度',
    signedOut: '未登录',
    missingKey: '无 API 密钥',
    readFailed: '读取失败',
    retry: '重试',
    afterTurn: '只在对话中报告',
    notAdded: '未添加',
    noReport: '尚未报告额度',
    offline: '连接中断，显示上次收到的额度',
    noDirect: '没有用自己登录的 Harness',
    observed: (value1: string | number) => `${value1} 读到`,
    unsupported: '不报告额度',
  },
  {
    only: (name: string) => `Showing only ${name}`,
    quota: 'Limits',
    usage: 'Usage',
    title: 'Limits and usage',
    view: 'View',
    allHarnesses: 'All Harnesses',
    allServices: 'All services',
    reading: 'Reading limits',
    signedOut: 'Signed out',
    missingKey: 'No API key',
    readFailed: "Couldn't read limits",
    retry: 'Retry',
    afterTurn: 'Reported during conversations',
    notAdded: 'Not added',
    noReport: 'No limits reported yet',
    offline: 'Disconnected. Showing the last reported limits',
    noDirect: 'No Harnesses with their own sign-in',
    observed: (value1: string | number) => `Read ${value1}`,
    unsupported: 'Limits unavailable',
  },
)

const VIEWS: ReadonlyArray<{ value: View; label: string }> = [
  {
    value: 'limits',
    get label() {
      return COPY.quota
    },
  },
  {
    value: 'usage',
    get label() {
      return COPY.usage
    },
  },
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
  useLocale()
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
    <Modal label={COPY.title} variant={phone ? 'sheet' : 'dialog'} size="xl" className="usage-surface" onClose={closeUsage}>
      <UsageBody key={audience} request={request} snapshot={snapshot} offline={offline} phone={phone} asks={access.scopes.has('run')} />
    </Modal>
  )
}

function UsageBody({
  request,
  snapshot,
  offline,
  phone,
  asks,
}: {
  request: UsageRequest
  snapshot: AppSnapshot
  offline: boolean
  phone: boolean
  /** The device may have the limits asked for: the same right as starting a session. */
  asks: boolean
}) {
  const usageOffered = snapshot.catalog?.features?.modelUsage === true
  const view: View = usageOffered ? request.view : 'limits'
  const views = usageOffered && (
    <SegmentedControl
      label={COPY.view}
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
          label: COPY.allHarnesses,
        }
      : view === 'usage' && request.providerId
        ? {
            name: snapshot.catalog?.providers.find(item => item.id === request.providerId)?.name ?? request.providerId,
            label: COPY.allServices,
          }
        : undefined
  return (
    <>
      <ModalHeader title={COPY.title} onClose={closeUsage} actions={phone ? undefined : views} />
      <div className="ui-modal-body usage-body" data-view={view}>
        {phone && views}
        {scoped && (
          <div className="usage-scope">
            <span className="usage-scope-name">{COPY.only(scoped.name)}</span>
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
          <LimitsView request={request} harnesses={snapshot.catalog?.harnesses ?? []} offline={offline} asks={asks} />
        ) : (
          <UsageView request={request} snapshot={snapshot} />
        )}
      </div>
    </>
  )
}

/** How long a row waits on a read this view asked for: the Host bounds one at 30 seconds. */
const READ_WAIT_MS = 35_000

/**
 * What a Harness's row says while it has no figure: reading, why there is none, or that it reports only in a turn.
 * `reading`: this view asked the Host to read it and has not heard the end of that yet.
 */
export function NoLimits({ harness, asks, reading }: { harness: HarnessInfo; asks: boolean; reading: boolean }) {
  const read = harness.quotaRead
  if (read?.running)
    return (
      <p className="usage-muted usage-reading">
        <Spinner size={12} label={COPY.reading} />
      </p>
    )
  if (read?.failed?.reason === 'login') return <p className="usage-muted">{COPY.signedOut}</p>
  if (read?.failed?.reason === 'no-key') return <p className="usage-muted">{COPY.missingKey}</p>
  if (read?.failed)
    return (
      <p className="usage-muted usage-retry">
        <span>{COPY.readFailed}</span>
        {asks && (
          <>
            <span aria-hidden="true">·</span>
            <Button
              size="xs"
              variant="link"
              onClick={() => {
                void refreshLimits([harness.id], true)
              }}>
              {COPY.retry}
            </Button>
          </>
        )}
      </p>
    )
  if (read?.afterTurn) return <p className="usage-muted">{COPY.afterTurn}</p>
  if (reading)
    return (
      <p className="usage-muted usage-reading">
        <Spinner size={12} label={COPY.reading} />
      </p>
    )
  // A preset not added yet is never read.
  if (harness.offer) return <p className="usage-muted">{COPY.notAdded}</p>
  return <p className="usage-muted">{COPY.noReport}</p>
}

function LimitsView({
  request,
  harnesses,
  offline,
  asks,
}: {
  request: UsageRequest
  harnesses: readonly HarnessInfo[]
  offline: boolean
  asks: boolean
}) {
  useTicker('minute')
  // Looking is what asks: each time the view opens, or is narrowed to one Harness, while connected. Until the Host
  // answers, every row it may read waits; then only those it said it asked, until the read's bound has passed.
  const [pending, setPending] = useState<ReadonlySet<string> | 'all'>(() => new Set())
  useEffect(() => {
    if (offline || !asks) return undefined
    let live = true
    setPending('all')
    void refreshLimits(request.harnessId ? [request.harnessId] : undefined).then(asked => {
      if (live) setPending(new Set(asked))
    })
    const timer = setTimeout(() => {
      if (live) setPending(new Set())
    }, READ_WAIT_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [offline, asks, request.harnessId])
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
      {offline && <p className="usage-muted">{COPY.offline}</p>}
      {shown.length === 0 && quiet.length === 0 && <p className="usage-muted">{COPY.noDirect}</p>}
      {shown.map(({ harness, limits }) => (
        <section className="usage-harness" key={harness.id} aria-label={harnessName(harness)}>
          <header className="usage-harness-head">
            <HarnessTile harness={harness} size={20} />
            <h3>{harnessName(harness)}</h3>
            {limits && harness.quotaRead?.running && <Spinner size={12} label={COPY.reading} />}
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
            <div className="usage-windows" title={harness.quota ? COPY.observed(dateTime(harness.quota.observedAt)) : undefined}>
              {limits.account && (
                <p className="usage-account" data-state="limited">
                  {COPY.quota}
                  {LIMIT_WORDS.limited}
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
            <NoLimits
              harness={harness}
              asks={asks && !offline}
              reading={!offline && (pending === 'all' ? harness.offer === undefined : pending.has(harness.id))}
            />
          )}
        </section>
      ))}
      {quiet.length > 0 && (
        <p className="usage-silent">
          <span>{COPY.unsupported}</span>
          <span>{quiet.map(harnessName).join('、')}</span>
        </p>
      )}
    </div>
  )
}
