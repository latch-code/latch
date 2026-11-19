import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { TEAM_LIMITS, type HostCatalog, type TaskSummary } from '@latch/protocol'
import { Button, CloseGlyph, IconButton, InlineNotice, PlusGlyph, Popover, StatusWord, useLayerClose } from '@latch/ui'
import { AgentsGlyph } from '../agents/AgentAvatar.tsx'
import { readChoice } from '../composerChoice.ts'
import { newRequestId } from '../core/api.ts'
import { useLocale } from '../core/i18n.ts'
import { ASK_AGENT_REQUEST, TEAM_COPY } from './copy.ts'
import { HarnessPick } from './HarnessPick.tsx'
import { memberModel } from './memberModel.ts'
import { nextHarness, rowTooLong, taskOf, tasksOf, type TeamRow } from './model.ts'
import { draftKey, useTeamDraft, useTeamStart } from './start.ts'

/** Where the panel's requests to an agent go: the input, for the person to finish and send. */
interface TeamPrepare {
  draft: string
  /** The input can take a request now. */
  open: boolean
  put: (value: string) => void
}

export interface TeamEntryProps {
  summary: TaskSummary
  catalog: HostCatalog
  deviceId: string
  access: { legacy: boolean; local: boolean }
  refresh: () => Promise<void>
  prepare: TeamPrepare
}

/** What Codex's own subagents add to the one entry: their request as a third way in, and their record once they exist. */
export interface CodexNative {
  /** The request that asks Codex to split the work itself; absent while it cannot. */
  request?: string | undefined
  /** Delegations exist: the entry opens their record, and the panel is reached from there. */
  record?: { label: string; waiting?: string | undefined; open: () => void } | undefined
}

const newRow = (harnessId: string | undefined): TeamRow => ({ id: newRequestId(), text: '', harnessId: harnessId ?? '' })

