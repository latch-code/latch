import type { Approval, Message, TaskDetail, ToolDetail } from '@latch/protocol'

const PATH_KEYS = new Set([
  'path',
  'filePath',
  'file_path',
  'filename',
  'fileName',
  'folder',
  'folderId',
  'root',
  'rootId',
  'cwd',
  'grantRoot',
  'directory',
  'oldPath',
  'newPath',
])
const STATUS_WORDS = new Set(['ok', 'success', 'error', 'failed', 'completed', 'done', 'saved', 'updated', 'cancelled'])
const VALUE_KEYS = new Set([
  'bytes',
  'count',
  'lines',
  'line',
  'startLine',
  'endLine',
  'offset',
  'length',
  'success',
  'isError',
  'overwrite',
  'append',
  'replaceAll',
  'replace_all',
])
const GROUP_KEYS = new Set(['edits', 'changes', 'files', 'result', 'details', 'metadata'])

/** File-edit payloads are opaque except for paths and bounded control/result metadata. Never used for execution. */
function filePayload(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return undefined
  } catch {
    return undefined
  }
  // Keep authorized value tokens verbatim. Re-encoding a parsed number would round it or change -0.
  let at = 0
  const white = () => {
    while (/\s/u.test(text[at] ?? '') && at < text.length) at++
  }
  const string = () => {
    const start = at++
    while (at < text.length) {
      const char = text[at++]
      if (char === '\\') at++
      else if (char === '"') return text.slice(start, at)
    }
    throw new Error('incomplete string')
  }
  const visit = (key: string, depth: number): string | undefined => {
    if (depth > 32) throw new Error('deep payload')
    white()
    if (text[at] === '"') {
      const raw = string(),
        value = JSON.parse(raw) as string
      return PATH_KEYS.has(key) || (key === 'status' && STATUS_WORDS.has(value)) ? raw : undefined
    }
    if (text[at] === '{' || text[at] === '[') {
      const object = text[at] === '{',
        close = object ? '}' : ']'
      const visible = key === '' || GROUP_KEYS.has(key)
      const open = text[at++]!
      const parts: string[] = []
      white()
      if (text[at] === close) {
        at++
        return visible ? open + close : undefined
      }
      for (;;) {
        let nextKey = key
        let name = ''
        if (object) {
          white()
          const raw = string()
          nextKey = JSON.parse(raw) as string
          name = raw + ':'
          white()
          at++
        }
        const value = visit(nextKey, depth + 1)
        if (value !== undefined) parts.push(name + value)
        white()
        const delimiter = text[at++]
        if (delimiter === close) return visible && parts.length ? open + parts.join(',') + close : undefined
      }
    }
    const start = at
    while (at < text.length && !/[\s,}\]]/u.test(text[at]!)) at++
    return VALUE_KEYS.has(key) ? text.slice(start, at) : undefined
  }
  try {
    return visit('', 0)
  } catch {
    return undefined
  }
}

const encodedSize = (text: string) => Buffer.byteLength(JSON.stringify(text))

/** Old file-edit history has no safe producer summary. Keep its outcome, never guess arbitrary text is not a file. */
function oldFileOutput(text: string, toolName: string | undefined): string {
  if (toolName === 'write_file' && /^已写入 [^\r\n]*（\d+ 字节）$/u.test(text)) return text
  const structured = filePayload(text)
  if (structured !== undefined) return structured
  if (text.startsWith('APPROVAL_REJECTED:')) return 'APPROVAL_REJECTED:'
  const facts: string[] = []
  const codes: string[] = []
  if (/(?:^|\n\n)TOOL_OUTCOME_UNKNOWN:/u.test(text)) {
    codes.push('TOOL_OUTCOME_UNKNOWN:')
    facts.push('TOOL_OUTCOME_UNKNOWN: 结果未知，请先核对它做了什么。Latch 不会自动重做。')
  }
  if (/(?:^|\n\n)TOOL_NOT_STARTED:/u.test(text)) {
    codes.push('TOOL_NOT_STARTED:')
    facts.push('TOOL_NOT_STARTED: 工具没有开始执行。')
  }
  if (/(?:^|\n\n)TOOL_CANCELLED:/u.test(text)) {
    codes.push('TOOL_CANCELLED:')
    facts.push('TOOL_CANCELLED: 工具已响应取消。已经发生的副作用不会自动撤销。')
  }
  if (text.startsWith('TOOL_ERROR:')) {
    codes.push('TOOL_ERROR:')
    facts.push('TOOL_ERROR: 工具报告失败，详细输出未向此设备显示。')
  }
  if (text.startsWith('用户拒绝了本次工具调用，未执行该操作。')) facts.push('用户拒绝了本次工具调用，未执行该操作。')
  const shown = facts.join('\n\n')
  return encodedSize(shown) <= encodedSize(text) ? shown : codes.join('\n')
}

