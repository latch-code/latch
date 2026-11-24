import {
  CONTEXT_STEP_LIMIT,
  CONTEXT_TOOL_CONTRIBUTION_LIMIT,
  type RequestContext,
  type RequestContextBytes,
  type RequestContextStep,
  type RequestContextToolContribution,
} from '@latch/protocol'
import type { ModelMessage, ToolDefinition } from '@latch/sdk'
import type { StoredHistory } from './store.ts'

function keepLargest(items: RequestContextToolContribution[], result: RequestContextToolContribution): void {
  if (items.length === CONTEXT_TOOL_CONTRIBUTION_LIMIT && result.bytes <= items.at(-1)!.bytes) return
  items.push(result)
  items.sort((a, b) => b.bytes - a.bytes)
  if (items.length > CONTEXT_TOOL_CONTRIBUTION_LIMIT) items.pop()
}

/** Measure the logical input after attachment/tool filtering. Transport adapters add their own framing and signatures. */
export function measureInput(
  messages: ModelMessage[],
  tools: ToolDefinition[],
  skillMessage: ModelMessage | undefined,
  sequence: number,
  toolSourceAt: (index: number) => StoredHistory['contextToolSource'],
) {
  const bytes: RequestContextBytes = { instructions: 0, skills: 0, toolSchemas: 0, user: 0, assistant: 0, toolResults: 0 }
  const largest: RequestContextToolContribution[] = []
  const added: RequestContextToolContribution[] = []
  let userMessages = 0
  let assistantMessages = 0
  let toolResults = 0
  let images = 0
  let unmeasuredTools = 0
  for (const tool of tools) {
    try {
      const { name, description, parameters } = tool
      bytes.toolSchemas += Buffer.byteLength(JSON.stringify({ name, description, parameters }))
    } catch {
      // A custom Provider may accept a non-JSON schema. Observing it must not prevent its normal execution.
      unmeasuredTools++
    }
  }
  for (const [index, message] of messages.entries()) {
    let length = Buffer.byteLength(message.content)
    for (const attachment of message.attachments ?? []) {
      if (attachment.type === 'image') images++
      else length += Buffer.byteLength(attachment.text)
    }
    switch (message.role) {
      case 'system':
        if (message === skillMessage) bytes.skills += length
        else bytes.instructions += length
        break
      case 'user':
        userMessages++
        bytes.user += length
        break
      case 'assistant':
        assistantMessages++
        bytes.assistant += length
        for (const { name, arguments: args } of message.toolCalls ?? []) {
          bytes.assistant += Buffer.byteLength(JSON.stringify({ name, arguments: args }))
        }
        break
      case 'tool': {
        toolResults++
        bytes.toolResults += length
        const source = toolSourceAt(index)
        const contribution: RequestContextToolContribution =
          source && source.afterSequence < sequence
            ? {
                bytes: length,
                inclusion: source.afterSequence + 1 === sequence ? 'new' : 'replayed',
                source: { resultId: source.resultId, turnId: source.turnId },
              }
            : { bytes: length, inclusion: 'unknown' }
        keepLargest(largest, contribution)
        if (contribution.inclusion === 'new') keepLargest(added, contribution)
        break
      }
    }
  }
  return {
    bytes,
    toolContributions: { largest, added },
    userMessages,
    assistantMessages,
    toolResults,
    images,
    tools: tools.length,
    ...(unmeasuredTools ? { unmeasuredTools } : {}),
  }
}

/** Preserve the original latest-request projection for saved sessions and existing clients. */
export function latestRequest(step: RequestContextStep): RequestContext {
  const { at, userMessages, assistantMessages, toolResults, tools, skills, images, inputTokens, creator } = step
  return {
    at,
    userMessages,
    assistantMessages,
    toolResults,
    tools,
    skills,
    images,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(creator ? { creator } : {}),
  }
}

/** Update just the current observation, or make room for a new one. Caller owns snapshots written to disk. */
export function withContextStep(history: RequestContextStep[] = [], step: RequestContextStep): RequestContextStep[] {
  const prior = history.at(-1)?.sequence === step.sequence ? history.slice(0, -1) : history.slice(1 - CONTEXT_STEP_LIMIT)
  return [...prior, step]
}
