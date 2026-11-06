import { claudeAgentProfile } from './claude-agent.ts'
import { codexProfile } from './codex.ts'
import { cursorProfile } from './cursor.ts'
import { dshProfile } from './dsh.ts'
import { geminiProfile } from './gemini.ts'
import { gooseProfile } from './goose.ts'
import { opencodeProfile } from './opencode.ts'
import { piProfile } from './pi.ts'
import { qwenProfile } from './qwen.ts'
import type { HarnessProfile } from './types.ts'

export type { AcpPermissionProfile, ExtensionRequest, HarnessProfile, LoginStatus, ProjectConfigManaged } from './types.ts'

export const HARNESS_PROFILES: ReadonlyMap<string, HarnessProfile> = new Map(
  [codexProfile, claudeAgentProfile, qwenProfile, gooseProfile, geminiProfile, dshProfile, opencodeProfile, piProfile, cursorProfile].map(
    profile => [profile.presetId, profile],
  ),
)

export function profileFor(presetId: string | undefined): HarnessProfile | undefined {
  return presetId === undefined ? undefined : HARNESS_PROFILES.get(presetId)
}
