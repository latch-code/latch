import { createHash } from 'node:crypto'
import { invalidRequest, invalidReply, toolKey, type GatewayTool, type ToolIdentity } from './ir.ts'

export interface NamedTool extends GatewayTool {
  wireName: string
}

/** Names are deterministic across history and requests; namespace and custom/function identity cannot collide. */
export class ToolNames {
  readonly all: NamedTool[] = []
  private readonly byKey = new Map<string, NamedTool>()
  private readonly byWire = new Map<string, NamedTool>()

  constructor(tools: GatewayTool[], history: ToolIdentity[]) {
    const declared = new Set<string>()
    for (const tool of tools) {
      const key = toolKey(tool)
      if (declared.has(key)) throw invalidRequest('工具列表有重复名称')
      declared.add(key)
      this.add(tool, true)
    }
    for (const tool of history) this.add(tool, false)
  }

  private add(tool: GatewayTool, declared: boolean): NamedTool {
    const key = toolKey(tool)
    const found = this.byKey.get(key)
    if (found) return found
    // Reserve our prefix even for literal names, avoiding collisions with shortened or namespaced names.
    const wireName =
      !tool.namespace && /^[A-Za-z0-9_-]{1,64}$/u.test(tool.name) && !tool.name.startsWith('latch_')
        ? tool.name
        : `latch_${createHash('sha256').update(key).digest('hex').slice(0, 56)}`
    if (this.byWire.has(wireName)) throw invalidRequest('工具名称无法无歧义地转换')
    const named = { ...tool, wireName }
    this.byKey.set(key, named)
    this.byWire.set(wireName, named)
    if (declared) this.all.push(named)
    return named
  }

  name(tool: ToolIdentity): string {
    const named = this.byKey.get(toolKey(tool))
    if (!named) throw invalidRequest('指定的工具不在请求中')
    return named.wireName
  }

  called(name: string): NamedTool {
    const tool = this.byWire.get(name)
    if (!tool || !this.all.includes(tool)) throw invalidReply('模型调用了本次请求未提供的工具')
    return tool
  }
}
