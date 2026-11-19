/**
 * Claude Code's permission questions on the Agent SDK wire: the options `claude-agent-acp` 0.101 offers for each tool
 * (`permissions/options*`, same IDs, kinds and order) and what each chosen one hands back to the SDK
 * (`permissions/effects.js`). Latch itself shows only the one-time ones (`filterPermissionOptions`); the others are
 * offered as the adapter offers them, and answered the same way if a client chooses one.
 */
import { homedir } from 'node:os'
import { basename, dirname, join, normalize, relative, resolve, sep } from 'node:path'
import { isRecord } from './process.ts'

export const OPTION = {
  allowOnce: 'allow-once',
  allowWithUpdates: 'allow-with-updates',
  allowSkillExact: 'allow-skill-exact',
  allowSkillPrefix: 'allow-skill-prefix',
  exitPlanBypass: 'exit-plan-bypass',
  exitPlanAuto: 'exit-plan-auto',
  exitPlanAcceptEdits: 'exit-plan-accept-edits',
  exitPlanDefault: 'exit-plan-default',
  exitPlanClearAuto: 'exit-plan-clear-auto',
  exitPlanClearBypass: 'exit-plan-clear-bypass',
  exitPlanClearAcceptEdits: 'exit-plan-clear-accept-edits',
  reject: 'reject',
} as const

export interface PermissionOption {
  optionId: string
  name: string
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
}

type Update = Record<string, unknown> & { type: string; destination: string }
interface Rule {
  toolName: string
  ruleContent?: string
}

export interface AskContext {
  toolName: string
  input: Record<string, unknown>
  toolUseID: string
  cwd: string
  /** The CLI's suggestions, checked and copied (`normalizeChangeSet`); absent when it gave none Latch may offer. */
  changeSet?: Update[]
  allowPersistent: boolean
  displayName?: string
  defaultToNo?: boolean
  availableModes: readonly string[]
  prePlanMode?: string
}

const plain = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
const allowOnce = (name = 'Yes'): PermissionOption => ({ optionId: OPTION.allowOnce, name, kind: 'allow_once' })
const allowWithUpdates = (name: string): PermissionOption => ({ optionId: OPTION.allowWithUpdates, name, kind: 'allow_always' })
const reject = (name = 'No'): PermissionOption => ({ optionId: OPTION.reject, name, kind: 'reject_once' })
const withOptionalUpdate = (changeSet: Update[] | undefined, updateName: string | undefined) => [
  allowOnce(),
  ...(changeSet && updateName ? [allowWithUpdates(updateName)] : []),
  reject(),
]
const rulesOf = (update: Update): Rule[] => (Array.isArray(update.rules) ? (update.rules as Rule[]) : [])

// ---- The CLI's suggestions -----------------------------------------------------------------------------------------

const DESTINATIONS = new Set(['session', 'cliArg', 'userSettings', 'projectSettings', 'localSettings'])
const BEHAVIORS = new Set(['allow', 'deny', 'ask'])
const MODES = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'])
const safe = (value: unknown, max: number) =>
  typeof value === 'string'
  && value.trim().length > 0
  && value.length <= max
  && ![...value.trim()].some(c => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(c))

function knownUpdate(value: unknown): value is Update {
  if (!isRecord(value) || typeof value.destination !== 'string' || !DESTINATIONS.has(value.destination)) return false
  switch (value.type) {
    case 'addRules':
    case 'replaceRules':
    case 'removeRules':
      return (
        Array.isArray(value.rules)
        && value.rules.length <= 100
        && (value.type === 'replaceRules' || value.rules.length > 0)
        && value.rules.every(
          rule => isRecord(rule) && safe(rule.toolName, 512) && (rule.ruleContent === undefined || safe(rule.ruleContent, 10_000)),
        )
        && typeof value.behavior === 'string'
        && BEHAVIORS.has(value.behavior)
      )
    case 'setMode':
      return typeof value.mode === 'string' && MODES.has(value.mode)
    case 'addDirectories':
    case 'removeDirectories':
      return (
        Array.isArray(value.directories)
        && value.directories.length > 0
        && value.directories.length <= 100
        && value.directories.every(item => safe(item, 4096))
      )
    default:
      return false
  }
}

