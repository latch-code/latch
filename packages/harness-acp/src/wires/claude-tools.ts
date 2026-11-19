/**
 * How Claude Code's tool calls, task list and questions look on the Agent SDK wire: the same titles, kinds, diffs,
 * locations, plans and question forms `claude-agent-acp` 0.101 sends a client that is neither AIR nor ACP v2
 * (its `tool-calls/reporters/`, `diff.js`, `tools.js` and `elicitation.js`), so a session looks alike on either route.
 */
import { relative, resolve, sep } from 'node:path'
import { clip, TOOL_TEXT_LIMIT } from '../mapping.ts'
import { isRecord } from './process.ts'

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

/** A path inside the session directory relative to it, as the adapter titles it. */
function displayPath(path: string, cwd: string | undefined): string {
  if (!cwd) return path
  const base = resolve(cwd)
  const file = resolve(path)
  return file === base || file.startsWith(base + sep) ? relative(base, file) : path
}

export interface ToolFacts {
  title: string
  kind: string
  content?: unknown[]
  locations?: Array<{ path: string; line?: number }>
}

const textContent = (value: string) => ({ type: 'content', content: { type: 'text', text: clip(value, TOOL_TEXT_LIMIT) } })

/** A Write's path and text, in each spelling the CLI accepts (2.1.280+: `path`, `file_text`, `file_content`). */
function writeInput(input: Record<string, unknown>): { path?: string; content?: string } {
  const path = text(input.file_path) ?? text(input.path)
  const key = ['content', 'file_text', 'file_content'].find(name => input[name] !== undefined && input[name] !== null)
  return { ...(path ? { path } : {}), ...(key && typeof input[key] === 'string' ? { content: input[key] as string } : {}) }
}

function grepTitle(input: Record<string, unknown>): string {
  let label = 'grep'
  if (input['-i']) label += ' -i'
  if (input['-n']) label += ' -n'
  for (const flag of ['-A', '-B', '-C']) if (input[flag] !== undefined) label += ` ${flag} ${String(input[flag])}`
  const mode =
    text(input.output_mode)
    ?? (input['-l'] === true || input['-l'] === 'true'
      ? 'files_with_matches'
      : input['-c'] === true || input['-c'] === 'true'
        ? 'count'
        : undefined)
  if (mode === 'files_with_matches') label += ' -l'
  else if (mode === 'count') label += ' -c'
  if (input.head_limit !== undefined) label += ` | head -${String(input.head_limit)}`
  if (input.glob) label += ` --include="${String(input.glob)}"`
  if (input.type) label += ` --type=${String(input.type)}`
  if (input.multiline) label += ' -P'
  if (input.pattern) label += ` "${String(input.pattern)}"`
  const path = text(input.path) ?? text(input.file_path)
  return path ? `${label} ${path}` : label
}

