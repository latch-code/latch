import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import type { AgentPreset, AppSnapshot, TaskDetail, WorkItemAnswer, WorkProposalAnswer, WorkProposalSummary } from '@latch/protocol'
import { startTestHost } from './helpers/host.ts'

/**
 * `<preset>=<program path>` (`codex`): one tiny turn of the real CLI asks it to propose one 待办 through the board's
 * tool; the proposal arrives, is accepted, and is never started. Only an approval for that one tool is allowed.
 */
const [presetId = '', path = ''] = (process.env.LATCH_WORK_PROPOSALS_LIVE ?? '').split('=')
const PROMPT =
  'Call the propose_todo tool exactly once with title "Add a CHANGELOG entry" and prompt "Add a one-line CHANGELOG entry for the latest change and check that the formatter passes." Do nothing else: do not run commands or edit files. Then reply "done".'

it.skipIf(!presetId || !path)(
  'a real CLI proposes one 待办 through the board tool; it is accepted and never started',
  { timeout: 300_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'latch-work-proposals-live-'))
    await mkdir(join(root, 'workspace'))
    const host = await startTestHost({
      demo: false,
      dataDir: join(root, 'host'),
      workspaceRoot: join(root, 'workspace'),
      commandDirectories: () => [dirname(process.execPath), dirname(path)],
      detectPreset: (preset: AgentPreset) => (preset.id === presetId ? { found: true, path } : { found: false }),
    })
    try {
      const owner = await host.enroll({ listener: 'unix' })
      const added = await owner.confirmed('agents', {
        method: 'POST',
        body: { id: presetId, name: presetId, presetId, command: path, args: [], env: {} },
      })
      expect(added.status).toBeLessThan(300)
      const { sessionId } = await owner.confirmedJson<{ sessionId: string }>('tasks', {
        body: { prompt: PROMPT, requestId: randomUUID(), harnessId: presetId },
      })
      let detail: TaskDetail | undefined
      for (let round = 0; round < 400; round++) {
        detail = await owner.json<TaskDetail>(`tasks/${sessionId}`)
        if (detail.summary.status === 'waiting-approval')
          for (const approval of detail.approvals) {
            const asked = `${approval.toolName} ${approval.tool?.title ?? ''}`
            await owner.confirmed(`approvals/${approval.id}`, {
              method: 'POST',
              body: { decision: /propose_todo/u.test(asked) ? 'allow' : 'reject', requestId: randomUUID() },
            })
          }
        if (!['running', 'waiting-approval', 'starting'].includes(detail.summary.status)) break
        await new Promise(resolve => setTimeout(resolve, 300))
      }
      let proposal: WorkProposalSummary | undefined
      for (let round = 0; round < 50 && !proposal; round++) {
        proposal = (await owner.json<AppSnapshot>('snapshot')).workProposals?.find(row => row.from.sessionId === sessionId)
        if (!proposal) await new Promise(resolve => setTimeout(resolve, 200))
      }
      const tools =
        detail?.messages.filter(message => message.role === 'tool').map(message => message.toolName ?? message.tool?.title) ?? []
      console.log(
        JSON.stringify({
          status: detail?.summary.status,
          tools,
          proposal: proposal && { kind: proposal.kind, entries: proposal.entries, external: proposal.external },
        }),
      )
      expect(proposal?.entries?.[0]?.title).toBe('Add a CHANGELOG entry')
      // Accepted, it is an unstarted 待办 that records where it came from; nothing started.
      const accepted = await owner.json<WorkProposalAnswer>(`work/proposals/${proposal!.id}/accept`, {
        method: 'POST',
        body: { requestId: randomUUID(), baseRevision: proposal!.revision },
      })
      const { item } = await owner.json<WorkItemAnswer>(`work/items/${accepted.itemIds![0]}`)
      expect(item).toMatchObject({ board: { group: 'todo' }, sessionIds: [], from: { sessionId, proposalId: proposal!.id } })
      console.log(JSON.stringify({ item: { title: item.title, prompt: item.prompt, from: item.from } }))
    } finally {
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)