function TeamPanel({ summary, catalog, deviceId, access, refresh, prepare, codex }: TeamEntryProps & { codex?: CodexNative | undefined }) {
  const close = useLayerClose()
  const ready = useMemo(() => catalog.harnesses.filter(harness => harness.status === 'ready'), [catalog.harnesses])
  const key = draftKey(deviceId, summary.id)
  const [rows, setRows] = useTeamDraft(key, () => {
    const first = newRow(nextHarness([], ready, summary.harnessId))
    return [first, newRow(nextHarness([first], ready, summary.harnessId))]
  })
  const { status, start, forget } = useTeamStart(key, summary.id, refresh)
  const remembered = useMemo(() => readChoice(deviceId), [deviceId])
  const modelOf = (harnessId: string) => memberModel(catalog, remembered, harnessId, { projectId: summary.workspaceId, access })
  const locked = status.state === 'sending' || status.state === 'unknown'
  const tasks = tasksOf(rows)
  const written = rows.filter(row => taskOf(row)).length
  // After a row is added or removed the keyboard is in a row again: the new one, or the one that took its place.
  const list = useRef<HTMLOListElement>(null)
  const [focusAt, setFocusAt] = useState<number>()
  useEffect(() => {
    if (focusAt === undefined) return
    list.current?.querySelectorAll<HTMLTextAreaElement>('textarea')[focusAt]?.focus()
    setFocusAt(undefined)
  }, [focusAt])
  const edit = (id: string, change: Partial<TeamRow>) => setRows(rows.map(row => (row.id === id ? { ...row, ...change } : row)))
  // A start that got no answer is sent again as it was: the rows stay locked until it is answered or given up.
  const go = async () => {
    if (status.state === 'sending' || (!tasks && status.state !== 'unknown')) return
    const team = await start({
      tasks: (tasks ?? []).map(task => {
        const model = modelOf(task.harnessId)
        return model ? { ...task, model } : task
      }),
    })
    if (!team) return
    setRows(undefined)
    close()
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return
    event.preventDefault()
    void go()
  }
  const slash = prepare.draft.trimStart().startsWith('/')
  const put = (request: string) => {
    prepare.put(prepare.draft.trim() ? `${request}\n\n${prepare.draft}` : `${request}\n\n`)
    close()
  }
  const ask = (label: string, request: string) => (
    <Button
      size="xs"
      variant="ghost"
      disabled={!prepare.open || slash || prepare.draft.startsWith(request) || locked}
      tooltip={slash ? TEAM_COPY.slashInInput : undefined}
      onClick={() => put(request)}>
      {label}
    </Button>
  )
  return (
    <form
      className="team-panel"
      onKeyDown={onKeyDown}
      onSubmit={event => {
        event.preventDefault()
        void go()
      }}>
      <ol className="team-tasks" ref={list}>
        {rows.map((row, index) => (
          <li key={row.id} className="team-task">
            <textarea
              className="ui-input team-task-input"
              aria-label={TEAM_COPY.task(index + 1)}
              placeholder={TEAM_COPY.taskPlaceholder}
              rows={2}
              value={row.text}
              disabled={locked}
              aria-invalid={rowTooLong(row) ? true : undefined}
              onChange={event => edit(row.id, { text: event.target.value })}
            />
            <div className="team-task-foot">
              <HarnessPick
                value={row.harnessId}
                ready={ready}
                listed={catalog.harnesses}
                model={row.harnessId ? modelOf(row.harnessId) : undefined}
                disabled={locked}
                onChange={harnessId => edit(row.id, { harnessId })}
              />
              {rowTooLong(row) && (
                <span className="team-task-count">{TEAM_COPY.count(row.text.trim().length, TEAM_LIMITS.promptChars)}</span>
              )}
              {rows.length > 1 && (
                <IconButton
                  size="xs"
                  icon={CloseGlyph}
                  label={TEAM_COPY.remove(index + 1)}
                  disabled={locked}
                  onClick={() => {
                    setRows(rows.filter(item => item.id !== row.id))
                    setFocusAt(Math.min(index, rows.length - 2))
                  }}
                />
              )}
            </div>
          </li>
        ))}
      </ol>
      <div className="team-panel-add">
        <Button
          size="xs"
          variant="ghost"
          icon={PlusGlyph}
          disabled={locked || rows.length >= TEAM_LIMITS.members}
          onClick={() => {
            setRows([...rows, newRow(nextHarness(rows, ready, summary.harnessId))])
            setFocusAt(rows.length)
          }}>
          {TEAM_COPY.add}
        </Button>
        <span className="team-panel-count">{TEAM_COPY.count(rows.length, TEAM_LIMITS.members)}</span>
      </div>
      {status.state === 'refused' && <InlineNotice tone="error">{status.reason}</InlineNotice>}
      {status.state === 'unknown' && (
        <InlineNotice
          tone="warn"
          action={
            <>
              <Button size="xs" variant="ghost" onClick={forget}>
                {TEAM_COPY.giveUp}
              </Button>
              <Button size="xs" variant="outline" onClick={() => void go()}>
                {TEAM_COPY.retry}
              </Button>
            </>
          }>
          {status.reason || TEAM_COPY.unanswered}
        </InlineNotice>
      )}
      <footer className="team-panel-foot">
        <span className="team-panel-asks">
          {ask(TEAM_COPY.askAgent, ASK_AGENT_REQUEST)}
          {codex?.request && ask(TEAM_COPY.codexNative, codex.request)}
        </span>
        <Button
          size="sm"
          variant="primary"
          type="submit"
          disabled={!tasks || status.state === 'unknown' || written === 0}
          loading={status.state === 'sending'}>
          {TEAM_COPY.start}
        </Button>
      </footer>
    </form>
  )
}

/**
 * 「用团队分工」 in the input's last line: a list of tasks, one member each, on the Harness chosen for it, started
 * together. The same panel offers to let the session's agent write the split, and, for a Codex session, Codex's own
 * subagents; once those exist the entry opens their record (`codex.record`), which leads back here.
 */
export function TeamEntry({
  codex,
  panelToggle,
  ...team
}: TeamEntryProps & {
  codex?: CodexNative | undefined
  /** Filled with how to open the panel from elsewhere (the Codex record's own 用团队分工). */
  panelToggle?: RefObject<(() => void) | undefined>
}): ReactNode {
  useLocale()
  const own = useRef<(() => void) | undefined>(undefined)
  const toggle = panelToggle ?? own
  const record = codex?.record
  return (
    <div className="codex-team-control">
      <Popover
        label={TEAM_COPY.team}
        size="lg"
        side="top"
        align="start"
        trigger={props => {
          const { onClick, ...rest } = props
          toggle.current = onClick
          return (
            <Button
              {...rest}
              variant="ghost"
              size="xs"
              className="codex-team-entry"
              onClick={() => (record ? record.open() : toggle.current?.())}>
              <AgentsGlyph size={14} />
              <span className="codex-team-label">{record ? record.label : TEAM_COPY.useTeam}</span>
              {record?.waiting && <StatusWord tone="waiting">{record.waiting}</StatusWord>}
            </Button>
          )
        }}>
        <TeamPanel {...team} codex={codex} />
      </Popover>
    </div>
  )
}