/** The suggestions as they were when asked, or none when one is not a plain update or the person's own ask rule forced the ask. */
export function normalizeChangeSet(suggestions: unknown, forcedAsk: boolean): Update[] | undefined {
  if (forcedAsk || !Array.isArray(suggestions) || !suggestions.length || suggestions.length > 100) return undefined
  try {
    return suggestions.every(knownUpdate) ? (structuredClone(suggestions) as Update[]) : undefined
  } catch {
    return undefined
  }
}

// ---- Options by tool -----------------------------------------------------------------------------------------------

const inside = (directory: string, candidate: string) => {
  const path = relative(resolve(directory), resolve(candidate))
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..')
}

function fileSessionChangeSet(changeSet: Update[] | undefined, operation: 'read' | 'write'): changeSet is Update[] {
  return (
    !!changeSet
    && changeSet.every(update => {
      if (update.destination !== 'session') return false
      if (update.type === 'setMode') return operation === 'write' && update.mode === 'acceptEdits'
      if (update.type === 'addDirectories') return operation === 'write'
      if (update.type !== 'addRules' || update.behavior !== 'allow') return false
      return rulesOf(update).every(rule => rule.toolName === (operation === 'read' ? 'Read' : 'Edit'))
    })
  )
}

function fileSessionLabel(context: AskContext, filePath: string | undefined, operation: 'read' | 'write'): string | undefined {
  const changeSet = context.changeSet
  if (!fileSessionChangeSet(changeSet, operation)) return undefined
  const tool = operation === 'read' ? 'Read' : 'Edit'
  const resolved = filePath ? resolve(context.cwd, filePath) : undefined
  const claudePath =
    operation === 'write' && !!resolved && (inside(join(context.cwd, '.claude'), resolved) || inside(join(homedir(), '.claude'), resolved))
  const sessionRule = (broad: boolean) =>
    changeSet.some(
      update =>
        update.type === 'addRules'
        && update.behavior === 'allow'
        && rulesOf(update).some(rule => rule.toolName === tool && (!broad || rule.ruleContent === undefined)),
    )
  const acceptEdits = changeSet.some(update => update.type === 'setMode' && update.mode === 'acceptEdits')
  if (resolved) {
    const directory = dirname(resolved)
    const paths = changeSet.flatMap(update =>
      update.type === 'addDirectories'
        ? (update.directories as string[])
        : update.type === 'addRules' && update.behavior === 'allow'
          ? rulesOf(update).flatMap(rule =>
              rule.toolName === tool && plain(rule.ruleContent) ? [plain(rule.ruleContent)!.replace(/[/\\]\*\*$/u, '')] : [],
            )
          : [],
    )
    const covered = paths.some(candidate => {
      const path = resolve(context.cwd, candidate)
      return path === directory || inside(path, resolved)
    })
    if (!covered && !sessionRule(true) && !(operation === 'write' && !claudePath && acceptEdits)) return undefined
  } else if (!sessionRule(true) && !(operation === 'write' && acceptEdits)) return undefined
  if (operation === 'write' && resolved && claudePath && sessionRule(false))
    return 'Yes, and allow Claude to edit its own settings for this session'
  if (!resolved || inside(context.cwd, resolved))
    return operation === 'read' ? 'Yes, during this session' : 'Yes, allow all edits during this session'
  const name = basename(dirname(resolved)) || 'this directory'
  return operation === 'read'
    ? `Yes, allow reading from ${name}${sep} during this session`
    : `Yes, allow all edits in ${name}${sep} during this session`
}

