import { realpath } from 'node:fs/promises'
import { AGENT_PROBE_MAX_MS, type AgentProbeResult, type AgentRecord } from '@latch/protocol'
import { AppError, type LaunchPreview } from '@latch/sdk'
import { redactSecrets } from '@latch/core/node-kit'
import { authFacts, reportedLogin, terminalLogins, type ReportedLogin } from './auth.ts'
import { redactor, resolveCommand } from './command.ts'
import { openWire, wireArgs } from './wires/index.ts'
import { ConnectionClosed } from './wires/process.ts'
import { agentEnvironment, programPaths } from './environment.ts'
import { checkLogin, readProgramVersion } from './login.ts'
import { launchHash, selectProfile, validateAgentDefinition } from './permission.ts'
import { fingerprintProjectConfig } from './project-config.ts'
import { assertVersion } from './version.ts'
import { AUTH_STATUS_METHOD, clientCapabilities, initializeResult, PROTOCOL_VERSION, RPC, RpcError } from './protocol.ts'

interface ProbeOptions {
  dataDir: string
  cwd: string
}
const HANDSHAKE_MS = 15_000
/** How long a harness that pushes its login state gets to push it after the handshake. */
const PUSH_WAIT_MS = 5_000
const CAPABILITIES = { embeddedContext: false, images: false, resume: false, load: false, additionalDirectories: false }
const isObject = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Same command, environment and configuration fingerprint as execution, without opening an ACP session. */
export async function agentProbePreview(agent: AgentRecord, options: ProbeOptions): Promise<LaunchPreview> {
  const verdict = validateAgentDefinition(agent)
  if (!verdict.ok) throw verdict.error
  const found = resolveCommand(agent.command)
  if (!found) throw new AppError(503, 'agent-not-found', '未找到 Agent 命令，请先完成安装或修改命令。')
  const command = await realpath(found)
  const cwd = await realpath(options.cwd)
  const selection = selectProfile(agent)
  const profile = selection.profile
  const project = await fingerprintProjectConfig(cwd, profile?.projectConfigPaths ?? [], profile?.projectConfigManaged)
  const definition = {
    resolvedCommand: command,
    args: agent.args,
    definitionEnv: agent.env,
    profileVersion: profile?.version ?? 1,
    ...(profile ? { presetId: profile.presetId } : {}),
    ...(profile?.permission.inheritEnv ? { inheritEnv: profile.permission.inheritEnv } : {}),
    programs: programPaths(profile?.permission),
  }
  const definitionHash = launchHash(definition)
  const hash = project.digest ? launchHash({ ...definition, projectConfig: project.digest }) : definitionHash
  const materializedEnv = await profile?.materialize?.({ dataDir: options.dataDir })
  const env = agentEnvironment({
    resolvedCommand: command,
    profile: profile?.permission,
    materializedEnv,
    definitionEnv: agent.env,
    sessionTmpDir: cwd,
  })
  return {
    command,
    cwd,
    args: [...agent.args, ...wireArgs(profile?.wire)],
    envNames: Object.keys(env).sort(),
    definitionEnvNames: Object.keys(agent.env).sort(),
    launchHash: hash,
    definitionHash,
    verified: selection.verified,
    approvals: profile?.permission.approvals ?? 'prompts',
    readback: profile?.permission.readback ?? 'none',
  }
}

/**
 * One initialize request, no session/new, authenticate or prompt; always waits for the process to stop. `timeoutMs` bounds
 * the whole of it, login and version reads included, so the page's own wait outlasts it.
 */
