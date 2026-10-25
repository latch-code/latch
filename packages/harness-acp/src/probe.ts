import { realpath } from 'node:fs/promises'
import type { AgentProbeResult, AgentRecord } from '@latch/protocol'
import { AppError, type LaunchPreview } from '@latch/sdk'
import { redactSecrets } from '@latch/core/node-kit'
import { redactor, resolveCommand } from './command.ts'
import { AgentConnection, ConnectionClosed } from './connection.ts'
import { agentEnvironment } from './environment.ts'
import { launchHash, selectProfile, validateAgentDefinition } from './permission.ts'
import { fingerprintProjectConfig } from './project-config.ts'
import { initializeResult, PROTOCOL_VERSION, RPC, RpcError } from './protocol.ts'

interface ProbeOptions {
  dataDir: string
  cwd: string
}
const CAPABILITIES = { images: false, resume: false, load: false, additionalDirectories: false }
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
    profileVersion: 1 as const,
    ...(profile ? { presetId: profile.presetId } : {}),
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
    args: [...agent.args],
    envNames: Object.keys(env).sort(),
    definitionEnvNames: Object.keys(agent.env).sort(),
    launchHash: hash,
    definitionHash,
    verified: selection.verified,
    approvals: profile?.permission.approvals ?? 'prompts',
    readback: profile?.permission.readback ?? 'none',
    notes: selection.notes ?? [],
  }
}

/** One initialize request, no session/new, authenticate or prompt; always waits for the process to stop. */
export async function probeAgent(
  agent: AgentRecord,
  options: ProbeOptions & { expectedLaunchHash: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<AgentProbeResult> {
  const preview = await agentProbePreview(agent, options)
  if (preview.launchHash !== options.expectedLaunchHash)
    throw new AppError(409, 'agent-definition-changed', 'Agent 启动内容已变化，请重新测试并确认。')
  if (options.signal?.aborted) throw new AppError(409, 'probe-cancelled', '测试启动已取消。')
  const mask = redactor(agent.env)
  const shortSecrets = Object.entries(agent.env)
    .filter(([name, value]) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/iu.test(name) && value.length > 0 && value.length < 4)
    .map(([, value]) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
  const shortPattern = shortSecrets.length ? new RegExp(shortSecrets.join('|'), 'gu') : undefined
  const redact = (text: string) => redactSecrets(mask(shortPattern ? text.replace(shortPattern, '[redacted]') : text))
  const bounded = (text: string, bytes = 4096) => Buffer.from(redact(text), 'utf8').subarray(-bytes).toString('utf8')
  const profile = selectProfile(agent).profile
  const materializedEnv = await profile?.materialize?.({ dataDir: options.dataDir })
  // Recheck after materializing settings; no process may start with a stale definition or after Host shutdown.
  const final = await agentProbePreview(agent, options)
  if (final.launchHash !== preview.launchHash || options.signal?.aborted)
    throw new AppError(409, 'agent-definition-changed', 'Agent 启动内容已变化，请重新测试并确认。')
  const connection = AgentConnection.spawn(
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
      notification: () => {},
      exit: () => {},
    },
  )
  const abort = () => {
    void connection.stop('kill', 0)
  }
  options.signal?.addEventListener('abort', abort, { once: true })
  let result: AgentProbeResult
  let diagnostic: string | undefined
  try {
    const parsed = initializeResult.safeParse(
      await connection.request(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'latch', title: 'Latch', version: '0.1.0' },
        },
        Math.max(1, Math.min(15_000, options.timeoutMs ?? 15_000)),
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
    result = {
      status: 'ready',
      checkedAt: new Date().toISOString(),
      launchHash: final.launchHash,
      capabilities: {
        images: caps?.promptCapabilities?.image === true,
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
  result.checkedAt = new Date().toISOString()
  if (diagnostic) result.diagnostic = bounded([diagnostic, connection.stderrTail(4096)].filter(Boolean).join('\n'))
  return result
}