function list(values: string[]): string {
  if (values.join(', ').length > 50) return 'similar'
  if (values.length === 1) return values[0]!
  if (values.length === 2) return `${values[0]} and ${values[1]}`
  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`
}

function paths(values: string[]): string {
  const names = [...new Set(values.map(value => normalize(value)))].map(value => {
    const name = basename(value) || value
    return name.endsWith(sep) ? name : `${name}${sep}`
  })
  return names.length <= 2 ? list(names) : `${names[0]}, ${names[1]} and ${names.length - 2} more`
}

/** The adapter's port of Claude Code's own label for a shell suggestion; undefined when it cannot say what it allows. */
function shellLabel(tool: string, changeSet: Update[]): string | undefined {
  const representable = changeSet.every(update => {
    if (update.type === 'addDirectories') return update.destination === 'session'
    if (update.type !== 'addRules' || update.behavior !== 'allow') return false
    return rulesOf(update).every(rule => (rule.toolName === tool || rule.toolName === 'Read') && plain(rule.ruleContent) !== undefined)
  })
  if (!representable) return undefined
  const rules = changeSet.filter(update => update.type === 'addRules').flatMap(rulesOf)
  const reads = rules
    .filter(rule => rule.toolName === 'Read')
    .flatMap(rule => (rule.ruleContent ? [rule.ruleContent.replace(/\/\*\*$/u, '')] : []))
  const commands = [
    ...new Set(rules.filter(rule => rule.toolName === tool && rule.ruleContent).map(rule => rule.ruleContent!.replace(/:\*$/u, ''))),
  ]
  const directories = changeSet.filter(update => update.type === 'addDirectories').flatMap(update => update.directories as string[])
  const all = [...directories, ...reads]
  if (reads.length && !directories.length && !commands.length) return `Yes, allow reading from ${paths(reads)} from this project`
  if (directories.length && !reads.length && !commands.length)
    return `Yes, and always allow access to ${paths(directories)} from this project`
  if (commands.length && !all.length) return `Yes, and don't ask again for ${list(commands)} commands`
  if (all.length && !commands.length) return `Yes, and always allow access to ${paths(all)} from this project`
  if (all.length && commands.length)
    return all.length === 1 && commands.length === 1
      ? `Yes, and allow access to ${paths(all)} and ${list(commands)} commands`
      : `Yes, and allow ${paths(all)} access and ${list(commands)} commands`
  return undefined
}

const mcpAllow = (changeSet: Update[] | undefined, tool: string) =>
  !!changeSet
  && changeSet.length > 0
  && changeSet.every(
    update =>
      update.type === 'addRules'
      && update.behavior === 'allow'
      && rulesOf(update).length > 0
      && rulesOf(update).every(rule => rule.toolName === tool && rule.ruleContent === undefined),
  )

function exitPlanOptions(context: AskContext): PermissionOption[] {
  const modes = new Set(context.availableModes)
  const elevated = (context.prePlanMode === 'bypassPermissions' ? ['bypassPermissions', 'auto'] : ['auto', 'bypassPermissions']).filter(
    mode => modes.has(mode),
  )
  const preferred = elevated[0] ?? 'acceptEdits'
  const options: PermissionOption[] = []
  if (plain(context.input.plan))
    options.push(
      preferred === 'auto'
        ? { optionId: OPTION.exitPlanClearAuto, name: 'Yes, clear context and use auto mode', kind: 'allow_always' }
        : preferred === 'bypassPermissions'
          ? { optionId: OPTION.exitPlanClearBypass, name: 'Yes, clear context and bypass permissions', kind: 'allow_always' }
          : { optionId: OPTION.exitPlanClearAcceptEdits, name: 'Yes, clear context and auto-accept edits', kind: 'allow_always' },
    )
  for (const mode of elevated)
    options.push(
      mode === 'auto'
        ? { optionId: OPTION.exitPlanAuto, name: 'Yes, and use auto mode', kind: 'allow_always' }
        : { optionId: OPTION.exitPlanBypass, name: 'Yes, and bypass permissions', kind: 'allow_always' },
    )
  if (!elevated.length) options.push({ optionId: OPTION.exitPlanAcceptEdits, name: 'Yes, auto-accept edits', kind: 'allow_always' })
  options.push({ optionId: OPTION.exitPlanDefault, name: 'Yes, manually approve edits', kind: 'allow_once' })
  options.push(reject('No, keep planning'))
  return options
}

