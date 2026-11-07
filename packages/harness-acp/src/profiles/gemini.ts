import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@latch/core/node-kit'
import type { HarnessProfile } from './types.ts'

/** Turns off the "always allow" choices Gemini CLI would otherwise store. The key path has not been checked against a release yet. */
const SYSTEM_SETTINGS = { security: { disableAlwaysAllow: true, enablePermanentToolApproval: false } }
const FILE = 'gemini-system-settings.json'

export const geminiProfile: HarnessProfile = {
  presetId: 'gemini',
  version: 1,
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
  /** Rewrites the file before every spawn (0600, replaced by rename so a planted symlink is replaced, not followed). */
  async materialize({ dataDir }) {
    await mkdir(dataDir, { recursive: true, mode: 0o700 })
    const path = join(dataDir, FILE)
    await writeFileAtomic(path, `${JSON.stringify(SYSTEM_SETTINGS, null, 2)}\n`)
    return { GEMINI_CLI_SYSTEM_SETTINGS_PATH: path }
  },
}
