import { useEffect, useRef, useState } from 'react'
import { AgentsGlyph } from '../agents/AgentAvatar.tsx'
import type {
  AppSnapshot,
  AppSummary,
  PluginBuild,
  PluginBuildDiagnostic,
  PluginPackageDetail,
  PluginPackageSummary,
} from '@latch/protocol'
import { Button, Hint, Icon, InlineNotice, Switch, CheckGlyph, RefreshGlyph } from '@latch/ui'
import { api, inlineError, isUncertain, newRequestId, type ApiOptions } from '../core/api.ts'
import { withConfirmation } from '../core/confirmations.ts'
import { handDraft } from '../core/draftHandoff.ts'
import { InlineConfirm } from '../components/InlineConfirm.tsx'
import { AppFrame, hostInfo } from '../plugin-pages/AppFrame.tsx'
import { useSecureCover } from '../plugin-pages/secureCover.ts'
import { useShellTheme } from '../hooks/useShellTheme.ts'
import { useMounted } from '../hooks/useMounted.ts'
import { defineCopy, formatNumber, plural } from '../core/i18n.ts'
import { PluginMutationDialog, reviewedPluginMutation, type PluginMutationTarget } from './PluginMutationReview.tsx'

const COPY = defineCopy(
  {
    draft: '草稿',
    build: '构建',
    preview: '预览',
    apply: '应用',
    newApp: '新应用',
    inDevelopment: '开发中',
    progress: '进度',
    sourceSession: '来自会话',
    deletedSession: '已删除的会话',
    refreshSession: '从会话更新',
    buildTimedOut: '构建超时',
    buildFailed: '构建没通过',
    noCredentials: '无凭据',
    previewScope: '预览不连接 Latch、不读密钥、不开会话；数据只在这一页里。',
    sample: '样例预览',
    previousSample: '上次构建成功的样例预览',
    previewNoSessions: '预览里不会开会话',
    applied: '已应用',
    open: '打开',
    retrySame: '重试同一请求',
    unknown: '结果尚未确认。',
    builtInBuilder: '用 Latch 自带的工具构建',
    buildScope: '构建只读导入时的快照，不运行草稿里的代码。',
    approveOnMac: '页面权限',
    approveScope: '首次应用或增加页面能力时，在这台 Mac 上确认。应用后可从侧栏打开。',
    discard: '丢弃',
    returnToAgent: '交回 Agent',
    applyVersion: '应用新版本',
    rebuild: '重新构建',
    pageDrafts: '页面草稿',
    appId: (id: string) => `新应用 ${id}`,
    allDiagnostics: (count: number) => `全部 ${formatNumber(count)} 条`,
    previewFailed: (message: string) => `预览没有打开：${message}`,
  },
  {
    draft: 'Draft',
    build: 'Build',
    preview: 'Preview',
    apply: 'Apply',
    newApp: 'New app',
    inDevelopment: 'In development',
    progress: 'Progress',
    sourceSession: 'From session',
    deletedSession: 'Deleted session',
    refreshSession: 'Refresh from session',
    buildTimedOut: 'Build timed out',
    buildFailed: 'Build failed',
    noCredentials: 'No credentials',
    previewScope: 'The preview stays on this page. It cannot connect to Latch, read secrets or start sessions.',
    sample: 'Sample preview',
    previousSample: 'Sample preview from the last successful build',
    previewNoSessions: 'The preview cannot start sessions',
    applied: 'Applied',
    open: 'Open',
    retrySame: 'Retry same request',
    unknown: 'Result unknown.',
    builtInBuilder: 'Build with Latch tools',
    buildScope: 'The builder reads the imported snapshot. Draft code does not run during the build.',
    approveOnMac: 'Page permissions',
    approveScope: 'Confirm on this Mac the first time you apply a page or add capabilities. The applied page is available in the sidebar.',
    discard: 'Discard',
    returnToAgent: 'Hand back to Agent',
    applyVersion: 'Apply new version',
    rebuild: 'Rebuild',
    pageDrafts: 'Page drafts',
    appId: (id: string) => `New app ${id}`,
    allDiagnostics: (count: number) => plural(count, { one: 'All {n} diagnostic', other: 'All {n} diagnostics' }),
    previewFailed: (message: string) => `Couldn’t open the preview. ${message}`,
  },
)

export type AppPhase = 'draft' | 'building' | 'build-failed' | 'preview' | 'confirm' | 'applied'
const PHASES = ['draft', 'build', 'preview', 'apply'] as const
const AT: Record<AppPhase, number> = { draft: 0, building: 1, 'build-failed': 1, preview: 2, confirm: 3, applied: 4 }

