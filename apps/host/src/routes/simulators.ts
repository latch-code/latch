// The 设备 panel's routes, for this Mac alone as the terminal's are: host.sock, a device with `run` and the full data
// scope, refused before any body is read. A simulator shows what this Mac holds (an Apple ID, app data), so a picture or
// a recording goes only as a bounded binary answer to the panel that asked, and log lines only down that panel's own
// event stream; never over the Host's SSE, into a log, the audit or the data directory.
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import type { ServerResponse } from 'node:http'
import { z } from 'zod'
import {
  SIMULATOR_BUTTONS,
  SIMULATOR_INPUT_LIMITS,
  SIMULATOR_KEYS,
  SIMULATOR_PRIVACY_ACTIONS,
  SIMULATOR_PRIVACY_SERVICES,
  SIMULATOR_STREAM_LIMITS,
  isLocalListener,
  type SimulatorLogEvents,
} from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { authFailure } from '../access.ts'
import { json, jsonBody, optionalJsonBody, safeDecode } from '../http-util.ts'
import {
  SIMULATOR_RUNTIME_ID,
  SIMULATOR_TYPE_ID,
  isBundleId,
  isSimulatorUdid,
  simulatorName,
  simulatorUrl,
  type Simulators,
} from '../simulators.ts'
import type { AuditDetail } from '../audit.ts'
import type { SimulatorControl } from '../simulator-control.ts'
import type { SimulatorLive } from '../simulator-live.ts'
import type { Caller, DeviceCaller, RouteContext, RouteModule } from './registry.ts'

const SIMULATOR_PATH =
  /^\/link\/api\/simulators\/([^/]+)\/(frame|screenshot|boot|shutdown|open-url|appearance|device-hub|orientation|rotate|record|apps|launch|terminate|privacy|logs|stream|keyframe|control|input)$/u
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
const streamSchema = z.strictObject({
  codec: z.enum(['h264', 'jpeg']),
  fps: z.coerce.number().int().min(SIMULATOR_STREAM_LIMITS.fps.min).max(SIMULATOR_STREAM_LIMITS.fps.max),
  size: z.coerce.number().int().min(SIMULATOR_STREAM_LIMITS.size.min).max(SIMULATOR_STREAM_LIMITS.size.max),
})
const controlSchema = z.strictObject({ action: z.enum(['take', 'release']) })
const coordinate = z.number().min(0).max(10_000)
const inputSchema = z.strictObject({
  events: z
    .array(
      z.discriminatedUnion('type', [
        z.strictObject({ type: z.literal('touch'), phase: z.enum(['down', 'move', 'up']), x: coordinate, y: coordinate }),
        z.strictObject({ type: z.literal('key'), key: z.enum(SIMULATOR_KEYS) }),
        z.strictObject({ type: z.literal('button'), button: z.enum(SIMULATOR_BUTTONS) }),
        z.strictObject({ type: z.literal('text'), text: z.string().min(1).max(SIMULATOR_INPUT_LIMITS.textChars) }),
      ]),
    )
    .min(1)
    .max(SIMULATOR_INPUT_LIMITS.events),
})
/** How often an open live stream marks its device as shown and in use. */
const WATCHING_EVERY_MS = 5_000
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

interface SimulatorRoutes extends RouteModule {
  endDisallowedStreams(): void
}