function isFileEdit(tool: ToolDetail | undefined, name: string | undefined): boolean {
  return tool?.kind === 'edit' || !!tool?.diffs?.length || name === 'write_file'
}

function shownTool(tool: ToolDetail, name: string | undefined): ToolDetail {
  const editing = isFileEdit(tool, name)
  if (!editing && tool.outputWithoutFiles === undefined) return tool
  const { diffs, input, output, outputWithoutFiles, ...rest } = tool
  const paths = [...new Set([...(rest.locations ?? []), ...(diffs?.map(diff => diff.path) ?? [])])]
  const shownInput = input === undefined || !editing ? input : filePayload(input)
  return {
    ...rest,
    ...(paths.length ? { locations: paths } : {}),
    ...(shownInput !== undefined ? { input: shownInput } : {}),
    ...(output !== undefined
      ? {
          output:
            outputWithoutFiles !== undefined && encodedSize(outputWithoutFiles) <= encodedSize(output)
              ? outputWithoutFiles
              : oldFileOutput(output, name),
        }
      : {}),
  }
}

function projectedItems<T>(items: T[], project: (item: T) => T): T[] {
  const shown = items.map(project)
  return shown.every((item, index) => item === items[index]) ? items : shown
}

function projectedChild(message: Message, project: (message: Message) => Message) {
  if (!message.subagent) return undefined
  const steps = projectedItems(message.subagent.steps, project)
  return steps === message.subagent.steps ? message.subagent : { ...message.subagent, steps }
}

function shownMessage(message: Message): Message {
  const tool = message.tool && shownTool(message.tool, message.toolName)
  const editing = isFileEdit(message.tool, message.toolName)
  let text = message.text
  if (message.role === 'tool' && (editing || tool !== message.tool)) {
    if (message.text === message.tool?.output) text = tool?.output ?? ''
    else if (message.text === message.tool?.input) text = tool?.input ?? ''
    else if (message.text !== message.tool?.title && editing) text = oldFileOutput(message.text, message.toolName)
  }
  const subagent = projectedChild(message, shownMessage)
  if (text === message.text && tool === message.tool && subagent === message.subagent) return message
  return { ...message, text, ...(tool ? { tool } : {}), ...(subagent ? { subagent } : {}) }
}

/** Provenance remains Host-side even when the device may see every original file byte. */
function allTool(tool: ToolDetail): ToolDetail {
  if (tool.outputWithoutFiles === undefined) return tool
  const { outputWithoutFiles: _source, ...visible } = tool
  return visible
}

function allMessage(message: Message): Message {
  const tool = message.tool && allTool(message.tool),
    subagent = projectedChild(message, allMessage)
  if (tool === message.tool && subagent === message.subagent) return message
  return { ...message, ...(tool ? { tool } : {}), ...(subagent ? { subagent } : {}) }
}

export function allApproval(approval: Approval): Approval {
  const tool = approval.tool && allTool(approval.tool)
  return tool === approval.tool ? approval : { ...approval, tool }
}

function projectedDetail(detail: TaskDetail, message: (value: Message) => Message, approval: (value: Approval) => Approval): TaskDetail {
  const messages = projectedItems(detail.messages, message),
    approvals = projectedItems(detail.approvals, approval)
  return messages === detail.messages && approvals === detail.approvals ? detail : { ...detail, messages, approvals }
}

export function allTaskContent(detail: TaskDetail): TaskDetail {
  return projectedDetail(detail, allMessage, allApproval)
}

/** Called only at a response boundary, after classification and the final current-device authorization check. */
export function workApproval(approval: Approval): Approval {
  const editing = isFileEdit(approval.tool, approval.toolName)
  const { arguments: original, ...rest } = approval
  const args = original !== undefined && editing ? filePayload(original) : original
  const tool = approval.tool && shownTool(approval.tool, approval.toolName)
  if (args === original && tool === approval.tool) return approval
  return { ...rest, ...(args !== undefined ? { arguments: args } : {}), ...(tool ? { tool } : {}) }
}

/** The source remains the Host/driver's unmodified history; scope does not change an approval's real arguments. */
export function workTaskContent(detail: TaskDetail): TaskDetail {
  return projectedDetail(detail, shownMessage, workApproval)
}
