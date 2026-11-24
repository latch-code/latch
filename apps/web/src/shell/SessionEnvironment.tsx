import { useState, type ReactNode } from 'react'

import type { AppSnapshot, HarnessInfo, HostCatalog, SessionConfigOption, TaskDetail, TaskSummary } from '@latch/protocol'
import { Badge, CopyButton, IconButton, InlineNotice, Tooltip, FolderOpenGlyph } from '@latch/ui'
import { CodeRootNotice, codeRootWorkspace } from '../components/CodeRootNotice.tsx'
import { MiddleText } from '../components/ui.tsx'
import { escapeHiddenCharacters } from '../components/VisibleText.tsx'
import { sessionHarness } from '../composerChoice.ts'
import { costClause, sessionTotals } from '../composer/sessionTotals.ts'
import { errorMessage } from '../core/api.ts'
import type { ComposerGate } from '../core/permissions.ts'
import { parseTime, useTicker } from '../core/hostClock.ts'
import { currentShell, revealLabel, shellFolders } from '../core/shell.ts'
import { absoluteTime, basename, formatDuration, messageTime, tokenAmount } from '../format.ts'
import { folderAccessText, projectFolders } from '../projects.tsx'
import { projectOf } from '../sessions.ts'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    worktree: '工作树',
    namedFolder: (name: number) => `文件夹 · ${name}`,
    folder: '文件夹',
    missing: '找不到',
    removed: '已移出项目',
    missingFolder: '找不到这个文件夹，请同步后重试。',
    copyPath: (path: string) => `复制路径：${path}`,
    usage: '用量',
    input: '输入',
    output: '· 输出',
    cost: '费用',
    turns: '轮数',
    time: '用时',
    started: '开始于',
    readOnly: '该会话不再接受输入。',
  },
  {
    worktree: 'Worktree',
    namedFolder: (name: number) => `Folder · ${name}`,
    folder: 'Folder',
    missing: 'Missing',
    removed: 'Removed from project',
    missingFolder: 'Can’t find this folder. Sync and try again.',
    copyPath: (path: string) => `Copy path: ${path}`,
    usage: 'Usage',
    input: 'Input',
    output: '· Output',
    cost: 'Cost',
    turns: 'Turns',
    time: 'Duration',
    started: 'Started',
    readOnly: 'This session no longer accepts input.',
  },
)

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
}: {
  summary: TaskSummary
  snapshot: AppSnapshot
  local: boolean
  admin: boolean
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
      <CrumbRow label={summary.worktree ? COPY.worktree : folders.length > 1 ? COPY.namedFolder(folders.length) : COPY.folder}>
        {folders.map((folder, index) => {
          const known = project ? projectFolders(project).find(item => item.id === folder.id && item.path === folder.path) : undefined
          const removed = project !== undefined && summary.folders !== undefined && known === undefined
          const unused = index > 0 && !allFolders
          return (
            <div key={folder.id} className="crumb-folder" data-unused={unused ? '' : undefined}>
              <code>
                <MiddleText text={folder.path} />
              </code>
              {known?.unavailable ? <Badge tone="warn">{COPY.missing}</Badge> : removed ? <Badge>{COPY.removed}</Badge> : null}
              {shell && project && known && !known.unavailable && (
                <IconButton
                  size="xs"
                  label={revealLabel(currentShell()?.platform)}
                  icon={FolderOpenGlyph}
                  onClick={() => {
                    void shell
                      .reveal(project.id, known.id)
                      .then(result => {
                        if (result.status === 'failed') setError(COPY.missingFolder)
                      })
                      .catch(cause => {
                        setError(errorMessage(cause))
                      })
                  }}
                />
              )}
              <CopyButton text={folder.path} label={COPY.copyPath(basename(folder.path))} size="xs" />
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
      {codeRoot && <CodeRootNotice workspace={codeRoot} />}
    </>
  )
}

/**
 * The session's totals. The hover footer on each turn holds that turn's; these are what the whole session cost. They are
 * the same numbers as the composer's status line (`sessionTotals`), in full words.
 */
function SessionUsage({
  summary,
  detail,
  harness,
}: {
  summary: TaskSummary
  detail: TaskDetail | null
  harness: Pick<HarnessInfo, 'capabilities'> | undefined
}) {
  const now = useTicker('minute')
  const { tokens, cost, time } = sessionTotals({ summary, detail, harness })
  const created = parseTime(summary.createdAt)
  return (
    <>
      {tokens && (
        <CrumbRow label={COPY.usage}>
          <span>
            {COPY.input} {tokenAmount(tokens.usage.inputTokens)} {COPY.output} {tokenAmount(tokens.usage.outputTokens)}
          </span>
        </CrumbRow>
      )}
      {cost && (
        <CrumbRow label={COPY.cost}>
          {cost.text} · {costClause(cost.reporter)}
        </CrumbRow>
      )}
      {time && <CrumbRow label={formatDuration(time.ms) === undefined ? COPY.turns : COPY.time}>{time.text}</CrumbRow>}
      {created !== undefined && (
        <CrumbRow label={COPY.started}>
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
      <p className="crumb-note">{gate.kind === 'read-only' ? gate.text : COPY.readOnly}</p>
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
      <SessionUsage summary={summary} detail={detail} harness={harness} />
      <LockedOptions config={detail?.summary.id === summary.id ? (detail.config ?? []) : []} gate={gate} />
    </>
  )
}
