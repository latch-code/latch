import { useState, type ReactNode } from 'react'
import { FolderOpen } from 'lucide-react'
import type { AppSnapshot, HarnessInfo, HostCatalog, SessionConfigOption, TaskDetail, TaskSummary } from '@latch/protocol'
import { Badge, CopyButton, IconButton, InlineNotice, Tooltip } from '@latch/ui'
import { CodeRootNotice, codeRootWorkspace } from '../components/CodeRootNotice.tsx'
import { MiddleText } from '../components/ui.tsx'
import { escapeHiddenCharacters } from '../components/VisibleText.tsx'
import { sessionHarness } from '../composerChoice.ts'
import { turnsOf } from '../conversation.ts'
import { errorMessage } from '../core/api.ts'
import type { ComposerGate } from '../core/permissions.ts'
import { parseDuration, parseTime, useTicker } from '../core/hostClock.ts'
import { currentShell, revealLabel, shellFolders } from '../core/shell.ts'
import { absoluteTime, basename, currencyAmount, formatDuration, messageTime, tokenAmount, tokenLines } from '../format.ts'
import { folderAccessText, projectFolders } from '../projects.tsx'
import { projectOf } from '../sessions.ts'

export function CrumbRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="crumb-row">
      <span className="crumb-label">{label}</span>
      <div className="crumb-value">{children}</div>
    </div>
  )
}

/** A folder of the project that is still the one the session froze: only that one may be opened in its name. */
export function liveFolder(
  project: HostCatalog['workspaces'][number] | undefined,
  frozen: ReadonlyArray<{ id: string; path: string }> | undefined,
  rootId: string,
) {
  const known = project ? projectFolders(project).find(item => item.id === rootId) : undefined
  if (!known || known.unavailable) return undefined
  return !frozen || frozen.some(folder => folder.id === known.id && folder.path === known.path) ? known : undefined
}

export const frozenFolders = (summary: TaskSummary) =>
  summary.folders?.length ? summary.folders : summary.cwd ? [{ id: 'default', path: summary.cwd }] : []

/**
 * The session's folders as it froze them, with what became of each since: a folder can go missing or leave the project
 * while the session keeps its old path. Copy and reveal live here because this is where the path is read.
 */
export function SessionFolders({
  summary,
  snapshot,
  local,
  admin,
  onNewProject,
}: {
  summary: TaskSummary
  snapshot: AppSnapshot
  local: boolean
  admin: boolean
  onNewProject?: () => void
}) {
  const [error, setError] = useState('')
  const catalog = snapshot.catalog
  const harness = sessionHarness(catalog, summary)
  const project = catalog ? projectOf(summary, catalog.workspaces) : undefined
  const folders = frozenFolders(summary)
  const shell = local && admin ? shellFolders() : null
  const allFolders = harness?.projectFolders?.access === 'all'
  const codeRoot = summary.cwd ? codeRootWorkspace(catalog?.workspaces, { path: summary.cwd }) : undefined
  if (summary.mode === 'chat' || folders.length === 0) return null
  return (
    <>
      <CrumbRow label={folders.length > 1 ? `文件夹 · ${folders.length}` : '文件夹'}>
        {folders.map((folder, index) => {
          const known = project ? projectFolders(project).find(item => item.id === folder.id && item.path === folder.path) : undefined
          const removed = project !== undefined && summary.folders !== undefined && known === undefined
          const unused = index > 0 && !allFolders
          return (
            <div key={folder.id} className="crumb-folder" data-unused={unused ? '' : undefined}>
              <code>
                <MiddleText text={folder.path} />
              </code>
              {known?.unavailable ? <Badge tone="warn">找不到</Badge> : removed ? <Badge>已移出项目</Badge> : null}
              {shell && project && known && !known.unavailable && (
                <IconButton
                  size="xs"
                  label={revealLabel(currentShell()?.platform)}
                  icon={FolderOpen}
                  onClick={() => {
                    void shell
                      .reveal(project.id, known.id)
                      .then(result => {
                        if (result.status === 'failed') setError('找不到这个文件夹，请同步后重试。')
                      })
                      .catch(cause => {
                        setError(errorMessage(cause))
                      })
                  }}
                />
              )}
              <CopyButton text={folder.path} label={`复制路径：${basename(folder.path)}`} size="xs" />
            </div>
          )
        })}
        {folders.length > 1 && harness && !allFolders && (
          <p className="crumb-note">
            {harness.capabilities.display.label}：{folderAccessText(harness, folders.length)}
          </p>
        )}
      </CrumbRow>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {codeRoot && <CodeRootNotice workspace={codeRoot} {...(onNewProject ? { onNewProject } : {})} />}
    </>
  )
}

