import type { HarnessDriver } from '@latch/sdk'
import { createRuntime } from '@latch/core'

/** The bundled independent loop; external drivers may supply an entirely different Bridge. */
export const standardHarnessDriver: HarnessDriver = {
  id: 'standard',
  name: 'Standard Harness',
  version: '0.1.0',
  description: '独立的会话、模型调用、工具审批、取消与持久化运行时。',
  capabilities: { modes: ['chat', 'agent'], models: 'host' },
  // The Host options pass through whole, so `classifyToolCall` and `tmpRoot` reach the runtime unchanged.
  create: options => createRuntime(options),
}
