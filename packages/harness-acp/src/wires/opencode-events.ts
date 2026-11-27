/**
 * OpenCode's server events and records, in the ACP terms `opencode acp` gives them: the same tool calls, titles, kinds,
 * locations, message IDs, subagent marks and compaction rows, so a session reads the same whichever route runs it.
 * Follows OpenCode 2.2.6's own ACP adapter (`packages/cli/src/acp/`: `translate.ts`, `tool.ts`, `child.ts`,
 * `compaction.ts`, `content.ts`, `replay.ts`, `elicitation.ts`), checked against a running 2.2.6 server.
 */
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isRecord } from './process.ts'

export type Json = Record<string, unknown>
export type Update = Json & { sessionUpdate: string }

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)
const rec = (value: unknown): Json => (isRecord(value) ? value : {})

/** 1.x tool names that 2.x reads as its own. */
const V1_ALIASES = new Map([
  ['bash', 'shell'],
  ['task', 'subagent'],
  ['apply_patch', 'patch'],
])

export function canonicalName(toolName: string): string {
  const name = toolName.toLocaleLowerCase()
  return V1_ALIASES.get(name) ?? name
}

function toolKind(toolName: string): string {
  switch (canonicalName(toolName)) {
    case 'shell':
      return 'execute'
    case 'webfetch':
      return 'fetch'
    case 'edit':
    case 'patch':
    case 'write':
      return 'edit'
    case 'grep':
    case 'glob':
    case 'context':
    case 'context7_resolve_library_id':
    case 'context7_get_library_docs':
      return 'search'
    case 'read':
      return 'read'
    case 'subagent':
      return 'think'
    default:
      return 'other'
  }
}

const absolutePath = (path: string, cwd: string): string => (isAbsolute(path) ? path : resolve(cwd, path))
const filePath = (input: Json): string | undefined => str(input.path) ?? str(input.filePath)

/** The files a patch-tool input names (`*** Add File:`, `*** Update File:`, `*** Delete File:`, `*** Move to:`). */
function patchPaths(input: Json): string[] {
  const text = str(input.patchText)
  if (!text) return []
  const paths: string[] = []
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/u.exec(line)
    if (match?.[1]) paths.push(match[1].trim())
  }
  return paths
}

function locationsFrom(cwd: string, ...values: unknown[]): Array<{ path: string }> {
  const paths = values.flatMap(value => (typeof value === 'string' && value ? [absolutePath(value, cwd)] : []))
  return Array.from(new Set(paths), path => ({ path }))
}

function toolLocations(toolName: string, input: Json, cwd: string): Array<{ path: string }> {
  switch (canonicalName(toolName)) {
    case 'shell':
      return locationsFrom(cwd, str(input.workdir) ?? str(input.cwd) ?? cwd)
    case 'read':
    case 'edit':
    case 'write':
      return locationsFrom(cwd, filePath(input))
    case 'patch':
      return locationsFrom(cwd, ...patchPaths(input))
    case 'external_directory':
      return locationsFrom(cwd, input.filepath)
    case 'grep':
    case 'glob':
    case 'context':
    case 'context7_resolve_library_id':
    case 'context7_get_library_docs':
      return locationsFrom(cwd, input.path)
    default:
      return []
  }
}

const isShell = (toolName: string): boolean => canonicalName(toolName) === 'shell'

function toolTitle(toolName: string, input: Json, fallback?: string): string {
  if (isShell(toolName)) return str(input.command) ?? str(input.cmd) ?? fallback ?? toolName
  return fallback || toolName
}

function rawInput(toolName: string, input: Json, cwd: string): Json {
  if (!isShell(toolName) || input.cwd || input.workdir) return input
  return { ...input, cwd }
}

