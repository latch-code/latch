import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { TEAM_LIMITS, WORK_ITEM_LIMITS, type HostCatalog, type TaskSummary } from '@latch/protocol'
import { Button, CloseGlyph, IconButton, InlineNotice, PlusGlyph, Popover, SegmentedControl, StatusWord, useLayerClose } from '@latch/ui'
import { AgentsGlyph } from '../agents/AgentAvatar.tsx'
import { DraftModelControl } from '../composer/ModelPanel.tsx'
import { readChoice, type ComposerChoice } from '../composerChoice.ts'
import { newRequestId } from '../core/api.ts'
import { useLocale } from '../core/i18n.ts'
import type { DeviceAccess } from '../core/permissions.ts'
import { ASK_AGENT_REQUEST, TEAM_COPY } from './copy.ts'
import { HarnessPick } from './HarnessPick.tsx'
import { memberChoice, memberStart, withPick } from './memberModel.ts'
import { codexTeamMessage, nextHarness, rowTooLong, tasksOf, type TeamMode, type TeamRow } from './model.ts'
import { draftKey, useTeamDraft, useTeamMode, useTeamStart } from './start.ts'

/** Where the panel's requests to an agent go: the input, for the person to finish and send. */
interface TeamPrepare {
  draft: string
  /** The input can take a request now. */
  open: boolean
  put: (value: string) => void
}

/** One message to this session, through the input's own send (its checks, queue and receipts), leaving the input as it is. */
interface TeamSend {
  /** The session would take a message now. */
  open: boolean
  /** True once the session took it; false when it was refused, nothing left, or its answer is still unknown. */
  go: (text: string) => Promise<boolean>
}

export interface TeamEntryProps {
  summary: TaskSummary
  catalog: HostCatalog
  deviceId: string
  access: Pick<DeviceAccess, 'legacy' | 'local' | 'admin' | 'scopes'>
  refresh: () => Promise<void>
  prepare: TeamPrepare
  send: TeamSend
  onManageModels?: (() => void) | undefined
  /** The Host computer's name on a page that is not the Latch app on it. */
  computer?: string | undefined
}

/** What Codex's own subagents add to the one entry: a way of working the list, and their record once they exist. */
export interface CodexNative {
  /** This session's Harness can split the work among its own subagents now. */
  available: boolean
  /** Delegations exist: the entry opens their record, and the panel is reached from there. */
  record?: { label: string; waiting?: string | undefined; open: () => void } | undefined
}

const newRow = (harnessId: string | undefined): TeamRow => ({ id: newRequestId(), text: '', harnessId: harnessId ?? '' })

/** A row's model, thinking and speed: the input box's entry for a new session, scoped to the row's Harness and its own pick. */
function MemberModel({
  catalog,
  access,
  choice,
  disabled,
  onChoice,
  refresh,
  onManageModels,
  computer,
}: {
  catalog: HostCatalog
  access: TeamEntryProps['access']
  choice: ComposerChoice
  disabled: boolean
  onChoice: (patch: Partial<ComposerChoice>) => void
  refresh: () => Promise<void>
  onManageModels?: (() => void) | undefined
  computer?: string | undefined
}) {
  return (
    <span className="team-agent-model">
      <DraftModelControl
        withLevel
        catalog={catalog}
        choice={choice}
        onChoice={onChoice}
        access={access}
        disabled={disabled}
        onManageModels={onManageModels}
        onProvidersChanged={() => {
          void refresh()
        }}
        onRead={refresh}
        computer={computer}
      />
    </span>
  )
}

