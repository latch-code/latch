import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { AgentQuestion, QuestionReceipt, QuestionResult, TaskDetail } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { canonicalJson, sha256Hex, writeFileAtomic } from '@latch/core/node-kit'

const key = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/u)
const id = z.string().min(1).max(256)
const optionSchema = z.strictObject({ id: key, label: z.string().trim().min(1).max(500), description: z.string().max(500).optional() })
const questionSchema = z.strictObject({
  id: key,
  label: z.string().trim().min(1).max(1000),
  multiple: z.boolean().default(false),
  // None: a question answered only in the person's own words (an agent's free-text field).
  options: z.array(optionSchema).max(20),
})
const inputSchema = z.strictObject({ prompt: z.string().trim().min(1).max(2000), questions: z.array(questionSchema).min(1).max(10) })
export const questionSubmissionSchema = z.strictObject({
  requestId: z.string().uuid(),
  answers: z
    .array(z.strictObject({ questionId: key, optionIds: z.array(key).max(20), other: z.string().trim().min(1).max(2000).optional() }))
    .min(1)
    .max(10),
})
const recordSchema = z.strictObject({
  id,
  sessionId: id,
  toolCallId: id,
  state: z.enum(['pending', 'answering', 'answered', 'closed']),
  input: inputSchema.optional(),
  deviceId: id.optional(),
  requestId: z.string().uuid().optional(),
  hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  result: z.string().max(100_000).optional(),
})
// Each record is read on its own: one that cannot be read is skipped, never a reason the Host cannot start.
const fileSchema = z.strictObject({ version: z.literal(1), items: z.array(z.unknown()).max(100_000) })
type Record = z.infer<typeof recordSchema>
interface Flight {
  signal: AbortSignal
  resolve(value: { text: string }): void
  reject(error: Error): void
  cleanup(): void
}
interface ReceiptFlight {
  promise: Promise<QuestionReceipt>
  resolve(value: QuestionReceipt): void
  reject(error: Error): void
}
export interface QuestionsOptions {
  dataDir: string
  changed(sessionId: string): void
  detail(sessionId: string): Promise<TaskDetail>
  /** The Host log: only counts and fixed words, never a record's content. */
  log?: (text: string) => void
}

/** A durable answer is acknowledged only after the runtime commits the corresponding tool result. */
export class Questions {
  private active: Record[]
  private serial: Promise<void> = Promise.resolve()
  private readonly flights = new Map<string, Flight>()
  private readonly receipts = new Map<string, ReceiptFlight>()
  private stopped = false
  private constructor(
    private readonly options: QuestionsOptions,
    private items: Map<string, Record>,
  ) {
    this.active = [...items.values()].filter(item => item.state === 'pending' || item.state === 'answering')
  }

  static async open(options: QuestionsOptions): Promise<Questions> {
    let items: Record[] = []
    const path = join(options.dataDir, 'questions.json')
    try {
      if ((await stat(path)).size > 128 * 1024 * 1024) throw new Error('question file too large')
      const seen = new Set<string>()
      let skipped = 0
      for (const raw of fileSchema.parse(JSON.parse(await readFile(path, 'utf8'))).items) {
        const read = recordSchema.safeParse(raw)
        if (!read.success || seen.has(read.data.id)) {
          skipped++
          continue
        }
        seen.add(read.data.id)
        items.push(read.data)
      }
      if (skipped) options.log?.(`问答记录中有 ${skipped} 条无法读取，已跳过`)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
        throw new AppError(500, 'questions-corrupt', '问答记录无法读取，原文件已保留；修复后再启动 Host')
    }
    return new Questions(options, new Map(items.map(item => [item.id, item])))
  }

  async reconcile(detail: (sessionId: string) => Promise<TaskDetail>): Promise<void> {
    await this.lock(async () => {
      const next = new Map(this.items)
      for (const item of next.values()) {
        if (item.state !== 'pending' && item.state !== 'answering') continue
        let committed = false
        if (item.state === 'answering' && item.result) {
          const message = await detail(item.sessionId)
            .then(value => value.messages.find(message => message.id === `tool:${item.toolCallId}`))
            .catch(() => undefined)
          committed = message?.state === 'completed' && message.tool?.output === item.result
        }
        next.set(item.id, { ...item, state: committed ? 'answered' : 'closed', input: undefined, result: undefined })
      }
      await this.commit(next)
    })
  }

  view(sessionId: string): AgentQuestion[] {
    return this.active
      .filter(item => item.sessionId === sessionId && item.input && (item.state === 'pending' || item.state === 'answering'))
      .map(item => ({
        id: item.id,
        toolCallId: item.toolCallId,
        state: item.state as AgentQuestion['state'],
        ...structuredClone(item.input!),
      }))
  }