/** What a tool use shows: the adapter's title, kind, diff and locations for it. */
export function toolFacts(tool: string, raw: unknown, cwd: string | undefined): ToolFacts {
  const input = isRecord(raw) ? raw : {}
  switch (tool) {
    case 'Read': {
      const path = text(input.file_path)
      const offset = typeof input.offset === 'number' ? input.offset : undefined
      const limit = typeof input.limit === 'number' && input.limit > 0 ? input.limit : undefined
      const range = limit ? ` (${offset ?? 1} - ${(offset ?? 1) + limit - 1})` : offset ? ` (from line ${offset})` : ''
      return {
        title: `Read ${path ? displayPath(path, cwd) : 'File'}${range}`,
        kind: 'read',
        locations: path ? [{ path, line: Math.max(offset ?? 1, 1) }] : [],
      }
    }
    case 'Edit': {
      const path = text(input.file_path)
      const changed = path && (text(input.old_string) || text(input.new_string))
      return {
        title: path ? `Edit ${displayPath(path, cwd)}` : 'Edit',
        kind: 'edit',
        locations: path ? [{ path }] : [],
        ...(changed
          ? {
              content: [
                {
                  type: 'diff',
                  path,
                  oldText: text(input.old_string) ?? null,
                  newText: typeof input.new_string === 'string' ? input.new_string : '',
                },
              ],
            }
          : {}),
      }
    }
    case 'Write': {
      const write = writeInput(input)
      return {
        title: write.path ? `Write ${displayPath(write.path, cwd)}` : 'Preparing file…',
        kind: 'edit',
        locations: write.path ? [{ path: write.path }] : [],
        // The input does not say whether the file exists: shown as written, and replaced by the real diff once it ran.
        ...(write.path ? { content: [{ type: 'diff', path: write.path, oldText: null, newText: write.content ?? '' }] } : {}),
      }
    }
    case 'NotebookEdit':
      return { title: 'NotebookEdit', kind: 'other' }
    case 'Bash':
    case 'PowerShell': {
      const description = text(input.description) ?? text(input.command_description)
      return {
        title: text(input.command) ?? 'Terminal',
        kind: 'execute',
        ...(description ? { content: [textContent(description)] } : {}),
      }
    }
    case 'Glob': {
      let label = 'Find'
      if (input.path) label += ` \`${String(input.path)}\``
      if (input.pattern) label += ` \`${String(input.pattern)}\``
      const path = text(input.path)
      return { title: label, kind: 'search', locations: path ? [{ path }] : [] }
    }
    case 'Grep':
      return { title: grepTitle(input), kind: 'search' }
    case 'WebFetch': {
      const from = input.offset ? ` (from char ${String(input.offset)})` : ''
      const prompt = text(input.prompt)
      return {
        title: input.url ? `Fetch ${String(input.url)}${from}` : 'Fetch',
        kind: 'fetch',
        ...(prompt ? { content: [textContent(prompt)] } : {}),
      }
    }
    case 'WebSearch':
      return { title: input.query ? `Search "${String(input.query)}"` : 'Web search', kind: 'fetch' }
    case 'Agent':
    case 'Task':
      return { title: text(input.description) ?? text(input.subagent_type) ?? 'Task', kind: 'think' }
    case 'EnterPlanMode':
      return { title: 'Enter plan mode', kind: 'switch_mode' }
    case 'ExitPlanMode':
      return { title: 'Ready to code?', kind: 'switch_mode' }
    case 'AskUserQuestion':
      return { title: 'Ask the user', kind: 'other' }
    default:
      return { title: tool, kind: 'other' }
  }
}

/** The tools whose calls are the session's task list rather than rows of their own. */
export const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])

interface Task {
  subject: string
  status: string
  activeForm?: string
}
const TASK_STATUSES = new Set(['pending', 'in_progress', 'completed'])
export type TaskList = Map<string, Task>

export interface PlanEntry {
  content: string
  status: string
  priority: 'medium'
}

/** TodoWrite's whole list, as the adapter's `planEntries`. */
export function todoPlan(input: unknown): PlanEntry[] | undefined {
  const todos = isRecord(input) && Array.isArray(input.todos) ? input.todos : undefined
  if (!todos) return undefined
  return todos.flatMap(todo => {
    if (!isRecord(todo) || typeof todo.content !== 'string' || typeof todo.status !== 'string') return []
    const content = todo.status === 'in_progress' && typeof todo.activeForm === 'string' && todo.activeForm ? todo.activeForm : todo.content
    return [{ content: clip(content, 2000), status: todo.status, priority: 'medium' as const }]
  })
}

/** A Task* tool's output: the structured result, else JSON in its text. */
function structured(output: unknown, content: unknown): Record<string, unknown> | undefined {
  if (isRecord(output)) return output
  const texts =
    typeof content === 'string'
      ? [content]
      : Array.isArray(content)
        ? content.flatMap(item => (isRecord(item) && typeof item.text === 'string' ? [item.text] : []))
        : []
  for (const value of texts) {
    try {
      const parsed: unknown = JSON.parse(value)
      if (isRecord(parsed)) return parsed
    } catch {
      const created = /^Task #(\S+) created successfully: (.+)$/u.exec(value.trim())
      if (created) return { task: { id: created[1], subject: created[2] } }
    }
  }
  return undefined
}

/**
 * The task list after a Task* tool's result, as the adapter keeps it (`applyTaskCreate`, `applyTaskUpdate`,
 * `applyTaskList`): true when it changed, so the plan is sent again.
 */