function TeamPanel({
  summary,
  catalog,
  deviceId,
  access,
  refresh,
  prepare,
  send,
  onManageModels,
  computer,
  codex,
}: TeamEntryProps & { codex?: CodexNative | undefined }) {
  const close = useLayerClose()
  const ready = useMemo(() => catalog.harnesses.filter(harness => harness.status === 'ready'), [catalog.harnesses])
  const key = draftKey(deviceId, summary.id)
  const [rows, setRows] = useTeamDraft(key, () => {
    const first = newRow(nextHarness([], ready, summary.harnessId))
    return [first, newRow(nextHarness([first], ready, summary.harnessId))]
  })
  const [picked, setMode] = useTeamMode(key)
  const mode: TeamMode = codex?.available ? picked : 'sessions'
  const { status, start, forget } = useTeamStart(key, summary.id, refresh)
  const remembered = useMemo(() => readChoice(deviceId), [deviceId])
  const place = { projectId: summary.workspaceId, access }
  const choiceOf = (row: TeamRow) => {
    const base = row.harnessId ? memberChoice(catalog, remembered, row.harnessId, place) : undefined
    return base && withPick(catalog, base, row.pick)
  }
  const [delivering, setDelivering] = useState(false)
  const locked = status.state === 'sending' || status.state === 'unknown' || delivering
  const tasks = tasksOf(rows, row => memberStart(catalog, choiceOf(row)))
  const message = mode === 'codex' ? codexTeamMessage(rows) : undefined
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
    const team = await start({ tasks: tasks ?? [] })
    if (!team) return
    setRows(undefined)
    close()
  }
  // Codex's own subagents: one message to this session, sent as the input sends; the input keeps what it holds.
  const deliver = async () => {
    if (delivering || !message || message.tooLong || !send.open) return
    setDelivering(true)
    let sent = false
    try {
      sent = await send.go(message.text)
    } finally {
      setDelivering(false)
    }
    // Not taken (an unknown answer is the pending card's to settle): the list stays as written.
    if (!sent) return
    setRows(undefined)
    close()
  }
  const submit = () => void (mode === 'codex' ? deliver() : go())
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey) || event.nativeEvent.isComposing) return
    event.preventDefault()
    submit()
  }
  const slash = prepare.draft.trimStart().startsWith('/')
  const remove = (row: TeamRow, index: number) => (
    <IconButton
      size="xs"
      icon={CloseGlyph}
      className="team-task-remove"
      label={TEAM_COPY.remove(index + 1)}
      disabled={locked}
      onClick={() => {
        setRows(rows.filter(item => item.id !== row.id))
        setFocusAt(Math.min(index, rows.length - 2))
      }}
    />
  )
  return (
    <form
      className="team-panel"
      data-mode={mode}
      onKeyDown={onKeyDown}
      onSubmit={event => {
        event.preventDefault()
        submit()
      }}>
      {codex?.available && (
        <header className="team-panel-head">
          <SegmentedControl<TeamMode>
            size="sm"
            label={TEAM_COPY.modes}
            value={mode}
            disabled={locked}
            options={[
              { value: 'sessions', label: TEAM_COPY.sessionsMode, title: TEAM_COPY.sessionsModeHint },
              { value: 'codex', label: TEAM_COPY.codexMode, title: TEAM_COPY.codexModeHint },
            ]}
            onValueChange={setMode}
          />
        </header>
      )}
      <ol className="team-tasks" ref={list}>
        {rows.map((row, index) => {
          const choice = mode === 'sessions' ? choiceOf(row) : undefined
          return (
            <li key={row.id} className="team-task">
              <textarea
                className="ui-input team-task-input"
                aria-label={TEAM_COPY.task(index + 1)}
                placeholder={TEAM_COPY.taskPlaceholder}
                rows={2}
                value={row.text}
                disabled={locked}
                aria-invalid={mode === 'sessions' && rowTooLong(row) ? true : undefined}
                onChange={event => edit(row.id, { text: event.target.value })}
              />
              {mode === 'sessions' ? (
                <div className="team-task-foot">
                  <HarnessPick
                    value={row.harnessId}
                    ready={ready}
                    listed={catalog.harnesses}
                    disabled={locked}
                    // Another Harness starts on its own default again: the pick was for the one before.
                    onChange={harnessId => edit(row.id, { harnessId, pick: undefined })}
                  />
                  {choice && (
                    <MemberModel
                      catalog={catalog}
                      access={access}
                      choice={choice}
                      disabled={locked}
                      refresh={refresh}
                      onManageModels={onManageModels}
                      computer={computer}
                      onChoice={patch => {
                        const { model, config } = patch
                        edit(row.id, {
                          pick: { ...row.pick, ...('model' in patch ? { model } : {}), ...('config' in patch ? { config } : {}) },
                        })
                      }}
                    />
                  )}
                  <span className="team-task-end">
                    {rowTooLong(row) && (
                      <span className="team-task-count">{TEAM_COPY.count(row.text.trim().length, TEAM_LIMITS.promptChars)}</span>
                    )}
                    {rows.length > 1 && remove(row, index)}
                  </span>
                </div>
              ) : (
                rows.length > 1 && <span className="team-task-corner">{remove(row, index)}</span>
              )}
            </li>
          )
        })}
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
        {message?.tooLong ? (
          <span className="team-panel-count" data-over="">
            {TEAM_COPY.count(message.text.length, WORK_ITEM_LIMITS.promptChars)}
          </span>
        ) : (
          <span className="team-panel-count">{TEAM_COPY.count(rows.length, TEAM_LIMITS.members)}</span>
        )}
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
        <Button
          size="xs"
          variant="ghost"
          className="team-panel-ask"
          disabled={!prepare.open || slash || prepare.draft.startsWith(ASK_AGENT_REQUEST) || locked}
          tooltip={slash ? TEAM_COPY.slashInInput : undefined}
          onClick={() => {
            prepare.put(prepare.draft.trim() ? `${ASK_AGENT_REQUEST}\n\n${prepare.draft}` : `${ASK_AGENT_REQUEST}\n\n`)
            close()
          }}>
          {TEAM_COPY.askAgent}
        </Button>
        {mode === 'codex' ? (
          <Button
            size="sm"
            variant="primary"
            type="submit"
            disabled={!message || message.tooLong || !send.open || status.state === 'unknown'}
            loading={delivering}>
            {TEAM_COPY.start}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            type="submit"
            disabled={!tasks || status.state === 'unknown'}
            loading={status.state === 'sending'}>
            {TEAM_COPY.start}
          </Button>
        )}
      </footer>
    </form>
  )
}

/**
 * 「用团队分工」 in the input's last line: a list of tasks, started together, each as a session on the Harness and model
 * chosen for it, or, for a Codex session, as one message that has Codex split them among its own subagents. The same
 * panel offers to let the session's agent write the split; once Codex has delegated, the entry opens that record
 * (`codex.record`), which leads back here.
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