  async ask(args: unknown, context: { sessionId: string; callId: string; signal: AbortSignal }): Promise<{ text: string }> {
    const input = inputSchema.parse(args)
    // What the record keeps must read back: a call ID it could not store would make the file unreadable.
    if (!id.safeParse(context.callId).success || !id.safeParse(context.sessionId).success)
      throw new AppError(400, 'question-invalid', '提问的调用标识过长')
    if (
      JSON.stringify(input).length > 32_000
      || new Set(input.questions.map(question => question.id)).size !== input.questions.length
      || input.questions.some(question => new Set(question.options.map(option => option.id)).size !== question.options.length)
    )
      throw new AppError(400, 'question-invalid', '问题过长或包含重复标识')
    const questionId = `question-${randomUUID()}`
    let resolve!: Flight['resolve'], reject!: Flight['reject']
    const result = new Promise<{ text: string }>((yes, no) => {
      resolve = yes
      reject = no
    })
    // An abort can win while the publication is still waiting for disk I/O.
    void result.catch(() => undefined)
    const abort = () => {
      reject(new AppError(409, 'question-closed', '本次提问已结束'))
      void this.withdraw(questionId).catch(() => undefined)
    }
    const flight: Flight = { signal: context.signal, resolve, reject, cleanup: () => context.signal.removeEventListener('abort', abort) }
    this.flights.set(questionId, flight)
    context.signal.addEventListener('abort', abort, { once: true })
    try {
      await this.lock(async () => {
        context.signal.throwIfAborted()
        if (this.stopped) throw new AppError(503, 'host-closing', 'Host 正在停止')
        if (this.items.size >= 100_000 || this.flights.size > 128)
          throw new AppError(409, 'questions-full', '问答记录已满，请删除不需要的旧会话后重试')
        const next = new Map(this.items)
        next.set(questionId, { id: questionId, sessionId: context.sessionId, toolCallId: context.callId, input, state: 'pending' })
        await this.commit(next)
        context.signal.throwIfAborted()
        this.options.changed(context.sessionId)
      })
      return await result
    } catch (error) {
      flight.cleanup()
      this.flights.delete(questionId)
      await this.withdraw(questionId)
      throw error
    }
  }

  async answer(
    sessionId: string,
    questionId: string,
    deviceId: string,
    raw: unknown,
    authorize: () => Promise<void>,
    audit: () => Promise<void>,
  ): Promise<QuestionReceipt> {
    const input = questionSubmissionSchema.parse(raw)
    const hash = sha256Hex(canonicalJson(input.answers))
    const prepared = await this.lock(async (): Promise<{ wait: Promise<QuestionReceipt> }> => {
      await authorize()
      const item = this.items.get(questionId)
      if (!item || item.sessionId !== sessionId) throw new AppError(404, 'question-not-found', '该问题不存在')
      if (item.requestId) {
        if (item.deviceId !== deviceId || item.requestId !== input.requestId)
          throw new AppError(409, 'question-answered', '该问题已由另一份回答接收')
        if (item.hash !== hash) throw new AppError(409, 'request-conflict', '同一次回答不能提交不同内容')
        if (item.state === 'answered') return { wait: Promise.resolve(this.receipt(item)) }
        const prior = this.receipts.get(questionId)
        if (item.state === 'answering' && prior) return { wait: prior.promise }
        if (item.state === 'answering' && item.result) {
          const message = (await this.options.detail(sessionId)).messages.find(message => message.id === `tool:${item.toolCallId}`)
          if (message?.state === 'completed' && message.tool?.output === item.result) {
            const next = new Map(this.items)
            next.set(questionId, { ...item, state: 'answered', input: undefined, result: undefined })
            await this.commit(next)
            return { wait: Promise.resolve(this.receipt(item)) }
          }
        }
        throw new AppError(409, 'question-closed', '本次提问已结束，请查看会话结果')
      }
      const producer = this.flights.get(questionId)
      if (this.stopped || item.state !== 'pending' || !item.input || !producer || producer.signal.aborted)
        throw new AppError(409, 'question-closed', '本次提问已结束')
      const answers = new Map(input.answers.map(answer => [answer.questionId, answer]))
      if (answers.size !== item.input.questions.length || answers.size !== input.answers.length)
        throw new AppError(400, 'question-invalid', '请回答每一道问题')
      const value: QuestionResult = {
        kind: 'latch.question-result',
        requestId: input.requestId,
        answers: item.input.questions.map(question => {
          const answer = answers.get(question.id)
          if (
            !answer
            || new Set(answer.optionIds).size !== answer.optionIds.length
            || (!question.multiple && answer.optionIds.length + (answer.other ? 1 : 0) > 1)
            || answer.optionIds.length + (answer.other ? 1 : 0) === 0
            || answer.optionIds.some(id => !question.options.some(option => option.id === id))
          )
            throw new AppError(400, 'question-invalid', '请选择有效选项；选择其他时请填写内容')
          return {
            questionId: question.id,
            label: question.label,
            optionIds: [...answer.optionIds],
            choices: answer.optionIds.map(id => question.options.find(option => option.id === id)!.label),
            ...(answer.other ? { other: answer.other } : {}),
          }
        }),
      }
      await audit()
      await authorize()
      if (producer.signal.aborted) throw new AppError(409, 'question-closed', '本次提问已结束')
      const result = JSON.stringify(value)
      const next = new Map(this.items)
      next.set(questionId, { ...item, state: 'answering', deviceId, requestId: input.requestId, hash, result })
      await this.commit(next)
      try {
        await authorize()
        if (producer.signal.aborted) throw new AppError(409, 'question-closed', '本次提问已结束')
      } catch (error) {
        const rollback = new Map(this.items)
        rollback.set(questionId, item)
        await this.commit(rollback)
        throw error
      }
      let settle!: ReceiptFlight['resolve'], fail!: ReceiptFlight['reject']
      const wait = new Promise<QuestionReceipt>((yes, no) => {
        settle = yes
        fail = no
      })
      void wait.catch(() => undefined)
      this.receipts.set(questionId, { promise: wait, resolve: settle, reject: fail })
      producer.resolve({ text: result })
      this.options.changed(sessionId)
      return { wait }
    })
    return prepared.wait
  }