/** The session's totals. The hover footer on each turn holds that turn's; these are what the whole session cost. */
function SessionUsage({ summary, detail, agentReported }: { summary: TaskSummary; detail: TaskDetail | null; agentReported: boolean }) {
  const now = useTicker('minute')
  const own = detail?.summary.id === summary.id ? detail : null
  const usage = summary.usage
  const report = own?.usageReport
  const timed = (own ? turnsOf(own.messages) : []).flatMap(turn => {
    const active = parseDuration(turn.user?.turn?.activeMs)
    return active === undefined || turn.user?.turn?.endedAt === undefined ? [] : [active]
  })
  const created = parseTime(summary.createdAt)
  const [inputLine, outputLine] = usage ? tokenLines(usage) : []
  return (
    <>
      {usage && (
        <CrumbRow label="用量">
          <Tooltip content={`${inputLine}；${outputLine}${agentReported ? '，由 Harness 报告' : ''}`}>
            <span tabIndex={0}>
              输入 {tokenAmount(usage.inputTokens)} · 输出 {tokenAmount(usage.outputTokens)}
            </span>
          </Tooltip>
        </CrumbRow>
      )}
      {report?.cost && (
        <CrumbRow label="费用">
          {report.cost.amount > 0 && report.cost.amount < 0.01 ? '<$0.01' : currencyAmount(report.cost.amount, report.cost.currency)}
          {' · 由 Harness 报告，不是账单'}
        </CrumbRow>
      )}
      {timed.length > 0 && (
        <CrumbRow label="用时">
          {[formatDuration(timed.reduce((sum, value) => sum + value, 0)), `${timed.length} 轮`].filter(Boolean).join(' · ')}
        </CrumbRow>
      )}
      {created !== undefined && (
        <CrumbRow label="开始于">
          <Tooltip content={absoluteTime(created)}>
            <time dateTime={new Date(created).toISOString()} tabIndex={0}>
              {messageTime(created, now)}
            </time>
          </Tooltip>
        </CrumbRow>
      )}
    </>
  )
}

/** A session that takes no input has no composer controls to read its options from, so they are stated here with the reason. */
function LockedOptions({ config, gate }: { config: readonly SessionConfigOption[]; gate: ComposerGate }) {
  if (gate.kind === 'open' || config.length === 0) return null
  return (
    <>
      {config.map(option => (
        <CrumbRow key={option.id} label={escapeHiddenCharacters(option.name)}>
          {escapeHiddenCharacters(option.options.find(item => item.value === option.currentValue)?.name ?? option.currentValue)}
        </CrumbRow>
      ))}
      <p className="crumb-note">{gate.kind === 'read-only' ? gate.text : '该会话不再接受输入。'}</p>
    </>
  )
}

/** What the title row's popover says below the folders, and a launcher says for a session without that popover. */
export function SessionFacts({
  summary,
  detail,
  harness,
  gate,
}: {
  summary: TaskSummary
  detail: TaskDetail | null
  harness: Pick<HarnessInfo, 'capabilities'> | undefined
  gate: ComposerGate
}) {
  return (
    <>
      <SessionUsage summary={summary} detail={detail} agentReported={harness?.capabilities.models.owner === 'harness'} />
      <LockedOptions config={detail?.summary.id === summary.id ? (detail.config ?? []) : []} gate={gate} />
    </>
  )
}
