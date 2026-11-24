import { BUILTIN_DEFAULT_MODE, BUILTIN_HARNESS_LABEL, BUILTIN_MODES, BUILTIN_MODE_TIERS } from '@latch/protocol'
import type { HarnessDriver } from '@latch/sdk'
import { createRuntime } from '@latch/core'

/** The bundled independent loop; external drivers may supply an entirely different Bridge. */
export const standardHarnessDriver: HarnessDriver = {
  id: 'standard',
  agentContext: 'private',
  skills: 'native',
  pluginCreation: true,
  name: BUILTIN_HARNESS_LABEL,
  version: '0.1.0',
  description: '独立的会话、模型调用、工具审批、取消与持久化运行时。',
  capabilities: {
    modes: ['chat', 'agent'],
    attachments: { images: true, text: true, textBytes: 256 * 1024 },
    models: { owner: 'latch', catalogue: 'live', wires: ['chat-completions', 'anthropic-messages'] },
    permission: { enforcement: 'latch', rejectionNote: true },
    tools: { shell: false, fileMentions: true },
    display: { mark: 'latch' },
  },
  // Its levels, before any session: who answers a call the Host classed, strictest first; sessions start at 先问你.
  permission: {
    approvals: 'prompts',
    readback: 'mode',
    modeTiers: structuredClone(BUILTIN_MODE_TIERS) as Record<string, (typeof BUILTIN_MODE_TIERS)['ask']>,
    modes: [...BUILTIN_MODES],
    startMode: BUILTIN_DEFAULT_MODE,
  },
  // Sessions get every folder of their project; the Host classifies each tool call against the folder it targets.
  projectFolders: 'all',
  // The Host options pass through whole, so `classifyToolCall`, `projects` and `tmpRoot` reach the runtime unchanged.
  create: options => createRuntime(options),
}
