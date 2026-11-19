import type { SessionCommand, SessionSkill } from './sessions.ts'

/**
 * 设置 › 扩展: what each Harness has, as it reports it over its own protocol, and the vendor's own commands that change
 * it. Latch never writes a CLI's configuration to change it, and never runs these commands: a person types them in its
 * terminal.
 */
export type ExtensionKind = 'skills' | 'commands' | 'mcp' | 'plugins'

/** What the mounted adapter can report for the extension settings. Its MCP report has its own state. */
export interface HarnessExtensionSupport {
  reports: readonly ('skills' | 'commands')[]
  /** Command sources list extensions that register commands. An installed-bundle sync is unavailable here. */
  plugins?: 'command-sources' | 'requires-sync'
}

/** Public labels only. No CLI paths, plugin sources or executable selectors. */
export interface HarnessPluginReport {
  names: string[]
  /** Some reported entries could not be identified or shown. */
  truncated?: true
}

/** `GET /extensions`: the newest report from an ordinary session of each external Harness's current definition. */
export interface HarnessExtensionReport {
  harnessId: string
  /** Absent: no ordinary session of its current definition has reported since it was saved. */
  report?: {
    commands: SessionCommand[]
    /** Absent: that session reported no skills, as most Harnesses do not. */
    skills?: SessionSkill[]
    skillsTruncated?: true
    /** Absent: the session did not obtain a plugin report. Empty names means it reported an empty list. */
    plugins?: HarnessPluginReport
    reportedAt: string
    /** The saved project that session ran in; absent for the default folder or a project since removed. */
    projectId?: string
  }
}

export interface ExtensionsResponse {
  harnesses: HarnessExtensionReport[]
}

/**
 * A vendor command, typed in for the person: `install` and `remove` end in a space for the name or source they add;
 * `update` runs as it stands. `named` builds the command for one listed entry (`<prefix><name>`).
 */
export interface ExtensionCommands {
  install?: string
  remove?: string
  update?: string
  /** Where the vendor documents them: its page, or its CLI's own `--help` (the versions in `HARNESS_EXTENSIONS`). */
  source: string
}

/**
 * What each preset's adapter reports over its protocol, and the vendor's documented commands per kind. A kind without
 * commands has none documented, and the page says so. Each entry's `source` is the vendor's page or the CLI's own `--help`
 * (codex-cli 0.169.0, pi 1.5.0, qwen 0.26.8, opencode 2.2.6, goose 1.57.0, grok 1.0.77, agy 1.5.9), read 2026-11-17.
 */
export interface HarnessExtensionProfile extends HarnessExtensionSupport {
  commands: Partial<Record<ExtensionKind, ExtensionCommands>>
}

/** ACP adapters report slash commands (`available_commands_update`); nothing else of these kinds. */
const ACP_ONLY: HarnessExtensionSupport['reports'] = ['commands']

export const HARNESS_EXTENSIONS: Readonly<Record<string, HarnessExtensionProfile>> = {
  codex: {
    // The direct app-server's `plugin/installed` can sync installed plugin bundles.
    reports: ['commands', 'skills'],
    plugins: 'requires-sync',
    commands: {
      mcp: { install: 'codex mcp add ', remove: 'codex mcp remove ', source: 'https://learn.chatgpt.com/docs/extend/mcp?surface=cli' },
      plugins: { install: 'codex plugin add ', remove: 'codex plugin remove ', source: 'codex plugin --help' },
    },
  },
  'claude-agent': {
    reports: ACP_ONLY,
    commands: {
      mcp: { install: 'claude mcp add ', remove: 'claude mcp remove ', source: 'https://code.claude.com/docs/en/mcp' },
      plugins: {
        install: 'claude plugin install ',
        remove: 'claude plugin uninstall ',
        source: 'https://code.claude.com/docs/en/plugins/cli-reference',
      },
    },
  },
  pi: {
    // pi's RPC `get_commands` lists its extension commands, prompt templates and skills.
    reports: ['commands', 'skills'],
    plugins: 'command-sources',
    commands: {
      mcp: { install: 'pi mcp add ', remove: 'pi mcp remove ', source: 'pi mcp --help' },
      plugins: { install: 'pi install ', remove: 'pi remove ', update: 'pi update --extensions', source: 'pi update --help' },
    },
  },
  dsh: { reports: [], commands: {} },
  opencode: {
    reports: ACP_ONLY,
    commands: {
      mcp: { install: 'opencode mcp add ', source: 'opencode mcp --help' },
      plugins: { install: 'opencode plugin add ', remove: 'opencode plugin remove ', source: 'opencode plugin --help' },
    },
  },
  qwen: {
    reports: ACP_ONLY,
    commands: {
      mcp: { install: 'qwen mcp add ', remove: 'qwen mcp remove ', source: 'qwen mcp --help' },
      plugins: {
        install: 'qwen extensions install ',
        remove: 'qwen extensions uninstall ',
        update: 'qwen extensions update --all',
        source: 'qwen extensions --help',
      },
    },
  },
  goose: {
    reports: ACP_ONLY,
    commands: {
      plugins: { install: 'goose plugin install ', source: 'goose plugin --help' },
    },
  },
  grok: {
    reports: ACP_ONLY,
    commands: {
      mcp: { install: 'grok mcp add ', remove: 'grok mcp remove ', source: 'grok mcp --help' },
      plugins: {
        install: 'grok plugin install ',
        remove: 'grok plugin uninstall ',
        update: 'grok plugin update',
        source: 'grok plugin --help',
      },
    },
  },
  antigravity: {
    reports: ACP_ONLY,
    commands: {
      mcp: { install: 'agy mcp add ', remove: 'agy mcp remove ', source: 'agy mcp --help' },
      plugins: { install: 'agy plugin install ', remove: 'agy plugin uninstall ', source: 'agy plugin --help' },
    },
  },
}

/** A Harness Latch has no profile for (a custom definition): an ACP agent may report its commands, nothing else known. */
export const UNKNOWN_EXTENSION_PROFILE: HarnessExtensionProfile = { reports: ACP_ONLY, commands: {} }

export function hasExtensionProfile(presetId: string | undefined): presetId is string {
  return presetId !== undefined && Object.hasOwn(HARNESS_EXTENSIONS, presetId)
}

export function extensionProfile(presetId: string | undefined): HarnessExtensionProfile {
  return hasExtensionProfile(presetId) ? HARNESS_EXTENSIONS[presetId]! : UNKNOWN_EXTENSION_PROFILE
}

/**
 * A name reported by a Harness, safe to put after a vendor command in a shell: letters, digits, `.`, `_`, `-`, not starting
 * with `-` (no quoting, globbing, expansion or option). Anything else gets no command.
 */
const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u

export function isShellSafeName(name: string): boolean {
  return SAFE_NAME.test(name)
}

/** The vendor's command for one listed entry, or undefined when there is none or the name is not plain. */
export function namedExtensionCommand(prefix: string | undefined, name: string): string | undefined {
  return prefix && prefix.endsWith(' ') && isShellSafeName(name) ? `${prefix}${name}` : undefined
}
