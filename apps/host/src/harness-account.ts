import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { harnessAccountDirectories, type AgentRecord } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalPathSpelling, isInsidePath, isPrintableText, overlapsPaths } from './paths.ts'

/** A named account pointing at the default login twice would show the same quota under two names. */
const DEFAULT_LOGIN: Readonly<Record<string, readonly [string, string]>> = {
  codex: ['CODEX_HOME', '.codex'],
  'claude-agent': ['CLAUDE_CONFIG_DIR', '.claude'],
  pi: ['PI_CODING_AGENT_DIR', '.pi/agent'],
  dsh: ['DSH_HOME', '.dsh'],
  qwen: ['QWEN_HOME', '.qwen'],
  grok: ['GROK_HOME', '.grok'],
}

function defaultAccountPaths(presetId: string, home: string, inherited: (name: string) => string | undefined): string[] {
  const configured = (name: string) => {
    const path = inherited(name)?.trim()
    if (path === '~') return home
    if (path?.startsWith('~/')) return join(home, path.slice(2))
    return path && isAbsolute(path) ? path : undefined
  }
  const xdg = (application: string, setting = configured) => [
    join(setting('XDG_CONFIG_HOME') ?? join(home, '.config'), application),
    join(setting('XDG_DATA_HOME') ?? join(home, '.local/share'), application),
    join(setting('XDG_STATE_HOME') ?? join(home, '.local/state'), application),
    join(setting('XDG_CACHE_HOME') ?? join(home, '.cache'), application),
  ]
  if (presetId === 'opencode') return xdg('opencode')
  if (presetId === 'goose') {
    // goose and etcetera's XDG strategy (also used on Darwin) ignore non-absolute environment paths.
    const absoluteSetting = (name: string) => {
      const value = inherited(name)
      return value && isAbsolute(value) ? value : undefined
    }
    const root = absoluteSetting('GOOSE_PATH_ROOT')
    return root ? [root] : xdg('goose', absoluteSetting)
  }
  const login = DEFAULT_LOGIN[presetId]
  if (!login) return []
  const paths = [configured(login[0]) ?? join(home, login[1])]
  const extra = presetId === 'codex' ? configured('CODEX_SQLITE_HOME') : presetId === 'qwen' ? configured('QWEN_RUNTIME_DIR') : undefined
  if (extra) paths.push(extra)
  return paths
}

/** Bind only an existing account directory selected on this computer. No credential file is opened. */
export async function resolveAccountDirectory(input: {
  path: string
  presetId: string | undefined
  home: string
  protected: readonly string[]
  projects: readonly string[]
  agents: readonly AgentRecord[]
  retired: readonly string[]
  inherited: (name: string) => string | undefined
}): Promise<string> {
  if (!input.presetId || !harnessAccountDirectories(input.presetId))
    throw new AppError(400, 'agent-account-unsupported', '这个 Harness 不支持按配置目录绑定账号')
  const path = await canonicalPathSpelling(input.path).catch(() => undefined)
  const info = path && (await lstat(path).catch(() => undefined))
  if (!path || !isPrintableText(path) || !info || !info.isDirectory() || (process.getuid && info.uid !== process.getuid()))
    throw new AppError(400, 'agent-account-directory', '请选择属于当前用户且已存在的账号配置目录')
  if (await overlapsPaths(path, defaultAccountPaths(input.presetId, input.home, input.inherited)))
    throw new AppError(409, 'agent-account-bound', '这个目录与该 Harness 的默认账号重叠')
  const saved = input.agents.find(agent => agent.accountDirectory === path && agent.presetId === input.presetId)
  if (saved) throw new AppError(409, 'agent-account-bound', '这个账号配置目录已绑定', { agentId: saved.id })
  if (
    await overlapsPaths(path, [
      ...input.agents.flatMap(agent => agent.accountDirectory ?? []),
      ...input.retired.filter(directory => directory !== path),
    ])
  )
    throw new AppError(409, 'agent-account-bound', '这个目录与已添加过的账号配置目录重叠')
  // $HOME itself and its ancestors must stay out, but ordinary children can be account directories.
  const home = await realpath(input.home).catch(() => input.home)
  if (isInsidePath(home, path) || (await overlapsPaths(path, [...input.protected, ...input.projects])))
    throw new AppError(409, 'agent-account-overlap', '请选择独立于项目和 Host 数据的账号配置目录')
  return path
}
