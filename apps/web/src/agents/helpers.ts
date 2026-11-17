import {
  AGENT_HUES,
  AGENT_PRESETS,
  BUILTIN_HELPER_CARD,
  type AgentAvatar,
  type HarnessInfo,
  type HelperAbility,
  type HelperCard,
  type HostCatalog,
  type TaskMode,
} from '@latch/protocol'
import { builtinHarness, harnessName } from '../composerChoice.ts'
import { MODE_COPY, type Brief } from '../core/securityCopy.ts'
import { agentHarnesses } from './model.ts'

/**
 * 「你想让谁成为你的帮手？」: each ready Harness that can take an Agent is a candidate, Latch 内置 first. A card says only
 * what is true of it: its preset's line and abilities (`HelperCard`, with their source), what the Harness itself reports
 * (a Harness Latch knows cannot run commands loses 跑命令), and 不先问你 where it never asks before acting.
 */
export interface HelperCandidate {
  harness: HarnessInfo
  /** Absent for a Harness Latch has no card for (one you defined yourself): its name alone, no line, no abilities. */
  card?: HelperCard
  abilities: HelperAbility[]
  /** It reports that it acts without asking first: an amber 不先问你 on its card. */
  unasked: boolean
}

/** Installed but not ready to be anyone's helper yet, with the word for why. */
export interface WaitingCandidate {
  harness: HarnessInfo
  words: '需要升级' | '未安装' | '没准备好'
  detail?: string
}

export const ABILITY_WORDS: Record<HelperAbility, string> = {
  files: '读写文件',
  commands: '跑命令',
  mcp: 'MCP',
  ask: '提问',
  memory: '记事',
  schedule: '定时',
}

/** The card a Harness gets: the built-in's own, or its preset's. */
export function helperCard(catalog: HostCatalog | undefined, harness: HarnessInfo): HelperCard | undefined {
  if (harness.id === builtinHarness(catalog)?.id) return BUILTIN_HELPER_CARD
  // A preset's definition carries the preset's ID as its mark (a brand drawn or not).
  const preset = harness.capabilities.display.mark
  return AGENT_PRESETS.find(item => item.id === preset)?.helperCard
}

function candidate(catalog: HostCatalog | undefined, harness: HarnessInfo): HelperCandidate {
  const card = helperCard(catalog, harness)
  // Only what the Harness itself makes possible: commands with a shell, proposals only through Latch's skill server.
  const proposes = harness.agentContext === 'private' || harness.skills === 'server'
  const abilities = (card?.abilities ?? []).filter(
    ability =>
      (ability !== 'commands' || harness.capabilities.tools.shell) && ((ability !== 'memory' && ability !== 'schedule') || proposes),
  )
  return { harness, ...(card ? { card } : {}), abilities, unasked: harness.permission?.approvals === 'none' }
}

/** What a helper on this Harness can really do here: its card's abilities less what the Harness itself lacks. */
export const helperAbilities = (catalog: HostCatalog | undefined, harness: HarnessInfo): HelperAbility[] =>
  candidate(catalog, harness).abilities

/** The candidates, Latch 内置 first and then the Host's order, and the Harnesses that are not ready, greyed below. */
export function helperCandidates(catalog: HostCatalog | undefined): { ready: HelperCandidate[]; waiting: WaitingCandidate[] } {
  const builtin = builtinHarness(catalog)
  const ready = agentHarnesses(catalog).toSorted((a, b) => Number(b.id === builtin?.id) - Number(a.id === builtin?.id))
  const waiting = (catalog?.harnesses ?? [])
    .filter(harness => harness.status !== 'ready' && !harness.offer && harness.agentContext !== undefined)
    .map((harness): WaitingCandidate => {
      const message = harness.statusMessage
      const words =
        harness.statusReason === 'outdated' ? '需要升级' : message && /安装|找不到|not found/iu.test(message) ? '未安装' : '没准备好'
      return { harness, words, ...(message ? { detail: message } : {}) }
    })
  return { ready: ready.map(harness => candidate(catalog, harness)), waiting }
}

/**
 * A new helper's first face: its card's bracket and eyes, in the first hue no other Agent wears yet (the Host's own
 * order), so the person starts from something that is theirs and changes any of it.
 */
export function firstFace(card: HelperCard | undefined, taken: ReadonlyArray<{ avatar: AgentAvatar }>): AgentAvatar {
  const used = new Set(taken.map(agent => agent.avatar.hue))
  const hue = AGENT_HUES.find(item => !used.has(item)) ?? AGENT_HUES[taken.length % AGENT_HUES.length]!
  return { kind: 'face', bracket: card?.face.bracket ?? 'round', eyes: card?.face.eyes ?? 'dot', hue }
}

/** The mode a helper works in: as an Agent where its Harness has that, else the Harness's first. */
export const helperMode = (harness: Pick<HarnessInfo, 'modes'>): TaskMode =>
  harness.modes.includes('agent') ? 'agent' : (harness.modes[0] ?? 'agent')

/**
 * What a person must know before choosing or keeping a helper on an external Harness: Latch does not isolate it, and one
 * that never asks says so (`firstStartUnasked`). Latch 内置 is L1 and has none: Latch decides each of its calls.
 */
export function isolationBrief(harness: Pick<HarnessInfo, 'level' | 'permission' | 'capabilities'>): Brief | undefined {
  if (harness.level !== 'L3') return undefined
  const name = harnessName(harness)
  return harness.permission?.approvals === 'none' ? MODE_COPY.firstStartUnasked(name) : MODE_COPY.firstStart(name)
}
