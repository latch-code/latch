import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
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
    hiddenOptionIds: ['proceed_always_and_save', 'ProceedAlwaysAndSave'],
    readback: 'mode',
    systemSettings: SYSTEM_SETTINGS,
    notes: [],
  },
  // Workspace settings, commands and extensions; `.gemini/.env` is looked up from the session directory upwards.
  projectConfigPaths: ['.gemini'],
  /** Rewrites the file before every spawn (0600, replaced by rename so a planted symlink is replaced, not followed). */
  async materialize({ dataDir }) {
    await mkdir(dataDir, { recursive: true, mode: 0o700 })
    const path = join(dataDir, FILE)
    const temporary = join(dataDir, `.${FILE}-${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(SYSTEM_SETTINGS, null, 2)}\n`)
      await handle.sync()
    } finally { await handle.close() }
    try { await rename(temporary, path) } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
    return { GEMINI_CLI_SYSTEM_SETTINGS_PATH: path }
  },
}
