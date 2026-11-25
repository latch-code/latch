import { randomInt, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import type { AgentMention, CustomAgent, Message, ProviderSettings, TaskDetail } from '@latch/protocol'
import { DSH_CONSULTATION_GUARD_VERSION } from '@latch/harness-acp'
import type { AuditRecord } from '../src/audit.ts'
import { redactKnownSecrets } from '@latch/core/node-kit'
import { CONSULT_AGENT, LIST_AGENTS } from '../src/agent-consultations.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'

const mode = process.env.LATCH_LIVE_AGENT_MENTIONS
const model = 'deepseek-flash'
const peerName = '展签编辑'
const toolIds = [LIST_AGENTS, CONSULT_AGENT]
const toolNames = new Set(toolIds.flatMap(name => [name, `mcp__latch-browser__${name}`, `latch-browser.${name}`, `latch-browser: ${name}`]))

async function readKey(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.() || stat.size > 4096)
      throw new Error('Use a private, single-link 0600 key file owned by this user.')
    const bytes = Buffer.alloc(4097)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    const key = bytes.subarray(0, bytesRead).toString('utf8').trim()
    if (!key || bytesRead > 4096 || /\s/u.test(key)) throw new Error('The key file must contain one API key.')
    return key
  } finally {
    await file.close()
  }
}

type Owner = Awaited<ReturnType<TestHost['enroll']>>
const safeModel = (name?: string) => (name && /^[a-zA-Z0-9_.:/-]{1,128}$/u.test(name) ? redactKnownSecrets(name) : undefined)
const exhibitAnswer = (message?: Message) => message && { id: message.id, text: redactKnownSecrets(message.text).slice(0, 1500) }
const observedTools = (rows: Message[]) => [
  ...new Set(
    rows
      .filter(message => message.role === 'tool')
      .flatMap(message => [message.toolName, message.tool?.title].filter((name): name is string => !!name && toolNames.has(name))),
  ),
]

async function settled(owner: Owner, sessionId: string): Promise<TaskDetail> {
  const until = Date.now() + 150_000
  while (Date.now() < until) {
    const detail = await owner.json<TaskDetail>('tasks/' + sessionId)
    for (const approval of detail.approvals) {
      // The acceptance needs just the two collaboration tools. Never approve shell, file or unrelated MCP operations.
      const authorized = toolNames.has(approval.toolName)
      const once = approval.options?.find(option => option.kind === 'allow_once')
      if (!authorized || (approval.options?.length && !once))
        throw new Error('An unexpected approval was requested. The fixture will stop its own Host.')
      await owner.json(`approvals/${approval.id}`, {
        method: 'POST',
        body: { decision: 'allow', requestId: randomUUID(), ...(once ? { optionId: once.id } : {}) },
      })
    }
    if (!['running', 'waiting-approval'].includes(detail.summary.status)) return detail
    await delay(400)
  }
  throw new Error('The real turn did not settle in 150 seconds.')
}

function turnEvidence(detail: TaskDetail) {
  const start = detail.messages.findLastIndex(message => message.role === 'user' && !message.steered)
  const latest = detail.messages[start]
  const rows = start < 0 ? [] : detail.messages.slice(start + 1)
  const routed = latest?.turn?.routed
  return {
    sessionId: detail.summary.id,
    harnessId: detail.summary.harnessId,
    status: detail.summary.status,
    outcome: detail.summary.runOutcome,
    providerId: detail.summary.modelRoute?.providerId ?? detail.summary.providerId,
    selectedModel: safeModel(detail.summary.modelRoute?.model ?? detail.summary.model),
    tools: observedTools(rows),
    gatewayBypassed: !!detail.summary.modelRoute?.bypassed,
    ...(routed
      ? {
          gatewayRequests: routed.requests,
          models: routed.models.map(row => ({
            requested: safeModel(row.model),
            reported: safeModel(row.used),
            requests: row.requests,
            failed: row.failed ?? 0,
          })),
        }
      : {}),
    errorCodes: rows
      .filter(m => m.role === 'system')
      .flatMap(m => (m.errorCode && /^[a-z][a-z0-9-]{0,60}$/u.test(m.errorCode) ? [m.errorCode] : [])),
  }
}

