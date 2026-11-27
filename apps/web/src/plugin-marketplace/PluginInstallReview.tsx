import { useEffect, useState, type ReactNode } from 'react'
import type { PluginPackageDetail } from '@latch/protocol'
import { Button, InlineNotice } from '@latch/ui'
import { api, inlineError, type ApiOptions } from '../core/api.ts'
import { withConfirmation } from '../core/confirmations.ts'
import { defineCopy } from '../core/i18n.ts'
import { useMounted } from '../hooks/useMounted.ts'
import { Loading } from '../settings/common.tsx'
import { PluginFileDisclosure } from '../settings/CreatorPluginReview.tsx'
import { PluginReachGroup } from '../settings/PluginAssetsSettings.tsx'
import {
  isPluginPackageReview,
  PluginMutationReviewBody,
  PluginRiskFacts,
  PluginWriteFeedback,
  reviewedPluginChange,
  reviewedPluginMutation,
  usePluginMutationReview,
  type AppliedPluginChange,
  type PluginMutationTarget,
} from '../settings/PluginMutationReview.tsx'
import { needsPageBuild, packageReach, pendingPluginChange } from '../settings/pluginAssets.ts'
import { marketRequest, receiptUnsettled, useMarketWriteScope } from './marketReceipts.ts'

const COPY = defineCopy(
  {
    loading: '正在读取待审阅版本…',
    retry: '重试',
    applied: '此版本已安装。',
    unknown: '尚未收到操作结果。可重试同一请求，或放弃查询。已提交的操作仍可能完成，可在连接后查看插件状态。',
  },
  {
    loading: 'Reading the version to review…',
    retry: 'Retry',
    applied: 'This version is installed.',
    unknown:
      'The result is unknown. Retry the same request or stop checking. The operation may still complete. Reconnect to check the plugin’s status.',
  },
)

type Request = { path: string; options: ApiOptions }
type Read = { id: string; round: number; detail?: PluginPackageDetail; error?: string }

/**
 * The saved draft of one package, in the marketplace's dialog: where its code runs, every file with its source, and the
 * Host's review of that exact revision. Apply is ready only once the Host described the same revision the files show;
 * it sends the reviewed request through the local confirmation, and an unknown result keeps that request to send again.
 * A draft whose pages need a build is reviewed here but built and applied in plugin settings, where its preview runs.
 */
