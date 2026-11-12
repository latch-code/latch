import { useCallback, type ReactNode } from 'react'

import type { MemoryProposal, TaskDetail } from '@latch/protocol'
import { StatusWord } from '@latch/ui'
import type { ShellState } from '../shell/useShellLayout.tsx'
import { topicOwner } from './chat.ts'
import { ProposalRow } from './ProposalRow.tsx'
import { effectWords, placeProposals } from './proposals.ts'
import { useProposals } from './useAgentData.ts'
import { useAgentWrites } from './useAgentWrites.ts'

/**
 * The memory proposals of an open topic of 我的 Agent, each after the turn it came from: what the Transcript's `placed`
 * takes. Undefined outside 我的 Agent and while there are none.
 */
export function useTopicProposals(
  shell: Pick<ShellState, 'snapshot' | 'catalog' | 'connection' | 'access' | 'refresh'>,
  detail: TaskDetail | null,
): ((turns: ReadonlyArray<{ key: string }>) => ReadonlyMap<string, ReactNode>) | undefined {
  const owner = detail ? (topicOwner(detail.summary) ?? null) : null
  const { read, reload } = useProposals(shell.snapshot, owner)
  const { refresh } = shell
  const writes = useAgentWrites(
    useCallback(() => {
      reload()
      void refresh()
    }, [reload, refresh]),
  )
  if (owner === null || detail === null) return undefined
  const sessionId = detail.summary.id
  const proposals = 'value' in read && read.value ? read.value.proposals.filter(proposal => proposal.source.sessionId === sessionId) : []
  // The person's 「记住…」 the Host did not keep: on its own turn, with why.
  const refusals: MemoryProposal[] = (detail.memoryRefusals ?? []).map(refusal => ({
    id: `refused:${refusal.requestId}`,
    content: refusal.reason,
    origin: 'user',
    external: false,
    source: { sessionId, requestId: refusal.requestId },
    state: 'dismissed',
    createdAt: '',
    updatedAt: '',
  }))
  if (!proposals.length && !refusals.length) return undefined
  const effect = effectWords(shell.catalog?.harnesses.find(harness => harness.id === detail.summary.harnessId))
  const disabled = shell.connection === 'offline' || !shell.access.scopes.has('run')
  return turns =>
    new Map(
      [...placeProposals([...proposals, ...refusals], sessionId, detail.messages, turns)].map(([key, items]) => [
        key,
        <div key={`proposals:${key}`} className="memory-proposals">
          {items.map(proposal =>
            proposal.id.startsWith('refused:') ? (
              <p key={proposal.id} className="memory-proposal-refused" role="status">
                <StatusWord tone="failed">没有记下</StatusWord>
                <span>{proposal.content}</span>
              </p>
            ) : (
              <ProposalRow key={proposal.id} owner={owner} proposal={proposal} writes={writes} effect={effect} disabled={disabled} />
            ),
          )}
        </div>,
      ]),
    )
}