export function applyTaskResult(list: TaskList, tool: string, input: unknown, output: unknown, content: unknown): boolean {
  const fields = isRecord(input) ? input : {}
  const read = structured(output, content)
  if (tool === 'TaskCreate') {
    const task = isRecord(read?.task) ? read.task : undefined
    if (!task || typeof task.id !== 'string') return false
    const subject = text(task.subject) ?? text(fields.subject)
    if (!subject) return false
    list.set(task.id, { subject, status: 'pending', ...(text(fields.activeForm) ? { activeForm: fields.activeForm as string } : {}) })
    return true
  }
  if (tool === 'TaskUpdate') {
    const id = text(fields.taskId)
    if (!id) return false
    if (read && typeof read.success === 'boolean' && (!read.success || read.taskId !== id)) return false
    if (fields.status === 'deleted') return list.delete(id)
    const existing = list.get(id)
    const subject = text(fields.subject) ?? existing?.subject
    if (!subject) return false
    const status = text(fields.status) ?? existing?.status ?? 'pending'
    const activeForm = text(fields.activeForm) ?? existing?.activeForm
    list.set(id, { subject, status, ...(activeForm ? { activeForm } : {}) })
    return true
  }
  if (tool === 'TaskList') {
    const tasks = Array.isArray(read?.tasks) ? read.tasks : undefined
    if (!tasks) return false
    const previous = new Map(list)
    list.clear()
    for (const task of tasks) {
      if (!isRecord(task) || typeof task.id !== 'string' || typeof task.subject !== 'string' || !TASK_STATUSES.has(String(task.status)))
        continue
      const activeForm = previous.get(task.id)?.activeForm
      list.set(task.id, { subject: task.subject, status: String(task.status), ...(activeForm ? { activeForm } : {}) })
    }
    return true
  }
  return false
}

export function taskPlan(list: TaskList): PlanEntry[] {
  return [...list.values()].map(task => ({
    content: clip(task.status === 'in_progress' && task.activeForm ? task.activeForm : task.subject, 2000),
    status: task.status,
    priority: 'medium',
  }))
}

/**
 * The real change of an Edit or a Write once it ran, from its structured result's `structuredPatch` (the adapter's
 * `toolUpdateFromDiffToolResponse`): one diff per hunk; an update with no hunk shows the whole file before and after.
 */
export function changeFromResult(output: unknown): { content: unknown[]; locations: Array<{ path: string; line?: number }> } | undefined {
  if (!isRecord(output) || typeof output.filePath !== 'string' || !Array.isArray(output.structuredPatch)) return undefined
  const path = output.filePath
  const content: unknown[] = []
  const locations: Array<{ path: string; line?: number }> = []
  for (const hunk of output.structuredPatch) {
    if (!isRecord(hunk) || !Array.isArray(hunk.lines)) continue
    const before: string[] = []
    const after: string[] = []
    for (const line of hunk.lines) {
      if (typeof line !== 'string' || line === '\\ No newline at end of file') continue
      if (line.startsWith('-')) before.push(line.slice(1))
      else if (line.startsWith('+')) after.push(line.slice(1))
      else {
        before.push(line.slice(1))
        after.push(line.slice(1))
      }
    }
    if (!before.length && !after.length) continue
    locations.push({ path, ...(typeof hunk.newStart === 'number' ? { line: hunk.newStart } : {}) })
    content.push({
      type: 'diff',
      path,
      oldText: before.length ? clip(before.join('\n'), TOOL_TEXT_LIMIT) : null,
      newText: clip(after.join('\n'), TOOL_TEXT_LIMIT),
    })
  }
  if (!content.length && output.type === 'update' && typeof output.content === 'string') {
    locations.push({ path })
    content.push(
      typeof output.originalFile === 'string'
        ? { type: 'diff', path, oldText: clip(output.originalFile, TOOL_TEXT_LIMIT), newText: clip(output.content, TOOL_TEXT_LIMIT) }
        : textContent(`Updated \`${path}\` (previous content too large to diff)`),
    )
  }
  return content.length ? { content, locations } : undefined
}

/** A tool result's text, whatever form the CLI wrote it in. */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap(item => (isRecord(item) && item.type === 'text' && typeof item.text === 'string' ? [item.text] : [])).join('\n')
}