/** OpenCode's tool content: text, and images as data URIs; anything else is left out. */
function toolContent(content: unknown): Json[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((part): Json[] => {
    if (!isRecord(part)) return []
    if (part.type === 'text' && typeof part.text === 'string') return [{ type: 'content', content: { type: 'text', text: part.text } }]
    const match = typeof part.uri === 'string' ? /^data:([^;,]+)(?:;[^,]*)*;base64,(.*)$/u.exec(part.uri) : null
    if (!match?.[1]?.startsWith('image/') || match[2] === undefined) return []
    return [{ type: 'content', content: { type: 'image', mimeType: match[1], data: match[2] } }]
  })
}

export function pendingToolCall(toolCallId: string, toolName: string, input: Json, cwd: string, title?: string): Json {
  return {
    toolCallId,
    name: toolName,
    title: toolTitle(toolName, input, title),
    kind: toolKind(toolName),
    status: 'pending',
    locations: toolLocations(toolName, input, cwd),
    rawInput: rawInput(toolName, input, cwd),
  }
}

export function runningToolUpdate(toolCallId: string, toolName: string, input: Json, cwd: string): Json {
  return {
    toolCallId,
    status: 'in_progress',
    kind: toolKind(toolName),
    title: toolTitle(toolName, input),
    locations: toolLocations(toolName, input, cwd),
    rawInput: rawInput(toolName, input, cwd),
  }
}

export function completedToolUpdate(
  toolCallId: string,
  toolName: string,
  input: Json,
  content: unknown,
  metadata: unknown,
  cwd: string,
): Json {
  const normalized = toolContent(content)
  const images = normalized.filter(part => rec(part.content).type === 'image')
  return {
    toolCallId,
    status: 'completed',
    locations: toolLocations(toolName, input, cwd),
    content: [...normalized.filter(part => !images.includes(part)), ...images, ...fileDiffs(metadata, cwd)],
    rawOutput: metadata === undefined ? {} : { metadata },
  }
}

export function errorToolUpdate(
  toolCallId: string,
  toolName: string,
  input: Json,
  content: unknown,
  metadata: unknown,
  error: string,
  cwd: string,
): Json {
  return {
    toolCallId,
    status: 'failed',
    kind: toolKind(toolName),
    title: toolTitle(toolName, input),
    locations: toolLocations(toolName, input, cwd),
    rawInput: rawInput(toolName, input, cwd),
    content: [...toolContent(content), { type: 'content', content: { type: 'text', text: error } }],
    rawOutput: { ...(metadata === undefined ? {} : { metadata }), error },
  }
}

/**
 * The changed part of each file OpenCode reports with a call (`metadata.files`, unified patches), as the diff the ACP
 * route shows. The adapter reads the whole file to show it entire; this wire reads no file of the project, so the diff
 * holds the patch's own lines: context and removed lines before, context and added lines after.
 */
export function fileDiffs(metadata: unknown, cwd: string): Json[] {
  const files = rec(metadata).files
  if (!Array.isArray(files)) return []
  return files.flatMap((file): Json[] => {
    if (!isRecord(file) || typeof file.file !== 'string' || typeof file.patch !== 'string') return []
    const path = absolutePath(file.file, cwd)
    const before: string[] = []
    const after: string[] = []
    let inHunk = false
    for (const line of file.patch.split('\n')) {
      if (line.startsWith('@@')) {
        if (before.length || after.length) {
          before.push('…')
          after.push('…')
        }
        inHunk = true
        continue
      }
      if (!inHunk || line.startsWith('\\')) continue
      if (line.startsWith('+')) after.push(line.slice(1))
      else if (line.startsWith('-')) before.push(line.slice(1))
      else if (line.startsWith(' ')) {
        before.push(line.slice(1))
        after.push(line.slice(1))
      }
    }
    if (!before.length && !after.length) return []
    const added = file.status === 'added'
    const deleted = file.status === 'deleted'
    return [{ type: 'diff', path, oldText: added ? null : before.join('\n'), newText: deleted ? '' : after.join('\n') }]
  })
}

