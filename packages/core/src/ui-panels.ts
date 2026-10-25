import { z } from 'zod'
import { isUiPanelDocument, type UiPanelDocument } from '@latch/protocol'
import { AppError, type ClientPanelDefinition, type UiPanelContext, type UiPanelDefinition } from '@latch/sdk'

const metadataSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u),
    title: z.string().trim().min(1).max(48),
    description: z.string().max(240).optional(),
    harnessIds: z
      .array(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u))
      .max(32)
      .optional(),
    listed: z.boolean().optional(),
  })
  .strict()
const documentSchema = z.custom<UiPanelDocument>(isUiPanelDocument)

/** Capture metadata and the callback so later writes to the plugin's declaration cannot change a published view. */
export function checkedUiPanel(input: UiPanelDefinition): UiPanelDefinition {
  const { render, ...metadata } = input
  if (typeof render !== 'function') throw new AppError(400, 'ui-panel-invalid', '扩展面板缺少读取方法。')
  return { ...metadataSchema.parse(metadata), render }
}

export function checkedClientPanel(input: ClientPanelDefinition): ClientPanelDefinition {
  const { source, ...metadata } = input
  if (typeof source !== 'string' || !source.trim() || source.length > 1_000_000) {
    throw new AppError(400, 'ui-panel-invalid', '界面模块必须是已经构建的 ESM 文件，且不超过 1 MB。')
  }
  return { ...metadataSchema.parse(metadata), source }
}

/** Validate data panels before they cross the wire, including their total size. */
export async function renderUiPanel(
  panel: UiPanelDefinition,
  context: UiPanelContext,
  log: (message: string, error: unknown) => void,
): Promise<UiPanelDocument> {
  context.signal.throwIfAborted()
  let output: unknown
  try {
    output = await panel.render({ session: structuredClone(context.session), signal: context.signal })
  } catch (error) {
    if (context.signal.aborted) throw new AppError(499, 'ui-panel-cancelled', '已取消读取扩展面板。')
    log('UI panel read failed', error)
    throw new AppError(502, 'ui-panel-failed', '扩展面板暂时无法读取，请稍后重试。')
  }
  context.signal.throwIfAborted()
  try {
    const serialized = JSON.stringify(output)
    if (serialized === undefined || serialized.length > 65_536) throw new Error('Panel document too large')
    return documentSchema.parse(JSON.parse(serialized))
  } catch {
    throw new AppError(502, 'ui-panel-invalid', '扩展面板返回了不支持的内容。')
  }
}