/** Bash's own output from its structured result, without the model-directed notes the result text carries. */
export function shellOutput(output: unknown): string | undefined {
  if (!isRecord(output) || typeof output.stdout !== 'string' || typeof output.stderr !== 'string' || output.isImage) return undefined
  if (output.backgroundTaskId !== undefined) return undefined
  const said = [output.stdout, output.stderr].filter(Boolean).join('\n')
  return output.interrupted ? [said, '[Command was aborted before completion]'].filter(Boolean).join('\n') : said
}

// ---- AskUserQuestion, as the adapter's `elicitation.js` asks it ----------------------------------------------------

interface Question {
  question: string
  header?: string
  multiSelect?: boolean
  options: Array<{ label: string; description?: string }>
}

export function askedQuestions(input: unknown): Question[] | undefined {
  const questions = isRecord(input) && Array.isArray(input.questions) ? input.questions : undefined
  const valid = (questions ?? []).flatMap(item => {
    if (!isRecord(item) || typeof item.question !== 'string' || !Array.isArray(item.options) || !item.options.length) return []
    const options = item.options.flatMap(option =>
      isRecord(option) && typeof option.label === 'string'
        ? [{ label: option.label, ...(typeof option.description === 'string' ? { description: option.description } : {}) }]
        : [],
    )
    if (!options.length) return []
    return [
      {
        question: item.question,
        ...(typeof item.header === 'string' ? { header: item.header } : {}),
        multiSelect: item.multiSelect === true,
        options,
      },
    ]
  })
  return valid.length ? valid : undefined
}

/** The form: one field per question (`question_<n>`, its labels as the choices) and its free-text `question_<n>_custom`. */
export function questionForm(questions: Question[], sessionId: string, toolCallId: string): Record<string, unknown> {
  const single = questions.length === 1
  const properties: Record<string, unknown> = {}
  questions.forEach((question, index) => {
    const choices = question.options.map(option => ({
      const: option.label,
      title: option.label,
      ...(option.description ? { description: option.description } : {}),
    }))
    const title = question.header || undefined
    const description = single ? undefined : question.question
    properties[`question_${index}`] = question.multiSelect
      ? { type: 'array', title, description, items: { anyOf: choices } }
      : { type: 'string', title, description, oneOf: choices }
    properties[`question_${index}_custom`] = {
      type: 'string',
      title: 'Other',
      description: question.multiSelect
        ? 'Type your own answer to add to your selection above (optional).'
        : 'Type your own answer, or add a note to the option you chose above (optional).',
    }
  })
  return {
    mode: 'form',
    sessionId,
    toolCallId,
    message: single ? questions[0]!.question : 'Please answer the following questions.',
    requestedSchema: { type: 'object', properties },
  }
}

const joinPicks = (items: string[]) =>
  items.map(item => (item.includes(', ') || item.includes('"') ? JSON.stringify(item) : item)).join(', ')

/**
 * The tool's input with the answers (`answers[question] = label`, multi-select comma-joined, a note beside a pick as
 * `annotations[question].notes`), or undefined to abort the call: what the adapter's `applyAskElicitationResponse` does.
 */
export function answeredInput(answer: unknown, input: Record<string, unknown>, questions: Question[]): Record<string, unknown> | undefined {
  const action = isRecord(answer) ? answer.action : undefined
  if (action === 'decline') return { ...input, answers: {} }
  if (action !== 'accept') return undefined
  const content = isRecord(answer) && isRecord(answer.content) ? answer.content : {}
  const answers: Record<string, string> = {}
  const annotations: Record<string, { notes: string }> = {}
  questions.forEach((question, index) => {
    const custom = content[`question_${index}_custom`]
    const own = typeof custom === 'string' ? custom.trim() : ''
    const value = content[`question_${index}`]
    const picks = (Array.isArray(value) ? value : [value])
      .filter(item => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')
      .map(String)
      .filter(item => item !== '')
    if (question.multiSelect) {
      const joined = joinPicks(own ? [...picks, own] : picks)
      if (joined) answers[question.question] = joined
      return
    }
    const picked = picks.join(', ')
    if (!picked) {
      if (own) answers[question.question] = own
      return
    }
    answers[question.question] = picked
    if (own) annotations[question.question] = { notes: own }
  })
  return { ...input, answers, ...(Object.keys(annotations).length ? { annotations } : {}) }
}