/** What a permission request is about, in a word, as the ACP route titles it. */
export function permissionTitle(toolName: string, input: Json, diffs: number): string | undefined {
  if (diffs > 1) return `${diffs} files`
  switch (canonicalName(toolName)) {
    case 'external_directory':
      return str(input.description) ?? str(input.command) ?? str(input.parentDir)
    case 'webfetch':
      return str(input.url)
    case 'websearch':
      return str(input.query)
    case 'grep':
    case 'glob':
      return str(input.pattern)
    case 'read':
    case 'edit':
    case 'write':
    case 'patch':
      return filePath(input)
    default:
      return undefined
  }
}

const PATH_ACTIONS = new Set(['read', 'edit', 'external_directory'])

export function permissionLocations(
  toolName: string,
  input: Json,
  action: string,
  resources: unknown,
  cwd: string,
): Array<{ path: string }> {
  const located = toolLocations(toolName, input, cwd)
  if (located.length || !PATH_ACTIONS.has(action) || !Array.isArray(resources)) return located
  const paths = resources.flatMap(resource => {
    if (typeof resource !== 'string') return []
    const path = resource.endsWith('/*') ? resource.slice(0, -2) : resource
    return path && !/[*?]/u.test(path) ? [absolutePath(path, cwd)] : []
  })
  return Array.from(new Set(paths), path => ({ path }))
}

/** A subagent's session as the session that started it reports it: `opencode/child-session` in `_meta`. */
export interface Child {
  id: string
  parentID: string
  depth: number
  title?: string
  /** The session of Latch's that the subagent works under, through any number of subagents. */
  root: string
}

const CHILD_META = 'opencode/child-session'

export function childMeta(child: Child): Json {
  return { [CHILD_META]: { id: child.id, parentID: child.parentID, depth: child.depth, ...(child.title ? { title: child.title } : {}) } }
}

export const childToolCallId = (child: Child | undefined, id: string): string => (child ? `${child.id}:${id}` : id)
export const childTitle = (child: Child | undefined, value: string): string => (child?.title ? `${child.title}: ${value}` : value)

/** A subagent's update as it arrives on the session that started it. */
export function projectChild(update: Update, child: Child | undefined): Update {
  if (!child) return update
  const projected: Update = { ...update, _meta: { ...rec(update._meta), ...childMeta(child) } }
  if (projected.sessionUpdate === 'tool_call' || projected.sessionUpdate === 'tool_call_update') {
    projected.toolCallId = childToolCallId(child, String(projected.toolCallId))
    if (typeof projected.title === 'string' && projected.title) projected.title = childTitle(child, projected.title)
  }
  return projected
}

export const reasoningMessageId = (messageId: string, ordinal: number): string => `${messageId}:reasoning:${ordinal}`

/** OpenCode's token record. */
export interface Tokens {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number; reportedRead?: boolean; reportedWrite?: boolean }
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0)
const hasNum = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0

export function readTokens(value: unknown): Tokens | undefined {
  if (!isRecord(value)) return undefined
  const cache = rec(value.cache)
  const reportedRead = hasNum(cache.read)
  const reportedWrite = hasNum(cache.write)
  return {
    input: num(value.input),
    output: num(value.output),
    reasoning: num(value.reasoning),
    cache: {
      read: num(cache.read),
      write: num(cache.write),
      ...(reportedRead ? { reportedRead: true } : {}),
      ...(reportedWrite ? { reportedWrite: true } : {}),
    },
  }
}

export const totalTokens = (tokens: Tokens): number =>
  tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write

export function addTokens(a: Tokens | undefined, b: Tokens): Tokens {
  if (!a) return b
  const reportedRead = (a.cache.reportedRead ?? a.cache.read > 0) && (b.cache.reportedRead ?? b.cache.read > 0)
  const reportedWrite = (a.cache.reportedWrite ?? a.cache.write > 0) && (b.cache.reportedWrite ?? b.cache.write > 0)
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cache: {
      read: a.cache.read + b.cache.read,
      write: a.cache.write + b.cache.write,
      reportedRead,
      reportedWrite,
    },
  }
}

