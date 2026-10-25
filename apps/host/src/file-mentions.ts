import { z } from 'zod'
import { isFileMention, type FileMention } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { ProtectedPaths, resolveRecorded, type FileRoot } from './files/resolve.ts'
import { searchFiles } from './files/search.ts'
export const fileMentionsSchema = z.array(z.custom<FileMention>(isFileMention)).max(32).optional()
export const projectSearchSchema = z.strictObject({
  q: z.string().max(512),
  harnessId: z.string().min(1).max(128),
  limit: z.number().int().min(1).max(100).default(100),
})
export async function checkedFileMentions(
  refs: FileMention[] | undefined,
  roots: readonly FileRoot[],
  paths: readonly string[],
  home: string,
): Promise<FileMention[]> {
  if (!refs?.length) return []
  if (refs.length > 32 || new Set(refs.map(ref => JSON.stringify(ref))).size !== refs.length)
    throw new AppError(400, 'file-reference-invalid', '每条消息最多引用 32 个不同文件。')
  const guard = new ProtectedPaths(paths),
    result: FileMention[] = []
  for (const ref of refs) {
    if (!isFileMention(ref)) throw new AppError(400, 'file-reference-invalid', '文件引用无效。')
    const resolved = await resolveRecorded(ref.root, ref.path, { roots, protectedPaths: guard, home })
    if (resolved.status !== 'ok' || resolved.file.secret)
      throw new AppError(403, 'file-reference-refused', '引用文件已不存在、不在当前会话文件夹内，或可能包含密钥。请重新选择。')
    result.push({ root: resolved.file.rootId, path: resolved.file.relativePath })
  }
  return result
}
export async function searchProjectFiles(
  roots: readonly FileRoot[],
  paths: readonly string[],
  q: string,
  limit: number,
  cancelled: () => boolean,
) {
  const guard = new ProtectedPaths(paths),
    result = await searchFiles(roots, guard, q, limit, cancelled),
    files = []
  for (const item of result.files) {
    if (cancelled()) break
    const resolved = await resolveRecorded(item.root, item.path, { roots, protectedPaths: guard, home: '' })
    if (resolved.status === 'ok' && !resolved.file.secret) files.push(item)
  }
  return { files, truncated: result.truncated }
}
