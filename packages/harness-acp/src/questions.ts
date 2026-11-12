/**
 * Questions an agent puts to the person, read into Latch's question form and answered in the agent's own shape: ACP's
 * standard `elicitation/create` (form mode), and Cursor's `cursor/ask_question` from any agent that sends it. Everything
 * here is untrusted and parsed tolerantly; a shape Latch cannot show is not asked.
 */
import { z } from 'zod'
import type { AgentQuestion, QuestionResult } from '@latch/protocol'

export const ELICITATION_METHOD = 'elicitation/create'
export const CURSOR_QUESTION_METHOD = 'cursor/ask_question'

const QUESTIONS = 10
const OPTIONS = 20
const text = z.string().max(4000)
/** The Host's limits for a question card: what is longer is refused at once, never cut and never silently dismissed. */
const PROMPT_LIMIT = 2000
const LABEL_LIMIT = 1000
const OPTION_LIMIT = 500

/** Whether the card fits the Host's limits as the agent wrote it. */
function fits(prompt: string, questions: AgentQuestion['questions']): boolean {
  return (
    prompt.length <= PROMPT_LIMIT
    && questions.every(item => item.label.length <= LABEL_LIMIT && item.options.every(option => option.label.length <= OPTION_LIMIT))
  )
}

/** The chosen options of one answer, by position: the ID the card gave (`o<n>`), or for an older Host the label. */
function chosenIndexes(answer: QuestionResult['answers'][number] | undefined, options: Array<{ label: string }>): number[] {
  if (!answer) return []
  if (answer.optionIds)
    return answer.optionIds.flatMap(id => {
      const at = /^o(\d{1,2})$/u.exec(id)
      const index = at ? Number(at[1]) : -1
      return index >= 0 && index < options.length ? [index] : []
    })
  return answer.choices.flatMap(label => {
    const at = options.findIndex(option => option.label === label)
    return at >= 0 ? [at] : []
  })
}

/** What the person is asked, and how to turn their answer (or none: they did not answer) into the agent's reply. */
export interface AgentAsk {
  /** The agent's own call ID, when it named one. */
  toolCallId?: string
  prompt: string
  questions: AgentQuestion['questions']
  reply(result: QuestionResult | undefined): unknown
}

const cursorQuestion = z.object({
  toolCallId: z.string().min(1).max(256),
  title: text.optional(),
  questions: z
    .array(
      z.object({
        id: z.string().max(256).optional(),
        prompt: text,
        allowMultiple: z.boolean().optional(),
        options: z
          .array(z.object({ id: z.string().max(256).optional(), label: text }))
          .max(OPTIONS)
          .optional(),
      }),
    )
    .min(1)
    .max(QUESTIONS),
})

/**
 * Cursor's question as it asks it, or undefined when the params do not read as one. `tooLong`: it reads, but is longer
 * than a card holds.
 */
export function cursorAsk(params: unknown): { parsed: z.infer<typeof cursorQuestion>; ask?: AgentAsk; tooLong?: true } | undefined {
  const parsed = cursorQuestion.safeParse(params)
  if (!parsed.success) return undefined
  const data = parsed.data
  // Cursor answers by ID: without one for every question and option, its answer cannot be written.
  const answerable = data.questions.every(item => item.id && (item.options ?? []).every(option => option.id))
  if (!answerable) return { parsed: data }
  const questions = data.questions.map((item, index) => ({
    id: `q${index}`,
    label: item.prompt.trim() || `问题 ${index + 1}`,
    multiple: item.allowMultiple === true,
    options: (item.options ?? []).map((option, at) => ({ id: `o${at}`, label: option.label.trim() || `选项 ${at + 1}` })),
  }))
  const prompt = data.title?.trim() || data.questions[0]!.prompt
  if (!fits(prompt, questions)) return { parsed: data, tooLong: true }
  return {
    parsed: data,
    ask: {
      toolCallId: data.toolCallId,
      prompt,
      questions,
      reply(result) {
        if (!result) return { outcome: { outcome: 'cancelled' } }
        const answers = data.questions.map((item, index) => {
          const answer = result.answers.find(entry => entry.questionId === `q${index}`)
          const chosen = chosenIndexes(answer, questions[index]!.options).map(at => item.options![at]!.id!)
          return { questionId: item.id!, selectedOptionIds: chosen, ...(answer?.other ? { other: answer.other } : {}) }
        })
        // Cursor takes option IDs only: words of the person's own go back as the reason it skipped, so they are not lost.
        const own = answers.filter(answer => 'other' in answer)
        if (own.length)
          return {
            outcome: {
              outcome: 'skipped',
              reason: `The user answered in their own words: ${own.map(answer => `${answer.questionId}: ${(answer as { other: string }).other}`).join('; ')}`,
            },
          }
        return { outcome: { outcome: 'answered', answers } }
      },
    },
  }
}

/** The note for a Cursor question Latch cannot put to the person: what it asked, so they can answer in their next message. */
export function cursorDeclineNote(parsed: z.infer<typeof cursorQuestion>, agentName: string): string {
  const lines = parsed.questions.map(item => {
    const choices = item.options?.map(option => option.label).join(' / ')
    return `- ${item.prompt}${choices ? `（${choices}）` : ''}`
  })
  return [
    `${agentName} 问${parsed.title ? `：${parsed.title}` : ''}`,
    ...lines,
    'Latch 不能在这里回答这个提问，已让它跳过；可以在下一条消息里直接回答。',
  ].join('\n')
}
export const CURSOR_DECLINE_REPLY = {
  outcome: { outcome: 'skipped', reason: 'The client cannot show this question; the user may answer in the next message.' },
}

