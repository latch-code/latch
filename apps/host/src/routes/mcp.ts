// 设置 › MCP: Latch's own MCP servers (docs/MCP.md). Reading is for any device that may view; writing only for the
// desktop app on this Mac (host.sock) with 管理此 Host, except 停用, which any such device may do. What a change widens
// is decided by `widens` alone: running something not confirmed takes the local confirmation `mcp.server.apply`;
// reaching more sessions or tools, or a secret's new value, needs none but is on record before it takes effect; only
// narrowing goes ahead when the record cannot be written. Every write names a `requestId`, kept with its result, so a
// retry after an unknown outcome is answered without doing it twice. A remote server (Streamable HTTP) is confirmed for
// its address and header names, with the outbound allowance it needs in the same confirmation; see docs/MCP.md.
import { homedir } from 'node:os'
import { realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { isMcpServerName, type McpFailure, type McpServerView } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import type { StepupMethod } from '../audit.ts'
import { json, jsonBody, safeDecode } from '../http-util.ts'
import { middleSlot } from '../presence-reason.ts'
import {
  envInput,
  envPatch,
  headersInput,
  headersPatch,
  httpSpecHash,
  isConfirmed,
  locateCommand,
  MCP_ID,
  newServerId,
  remoteAddress,
  runnerTarget,
  scopeNarrows,
  scopeSchema,
  secretRefusal,
  secretRotated,
  serverEnvironment,
  specHash,
  specInput,
  testServer,
  widens,
  within,
  type McpHttpRecord,
  type McpHttpSpec,
  type McpServerRecord,
  type McpStdioRecord,
  type McpSpec,
  type McpState,
  type McpStore,
} from '../mcp.ts'
import { CONFIG_BODY_LIMIT, type Caller, type DeviceCaller, type PreviewLine, type RouteContext, type RouteModule } from './registry.ts'

const requestId = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u)
const revision = z.number().int().min(0)
const createSchema = z.strictObject({
  requestId,
  baseRevision: revision,
  transport: z.literal('stdio').optional(),
  ...specInput,
  env: envInput,
  secrets: envInput,
  scope: scopeSchema,
})
const remoteUrl = z.string().min(1).max(2048)
const createRemoteSchema = z.strictObject({
  requestId,
  baseRevision: revision,
  transport: z.literal('http'),
  name: specInput.name,
  url: remoteUrl,
  headers: headersInput,
  scope: scopeSchema,
})
const toolName = z.string().regex(/^[A-Za-z0-9_.:/-]{1,128}$/u)
const patchSchema = z.strictObject({
  requestId,
  baseRevision: revision,
  name: specInput.name.optional(),
  command: specInput.command.optional(),
  args: specInput.args.optional(),
  projectCwd: z.boolean().optional(),
  env: envPatch.optional(),
  secrets: envPatch.optional(),
  scope: scopeSchema.optional(),
  enabled: z.boolean().optional(),
  disabledTools: z.array(toolName).max(256).optional(),
  url: remoteUrl.optional(),
  headers: headersPatch.optional(),
})
const testSchema = z.strictObject({ requestId })
const SERVER_PATH = /^\/link\/api\/mcp\/servers\/([^/]+)$/u
const TEST_PATH = /^\/link\/api\/mcp\/servers\/([^/]+)\/test$/u

export interface McpRouteDeps {
  store: McpStore
  /** The rule Harness commands are found by. */
  resolveCommand: (command: string) => string | undefined
  /** Where a server's command may not be: the data directory, Latch's program directory, every project folder. */
  forbiddenRoots: () => string[]
  /**
   * Where neither 测试's command nor a path in its arguments may be: every project folder, worktree, session folder, the
   * Agents' folder and the data directory. 测试 is the Host running the program, and the Host runs no repository's code.
   */
  testForbiddenRoots: () => Promise<string[]>
  /** Where the person's programs are, for a server's PATH. */
  commandDirectories: () => string[]
  /** The Host's private temporary directory. */
  tmpRoot: string
  /** Ends every bridge of a server: removed, switched off, changed or used in fewer sessions. */
  revoke: (serverId: string) => void
  /**
   * What reaching a remote address takes under the Host's outbound rules: `target` is its `host:port`; `egress` the
   * allowance it still needs (a loopback or private address not yet allowed), with why. Rejects (403 `egress-denied`) for
   * an address that can never be allowed.
   */
  egressFor: (url: string) => Promise<{ target: string; egress?: string; local?: boolean }>
  /** Adds the allowance in one audited policy change; returns its undo. */
  allowEgress: (caller: Caller, target: string, stepup: StepupMethod) => Promise<() => Promise<void>>
  /**
   * The outbound allowance only this remote server uses: in the policy, and no other remote server, model service or
   * allowance the Host was started with reaches that `host:port`.
   */
  allowanceOf: (serverId: string) => string | undefined
  /** Takes an allowance out of the policy; it only narrows, so it is asked for nobody, and is on record. */
  removeAllowance: (caller: Caller, target: string, res: Parameters<typeof json>[0]) => Promise<void>
  /** 测试 of a remote server: `initialize` and `tools/list` from the Host, within 20 s, then the session ends. */
  testRemote: (record: McpHttpRecord) => Promise<{ status: 'ok'; tools: string[] } | { status: 'failed'; reason: McpFailure }>
}

