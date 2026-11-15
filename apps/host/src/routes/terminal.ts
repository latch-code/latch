// The terminal routes, every one for this computer alone: the service refuses other listeners too, and these refuse them
// first, before any body is read. Output is raw and may hold keys, so a stream lives only as long as its credential.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { isLocalListener, type TerminalStreamEvents, type TerminalTarget } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { authFailure } from '../access.ts'
import { KIB, json, jsonBody, optionalJsonBody, safeDecode } from '../http-util.ts'
import { INPUT_BYTES, SELECTION_BYTES, type TerminalRef, type TerminalRequester, type TerminalService } from '../terminal/service.ts'
import type { Caller, DeviceCaller, RouteContext, RouteModule } from './registry.ts'

const TERMINAL_PATH = /^\/link\/api\/(tasks|workspaces)\/([^/]+)\/terminals(?:\/([^/]+)(?:\/([a-z]+))?)?$/u
const STREAM_HEARTBEAT_MS = 15_000
const OFFSET = /^(?:0|[1-9][0-9]{0,15})$/u
/** The whole body of an input: the base64 of the most one call carries, and its JSON. */
const INPUT_BODY_BYTES = Math.ceil(INPUT_BYTES / 3) * 4 + 64
/** JSON escapes a selection's line breaks and tabs, so its body is larger than the text. */
const ATTACH_BODY_BYTES = SELECTION_BYTES * 2 + KIB
/** The Host itself ends a session's terminals once the session ended; the service admits only this computer. */
const HOST: TerminalRequester = { listener: 'unix', deviceId: 'host' }

const dimension = z.number().int()
const sizeSchema = z.strictObject({ cols: dimension, rows: dimension })
const inputSchema = z.strictObject({ data: z.base64() })
const closeSchema = z.strictObject({ force: z.boolean().optional() })
const attachSchema = z.strictObject({ lines: z.number().int().optional(), selection: z.string().optional() })

function requesterOf(caller: DeviceCaller): TerminalRequester {
  return { listener: caller.connection.listener, deviceId: caller.device.id }
}

function frame<E extends keyof TerminalStreamEvents>(event: E, data: TerminalStreamEvents[E]): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function pathPart(value: string): string {
  const decoded = safeDecode(value)
  if (decoded.length > 256) throw new AppError(400, 'invalid-input', '终端标识过长')
  return decoded
}

/** The position a reconnecting stream continues from; anything but one plain `from` is refused. */
function streamFrom(req: IncomingMessage): { from?: number } {
  const query = new URL(req.url ?? '/', 'http://latch.invalid').searchParams
  if ([...query.keys()].some(key => key !== 'from') || query.getAll('from').length > 1)
    throw new AppError(400, 'invalid-input', '终端位置无效')
  const from = query.get('from')
  if (from === null) return {}
  if (!OFFSET.test(from) || !Number.isSafeInteger(Number(from))) throw new AppError(400, 'invalid-input', '终端位置无效')
  return { from: Number(from) }
}

export interface TerminalRoutes extends RouteModule {
  /**
   * For the routes that archive or delete a session, before they act; the terminals end once the session has, so a refused
   * delete costs no shell. This computer's request is held back while a program runs in a terminal (409 `terminal-busy`:
   * the client asks, closes it with `force` and tries again); any other device while a terminal runs at all (409
   * `terminal-running`).
   */
  checkSessionEnd(caller: DeviceCaller, sessionId: string): void
  /** Ends every stream whose credential or device is no longer accepted, without waiting for its next heartbeat. */
  endDisallowedStreams(): void
}

export type TerminalWorkspaceOperation = <T>(workspaceId: string, caller: DeviceCaller, operation: () => Promise<T>) => Promise<T>