function unsortedOptions(context: AskContext): PermissionOption[] {
  const { toolName: tool, input, changeSet } = context
  const label = plain(context.displayName) ?? tool
  if (tool.startsWith('mcp__')) {
    const allowed = context.allowPersistent && mcpAllow(changeSet, tool) ? changeSet : undefined
    return withOptionalUpdate(
      allowed,
      allowed ? `Yes, and don't ask again for ${label}${tool.startsWith('mcp__computer-use__') ? '' : ' commands'}` : undefined,
    )
  }
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return withOptionalUpdate(changeSet, changeSet ? shellLabel(tool, changeSet) : undefined)
    case 'Read':
      return withOptionalUpdate(changeSet, fileSessionLabel(context, plain(input.file_path), 'read'))
    case 'Glob':
    case 'Grep':
      return withOptionalUpdate(changeSet, fileSessionLabel(context, plain(input.path) ?? context.cwd, 'read'))
    case 'Edit':
    case 'Write':
      return withOptionalUpdate(changeSet, fileSessionLabel(context, plain(input.file_path), 'write'))
    case 'NotebookEdit':
      return withOptionalUpdate(changeSet, fileSessionLabel(context, plain(input.notebook_path), 'write'))
    case 'WebFetch': {
      const url = plain(input.url)
      if (url && context.allowPersistent)
        try {
          const host = new URL(url).hostname
          if (host) return [allowOnce(), allowWithUpdates(`Yes, and don't ask again for ${host}`), reject()]
        } catch {
          // Not a URL: no domain to name.
        }
      return [allowOnce(), reject()]
    }
    case 'Skill': {
      const skill = plain(input.skill)
      const options = [allowOnce()]
      if (skill && context.allowPersistent) {
        options.push({ optionId: OPTION.allowSkillExact, name: `Yes, and don't ask again for ${skill}`, kind: 'allow_always' })
        const space = skill.indexOf(' ')
        if (space > 0)
          options.push({
            optionId: OPTION.allowSkillPrefix,
            name: `Yes, and don't ask again for ${skill.slice(0, space)}:* commands`,
            kind: 'allow_always',
          })
      }
      return [...options, reject()]
    }
    case 'EnterPlanMode':
      return [allowOnce('Yes, enter plan mode'), reject('No, start implementing now')]
    case 'ExitPlanMode':
      return exitPlanOptions(context)
    case 'SandboxNetworkAccess': {
      const host = plain(input.host)
      const only = changeSet?.length === 1 ? changeSet[0] : undefined
      const rule =
        only?.type === 'addRules' && only.behavior === 'allow' && only.destination === 'localSettings' && rulesOf(only).length === 1
          ? rulesOf(only)[0]
          : undefined
      return withOptionalUpdate(
        changeSet,
        host && rule?.toolName === tool && plain(rule.ruleContent) === host ? `Yes, and don't ask again for ${host}` : undefined,
      )
    }
    default:
      return context.allowPersistent
        ? [allowOnce(), allowWithUpdates(`Yes, and don't ask again for ${label} commands`), reject()]
        : [allowOnce(), reject()]
  }
}

const order = (option: PermissionOption) => (option.kind === 'allow_once' ? 0 : option.kind === 'allow_always' ? 1 : 3)

/** The adapter's options for this ask, in its order: the approvals first, or the refusals when Claude leans to no. */
export function permissionOptions(context: AskContext): PermissionOption[] {
  const rank = context.defaultToNo ? (option: PermissionOption) => (option.kind.startsWith('reject') ? 0 : 1 + order(option)) : order
  return unsortedOptions(context).sort((left, right) => rank(left) - rank(right))
}

// ---- What a choice hands back --------------------------------------------------------------------------------------

