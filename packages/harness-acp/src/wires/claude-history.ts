/**
 * A Claude session's transcript as ACP's replay of `session/load`: what `claude-agent-acp` 0.101 replays
 * (`acp-agent.js`, its replay of resumed sessions), from the messages Claude's store reader returns. The person's words
 * and Claude's, and each tool call with its result. Left out, as on the adapter: Claude's own notes (`isMeta`),
 * compaction summaries, the commands Claude Code runs itself, its login and limit notices (`model: "<synthetic>"`) and
 * subagents' inner messages (only the Agent call and its result show). Thinking is not replayed, nor are an image's bytes.
 */
import { clip, TOOL_TEXT_LIMIT } from '../mapping.ts'
import type { StoredMessage } from '../claude-store.ts'
import { PLAN_TOOLS, resultText, toolFacts } from './claude-tools.ts'
import { isRecord } from './process.ts'

/** Commands Claude Code answers itself; a replay hides them whole (the adapter's list). */
const HIDDEN_COMMANDS = new Set(['compact', 'model', 'mcp', 'status', 'usage', 'context', 'heapdump', 'extra-usage', 'clear', 'cost'])
const TAG = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'u')
const MARKUP = /<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|system-reminder)>[\s\S]*?<\/\1>/gu

/** A user's text with Claude Code's markup taken out: a command it ran itself is hidden, another shows as `/name args`. */
export function promptText(text: string): string | undefined {
  const command = TAG('command-name').exec(text)?.[1]?.trim()
  if (command) {
    const name = command.replace(/^\//u, '')
    if (HIDDEN_COMMANDS.has(name)) return undefined
    const args = TAG('command-args').exec(text)?.[1]?.trim()
    return `/${name}${args ? ` ${args}` : ''}`
  }
  if (/<local-command-std(?:out|err)>/u.test(text)) return undefined
  const left = text.replace(MARKUP, '').trim()
  return left || undefined
}

type Update = Record<string, unknown> & { sessionUpdate: string }

/** The replay of one session, in order. */
export function replayUpdates(messages: readonly StoredMessage[], cwd: string): Update[] {
  const updates: Update[] = []
  const calls = new Map<string, string>()
  for (const message of messages) {
    if (message.parentToolUseId || message.meta || message.compactSummary) continue
    if (message.type === 'user') {
      const words: string[] = []
      for (const block of message.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          const said = promptText(block.text)
          if (said) words.push(said)
        } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const tool = calls.get(block.tool_use_id)
          if (!tool) continue
          const said = resultText(block.content)
          updates.push({
            sessionUpdate: 'tool_call_update',
            toolCallId: block.tool_use_id,
            status: block.is_error === true ? 'failed' : 'completed',
            ...(said ? { content: [{ type: 'content', content: { type: 'text', text: clip(said, TOOL_TEXT_LIMIT) } }] } : {}),
            _meta: { claudeCode: { toolName: tool } },
          })
        }
      }
      if (words.length) updates.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: words.join('\n\n') } })
      continue
    }
    if (message.type !== 'assistant' || message.model === '<synthetic>') continue
    for (const block of message.content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        updates.push({
          sessionUpdate: 'agent_message_chunk',
          ...(message.id ? { messageId: message.id } : {}),
          content: { type: 'text', text: block.text },
        })
      } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        if (PLAN_TOOLS.has(block.name)) continue
        calls.set(block.id, block.name)
        const facts = toolFacts(block.name, block.input, cwd)
        updates.push({
          sessionUpdate: 'tool_call',
          toolCallId: block.id,
          name: block.name,
          title: clip(facts.title, 500),
          kind: facts.kind,
          status: 'pending',
          rawInput: isRecord(block.input) ? block.input : {},
          content: facts.content ?? [],
          ...(facts.locations ? { locations: facts.locations } : {}),
          _meta: { claudeCode: { toolName: block.name } },
        })
      }
    }
  }
  return updates
}
