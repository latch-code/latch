// Development servers on this computer that a terminal's output announces, such as Vite's
// `➜  Local:   http://localhost:5173/`, for 「打开预览 localhost:5173」 and the browser's 「本地服务」. Only what the
// output said: nothing checks that the server still listens.
import type { LocalService } from '@latch/protocol'
import { stripEscapes } from './text.ts'

/** A line longer than this keeps only its end while it waits for its line break. */
const PARTIAL_LINE_BYTES = 2048
/** The most recently announced services a terminal keeps. */
const SERVICES_KEPT = 8
const URL_SEPARATOR = Buffer.from('://')
const LOOPBACK_URL = /\b(https?):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{1,5})(?!\d)/giu

function servicesIn(line: string): LocalService[] {
  const found: LocalService[] = []
  for (const match of stripEscapes(line).matchAll(LOOPBACK_URL)) {
    const port = Number(match[3])
    if (port < 1 || port > 65_535) continue
    const host = match[2].toLowerCase()
    // The unspecified addresses mean "every interface"; a browser reaches the server through localhost.
    const shown = host === '0.0.0.0' || host === '[::]' ? 'localhost' : host
    found.push({ origin: `${match[1].toLowerCase()}://${shown}:${port}`, port })
  }
  return found
}

/**
 * Reads complete lines across chunks and keeps the newest SERVICES_KEPT services. Heavy output without `://` costs one
 * search per chunk; each address found costs one map update, however often it repeats.
 */
export class LocalServiceDetector {
  private partial = Buffer.alloc(0)
  /** By origin, oldest first. */
  private readonly known = new Map<string, LocalService>()
  private newest: string | undefined

  /** Reads a chunk of output; true when the services changed. */
  push(chunk: Buffer): boolean {
    const data = this.partial.length === 0 ? chunk : Buffer.concat([this.partial, chunk])
    const last = data.lastIndexOf(0x0a)
    const rest = last < 0 ? data : data.subarray(last + 1)
    this.partial = Buffer.from(rest.subarray(Math.max(0, rest.length - PARTIAL_LINE_BYTES)))
    if (last < 0) return false
    const complete = data.subarray(0, last + 1)
    let changed = false
    let index = complete.indexOf(URL_SEPARATOR)
    while (index >= 0) {
      const start = complete.lastIndexOf(0x0a, index) + 1
      const end = complete.indexOf(0x0a, index)
      for (const service of servicesIn(complete.subarray(start, end).toString('utf8'))) changed = this.add(service) || changed
      index = complete.indexOf(URL_SEPARATOR, end)
    }
    return changed
  }

  /** Newest first. */
  services(): LocalService[] {
    return [...this.known.values()].toReversed().map(service => ({ ...service }))
  }

  /** The program that announced them has ended. */
  clear(): void {
    this.known.clear()
    this.newest = undefined
  }

  private add(service: LocalService): boolean {
    if (this.newest === service.origin) return false
    this.known.delete(service.origin)
    this.known.set(service.origin, service)
    this.newest = service.origin
    const oldest = this.known.keys().next()
    if (this.known.size > SERVICES_KEPT && !oldest.done) this.known.delete(oldest.value)
    return true
  }
}