export function createSimulatorRoutes(
  context: RouteContext,
  simulators: Simulators,
  live: SimulatorLive,
  control: SimulatorControl,
): SimulatorRoutes {
  const { devices, lifecycle } = context
  const liveStreams = new Set<() => boolean>()
  function endDisallowedStreams(): void {
    for (const closeIfDisallowed of liveStreams) closeIfDisallowed()
    control.releaseDisallowedHolders(id => {
      const device = devices.get(id)
      return device?.dataScope === 'all' && device.scopes.includes('run') && isLocalListener(device.listener) && devices.isActive(id)
    })
  }
  devices.onRevoked(endDisallowedStreams)
  lifecycle.on('hostStopping', async () => {
    await Promise.all([simulators.stop(), live.stop(), control.stop()])
  })
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

  /**
   * The live picture as a binary fetch stream (SIMULATOR_STREAM framing): each message is written only once the socket
   * took the last, so a page that reads slowly holds back its own small queue (frames dropped there), never the Host.
   */
  async function stream(
    res: ServerResponse,
    caller: DeviceCaller,
    udid: string,
    settings: z.infer<typeof streamSchema>,
    gone: AbortController,
  ) {
    const { credentialHash } = caller
    if (!credentialHash) throw authFailure('unauthorized')
    const deviceId = caller.device.id
    const closeIfDisallowed = () => {
      const device = devices.get(deviceId)
      if (device?.dataScope === 'all' && device.scopes.includes('run') && devices.streamAllowed(deviceId, credentialHash)) return false
      // Destroy the response to discard queued bytes, even if this client never reads enough to emit drain.
      res.destroy()
      gone.abort()
      return true
    }
    const watch = await live.watch(udid, { codec: settings.codec, maxFps: settings.fps, maxDimension: settings.size })
    if (gone.signal.aborted || res.destroyed || closeIfDisallowed()) {
      watch.close()
      return
    }
    const closeWatch = () => watch.close()
    gone.signal.addEventListener('abort', closeWatch, { once: true })
    const unwatchOwner = control.watchOwner(udid, deviceId, owner => watch.inputOwner(owner))
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store, no-transform',
      'x-content-type-options': 'nosniff',
      'x-accel-buffering': 'no',
    })
    simulators.watching(udid)
    // Also on a still screen, when no frame comes to check against: a device no longer allowed loses the picture.
    const marking = setInterval(() => {
      if (!closeIfDisallowed()) simulators.watching(udid)
    }, WATCHING_EVERY_MS)
    marking.unref()
    liveStreams.add(closeIfDisallowed)
    try {
      for (;;) {
        const message = await watch.next()
        if (!message || res.destroyed || gone.signal.aborted || closeIfDisallowed()) break
        if (!res.write(message))
          await once(res, 'drain', { signal: gone.signal }).catch(error => {
            if (!gone.signal.aborted) throw error
          })
      }
    } finally {
      liveStreams.delete(closeIfDisallowed)
      unwatchOwner()
      clearInterval(marking)
      gone.signal.removeEventListener('abort', closeWatch)
      closeWatch()
      if (!res.destroyed && !res.writableEnded) res.end()
    }
  }

  return {
    endDisallowedStreams,

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
            inputOwner: device.state === 'booted' ? control.ownerOf(device.udid, caller.device.id) : 'none',
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
        if (action === 'stream') {
          const gone = new AbortController()
          res.once('close', () => gone.abort())
          const query = new URL(req.url ?? '/', 'http://host').searchParams
          if ([...query.keys()].some((key, index, keys) => keys.indexOf(key) !== index))
            throw new AppError(400, 'invalid-input', '画面参数无效')
          const settings = streamSchema.parse(Object.fromEntries(query))
          const device = await simulators.device(udid)
          authorize(caller)
          if (device.state !== 'booted') throw new AppError(409, 'simulator-not-booted', '设备未启动')
          await stream(res, caller, device.udid, settings, gone)
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
      if (action === 'input') {
        // Read and checked before the device is looked up: inputs come many a second, and the list is kept two seconds.
        const { events } = inputSchema.parse(await jsonBody(req))
        if (!control.holds(udid, owner)) throw new AppError(409, 'simulator-control-required', '先在面板里接管这台设备')
        const device = await simulators.device(udid)
        authorize(caller)
        if (device.state !== 'booted') throw new AppError(409, 'simulator-not-booted', '设备未启动')
        simulators.touch(device.udid)
        const receipt = await control.input(device.udid, owner, events, () => authorize(caller))
        // Written to the companion's stream in order; the device's own confirmation comes only as a stream ends.
        authorize(caller)
        json(res, receipt)
        return true
      }
      if (action === 'keyframe') {
        // Looking, not acting: no body to speak of, no record; only a device with a live picture now.
        await optionalJsonBody(req)
        if (!isSimulatorUdid(udid)) throw new AppError(400, 'invalid-input', '设备标识无效')
        authorize(caller)
        json(res, { asked: live.keyframe(udid) })
        return true
      }
      const device = await simulators.device(udid)
      authorize(caller)
      if (action === 'control') {
        const { action: step } = controlSchema.parse(await jsonBody(req))
        authorize(caller)
        if (step === 'release') {
          await control.release(device.udid, owner)
          json(res, { released: true })
          return true
        }
        if (device.state !== 'booted') throw new AppError(409, 'simulator-not-booted', '设备未启动')
        // The person's taps are not recorded one by one: once, as they take control.
        const record = control.holds(device.udid, owner) ? undefined : () => audited(caller, { action: 'control', udid: device.udid })
        const view = await control.take(device.udid, owner, () => authorize(caller), record)
        authorize(caller)
        json(res, { control: view })
        return true
      }
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
        const orientation = await simulators.rotate(device.udid, direction)
        control.displayChanged(device.udid)
        json(res, { orientation })
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
