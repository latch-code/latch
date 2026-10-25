import type { IncomingMessage, ServerResponse } from 'node:http'
import { sep } from 'node:path'
import { AppError } from '@latch/sdk'

export const KIB = 1024

export async function jsonBody(req: IncomingMessage, limit = 32 * KIB): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError(415, 'content-type', '请使用 JSON 请求')
  let bytes = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > limit) throw new AppError(413, 'body-too-large', '请求内容过长')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new AppError(400, 'invalid-json', '请求不是有效的 JSON')
  }
}

/** Like `jsonBody`, but an empty body (or none) reads as `{}`. */
export async function optionalJsonBody(req: IncomingMessage, limit = 32 * KIB): Promise<unknown> {
  const length = req.headers['content-length']
  if (!req.headers['content-type'] && (length === undefined || length === '0')) {
    for await (const _chunk of req) throw new AppError(415, 'content-type', '请使用 JSON 请求')
    return {}
  }
  return jsonBody(req, limit)
}

/** Returns the body's size in bytes. */
export function json(res: ServerResponse, value: unknown, status = 200): number {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
  return Buffer.byteLength(body)
}

export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new AppError(400, 'invalid-path', '请求路径编码无效')
  }
}

export function isWithin(path: string, parent: string): boolean {
  return path === parent || path.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/** Either path contains the other. */
export function overlaps(a: string, b: string): boolean {
  return isWithin(a, b) || isWithin(b, a)
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function codeOf(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

export const UI_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; frame-src 'self' blob:; object-src 'none'; require-trusted-types-for 'script'; trusted-types latch-runtime; frame-ancestors 'none'; base-uri 'none'"
