import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import type { AgentPreset, CancelReceipt, TaskDetail } from '@latch/protocol'
import { detectPresetCommands } from '../src/server.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const binary = process.env.LATCH_CLAUDE_DIRECT_BINARY
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * The person's own `claude`, logged in, through the Claude Agent SDK wire of a test Host: a one-word reply, a file read,
 * a write that is asked and denied, a cancel, then the same Claude session resumed after the Host restarts. Opt-in:
 * only with `LATCH_CLAUDE_DIRECT_BINARY` and the owner's leave, since each step is a tiny real prompt. Nothing of
 * Claude's own files is read; the steps say only what Latch saw.
 */
it.skipIf(!binary)(
  'drives the person’s own Claude Code through the Agent SDK',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'latch-claude-direct-')))
    const project = join(root, 'project')
    await mkdir(project, { recursive: true })
    await writeFile(join(project, 'note.txt'), 'pineapple\n')
    await writeFile(join(project, 'edit.txt'), 'one\n')
    const data = { dataDir: join(root, 'host'), workspaceRoot: join(root, 'workspace') }
    await mkdir(data.workspaceRoot, { recursive: true })
    const hosts: TestHost[] = []
    const open = async () => {
      const host = await startTestHost({
        demo: false,
        ...data,
        commandDirectories: () => [dirname(binary!)],
        loginPrograms: (name: string) => (name === 'claude' ? binary : undefined),
        detectPreset: (preset: AgentPreset) => (preset.id === 'claude-agent' ? detectPresetCommands(preset) : { found: false }),
      })
      hosts.push(host)
      return host
    }
    const steps: Array<{ step: string; ok: boolean; note?: string }> = []
    try {
      let host = await open()
      let owner = await host.enroll({ listener: 'unix' })
      const preset = (await owner.json<{ presets: AgentPreset[] }>('agents')).presets.find(item => item.id === 'claude-agent')!
      expect(preset.command).toBe('claude')
      const added = await owner.confirmed('agents', {
        method: 'POST',
        body: { id: 'claude-agent', name: 'Claude Agent', presetId: 'claude-agent', command: preset.command, args: preset.args, env: {} },
      })
      expect(added.status).toBe(201)
      const { workspace } = (await (await owner.addFolders({ paths: [project], name: 'claude-project' })).json()) as {
        workspace: { id: string }
      }
      const detail = (sessionId: string) => owner.json<TaskDetail>(`tasks/${sessionId}`)
      const until = async (sessionId: string, wanted: (now: TaskDetail) => boolean, ms = 120_000) => {
        const end = Date.now() + ms
        for (;;) {
          const now = await detail(sessionId)
          if (wanted(now)) return now
          if (Date.now() > end) throw new Error(`timed out; status ${now.summary.status}`)
          await sleep(200)
        }
      }
      const settled = (sessionId: string) => until(sessionId, now => !['running', 'waiting-approval'].includes(now.summary.status))
      const lastReply = (now: TaskDetail) => now.messages.filter(item => item.role === 'assistant').at(-1)?.text ?? ''
      const systemText = (now: TaskDetail) =>
        now.messages
          .filter(item => item.role === 'system')
          .map(item => item.text)
          .join('\n')
      const prompt = async (sessionId: string, text: string) => {
        const response = await owner.request(`tasks/${sessionId}/prompt`, {
          method: 'POST',
          body: { prompt: text, requestId: randomUUID() },
        })
        if (!response.ok) throw new Error(`prompt ${response.status}: ${await response.text()}`)
      }

      // 1. One word.
      const started = await owner.confirmed('tasks', {
        method: 'POST',
        body: {
          harnessId: 'claude-agent',
          workspaceId: workspace.id,
          prompt: 'Reply with exactly the one word: pong',
          requestId: randomUUID(),
          config: [{ configId: 'mode', value: 'default' }],
        },
      })
      const sessionId = ((await started.json()) as { sessionId: string }).sessionId
      let now = await settled(sessionId)
      expect(now.summary.status, systemText(now)).toBe('idle')
      expect(lastReply(now).toLowerCase()).toContain('pong')
      const claudeSession = (now as unknown as { acp?: { acpSessionId?: string } }).acp?.acpSessionId
      steps.push({
        step: '1 one word',
        ok: true,
        note: `reply ${JSON.stringify(lastReply(now).trim())}; model ${now.config?.find(option => option.category === 'model')?.currentValue}; usage ${JSON.stringify(now.usageReport ?? null)}`,
      })

      // 2. A read inside the project, which Claude does not ask about.
      await prompt(sessionId, 'Read note.txt and reply with only the word in it.')
      now = await settled(sessionId)
      expect(now.summary.status, systemText(now)).toBe('idle')
      expect(lastReply(now).toLowerCase()).toContain('pineapple')
      const read = now.messages.filter(item => item.tool?.title?.startsWith('Read'))
      expect(read.length).toBeGreaterThan(0)
      steps.push({
        step: '2 read',
        ok: true,
        note: `reply ${JSON.stringify(lastReply(now).trim())}; tool rows ${read.map(item => item.tool?.title).join(', ')}`,
      })

      // 3. A write, asked and denied.
      await prompt(sessionId, 'Create the file out.txt containing exactly: hi')
      const asked = await until(sessionId, current => current.summary.status !== 'running')
      expect(asked.summary.status).toBe('waiting-approval')
      const names = asked.approvals.map(approval => approval.toolName)
      // Claude offers to allow it from now on; Latch shows only the one-time choices, on either route.
      const choices = asked.approvals.flatMap(approval => (approval.options ?? []).map(option => option.id))
      expect(choices).not.toContain('allow-with-updates')
      for (;;) {
        const current = await detail(sessionId)
        if (current.summary.status === 'waiting-approval')
          for (const approval of current.approvals)
            await owner.confirmed(`approvals/${approval.id}`, { method: 'POST', body: { decision: 'reject', requestId: randomUUID() } })
        if (!['running', 'waiting-approval'].includes(current.summary.status)) break
        await sleep(200)
      }
      now = await detail(sessionId)
      expect(existsSync(join(project, 'out.txt'))).toBe(false)
      steps.push({
        step: '3 write denied',
        ok: true,
        note: `asked ${names.join(', ')} with ${choices.join(', ')}; status ${now.summary.status}; file absent`,
      })

      // 4. A cancel while it streams: the reply grows before the turn ends, and the cancel stops it.
      const before = (await detail(sessionId)).messages.length
      await prompt(sessionId, 'Write the numbers from 1 to 2000, one per line, as plain text with nothing else. Do not use any tool.')
      const fresh = (current: TaskDetail) =>
        current.messages
          .slice(before)
          .filter(item => item.role === 'assistant')
          .map(item => item.text)
          .join('')
      // The reply in progress is the detail's live text, until it settles into a message.
      const streaming = await until(sessionId, current => current.summary.status !== 'running' || current.liveText.length > 20, 60_000)
      expect(streaming.summary.status, `${streaming.summary.status}: ${fresh(streaming).slice(0, 200)}`).toBe('running')
      const stopped = await owner.json<{ receipt: CancelReceipt }>(`tasks/${sessionId}/cancel`, {
        method: 'POST',
        body: { requestId: randomUUID(), runId: streaming.summary.runId },
      })
      expect(stopped.receipt).toMatchObject({ outcome: 'stopped', status: 'cancelled' })
      now = await detail(sessionId)
      steps.push({
        step: '4 cancel',
        ok: true,
        note: `${JSON.stringify(stopped.receipt)}; ${streaming.liveText.split('\n').length} lines streamed when cancelled, ${fresh(now).split('\n').length} kept`,
      })

      const setMode = async (value: string) => {
        const set = await owner.confirmed(`tasks/${sessionId}/config`, {
          method: 'POST',
          body: { configId: 'mode', value, requestId: randomUUID() },
        })
        expect(set.status).toBe(200)
      }
      const answerAll = async (decision: 'allow' | 'reject') => {
        for (;;) {
          const current = await detail(sessionId)
          if (current.summary.status === 'waiting-approval')
            for (const approval of current.approvals)
              await owner.confirmed(`approvals/${approval.id}`, { method: 'POST', body: { decision, requestId: randomUUID() } })
          if (!['running', 'waiting-approval'].includes(current.summary.status)) return current
          await sleep(200)
        }
      }

      // 6. An edit, with the diff on its row.
      await setMode('acceptEdits')
      await prompt(sessionId, 'Use the Edit tool to replace the word one with two in edit.txt. Reply ok.')
      now = await answerAll('allow')
      const edit = now.messages.find(item => item.tool?.title?.startsWith('Edit'))
      expect(edit?.tool?.diffs?.length).toBeGreaterThan(0)
      steps.push({
        step: '6 edit diff',
        ok: true,
        note: `row ${edit?.tool?.title}; diffs ${JSON.stringify(edit?.tool?.diffs).slice(0, 200)}`,
      })

      // The task list (7) is not checked here: the `claude` this was written against (2.1.327) offers neither TodoWrite
      // nor the Task* tools to an SDK session (its `init` lists only `Task` and `TaskStop`), so it cannot be asked to.

      // 8. Claude's own question, answered on the question card.
      await prompt(
        sessionId,
        'Use the AskUserQuestion tool to ask me which fruit I want, with exactly two options: Apple and Banana. Then reply with only the fruit I picked.',
      )
      const questioned = await until(
        sessionId,
        current => (current.questions?.length ?? 0) > 0 || !['running', 'waiting-approval'].includes(current.summary.status),
      )
      const question = questioned.questions?.[0]
      expect(question, systemText(questioned)).toBeDefined()
      const banana = question!.questions[0]!.options.findIndex(option => /banana/iu.test(option.label))
      await owner.json(`tasks/${sessionId}/questions/${question!.id}/answer`, {
        method: 'POST',
        body: { requestId: randomUUID(), answers: [{ questionId: question!.questions[0]!.id, optionIds: [`o${banana}`] }] },
      })
      now = await settled(sessionId)
      expect(lastReply(now).toLowerCase()).toContain('banana')
      steps.push({
        step: '8 question',
        ok: true,
        note: `asked ${JSON.stringify(question!.questions[0]!.options.map(option => option.label))}; reply ${JSON.stringify(lastReply(now).trim())}`,
      })

      // 9. A subagent, shown as its own row with its own work.
      await prompt(
        sessionId,
        'Use the Agent tool with subagent_type general-purpose to read note.txt and report its word. Then reply with only that word.',
      )
      now = await answerAll('allow')
      const child = now.messages.find(item => item.subagent)
      expect(child?.subagent).toBeDefined()
      expect(lastReply(now).toLowerCase()).toContain('pineapple')
      steps.push({
        step: '9 subagent',
        ok: true,
        note: `row ${JSON.stringify({ title: child?.subagent?.title, status: child?.subagent?.status, steps: child?.subagent?.steps?.length })}`,
      })

      // 10. A plan, and keep planning: the turn ends as on the adapter, and nothing is written.
      await setMode('plan')
      await prompt(
        sessionId,
        'Plan how to create the file plan.txt containing x. Present the plan with ExitPlanMode right away, without reading anything.',
      )
      const planned = await until(sessionId, current => current.summary.status !== 'running')
      const planAsk = planned.approvals.find(approval => approval.plan)
      expect(planAsk, systemText(planned)).toBeDefined()
      now = await answerAll('reject')
      expect(existsSync(join(project, 'plan.txt'))).toBe(false)
      steps.push({
        step: '10 keep planning',
        ok: true,
        note: `plan asked with ${(planAsk!.options ?? []).map(option => option.id).join(', ')}; status ${now.summary.status}`,
      })
      await setMode('acceptEdits')

      // 5. The same Claude session after the Host restarts, on the mode, model and effort it showed.
      const chosen = (await detail(sessionId)).config ?? []
      const effort = chosen.find(option => option.category === 'thought_level')
      const lower = effort?.options.find(option => option.value !== 'default' && option.value !== effort.currentValue)?.value
      if (effort && lower) {
        const set = await owner.confirmed(`tasks/${sessionId}/config`, {
          method: 'POST',
          body: { configId: effort.id, value: lower, requestId: randomUUID() },
        })
        expect(set.status).toBe(200)
      }
      const shown = ((await detail(sessionId)).config ?? []).map(option => [option.id, option.currentValue])
      await host.close()
      host = await open()
      owner = await host.enroll({ listener: 'unix' })
      await prompt(sessionId, 'What was the one word you replied with first? Reply with that word only.')
      now = await settled(sessionId)
      expect(now.summary.status, systemText(now)).toBe('idle')
      expect(lastReply(now).toLowerCase()).toContain('pong')
      const after = (now.config ?? []).map(option => [option.id, option.currentValue])
      expect(after).toEqual(shown)
      const resumedSession = (now as unknown as { acp?: { acpSessionId?: string } }).acp?.acpSessionId
      if (claudeSession && resumedSession) expect(resumedSession).toBe(claudeSession)
      steps.push({
        step: '5 resume after restart',
        ok: true,
        note: `reply ${JSON.stringify(lastReply(now).trim())}; options before ${JSON.stringify(shown)}, after ${JSON.stringify(after)}`,
      })
    } finally {
      for (const host of hosts) await host.close().catch(() => {})
      process.stdout.write(`${JSON.stringify(steps, null, 2)}\n`)
      await rm(root, { recursive: true, force: true })
    }
  },
  600_000,
)