/** A turn's tokens as `session/prompt` answers them on the ACP route: input and cache apart, as OpenCode counts them. */
export function promptUsage(tokens: Tokens | undefined): Json | undefined {
  if (!tokens) return undefined
  return {
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    totalTokens: totalTokens(tokens),
    ...(tokens.reasoning > 0 ? { thoughtTokens: tokens.reasoning } : {}),
    ...((tokens.cache.reportedRead ?? tokens.cache.read > 0) ? { cachedReadTokens: tokens.cache.read } : {}),
    ...((tokens.cache.reportedWrite ?? tokens.cache.write > 0) ? { cachedWriteTokens: tokens.cache.write } : {}),
  }
}

/** One compaction OpenCode reported starting, by the session it compacts. */
export interface Compaction {
  messageId: string
  reason: string
}

const CANCELLED_COMPACTION = new Set(['aborted', 'compaction.interrupted'])

export function compactionStarted(compaction: Compaction): Update {
  return { sessionUpdate: 'compaction_update', compactionId: compaction.messageId, status: 'in_progress' }
}

export function compactionEnded(compaction: Compaction, summary: string): Update {
  return {
    sessionUpdate: 'compaction_update',
    compactionId: compaction.messageId,
    status: 'completed',
    summary: summary ? [{ type: 'text', text: summary }] : null,
  }
}

export function compactionFailed(compaction: Compaction, error: unknown): Update {
  const { type, message } = rec(error)
  if (typeof type === 'string' && CANCELLED_COMPACTION.has(type))
    return { sessionUpdate: 'compaction_update', compactionId: compaction.messageId, status: 'cancelled', summary: null }
  const text = typeof message === 'string' ? message : ''
  return {
    sessionUpdate: 'compaction_update',
    compactionId: compaction.messageId,
    status: 'failed',
    summary: null,
    // A defect arrives as a multi-line printed cause, which says nothing to a person.
    error: !text || (type === 'compaction.failed' && text.includes('\n')) ? 'Compaction failed' : text,
  }
}

/** A prompt's blocks as OpenCode's input: text, files by URI (images as data URIs), and context only the model sees. */
export interface PreparedPrompt {
  text: string
  files: Array<{ uri: string; name?: string }>
  synthetic: string[]
  slash?: { name: string; args: string }
}

function filenameFromUri(uri: string | undefined): string | undefined {
  if (!uri || uri.startsWith('data:')) return undefined
  if (URL.canParse(uri)) {
    const url = new URL(uri)
    return url.pathname.split('/').filter(Boolean).at(-1) || undefined
  }
  return uri.split('/').filter(Boolean).at(-1) || undefined
}

type Part = { type: 'text'; text: string; synthetic?: true; ignored?: true } | { type: 'file'; url: string; filename?: string }

