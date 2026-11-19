import { antigravityProfile } from './antigravity.ts'
import { claudeAgentProfile, claudeProfile } from './claude-agent.ts'
import { codexAcpProfile } from './codex-acp.ts'
import { codexProfile } from './codex.ts'
import { cursorProfile } from './cursor.ts'
import { cursorSdkProfile } from './cursor-sdk.ts'
import { dshProfile } from './dsh.ts'
import { gooseProfile } from './goose.ts'
import { grokProfile } from './grok.ts'
import { opencodeAcpProfile, opencodeProfile } from './opencode.ts'
import { piProfile } from './pi.ts'
import { qwenProfile } from './qwen.ts'
import type { HarnessProfile } from './types.ts'

export type {
  AcpPermissionProfile,
  ExtensionRequest,
  HarnessProfile,
  LoginCheck,
  LoginStatus,
  ProjectConfigManaged,
  ProjectedChild,
  QuotaCommand,
  RetryReport,
  ToolDenial,
} from './types.ts'

export const HARNESS_PROFILES: ReadonlyMap<string, HarnessProfile> = new Map(
  [
    codexProfile,
    claudeProfile,
    qwenProfile,
    gooseProfile,
    dshProfile,
    opencodeProfile,
    piProfile,
    cursorProfile,
    antigravityProfile,
    grokProfile,
  ].map(profile => [profile.presetId, profile]),
)

/** The profile of a preset's `fallback` adapter, by preset ID: what a definition on the adapter runs with. */
export const FALLBACK_PROFILES: ReadonlyMap<string, HarnessProfile> = new Map(
  [codexAcpProfile, opencodeAcpProfile, claudeAgentProfile].map(profile => [profile.presetId, profile]),
)

export function profileFor(presetId: string | undefined): HarnessProfile | undefined {
  return presetId === undefined ? undefined : HARNESS_PROFILES.get(presetId)
}

/** Cursor through its official SDK, for a Cursor definition that carries the key the SDK reads (`selectProfile`). */
export const CURSOR_SDK_PROFILE: HarnessProfile = cursorSdkProfile
