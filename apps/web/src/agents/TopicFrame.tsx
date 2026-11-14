import type { ReactNode } from 'react'
import { Button, ScheduleGlyph, StatusWord } from '@latch/ui'

import { GENERAL_AGENT_ID } from '@latch/protocol'
import { useLastConfirmed } from '../components/SessionStatus.tsx'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { AgentFrame, TopicMenu } from './AgentFrame.tsx'
import { agentTopics } from './chat.ts'
import { askDelegateFocus } from './delegateFocus.ts'
import { draftPermission, permissionView } from '../composer/permission.ts'
import { ACTIVITY_WORDS, agentActivity, agentLiveWord, dutyLine, generalChoice, scheduleWords, sessionAgent } from './model.ts'
import { ActivityWord, IsolationNote, PermissionNote, Unavailable } from './parts.tsx'
import { helperPermissionBlocked, permissionNote } from './personWords.ts'
import { MODE_COPY } from '../core/securityCopy.ts'
import { draftConfig, startBlock, withLadderMode, type ComposerChoice } from '../composerChoice.ts'

/**
 * The frame of a conversation with `owner` as the shell draws it, on a topic (`current`) or on a new one (null): the face
 * and name open the profile, 话题 ▾ moves between topics or starts a new one. `actions` follow 话题 (a phone's panel and ⋯).
 */
export function TopicFrame({
  shell,
  owner,
  current,
  title,
  actions,
}: {
  shell: ShellState
  owner: string
  current: string | null
  /** The open topic's title. */
  title?: string | undefined
  actions?: ReactNode
}) {
  const { snapshot, connection, phone, access } = shell
  const frozen = useLastConfirmed(connection, snapshot)
  const general = owner === GENERAL_AGENT_ID
  const found = general ? undefined : snapshot.customAgents?.find(agent => agent.id === owner)
  const named = sessionAgent(snapshot, general ? { generalChat: true } : { agent: { customAgentId: owner } })
  const name = named?.name ?? 'Agent'
  const generalBlock = general ? startBlock(snapshot, generalChoice(shell.catalog ?? undefined)) : null
  const state = agentActivity(snapshot, found ?? { id: owner, available: generalBlock === null })
  const offline = connection === 'offline'
  const gone = !general && snapshot.customAgents !== undefined && !found
  const schedules = snapshot.automations?.filter(item => (general ? !item.customAgentId : item.customAgentId === owner)) ?? []
  // The permission chip is not in a helper's input, so what it would warn of is said here: the open topic's own mode
  // as its session reports it, or on a new topic what the helper's Harness declares.
  const detail = shell.current
  const topicHarness =
    current !== null && detail?.summary.id === current
      ? shell.catalog?.harnesses.find(item => item.id === detail.summary.harnessId)
      : undefined
  const fresh: ComposerChoice | undefined = general
    ? generalChoice(shell.catalog ?? undefined)
    : found
      ? { harnessId: found.harnessId, mode: found.mode, config: found.engineOptions }
      : undefined
  const freshHarness = fresh && shell.catalog?.harnesses.find(item => item.id === fresh.harnessId)
  const note = permissionNote(
    current !== null
      ? topicHarness && detail
        ? permissionView({
            harness: topicHarness,
            mode: detail.summary.mode,
            ...(detail.permission ? { permission: detail.permission } : {}),
            config: detail.config ?? [],
            access,
          })
        : undefined
      : freshHarness && fresh
        ? draftPermission(
            freshHarness,
            fresh.mode ?? 'agent',
            withLadderMode(freshHarness, draftConfig(freshHarness, fresh.config)?.config, fresh.config),
          )
        : undefined,
    current !== null && detail?.summary.id === current && helperPermissionBlocked(detail),
  )
  const boundary = (topicHarness ?? freshHarness)?.level === 'L3' ? MODE_COPY.firstStart(name).detail : undefined
  const canStart = offline
    ? 'Mac 不在线'
    : !access.scopes.has('run')
      ? '这台设备不能开始会话'
      : gone
        ? '这个 Agent 已删除'
        : found && !found.available
          ? (found.unavailableReason ?? '现在不能开始')
          : generalBlock?.message
  // The state is said once per screen: where the 顶栏 layout's queue stands beside the conversation it already says it,
  // in the same words, so the presence block does not repeat it.
  const queueSays =
    shell.preferences.workbenchLayout === 'triage' && !phone && (current === null || (!shell.drawerMode && !shell.sidebarCollapsed))
  const repair = shell.owner && found && !found.available ? () => shell.openSettings('engines') : undefined
  const word = gone ? (
    <StatusWord tone="neutral" className="agent-activity">
      已删除
    </StatusWord>
  ) : frozen === null && ACTIVITY_WORDS[state] ? (
    queueSays ? null : (
      <ActivityWord state={state} live={agentLiveWord(snapshot, owner, current)} />
    )
  ) : found && !found.available ? (
    <Unavailable reason={found.unavailableReason} onRepair={repair} />
  ) : null
  return (
    <AgentFrame
      name={name}
      layout={shell.preferences.workbenchLayout}
      duty={found ? dutyLine(found) : general ? '没选别的 Agent 的会话都带上它' : undefined}
      avatar={found?.avatar ?? 'general'}
      state={frozen !== null && (state === 'running' || state === 'waiting') ? 'idle' : state}
      word={word}
      note={
        note ? (
          <PermissionNote {...note} detail={boundary ? `${note.detail} ${boundary}` : note.detail} />
        ) : boundary ? (
          <IsolationNote name={name} />
        ) : null
      }
      topic={title}
      phone={phone}
      profileOpen={shell.profileShown !== null}
      onProfile={() => {
        shell.toggleProfile(owner)
      }}
      actions={
        <>
          {!phone && shell.catalog?.features?.automations && schedules.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="agent-schedule-chip"
              icon={ScheduleGlyph}
              onClick={() => shell.openMyAgent({ id: owner, tab: 'schedules' })}>
              <span className="agent-schedule-words">
                {schedules.length === 1 && schedules[0].enabled ? scheduleWords(schedules[0].schedule) : `${schedules.length} 个定时任务`}
              </span>
            </Button>
          )}
          <TopicMenu
            topics={agentTopics(snapshot.tasks, owner)}
            current={current}
            title={title}
            frozen={frozen !== null}
            canStart={canStart}
            compact={phone}
            onTopic={id => {
              if (id !== shell.selectedId) shell.choose(id)
              shell.setRoute({ entry: 'sessions' })
            }}
            onNewTopic={() => {
              askDelegateFocus()
              shell.openMyAgent({ id: owner, topic: 'new' })
            }}
          />
          {actions}
        </>
      }
    />
  )
}