export function createTerminalRoutes(
  context: RouteContext,
  service: TerminalService,
  inWorkspace: TerminalWorkspaceOperation,
): TerminalRoutes {
  const { devices, lifecycle } = context
  /** Each open stream and whether it may stay open. */
  const streams = new Map<ServerResponse, () => boolean>()

  /** A shell reads whatever this account can, Host data included, so it takes the full data scope as session files do. */
  function authorize(caller: DeviceCaller): void {
    context.recheck(caller, 'run')
    if (devices.get(caller.device.id)?.dataScope !== 'all') throw new AppError(403, 'terminal-scope', '这台设备的数据范围不包括终端')
  }

  // The routes checked before the session ended, so whatever still runs here goes with it.
  const endSession = ({ sessionId }: { sessionId: string }) => service.closeSession(sessionId, HOST, { force: true })
  lifecycle.on('sessionArchived', endSession)
  lifecycle.on('sessionDeleted', endSession)
  lifecycle.on('hostStopping', () => service.shutdown())

  function stream(req: IncomingMessage, res: ServerResponse, caller: DeviceCaller, ref: TerminalRef): void {
    const position = streamFrom(req)
    const { credentialHash } = caller
    if (!credentialHash) throw authFailure('unauthorized')
    const deviceId = caller.device.id
    const allowed = () => {
      const device = devices.get(deviceId)
      return device?.dataScope === 'all' && device.scopes.includes('run') && devices.streamAllowed(deviceId, credentialHash)
    }
    const opened = service.stream(
      ref,
      requesterOf(caller),
      {
        write(event) {
          // No headers until the service has accepted the stream, so a refusal is still an ordinary error response.
          if (!res.headersSent)
            res.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-store, no-transform',
              connection: 'keep-alive',
              'x-accel-buffering': 'no',
            })
          if (!allowed()) {
            res.end()
            return false
          }
          if (event.type === 'terminal') return res.write(frame('terminal', event.terminal))
          if (event.type === 'reset') return res.write(frame('reset', { offset: event.offset }))
          return res.write(frame('output', { offset: event.offset, data: event.data.toString('base64') }))
        },
        end() {
          if (!res.writableEnded) res.end(frame('closed', {}))
        },
      },
      position,
    )
    const heartbeat = setInterval(() => {
      // An ended response stays open until a slow reader has taken the rest, and must not be written to again.
      if (res.writableEnded) return
      if (!allowed()) res.end()
      else if (!res.writableNeedDrain) res.write(': heartbeat\n\n')
    }, STREAM_HEARTBEAT_MS)
    heartbeat.unref()
    streams.set(res, allowed)
    res.on('drain', () => opened.resume())
    res.once('close', () => {
      clearInterval(heartbeat)
      streams.delete(res)
      opened.close()
    })
  }

  return {
    async route({ req, res, caller, path, method }) {
      const match = TERMINAL_PATH.exec(path)
      if (!match) return false
      context.requireLocal(caller)
      context.requireScope(caller, 'run')
      authorize(caller)
      const id = pathPart(match[2]!)
      const target: TerminalTarget = match[1] === 'tasks' ? { sessionId: id } : { workspaceId: id }
      const requester = requesterOf(caller)
      if (match[3] === undefined) {
        if (method === 'GET') {
          json(res, { terminals: service.list(target, requester) })
          return true
        }
        if (method !== 'POST') return false
        const size = sizeSchema.parse(await jsonBody(req))
        authorize(caller)
        const open = () => {
          authorize(caller)
          return service.create(target, requester, size, () => authorize(caller))
        }
        const terminal = target.workspaceId === undefined ? await open() : await inWorkspace(target.workspaceId, caller, open)
        authorize(caller)
        json(res, { terminal }, 201)
        return true
      }
      const ref: TerminalRef = { ...target, terminalId: pathPart(match[3]) }
      const action = match[4]
      if (action === 'stream' && method === 'GET') {
        stream(req, res, caller, ref)
        return true
      }
      if (method !== 'POST') return false
      if (action === 'input') {
        const { data } = inputSchema.parse(await jsonBody(req, INPUT_BODY_BYTES))
        authorize(caller)
        service.input(ref, requester, Buffer.from(data, 'base64'))
        json(res, { accepted: true })
        return true
      }
      if (action === 'resize') {
        const size = sizeSchema.parse(await jsonBody(req))
        authorize(caller)
        json(res, { terminal: service.resize(ref, requester, size) })
        return true
      }
      if (action === 'close') {
        const { force } = closeSchema.parse(await optionalJsonBody(req))
        authorize(caller)
        await service.close(ref, requester, force === undefined ? {} : { force })
        json(res, { closed: true })
        return true
      }
      if (action === 'attach') {
        const { lines, selection } = attachSchema.parse(await optionalJsonBody(req, ATTACH_BODY_BYTES))
        authorize(caller)
        json(
          res,
          service.extract(ref, requester, { ...(lines !== undefined ? { lines } : {}), ...(selection !== undefined ? { selection } : {}) }),
        )
        return true
      }
      return false
    },

    // Only where a terminal really opens: on this computer, for a device that may use it, with the component in place.
    features: (caller: Caller) =>
      service.available
      && isLocalListener(caller.connection.listener)
      && caller.device?.scopes.includes('run')
      && caller.device.dataScope === 'all'
        ? { terminal: true }
        : {},

    checkSessionEnd: (caller, sessionId) => service.checkSessionEnd(sessionId, requesterOf(caller)),

    endDisallowedStreams() {
      for (const [res, allowed] of streams) if (!allowed()) res.end()
    },
  }
}
