// The 设备 panel's routes, for this Mac alone as the terminal's are: host.sock, a device with `run` and the full data
// scope, refused before any body is read. A simulator shows what this Mac holds (an Apple ID, app data), so a picture or
// a recording goes only as a bounded binary answer to the panel that asked, and log lines only down that panel's own
// event stream; never over the Host's SSE, into a log, the audit or the data directory. See docs/DEVICE-PREVIEW.md.
import { createHash } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import { z } from 'zod'
import { SIMULATOR_PRIVACY_ACTIONS, SIMULATOR_PRIVACY_SERVICES, isLocalListener, type SimulatorLogEvents } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { authFailure } from '../access.ts'
import { json, jsonBody, safeDecode } from '../http-util.ts'
import { SIMULATOR_RUNTIME_ID, SIMULATOR_TYPE_ID, isBundleId, simulatorName, simulatorUrl, type Simulators } from '../simulators.ts'
import type { AuditDetail } from '../audit.ts'
import type { Caller, DeviceCaller, RouteContext, RouteModule } from './registry.ts'

const SIMULATOR_PATH =
  /^\/link\/api\/simulators\/([^/]+)\/(frame|screenshot|boot|shutdown|open-url|appearance|device-hub|orientation|rotate|record|apps|launch|terminate|privacy|logs)$/u
const openSchema = z.strictObject({ url: z.string().max(2048) })
const appearanceSchema = z.strictObject({ appearance: z.enum(['light', 'dark']) })
const rotateSchema = z.strictObject({ direction: z.enum(['left', 'right']) })
const recordSchema = z.strictObject({ action: z.enum(['start', 'stop', 'discard']) })
const appSchema = z.strictObject({ bundleId: z.string().max(155) })
const privacySchema = z.strictObject({
  action: z.enum(SIMULATOR_PRIVACY_ACTIONS),
  service: z.enum(SIMULATOR_PRIVACY_SERVICES),
  bundleId: z.string().max(155),
})
const createSchema = z.strictObject({
  name: z.string().max(200),
  deviceType: z.string().regex(SIMULATOR_TYPE_ID),
  runtime: z.string().regex(SIMULATOR_RUNTIME_ID),
})
const LOG_HEARTBEAT_MS = 15_000
const LOG_BEHIND_BYTES = 1024 * 1024

/** Where an opened address goes, as the audit keeps it: its scheme and the SHA-256 of its origin, never the address. */
export function addressFacts(url: string): { scheme: string; originHash?: string } {
  const parsed = new URL(url)
  const scheme = parsed.protocol.slice(0, -1).toLowerCase()
  const origin = parsed.origin !== 'null' ? parsed.origin : `${scheme}:`
  return { scheme, originHash: createHash('sha256').update(origin).digest('hex') }
}

/** An app as the audit keeps it: the SHA-256 of its bundle id, which may name the person's own project. */
export function bundleHash(bundleId: string): string {
  return createHash('sha256').update(bundleId).digest('hex')
}

