import type { AgentSettings } from '@latch/protocol'

/** Explain only the locally detected command/adapter state, without loading the settings editor. */
export function missingText(agent: Pick<AgentSettings, 'command' | 'detected'>): string | undefined {
  const companion = agent.detected.companion
  if (!companion) return agent.detected.found ? undefined : `未找到命令 ${agent.command}`
  if (agent.detected.found && companion.found) return undefined
  if (agent.detected.found) return `已找到适配器 ${agent.command}，还没找到 ${companion.command}`
  if (companion.found) return `已安装 ${companion.command}，还差让 Latch 连接它的适配器 ${agent.command}`
  return `未找到 ${companion.command} 和它的适配器 ${agent.command}`
}
