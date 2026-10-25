import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { AppError } from '@latch/sdk'
import { writeFileAtomic } from '@latch/core/node-kit'

const path = z
  .string()
  .min(1)
  .max(4096)
  .refine(value => isAbsolute(value) && !value.includes('\0'))
const contextSchema = z
  .object({
    version: z.literal(1),
    workspaceRoot: path,
    agentsDir: path,
    codeRoot: path,
    tlsKeyPath: path.optional(),
  })
  .strict()

export type ProjectCheckContext = Omit<z.infer<typeof contextSchema>, 'version'>
const FILE = 'project-context.json'

/** The last successful Host's actual startup paths, so offline folder checks do not infer flags from the CLI cwd. */
export async function writeProjectContext(dataDir: string, context: ProjectCheckContext): Promise<void> {
  const record = contextSchema.parse({ version: 1, ...context })
  await writeFileAtomic(join(dataDir, FILE), `${JSON.stringify(record)}\n`)
}

export async function readProjectContext(dataDir: string): Promise<ProjectCheckContext | undefined> {
  let text: string
  try {
    text = await readFile(join(dataDir, FILE), 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw new AppError(500, 'config-corrupt', '无法读取项目校验上下文，请用原启动参数成功启动 Host 后再试。')
  }
  try {
    const { version: _version, ...context } = contextSchema.parse(JSON.parse(text))
    return context
  } catch {
    throw new AppError(500, 'config-corrupt', '项目校验上下文无效，请用原启动参数成功启动 Host 后再试。')
  }
}
