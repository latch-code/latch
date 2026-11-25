import { useEffect, useState, type ReactNode } from 'react'
import type { PluginPackageDetail } from '@latch/protocol'
import { Button, InlineNotice } from '@latch/ui'
import { api, inlineError, isUncertain, type ApiOptions } from '../core/api.ts'
import { withConfirmation } from '../core/confirmations.ts'
import { defineCopy } from '../core/i18n.ts'
import { InlineConfirm } from '../components/InlineConfirm.tsx'
import { useMounted } from '../hooks/useMounted.ts'
import { Loading, SettingsGroup } from '../settings/common.tsx'
import { PluginFileViewer } from '../settings/CreatorPluginReview.tsx'
import { PluginReachGroup } from '../settings/PluginAssetsSettings.tsx'
import {
  isPluginPackageReview,
  PluginMutationReviewBody,
  PluginRiskFacts,
  reviewedPluginMutation,
  usePluginMutationReview,
  type PluginMutationTarget,
} from '../settings/PluginMutationReview.tsx'
import { needsPageBuild, packageReach } from '../settings/pluginAssets.ts'

const COPY = defineCopy(
  {
    files: '文件',
    loading: '正在读取草稿…',
    retry: '重试',
    applied: '此版本已应用。',
    unknown: '暂时不知道这次应用是否完成。可重试同一请求。',
  },
  {
    files: 'Files',
    loading: 'Reading the draft…',
    retry: 'Retry',
    applied: 'This version is applied.',
    unknown: 'The outcome is unknown. You can retry the same request.',
  },
)

type Request = { path: string; options: ApiOptions }
type Read = { id: string; detail?: PluginPackageDetail; error?: string }

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
  pageBuilds,
  onApplied,
}: {
  id: string | undefined
  active: boolean
  /** The revision the package list last reported: a different one reads the draft again. */
  revisionHint: string | undefined
  /** The Host builds pages (format 2): such drafts are applied after their build in plugin settings. */
  pageBuilds: boolean
  onApplied: (applied: { name: string; version: string }) => void
}) {
  const mounted = useMounted()
  const [read, setRead] = useState<Read | null>(null)
  const [readAgain, setReadAgain] = useState(0)
  // Each outcome belongs to one package: another package starts clean.
  const [sent, setSent] = useState<{ id: string; request: Request } | null>(null)
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setRead(null)
    if (!active || id === undefined) return undefined
    const abort = new AbortController()
    void api<{ package: PluginPackageDetail }>('plugin-packages/' + encodeURIComponent(id), { signal: abort.signal }).then(
      value => {
        if (!abort.signal.aborted) setRead({ id, detail: value.package })
      },
      cause => {
        if (!abort.signal.aborted) setRead({ id, error: inlineError(cause) })
      },
    )
    return () => abort.abort()
  }, [active, id, revisionHint, readAgain])

  const pending = sent && sent.id === id ? sent.request : null
  const error = failure && failure.id === id ? failure.message : ''
  const detail = read && read.id === id ? read.detail : undefined
  const readError = read && read.id === id ? read.error : undefined
  const pageBuild = pageBuilds && needsPageBuild(detail?.bundle.manifest)
  const applied = detail !== undefined && detail.revision === detail.appliedRevision
  const target: PluginMutationTarget | null =
    detail && !pageBuild && !applied ? { id: detail.id, name: detail.name, operation: 'apply', revision: detail.revision } : null
  const mutation = usePluginMutationReview(active ? target : null)

  const send = async (packageId: string, request: Request, shown: { name: string; version: string }) => {
    if (busy) return
    setBusy(true)
    setFailure(null)
    setSent({ id: packageId, request })
    try {
      await withConfirmation(confirmation => api(request.path, { ...request.options, ...(confirmation ? { confirmation } : {}) }))
      if (mounted.current) {
        setSent(null)
        onApplied(shown)
      }
    } catch (cause) {
      if (mounted.current) {
        if (!isUncertain(cause)) {
          setSent(null)
          // The Host refused this revision as reviewed: show what it holds now.
          setReadAgain(count => count + 1)
        }
        setFailure({ id: packageId, message: inlineError(cause) })
      }
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const ready = target !== null && mutation.review !== null && detail !== undefined
  const apply = () => {
    if (!detail) return
    const shown = { name: detail.name, version: detail.version }
    if (pending) {
      void send(detail.id, pending, shown)
      return
    }
    if (!target || !mutation.review) return
    void send(detail.id, reviewedPluginMutation(target, mutation.review), shown)
  }

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
          <SettingsGroup title={COPY.files} bare>
            <div className="creator-plugin-review">
              <PluginFileViewer key={detail.revision} bundle={detail.bundle} />
            </div>
          </SettingsGroup>
          {applied ? (
            <p className="settings-caption">{COPY.applied}</p>
          ) : pageBuild ? (
            isPluginPackageReview(detail.review, detail.revision) && <PluginRiskFacts review={detail.review} />
          ) : (
            <PluginMutationReviewBody review={mutation.review} error={mutation.error} onRetry={mutation.retry} />
          )}
        </>
      )}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {pending && !busy && <InlineNotice tone="warn">{COPY.unknown}</InlineNotice>}
      <InlineConfirm active={busy} rank={1} />
    </div>
  )

  return {
    body,
    name: detail?.name,
    version: detail?.version,
    /** The draft's pages build in plugin settings, where their preview runs. */
    pageBuild: detail !== undefined && pageBuild,
    applied,
    /** Apply has the Host's review of the revision shown, or an unknown result to send again. */
    ready: ready || (pending !== null && detail !== undefined),
    retrying: pending !== null && !busy,
    busy,
    locked: busy,
    apply,
  }
}
