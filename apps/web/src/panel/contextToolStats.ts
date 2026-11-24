import type { ContextPanelToolCount, Message, SessionContext } from '@latch/protocol'
import { shownToolState, toolDuration } from '../conversation.ts'

export function countContextTools(messages: readonly Message[], nameOf: (message: Message) => string): SessionContext['tools'] {
  const groups = new Map<string, ContextPanelToolCount>()
  let total = 0
  let failures = 0
  for (const message of messages) {
    if (message.role !== 'tool' || message.subagent) continue
    const name = nameOf(message)
    const group = groups.get(name) ?? { name, calls: 0, failed: 0, longestMs: 0 }
    group.calls++
    total++
    const state = shownToolState(message)
    if (state === 'failed') {
      group.failed++
      failures++
    }
    if ((state === 'completed' || state === 'failed') && message.startedAt && message.completedAt) {
      const timing = toolDuration(message, 0)
      if (timing && !timing.live) group.longestMs = Math.max(group.longestMs, timing.ms)
    }
    groups.set(name, group)
  }
  return {
    groups: [...groups.values()].sort((a, b) => b.calls - a.calls || b.failed - a.failed || a.name.localeCompare(b.name)),
    total,
    failures,
  }
}