const changed = () => new AppError(409, 'mcp-changed', 'MCP 服务器已被修改，请刷新后重试')
const missing = () => new AppError(404, 'mcp-not-found', '找不到该 MCP 服务器')

function scopeText(scope: McpServerRecord['scope']): string {
  if (scope.all) return '所有会话'
  const parts = [
    ...(scope.agents.length ? [`${scope.agents.length} 个 Agent`] : []),
    ...(scope.projects.length ? [`${scope.projects.length} 个项目`] : []),
  ]
  return parts.join('、') || '尚未选择'
}

/** The confirmation's lines: the Host's facts (what runs, where), then what the person typed. */
function previewLines(name: string, spec: McpSpec, scope: McpServerRecord['scope']): PreviewLine[] {
  const plain = Object.entries(spec.env).map(([key, value]) => `${key}=${value}`)
  return [
    { label: '命令', value: spec.command },
    { label: '参数', value: spec.args.length ? spec.args.join(' ') : '无' },
    { label: '环境变量', value: plain.length ? plain.join(' ') : '无' },
    { label: '秘密变量', value: spec.secretNames.length ? spec.secretNames.join('、') : '无' },
    { label: '工作目录', value: spec.projectCwd ? '会话的项目文件夹' : '会话的空文件夹' },
    { label: '用在', value: scopeText(scope) },
    { label: 'MCP 服务器', value: name },
  ]
}

/** A remote server's confirmation lines: the Host's facts (where it connects, what it allows), then what was typed. */
function remoteLines(
  name: string,
  spec: McpHttpSpec,
  scope: McpServerRecord['scope'],
  egress?: { target: string; local?: boolean },
): PreviewLine[] {
  return [
    { label: '地址', value: spec.url },
    { label: '请求头', value: spec.headerNames.length ? `${spec.headerNames.join('、')}（值只发往这个地址）` : '无' },
    ...(egress
      ? [{ label: '出站许可', value: `允许 Host 访问 ${egress.target}（${egress.local ? '这台电脑上的地址' : '局域网或私网地址'}）` }]
      : []),
    { label: '用在', value: scopeText(scope) },
    { label: 'MCP 服务器', value: name },
  ]
}

const badUrl = () =>
  new AppError(400, 'mcp-url-invalid', '地址要以 https:// 开头，或是这台 Mac 上的 http://localhost、http://127.0.0.1；不带账号、查询或片段')

/** Header names compared as HTTP does, without case. */
function checkHeaderNames(names: readonly string[]): void {
  if (new Set(names.map(name => name.toLowerCase())).size !== names.length)
    throw new AppError(400, 'mcp-header-twice', '同一个请求头只能填一次')
  if (names.length > 32) throw new AppError(400, 'mcp-header-limit', '请求头最多 32 个')
}

/** Refuses secret variables that decide what runs: their place is with the plain ones, on the confirmation. */
function checkSecrets(secrets: Readonly<Record<string, string | null>>): void {
  for (const [name, value] of Object.entries(secrets)) {
    const why = value === null ? undefined : secretRefusal(name, value)
    if (why) throw new AppError(400, 'mcp-secret-not-allowed', why)
  }
}

/**
 * The paths an argument or a variable may name, as the program would see them from `cwd`: the value itself, what
 * follows `=` in `--flag=value`, a `file:` URL, `~/…`, and a relative path resolved against `cwd`.
 */