const titled = z.object({ const: z.union([z.string(), z.number()]), title: text.optional() })
const property = z.object({
  type: z.string().max(32).optional(),
  title: text.optional(),
  description: text.optional(),
  enum: z
    .array(z.union([z.string(), z.number()]))
    .max(OPTIONS)
    .optional(),
  enumNames: z.array(text).max(OPTIONS).optional(),
  oneOf: z.array(titled).max(OPTIONS).optional(),
  anyOf: z.array(titled).max(OPTIONS).optional(),
  items: z
    .object({
      type: z.string().max(32).optional(),
      enum: z
        .array(z.union([z.string(), z.number()]))
        .max(OPTIONS)
        .optional(),
      anyOf: z.array(titled).max(OPTIONS).optional(),
      oneOf: z.array(titled).max(OPTIONS).optional(),
    })
    .optional(),
})
const elicitation = z.object({
  sessionId: z.string().max(256).optional(),
  toolCallId: z.string().min(1).max(256).optional(),
  mode: z.string().max(32),
  message: text,
  requestedSchema: z
    .object({
      type: z.literal('object').optional(),
      properties: z.record(z.string().max(256), property),
      required: z.array(z.string().max(256)).max(64).optional(),
    })
    .optional(),
})

type Choice = { value: string | number | boolean; label: string }
type Field = { key: string; kind: 'one' | 'many' | 'text' | 'number' | 'integer'; choices: Choice[] }

function field(key: string, raw: z.infer<typeof property>): Field | undefined {
  const fromTitled = (items: Array<z.infer<typeof titled>>) =>
    items.map(item => ({ value: item.const, label: item.title ?? String(item.const) }))
  if (raw.type === 'array') {
    const items = raw.items
    const choices = items?.enum
      ? items.enum.map(value => ({ value, label: String(value) }))
      : fromTitled(items?.anyOf ?? items?.oneOf ?? [])
    return choices.length ? { key, kind: 'many', choices } : undefined
  }
  if (raw.type === 'boolean')
    return {
      key,
      kind: 'one',
      choices: [
        { value: true, label: '是' },
        { value: false, label: '否' },
      ],
    }
  if (raw.enum?.length)
    return { key, kind: 'one', choices: raw.enum.map((value, at) => ({ value, label: raw.enumNames?.[at] ?? String(value) })) }
  if (raw.oneOf?.length || raw.anyOf?.length) return { key, kind: 'one', choices: fromTitled(raw.oneOf ?? raw.anyOf ?? []) }
  if (raw.type === 'string' || raw.type === undefined) return { key, kind: 'text', choices: [] }
  if (raw.type === 'number' || raw.type === 'integer') return { key, kind: raw.type, choices: [] }
  return undefined
}

/**
 * A form-mode elicitation as Latch can ask it: each field a question, its choices the options (yes or no for a boolean),
 * and a field of free text or a number answered in the person's own words (其他). Undefined: not form mode, or a field
 * Latch cannot ask; the agent is then told the params are invalid, as ACP says for a mode the client did not offer.
 */
export function elicitationAsk(params: unknown): AgentAsk | undefined {
  const parsed = elicitation.safeParse(params)
  if (!parsed.success || parsed.data.mode !== 'form') return undefined
  const entries = Object.entries(parsed.data.requestedSchema?.properties ?? {})
  if (entries.length > QUESTIONS) return undefined
  const fields: Field[] = []
  for (const [key, raw] of entries) {
    const read = field(key, raw)
    if (!read) return undefined
    fields.push(read)
  }
  const labels = new Map(entries)
  const questions = fields.map((item, index) => {
    const raw = labels.get(item.key)!
    return {
      id: `q${index}`,
      label: (raw.title ?? raw.description ?? item.key).trim() || item.key,
      multiple: item.kind === 'many',
      options: item.choices.map((choice, at) => ({ id: `o${at}`, label: choice.label.trim() || String(choice.value) })),
    }
  })
  // A form with no fields only asks for consent: one question, yes or no.
  const consent = fields.length === 0
  if (!fits(parsed.data.message, consent ? [{ id: 'q0', label: parsed.data.message, multiple: false, options: [] }] : questions))
    return undefined
  return {
    ...(parsed.data.toolCallId ? { toolCallId: parsed.data.toolCallId } : {}),
    prompt: parsed.data.message,
    questions: consent
      ? [
          {
            id: 'q0',
            label: parsed.data.message,
            multiple: false,
            options: [
              { id: 'o0', label: '同意' },
              { id: 'o1', label: '不同意' },
            ],
          },
        ]
      : questions,
    reply(result) {
      if (!result) return { action: 'cancel' }
      if (consent) {
        const [first] = chosenIndexes(result.answers[0], [{ label: '同意' }, { label: '不同意' }])
        return first === 0 ? { action: 'accept' } : { action: 'decline' }
      }
      const content: Record<string, unknown> = {}
      fields.forEach((item, index) => {
        const answer = result.answers.find(entry => entry.questionId === `q${index}`)
        if (!answer) return
        const chosen = chosenIndexes(answer, questions[index]!.options).map(at => item.choices[at]!.value)
        if (item.kind === 'many') content[item.key] = answer.other ? [...chosen, answer.other] : chosen
        else if (item.kind === 'number' || item.kind === 'integer') {
          const value = Number(answer.other)
          if (answer.other !== undefined && Number.isFinite(value) && (item.kind === 'number' || Number.isInteger(value)))
            content[item.key] = value
        } else if (chosen.length) content[item.key] = chosen[0]
        else if (answer.other !== undefined) content[item.key] = answer.other
      })
      return { action: 'accept', content }
    },
  }
}