function blockParts(block: Json): Part[] {
  switch (block.type) {
    case 'text': {
      const text = str(block.text) ?? ''
      const audience = rec(block.annotations).audience
      if (Array.isArray(audience) && audience.length === 1 && audience[0] === 'assistant') return [{ type: 'text', text, synthetic: true }]
      if (Array.isArray(audience) && audience.length === 1 && audience[0] === 'user') return [{ type: 'text', text, ignored: true }]
      return [{ type: 'text', text }]
    }
    case 'image': {
      const mime = str(block.mimeType) ?? 'image/png'
      const url = block.data ? `data:${mime};base64,${String(block.data)}` : str(block.uri)
      if (!url) return []
      const filename = filenameFromUri(str(block.uri)) ?? 'image'
      if (url.startsWith('data:')) return [{ type: 'file', url, filename }]
      return [linkPart({ uri: url, name: filename })]
    }
    case 'resource_link':
      return [linkPart(block)]
    case 'resource': {
      const resource = rec(block.resource)
      const uri = str(resource.uri) ?? ''
      if (typeof resource.text === 'string') {
        const parsed = URL.canParse(uri) ? new URL(uri) : undefined
        let decoded: string | undefined
        if (parsed?.protocol === 'file:') {
          try {
            decoded = fileURLToPath(parsed)
          } catch {
            decoded = decodeURIComponent(parsed.pathname)
          }
        }
        if (!parsed || decoded === undefined) return [{ type: 'text', text: `[${uri}]\n${resource.text}` }]
        const line = /^#L(\d+)/u.exec(parsed.hash)?.[1]
        return [{ type: 'text', text: `[${decoded}${line ? `:${line}` : ''}]\n${resource.text}` }]
      }
      const mime = str(resource.mimeType)
      if (!mime) return []
      return [
        {
          type: 'file',
          url: uri.startsWith('data:') ? uri : `data:${mime};base64,${String(resource.blob ?? '')}`,
          filename: filenameFromUri(uri) ?? 'file',
        },
      ]
    }
    default:
      return []
  }
}

function linkPart(link: Json): Part {
  const uri = str(link.uri) ?? ''
  const name = str(link.name)
  if (uri.startsWith('file://')) return { type: 'file', url: uri, filename: name || filenameFromUri(uri) || 'file' }
  return { type: 'text', text: name ? `[${name}](${uri})` : uri }
}

export function preparePrompt(blocks: readonly Json[]): PreparedPrompt {
  const parts = blocks.flatMap(blockParts)
  const visible = parts.filter(part => part.type !== 'text' || (!part.synthetic && !part.ignored))
  const text = visible.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n')
  const trimmed = text.trim()
  let slash: PreparedPrompt['slash']
  if (trimmed.startsWith('/')) {
    const [name, ...rest] = trimmed.slice(1).split(/\s+/u)
    if (name) slash = { name, args: rest.join(' ').trim() }
  }
  return {
    text,
    files: visible.flatMap(part => (part.type === 'file' ? [{ uri: part.url, ...(part.filename ? { name: part.filename } : {}) }] : [])),
    synthetic: parts.flatMap(part => (part.type === 'text' && part.synthetic ? [part.text] : [])),
    ...(slash ? { slash } : {}),
  }
}

/** One of OpenCode's stored messages as the updates `session/load` replays, as the ACP route sends them. */
export function replayUpdates(message: Json, cwd: string): Update[] {
  const id = str(message.id) ?? ''
  if (message.type === 'user') {
    const updates: Update[] = [
      { sessionUpdate: 'user_message_chunk', messageId: id, content: { type: 'text', text: str(message.text) ?? '' } },
    ]
    for (const file of Array.isArray(message.files) ? message.files : []) {
      if (!isRecord(file)) continue
      const source = rec(file.source)
      const mime = str(file.mime) ?? 'application/octet-stream'
      const url = source.type === 'uri' ? str(source.uri) : typeof file.data === 'string' ? `data:${mime};base64,${file.data}` : undefined
      if (!url) continue
      const name = str(file.name)
      if (url.startsWith('file://')) {
        updates.push({
          sessionUpdate: 'user_message_chunk',
          messageId: id,
          content: { type: 'resource_link', uri: url, name: name ?? 'file', mimeType: mime },
        })
        continue
      }
      const match = /^data:([^;]+);base64,(.*)$/u.exec(url)
      if (!match?.[1] || match[2] === undefined) continue
      if (match[1].startsWith('image/'))
        updates.push({ sessionUpdate: 'user_message_chunk', messageId: id, content: { type: 'image', mimeType: match[1], data: match[2] } })
    }
    return updates
  }
  if (message.type === 'compaction') {
    if (message.status === 'running') return []
    const compaction = { messageId: id, reason: str(message.reason) ?? 'auto' }
    return [
      message.status === 'failed' ? compactionFailed(compaction, message.error) : compactionEnded(compaction, str(message.summary) ?? ''),
    ]
  }
  if (message.type !== 'assistant' || !Array.isArray(message.content)) return []
  let reasoning = 0
  return message.content.flatMap((part): Update[] => {
    if (!isRecord(part)) return []
    if (part.type === 'text')
      return [{ sessionUpdate: 'agent_message_chunk', messageId: id, content: { type: 'text', text: str(part.text) ?? '' } }]
    if (part.type === 'reasoning')
      return [
        {
          sessionUpdate: 'agent_thought_chunk',
          messageId: reasoningMessageId(id, reasoning++),
          content: { type: 'text', text: str(part.text) ?? '' },
        },
      ]
    if (part.type !== 'tool' || typeof part.id !== 'string') return []
    const name = str(part.name) ?? 'tool'
    const state = rec(part.state)
    const input = state.status === 'streaming' ? {} : rec(state.input)
    const call: Update = { sessionUpdate: 'tool_call', ...pendingToolCall(part.id, name, input, cwd) }
    switch (state.status) {
      case 'completed':
        return [
          call,
          { sessionUpdate: 'tool_call_update', ...completedToolUpdate(part.id, name, input, state.content, state.metadata, cwd) },
        ]
      case 'running':
        return [call, { sessionUpdate: 'tool_call_update', ...runningToolUpdate(part.id, name, input, cwd) }]
      case 'error':
        return [
          call,
          {
            sessionUpdate: 'tool_call_update',
            ...errorToolUpdate(part.id, name, input, state.content, state.metadata, str(rec(state.error).message) ?? 'Tool failed', cwd),
          },
        ]
      default:
        return [call]
    }
  })
}