export function namedPaths(values: readonly string[], cwd: string): string[] {
  const one = (item: string): string[] => {
    const text = item.trim()
    if (!text) return []
    if (/^file:/iu.test(text)) {
      try {
        return [fileURLToPath(text)]
      } catch {
        return []
      }
    }
    if (text.startsWith('~/')) return [join(homedir(), text.slice(2))]
    if (isAbsolute(text)) return [resolve(text)]
    // Relative: only what has the shape of a path (a separator or a leading dot), so a plain word stays a word.
    return /[/\\]/u.test(text) || text.startsWith('.') ? [resolve(cwd, text)] : []
  }
  return values.flatMap(value => [value, ...(value.includes('=') ? [value.slice(value.indexOf('=') + 1)] : [])].flatMap(one))
}

/** The modules `NODE_OPTIONS` loads (`--require`, `-r`, `--import`, `--loader`), which run before any script. */
function nodeOptionPaths(value: string): string[] {
  const words = value.split(/\s+/u).filter(Boolean)
  return words.flatMap((word, index) => {
    const [name, attached] = word.includes('=') ? [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)] : [word, undefined]
    if (!['--require', '-r', '--import', '--loader', '--experimental-loader'].includes(name)) return []
    const next = attached ?? words[index + 1]
    return next ? [next] : []
  })
}