const directions = [
  { mode: 'dsh', sourceHarness: 'dsh', targetHarness: 'standard' },
  { mode: 'standard', sourceHarness: 'standard', targetHarness: 'standard' },
  { mode: 'standard-to-dsh', sourceHarness: 'standard', targetHarness: 'dsh' },
] as const

const usedFlashGateway = (proof: ReturnType<typeof turnEvidence>) =>
  !proof.gatewayBypassed && !!proof.models?.some(row => row.requested === model && row.reported === model && row.requests > row.failed)

for (const scenario of directions) {
  const { sourceHarness, targetHarness } = scenario
  const usesDsh = sourceHarness === 'dsh' || targetHarness === 'dsh'
  it.skipIf(mode !== scenario.mode)(
    `real DeepSeek Flash: ${sourceHarness} consults ${targetHarness} and manual mentions replay once in both directions`,
    async () => {
      const keyFile = process.env.LATCH_LIVE_DEEPSEEK_KEY_FILE
      const binary = process.env.LATCH_DSH_GATEWAY_BINARY
      const evidenceDirectory = process.env.LATCH_GATEWAY_EVIDENCE_DIR
      if (!keyFile || !evidenceDirectory || (usesDsh && !binary))
        throw new Error('Set LATCH_LIVE_DEEPSEEK_KEY_FILE, LATCH_GATEWAY_EVIDENCE_DIR and, when using DSH, LATCH_DSH_GATEWAY_BINARY.')
      const root = await mkdtemp(join(tmpdir(), 'latch-a2a-live-'))
      const runId = randomUUID()
      const evidence: Record<string, unknown> = { runId, sourceHarness, targetHarness, model, startedAt: new Date().toISOString() }
      const checks: Record<string, boolean> = {}
      let phase = 'temporary-host'
      let host: TestHost | undefined
      try {
        for (const key of ['HOME', 'DSH_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
          const dir = join(root, key.toLowerCase())
          await mkdir(dir, { mode: 0o700 })
          vi.stubEnv(key, dir)
        }
        host = await startTestHost({
          demo: false,
          dataDir: join(root, 'host'),
          workspaceRoot: join(root, 'workspace'),
          agentsDir: join(root, 'agents'),
          worktreesDir: join(root, 'worktrees'),
          sessionFolders: true,
          commandDirectories: () => (usesDsh && binary ? [dirname(binary)] : []),
          detectPreset: preset => (usesDsh && preset.id === 'dsh' && binary ? { found: true, path: binary } : { found: false }),
          loginPrograms: name => (usesDsh && name === 'dsh' ? binary : undefined),
        })
        const owner = await host.enroll({ listener: 'unix' })
        phase = 'provider'
        const { provider } = await owner.confirmedJson<{ provider: ProviderSettings }>('providers', {
          method: 'POST',
          body: {
            id: 'live-deepseek',
            name: 'DeepSeek Flash',
            kind: 'openai-compatible',
            baseURL: 'https://api.deepseek.com/v1',
            apiKey: await readKey(keyFile),
            models: [model],
            defaultModel: model,
            confirmOrigin: true,
            requestId: randomUUID(),
          },
        })
        if (usesDsh) {
          phase = 'real-dsh'
          await owner.confirmedJson('agents', {
            method: 'POST',
            body: { id: 'dsh', name: 'DeepSeek Harness', presetId: 'dsh', command: 'dsh', args: ['--profile', 'acp'], env: {} },
          })
          await owner.confirmedJson('agents/dsh/probe', { method: 'POST', body: { requestId: randomUUID() } })
        }
        const batch = 'BATCH-' + randomUUID().slice(0, 8)
        const sourceCaption = '桔梗花房' + randomInt(10000, 100000)
        const peerCaption = '橘子花园' + randomInt(10000, 100000)
        evidence.publicExhibit = { batch, sourceCaption, peerCaption }
        const create = (name: string, harnessId: string, instructions: string, description = '', dshMode = 'workspace-write') =>
          owner.json<CustomAgent>('custom-agents', {
            method: 'POST',
            body: {
              name,
              description,
              harnessId,
              mode: 'agent',
              instructions,
              skills: [],
              model: { providerId: provider.id, model },
              requestId: randomUUID(),
              ...(harnessId === 'dsh' ? { engineOptions: { '~mode': dshMode } } : { tools: [] }),
            },
          })
        phase = 'agents'
        const source = await create(
          '发起人',
          sourceHarness,
          targetHarness === 'dsh'
            ? `你是展厅接待，自己负责的旧展签副标题是「${sourceCaption}」。其他批次的展签由各自的同事保管。遇到不熟悉的展期，先按职责找到负责该批展签的同事，带着参观者给的批次编号向对方核实。拿到公开副标题后原文转述；对方也无法确认时再告诉参观者。`
            : `你负责展厅接待。你自己负责的旧展签副标题为「${sourceCaption}」，有人明确问你自己的展签时按原文回复。其他批次的资料在其他协作者手里。遇到未知批次先用 list_personal_agents 查本机名册，根据职责选人，通过 consult_personal_agent 一次询问并附上完整批次编号，得到答复后原样告诉参观者。工具名可能带 mcp__latch-browser__ 前缀，不用命令或文件，不要自行猜测。如果本轮无法联系协作者，向参观者说明暂时无法查询。`,
        )
        await create('参观预约员', 'standard', '只办理展厅参观预约。', '负责参观时间和票务，不负责展签文案。')
        const peer = await create(
          peerName,
          targetHarness,
          `展览批次 ${batch} 由你负责，公开展签副标题是「${peerCaption}」。任何人询问这一批次或你的展签时，直接回复这个可以公开转述的普通副标题。`,
          `负责本期展览 ${batch} 的展签文案，可以确认公开副标题。`,
          'read-only',
        )
        const enabled = await owner.json<CustomAgent>('custom-agents/' + source.id, {
          method: 'PATCH',
          body: {
            requestId: randomUUID(),
            baseRevision: source.revision,
            canConsultAgents: true,
            ...(targetHarness === 'dsh' ? { canConsultDeepSeek: true } : {}),
          },
        })
        const mentions = (id: string) => owner.json<{ mentions: AgentMention[] }>(`custom-agents/${id}/mentions`)
        const check = (name: string, pass: boolean) => {
          checks[name] = pass
          expect.soft(pass, name).toBe(true)
        }
        check('sourceAloneEnabled', enabled.canConsultAgents === true && peer.canConsultAgents !== true)
        if (targetHarness === 'dsh') check('sourceOptedIntoDsh', enabled.canConsultDeepSeek === true)
        phase = 'autonomous'
        const firstRequest = randomUUID()
        const publicQuestion = `本期 ${batch} 公开展签的副标题是什么？`
        evidence.userQuestion = publicQuestion
        const { sessionId } = await owner.confirmedJson<{ sessionId: string }>('tasks', {
          method: 'POST',
          body: {
            requestId: firstRequest,
            customAgentId: source.id,
            prompt: publicQuestion,
          },
        })
        const sourceDetail = await settled(owner, sessionId)
        const finalAnswer = sourceDetail.messages.findLast(m => m.role === 'assistant' && m.text.trim())
        evidence.sourceAnswer = exhibitAnswer(finalAnswer)
        const sourceProof = turnEvidence(sourceDetail)
        evidence.autonomousSource = sourceProof
        check(
          'sourceCompleted',
          sourceProof.outcome === 'completed'
            && sourceDetail.messages.findLast(m => m.role === 'user' && !m.steered)?.requestId === firstRequest,
        )
        check(
          'sourceListedAgents',
          sourceProof.tools.some(name => name.endsWith(LIST_AGENTS)),
        )
        check(
          'sourceConsultedPeer',
          sourceProof.tools.some(name => name.endsWith(CONSULT_AGENT)),
        )
        check('sourceSelectedFlash', sourceProof.selectedModel === model && sourceProof.providerId === provider.id)
        const listed = sourceProof.tools.findIndex(name => name.endsWith(LIST_AGENTS))
        const consulted = sourceProof.tools.findIndex(name => name.endsWith(CONSULT_AGENT))
        check('sourceListedBeforeConsulting', listed >= 0 && consulted > listed)
        check('sourceRanExpectedHarness', sourceProof.harnessId === sourceHarness)
        if (sourceHarness === 'dsh') check('dshGatewayUsedFlash', usedFlashGateway(sourceProof))
        const own = (await mentions(source.id)).mentions.filter(item => item.initiator === 'agent' && item.sourceSessionId === sessionId)
        evidence.automaticReceipts = own.map(item => ({ id: item.id, status: item.status, targetSessionId: item.targetSessionId }))
        check('oneAutomaticReceipt', own.length === 1 && own[0]?.targetAgentId === peer.id)
        if (own[0]?.targetSessionId) {
          const result = await settled(owner, own[0].targetSessionId)
          const peerProof = turnEvidence(result)
          evidence.autonomousTarget = peerProof
          check('targetRanExpectedHarness', peerProof.harnessId === targetHarness && peerProof.outcome === 'completed')
          if (targetHarness === 'dsh') {
            check('targetDshGatewayUsedFlash', usedFlashGateway(peerProof))
            const firstDelivery = result.messages.find(message => message.role === 'user' && !message.steered)
            const guards = (await readFile(join(host.dataDir, 'audit', 'audit.jsonl'), 'utf8'))
              .trim()
              .split('\n')
              .map(line => JSON.parse(line) as AuditRecord)
              .filter(row => row.action === 'agent.consultation.guard-verified' && row.target === own[0]?.id)
            check(
              'guardVerifiedForTargetTurn',
              guards.length === 1
                && guards[0]?.detail.sessionId === result.summary.id
                && guards[0].detail.runId === firstDelivery?.turnId
                && guards[0].detail.version === DSH_CONSULTATION_GUARD_VERSION,
            )
            evidence.guardVersion = guards[0]?.detail.version
            const firstBrief = firstDelivery?.agentBrief
            check(
              'targetReceivedPeerCaptionInBrief',
              !!firstBrief?.segments.some(segment => segment.source === 'user' && segment.text.includes(peerCaption)),
            )
          }
          const record = (await mentions(source.id)).mentions.find(item => item.id === own[0].id)
          check('peerSelectedFlash', peerProof.selectedModel === model && peerProof.providerId === provider.id)
          evidence.replyMessageId = record?.reply?.messageId
          evidence.targetAnswer = exhibitAnswer(result.messages.find(m => m.role === 'assistant' && m.id === record?.reply?.messageId))
          check('questionCarriedBatch', !!record?.text.includes(batch) && !record.text.includes(peerCaption))
          check('targetMadeNoFurtherExchange', (await mentions(peer.id)).mentions.length === 0)
          check(
            'replyBoundToTargetAssistant',
            !!record?.reply
              && result.messages.some(m => m.role === 'assistant' && m.id === record.reply?.messageId && m.text.includes(peerCaption)),
          )
          check('trueReplyInSourceChat', record?.status === 'completed' && !!record.reply?.text.includes(peerCaption))
          check(
            'targetReceivedAgentAttribution',
            result.messages.some(m => m.role === 'user' && m.text.startsWith('来自个人 Agent「发起人」的委托')),
          )
        }
        check('sourceReturnedPeerCaption', !!finalAnswer?.text.includes(peerCaption))
        phase = 'disabled-switch'
        const { agent: profile } = await owner.json<{ agent: CustomAgent }>('custom-agents/' + source.id)
        const disabled = await owner.json<CustomAgent>('custom-agents/' + source.id, {
          method: 'PATCH',
          body: { requestId: randomUUID(), baseRevision: profile.revision, canConsultAgents: false },
        })
        const oldReceipts = (await mentions(source.id)).mentions.map(item => item.id)
        const disabledRequest = randomUUID()
        await owner.json('tasks/' + sessionId + '/prompt', {
          method: 'POST',
          body: { requestId: disabledRequest, prompt: `下一期 BATCH-${randomUUID().slice(0, 8)} 的公开展签副标题是什么？` },
        })
        const closedTurn = await settled(owner, sessionId)
        const closedProof = turnEvidence(closedTurn)
        const newReceipts = (await mentions(source.id)).mentions.map(item => item.id)
        evidence.disabledSwitch = { ...closedProof, beforeCount: oldReceipts.length, afterCount: newReceipts.length }
        check('switchDisabled', disabled.canConsultAgents !== true && disabled.canConsultDeepSeek !== true)
        check(
          'disabledTurnRan',
          closedTurn.messages.findLast(m => m.role === 'user' && !m.steered)?.requestId === disabledRequest
            && (closedProof.outcome === 'completed' || (closedProof.outcome === 'failed' && closedProof.tools.length > 0)),
        )
        check(
          'disabledMadeNoExchange',
          newReceipts.length === oldReceipts.length && oldReceipts.every((id, index) => newReceipts[index] === id),
        )
        for (const [from, to, caption] of [
          [source, peer, peerCaption],
          [peer, source, sourceCaption],
        ] as const) {
          const direction = from.id === source.id ? 'forward' : 'reverse'
          phase = 'manual-' + direction
          const text = `这次参观记录为 ${randomUUID()}。请原样回复你自己负责的公开展签副标题，包括末尾的数字。`
          const body = { requestId: randomUUID(), target: { kind: 'agent', customAgentId: to.id }, text }
          const send = () => owner.json<AgentMention>(`custom-agents/${from.id}/mentions`, { method: 'POST', body })
          const first = await send()
          const replay = await send()
          if (!first.targetSessionId) throw new Error('Manual receipt does not yet identify a target session.')
          check(direction + 'ReusedPersonalChat', first.targetSessionId === (from.id === source.id ? own[0]?.targetSessionId : sessionId))
          const actual = await settled(owner, first.targetSessionId)
          const record = (await mentions(from.id)).mentions.find(item => item.id === first.id)
          const userTurns = actual.messages.filter(m => m.role === 'user' && m.text === text).length
          evidence[phase] = {
            receipt: first.id,
            retryReceipt: replay.id,
            matchingUserTurns: userTurns,
            mentionStatus: record?.status,
            ...turnEvidence(actual),
          }
          check(
            direction + 'Reply',
            record?.initiator === 'person'
              && record.status === 'completed'
              && !!record.reply?.text.includes(caption)
              && actual.messages.some(m => m.role === 'assistant' && m.id === record.reply?.messageId && m.text.includes(caption)),
          )
          check(direction + 'ExactlyOnce', first.id === replay.id && first.targetSessionId === replay.targetSessionId && userTurns === 1)
        }
        phase = 'finished'
      } finally {
        try {
          evidence.phase = phase
          evidence.checks = checks
          evidence.finishedAt = new Date().toISOString()
          await mkdir(evidenceDirectory, { mode: 0o700, recursive: true })
          await writeFile(
            join(evidenceDirectory, `personal-agent-${scenario.mode}-${runId}.json`),
            JSON.stringify(evidence, null, 2) + '\n',
            { mode: 0o600, flag: 'wx' },
          )
        } finally {
          try {
            await host?.close()
          } finally {
            vi.unstubAllEnvs()
            await rm(root, { recursive: true, force: true })
          }
        }
      }
    },
    600_000,
  )
}