/** Forms OpenCode asks through its question tool and web-search setup, which hold no secrets; others are not shown. */
const ELICITED_KINDS = new Set(['question', 'websearch.provider'])
const CREDENTIAL = /password|passphrase|secret|token|api[_ -]?key|credential|private[_ -]?key/iu
export const UNSHOWN_QUESTION =
  "The question couldn't be shown to the user in this client. Continue without an answer: make reasonable assumptions and state them, or ask the user in your reply if you can't proceed."

const customKey = (field: Json): string => `${String(field.key)}_custom`
const hasOptions = (field: Json): boolean => field.type === 'multiselect' || field.options !== undefined

function optionsOf(field: Json): Json[] {
  return (Array.isArray(field.options) ? field.options : []).filter(isRecord).map(option => ({
    const: option.value,
    title: option.label,
    ...(option.description !== undefined ? { description: option.description } : {}),
  }))
}

function stringConstraints(field: Json): Json {
  const required = field.required === true
  const min = typeof field.minLength === 'number' ? field.minLength : undefined
  return {
    ...(field.format !== undefined ? { format: field.format } : {}),
    ...(required ? { minLength: Math.max(min ?? 0, 1) } : min !== undefined ? { minLength: min } : {}),
    ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
    ...(field.pattern !== undefined ? { pattern: field.pattern } : {}),
  }
}

function representable(field: Json, keys: ReadonlySet<string>): boolean {
  if (field.type !== 'string' && field.type !== 'multiselect') return true
  if (!hasOptions(field)) return true
  const values = new Set(optionsOf(field).map(option => option.const))
  const defaults = field.default === undefined ? [] : Array.isArray(field.default) ? field.default : [field.default]
  if (defaults.some(value => !values.has(value))) return false
  if (!field.custom) return true
  if (field.required === true || keys.has(customKey(field))) return false
  return field.type === 'string' || (field.minItems === undefined && field.maxItems === undefined)
}

