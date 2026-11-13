import type { ExtensionRequest, HarnessProfile, ProjectedChild, SessionUpdate, ToolDenial } from './types.ts'

/**
 * The four modes, as the adapter route names them, and what each sends to Codex with every turn and thread: its approval
 * policy, the sandbox and who reviews a request. `agent` is Codex's 「Auto review」: the sandbox of `workspace-write`,
 * with requests decided by Codex's own review model instead of the person. A change here is a change of the profile.
 */
export const CODEX_MODES = {
  'read-only': { name: 'Read Only', approvalPolicy: 'untrusted', sandbox: 'read-only', reviewer: 'user' },
  'workspace-write': { name: 'Workspace Write', approvalPolicy: 'on-request', sandbox: 'workspace-write', reviewer: 'user' },
  agent: { name: 'Auto Review', approvalPolicy: 'on-request', sandbox: 'workspace-write', reviewer: 'auto_review' },
  'agent-full-access': { name: 'Full Access', approvalPolicy: 'never', sandbox: 'danger-full-access', reviewer: 'user' },
} as const
export type CodexMode = keyof typeof CODEX_MODES

/** Where the wire marks a subagent's work and a call Codex refused without asking; see `wires/codex.ts`. */
const CHILD = 'latch/codexChild'
const DENIED = 'latch/codexDenied'
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const said = (value: unknown, limit = 300) => (typeof value === 'string' ? value.slice(0, limit) : '')

/** A subagent's call or ask, marked by the wire, as it would arrive on the subagent's own session. */
function projectedChild(value: Record<string, unknown>): { child: ProjectedChild; value: Record<string, unknown> } | undefined {
  const meta = value._meta
  const mark = isRecord(meta) ? meta[CHILD] : undefined
  if (!isRecord(mark) || typeof mark.id !== 'string' || typeof mark.parentID !== 'string') return undefined
  // Its other marks, a refusal among them, stay with it.
  const { [CHILD]: _, ...rest } = meta as Record<string, unknown>
  const { _meta: __, ...own } = value
  return { child: { sessionId: mark.id, parentSessionId: mark.parentID }, value: Object.keys(rest).length ? { ...own, _meta: rest } : own }
}

function denial(update: SessionUpdate): ToolDenial | undefined {
  const meta = update._meta
  const mark = isRecord(meta) ? meta[DENIED] : undefined
  if (!isRecord(mark) || (mark.source !== 'model' && mark.source !== 'rule')) return undefined
  return { source: mark.source, ...(typeof mark.reason === 'string' && mark.reason ? { reason: mark.reason } : {}) }
}

/** What more a permission request asks for, in a few words. */
function widened(params: unknown): string {
  const asked = isRecord(params) && isRecord(params.permissions) ? params.permissions : {}
  const parts: string[] = []
  if (isRecord(asked.network) && asked.network.enabled === true) parts.push('联网')
  const files = isRecord(asked.fileSystem) ? asked.fileSystem : {}
  for (const [key, word] of [
    ['write', '写入'],
    ['read', '读取'],
  ] as const) {
    const paths = Array.isArray(files[key]) ? files[key].filter(item => typeof item === 'string') : []
    if (paths.length) parts.push(`${word} ${paths.slice(0, 3).join('、')}${paths.length > 3 ? ' 等' : ''}`)
  }
  return parts.join('，') || '更多权限'
}

/**
 * Codex's requests no person is asked: each answered at once, said in the session and recorded as automatically
 * refused. Permissions follow the mode the person chose; a question from an MCP server is not passed on yet.
 */
const DECLINED: Readonly<Record<string, ExtensionRequest>> = {
  'item/permissions/requestApproval': {
    decline: (params, agent) => ({
      note: `已自动拒绝：${agent} 请求${widened(params)}。权限只随你在「权限」里选的模式变。`,
      reply: { permissions: {}, scope: 'turn' },
      rejected: true,
    }),
  },
  'mcpServer/elicitation/request': {
    decline: (params, agent) => {
      const server = isRecord(params) ? said(params.serverName, 100) : ''
      const message = isRecord(params) ? said(params.message) : ''
      return {
        note: `已自动拒绝：${agent} 的 MCP 服务器${server ? `「${server}」` : ''}想问你${message ? `「${message}」` : '一个问题'}，Latch 还不能转交这类询问（尚未实现）。`,
        reply: { action: 'decline' },
        rejected: true,
      }
    },
  },
  execCommandApproval: {
    decline: (_params, agent) => ({
      note: `已自动拒绝：${agent} 用旧式请求要求运行命令，Latch 只回答新式的审批。`,
      reply: { decision: 'abort' },
      rejected: true,
    }),
  },
  applyPatchApproval: {
    decline: (_params, agent) => ({
      note: `已自动拒绝：${agent} 用旧式请求要求改文件，Latch 只回答新式的审批。`,
      reply: { decision: 'abort' },
      rejected: true,
    }),
  },
}

/**
 * Codex over its own app-server (`wires/codex.ts`). The modes and what each says are the ACP route's, and the wire sends
 * each mode's approval policy, sandbox and reviewer with every turn. Definitions on the adapter keep `codex-acp.ts`.
 */
export const codexProfile: HarnessProfile = {
  presetId: 'codex',
  // 2: Codex's reviews and refusals reach the session, the wire's own refusals are said and recorded.
  version: 2,
  wire: 'codex',
  permission: {
    approvals: 'prompts',
    defaultEnv: {},
    expectedMode: 'read-only',
    modeLadder: ['read-only', 'workspace-write', 'agent', 'agent-full-access'],
    modeTiers: {
      'read-only': { tier: 'ask', line: '改文件或联网前问你' },
      'workspace-write': { tier: 'rule', line: '项目内直接做，越界前问你' },
      agent: { tier: 'model', line: '越界或联网由它的模型判断' },
      'agent-full-access': { tier: 'never', line: '直接改文件、联网和运行命令' },
    },
    // Codex's review model reports each request it decides (`item/autoApprovalReview/*`), as the wire names it.
    reviewCallPrefix: 'guardian_assessment:',
    // The wire holds the mode and sends it with each turn, so what it reports is what Codex receives.
    readback: 'mode',
    inheritEnv: ['CODEX_HOME', 'CODEX_SQLITE_HOME'],
    notes: [],
  },
  // The other folders are writable roots of a `workspace-write` turn; Codex loads `.agents/skills` in the session directory.
  folders: { via: 'acp', configPaths: ['.codex', '.agents/skills'] },
  projectConfigPaths: ['.codex'],
  // Threads are listed and read through `thread/list` and `thread/read`; Latch never reads Codex's own files.
  historyImport: true,
  // `model/list` opens no thread: no turn, no model call, no hooks or MCP servers, so a draft reads it by itself.
  catalogueRead: { codexModels: ['app-server'] },
  readProjectedChild: projectedChild,
  readDenial: denial,
  extensions: { requests: DECLINED },
  // Codex 0.156.0 keeps streamed answers when a turn is interrupted or fails (its release notes); T3 Code supports
  // app-server from the same version (its model-manifest.json). Older ones use the adapter, when it is installed.
  minimumVersion: {
    args: ['--version'],
    read: output => /\bcodex-cli (\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b/u.exec(output)?.[1],
    minimum: '0.156.0',
    upgrade: 'npm i -g @openai/codex@latest',
  },
  loginStatus: {
    args: ['login', 'status'],
    read: ({ code, output }) =>
      code === 0 ? 'authenticated' : code === 1 && /\bNot logged in\b/u.test(output) ? 'unauthenticated' : 'unknown',
  },
}
