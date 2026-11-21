import { useEffect, useMemo, useRef, useState } from 'react'
import {
  escapeSecurityText,
  TEAM_LIMITS,
  WORK_ITEM_LIMITS,
  type HostCatalog,
  type TaskSummary,
  type WorkProposal,
  type WorkProposalAnswer,
  type WorkProposalEntryEdit,
} from '@latch/protocol'
import { Button, Checkbox, InlineNotice, Loading, Modal, ModalHeader, TextAreaField, TextField } from '@latch/ui'
import { api, errorMessage } from '../core/api.ts'
import { harnessName } from '../core/harnessName.ts'
import { defineCopy, formatNumber } from '../core/i18n.ts'
import { switchWorkView } from '../preferences.ts'
import type { ShellState } from '../shell/useShellLayout.tsx'
import type { TodoProposal, ProposalWrites } from './proposals.ts'
import { ExternalMark, ProposedBy } from './WorkBoardProposalCard.tsx'
import { BOARD_CARD_COPY, TagChips } from './WorkBoardCard.tsx'
import { ItemWriteLine } from './WriteLine.tsx'
import { readChoice } from '../composerChoice.ts'
import { TEAM_COPY } from '../teams/copy.ts'
import { HarnessPick } from '../teams/HarnessPick.tsx'
import { memberChoice, memberModel, memberStart } from '../teams/memberModel.ts'
import { proposalStart } from '../teams/model.ts'
import { draftKey, useTeamStart } from '../teams/start.ts'

const chars = (text: string) => Array.from(text).length
const noRefresh = () => Promise.resolve()
const COPY = defineCopy(
  {
    saveFailed: '没有保存',
    heading: '提议的待办',
    review: '审阅提议',
    from: '提议自',
    loading: '读取中',
    choose: (position: number) => `收下第 ${formatNumber(position)} 条`,
    title: '标题',
    instructions: '要求',
    dismissAll: '全部不要',
    dismiss: '不要',
    acceptCount: (count: number) => `接受 ${formatNumber(count)} 条`,
    accept: '接受',
    accepted: '已收下的待办',
  },
  {
    saveFailed: 'Changes weren’t saved',
    heading: 'Proposed task',
    review: 'Review proposal',
    from: 'Proposed by',
    loading: 'Loading',
    choose: (position: number) => `Accept task ${formatNumber(position)}`,
    title: 'Title',
    instructions: 'Instructions',
    dismissAll: 'Dismiss all',
    dismiss: 'Dismiss',
    acceptCount: (count: number) => `Accept ${formatNumber(count)}`,
    accept: 'Accept',
    accepted: 'Accepted tasks',
  },
)

export function AcceptedItems({ ids, shell, onClose }: { ids: readonly string[]; shell: ShellState; onClose: () => void }) {
  const visible = ids.flatMap(id => {
    const item = shell.snapshot.items?.find(row => row.id === id)
    return item ? [item] : []
  })
  return (
    <Modal label={COPY.accepted} variant={shell.phone ? 'sheet' : 'dialog'} onClose={onClose} className="work-board-proposal-review">
      <ModalHeader title={COPY.accepted} onClose={onClose} />
      <div className="ui-modal-body item-accepted-links">
        {visible.map(item => (
          <Button
            key={item.id}
            variant="outline"
            onClick={() => {
              shell.openWorkItem(item.id)
              onClose()
            }}>
            {escapeSecurityText(item.title)}
          </Button>
        ))}
      </div>
    </Modal>
  )
}

interface Draft {
  index: number
  chosen: boolean
  title: string
  prompt: string
  /** The Harness this entry runs on when the entries are started together. */
  harnessId: string
  read: { title: string; prompt: string }
}

/** The session that proposed, where it can start what it proposed as a team. */
export interface ProposalTeam {
  lead: TaskSummary
  catalog: HostCatalog
  deviceId: string
  access: { legacy: boolean; local: boolean }
  refresh: () => Promise<void>
}

/**
 * 审阅 an agent's proposal of 待办: each pending one with its full 要求, read from the Host at the revision the card
 * showed, to edit, pick and accept (they become unstarted 待办; nothing starts), or to dismiss. Accepting names that
 * revision, so what the person read is what is kept.
 */