function fieldProperties(field: Json): Array<[string, Json]> {
  const key = String(field.key)
  const base = {
    ...(field.title !== undefined ? { title: field.title } : {}),
    ...(field.description !== undefined ? { description: field.description } : {}),
  }
  const withDefault = field.default !== undefined ? { default: field.default } : {}
  const other = (description: string): [string, Json] => [
    customKey(field),
    {
      type: 'string',
      title: `${String(field.title ?? key)} (other)`,
      description,
      ...(field.type === 'string' ? stringConstraints(field) : {}),
    },
  ]
  switch (field.type) {
    case 'string': {
      if (!hasOptions(field)) return [[key, { type: 'string', ...base, ...stringConstraints(field), ...withDefault }]]
      const select = { type: 'string', ...base, oneOf: optionsOf(field), ...withDefault }
      return field.custom ? [[key, select], other('Type your own answer')] : [[key, select]]
    }
    case 'multiselect': {
      const min = typeof field.minItems === 'number' ? field.minItems : undefined
      const select = {
        type: 'array',
        ...base,
        items: { anyOf: optionsOf(field) },
        ...(field.required === true ? { minItems: Math.max(min ?? 0, 1) } : min !== undefined ? { minItems: min } : {}),
        ...(field.maxItems !== undefined ? { maxItems: field.maxItems } : {}),
        ...withDefault,
      }
      return field.custom ? [[key, select], other('Add your own answer')] : [[key, select]]
    }
    case 'number':
    case 'integer':
      return [
        [
          key,
          {
            type: field.type,
            ...base,
            ...(field.minimum !== undefined ? { minimum: field.minimum } : {}),
            ...(field.maximum !== undefined ? { maximum: field.maximum } : {}),
            ...withDefault,
          },
        ],
      ]
    case 'boolean':
      return [[key, { type: 'boolean', ...base, ...withDefault }]]
    default:
      return []
  }
}

/** The form as a question card's schema, or undefined when it cannot be shown without asking for a secret. */
export function formSchema(form: Json): Json | undefined {
  const kind = rec(form.metadata).kind
  if (typeof kind !== 'string' || !ELICITED_KINDS.has(kind)) return undefined
  const fields = (Array.isArray(form.fields) ? form.fields : []).filter(isRecord)
  if (!fields.length || fields.length !== (form.fields as unknown[]).length) return undefined
  const credentialLike = (field: Json) =>
    [field.key, field.title, field.description, ...optionsOf(field).map(option => option.title)].some(
      text => typeof text === 'string' && CREDENTIAL.test(text),
    )
  if (fields.some(credentialLike)) return undefined
  if (fields.some(field => field.type === 'external' || (Array.isArray(field.when) && field.when.length))) return undefined
  if (fields.some(field => field.hidden === true && field.required === true && field.default === undefined)) return undefined
  const keys = new Set(fields.map(field => String(field.key)))
  const visible = fields.filter(field => field.hidden !== true)
  if (!visible.every(field => representable(field, keys))) return undefined
  return {
    type: 'object',
    properties: Object.fromEntries(visible.flatMap(fieldProperties)),
    required: visible.filter(field => field.required === true).map(field => String(field.key)),
  }
}

/** The person's answer as OpenCode's form answer, or undefined when it does not answer the form. */
export function formAnswer(form: Json, response: unknown): Json | undefined {
  const answer = rec(response)
  if (answer.action !== 'accept' || !isRecord(answer.content)) return undefined
  const content = answer.content
  const fields = (Array.isArray(form.fields) ? form.fields : []).filter(isRecord)
  return Object.fromEntries(
    fields.flatMap((field): Array<[string, unknown]> => {
      const key = String(field.key)
      if (field.hidden === true) return field.default === undefined ? [] : [[key, field.default]]
      const value = content[key]
      if ((field.type !== 'string' && field.type !== 'multiselect') || !field.custom || !hasOptions(field))
        return value === undefined ? [] : [[key, value]]
      const custom = content[customKey(field)]
      if (typeof custom !== 'string' || !custom.trim()) return value === undefined ? [] : [[key, value]]
      if (field.type === 'string') return [[key, custom]]
      return [[key, Array.isArray(value) ? [...value, custom] : [custom]]]
    }),
  )
}
