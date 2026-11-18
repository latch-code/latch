import type { AgentPresetSettings, AgentSettings, CommandDetection } from '@latch/protocol'
import { defineCopy } from './i18n.ts'

const DETECTION_COPY = defineCopy(
  {
    adapterMissing: (program: string, adapter: string) => `已安装 ${program}，还差让 Latch 连接它的适配器 ${adapter}`,
    notFound: (command: string) => `未找到命令 ${command}`,
  } as const,
  {
    adapterMissing: (program: string, adapter: string) =>
      `${program} is installed; the adapter that connects it to Latch, ${adapter}, is missing`,
    notFound: (command: string) => `Command not found: ${command}`,
  },
)

/** Explain only the locally detected command/adapter state, without loading the settings editor. */
export function missingText(agent: Pick<AgentSettings, 'command' | 'detected'>): string | undefined {
  if (agent.detected.found) return undefined
  const known = agent.detected.agent
  return known?.found ? DETECTION_COPY.adapterMissing(known.command, agent.command) : DETECTION_COPY.notFound(agent.command)
}

/** The program a person knows is here and only the adapter that connects it is not: what to call it, or undefined. */
export function foundWithoutAdapter(detected: CommandDetection | undefined): string | undefined {
  if (!detected || detected.found) return undefined
  return detected.agent?.found ? detected.agent.command : undefined
}

/**
 * The presets as the first-run card lists them, each in preset order: found (an executable with the command's name is
 * here, nothing more is known), half-way (the program is here, its adapter is not), and the rest, which can be
 * installed. A preset the Host sent no detection for is in none of them.
 */
export interface PresetsFound {
  found: Array<{ preset: AgentPresetSettings; path?: string }>
  halfway: Array<{ preset: AgentPresetSettings; program: string }>
  more: AgentPresetSettings[]
}

export function presetsFound(presets: readonly AgentPresetSettings[]): PresetsFound {
  const sorted: PresetsFound = { found: [], halfway: [], more: [] }
  for (const preset of presets) {
    const detected = preset.detected
    if (!detected) continue
    const program = foundWithoutAdapter(detected)
    if (detected.found) sorted.found.push({ preset, ...(detected.path ? { path: detected.path } : {}) })
    else if (program) sorted.halfway.push({ preset, program })
    else sorted.more.push(preset)
  }
  return sorted
}
