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
    neverAskModes: ['yolo'],
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
