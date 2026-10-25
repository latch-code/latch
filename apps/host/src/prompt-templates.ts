import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { PromptTemplate } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { sha256Hex, writeFileAtomic } from '@latch/core/node-kit'
export const templateSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
  name: z.string().trim().min(1).max(80),
  content: z
    .string()
    .min(1)
    .max(20_000)
    .refine(value => value.trim().length > 0),
  scope: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('all') }),
    z.strictObject({ kind: z.literal('project'), id: z.string().min(1).max(128) }),
    z.strictObject({ kind: z.literal('agent'), id: z.string().min(1).max(128) }),
  ]),
})
const fileSchema = z.strictObject({ version: z.literal(1), templates: z.array(templateSchema).max(200) })
/** Stable IDs and PUT replacement make an unknown-result retry idempotent. Memory changes only after atomic persistence. */
export class PromptTemplateStore {
  private tail: Promise<unknown> = Promise.resolve()
  private constructor(
    private readonly path: string,
    private templates: PromptTemplate[],
  ) {}
  static async open(directory: string): Promise<PromptTemplateStore> {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, 'prompt-templates.json')
    try {
      const data = fileSchema.parse(JSON.parse(await readFile(path, 'utf8')))
      return new PromptTemplateStore(path, data.templates)
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return new PromptTemplateStore(path, [])
      throw new AppError(500, 'prompt-templates-invalid', '提示模板文件无法读取，请在执行端电脑检查。')
    }
  }
  revision(): string {
    return sha256Hex(JSON.stringify(this.templates))
  }
  list(): PromptTemplate[] {
    return structuredClone(this.templates)
  }
  put(value: PromptTemplate, authorize: () => void = () => {}): Promise<void> {
    const input = templateSchema.parse(value)
    return this.change(templates => {
      const index = templates.findIndex(template => template.id === input.id)
      if (index < 0) {
        if (templates.length === 200) throw new AppError(409, 'prompt-template-limit', '最多保存 200 个提示模板。')
        templates.push(input)
      } else templates[index] = input
    }, authorize)
  }
  remove(id: string, authorize: () => void = () => {}): Promise<void> {
    return this.change(templates => {
      const index = templates.findIndex(template => template.id === id)
      if (index >= 0) templates.splice(index, 1)
    }, authorize)
  }
  private change(mutate: (templates: PromptTemplate[]) => void, authorize: () => void): Promise<void> {
    const operation = this.tail
      .catch(() => {})
      .then(async () => {
        const next = this.list()
        mutate(next)
        authorize()
        if (JSON.stringify(next) === JSON.stringify(this.templates)) return
        await writeFileAtomic(this.path, `${JSON.stringify({ version: 1, templates: next })}\n`, { prefix: 'prompt-templates.' })
        this.templates = next
      })
    this.tail = operation
    return operation
  }
}
