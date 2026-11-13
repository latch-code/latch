/** Permission rules for ACP agents: profile selection, definition checks, launch fingerprint, modes and options. */
import { realpathSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import { AGENT_PRESETS, isReservedAgentEnvName, type AgentPreset } from '@latch/protocol'
import { AppError, type ConfigChangeClass } from '@latch/sdk'
import { canonicalJson, sha256Hex } from '@latch/core/node-kit'
import { resolveCommand } from './command.ts'
import { FALLBACK_PROFILES, HARNESS_PROFILES, type AcpPermissionProfile, type HarnessProfile } from './profiles/index.ts'
import type { PermissionOption } from './protocol.ts'
import type { AgentRecord } from './types.ts'
import { codexArgs } from './wires/codex.ts'
import { piArgs } from './wires/pi.ts'

export interface ProfileSelection {
  profile?: HarnessProfile
  preset?: AgentPreset
  /**
   * The definition launches exactly the preset's command (see `isPresetCommand`) and arguments, and sets none of the
   * profile's `configEnv`.
   */
  verified: boolean
  /** Chinese display notes about the definition itself, shown after the profile's own. */
  notes?: string[]
}

/** Executable name without a Windows extension, as compared with `AgentPreset.command`. */
export function commandName(command: string): string {
  const name = basename(command.replace(/\\/g, '/'))
  return process.platform === 'win32' ? name.replace(/\.(exe|cmd|bat|com)$/i, '') : name
}

/** Finds a command the way the Host does; tests pass their own. */
export type CommandLocator = (command: string) => string | undefined

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

/**
 * Whether `command` is the preset's own executable: its bare name, which the Host looks up itself, or the file that
 * lookup finds (compared by real path, so a link to it counts). Another file of the same name elsewhere, for example
 * in a project's node_modules/.bin, is not: the system sheet calls it a custom command.
 */
function isPresetCommand(command: string, presetCommand: string, locate: CommandLocator = resolveCommand): boolean {
  if (command === presetCommand) return true
  if (!isAbsolute(command) || commandName(command) !== presetCommand) return false
  const found = locate(presetCommand)
  return found !== undefined && sameFile(found, command)
}

function matchesName(patterns: readonly string[], name: string): boolean {
  const upper = name.toUpperCase()
  return patterns.some(pattern =>
    pattern.endsWith('*') ? upper.startsWith(pattern.slice(0, -1).toUpperCase()) : upper === pattern.toUpperCase(),
  )
}

/** By `presetId`, else by the command's file name. The profile's environment applies even when not verified. */
export function selectProfile(record: AgentRecord, locate: CommandLocator = resolveCommand): ProfileSelection {
  const name = commandName(record.command)
  const byId = record.presetId !== undefined ? AGENT_PRESETS.find(preset => preset.id === record.presetId) : undefined
  const preset = byId ?? AGENT_PRESETS.find(item => item.command === name || item.fallback?.command === name)
  // Only the preset's own program speaks its own protocol: any other command of a preset with an adapter (the adapter,
  // or a wrapper of the person's) runs with the adapter's profile, and is verified against the adapter's command.
  const viaFallback = preset?.fallback !== undefined && name !== preset.command
  const route = viaFallback ? preset!.fallback! : preset
  const profile = preset ? (viaFallback ? FALLBACK_PROFILES : HARNESS_PROFILES).get(preset.id) : undefined
  const configEnv = profile?.permission.configEnv ?? []
  const redirected = Object.keys(record.env)
    .filter(key => matchesName(configEnv, key))
    .sort()
  const verified =
    byId !== undefined
    && redirected.length === 0
    && route !== undefined
    && record.args.length === route.args.length
    && record.args.every((arg, index) => arg === route.args[index])
    && isPresetCommand(record.command, route.command, locate)
  const notes =
    preset && redirected.length
      ? [
          `定义设置了 ${redirected.join('、')}，${preset.name} 可能改从其他位置读取配置、Agent 定义与插件，覆盖 Latch 设置的询问规则；该定义不作为已验证的预设`,
        ]
      : []
  return { ...(profile ? { profile } : {}), ...(preset ? { preset } : {}), verified, ...(notes.length ? { notes } : {}) }
}

export function validateAgentDefinition(
  record: AgentRecord,
  locate: CommandLocator = resolveCommand,
): { ok: true; verified: boolean } | { ok: false; error: AppError } {
  for (const name of Object.keys(record.env)) {
    if (isReservedAgentEnvName(name)) {
      return { ok: false, error: new AppError(400, 'agent-env-reserved', `环境变量 ${name} 由 Latch 管理，不能在 Agent 定义中设置`) }
    }
  }
  const selection = selectProfile(record, locate)
  if (selection.profile?.wire === 'pi' || selection.profile?.wire === 'codex') {
    try {
      if (selection.profile.wire === 'pi') piArgs(record.args)
      else codexArgs(record.args)
    } catch (error) {
      return { ok: false, error: new AppError(400, 'agent-args-reserved', error instanceof Error ? error.message : String(error)) }
    }
  }
  return { ok: true, verified: selection.verified }
}

/** The folders a session passes to its agent besides the session directory: how, and their real paths in order. */
export interface LaunchFolders {
  via: 'acp' | 'args'
  paths: string[]
}

/**
 * What a launch says of a gateway route: for `launch`, the variables it sets (the token's among them) and the versions
 * of its argument and file templates; for `providers`, what `providers/set` names. Never a port, a path or a value.
 */
export interface LaunchRoute {
  providerId: string
  origin: string
  wire: string
  upstream?: string
  via: 'providers' | 'launch'
  names: string[]
  templates?: { args?: number; files?: number }
}

/**
 * Fingerprint of what a session launches. Values enter only as one digest, so the preview can show it without them.
 * `projectConfig` is the digest of the project configuration found; without one the fingerprint is the definition's.
 * `folders` counts only when it names at least one folder, so a session of one folder keeps the fingerprint it had.
 */
export function launchHash(input: {
  resolvedCommand: string
  args: string[]
  definitionEnv: Record<string, string>
  presetId?: string
  /** The preset's profile version, or 1 for a definition with no profile. */
  profileVersion: number
  projectConfig?: string
  folders?: LaunchFolders
  /** The names a profile inherits from the person's environment; never their values, since a client receives this hash. */
  inheritEnv?: readonly string[]
  /** Variable to the path of the program it points at. */
  programs?: Record<string, string>
  /** A session on a gateway route: the service, its origin and protocol, and how the harness is pointed there. Never the token. */
  route?: LaunchRoute
  /** A process-level permission choice; absent preserves fingerprints for other Harnesses. */
  launchMode?: string
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      command: input.resolvedCommand,
      args: input.args,
      envNames: Object.keys(input.definitionEnv).sort(),
      envValues: sha256Hex(canonicalJson(input.definitionEnv)),
      presetId: input.presetId,
      profileVersion: input.profileVersion,
      projectConfig: input.projectConfig,
      ...(input.folders?.paths.length ? { folders: { via: input.folders.via, paths: input.folders.paths } } : {}),
      ...(input.inheritEnv?.length ? { inheritEnv: [...input.inheritEnv].sort() } : {}),
      ...(input.programs && Object.keys(input.programs).length ? { programs: input.programs } : {}),
      ...(input.route ? { route: input.route } : {}),
      ...(input.launchMode ? { launchMode: input.launchMode } : {}),
    }),
  )
}

