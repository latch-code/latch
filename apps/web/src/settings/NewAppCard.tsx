import { useEffect, useRef, useState } from 'react'
import { AgentsGlyph } from '../agents/AgentAvatar.tsx'
import type {
  AppSnapshot,
  AppSummary,
  HarnessInfo,
  PluginBuild,
  PluginBuildDiagnostic,
  PluginPackageDetail,
  PluginPackageSummary,
} from '@latch/protocol'
import { Button, Dialog, Hint, Icon, InlineNotice, Switch, TextAreaField, ValuePicker, CheckGlyph, RefreshGlyph } from '@latch/ui'
import { api, inlineError, isUncertain, newRequestId, type ApiOptions } from '../core/api.ts'
import { withConfirmation } from '../core/confirmations.ts'
import { handDraft } from '../core/draftHandoff.ts'
import { harnessName } from '../composerChoice.ts'
import { InlineConfirm } from '../components/InlineConfirm.tsx'
import { AppFrame, hostInfo } from '../plugin-pages/AppFrame.tsx'
import { useSecureCover } from '../plugin-pages/secureCover.ts'
import { useShellTheme } from '../hooks/useShellTheme.ts'

export type AppPhase = 'draft' | 'building' | 'build-failed' | 'preview' | 'confirm' | 'applied'
const PHASES = [
  { id: 'draft', label: '草稿' },
  { id: 'build', label: '构建' },
  { id: 'preview', label: '预览' },
  { id: 'apply', label: '应用' },
] as const
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
function AppDraftCard({
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
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<PluginPackageDetail | null>(null)
  const [diagnostics, setDiagnostics] = useState<{ revision: string; items: PluginBuildDiagnostic[] } | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [notice, setNotice] = useState('')
  const previewSurface = useRef<HTMLDivElement>(null)
  const covered = useSecureCover(previewSurface)
  const theme = useShellTheme()
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    [],
  )
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
    if (busy) return
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
    <section className="new-app-card" aria-label={`新应用 ${record.id}`} data-phase={phase}>
      <header className="new-app-head">
        <h3>新应用</h3>
        <span className="new-app-id">{record.id}</span>
        <span className="new-app-spacer" />
        {source && <span className="new-app-dev">开发中</span>}
        {source && (
          <Switch
            label="开发中"
            checked={source.dev}
            disabled={busy !== null}
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
      <ol className="new-app-phases" aria-label="进度">
        {PHASES.map((step, index) => (
          <li
            key={step.id}
            data-s={marks[index] || undefined}
            aria-current={marks[index] === 'now' || marks[index] === 'wait' ? 'step' : undefined}>
            <i aria-hidden="true" />
            <span>{step.label}</span>
          </li>
        ))}
      </ol>
      {source && (
        <div className="new-app-source">
          <Icon icon={AgentsGlyph} size={14} />
          <span>来自会话</span>
          {onOpenSession && sessionTitle ? (
            <Button variant="ghost" size="xs" onClick={() => onOpenSession(source.sessionId)}>
              {sessionTitle.length > 32 ? `${sessionTitle.slice(0, 31)}…` : sessionTitle}
            </Button>
          ) : (
            <span>{sessionTitle ?? '已删除的会话'}</span>
          )}
          {sessionTitle && (
            <Button variant="ghost" size="xs" icon={RefreshGlyph} disabled={busy !== null} onClick={reimport}>
              从会话更新
            </Button>
          )}
        </div>
      )}
      {(failed || (lines.length > 0 && phase !== 'applied')) && (
        <InlineNotice tone="error" title={build?.status === 'timeout' ? '构建超时' : '构建没通过'} className="new-app-failure">
          {lines.length > 0 && (
            <pre className="new-app-diagnostics">{(showAll ? lines : lines.slice(0, 5)).map(diagnosticLine).join('\n')}</pre>
          )}
          {lines.length > 5 && !showAll && (
            <Button variant="ghost" size="xs" onClick={() => setShowAll(true)}>
              {`全部 ${lines.length} 条`}
            </Button>
          )}
        </InlineNotice>
      )}
      {pagePreview && phase !== 'applied' && (
        <div className="new-app-preview">
          <div className="new-app-preview-label">
            <span className="new-app-tag">预览</span>
            <Hint label="无凭据">预览不连接 Latch、不读密钥、不开会话；数据只在这一页里。</Hint>
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
                if (outcome.kind === 'failed') setNotice(`预览没有打开：${outcome.message}`)
              }}
              onOpenSession={() => {}}
              onShortcut={() => {}}
              onEscape={() => {}}
              preview={{
                moduleUrl: `${route(record.id)}/builds/${pagePreview.bundleHash}.js`,
                ...(app?.preview?.tasks ? { tasks: app.preview.tasks } : {}),
                onPreviewOnly: () => setNotice('预览里不会开会话'),
              }}
            />
          </div>
          {notice && <p className="new-app-notice">{notice}</p>}
        </div>
      )}
      {phase === 'applied' && (
        <div className="new-app-applied">
          <Icon icon={CheckGlyph} size={16} />
          <strong>已应用</strong>
          <span className="new-app-meta">{`· ${record.id} ${record.version}`}</span>
          <span className="new-app-spacer" />
          {app && onOpenApp && record.enabled && (
            <Button variant="ghost" onClick={() => onOpenApp({ pluginId: record.id, appId: app.id })}>
              打开
            </Button>
          )}
        </div>
      )}
      {phase === 'confirm' && <InlineConfirm active rank={1} className="new-app-confirm" />}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {pending && !busy && (
        <InlineNotice tone="warn" action={<Button onClick={() => void perform(pending)}>重试同一请求</Button>}>
          结果尚未确认。
        </InlineNotice>
      )}
      {phase !== 'applied' && phase !== 'confirm' && (
        <footer className="new-app-foot">
          {phase === 'building' && <Hint label="用 Latch 自带的工具构建">构建只读导入时的快照，不运行草稿里的代码。</Hint>}
          {phase === 'preview' && <Hint label="应用要在这台 Mac 上确认一次">能力变多时要确认；确认后侧栏出现入口。</Hint>}
          <span className="new-app-spacer" />
          {!applied && (phase === 'draft' || failed) && (
            <Button
              variant="ghost"
              disabled={busy !== null}
              onClick={() => {
                void perform({
                  kind: 'discard',
                  path: route(record.id),
                  options: { method: 'DELETE', body: { requestId: newRequestId(), baseRevision: record.revision } },
                })
              }}>
              丢弃
            </Button>
          )}
          {failed && source && sessionTitle ? (
            <Button
              variant="primary"
              disabled={busy !== null || lines.length === 0}
              onClick={() => {
                handDraft(source.sessionId, handBackText(lines))
                onOpenSession?.(source.sessionId)
              }}>
              交回 Agent
            </Button>
          ) : phase === 'preview' ? (
            <Button
              variant="primary"
              loading={busy === 'apply'}
              disabled={busy !== null}
              onClick={() => {
                void perform({
                  kind: 'apply',
                  path: `${route(record.id)}/apply`,
                  options: { method: 'POST', body: { requestId: newRequestId(), revision: record.revision } },
                })
              }}>
              {applied ? '应用新版本' : '应用'}
            </Button>
          ) : (
            <Button
              variant="primary"
              loading={phase === 'building'}
              disabled={busy !== null}
              onClick={() => {
                void perform({
                  kind: 'build',
                  path: `${route(record.id)}/build`,
                  options: { method: 'POST', timeoutMs: 90_000, body: { requestId: newRequestId(), revision: record.revision } },
                })
              }}>
              {failed ? '重新构建' : '构建'}
            </Button>
          )}
        </footer>
      )}
    </section>
  )
}