  async resultCommitted(context: { sessionId: string; callId: string; state: 'completed' | 'failed' | 'cancelled' }): Promise<void> {
    await this.lock(async () => {
      const item = [...this.items.values()].find(
        item =>
          item.sessionId === context.sessionId
          && item.toolCallId === context.callId
          && (item.state === 'answering' || item.state === 'pending'),
      )
      if (!item) return
      const next = new Map(this.items)
      const finished: Record = {
        ...item,
        state: context.state === 'completed' && item.requestId ? 'answered' : 'closed',
        input: undefined,
        result: undefined,
      }
      next.set(item.id, finished)
      try {
        await this.commit(next)
        const receipt = this.receipts.get(item.id)
        if (finished.state === 'answered') receipt?.resolve(this.receipt(finished))
        else receipt?.reject(new AppError(409, 'question-closed', '本次提问已结束'))
      } catch {
        // The tool result is already durable. A retry or startup reconciliation can confirm it without replaying input.
        this.receipts.get(item.id)?.reject(new AppError(503, 'question-result-unknown', '回答结果尚未确认，请重试这次提交'))
      }
      this.flights.get(item.id)?.cleanup()
      this.flights.delete(item.id)
      this.receipts.delete(item.id)
      this.options.changed(context.sessionId)
    })
  }

  /**
   * The driver could not make the answered row durable: the answer stays in flight and the device that gave it is told
   * the result is unknown, so its retry, or the next start's reconciliation, decides.
   */
  async resultUnknown(context: { sessionId: string; callId: string }): Promise<void> {
    await this.lock(async () => {
      const item = [...this.items.values()].find(
        item => item.sessionId === context.sessionId && item.toolCallId === context.callId && item.state === 'answering',
      )
      if (!item) return
      this.receipts.get(item.id)?.reject(new AppError(503, 'question-result-unknown', '回答结果尚未确认，请重试这次提交'))
      this.receipts.delete(item.id)
      this.flights.get(item.id)?.cleanup()
      this.flights.delete(item.id)
    })
  }

  async forgetSession(sessionId: string): Promise<void> {
    await this.lock(async () => {
      const next = new Map(this.items)
      for (const item of next.values()) if (item.sessionId === sessionId) next.delete(item.id)
      await this.commit(next)
    })
  }

  async close(): Promise<void> {
    this.stopped = true
    for (const [id, flight] of this.flights) {
      flight.cleanup()
      flight.reject(new AppError(503, 'host-closing', 'Host 正在停止'))
      await this.withdraw(id, true)
    }
    this.flights.clear()
  }

  private receipt(item: Record): QuestionReceipt {
    return { answered: true, questionId: item.id, requestId: item.requestId! }
  }
  private withdraw(id: string, force = false): Promise<void> {
    return this.lock(async () => {
      const item = this.items.get(id)
      if (!item || item.state === 'answered' || item.state === 'closed') return
      // Once handed to the tool, its durable completion decides the receipt even if cancellation races it.
      if (item.state === 'answering' && !force) return
      const next = new Map(this.items)
      next.set(id, { ...item, state: 'closed', input: undefined, result: undefined })
      await this.commit(next)
      this.receipts.get(id)?.reject(new AppError(409, 'question-closed', '本次提问已结束'))
      this.receipts.delete(id)
      this.flights.get(id)?.cleanup()
      this.flights.delete(id)
      this.options.changed(item.sessionId)
    })
  }
  private async commit(items: Map<string, Record>): Promise<void> {
    await writeFileAtomic(join(this.options.dataDir, 'questions.json'), JSON.stringify({ version: 1, items: [...items.values()] }))
    this.items = items
    this.active = [...items.values()].filter(item => item.state === 'pending' || item.state === 'answering')
  }
  private lock<T>(operation: () => Promise<T>): Promise<T> {
    const flight = this.serial.then(operation)
    this.serial = flight.then(
      () => undefined,
      () => undefined,
    )
    return flight
  }
}
