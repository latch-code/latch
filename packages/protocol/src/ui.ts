/** Session panels contributed by enabled packages. Source code is fetched separately after authentication. */
export interface UiPanelInfo {
  id: string
  pluginId: string
  pluginName: string
  title: string
  description?: string
  /** Absent means every harness. An empty list contributes to no sessions. */
  harnessIds?: string[]
  /** Absent means a data panel. Modules are trusted client code, identified by their immutable source digest. */
  moduleHash?: string
}

export interface SkillInfo {
  id: string
  pluginId: string
  pluginName: string
  name: string
  description: string
}

export type UiPanelBlock =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string; language?: string }
  | { type: 'list'; items: string[] }
  | { type: 'facts'; items: Array<{ label: string; value: string }> }
  | { type: 'table'; columns: string[]; rows: string[][] }

export interface UiPanelDocument {
  blocks: UiPanelBlock[]
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function text(value: unknown, max = 16_000): value is string {
  return typeof value === 'string' && value.length <= max
}

function strings(value: unknown, max: number, length = 2000): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every(item => text(item, length))
}

function block(value: unknown): value is UiPanelBlock {
  if (!record(value)) return false
  switch (value.type) {
    case 'text':
      return keys(value, ['type', 'text']) && text(value.text)
    case 'code':
      return (
        keys(value, ['type', 'text', 'language']) && text(value.text, 32_000) && (value.language === undefined || text(value.language, 40))
      )
    case 'list':
      return keys(value, ['type', 'items']) && strings(value.items, 100)
    case 'facts':
      return (
        keys(value, ['type', 'items'])
        && Array.isArray(value.items)
        && value.items.length <= 100
        && value.items.every(item => record(item) && keys(item, ['label', 'value']) && text(item.label, 100) && text(item.value, 4000))
      )
    case 'table': {
      if (!keys(value, ['type', 'columns', 'rows']) || !strings(value.columns, 12, 100) || value.columns.length === 0) return false
      const columns = value.columns.length
      return (
        Array.isArray(value.rows) && value.rows.length <= 100 && value.rows.every(row => strings(row, columns) && row.length === columns)
      )
    }
    default:
      return false
  }
}

/** Data panels share a finite vocabulary; executable nodes and style records are not accepted. */
export function isUiPanelDocument(value: unknown): value is UiPanelDocument {
  return (
    record(value)
    && keys(value, ['blocks'])
    && Array.isArray(value.blocks)
    && value.blocks.length <= 32
    && value.blocks.every(block)
    && JSON.stringify(value).length <= 65_536
  )
}