/** Where a draft from a session stands: the four steps 草稿 › 构建 › 预览 › 应用. */
export function appPhase(record: PluginPackageSummary, busy: 'build' | 'apply' | null): AppPhase {
  if (busy === 'apply') return 'confirm'
  if (busy === 'build') return 'building'
  if (record.state === 'applied') return 'applied'
  if (!record.build) return 'draft'
  return record.build.status === 'ok' ? 'preview' : 'build-failed'
}

/** Each step's mark: done, now, failed, or waiting for this Mac. */
export function phaseMarks(phase: AppPhase): Array<'done' | 'now' | 'fail' | 'wait' | ''> {
  const at = AT[phase]
  return PHASES.map((_, index) => {
    if (phase === 'build-failed' && index === 1) return 'fail'
    if (phase === 'confirm' && index === 3) return 'wait'
    return index < at ? 'done' : index === at ? 'now' : ''
  })
}

/** A diagnostic as one line: `file:line:col  message`. */
export const diagnosticLine = (item: PluginBuildDiagnostic) =>
  `${item.file ? `${item.file}${item.line ? `:${item.line}:${item.column ?? 1}` : ''}  ` : ''}${item.message}`

/** What 交回 Agent puts in the source session's draft; it is never sent from here. */
export function handBackText(diagnostics: readonly PluginBuildDiagnostic[]): string {
  const lines = diagnostics.slice(0, 30).map(diagnosticLine)
  return `Latch 构建 latch-app/ 没通过（${diagnostics.length} 条）。请按下面的诊断修改，只改 latch-app/ 里的文件：\n\n\`\`\`\n${lines.join('\n')}${diagnostics.length > lines.length ? `\n…另有 ${diagnostics.length - lines.length} 条` : ''}\n\`\`\``
}

const route = (id: string) => 'plugin-packages/' + encodeURIComponent(id)

interface Pending {
  kind: 'build' | 'apply' | 'dev' | 'import' | 'discard'
  path: string
  options: ApiOptions
}

/**
 * One draft imported from a session: its four steps, the build's diagnostics, the preview (same frame and bundle, no
 * credentials) and 应用. Every write keeps its request ID; an unknown result is retried with the same request.
 */
