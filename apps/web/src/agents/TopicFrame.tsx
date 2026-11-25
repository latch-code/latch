import { useEffect, type ReactNode } from 'react'
import { Button, ScheduleGlyph, StatusWord } from '@latch/ui'
import { api } from '../core/api.ts'
import { defineCopy, formatNumber, plural } from '../core/i18n.ts'

import { GENERAL_AGENT_ID } from '@latch/protocol'
import { useLastConfirmed } from '../components/SessionStatus.tsx'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { AgentFrame } from './AgentFrame.tsx'
import { personalChat } from './chat.ts'
import { draftPermission, permissionView } from '../composer/permission.ts'
import { ACTIVITY_WORDS, agentActivity, agentLiveWord, dutyLine, generalChoice, readsAgents, scheduleWords, sessionAgent } from './model.ts'
import { ActivityWord, IsolationNote, PermissionNote, Unavailable } from './parts.tsx'
import { helperPermissionBlocked, permissionNote } from './personWords.ts'
import { MODE_COPY } from '../core/securityCopy.ts'
import { draftConfig, startBlock, withLadderMode, type ComposerChoice } from '../composerChoice.ts'
import { AGENT_SPACE_COPY } from './spaceCopy.ts'

const COPY = defineCopy(
  { deleted: '已删除', schedules: (count: number) => `${formatNumber(count)} 个定时任务` },
  { deleted: 'Deleted', schedules: (count: number) => plural(count, { one: '{n} scheduled task', other: '{n} scheduled tasks' }) },
)

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
  // Opening one of your Agents' chat warms its process, so the first words come sooner. The Host decides whether anything
  // starts (scope, limits, its own chat slot); a refusal or failure changes nothing here.
  const chatSession = personalChat(snapshot, owner)
  const found = snapshot.customAgents?.find(agent => agent.id === owner)
  const warmable =
    owner !== GENERAL_AGENT_ID
    && !found?.workComputer
    && current !== null
    && chatSession?.state === 'ready'
    && chatSession.sessionId === current
    && connection === 'connected'
    && snapshot.device.dataScope === 'all'
    && access.scopes.has('run')
  useEffect(() => {
    if (!warmable) return
    void api(`custom-agents/${encodeURIComponent(owner)}/warm`, { method: 'POST', body: {} }).catch(() => undefined)
  }, [warmable, owner, current])
  const general = owner === GENERAL_AGENT_ID
  const named = sessionAgent(snapshot, general ? { generalChat: true } : { agent: { customAgentId: owner } })
  const name = named?.name ?? 'Agent'
  const generalBlock = general ? startBlock(snapshot, generalChoice(shell.catalog ?? undefined)) : null
  const state = agentActivity(snapshot, found ?? { id: owner, available: generalBlock === null })
  const gone = !general && snapshot.customAgents !== undefined && !found
  const schedules = snapshot.automations?.filter(item => (general ? !item.customAgentId : item.customAgentId === owner)) ?? []
  // The permission chip is not in a helper's input, so what it would warn of is said here: the open topic's own mode
  // as its session reports it, or on a new topic what the helper's Harness declares.
  const detail = shell.current
  const configFeedback = current === null ? undefined : shell.configFeedback?.get(current)
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
            freshHarness.level === 'L3'
              ? withLadderMode(freshHarness, draftConfig(freshHarness, fresh.config)?.config, fresh.config)
              : undefined,
          )
        : undefined,
    current !== null
      && detail?.summary.id === current
      && helperPermissionBlocked(detail, configFeedback?.kind === 'unknown' ? configFeedback.configId : undefined),
  )
  const boundary = (topicHarness ?? freshHarness)?.level === 'L3' ? MODE_COPY.firstStart(name).detail : undefined
  const repair = shell.owner && found && !found.available ? () => shell.openSettings('engines') : undefined
  const word = gone ? (
    <StatusWord tone="neutral" className="agent-activity">
      {COPY.deleted}
    </StatusWord>
  ) : frozen === null && ACTIVITY_WORDS[state] ? (
    <ActivityWord state={state} live={agentLiveWord(snapshot, owner, current)} />
  ) : found?.workComputer ? (
    <StatusWord tone="neutral">{AGENT_SPACE_COPY.workComputer}</StatusWord>
  ) : null
  const unavailable = !word && found && !found.available ? <Unavailable reason={found.unavailableReason} onRepair={repair} /> : undefined
  const canReadProfile = readsAgents(snapshot) && access.scopes.has('view') && !gone
  return (
    <AgentFrame
      name={name}
      duty={found ? dutyLine(found) : general ? AGENT_SPACE_COPY.generalDuty : undefined}
      avatar={found?.avatar ?? 'general'}
      state={frozen !== null && (state === 'running' || state === 'waiting') ? 'idle' : state}
      word={word}
      unavailable={unavailable}
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
      onProfile={canReadProfile ? () => shell.toggleProfile(owner) : undefined}
      actions={
        <>
          {canReadProfile && !phone && shell.catalog?.features?.automations && schedules.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="agent-schedule-chip"
              icon={ScheduleGlyph}
              onClick={() => shell.openMyAgent({ id: owner, tab: 'schedules' })}>
              <span className="agent-schedule-words">
                {schedules.length === 1 && schedules[0].enabled ? scheduleWords(schedules[0].schedule) : COPY.schedules(schedules.length)}
              </span>
            </Button>
          )}
          {actions}
        </>
      }
    />
  )
}