type PermissionResult = Record<string, unknown> & { behavior: 'allow' | 'deny' }

const localRule = (toolName: string, ruleContent?: string): Update[] => [
  {
    type: 'addRules',
    rules: [{ toolName, ...(ruleContent === undefined ? {} : { ruleContent }) }],
    behavior: 'allow',
    destination: 'localSettings',
  },
]

export interface Decision {
  result: PermissionResult
  /** ExitPlanMode's clear-context choices: the mode to go on in with a fresh context. */
  clearContext?: string
  /** The choice stops the turn (keep planning, clear context): it ends as cancelled, as on the adapter. */
  interrupts?: true
}

/** The SDK result of the chosen option, as the adapter's `applyClaudePermissionSelection`; undefined for one not offered. */
export function decide(context: AskContext, offered: readonly PermissionOption[], optionId: string): Decision | undefined {
  if (!offered.some(option => option.optionId === optionId)) return undefined
  const { toolName: tool, input, toolUseID } = context
  const allow = (updates?: Update[], permanent = false): Decision => ({
    result: {
      behavior: 'allow',
      updatedInput: input,
      ...(updates ? { updatedPermissions: updates } : {}),
      toolUseID,
      decisionClassification: permanent ? 'user_permanent' : 'user_temporary',
    },
  })
  const deny = (message = 'User refused permission to run tool', interrupt = false): Decision => ({
    result: { behavior: 'deny', message, ...(interrupt ? { interrupt: true } : {}), toolUseID, decisionClassification: 'user_reject' },
    ...(interrupt ? { interrupts: true as const } : {}),
  })
  if (tool === 'ExitPlanMode') {
    const clear = {
      [OPTION.exitPlanClearAuto]: 'auto',
      [OPTION.exitPlanClearBypass]: 'bypassPermissions',
      [OPTION.exitPlanClearAcceptEdits]: 'acceptEdits',
    }[optionId]
    if (clear) return { ...deny('User accepted the plan and requested a fresh context', true), clearContext: clear }
    const mode = {
      [OPTION.exitPlanBypass]: 'bypassPermissions',
      [OPTION.exitPlanAuto]: 'auto',
      [OPTION.exitPlanAcceptEdits]: 'acceptEdits',
      [OPTION.exitPlanDefault]: 'default',
    }[optionId]
    if (mode) return allow([{ type: 'setMode', mode, destination: 'session' }], mode !== 'default')
    // A plain deny lets Claude go on planning; the interrupt ends this turn, which the adapter reports as cancelled.
    if (optionId === OPTION.reject) return deny('User chose to keep planning', true)
  }
  if (tool === 'Skill' && (optionId === OPTION.allowSkillExact || optionId === OPTION.allowSkillPrefix)) {
    const skill = plain(input.skill)
    if (!skill) return undefined
    const space = skill.indexOf(' ')
    if (optionId === OPTION.allowSkillPrefix && space <= 0) return undefined
    return allow(localRule('Skill', optionId === OPTION.allowSkillExact ? skill : `${skill.slice(0, space)}:*`), true)
  }
  if (optionId === OPTION.allowOnce) return allow()
  if (optionId === OPTION.reject) return deny()
  if (optionId !== OPTION.allowWithUpdates) return undefined
  if (tool === 'WebFetch') {
    try {
      const host = new URL(String(input.url)).hostname
      return host ? allow(localRule('WebFetch', `domain:${host}`), true) : undefined
    } catch {
      return undefined
    }
  }
  // Tools Claude suggests a rule for take the suggestion; any other is allowed from now on in the local settings.
  if (SUGGESTED.has(tool) || tool.startsWith('mcp__')) return context.changeSet ? allow(context.changeSet, true) : undefined
  return allow(localRule(tool), true)
}

const SUGGESTED = new Set([
  'Read',
  'Bash',
  'PowerShell',
  'Glob',
  'Grep',
  'Edit',
  'Write',
  'NotebookEdit',
  'SandboxNetworkAccess',
  'EnterPlanMode',
  'Skill',
])
