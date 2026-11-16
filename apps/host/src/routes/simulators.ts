// The 设备 panel's routes, for this Mac alone as the terminal's are: host.sock, a device with `run` and the full data
// scope, refused before any body is read. A simulator shows what this Mac holds (an Apple ID, app data), so the picture
// goes only as a bounded binary answer to the panel that asked; never over SSE, into a log or onto disk. See
// docs/DEVICE-PREVIEW.md.
import { createHash } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import { z } from 'zod'
import { isLocalListener } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { json, jsonBody, safeDecode } from '../http-util.ts'
import { simulatorUrl, type Simulators } from '../simulators.ts'
import type { AuditDetail } from '../audit.ts'
import type { Caller, DeviceCaller, RouteContext, RouteModule } from './registry.ts'

const SIMULATOR_PATH = /^\/link\/api\/simulators\/([^/]+)\/(frame|screenshot|boot|shutdown|open-url|appearance|device-hub)$/u
const openSchema = z.strictObject({ url: z.string().max(2048) })
const appearanceSchema = z.strictObject({ appearance: z.enum(['light', 'dark']) })

/** Where an opened address goes, as the audit keeps it: its scheme and the SHA-256 of its origin, never the address. */
export function addressFacts(url: string): { scheme: string; originHash?: string } {
  const parsed = new URL(url)
  const scheme = parsed.protocol.slice(0, -1).toLowerCase()
  const origin = parsed.origin !== 'null' ? parsed.origin : `${scheme}:`
  return { scheme, originHash: createHash('sha256').update(origin).digest('hex') }
}

function picture(res: ServerResponse, data: Buffer, type: 'image/png' | 'image/jpeg'): void {
  res.writeHead(200, {
    'content-type': type,
    'content-length': String(data.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(data)
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

  return {
    async route({ req, res, caller, path, method }) {
      if (path !== '/link/api/simulators' && !path.startsWith('/link/api/simulators/')) return false
      context.requireLocal(caller)
      context.requireScope(caller, 'run')
      authorize(caller)
      if (!simulators.supported) throw new AppError(501, 'simulator-unsupported', '这台电脑上没有模拟器')
      if (path === '/link/api/simulators') {
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
        })
        return true
      }
      const match = SIMULATOR_PATH.exec(path)
      if (!match) return false
      const udid = safeDecode(match[1]!)
      const action = match[2]!
      if (action === 'frame' || action === 'appearance') {
        if (method === 'GET' && action === 'frame') {
          const data = await simulators.picture(udid, 'jpeg', { frame: true })
          authorize(caller)
          picture(res, data, 'image/jpeg')
          return true
        }
        if (method === 'GET') {
          const appearance = await simulators.appearance(udid)
          authorize(caller)
          json(res, { appearance: appearance ?? null })
          return true
        }
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
        picture(res, await simulators.picture(device.udid, 'png'), 'image/png')
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