export async function probeAgent(
  agent: AgentRecord,
  options: ProbeOptions & { expectedLaunchHash: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<AgentProbeResult> {
  const deadline = Date.now() + Math.max(1, options.timeoutMs ?? AGENT_PROBE_MAX_MS)
  const preview = await agentProbePreview(agent, options)
  if (preview.launchHash !== options.expectedLaunchHash)
    throw new AppError(409, 'agent-definition-changed', 'Agent 启动内容已变化，请重新测试。')
  if (options.signal?.aborted) throw new AppError(409, 'probe-cancelled', '测试启动已取消。')
  const mask = redactor(agent.env)
  const shortSecrets = Object.entries(agent.env)
    .filter(([name, value]) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/iu.test(name) && value.length > 0 && value.length < 4)
    .map(([, value]) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
  const shortPattern = shortSecrets.length ? new RegExp(shortSecrets.join('|'), 'gu') : undefined
  const redact = (text: string) => redactSecrets(mask(shortPattern ? text.replace(shortPattern, '[redacted]') : text))
  const bounded = (text: string, bytes = 4096) => Buffer.from(redact(text), 'utf8').subarray(-bytes).toString('utf8')
  // A command older than its profile supports is refused as a session start is (409 `harness-version-unsupported`),
  // before anything else; the checks below stay the last before the spawn, so a cancel meanwhile starts nothing.
  await assertVersion(agent, preview.command)
  if (options.signal?.aborted) throw new AppError(409, 'probe-cancelled', '测试启动已取消。')
  const selection = selectProfile(agent)
  const profile = selection.profile
  const materializedEnv = await profile?.materialize?.({ dataDir: options.dataDir })
  // Recheck after materializing settings; no process may start with a stale definition or after Host shutdown.
  const final = await agentProbePreview(agent, options)
  if (final.launchHash !== preview.launchHash || options.signal?.aborted)
    throw new AppError(409, 'agent-definition-changed', 'Agent 启动内容已变化，请重新测试。')
  const connection = openWire(
    profile?.wire,
    {
      command: final.command,
      args: [...agent.args],
      cwd: final.cwd,
      env: agentEnvironment({
        resolvedCommand: final.command,
        profile: profile?.permission,
        materializedEnv,
        definitionEnv: agent.env,
        sessionTmpDir: final.cwd,
      }),
      maxLineBytes: 1024 * 1024,
      redact,
    },
    {
      request: async () => {
        throw new RpcError(RPC.methodNotFound, 'Unsupported during initialize-only probe')
      },
      notification: (method, params) => {
        if (method !== AUTH_STATUS_METHOD) return
        const report = reportedLogin(params)
        if (report?.status === 'unknown') return
        pushed = report
        if (pushed) pushedNow?.()
      },
      exit: () => {},
    },
  )
  const abort = () => {
    void connection.stop('kill', 0)
  }
  options.signal?.addEventListener('abort', abort, { once: true })
  let result: AgentProbeResult
  let diagnostic: string | undefined
  let pushed: ReportedLogin | undefined
  let pushedNow: (() => void) | undefined
  try {
    const parsed = initializeResult.safeParse(
      await connection.request(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: clientCapabilities(selection.preset?.signIn === undefined),
          clientInfo: { name: 'latch', title: 'Latch', version: '0.1.0' },
        },
        Math.max(1, Math.min(HANDSHAKE_MS, deadline - Date.now())),
        options.signal,
      ),
    )
    if (!parsed.success || parsed.data.protocolVersion !== PROTOCOL_VERSION)
      throw new Error('Agent 的 ACP initialize 响应无效或版本不兼容。')
    const data = parsed.data
    const reported = data.agentInfo?.version
    const rule = profile?.permission.versionRule
    if (rule && (typeof reported !== 'string' || !new RegExp(rule.pattern).test(reported))) throw new Error('Agent 版本未经此预设验证。')
    const caps = data.agentCapabilities
    const located = resolveCommand(agent.command)
    if (located) authFacts(agent)?.learn(located, terminalLogins(data.authMethods), caps?.auth?.logout != null)
    // Pushed after the answer to initialize: a short wait, cut short by the push, the deadline or a cancel.
    if (caps?._meta?.authStatus != null && !pushed) {
      let stop = () => {}
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, Math.max(0, Math.min(PUSH_WAIT_MS, deadline - Date.now() - 2_000)))
        stop = () => {
          clearTimeout(timer)
          resolve()
        }
        pushedNow = stop
        options.signal?.addEventListener('abort', stop, { once: true })
      })
      options.signal?.removeEventListener('abort', stop)
    }
    result = {
      status: 'ready',
      checkedAt: new Date().toISOString(),
      launchHash: final.launchHash,
      capabilities: {
        images: caps?.promptCapabilities?.image === true,
        embeddedContext: caps?.promptCapabilities?.embeddedContext === true,
        resume: caps?.sessionCapabilities?.resume != null,
        load: caps?.loadSession === true,
        additionalDirectories: isObject(caps?.sessionCapabilities?.additionalDirectories),
      },
      ...(data.agentInfo
        ? {
            agent: {
              ...(data.agentInfo.name ? { name: bounded(data.agentInfo.name, 200) } : {}),
              ...(reported ? { version: bounded(reported, 100) } : {}),
            },
          }
        : {}),
      authMethods: (data.authMethods ?? []).slice(0, 16).map(method => ({
        name: bounded(method.name, 200),
        ...(method.description ? { description: bounded(method.description, 500) } : {}),
      })),
    }
  } catch (error) {
    diagnostic =
      error instanceof ConnectionClosed ? (error.info.error ?? error.message) : error instanceof Error ? error.message : '测试启动失败。'
    result = {
      status: error instanceof RpcError && error.code === RPC.authRequired ? 'authentication-required' : 'failed',
      checkedAt: new Date().toISOString(),
      launchHash: final.launchHash,
      capabilities: { ...CAPABILITIES },
      authMethods: [],
    }
  } finally {
    options.signal?.removeEventListener('abort', abort)
    await connection.stop('kill', 0)
  }
  // The handshake says nothing about a login, so a harness that can say gets asked too. Its refusal is as clear an answer.
  // Beside the adapter, the program it drives: a pair the adapter was not built for gets a warning, never a refusal.
  // Both reads run together in the time the handshake left; with none left, the login is as unknown as a timed-out check.
  const left = deadline - Date.now()
  const reads = left > 0 ? { timeoutMs: left, ...(options.signal ? { signal: options.signal } : {}) } : undefined
  // What the harness pushed is its own answer, so its status command, whose output may hold part of a key, need not run.
  const asksLogin = result.status !== 'authentication-required' && !pushed && profile?.loginStatus !== undefined && !options.signal?.aborted
  const pairing = profile?.programVersion
  const name = selection.preset?.name
  const [login, program] = await Promise.all([
    asksLogin && reads ? checkLogin(agent, reads) : undefined,
    pairing && name && reads && !options.signal?.aborted ? readProgramVersion(agent, reads) : undefined,
  ])
  if (result.status === 'authentication-required') result.login = 'unauthenticated'
  else if (pushed) result.login = pushed.status
  else if (asksLogin) result.login = login?.status ?? 'unknown'
  if (pairing && name && program) {
    const adapter = result.agent?.version
    const version = program.version === undefined ? undefined : bounded(program.version, 100)
    const unchecked =
      adapter !== undefined
      && version !== undefined
      && !pairing.checked.some(pair => new RegExp(pair.adapter, 'u').test(adapter) && new RegExp(pair.program, 'u').test(version))
    if (program.found) result.program = { name, ...(version ? { version } : {}), ...(unchecked ? { unchecked: true as const } : {}) }
  }
  result.checkedAt = new Date().toISOString()
  if (diagnostic) result.diagnostic = bounded([diagnostic, connection.stderrTail(4096)].filter(Boolean).join('\n'))
  return result
}