function binary(res: ServerResponse, data: Buffer, type: 'image/png' | 'image/jpeg' | 'video/mp4'): void {
  res.writeHead(200, {
    'content-type': type,
    'content-length': String(data.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(data)
}

function frame<E extends keyof SimulatorLogEvents>(event: E, data: SimulatorLogEvents[E]): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export function createSimulatorRoutes(context: RouteContext, simulators: Simulators): RouteModule {
  const { devices, lifecycle } = context
  lifecycle.on('hostStopping', () => simulators.stop())
  for (const event of ['sessionArchived', 'sessionDeleted', 'runSettled'] as const)
    lifecycle.on(event, ({ sessionId }: { sessionId: string }) => simulators.agentEnded(sessionId))

  /** As the terminal: this Mac, `run`, and every file this account can read, which a simulator's data is. */
  function authorize(caller: DeviceCaller): void {
    context.recheck(caller, 'run')
    if (devices.get(caller.device.id)?.dataScope !== 'all') throw new AppError(403, 'simulator-scope', '这台设备的数据范围不包括模拟器')
  }

  async function audited(caller: DeviceCaller, detail: AuditDetail<'simulator.action'>): Promise<void> {
    await context.audited({ action: 'simulator.action', actor: context.actorOf(caller), target: '', detail })
    authorize(caller)
  }

  /**
   * The panel's own log stream: lines only while the device stays allowed, dropped (and counted) while it is behind.
   * `gone` was set up before the route's first await: a page that left during setup never gets a `log` child left behind.
   */
  async function logs(
    res: ServerResponse,
    caller: DeviceCaller,
    udid: string,
    app: string | undefined,
    gone: AbortController,
  ): Promise<void> {
    const { credentialHash } = caller
    if (!credentialHash) throw authFailure('unauthorized')
    const deviceId = caller.device.id
    const allowed = () => {
      const device = devices.get(deviceId)
      return device?.dataScope === 'all' && device.scopes.includes('run') && devices.streamAllowed(deviceId, credentialHash)
    }
    const open = () => {
      if (res.headersSent) return
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
    }
    const ended = () => res.writableEnded || res.destroyed
    const stream = await simulators.logs(
      udid,
      app,
      {
        lines(lines) {
          if (ended()) return true
          open()
          if (!allowed()) {
            res.end()
            return true
          }
          res.write(frame('lines', { lines }))
          // Behind only past a megabyte unread: an ordinary burst fills the socket's small buffer without the page lagging.
          return res.writableLength < LOG_BEHIND_BYTES
        },
        dropped(count) {
          if (ended()) return
          open()
          if (allowed()) res.write(frame('dropped', { count }))
        },
        closed(reason) {
          if (ended()) return
          open()
          res.end(frame('closed', { reason }))
        },
      },
      gone.signal,
    )
    const heartbeat = setInterval(() => {
      if (ended()) return
      if (!allowed()) res.end()
      else if (!res.writableNeedDrain) res.write(': heartbeat\n\n')
    }, LOG_HEARTBEAT_MS)
    heartbeat.unref()
    const finish = () => {
      clearInterval(heartbeat)
      stream.close()
    }
    // Closed while the stream was set up: the close event has passed, so end it now.
    if (gone.signal.aborted || res.destroyed) {
      finish()
      return
    }
    gone.signal.addEventListener('abort', finish, { once: true })
    open()
    res.write(': open\n\n')
    res.on('drain', () => stream.resume())
  }

  return {
    async route({ req, res, caller, path, method }) {
      if (path !== '/link/api/simulators' && !path.startsWith('/link/api/simulators/')) return false
      context.requireLocal(caller)
      context.requireScope(caller, 'run')
      authorize(caller)
      if (!simulators.supported) throw new AppError(501, 'simulator-unsupported', '这台电脑上没有模拟器')
      if (path === '/link/api/simulators') {
        if (method === 'POST') {
          const body = createSchema.parse(await jsonBody(req))
          const name = simulatorName(body.name)
          authorize(caller)
          // The type and runtime are Apple's identifiers; the name the person typed is not recorded.
          await audited(caller, { action: 'create', deviceType: body.deviceType, runtime: body.runtime })
          json(res, { udid: await simulators.create(name, body.deviceType, body.runtime) })
          return true
        }
        if (method !== 'GET') return false
        const { xcode, devices: list } = await simulators.list()
        authorize(caller)
        const shown = simulators.shown()
        const using = simulators.agentsUsing()
        json(res, {
          xcode,
          devices: list.map(device => ({
            ...device,
            ...(device.udid === shown ? { shown: true } : {}),
            ...(using.some(held => held.udid === device.udid) ? { agent: true } : {}),
          })),
          // An agent's device session through Xcode whose device no call named.
          ...(using.some(held => !held.udid) ? { agentUnnamed: true } : {}),
          abilities: simulators.abilities,
        })
        return true
      }
      if (path === '/link/api/simulators/catalog') {
        if (method !== 'GET') return false
        const catalog = await simulators.catalog()
        authorize(caller)
        json(res, catalog)
        return true
      }
      const match = SIMULATOR_PATH.exec(path)
      if (!match) return false
      const udid = safeDecode(match[1]!)
      const action = match[2]!
      const owner = caller.device.id
      if (method === 'GET') {
        if (action === 'frame') {
          const data = await simulators.picture(udid, 'jpeg', { frame: true })
          authorize(caller)
          binary(res, data, 'image/jpeg')
          return true
        }
        if (action === 'appearance') {
          const appearance = await simulators.appearance(udid)
          authorize(caller)
          json(res, { appearance: appearance ?? null })
          return true
        }
        if (action === 'orientation') {
          const orientation = await simulators.orientation(udid)
          authorize(caller)
          json(res, orientation)
          return true
        }
        if (action === 'record') {
          await simulators.device(udid)
          authorize(caller)
          json(res, simulators.recordingOf(udid, owner))
          return true
        }
        if (action === 'apps') {
          const apps = await simulators.appList(udid)
          authorize(caller)
          json(res, { apps })
          return true
        }
        if (action === 'logs') {
          // Before any await: a page that closes during the setup below must still end what it would have started.
          const gone = new AbortController()
          res.once('close', () => gone.abort())
          const app = new URL(req.url ?? '/', 'http://host').searchParams.get('app') ?? undefined
          if (app !== undefined && !isBundleId(app)) throw new AppError(400, 'invalid-input', 'App 标识无效')
          const device = await simulators.device(udid)
          authorize(caller)
          await audited(caller, { action: 'logs', udid: device.udid, filtered: app !== undefined })
          await logs(res, caller, device.udid, app, gone)
          return true
        }
        return false
      }
      if (method !== 'POST') return false
      const device = await simulators.device(udid)
      authorize(caller)
      if (action === 'boot') {
        await audited(caller, { action: 'boot', udid: device.udid })
        json(res, { device: await simulators.boot(device.udid) })
        return true
      }
      if (action === 'shutdown') {
        // Refused before the record when the device is not this Host's to shut down.
        if (!device.ours) throw new AppError(409, 'simulator-not-ours', '只关闭 Latch 启动的设备')
        await audited(caller, { action: 'shutdown', udid: device.udid })
        json(res, { device: await simulators.shutdown(device.udid) })
        return true
      }
      if (action === 'device-hub') {
        await audited(caller, { action: 'device-hub', udid: device.udid })
        await simulators.openInHub(device.udid)
        json(res, { opened: true })
        return true
      }
      if (action === 'screenshot') {
        await audited(caller, { action: 'screenshot', udid: device.udid })
        binary(res, await simulators.picture(device.udid, 'png'), 'image/png')
        return true
      }
      if (action === 'open-url') {
        const { url } = openSchema.parse(await jsonBody(req))
        const address = simulatorUrl(url)
        authorize(caller)
        await audited(caller, { action: 'open-url', udid: device.udid, ...addressFacts(address) })
        await simulators.openUrl(device.udid, address)
        json(res, { opened: true })
        return true
      }
      if (action === 'appearance') {
        const { appearance } = appearanceSchema.parse(await jsonBody(req))
        authorize(caller)
        await audited(caller, { action: 'appearance', udid: device.udid, appearance })
        await simulators.setAppearance(device.udid, appearance)
        json(res, { appearance })
        return true
      }
      if (action === 'rotate') {
        const { direction } = rotateSchema.parse(await jsonBody(req))
        authorize(caller)
        await audited(caller, { action: 'rotate', udid: device.udid, direction })
        json(res, { orientation: await simulators.rotate(device.udid, direction) })
        return true
      }
      if (action === 'record') {
        const { action: step } = recordSchema.parse(await jsonBody(req))
        authorize(caller)
        if (step === 'start') {
          await audited(caller, { action: 'record', udid: device.udid })
          json(res, await simulators.startRecording(device.udid, owner))
          return true
        }
        if (step === 'discard') {
          json(res, { discarded: await simulators.discardRecording(device.udid, owner) })
          return true
        }
        const data = await simulators.takeRecording(device.udid, owner)
        authorize(caller)
        binary(res, data, 'video/mp4')
        return true
      }
      if (action === 'launch' || action === 'terminate') {
        const { bundleId } = appSchema.parse(await jsonBody(req))
        if (!isBundleId(bundleId)) throw new AppError(400, 'invalid-input', 'App 标识无效')
        authorize(caller)
        await audited(caller, { action, udid: device.udid, bundleHash: bundleHash(bundleId) })
        if (action === 'launch') await simulators.launch(device.udid, bundleId)
        else await simulators.terminate(device.udid, bundleId)
        json(res, { done: true })
        return true
      }
      if (action === 'privacy') {
        const body = privacySchema.parse(await jsonBody(req))
        if (!isBundleId(body.bundleId)) throw new AppError(400, 'invalid-input', 'App 标识无效')
        authorize(caller)
        await audited(caller, {
          action: 'privacy',
          udid: device.udid,
          privacy: body.action,
          service: body.service,
          bundleHash: bundleHash(body.bundleId),
        })
        await simulators.privacy(device.udid, body.action, body.service, body.bundleId)
        json(res, { done: true })
        return true
      }
      return false
    },

    // Only where it can work: this Mac, a device allowed what the terminal is allowed, and a Host that runs simctl.
    features: (caller: Caller) =>
      simulators.offered
      && isLocalListener(caller.connection.listener)
      && caller.device?.scopes.includes('run')
      && caller.device.dataScope === 'all'
        ? { simulators: true }
        : {},
  }
}