/** How `value` relates to `expected`: unknown modes and an unknown baseline count as wider. */
export function classifyMode(profile: AcpPermissionProfile | undefined, expected: string | undefined, value: string): ConfigChangeClass {
  if (value === expected) return 'neutral'
  const ladder = profile?.modeLadder
  if (!ladder || expected === undefined) return 'wider'
  const from = ladder.indexOf(expected)
  const to = ladder.indexOf(value)
  if (from < 0 || to < 0) return 'wider'
  return to < from ? 'stricter' : 'wider'
}

const KNOWN_KINDS = new Set(['allow_once', 'allow_always', 'reject_once', 'reject_always'])
/** These store a rule inside the agent that outlives the decision. */
const PERSISTENT_KINDS = new Set(['allow_always', 'reject_always'])

function hiddenId(profile: AcpPermissionProfile | undefined, optionId: string): boolean {
  return (profile?.hiddenOptionIds ?? []).some(pattern =>
    pattern.endsWith('*') ? optionId.startsWith(pattern.slice(0, -1)) : optionId === pattern,
  )
}

export function isVisibleOption(profile: AcpPermissionProfile | undefined, option: { optionId: string; kind: string }): boolean {
  return (option.kind === 'allow_once' || option.kind === 'reject_once') && !hiddenId(profile, option.optionId)
}

/**
 * Keeps only one-time choices that the profile does not hide. Without a one-time allow left, the request is answered
 * at once: with a visible one-time reject, else as cancelled.
 */
export function filterPermissionOptions(
  profile: AcpPermissionProfile | undefined,
  options: Array<{ optionId: string; name: string; kind: string }>,
): {
  visible: PermissionOption[]
  autoReject?: { reason: 'persistent-only' | 'unknown-kind'; optionId?: string }
} {
  const visible = options.filter(option => isVisibleOption(profile, option))
  if (visible.some(option => option.kind === 'allow_once')) return { visible }
  const unknown = options.some(option => !KNOWN_KINDS.has(option.kind))
  const persistent = options.some(option => PERSISTENT_KINDS.has(option.kind) || hiddenId(profile, option.optionId))
  const reject = visible.find(option => option.kind === 'reject_once')
  return {
    visible,
    autoReject: { reason: unknown && !persistent ? 'unknown-kind' : 'persistent-only', ...(reject ? { optionId: reject.optionId } : {}) },
  }
}
