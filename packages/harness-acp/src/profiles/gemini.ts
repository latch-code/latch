import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@latch/core/node-kit'
import type { HarnessProfile, RetryReport, SessionUpdate } from './types.ts'

/** Turns off the "always allow" choices Gemini CLI would otherwise store. The key path has not been checked against a release yet. */
const SYSTEM_SETTINGS = { security: { disableAlwaysAllow: true, enablePermanentToolApproval: false } }
const FILE = 'gemini-system-settings.json'

/**
 * The aliases Gemini CLI asks for on its own helper calls (web fetch and search, loop and next-speaker checks, edit
 * fixes, summaries, compression, and its experimental context management's token count and distillation), each
 * naming a fixed model. One it does not define (`context-calibrator`) is sent as a model name unless pointed elsewhere.
 */
const HELPER_ALIASES = [
  'classifier',
  'prompt-completion',
  'fast-ack-helper',
  'edit-corrector',
  'summarizer-default',
  'summarizer-shell',
  'web-search',
  'web-fetch',
  'web-fetch-fallback',
  'loop-detection',
  'loop-detection-double-check',
  'llm-edit-fixer',
  'next-speaker-checker',
  'context-snapshotter',
  'chat-compression-3-pro',
  'chat-compression-3-flash',
  'chat-compression-3.1-flash-lite',
  'chat-compression-2.5-pro',
  'chat-compression-2.5-flash',
  'chat-compression-2.5-flash-lite',
  'chat-compression-default',
  'agent-history-provider-summarizer',
  'context-calibrator',
  'gemini-3-flash-base',
] as const

/** Gemini CLI's own subagents that pick a fixed model rather than the session's. */
const SUBAGENTS = ['codebase_investigator', 'cli_help', 'browser_agent'] as const

/**
 * Through the gateway: Gemini CLI's `gateway` login, which reads its address and key from the environment. The person's
 * own `security.auth.selectedType` would win over the environment, and system settings win over theirs.
 *
 * The gateway refuses a model outside the service's list, so each helper alias and subagent is pointed at the
 * session's model and keeps its own generation settings. `customOverrides` apply after `overrides` that match as
 * closely, so a person's own `overrides` for an alias win only where they match more than the alias (`isRetry`, say);
 * system settings replace the person's `customOverrides` array whole, while `agents.overrides` merge key by key with
 * theirs.
 */
const routed = (model: string) => ({
  security: { ...SYSTEM_SETTINGS.security, auth: { selectedType: 'gateway' } },
  model: { name: model },
  modelConfigs: { customOverrides: HELPER_ALIASES.map(alias => ({ match: { model: alias }, modelConfig: { model } })) },
  agents: { overrides: Object.fromEntries(SUBAGENTS.map(name => [name, { modelConfig: { model } }])) },
})

async function writeSettings(directory: string, settings: unknown): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, FILE)
  await writeFileAtomic(path, `${JSON.stringify(settings, null, 2)}\n`)
  return path
}

/**
 * Gemini CLI writes a retry as thinking. A model's thought never matches: Gemini CLI sends each as `**subject**` and a
 * description.
 */
const RETRY_ATTEMPT = /^\[Retry (\d+)\/(\d+)\] ([\s\S]*)\. Retrying in \d+s\.\.\.$/u

/**
 * A retry before the reply started names the service's error as it came, often its whole JSON body; its `error.message`
 * (itself JSON at times) is what the service said, as Gemini CLI's own error lines read it.
 */
function serviceReason(text: string): string {
  let reason = text
  for (let depth = 0; depth < 2; depth++) {
    const start = reason.indexOf('{')
    if (start < 0) break
    let error: unknown
    try {
      error = (JSON.parse(reason.slice(start)) as { error?: unknown } | null)?.error
    } catch {
      break
    }
    const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown }
    if (typeof message !== 'string' || !message.trim()) break
    reason = typeof code === 'number' && depth === 0 ? `${code} ${message.trim()}` : message.trim()
  }
  return reason
}

function readRetry(update: SessionUpdate): RetryReport | undefined {
  const meta = update._meta !== null && typeof update._meta === 'object' ? (update._meta as Record<string, unknown>) : undefined
  // Only the first text after a retry carries this; the text before it belongs to the reply that broke off.
  if (update.sessionUpdate === 'agent_message_chunk') return meta?.retry === true && meta.reset === true ? { kind: 'restart' } : undefined
  if (update.sessionUpdate !== 'agent_thought_chunk') return undefined
  if (meta?.retry === true) return { kind: 'interrupted' }
  const content = update.content as { type?: unknown; text?: unknown } | undefined
  const match = content?.type === 'text' && typeof content.text === 'string' ? RETRY_ATTEMPT.exec(content.text) : null
  return match ? { kind: 'attempt', attempt: Number(match[1]), of: Number(match[2]), reason: serviceReason(match[3]!) } : undefined
}

export const geminiProfile: HarnessProfile = {
  presetId: 'gemini',
  version: 2,
  permission: {
    approvals: 'prompts',
    defaultEnv: {},
    expectedMode: 'default',
    modeLadder: ['plan', 'default', 'autoEdit', 'yolo'],
    modeTiers: {
      plan: { tier: 'plan', line: '只看和规划，不改文件' },
      default: { tier: 'ask', line: '改文件或运行命令前问你' },
      autoEdit: { tier: 'rule', line: '直接改文件；运行命令前问你' },
      yolo: { tier: 'never', line: '直接读写这台 Mac 上的文件并运行命令' },
    },
    hiddenOptionIds: ['proceed_always_and_save', 'ProceedAlwaysAndSave'],
    readback: 'mode',
    systemSettings: SYSTEM_SETTINGS,
    inheritEnv: ['GEMINI_CLI_HOME'],
    notes: [],
  },
  // Every ACP session of a process uses its arguments; Gemini CLI splits the value on commas and documents 5 directories.
  folders: { via: 'args', flag: '--include-directories', maxExtra: 4 },
  // Workspace settings, commands and extensions; `.gemini/.env` is looked up from the session directory upwards.
  projectConfigPaths: ['.gemini'],
  readRetry,
  gateway: {
    wires: ['gemini'],
    via: 'env',
    envNames: ['GOOGLE_GEMINI_BASE_URL', 'GEMINI_API_KEY'],
    env: access => ({ GOOGLE_GEMINI_BASE_URL: access.baseURL, GEMINI_API_KEY: access.token }),
  },
  /**
   * Rewrites the file before every spawn (0600, replaced by rename so a planted symlink is replaced, not followed). A
   * session on a gateway route gets its own, in its private directory, since it names the session's model.
   */
  async materialize({ dataDir, route }) {
    const path = route
      ? await writeSettings(join(route.directory, 'gateway'), routed(route.route.model))
      : await writeSettings(dataDir, SYSTEM_SETTINGS)
    return { GEMINI_CLI_SYSTEM_SETTINGS_PATH: path }
  },
}
