import type { ReactNode } from 'react'
import type { FileMetadata } from '@latch/protocol'
import type { PreviewQuote } from './quote.ts'
export type OfficeKind = 'pptx' | 'docx' | 'xlsx'
export type FrameKind = OfficeKind | 'mermaid' | 'html' | 'html-script'
export interface GridCell {
  text: string
  formula?: string
  numeric?: true
}
export interface SheetInfo {
  id: number
  name: string
  rows: number
  cols: number
  hidden: boolean
  merges: Array<[number, number, number, number]>
  colWidths: number[]
  frozen: { rows: number; cols: number }
}
export type FrameCommand =
  | { type: 'quote'; id: string; source: 'selection' | 'page' }
  | { type: 'sheet-page'; sheet: number; start: number; count: number }
  | { type: 'page'; index: number }
  | { type: 'fit'; value: boolean }
  | { type: 'zoom'; percent: number }
export type FrameEvent =
  | { type: 'quote'; id: string; text: string; page?: number }
  | { type: 'initialized' }
  | { type: 'view'; fit: boolean; zoomPercent: number }
  | { type: 'diagram'; svg: string }
  | { type: 'html'; blocked: number }
  | { type: 'rendered'; kind: OfficeKind; sheets?: SheetInfo[]; truncated?: boolean }
  | { type: 'error'; code: 'invalid-file' | 'file-too-large' | 'zip-refused' | 'document-too-complex' | 'render-failed' }
  | { type: 'page'; index: number; count: number }
  | { type: 'sheet-page'; sheet: number; start: number; rows: GridCell[][]; truncated?: boolean }
  | { type: 'link'; href: string }
export interface FrameOrigin {
  versionKey: string
  data: ArrayBuffer
}
export interface FrameInput {
  kind: FrameKind
  data: ArrayBuffer
  versionKey: string
  options?: Record<string, unknown>
  onMessage?: (data: unknown, origin: FrameOrigin) => void
  onChannel?: (send: ((message: FrameCommand) => void) | undefined) => void
}
export interface DocumentPreviewProps {
  onQuote?(value: PreviewQuote): void
  file: FileMetadata
  versionKey: string
  read: (start?: number, end?: number, signal?: AbortSignal) => Promise<ArrayBuffer>
  renderFrame: (input: FrameInput) => ReactNode
}
const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const integer = (value: unknown, max: number) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key))
export function isFrameCommand(value: unknown): value is FrameCommand {
  if (!plain(value)) return false
  if (value.type === 'quote')
    return (
      keys(value, ['type', 'id', 'source'])
      && typeof value.id === 'string'
      && /^[a-f0-9]{32}$/u.test(value.id)
      && (value.source === 'selection' || value.source === 'page')
    )
  if (value.type === 'sheet-page')
    return (
      keys(value, ['type', 'sheet', 'start', 'count'])
      && integer(value.sheet, 99)
      && integer(value.start, 999_999)
      && integer(value.count, 1000)
      && Number(value.count) > 0
    )
  if (value.type === 'zoom') return keys(value, ['type', 'percent']) && integer(value.percent, 400) && Number(value.percent) >= 10
  if (value.type === 'page') return keys(value, ['type', 'index']) && integer(value.index, 9999)
  return value.type === 'fit' && keys(value, ['type', 'value']) && typeof value.value === 'boolean'
}
export function isFrameEvent(value: unknown): value is FrameEvent {
  if (!plain(value)) return false
  switch (value.type) {
    case 'quote':
      return (
        keys(value, ['type', 'id', 'text', 'page'])
        && typeof value.id === 'string'
        && /^[a-f0-9]{32}$/u.test(value.id)
        && typeof value.text === 'string'
        && value.text.length <= 2000
        && (value.page === undefined || integer(value.page, 9999))
      )
    case 'html':
      return keys(value, ['type', 'blocked']) && integer(value.blocked, 100_000)
    case 'diagram':
      return keys(value, ['type', 'svg']) && typeof value.svg === 'string' && value.svg.length <= 2_000_000
    case 'view':
      return (
        keys(value, ['type', 'fit', 'zoomPercent'])
        && typeof value.fit === 'boolean'
        && integer(value.zoomPercent, 400)
        && Number(value.zoomPercent) >= 10
      )
    case 'initialized':
      return keys(value, ['type'])
    case 'error':
      return (
        keys(value, ['type', 'code'])
        && ['invalid-file', 'file-too-large', 'zip-refused', 'document-too-complex', 'render-failed'].includes(String(value.code))
      )
    case 'page':
      return (
        keys(value, ['type', 'index', 'count'])
        && integer(value.index, 9999)
        && integer(value.count, 10_000)
        && Number(value.count) > 0
        && Number(value.index) < Number(value.count)
      )
    case 'link':
      return (
        keys(value, ['type', 'href']) && typeof value.href === 'string' && value.href.length <= 4096 && /^https?:\/\//u.test(value.href)
      )
    case 'rendered':
      return (
        keys(value, ['type', 'kind', 'sheets', 'truncated'])
        && ['pptx', 'docx', 'xlsx'].includes(String(value.kind))
        && (value.truncated === undefined || typeof value.truncated === 'boolean')
        && (value.sheets === undefined
          || (Array.isArray(value.sheets)
            && value.sheets.length <= 100
            && value.sheets.every(
              sheet =>
                plain(sheet)
                && keys(sheet, ['id', 'name', 'rows', 'cols', 'hidden', 'merges', 'colWidths', 'frozen'])
                && integer(sheet.id, 99)
                && typeof sheet.name === 'string'
                && sheet.name.length <= 200
                && integer(sheet.rows, 1_000_000)
                && integer(sheet.cols, 200)
                && typeof sheet.hidden === 'boolean'
                && Array.isArray(sheet.merges)
                && sheet.merges.length <= 2000
                && sheet.merges.every(
                  merge =>
                    Array.isArray(merge) && merge.length === 4 && merge.every((item, i) => integer(item, i % 2 === 0 ? 999_999 : 199)),
                )
                && Array.isArray(sheet.colWidths)
                && sheet.colWidths.length <= 200
                && sheet.colWidths.every(width => typeof width === 'number' && Number.isFinite(width) && width >= 16 && width <= 1000)
                && plain(sheet.frozen)
                && keys(sheet.frozen, ['rows', 'cols'])
                && integer(sheet.frozen.rows, 1000)
                && integer(sheet.frozen.cols, 200),
            )))
      )
    case 'sheet-page': {
      if (
        !keys(value, ['type', 'sheet', 'start', 'rows', 'truncated'])
        || !integer(value.sheet, 99)
        || !integer(value.start, 999_999)
        || !Array.isArray(value.rows)
        || value.rows.length > 1000
        || (value.truncated !== undefined && typeof value.truncated !== 'boolean')
      )
        return false
      let chars = 0
      return value.rows.every(
        row =>
          Array.isArray(row)
          && row.length <= 200
          && row.every(
            cell =>
              plain(cell)
              && keys(cell, ['text', 'formula', 'numeric'])
              && typeof cell.text === 'string'
              && cell.text.length <= 32767
              && (chars += cell.text.length) <= 1_000_000
              && (cell.formula === undefined
                || (typeof cell.formula === 'string' && cell.formula.length <= 8192 && (chars += cell.formula.length) <= 1_000_000))
              && (cell.numeric === undefined || cell.numeric === true),
          ),
      )
    }
    default:
      return false
  }
}