const DEFAULT_PROMPT = '做一个页面：'

/** 让 Agent 做: a normal session in its own folder, which the Host gives a draft skeleton and guide before the first input. */
function AgentDraftDialog({
  harnesses,
  onClose,
  onStarted,
}: {
  harnesses: HarnessInfo[]
  onClose: () => void
  onStarted: (sessionId: string) => void
}) {
  const usable = harnesses.filter(harness => harness.status === 'ready' && harness.modes.includes('agent'))
  const [harnessId, setHarnessId] = useState(usable[0]?.id ?? '')
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = useRef(newRequestId())
  const start = async () => {
    setBusy(true)
    setError('')
    try {
      const body = {
        requestId: request.current,
        prompt: `${prompt.trim()}\n\n按 latch-app/README.md 写这个 Latch 应用，只改 latch-app/ 里的文件。`,
        mode: 'agent',
        harnessId,
        appDraft: true,
      }
      const result = await withConfirmation(confirmation =>
        api<{ sessionId: string }>('tasks', { method: 'POST', body, ...(confirmation ? { confirmation } : {}) }),
      )
      onStarted(result.sessionId)
    } catch (cause) {
      if (!isUncertain(cause)) request.current = newRequestId()
      setError(inlineError(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      title="让 Agent 做"
      size="lg"
      className="agent-draft-dialog"
      onClose={() => {
        if (!busy) onClose()
      }}
      footer={
        <Button
          variant="primary"
          loading={busy}
          disabled={!harnessId || prompt.trim() === DEFAULT_PROMPT.trim() || !prompt.trim()}
          onClick={() => void start()}>
          开始
        </Button>
      }>
      <div className="settings-form">
        <TextAreaField label="想要的页面" rows={4} value={prompt} maxLength={4000} onChange={event => setPrompt(event.target.value)} />
        {usable.length > 1 && (
          <div className="agent-draft-harness">
            <span className="ui-field-label">Harness</span>
            <ValuePicker
              label="Harness"
              value={harnessId}
              options={usable.map(harness => ({ value: harness.id, label: harnessName(harness) }))}
              onValueChange={setHarnessId}
              disabled={busy}
            />
          </div>
        )}
        {usable.length === 0 && <InlineNotice tone="warn">没有可以用 Agent 模式开始的 Harness。</InlineNotice>}
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
        <InlineConfirm active={busy} rank={1} />
      </div>
    </Dialog>
  )
}

/**
 * 设置 › 插件's 「新应用」: drafts imported from sessions, each with its steps, and 让 Agent 做. Only on this Mac's admin
 * device with all data; the Host checks again.
 */
export function NewApps({
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
  const [asking, setAsking] = useState(false)
  const drafts = records.filter(record => record.source)
  return (
    <div className="new-apps">
      <div className="new-apps-head">
        <h3>新应用</h3>
        <Button icon={AgentsGlyph} onClick={() => setAsking(true)}>
          让 Agent 做
        </Button>
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
      {asking && (
        <AgentDraftDialog
          harnesses={snapshot.catalog?.harnesses ?? []}
          onClose={() => setAsking(false)}
          onStarted={sessionId => {
            setAsking(false)
            onChanged()
            onOpenSession?.(sessionId)
          }}
        />
      )}
    </div>
  )
}