export function createMcpRoutes(context: RouteContext, deps: McpRouteDeps): RouteModule {
  const { store } = deps
  /** 测试 runs one at a time per server; a retry of the same request waits for it. */
  const testing = new Map<string, { requestId: string; promise: Promise<unknown> }>()

  const sameName = (name: string, except?: string) =>
    store.records().some(record => record.id !== except && record.name.toLowerCase() === name.toLowerCase())

  async function confirmSpec(
    req: Parameters<RouteContext['confirm']>[0],
    caller: Caller,
    name: string,
    spec: McpSpec,
    scope: McpServerRecord['scope'],
    secrets: Record<string, string | null>,
  ) {
    const target = runnerTarget(spec.command, spec.args)
    return context.confirm(
      req,
      caller,
      'mcp.server.apply',
      {
        name,
        command: spec.command,
        args: spec.args,
        env: spec.env,
        secretNames: spec.secretNames.toSorted(),
        projectCwd: spec.projectCwd,
        scope,
        // Secret values typed with the change are bound to it without being part of the preview.
        secretsHash: sha256Hex(canonicalJson(secrets)),
      },
      target
        ? {
            // The program by its file name, then what it runs, cut in the middle, and a hash of all of it: two packages
            // whose names differ anywhere never read the same.
            form: 'mcp.server.apply-runner',
            slots: {
              command: basename(spec.command),
              target: middleSlot(target.target, 32),
              hash: sha256Hex(target.target).slice(0, 4),
              server: name,
            },
          }
        : { form: 'mcp.server.apply', slots: { command: spec.command, server: name } },
      previewLines(name, spec, scope),
      spec.projectCwd ? ['这个命令会在会话的项目文件夹里启动，能读写那里的文件。'] : [],
    )
  }

  /**
   * The confirmation of a remote server: its address and header names, and the outbound allowance it needs, in one
   * request, so the person is never asked twice for the same address. An address the policy already allows (a model
   * service's, say) needs no allowance and says none.
   */
  async function confirmRemote(
    req: Parameters<RouteContext['confirm']>[0],
    caller: Caller,
    name: string,
    spec: McpHttpSpec,
    scope: McpServerRecord['scope'],
    headers: Record<string, string | null>,
    reach: { target: string; egress?: string; local?: boolean },
  ): Promise<StepupMethod> {
    return context.confirm(
      req,
      caller,
      'mcp.server.apply',
      {
        transport: 'http',
        name,
        url: spec.url,
        headerNames: spec.headerNames.toSorted(),
        scope,
        egress: reach.egress ?? null,
        // Header values typed with the change are bound to it, never shown.
        headersHash: sha256Hex(canonicalJson(headers)),
      },
      { form: 'mcp.server.apply-remote', slots: { target: reach.target, server: name } },
      remoteLines(name, spec, scope, reach.egress ? { target: reach.egress, ...(reach.local ? { local: true } : {}) } : undefined),
      [],
      reach.target,
    )
  }

  function answer(res: Parameters<typeof json>[0], id: string, status = 200): void {
    const server = store.view(id)
    json(res, { ...(server ? { server } : {}), revision: store.revision() }, status)
  }

  const remoteStateOf = (
    record: McpHttpSpec & Pick<McpServerRecord, 'scope' | 'enabled' | 'disabledTools'>,
    headers: Record<string, string>,
  ): McpState => ({
    transport: 'http',
    url: record.url,
    headerNames: record.headerNames,
    scope: record.scope,
    enabled: record.enabled,
    disabledTools: record.disabledTools,
    secretHashes: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, sha256Hex(value)])),
  })

  const stateOf = (
    record: McpSpec & Pick<McpServerRecord, 'scope' | 'enabled' | 'disabledTools'>,
    secrets: Record<string, string>,
  ): McpState => ({
    command: record.command,
    args: record.args,
    env: record.env,
    secretNames: record.secretNames,
    projectCwd: record.projectCwd,
    scope: record.scope,
    enabled: record.enabled,
    disabledTools: record.disabledTools,
    secretHashes: Object.fromEntries(Object.entries(secrets).map(([key, value]) => [key, sha256Hex(value)])),
  })

  /**
   * Refuses 测试 of a program that is, or that names among its arguments or plain variables, anything inside a
   * project, worktree, session folder, the Agents' folder, Latch's data or program directory: 测试 is the Host running
   * the program, and the Host runs no repository's code.
   */
  async function assertTestable(record: McpStdioRecord): Promise<void> {
    if (record.args.some(value => value.includes('${workspaceFolder}')))
      throw new AppError(409, 'mcp-test-repository', '它的参数指向会话的项目文件夹：测试只运行不在项目里的程序，请在会话里使用它')
    const roots = await deps.testForbiddenRoots()
    const real = await Promise.all(roots.map(root => realpath(root).catch(() => root)))
    // Relative paths as the program sees them: from 测试's own empty folder, one level inside the temporary directory.
    const cwd = join(deps.tmpRoot, 'mcp-test-folder')
    const values = [
      ...record.args,
      ...Object.values(record.env),
      ...Object.entries(record.env).flatMap(([name, value]) => (name.toUpperCase() === 'NODE_OPTIONS' ? nodeOptionPaths(value) : [])),
    ]
    const candidates = [record.command, ...namedPaths(values, cwd)]
    for (const candidate of candidates) {
      const found = await realpath(candidate).catch(() => candidate)
      if ([...roots, ...real].some(root => within(root, candidate) || within(root, found)))
        throw new AppError(
          409,
          'mcp-test-repository',
          '它的命令、参数或变量指向项目、工作树、会话文件夹或 Latch 的数据与程序：测试不运行仓库里的程序，请在会话里使用它',
        )
    }
  }

  /**
   * Adds a remote server: its address as kept (`remoteAddress`), confirmed with its header names and the outbound
   * allowance it needs; on record, then the allowance, then the server. A failed save takes the allowance back.
   */
  async function addRemote(
    req: Parameters<RouteContext['confirm']>[0],
    res: Parameters<typeof json>[0],
    caller: DeviceCaller,
    input: z.infer<typeof createRemoteSchema>,
  ): Promise<void> {
    context.recheck(caller, 'admin')
    const done = store.receipt(caller.device.id, input.requestId, input)
    if (done) return answer(res, done.serverId, 201)
    if (input.baseRevision !== store.revision()) throw changed()
    if (sameName(input.name)) throw new AppError(409, 'mcp-name-taken', `已有名为 ${input.name} 的 MCP 服务器`)
    const url = remoteAddress(input.url)
    if (!url) throw badUrl()
    const spec: McpHttpSpec = { url, headerNames: Object.keys(input.headers) }
    checkHeaderNames(spec.headerNames)
    const reach = await deps.egressFor(url)
    const stepup = await confirmRemote(req, caller, input.name, spec, input.scope, input.headers, reach)
    const id = await context.serial(caller, 'admin', async () => {
      if (input.baseRevision !== store.revision()) throw changed()
      if (sameName(input.name)) throw new AppError(409, 'mcp-name-taken', `已有名为 ${input.name} 的 MCP 服务器`)
      const serverId = newServerId()
      const hash = httpSpecHash(spec)
      await context.audited({
        action: 'mcp.server.added',
        actor: context.actorOf(caller),
        target: serverId,
        stepup,
        detail: {
          serverId,
          specHash: hash,
          envCount: spec.headerNames.length,
          scope: input.scope.all ? 'all' : 'chosen',
          projectCwd: false,
          transport: 'http',
        },
      })
      const undo = reach.egress ? await deps.allowEgress(caller, reach.egress, stepup) : async () => {}
      try {
        return await store.change(
          { deviceId: caller.device.id, requestId: input.requestId, payload: input },
          ({ servers, secrets, stamp }) => {
            servers.servers.push({
              id: serverId,
              name: input.name,
              transport: 'http',
              url,
              headerNames: [...spec.headerNames],
              scope: input.scope,
              enabled: true,
              disabledTools: [],
              revision: 1,
              specHash: hash,
              confirmed: { hash, secretNames: [...spec.headerNames] },
              createdAt: stamp,
              updatedAt: stamp,
            })
            if (spec.headerNames.length) secrets.servers[serverId] = { env: {}, headers: { ...input.headers } }
            return serverId
          },
        )
      } catch (error) {
        await undo()
        throw error
      }
    })
    context.refresh()
    answer(res, id, 201)
  }

  /** A change to a remote server; the same rules as a local command's, with its address and headers. */
  async function patchRemote(
    req: Parameters<RouteContext['confirm']>[0],
    res: Parameters<typeof json>[0],
    caller: DeviceCaller,
    current: McpHttpRecord,
    input: z.infer<typeof patchSchema>,
  ): Promise<void> {
    const id = current.id
    if (
      input.command !== undefined
      || input.args !== undefined
      || input.projectCwd !== undefined
      || input.env !== undefined
      || input.secrets !== undefined
    )
      throw new AppError(400, 'mcp-transport', '远程地址没有命令、参数或环境变量')
    const name = input.name ?? current.name
    if (input.name !== undefined && !isMcpServerName(name)) throw new AppError(400, 'mcp-name-invalid', '名称无效')
    if (input.name !== undefined && sameName(name, id)) throw new AppError(409, 'mcp-name-taken', `已有名为 ${name} 的 MCP 服务器`)
    const url = input.url !== undefined ? remoteAddress(input.url) : current.url
    if (!url) throw badUrl()
    const before = store.headersOf(id)
    const headers = { ...before }
    const headerNames = [...current.headerNames]
    for (const [key, value] of Object.entries(input.headers ?? {})) {
      if (value === null) {
        if (headerNames.includes(key)) headerNames.splice(headerNames.indexOf(key), 1)
        delete headers[key]
      } else {
        if (!headerNames.includes(key)) headerNames.push(key)
        headers[key] = value
      }
    }
    checkHeaderNames(headerNames)
    const spec: McpHttpSpec = { url, headerNames }
    const after = remoteStateOf(
      {
        ...spec,
        scope: input.scope ?? current.scope,
        enabled: input.enabled ?? current.enabled,
        disabledTools: input.disabledTools ? [...new Set(input.disabledTools)] : current.disabledTools,
      },
      headers,
    )
    const previous = remoteStateOf(current, before)
    const hash = httpSpecHash(spec)
    const kinds = new Set<'spec' | 'secret' | 'scope' | 'tools' | 'enabled' | 'name'>()
    if (hash !== current.specHash) kinds.add('spec')
    if (secretRotated(previous, after)) kinds.add('secret')
    if (input.name !== undefined && input.name !== current.name) kinds.add('name')
    if (canonicalJson(after.scope) !== canonicalJson(current.scope)) kinds.add('scope')
    if (after.enabled !== current.enabled) kinds.add('enabled')
    if (canonicalJson(after.disabledTools.toSorted()) !== canonicalJson(current.disabledTools.toSorted())) kinds.add('tools')
    if (!kinds.size) return answer(res, id)
    const widened = widens(previous, after)
    let stepup: StepupMethod = 'none'
    let reach: { target: string; egress?: string; local?: boolean } | undefined
    if (widened === 'spec') {
      reach = await deps.egressFor(url)
      stepup = await confirmRemote(req, caller, name, spec, after.scope, input.headers ?? {}, reach)
    }
    await context.serial(caller, 'admin', async () => {
      const latest = store.get(id)
      if (!latest) throw missing()
      if (latest.revision !== input.baseRevision) throw changed()
      await context.audited(
        {
          action: 'mcp.server.changed',
          actor: context.actorOf(caller),
          target: id,
          stepup,
          detail: { serverId: id, kinds: [...kinds], specHash: hash, enabled: after.enabled },
        },
        widened ? undefined : res,
      )
      const undo = reach?.egress ? await deps.allowEgress(caller, reach.egress, stepup) : async () => {}
      try {
        await store.change({ deviceId: caller.device.id, requestId: input.requestId, payload: input }, ({ servers, secrets, stamp }) => {
          const record = servers.servers.find(item => item.id === id)
          if (!record || record.transport !== 'http') throw missing()
          record.name = name
          record.url = url
          record.headerNames = [...headerNames]
          record.specHash = hash
          if (widened === 'spec') record.confirmed = { hash, secretNames: [...headerNames] }
          record.scope = after.scope
          record.enabled = after.enabled
          record.disabledTools = after.disabledTools
          if (kinds.has('spec')) delete record.report
          record.revision += 1
          record.updatedAt = stamp
          if (headerNames.length)
            secrets.servers[id] = { env: {}, headers: Object.fromEntries(headerNames.map(key => [key, headers[key] ?? ''])) }
          else delete secrets.servers[id]
          return id
        })
      } catch (error) {
        await undo()
        throw error
      }
    })
    if (kinds.has('spec') || kinds.has('name') || kinds.has('secret') || !after.enabled || scopeNarrows(current.scope, after.scope))
      deps.revoke(id)
    context.refresh()
    answer(res, id)
  }

  return {
    features: () => ({ mcp: true }),
    async route({ req, res, caller, path, method }) {
      if (path === '/link/api/mcp/servers' && method === 'GET') {
        context.requireScope(caller, 'view')
        const list = store.list()
        // Which allowance removing a server may take with it: only for a device that may remove one.
        const admin = caller.device?.scopes.includes('admin') === true
        json(res, {
          ...list,
          servers: list.servers.map(server => {
            const allowance = admin && server.transport === 'http' ? deps.allowanceOf(server.id) : undefined
            return allowance ? { ...server, allowance } : server
          }),
        })
        return true
      }
      if (path === '/link/api/mcp/servers' && method === 'POST') {
        context.requireScope(caller, 'admin')
        context.requireLocal(caller)
        const body = await jsonBody(req, CONFIG_BODY_LIMIT)
        if (body && typeof body === 'object' && (body as { transport?: unknown }).transport === 'http') {
          await addRemote(req, res, caller, createRemoteSchema.parse(body))
          return true
        }
        const input = createSchema.parse(body)
        context.recheck(caller, 'admin')
        const done = store.receipt(caller.device.id, input.requestId, input)
        if (done) {
          answer(res, done.serverId, 201)
          return true
        }
        if (input.baseRevision !== store.revision()) throw changed()
        if (sameName(input.name)) throw new AppError(409, 'mcp-name-taken', `已有名为 ${input.name} 的 MCP 服务器`)
        checkSecrets(input.secrets)
        if (Object.keys(input.secrets).some(name => Object.hasOwn(input.env, name)))
          throw new AppError(400, 'mcp-env-twice', '同一个变量不能既是普通变量又是秘密变量')
        if (Object.keys(input.env).length + Object.keys(input.secrets).length > 32)
          throw new AppError(400, 'mcp-env-limit', '环境变量最多 32 个')
        const command = await locateCommand(input.command, deps.resolveCommand, deps.forbiddenRoots())
        const spec: McpSpec = {
          command,
          args: input.args,
          env: input.env,
          secretNames: Object.keys(input.secrets),
          projectCwd: input.projectCwd,
        }
        const stepup = await confirmSpec(req, caller, input.name, spec, input.scope, input.secrets)
        const id = await context.serial(caller, 'admin', async () => {
          if (input.baseRevision !== store.revision()) throw changed()
          if (sameName(input.name)) throw new AppError(409, 'mcp-name-taken', `已有名为 ${input.name} 的 MCP 服务器`)
          const serverId = newServerId()
          const hash = specHash(spec)
          // Written before the server exists; a record that cannot be written leaves nothing saved.
          await context.audited({
            action: 'mcp.server.added',
            actor: context.actorOf(caller),
            target: serverId,
            stepup,
            detail: {
              serverId,
              specHash: hash,
              envCount: Object.keys(spec.env).length + spec.secretNames.length,
              scope: input.scope.all ? 'all' : 'chosen',
              projectCwd: spec.projectCwd,
            },
          })
          return store.change({ deviceId: caller.device.id, requestId: input.requestId, payload: input }, ({ servers, secrets, stamp }) => {
            const { transport: _, ...given } = { transport: 'stdio' as const, ...spec }
            servers.servers.push({
              id: serverId,
              name: input.name,
              transport: 'stdio',
              ...given,
              scope: input.scope,
              enabled: true,
              disabledTools: [],
              revision: 1,
              specHash: hash,
              confirmed: { hash, secretNames: [...spec.secretNames] },
              createdAt: stamp,
              updatedAt: stamp,
            })
            if (spec.secretNames.length) secrets.servers[serverId] = { env: { ...input.secrets } }
            return serverId
          })
        })
        context.refresh()
        answer(res, id, 201)
        return true
      }
      const serverMatch = SERVER_PATH.exec(path)
      if (serverMatch && method === 'PATCH') {
        context.requireScope(caller, 'admin')
        const id = safeDecode(serverMatch[1]!)
        if (!MCP_ID.test(id)) throw missing()
        const input = patchSchema.parse(await jsonBody(req, CONFIG_BODY_LIMIT))
        const { requestId: _, baseRevision: __, ...change } = input
        // 停用 narrows what agents get: any device that may manage this Host may do it, wherever it is.
        const disableOnly = canonicalJson(change) === canonicalJson({ enabled: false })
        if (!disableOnly) context.requireLocal(caller)
        context.recheck(caller, 'admin')
        const done = store.receipt(caller.device.id, input.requestId, input)
        if (done) {
          answer(res, done.serverId)
          return true
        }
        const current = store.get(id)
        if (!current) throw missing()
        if (current.revision !== input.baseRevision) throw changed()
        if (current.transport === 'http') {
          await patchRemote(req, res, caller, current, input)
          return true
        }
        if (input.url !== undefined || input.headers !== undefined) throw new AppError(400, 'mcp-transport', '本机命令没有地址或请求头')
        const name = input.name ?? current.name
        if (input.name !== undefined && !isMcpServerName(name)) throw new AppError(400, 'mcp-name-invalid', '名称无效')
        if (input.name !== undefined && sameName(name, id)) throw new AppError(409, 'mcp-name-taken', `已有名为 ${name} 的 MCP 服务器`)
        checkSecrets(input.secrets ?? {})
        const env = { ...current.env }
        for (const [key, value] of Object.entries(input.env ?? {})) {
          if (value === null) delete env[key]
          else env[key] = value
        }
        const secretNames = [...current.secretNames]
        const before = store.secretsOf(id)
        const secrets = { ...before }
        for (const [key, value] of Object.entries(input.secrets ?? {})) {
          if (value === null) {
            if (secretNames.includes(key)) secretNames.splice(secretNames.indexOf(key), 1)
            delete secrets[key]
          } else {
            if (!secretNames.includes(key)) secretNames.push(key)
            secrets[key] = value
          }
        }
        if (secretNames.some(key => Object.hasOwn(env, key)))
          throw new AppError(400, 'mcp-env-twice', '同一个变量不能既是普通变量又是秘密变量')
        if (Object.keys(env).length + secretNames.length > 32) throw new AppError(400, 'mcp-env-limit', '环境变量最多 32 个')
        const command =
          input.command !== undefined ? await locateCommand(input.command, deps.resolveCommand, deps.forbiddenRoots()) : current.command
        const spec: McpSpec = {
          command,
          args: input.args ?? current.args,
          env,
          secretNames,
          projectCwd: input.projectCwd ?? current.projectCwd,
        }
        const after: McpState = stateOf(
          {
            ...spec,
            scope: input.scope ?? current.scope,
            enabled: input.enabled ?? current.enabled,
            disabledTools: input.disabledTools ? [...new Set(input.disabledTools)] : current.disabledTools,
          },
          secrets,
        )
        const previous = stateOf(current, before)
        const hash = specHash(spec)
        const kinds = new Set<'spec' | 'secret' | 'scope' | 'tools' | 'enabled' | 'name'>()
        if (hash !== current.specHash) kinds.add('spec')
        if (secretRotated(previous, after)) kinds.add('secret')
        if (input.name !== undefined && input.name !== current.name) kinds.add('name')
        if (canonicalJson(after.scope) !== canonicalJson(current.scope)) kinds.add('scope')
        if (after.enabled !== current.enabled) kinds.add('enabled')
        if (canonicalJson(after.disabledTools.toSorted()) !== canonicalJson(current.disabledTools.toSorted())) kinds.add('tools')
        if (!kinds.size) {
          answer(res, id)
          return true
        }
        const widened = widens(previous, after)
        const stepup = widened === 'spec' ? await confirmSpec(req, caller, name, spec, after.scope, input.secrets ?? {}) : ('none' as const)
        await context.serial(caller, 'admin', async () => {
          const latest = store.get(id)
          if (!latest) throw missing()
          if (latest.revision !== input.baseRevision) throw changed()
          // Whatever widens is on record first; only what narrows or renames goes ahead when the record cannot be written.
          await context.audited(
            {
              action: 'mcp.server.changed',
              actor: context.actorOf(caller),
              target: id,
              stepup,
              detail: { serverId: id, kinds: [...kinds], specHash: hash, enabled: after.enabled },
            },
            widened ? undefined : res,
          )
          await store.change(
            { deviceId: caller.device.id, requestId: input.requestId, payload: input },
            ({ servers, secrets: draft, stamp }) => {
              const record = servers.servers.find(item => item.id === id)
              if (!record || record.transport !== 'stdio') throw missing()
              record.name = name
              Object.assign(record, spec)
              record.specHash = hash
              if (widened === 'spec') record.confirmed = { hash, secretNames: [...spec.secretNames] }
              record.scope = after.scope
              record.enabled = after.enabled
              record.disabledTools = after.disabledTools
              if (kinds.has('spec')) delete record.report
              record.revision += 1
              record.updatedAt = stamp
              if (secretNames.length) draft.servers[id] = { env: Object.fromEntries(secretNames.map(key => [key, secrets[key] ?? ''])) }
              else delete draft.servers[id]
              return id
            },
          )
        })
        // Running bridges end with another program, name or secret, with 停用, and when 「用在」 loses sessions; a tool
        // switched off is refused at its next call.
        if (kinds.has('spec') || kinds.has('name') || kinds.has('secret') || !after.enabled || scopeNarrows(current.scope, after.scope))
          deps.revoke(id)
        context.refresh()
        answer(res, id)
        return true
      }
      if (serverMatch && method === 'DELETE') {
        context.requireScope(caller, 'admin')
        context.requireLocal(caller)
        const id = safeDecode(serverMatch[1]!)
        if (!MCP_ID.test(id) || !store.get(id)) throw missing()
        // 「同时移除出站许可」: only an allowance no other server or model service uses.
        const withAllowance = new URL(req.url ?? '/', 'http://latch.invalid').searchParams.get('allowance') === 'remove'
        let allowance: string | undefined
        await context.serial(caller, 'admin', async () => {
          if (!store.get(id)) throw missing()
          allowance = withAllowance ? deps.allowanceOf(id) : undefined
          await context.audited(
            { action: 'mcp.server.removed', actor: context.actorOf(caller), target: id, stepup: 'none', detail: { serverId: id } },
            res,
          )
          await store.change(undefined, ({ servers, secrets }) => {
            servers.servers = servers.servers.filter(item => item.id !== id)
            delete secrets.servers[id]
            return id
          })
        })
        deps.revoke(id)
        if (allowance) await deps.removeAllowance(caller, allowance, res)
        context.refresh()
        json(res, { deleted: true, revision: store.revision(), ...(allowance ? { allowanceRemoved: allowance } : {}) })
        return true
      }
      const testMatch = TEST_PATH.exec(path)
      if (testMatch && method === 'POST') {
        context.requireScope(caller, 'admin')
        context.requireLocal(caller)
        const id = safeDecode(testMatch[1]!)
        const input = testSchema.parse(await jsonBody(req))
        context.recheck(caller, 'admin')
        const record = MCP_ID.test(id) ? store.get(id) : undefined
        if (!record) throw missing()
        const running = testing.get(id)
        if (running && running.requestId !== input.requestId) throw new AppError(409, 'mcp-test-running', '正在测试这个 MCP 服务器')
        const promise =
          running?.promise
          ?? (async () => {
            // Only a definition that is exactly what was confirmed runs, and never one in a repository.
            if (!isConfirmed(record)) throw new AppError(409, 'mcp-unconfirmed', '这个 MCP 服务器的定义没有经过确认')
            if (record.transport === 'stdio') await assertTestable(record)
            await context.audited({
              action: 'mcp.server.test',
              actor: context.actorOf(caller),
              target: id,
              stepup: 'none',
              detail: { serverId: id, specHash: record.specHash },
            })
            const result =
              record.transport === 'http'
                ? await deps.testRemote(record)
                : await testServer(
                    {
                      command: record.command,
                      args: [...record.args],
                      env: serverEnvironment(record.command, { ...record.env, ...store.secretsOf(id) }, deps.commandDirectories()),
                    },
                    { tmpRoot: deps.tmpRoot },
                  )
            await store
              .report(id, record.specHash, {
                status: result.status,
                tools: result.status === 'ok' ? result.tools : [],
                ...(result.status === 'failed' ? { reason: result.reason } : {}),
                via: 'test',
              })
              .catch(() => {})
            context.refresh()
            return result
          })().finally(() => {
            if (testing.get(id)?.promise === promise) testing.delete(id)
          })
        if (!running) testing.set(id, { requestId: input.requestId, promise })
        const result = (await promise) as Awaited<ReturnType<typeof testServer>>
        context.recheck(caller as DeviceCaller, 'admin')
        json(res, { ...result, server: store.view(id) as McpServerView | undefined })
        return true
      }
      return false
    },
  }
}
