import { chromium, type Browser, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { expect, it } from 'vitest'
import { AGENT_PRESETS, type Approval, type AppSnapshot, type CustomAgent, type ExtensionsResponse, type TaskDetail } from '@latch/protocol'
import { FAKE_ACP_AGENT, type TestDevice } from '@latch/testkit'
import { browserLaunchOptions, connected, enrollBrowser } from './helpers/browser.ts'
import { startTestHost, type TestHost } from './helpers/host.ts'
import { openSection, openSession, openSettings } from './helpers/layout.ts'
import { homeInput, switchView } from './helpers/workbench.ts'

const selected = process.env.LATCH_LIVE_HARNESS
const binary = process.env.LATCH_LIVE_HARNESS_BINARY
const fixture = selected === undefined && binary === undefined
const mode = fixture ? 'reply' : (process.env.LATCH_LIVE_HARNESS_MODE ?? 'reply')
const allowed = ['codex', 'claude-agent', 'pi', 'antigravity', 'grok', 'qwen', 'goose']
const ANSWER = 'LATCH-OK'
const REPLY = `Reply with only ${ANSWER}. Do not use tools.`
const TODO = { title: 'Latch acceptance marker', prompt: `Reply with only ${ANSWER}.` }
const PROPOSE = `Call latch-skills.propose_todo once with ${JSON.stringify(TODO)}. Use no other tools. Then reply with only ${ANSWER}.`
const AGENT_NAME = '验收 Agent'
const BROWSER_NAME = '验收浏览器'
const snapshot = (owner: TestDevice) => owner.json<AppSnapshot>('snapshot')
const detail = (owner: TestDevice, id: string) => owner.json<TaskDetail>(`tasks/${id}`)

async function closeHost(fixture: TestHost): Promise<void> {
  // The fixture removes its runtime directory even when shutdown rejects. Confirm the Host has stopped first.
  await fixture.host.close()
  await fixture.close()
}

async function openAgentChat(page: Page, agentId: string): Promise<void> {
  await page.getByRole('radio', { name: '我的 Agent', exact: true }).filter({ visible: true }).first().click()
  await page.getByRole('navigation', { name: '我的 Agent', exact: true }).locator(`[data-agent-id="${agentId}"]`).click()
}

/** The only approval this test can grant is a one-time Latch tool call carrying its exact synthetic 待办. */
function isProposalApproval(approval: Approval): boolean {
  if (approval.subagent || approval.tool?.kind !== 'other' || approval.tool.title !== '调用 latch-skills.propose_todo') return false
  if (!approval.options?.some(option => option.id === 'accept' && option.kind === 'allow_once')) return false
  const input = JSON.parse(approval.arguments ?? 'null') as { server?: unknown; tool?: unknown; arguments?: unknown } | null
  return (
    input?.server === 'latch-skills'
    && input.tool === 'propose_todo'
    && typeof input.arguments === 'string'
    && isDeepStrictEqual(JSON.parse(input.arguments), TODO)
  )
}

async function acceptTodo(page: Page, owner: TestDevice, task: TaskDetail, observed: Record<string, unknown>): Promise<string> {
  const proposals = async () => (await snapshot(owner)).workProposals?.filter(row => row.from.sessionId === task.summary.id) ?? []
  await expect.poll(async () => (await proposals()).length).toBe(1)
  const [proposal] = await proposals()
  expect(proposal?.kind).toBe('todo')
  expect(proposal?.private).toBe(true)
  expect(proposal?.external).toBeUndefined()
  expect(proposal?.entries?.length).toBe(1)
  expect(proposal?.entries?.[0]?.title === TODO.title).toBe(true)
  expect(proposal?.from.messageId === task.messages.find(message => message.role === 'user')!.id).toBe(true)
  expect((await snapshot(owner)).items?.length ?? 0).toBe(0)

  await page.getByRole('radio', { name: 'Code', exact: true }).filter({ visible: true }).first().click()
  await switchView(page, 'board')
  await page.locator(`.work-board-card[data-work-proposal="${proposal!.id}"]`).getByRole('button', { name: '审阅', exact: true }).click()
  const review = page.getByRole('dialog', { name: '审阅提议', exact: true })
  expect((await review.getByRole('textbox', { name: '要求', exact: true }).inputValue()) === TODO.prompt).toBe(true)
  const [receipt] = await Promise.all([
    page.waitForResponse(
      response =>
        response.request().method() === 'POST' && new URL(response.url()).pathname === `/link/api/work/proposals/${proposal!.id}/accept`,
    ),
    review.getByRole('button', { name: '接受', exact: true }).click(),
  ])
  expect(receipt.ok()).toBe(true)
  const { itemIds } = (await receipt.json()) as { itemIds?: string[] }
  expect(itemIds?.length).toBe(1)
  const itemId = itemIds![0]!
  const itemPage = page.locator(`.item-page[data-item-id="${itemId}"]`)
  const card = page.locator(`.work-board-card[data-work-item="${itemId}"] .work-board-card-main`)
  await itemPage.or(card).filter({ visible: true }).first().waitFor()
  observed.openedFromAccept = await itemPage.isVisible()
  if (await card.isVisible()) await card.click()
  await itemPage.getByRole('heading', { name: TODO.title, exact: true }).waitFor()

  const saved = (await snapshot(owner)).items?.find(row => row.id === itemId)
  expect(saved?.board.group).toBe('todo')
  expect(saved?.sessionIds.length).toBe(0)
  expect(saved?.from?.sessionId === task.summary.id && saved?.from?.proposalId === proposal!.id).toBe(true)
  observed.acceptedUnstarted = true
  return itemId
}

it(
  fixture
    ? 'checks the Harness report panels and reopens the same turn with a local ACP fixture'
    : 'shows one real Harness turn, keeps its source after a temporary Host restart and opens it once',
  { timeout: 240_000 },
  async () => {
    const executable = fixture ? process.execPath : binary
    const preset = fixture
      ? { id: 'acceptance-fixture', name: '验收 Harness', command: basename(process.execPath), args: [FAKE_ACP_AGENT] }
      : AGENT_PRESETS.find(item => item.id === selected && allowed.includes(item.id))
    if (!preset || !executable || !isAbsolute(executable) || basename(executable) !== preset.command)
      throw new Error('Select one supported Harness and its absolute preset command path.')
    if (mode !== 'reply' && !(mode === 'todo' && preset.id === 'codex')) throw new Error('Choose reply mode or use todo mode with Codex.')

    const root = await mkdtemp(join(tmpdir(), 'latch-live-harness-'))
    const bin = join(root, 'bin')
    const start = () =>
      startTestHost({
        dataDir: join(root, 'data'),
        workspaceRoot: join(root, 'workspace'),
        worktreesDir: join(root, 'worktrees'),
        agentsDir: join(root, 'agents'),
        hostName: '验收电脑',
        demo: false,
        commandDirectories: () => [bin],
        detectPreset: () => ({ found: false }),
        log: () => {},
      })
    let host: TestHost | undefined
    let browser: Browser | undefined
    let stage = 'setup'
    // CLI text, HTTP bodies and exceptions can contain private data.
    const observed: Record<string, unknown> = { harness: preset.id, mode }
    try {
      // A normal installation directory may contain other presets. Lookup here must only see the selected program.
      await mkdir(bin)
      await symlink(executable, join(bin, preset.command))
      host = await start()
      let owner = await host.enroll({ listener: 'unix' })
      // Keep the vendors' background installers off in these processes without changing their settings.
      const env: Record<string, string> = {}
      if (fixture) {
        env.FAKE_ACP_REPLY_QUEUE = join(root, 'replies.json')
        await writeFile(env.FAKE_ACP_REPLY_QUEUE, JSON.stringify([ANSWER]), { mode: 0o600 })
      }
      if (preset.id === 'antigravity') env.AGY_CLI_DISABLE_AUTO_UPDATE = 'true'
      if (preset.id === 'claude-agent') {
        env.DISABLE_AUTOUPDATER = '1'
        env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL = '1'
      }
      const saved = await owner.confirmed('agents', {
        body: {
          id: preset.id,
          name: preset.name,
          ...(fixture ? {} : { presetId: preset.id }),
          command: executable,
          args: preset.args,
          env,
        },
      })
      observed.setupStatus = saved.status
      expect(saved.status).toBe(201)
      let agent: CustomAgent | undefined
      if (mode === 'todo')
        agent = await owner.json<CustomAgent>('custom-agents', {
          body: { requestId: randomUUID(), name: AGENT_NAME, harnessId: preset.id, mode: 'agent', instructions: '', skills: [] },
        })
      browser = await chromium.launch(browserLaunchOptions())
      let turnRequests = 0
      const attach = async (node: TestHost, owner: TestDevice, name: string): Promise<Page> => {
        const page = await browser!.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' })
        page.setDefaultTimeout(15_000)
        page.on('request', request => {
          const path = new URL(request.url()).pathname
          if (request.method() === 'POST' && /^\/link\/api\/tasks(?:\/[^/]+\/prompt)?$/u.test(path)) turnRequests++
        })
        await enrollBrowser(page, node, { name, scopes: ['view', 'run', 'admin'] })
        if (agent) {
          const device = node.host.security.devices.list().find(item => item.name === name && item.status === 'active')!
          const scope = await owner.confirmed(`devices/${device.id}`, { method: 'PATCH', body: { dataScope: 'all' } })
          expect(scope.status).toBe(200)
          await page.reload()
          await connected(page)
          await openAgentChat(page, agent.id)
        }
        return page
      }
      stage = 'browser enrollment'
      let page = await attach(host, owner, BROWSER_NAME)
      stage = 'submit one turn'
      const prompt = agent ? PROPOSE : REPLY
      const input = agent ? page.getByRole('textbox', { name: `给${AGENT_NAME}发消息`, exact: true }) : homeInput(page)
      const harnessButton = () => page.getByRole('button', { name: `Harness：${preset.name}`, exact: true }).filter({ visible: true })
      if (!agent) await harnessButton().waitFor()
      await input.fill(prompt)
      const [started] = await Promise.all([
        page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/link/api/tasks'),
        page
          .getByRole('button', { name: /^(发送|开始)$/u })
          .filter({ visible: true })
          .first()
          .click(),
      ])
      observed.startStatus = started.status()
      observed.turnRequests = turnRequests
      if (!started.ok()) {
        const refusal = (await started.json()) as { error?: unknown }
        observed.loginRequired = refusal.error === 'agent-auth-required'
      }
      expect(started.status()).toBe(201)
      const { sessionId } = (await started.json()) as { sessionId: string }

      stage = 'settle one turn'
      let task = await detail(owner, sessionId)
      let approved: string | undefined
      const deadline = Date.now() + 100_000
      while (Date.now() < deadline) {
        observed.status = task.summary.status
        if (task.summary.status === 'running') observed.sawRunning = true
        observed.runOutcome = task.summary.runOutcome
        observed.runEnd = task.summary.runEnd?.reason
        observed.approvals = task.approvals.length
        observed.questions = task.summary.pendingQuestions ?? 0
        if (task.summary.pendingQuestions) throw new Error('The Harness asked a question.')
        if (task.approvals.length > 1) throw new Error('The Harness requested more than one approval.')
        const [approval] = task.approvals
        if (approval && approval.id !== approved) {
          if (!agent || approved || !isProposalApproval(approval)) throw new Error('Unexpected approval.')
          approved = approval.id
          const answer = await owner.confirmed(`approvals/${approval.id}`, {
            body: { decision: 'allow', optionId: 'accept', requestId: randomUUID() },
          })
          expect(answer.ok).toBe(true)
        }
        if (task.summary.status !== 'running' && task.summary.status !== 'waiting-approval') break
        await delay(250)
        task = await detail(owner, sessionId)
      }
      observed.timedOut = Date.now() >= deadline && (task.summary.status === 'running' || task.summary.status === 'waiting-approval')
      observed.loginRequired =
        task.summary.runEnd?.reason === 'login-required' || task.messages.some(message => message.errorCode === 'agent-auth-required')
      const publicFailures = new Set([
        'agent-exited',
        'agent-timeout',
        'agent-auth-required',
        'harness-session-lost',
        'agent-error',
        'agent-unavailable',
      ])
      const failures = task.messages.flatMap(message =>
        message.errorCode ? [publicFailures.has(message.errorCode) ? message.errorCode : 'other'] : [],
      )
      if (failures.length) observed.failureCodes = [...new Set(failures)]
      expect(task.summary.status).toBe('idle')
      expect(task.summary.runOutcome).toBe('completed')
      expect(task.summary.runId).toBeTruthy()
      expect(task.summary.harnessId === preset.id && task.summary.id === sessionId).toBe(true)
      expect(task.summary.agent?.customAgentId === agent?.id).toBe(true)
      expect(task.summary.modelRoute === undefined && task.summary.providerId === undefined).toBe(true)
      const user = task.messages.filter(message => message.role === 'user')
      const assistant = task.messages.filter(message => message.role === 'assistant')
      const tool = task.messages.filter(message => message.role === 'tool')
      observed.messages = { user: user.length, assistant: assistant.length, tool: tool.length }
      observed.userExact = user.length === 1 && user[0]!.text === prompt && Boolean(user[0]!.requestId)
      observed.replyExact = assistant.length === 1 && assistant[0]!.text.trim() === ANSWER
      if (agent) {
        const proposals = (await snapshot(owner)).workProposals?.filter(row => row.from.sessionId === sessionId) ?? []
        observed.sourceProposalsAtSettlement = proposals.length
        observed.proposalForThisInput =
          Boolean(user[0]?.id) && proposals.some(row => row.from.messageId === user[0]?.id && row.entries?.[0]?.title === TODO.title)
        observed.reportedProposalTool = tool.some(message => message.toolName === 'latch-skills.propose_todo')
      }
      stage = 'check the stored input'
      expect(user.length).toBe(1)
      expect(user[0]!.text === prompt && Boolean(user[0]!.requestId)).toBe(true)
      stage = 'check the fixed reply'
      expect(assistant.length).toBe(1)
      expect(assistant[0]!.text.trim() === ANSWER).toBe(true)
      stage = 'check the tool activity'
      expect(tool.length).toBe(agent ? 1 : 0)
      // acceptTodo checks the Host's attributed proposal and accepted item. The transcript's tool label is for display.

      const reply = (view: Page) => view.locator(`.transcript .message-assistant[data-message-id="${assistant[0]!.id}"] .message-content`)
      stage = 'render the reply'
      await reply(page).waitFor()
      expect((await reply(page).innerText()).trim() === ANSWER).toBe(true)
      let itemId: string | undefined
      let reportFailure: string | undefined
      if (agent) {
        stage = 'accept the proposal into its todo'
        itemId = await acceptTodo(page, owner, task, observed)
      } else {
        try {
          stage = 'open the bound Harness panel'
          await harnessButton().click()
          await page.getByRole('dialog', { name: 'Harness', exact: true }).waitFor()
          await page.keyboard.press('Escape')
          stage = 'read the model menu'
          const modelCount = task.config?.find(option => option.category === 'model')?.options.length ?? 0
          observed.modelOptions = modelCount
          if (modelCount) {
            await page
              .getByRole('button', { name: /^模型：/u })
              .filter({ visible: true })
              .click()
            await page.getByRole('menu', { name: '模型', exact: true }).waitFor()
            await page.keyboard.press('Escape')
          }
          stage = 'read the quota panel'
          await page.getByRole('button', { name: '额度与用量', exact: true }).filter({ visible: true }).first().click()
          const usage = page.getByRole('dialog', { name: '额度与用量', exact: true })
          await usage.waitFor()
          const harness = () => snapshot(owner).then(current => current.catalog?.harnesses.find(item => item.id === preset.id))
          await expect
            .poll(
              async () => {
                const current = await harness()
                if (!current) return false
                return Boolean(
                  !current.capabilities.models.quota || current.quota || current.quotaRead?.afterTurn || current.quotaRead?.failed,
                )
              },
              { timeout: 35_000 },
            )
            .toBe(true)
          const current = await harness()
          observed.quota = {
            supported: current?.capabilities.models.quota === true,
            afterTurn: current?.quotaRead?.afterTurn === true,
            reported: current?.quota !== undefined,
            windows: current?.quota?.windows.map(window => ({ kind: window.kind, percent: window.usedPercent, state: window.state })) ?? [],
            failure: current?.quotaRead?.failed?.reason,
          }
          if (!current?.capabilities.models.quota)
            expect((await usage.locator('.usage-silent').innerText()).includes(preset.name)).toBe(true)
          await page.keyboard.press('Escape')
          stage = 'read the extensions panel'
          const settings = await openSettings(page)
          await openSection(settings, '扩展')
          await settings.getByRole('button', { name: new RegExp(`^${preset.name}`, 'u') }).click()
          const extensions = settings.locator(`[data-extensions-harness="${preset.id}"]`)
          const plugins = extensions.getByRole('region', { name: '插件', exact: true })
          await plugins.waitFor()
          if (preset.id === 'codex') await plugins.getByText('尚未实现', { exact: true }).waitFor()
          const report = (await owner.json<ExtensionsResponse>('extensions')).harnesses.find(row => row.harnessId === preset.id)?.report
          observed.extensionReport = {
            commands: report?.commands.length ?? null,
            skills: report?.skills?.length ?? null,
            visiblePlugins: await plugins.locator('[data-extension]').count(),
            pluginsNotReported: (await plugins.getByText('这个 Harness 没有报告', { exact: true }).count()) > 0,
            pluginsNotImplemented: (await plugins.getByText('尚未实现', { exact: true }).count()) > 0,
          }
        } catch {
          reportFailure = stage
          observed.reportFailure = stage
        }
      }

      stage = 'restart the temporary Host'
      const instance = host.host.instanceId
      await page.context().close()
      await closeHost(host)
      host = await start()
      expect(host.host.instanceId === instance).toBe(false)
      owner = await host.enroll({ listener: 'unix' })
      const restored = await detail(owner, sessionId)
      const identity = (value: TaskDetail) => value.messages.map(message => [message.id, message.role, message.requestId, message.text])
      expect(restored.summary.status).toBe('idle')
      expect(restored.summary.runOutcome).toBe('completed')
      expect(restored.summary.id === sessionId && restored.summary.runId === task.summary.runId).toBe(true)
      expect(isDeepStrictEqual(identity(restored), identity(task))).toBe(true)
      if (itemId) expect((await snapshot(owner)).items?.find(item => item.id === itemId)?.sessionIds.length).toBe(0)
      page = await attach(host, owner, `${BROWSER_NAME} 重启`)
      if (!agent) await openSession(page, sessionId)
      await reply(page).waitFor()
      expect(await reply(page).count()).toBe(1)
      expect((await reply(page).innerText()).trim() === ANSWER).toBe(true)
      expect((await snapshot(owner)).tasks.length).toBe(1)
      const reopened = await detail(owner, sessionId)
      expect(reopened.summary.runId === task.summary.runId && isDeepStrictEqual(identity(reopened), identity(task))).toBe(true)
      observed.turnRequests = turnRequests
      expect(turnRequests).toBe(1)
      observed.reopenedSameRun = true
      const output = process.env.LATCH_LIVE_HARNESS_EVIDENCE_DIR
      if (output) {
        stage = 'capture the fixed reply'
        await mkdir(output, { recursive: true })
        await reply(page).screenshot({ path: join(output, `${preset.id}-${mode}-reply.png`), animations: 'disabled', caret: 'hide' })
      }
      if (reportFailure) {
        stage = reportFailure
        throw new Error('A Harness report panel could not be verified.')
      }
      observed.result = 'passed'
    } catch {
      observed.result = 'failed'
      observed.stage = stage
      throw new Error(`Live Harness acceptance stopped at ${stage}.`)
    } finally {
      const [browserClose, hostClose] = await Promise.allSettled([browser?.close(), host && closeHost(host)])
      const closed = browserClose.status === 'fulfilled' && hostClose.status === 'fulfilled'
      const rootCleanup = closed
        ? await rm(root, { recursive: true, force: true }).then(
            () => 'removed',
            () => 'removal-failed',
          )
        : 'retained'
      if (rootCleanup !== 'removed') {
        observed.result = 'failed'
        observed.cleanup = {
          browser: browser ? browserClose.status : 'not-started',
          host: host ? hostClose.status : 'not-started',
          root: rootCleanup,
          temporaryRoot: root,
          ...(host && hostClose.status === 'rejected' ? { fixtureRoot: host.root } : {}),
        }
      }
      console.log(JSON.stringify(observed))
      if (rootCleanup !== 'removed') throw new Error('Temporary Harness acceptance cleanup did not complete.')
    }
  },
)