export function usePluginInstallReview({
  id,
  active,
  revisionHint,
  scope,
  nameHint,
  canPrefetchReview = true,
  pageBuilds,
  onApplied,
}: {
  id: string | undefined
  active: boolean
  scope: string
  /** The revision the package list or stage last reported: a different one reads the draft again. */
  revisionHint: string | undefined
  nameHint?: string | undefined
  /** Whether the apply review can start alongside the draft read before the manifest arrives. */
  canPrefetchReview?: boolean | undefined
  /** The Host builds pages (format 2): such drafts are applied after their build in plugin settings. */
  pageBuilds: boolean
  onApplied: (applied: AppliedPluginChange) => void
}) {
  const mounted = useMounted()
  const key = JSON.stringify([scope, id])
  const writeSignal = useMarketWriteScope(key, active)
  const [read, setRead] = useState<Read | null>(null)
  const [readAgain, setReadAgain] = useState(0)
  // Each outcome belongs to one package: another package starts clean.
  const [sent, setSent] = useState<{ key: string; request: Request; shown: AppliedPluginChange } | null>(null)
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const currentDetail = read && read.id === id && read.round === readAgain ? read.detail : undefined
  const alreadyRead =
    active && id !== undefined && currentDetail !== undefined && revisionHint !== undefined && currentDetail.revision === revisionHint

  useEffect(() => {
    if (!active || id === undefined) {
      setRead(null)
      setFailure(null)
      return undefined
    }
    if (alreadyRead) return undefined
    setRead(previous => (previous?.id === id && previous.detail ? previous : null))
    const abort = new AbortController()
    void api<{ package: PluginPackageDetail }>('plugin-packages/' + encodeURIComponent(id), { signal: abort.signal }).then(
      value => {
        if (!abort.signal.aborted) setRead({ id, round: readAgain, detail: value.package })
      },
      cause => {
        if (!abort.signal.aborted) setRead({ id, round: readAgain, error: inlineError(cause) })
      },
    )
    return () => abort.abort()
  }, [active, alreadyRead, id, revisionHint, readAgain])

  const pending = sent?.key === key ? sent : null
  const error = failure && failure.id === id ? failure.message : ''
  const detail = read && read.id === id ? read.detail : undefined
  const readError = read && read.id === id ? read.error : undefined
  const pageBuild = pageBuilds && needsPageBuild(detail?.bundle.manifest)
  const applied = detail !== undefined && detail.revision === detail.appliedRevision
  const target: PluginMutationTarget | null = detail
    ? !pageBuild && !applied
      ? { id: detail.id, name: detail.name, operation: 'apply', revision: detail.revision }
      : null
    : id !== undefined && revisionHint !== undefined && !readError && canPrefetchReview
      ? { id, name: nameHint ?? id, operation: 'apply', revision: revisionHint }
      : null
  const mutation = usePluginMutationReview(active ? target : null)

  const send = async (packageId: string, request: Request, shown: AppliedPluginChange) => {
    const signal = writeSignal()
    if (!signal || busy) return
    setBusy(true)
    setFailure(null)
    setSent({ key, request, shown })
    try {
      const scopedApi = <T,>(path: string, options?: ApiOptions) => marketRequest<T>(signal, path, options)
      await withConfirmation(confirmation => scopedApi(request.path, { ...request.options, ...(confirmation ? { confirmation } : {}) }), {
        signal,
        api: scopedApi,
      })
      if (mounted.current) {
        setSent(null)
        onApplied(shown)
      }
    } catch (cause) {
      if (mounted.current && !signal.aborted) {
        if (!receiptUnsettled(cause, pending?.request === request)) {
          setSent(null)
          // The Host refused this revision as reviewed: show what it holds now.
          setReadAgain(count => count + 1)
          mutation.retry()
        }
        setFailure({ id: packageId, message: inlineError(cause) })
      }
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const change = mutation.review ? reviewedPluginChange(mutation.review) : detail && pendingPluginChange(detail)
  const ready = target !== null && mutation.review !== null && currentDetail !== undefined
  const apply = () => {
    if (pending && id) {
      void send(id, pending.request, pending.shown)
      return
    }
    if (!ready || !target || !detail || !mutation.review || !change) return
    void send(detail.id, reviewedPluginMutation(target, mutation.review), { name: detail.name, version: detail.version, kind: change.kind })
  }

  const feedback = (
    <PluginWriteFeedback
      busy={busy}
      failure={error}
      uncertain={pending !== null}
      unknownMessage={COPY.unknown}
      replacesInstalled={!!mutation.review?.baseAppliedRevision}
    />
  )
  const body: ReactNode = (
    <div className="plugin-install-review">
      {readError ? (
        <InlineNotice tone="error" action={<Button onClick={() => setReadAgain(count => count + 1)}>{COPY.retry}</Button>}>
          {readError}
        </InlineNotice>
      ) : !detail ? (
        <Loading label={COPY.loading} />
      ) : (
        <>
          <PluginReachGroup reach={packageReach(detail.bundle.manifest, detail)} />
          {applied ? (
            <p className="settings-caption">{COPY.applied}</p>
          ) : pageBuild ? (
            isPluginPackageReview(detail.review, detail.revision) && <PluginRiskFacts review={detail.review} />
          ) : (
            <PluginMutationReviewBody
              submitting={busy || pending !== null}
              review={mutation.review}
              fallback={isPluginPackageReview(detail.review, detail.revision) ? detail.review : undefined}
              error={mutation.error}
              onRetry={mutation.retry}
            />
          )}
          <PluginFileDisclosure key={detail.revision} bundle={detail.bundle} />
        </>
      )}
    </div>
  )

  return {
    body,
    feedback,
    loaded: detail !== undefined || readError !== undefined,
    name: detail?.name,
    version: detail?.version,
    /** The draft's pages build in plugin settings, where their preview runs. */
    pageBuild: pending === null && detail !== undefined && pageBuild,
    applied,
    /** Apply has the Host's review of the revision shown, or an unknown result to send again. */
    ready: ready || pending !== null,
    confirmLabel: change?.confirm,
    retrying: pending !== null && !busy,
    busy,
    locked: busy || pending !== null,
    abandon: () => {
      if (pending && !busy) setSent(null)
    },
    apply,
  }
}
