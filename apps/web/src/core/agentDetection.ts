import type { AgentSettings, CommandDetection } from '@latch/protocol'

/** Explain only the locally detected command/adapter state, without loading the settings editor. */
export function missingText(agent: Pick<AgentSettings, 'command' | 'detected'>): string | undefined {
  const companion = agent.detected.companion
  if (!companion) {
    if (agent.detected.found) return undefined
    const known = agent.detected.agent
    return known?.found ? `已安装 ${known.command}，还差让 Latch 连接它的适配器 ${agent.command}` : `未找到命令 ${agent.command}`
  }
  if (agent.detected.found && companion.found) return undefined
  if (agent.detected.found) return `已找到适配器 ${agent.command}，还没找到 ${companion.command}`
  if (companion.found) return `已安装 ${companion.command}，还差让 Latch 连接它的适配器 ${agent.command}`
  return `未找到 ${companion.command} 和它的适配器 ${agent.command}`
}

/** The program a person knows is here and only the adapter that connects it is not: what to call it, or undefined. */
export function foundWithoutAdapter(detected: CommandDetection | undefined): string | undefined {
  if (!detected || detected.found) return undefined
  return detected.companion?.found ? detected.companion.command : detected.agent?.found ? detected.agent.command : undefined
}