export function AppDraftCard({
  record,
  snapshot,
  onChanged,
  onOpenSession,
  onOpenApp,
}: {
  record: PluginPackageSummary
  snapshot: AppSnapshot
  onChanged: () => void
  onOpenSession?: (id: string) => void
  onOpenApp?: (target: { pluginId: string; appId: string }) => void
}) {
  const [busy, setBusy] = useState<Pending['kind'] | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [reviewTarget, setReviewTarget] = useState<PluginMutationTarget | null>(null)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<PluginPackageDetail | null>(null)
  const [diagnostics, setDiagnostics] = useState<{ revision: string; items: PluginBuildDiagnostic[] } | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [notice, setNotice] = useState('')
  const previewSurface = useRef<HTMLDivElement>(null)
  const covered = useSecureCover(previewSurface)
  const theme = useShellTheme()
  const alive = useMounted()
  // The manifest (page titles, preview samples) of the draft revision.
  useEffect(() => {
    let live = true
    void api<{ package: PluginPackageDetail }>(route(record.id)).then(
      value => {
        if (live) setDetail(value.package)
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [record.id, record.revision])
  const build = record.build
  // A failed build's own lines, for the card and 交回 Agent.
  useEffect(() => {
    if (!build || build.diagnostics === 0) {
      setDiagnostics(null)
      return undefined
    }
    let live = true
    void api<{ build: PluginBuild }>(`${route(record.id)}/build?revision=${build.revision}`).then(
      value => {
        if (live) setDiagnostics({ revision: value.build.revision, items: value.build.diagnostics })
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [record.id, build?.id])

  const perform = async (change: Pending) => {
    if (busy || (pending && pending !== change)) return
    setBusy(change.kind)
    setPending(change)
    setError('')
    try {
      await withConfirmation(confirmation => api(change.path, { ...change.options, ...(confirmation ? { confirmation } : {}) }))
      if (alive.current) setPending(null)
      onChanged()
    } catch (cause) {
      if (alive.current) {
        if (!isUncertain(cause)) setPending(null)
        setError(inlineError(cause))
      }
    } finally {
      if (alive.current) setBusy(null)
    }
  }
  const phase = appPhase(record, busy === 'build' || busy === 'apply' ? busy : null)
  const locked = busy !== null || pending !== null || reviewTarget !== null
  const marks = phaseMarks(phase)
  const source = record.source
  const sessionTitle = source ? snapshot.tasks.find(task => task.id === source.sessionId)?.title : undefined
  const manifest = detail?.revision === record.revision ? detail.bundle.manifest : undefined
  const app = manifest?.apps?.[0]
  const preview = record.preview?.modules.find(module => module.appId === (app?.id ?? record.preview?.modules[0]?.appId))
  const failed = phase === 'build-failed'
  const lines = diagnostics?.revision === build?.revision ? (diagnostics?.items ?? []) : []
  const reimport = () => {
    if (!source) return
    void perform({
      kind: 'import',
      path: 'plugin-packages/import',
      options: { method: 'POST', body: { requestId: newRequestId(), sessionId: source.sessionId } },
    })
  }
  const applied = record.appliedRevision !== undefined
  const pagePreview =
    preview && app
      ? ({
          pluginId: record.id,
          appId: preview.appId,
          title: app.title,
          pluginName: record.name,
          version: record.version,
          revision: record.preview!.revision,
          capabilities: app.capabilities,
          dataVersion: app.dataVersion,
          status: 'ready',
          bundleHash: preview.bundleHash,
        } satisfies AppSummary & { bundleHash: string })
      : undefined

  return (
    <section className="new-app-card" aria-label={COPY.appId(record.id)} data-phase={phase}>
      <header className="new-app-head">
        <h3>{COPY.newApp}</h3>
        <span className="new-app-id">{record.id}</span>
        <span className="new-app-spacer" />
        {source && <span className="new-app-dev">{COPY.inDevelopment}</span>}
        {source && (
          <Switch
            label={COPY.inDevelopment}
            checked={source.dev}
            disabled={locked}
            onCheckedChange={dev => {
              void perform({
                kind: 'dev',
                path: `${route(record.id)}/dev`,
                options: { method: 'POST', body: { requestId: newRequestId(), dev } },
              })
            }}
          />
        )}
      </header>
      <ol className="new-app-phases" aria-label={COPY.progress}>
        {PHASES.map((step, index) => (
          <li
            key={step}
            data-s={marks[index] || undefined}
            aria-current={marks[index] === 'now' || marks[index] === 'wait' ? 'step' : undefined}>
            <i aria-hidden="true" />
            <span>{COPY[step]}</span>
          </li>
        ))}
      </ol>
      {source && (
        <div className="new-app-source">
          <Icon icon={AgentsGlyph} size={14} />
          <span>{COPY.sourceSession}</span>
          {onOpenSession && sessionTitle ? (
            <Button variant="ghost" size="xs" onClick={() => onOpenSession(source.sessionId)}>
              {sessionTitle.length > 32 ? `${sessionTitle.slice(0, 31)}…` : sessionTitle}
            </Button>
          ) : (
            <span>{sessionTitle ?? COPY.deletedSession}</span>
          )}
          {sessionTitle && (
            <Button variant="ghost" size="xs" icon={RefreshGlyph} disabled={locked} onClick={reimport}>
              {COPY.refreshSession}
            </Button>
          )}
        </div>
      )}
      {(failed || (lines.length > 0 && phase !== 'applied')) && (
        <InlineNotice tone="error" title={build?.status === 'timeout' ? COPY.buildTimedOut : COPY.buildFailed} className="new-app-failure">
          {lines.length > 0 && (
            <pre className="new-app-diagnostics">{(showAll ? lines : lines.slice(0, 5)).map(diagnosticLine).join('\n')}</pre>
          )}
          {lines.length > 5 && !showAll && (
            <Button variant="ghost" size="xs" onClick={() => setShowAll(true)}>
              {COPY.allDiagnostics(lines.length)}
            </Button>
          )}
        </InlineNotice>
      )}
      {pagePreview && phase !== 'applied' && (
        <div className="new-app-preview">
          <div className="new-app-preview-label">
            <span className="new-app-tag">
              {failed || record.preview?.revision !== record.revision ? COPY.previousSample : COPY.sample}
            </span>
            <Hint label={COPY.noCredentials}>{COPY.previewScope}</Hint>
          </div>
          <div ref={previewSurface} className="new-app-preview-frame">
            <AppFrame
              key={`${pagePreview.revision}:${pagePreview.bundleHash}`}
              page={pagePreview}
              snapshot={snapshot}
              online
              info={hostInfo(theme, true, false, { preview: true })}
              covered={covered}
              onOutcome={outcome => {
                if (outcome.kind === 'failed') setNotice(COPY.previewFailed(outcome.message))
              }}
              onOpenSession={() => {}}
              onShortcut={() => {}}
              onEscape={() => {}}
              preview={{
                moduleUrl: `${route(record.id)}/builds/${pagePreview.bundleHash}.js`,
                ...(app?.preview?.tasks ? { tasks: app.preview.tasks } : {}),
                onPreviewOnly: () => setNotice(COPY.previewNoSessions),
              }}
            />
          </div>
          {notice && <p className="new-app-notice">{notice}</p>}
        </div>
      )}
      {phase === 'applied' && (
        <div className="new-app-applied">
          <Icon icon={CheckGlyph} size={16} />
          <strong>{COPY.applied}</strong>
          <span className="new-app-meta">{`· ${record.id} ${record.version}`}</span>
          <span className="new-app-spacer" />
          {app && onOpenApp && record.enabled && (
            <Button variant="ghost" onClick={() => onOpenApp({ pluginId: record.id, appId: app.id })}>
              {COPY.open}
            </Button>
          )}
        </div>
      )}
      {phase === 'confirm' && <InlineConfirm active rank={1} className="new-app-confirm" />}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {pending && !busy && (
        <InlineNotice tone="warn" action={<Button onClick={() => void perform(pending)}>{COPY.retrySame}</Button>}>
          {COPY.unknown}
        </InlineNotice>
      )}
      {phase !== 'applied' && phase !== 'confirm' && (
        <footer className="new-app-foot">
          {phase === 'building' && <Hint label={COPY.builtInBuilder}>{COPY.buildScope}</Hint>}
          {phase === 'preview' && <Hint label={COPY.approveOnMac}>{COPY.approveScope}</Hint>}
          <span className="new-app-spacer" />
          {!applied && (phase === 'draft' || failed) && (
            <Button
              variant="ghost"
              disabled={locked}
              onClick={() => {
                void perform({
                  kind: 'discard',
                  path: route(record.id),
                  options: { method: 'DELETE', body: { requestId: newRequestId(), baseRevision: record.revision } },
                })
              }}>
              {COPY.discard}
            </Button>
          )}
          {failed && source && sessionTitle && onOpenSession && lines.length > 0 ? (
            <Button
              variant="primary"
              disabled={locked}
              onClick={() => {
                handDraft(source.sessionId, handBackText(lines))
                onOpenSession(source.sessionId)
              }}>
              {COPY.returnToAgent}
            </Button>
          ) : phase === 'preview' ? (
            <Button
              variant="primary"
              loading={busy === 'apply'}
              disabled={locked}
              onClick={() => {
                setReviewTarget({ operation: 'apply', id: record.id, name: record.name, revision: record.revision })
              }}>
              {applied ? COPY.applyVersion : COPY.apply}
            </Button>
          ) : (
            <Button
              variant="primary"
              loading={phase === 'building'}
              disabled={locked}
              onClick={() => {
                void perform({
                  kind: 'build',
                  path: `${route(record.id)}/build`,
                  options: { method: 'POST', timeoutMs: 90_000, body: { requestId: newRequestId(), revision: record.revision } },
                })
              }}>
              {failed ? COPY.rebuild : COPY.build}
            </Button>
          )}
        </footer>
      )}
      {reviewTarget && (
        <PluginMutationDialog
          target={reviewTarget}
          onClose={() => setReviewTarget(null)}
          onConfirm={review => {
            const request = reviewedPluginMutation(reviewTarget, review)
            setReviewTarget(null)
            void perform({ ...request, kind: 'apply' })
          }}
        />
      )}
    </section>
  )
}

export function PageDrafts({
  records,
  snapshot,
  onChanged,
  onOpenSession,
  onOpenApp,
}: {
  records: readonly PluginPackageSummary[]
  snapshot: AppSnapshot
  onChanged: () => void
  onOpenSession?: (id: string) => void
  onOpenApp?: (target: { pluginId: string; appId: string }) => void
}) {
  const drafts = records.filter(record => record.source && record.source.kind !== 'plugin')
  if (drafts.length === 0) return null
  return (
    <div className="new-apps">
      <div className="new-apps-head">
        <h3>{COPY.pageDrafts}</h3>
      </div>
      {drafts.map(record => (
        <AppDraftCard
          key={record.id}
          record={record}
          snapshot={snapshot}
          onChanged={onChanged}
          {...(onOpenSession ? { onOpenSession } : {})}
          {...(onOpenApp ? { onOpenApp } : {})}
        />
      ))}
    </div>
  )
}