export function ProposalReview({
  proposal,
  writes,
  shell,
  onClose,
  team,
}: {
  proposal: TodoProposal
  writes: ProposalWrites
  shell: ShellState
  onClose: () => void
  /** 一起开始: the entries chosen start at once as this session's team, each on the Harness chosen in its row. */
  team?: ProposalTeam | undefined
}) {
  const [read, setRead] = useState<WorkProposal | null>(null)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [accepted, setAccepted] = useState<string[]>([])
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const write = writes.states.get(proposal.id)
  const unknown = write?.state === 'unknown'
  const leadHarness = team?.lead.harnessId
  const teamStart = useTeamStart(draftKey(team?.deviceId ?? '', `proposal:${proposal.id}`), team?.lead.id ?? '', team?.refresh ?? noRefresh)
  const starting = teamStart.status.state === 'sending'
  const startUnknown = teamStart.status.state === 'unknown'
  const remembered = useMemo(() => (team ? readChoice(team.deviceId) : null), [team?.deviceId])
  const ready = useMemo(() => team?.catalog.harnesses.filter(harness => harness.status === 'ready') ?? [], [team?.catalog.harnesses])
  const modelOf = (harnessId: string) =>
    team ? memberModel(team.catalog, remembered, harnessId, { projectId: team.lead.workspaceId, access: team.access }) : undefined
  // The proposal changed under 一起开始: what the card holds is the revision it was opened at, so read it again here.
  const [reread, setReread] = useState(0)
  const startRefusal = teamStart.status.state === 'refused' ? teamStart.status.code : undefined
  useEffect(() => {
    if (startRefusal === 'proposal-changed') setReread(count => count + 1)
  }, [startRefusal])
  useEffect(() => {
    let live = true
    api<WorkProposalAnswer>(`work/proposals/${encodeURIComponent(proposal.id)}`)
      .then(({ proposal: full }) => {
        if (!live) return
        setRead(full)
        setDrafts(
          (full.entries ?? [])
            .filter(entry => entry.state === 'pending')
            .map(entry => ({
              index: entry.index,
              chosen: true,
              title: entry.title,
              prompt: entry.prompt,
              harnessId: entry.harnessId ?? leadHarness ?? '',
              read: { title: entry.title, prompt: entry.prompt },
            })),
        )
      })
      .catch((cause: unknown) => {
        if (live) setError(errorMessage(cause))
      })
    return () => {
      live = false
    }
  }, [proposal.id, proposal.revision, leadHarness, reread])
  const chosen = drafts.filter(draft => draft.chosen)
  const invalid = chosen.some(
    draft =>
      !draft.title.trim() || chars(draft.title.trim()) > WORK_ITEM_LIMITS.titleChars || draft.prompt.length > WORK_ITEM_LIMITS.promptChars,
  )
  const edit = (index: number, change: Partial<Draft>) => {
    setDrafts(previous => previous.map(draft => (draft.index === index ? { ...draft, ...change } : draft)))
  }
  const finish = async (action: 'accept' | 'dismiss') => {
    if (!read || busy || unknown) return
    setBusy(true)
    setError('')
    const result =
      action === 'accept'
        ? await writes.accept(
            read,
            chosen.map(draft => {
              const entry: WorkProposalEntryEdit = { index: draft.index }
              if (draft.title.trim() !== draft.read.title) entry.title = draft.title.trim()
              if (draft.prompt.trim() !== draft.read.prompt) entry.prompt = draft.prompt.trim()
              return entry
            }),
          )
        : await writes.dismiss(read)
    if (!mounted.current) return
    if (result.ok) {
      showAccepted(result.itemIds)
    } else if (!result.unknown) {
      writes.forget(read.id)
      setError(result.reason ?? COPY.saveFailed)
    }
    setBusy(false)
  }
  // Offered for a split, two or more waiting entries; what is chosen of them starts.
  const teamOffered = team !== undefined && drafts.length >= 2
  const teamReady =
    chosen.length > 0 && chosen.length <= TEAM_LIMITS.members && !invalid && chosen.every(draft => draft.prompt.trim() && draft.harnessId)
  const startTogether = async () => {
    if (!read || busy || unknown || starting) return
    setError('')
    const started = await teamStart.start({
      proposal: proposalStart(
        read,
        // Each starts on what a new session of its Harness would, as an untouched row of the panel does.
        chosen.map(draft => ({
          ...draft,
          ...(team
            ? memberStart(
                team.catalog,
                memberChoice(team.catalog, remembered, draft.harnessId, { projectId: team.lead.workspaceId, access: team.access }),
              )
            : {}),
        })),
      ),
    })
    // The team's card takes the proposal's place in the conversation, which can mount this review anew: close it either way.
    if (started) onClose()
  }
  const locked = busy || unknown || starting || startUnknown
  const showAccepted = (ids: string[] | undefined) => {
    if (ids && ids.length > 1) {
      setAccepted(ids)
      return
    }
    if (ids?.[0]) shell.openWorkItem(ids[0])
    onClose()
  }
  const retry = async () => {
    setBusy(true)
    const result = await writes.retry(proposal.id)
    if (!mounted.current) return
    setBusy(false)
    if (result.ok) showAccepted(result.itemIds)
  }
  const close = () => {
    if (!busy && !starting) onClose()
  }
  const group = read?.goal !== undefined
  const heading = group ? escapeSecurityText(read.goal!) : COPY.heading
  if (accepted.length) return <AcceptedItems ids={accepted} shell={shell} onClose={close} />
  return (
    <Modal
      label={COPY.review}
      variant={shell.phone ? 'sheet' : 'dialog'}
      dismissible={!busy && !starting}
      onClose={close}
      className="work-board-proposal-review">
      <form
        onSubmit={event => {
          event.preventDefault()
          void finish('accept')
        }}>
        <ModalHeader title={heading} onClose={close} />
        <div className="ui-modal-body">
          <div className="work-board-proposal-line">
            <span className="work-board-proposal-word">{COPY.from}</span>
            <ProposedBy
              proposal={proposal}
              shell={shell}
              details
              onOpenSession={
                busy
                  ? undefined
                  : id => {
                      close()
                      shell.choose(id, () => shell.setRoute({ entry: 'sessions' }))
                      switchWorkView('chat')
                    }
              }
            />
            {proposal.external && <ExternalMark />}
          </div>
          {read === null && !error ? (
            <Loading label={COPY.loading} />
          ) : (
            drafts.map(draft => {
              const entry = read?.entries?.find(item => item.index === draft.index)
              const titleLong = chars(draft.title.trim()) > WORK_ITEM_LIMITS.titleChars
              const promptLong = draft.prompt.length > WORK_ITEM_LIMITS.promptChars
              const project = entry?.projectId
                ? (shell.catalog?.workspaces.find(item => item.id === entry.projectId)?.name
                  ?? (entry.projectId === 'default' ? BOARD_CARD_COPY.noProject : entry.projectId))
                : undefined
              const listed = shell.catalog?.harnesses.find(item => item.id === entry?.harnessId)
              const harness = listed ? harnessName(listed) : entry?.harnessId
              return (
                <section key={draft.index} className="work-board-proposal-entry" data-off={draft.chosen ? undefined : ''}>
                  {drafts.length > 1 && (
                    <Checkbox
                      label={COPY.choose(draft.index + 1)}
                      checked={draft.chosen}
                      disabled={locked}
                      onChange={() => {
                        edit(draft.index, { chosen: !draft.chosen })
                      }}
                    />
                  )}
                  <TextField
                    label={COPY.title}
                    value={draft.title}
                    disabled={locked || !draft.chosen}
                    autoComplete="off"
                    error={
                      titleLong ? `${formatNumber(chars(draft.title.trim()))} / ${formatNumber(WORK_ITEM_LIMITS.titleChars)}` : undefined
                    }
                    onChange={event => {
                      edit(draft.index, { title: event.target.value.replace(/\n/gu, ' ') })
                    }}
                  />
                  <TextAreaField
                    label={COPY.instructions}
                    value={draft.prompt}
                    rows={drafts.length > 1 ? 5 : 8}
                    disabled={locked || !draft.chosen}
                    error={promptLong ? `${formatNumber(draft.prompt.length)} / ${formatNumber(WORK_ITEM_LIMITS.promptChars)}` : undefined}
                    onChange={event => {
                      edit(draft.index, { prompt: event.target.value })
                    }}
                  />
                  {(project || harness || entry?.tags?.length || teamOffered) && (
                    <span className="work-board-proposal-facts">
                      {teamOffered && (
                        <HarnessPick
                          value={draft.harnessId}
                          ready={ready}
                          listed={team.catalog.harnesses}
                          model={draft.harnessId ? modelOf(draft.harnessId) : undefined}
                          disabled={locked || !draft.chosen}
                          onChange={harnessId => edit(draft.index, { harnessId })}
                        />
                      )}
                      {project && !teamOffered && <span>{escapeSecurityText(project)}</span>}
                      {harness && !teamOffered && <span>{escapeSecurityText(harness)}</span>}
                      <TagChips tags={entry?.tags} />
                    </span>
                  )}
                </section>
              )
            })
          )}
          {error && <InlineNotice tone="error">{error}</InlineNotice>}
          {teamStart.status.state === 'refused' && <InlineNotice tone="error">{teamStart.status.reason}</InlineNotice>}
          {teamStart.status.state === 'unknown' && (
            <InlineNotice
              tone="warn"
              action={
                <>
                  <Button size="xs" variant="ghost" onClick={teamStart.forget}>
                    {TEAM_COPY.giveUp}
                  </Button>
                  <Button size="xs" variant="outline" onClick={() => void startTogether()}>
                    {TEAM_COPY.retry}
                  </Button>
                </>
              }>
              {teamStart.status.reason || TEAM_COPY.unanswered}
            </InlineNotice>
          )}
          {unknown && <ItemWriteLine state={write} onRetry={() => void retry()} onDismiss={() => writes.forget(proposal.id)} />}
        </div>
        <footer className="ui-modal-footer">
          <Button
            size="md"
            variant="ghost"
            disabled={locked || read === null}
            onClick={() => {
              void finish('dismiss')
            }}>
            {drafts.length > 1 ? COPY.dismissAll : COPY.dismiss}
          </Button>
          <Button
            size="md"
            variant={teamOffered ? 'outline' : 'primary'}
            type="submit"
            disabled={locked || read === null || !chosen.length || invalid}
            loading={busy}>
            {drafts.length > 1 ? COPY.acceptCount(chosen.length) : COPY.accept}
          </Button>
          {teamOffered && (
            <Button
              size="md"
              variant="primary"
              disabled={busy || unknown || startUnknown || read === null || !teamReady}
              loading={starting}
              onClick={() => void startTogether()}>
              {TEAM_COPY.startTogether}
            </Button>
          )}
        </footer>
      </form>
    </Modal>
  )
}
