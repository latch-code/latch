import type { HarnessCapabilities, HarnessInfo } from '@latch/protocol'

type Kind = 'builtin' | 'agent' | 'plugin'
type Options = Partial<Omit<HarnessInfo, 'id' | 'capabilities'>> & { kind?: Kind; label?: string; mark?: string }

const FACTS: Record<Kind, Omit<HarnessCapabilities, 'display'>> = {
  builtin: {
    models: { owner: 'latch', catalogue: 'live', wires: ['chat-completions', 'anthropic-messages'] },
    permission: { enforcement: 'latch', rejectionNote: true },
    tools: { shell: false, fileMentions: true },
  },
  agent: {
    models: { owner: 'harness', catalogue: 'none', wires: [] },
    permission: { enforcement: 'harness', rejectionNote: false },
    tools: { shell: true, fileMentions: true },
  },
  plugin: {
    models: { owner: 'harness', catalogue: 'none', wires: [] },
    permission: { enforcement: 'none', rejectionNote: false },
    tools: { shell: true, fileMentions: false },
  },
}

/** A catalog entry as the Host would send it, for tests of what clients read. An agent's icon defaults to its ID's preset. */
export function testHarness(id: string, { kind = 'agent', label, mark, ...info }: Options = {}): HarnessInfo {
  const shown = mark ?? (kind === 'builtin' ? 'latch' : kind === 'plugin' ? 'plugin' : id.replace(/-\d+$/u, ''))
  return {
    id,
    status: 'ready',
    modes: kind === 'agent' ? ['agent'] : ['chat', 'agent'],
    level: kind === 'builtin' ? 'L1' : 'L3',
    ...(kind === 'agent' ? { editable: true as const } : {}),
    capabilities: { ...structuredClone(FACTS[kind]), display: { label: label ?? id, mark: shown } },
    ...info,
  }
}
