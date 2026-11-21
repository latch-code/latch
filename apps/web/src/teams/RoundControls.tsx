import { createContext, useContext, useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import { TEAM_LIMITS, type TaskSummary, type TeamMember, type TeamSummary } from '@latch/protocol'
import { CornerDownRight } from 'lucide-react'
import { Button, Icon, IconButton, SendGlyph, Switch, Tooltip } from '@latch/ui'
import { TEAM_COPY } from './copy.ts'
import { leadTeamOf, memberChoices, useDispatchSwitch, useTeamRound } from './rounds.ts'
import type { TeamPage } from './TeamGraph.tsx'

/**
 * A team card's parts for later rounds, each self-contained so the card places them where it draws its
 * head and its member rows: 「第 N 轮」, the switch that lets the lead's agent send work, and 「再派一轮」 on a member's
 * row with its input under that row.
 */

/** What the round parts read of the page beyond `TeamPage`: the sessions (can a member take work now) and the teams. */
export interface RoundPage {
  tasks: readonly Pick<TaskSummary, 'id' | 'status' | 'archived'>[]
  teams: readonly TeamSummary[] | undefined
}

export const RoundPageContext = createContext<RoundPage | undefined>(undefined)

/** The newest team of its session, on a device that may run: the one more work goes to. Older cards offer none. */
function takesWork(team: TeamSummary, page: TeamPage, rounds: RoundPage | undefined): rounds is RoundPage {
  return page.canStop && rounds !== undefined && leadTeamOf(rounds.teams, team.leadSessionId)?.id === team.id
}

/** 「第 2 轮」 once there is more than one, and who made it on hover. For the card's head. */
export function RoundMark({ team }: { team: TeamSummary }): ReactNode {
  const latest = team.rounds?.at(-1)
  if (!latest || (team.rounds?.length ?? 0) < 2) return null
  return (
    <Tooltip content={latest.by === 'agent' ? TEAM_COPY.byAgent : TEAM_COPY.byYou}>
      <span className="team-round" tabIndex={0} data-by={latest.by}>
        {TEAM_COPY.round(latest.round)}
      </span>
    </Tooltip>
  )
}

/**
 * 「让它自己派活」, for the card's head: off unless the person turns it on; disabled with the Host's reason where the
 * lead's agent cannot; in flight until the Host answers, a refusal said by the page.
 */
export function DispatchSwitch({ team, page }: { team: TeamSummary; page: TeamPage }): ReactNode {
  const rounds = useContext(RoundPageContext)
  if (!takesWork(team, page, rounds)) return null
  return <DispatchControl team={team} page={page} />
}

function DispatchControl({ team, page }: { team: TeamSummary; page: TeamPage }) {
  const id = useId()
  const { sending, change } = useDispatchSwitch(team.id, page.refresh)
  const on = sending ?? team.agentDispatch === true
  const refusal = team.agentDispatch ? undefined : team.dispatchRefusal
  return (
    <div className="team-dispatch" data-busy={sending !== undefined ? '' : undefined} data-disabled={refusal ? '' : undefined}>
      <label className="team-dispatch-label" htmlFor={id}>
        {TEAM_COPY.letAgent}
      </label>
      <Switch
        id={id}
        checked={on}
        disabled={refusal !== undefined || sending !== undefined}
        {...(refusal ? { title: refusal } : {})}
        onCheckedChange={next => {
          void change(next).then(reason => {
            if (reason) page.onError(reason)
          })
        }}
      />
    </div>
  )
}

/**
 * Which member has its 「再派一轮」 input open, for one card. `offers(member)`: its row shows the action (it can take
 * work now, and its input is not the one open).
 */
export function useAgain(team: TeamSummary, page: TeamPage | undefined) {
  const rounds = useContext(RoundPageContext)
  const [open, setOpen] = useState<string>()
  const free = page && takesWork(team, page, rounds) ? memberChoices(team, rounds.tasks).filter(choice => !choice.disabled) : []
  return {
    open,
    setOpen,
    offers: (member: TeamMember) => open !== member.itemId && free.some(choice => choice.itemId === member.itemId),
  }
}

/** 「再派一轮」 at the end of a member's pill, shown on the row's hover or focus (always on touch). */
export function AgainButton({ member, onOpen }: { member: TeamMember; onOpen: () => void }): ReactNode {
  return (
    <Button
      size="xs"
      variant="ghost"
      className="team-again-button"
      aria-label={TEAM_COPY.againTo(member.name || member.title)}
      onClick={onOpen}>
      <Icon icon={CornerDownRight} size={12} />
      <span className="team-again-word">{TEAM_COPY.again}</span>
    </Button>
  )
}

/**
 * The input 「再派一轮」 opens, as a line under the whole graph (the rows keep their height), named for its member.
 * Enter sends a round to this member alone, Esc closes; a refusal is said under it.
 */
export function AgainLine({
  team,
  member,
  page,
  onClose,
}: {
  team: TeamSummary
  member: TeamMember
  page: TeamPage
  onClose: () => void
}): ReactNode {
  return <AgainInput key={member.itemId} team={team} member={member} page={page} onClose={onClose} />
}

function AgainInput({ team, member, page, onClose }: { team: TeamSummary; member: TeamMember; page: TeamPage; onClose: () => void }) {
  const [text, setText] = useState('')
  const { status, send } = useTeamRound(team.id, page.refresh)
  const sending = status.state === 'sending'
  const prompt = text.trim()
  const ready = prompt.length > 0 && prompt.length <= TEAM_LIMITS.promptChars && !sending
  const go = async () => {
    if (!ready) return
    if (await send([{ itemId: member.itemId, prompt }], text)) onClose()
  }
  const keydown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      void go()
    }
  }
  const failed = status.state === 'failed' && status.key === text ? status.reason : undefined
  return (
    <div className="team-again" data-busy={sending ? '' : undefined}>
      <div className="team-again-field">
        <span className="team-again-to">
          <Icon icon={CornerDownRight} size={12} />
          <span className="team-again-title">{member.name || member.title}</span>
        </span>
        <input
          // A new input the person just asked for: where typing goes next.
          autoFocus
          className="team-again-input"
          aria-label={TEAM_COPY.againTo(member.name || member.title)}
          aria-invalid={failed ? true : undefined}
          placeholder={TEAM_COPY.againPlaceholder}
          value={text}
          maxLength={TEAM_LIMITS.promptChars}
          readOnly={sending}
          onChange={event => setText(event.target.value)}
          onKeyDown={keydown}
        />
        <IconButton
          size="xs"
          label={TEAM_COPY.sendAgain}
          icon={SendGlyph}
          shortcut="Enter"
          busy={sending}
          disabled={!ready}
          onClick={() => {
            void go()
          }}
        />
      </div>
      {failed && (
        <p className="team-again-error" role="alert">
          {failed}
        </p>
      )}
    </div>
  )
}
