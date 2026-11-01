import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Device, DeviceScope, HostFeatures, PresenceAction, PresencePreview, PresenceSubject } from '@latch/protocol'
import type { PluginRegistry } from '@latch/core'
import type { ProjectFolder } from '@latch/sdk'
import type { BucketName, Presented, RateLimiter } from '../access.ts'
import type { AuditActor, AuditLog, StepupMethod } from '../audit.ts'
import type { ConnectionContext, DeviceStore, EnrollmentService } from '../auth.ts'
import type { HostConfig } from '../config.ts'
import { KIB } from '../http-util.ts'
import type { HarnessHub } from '../hub.ts'
import type { ListenerContext } from '../listeners.ts'
import type { NativeOpening } from '../native.ts'
import type { PolicyStore } from '../policy.ts'
import type { PresenceService } from '../presence.ts'
import type { LifecycleListeners } from '../session-lifecycle.ts'

export const CONFIG_BODY_LIMIT = 128 * KIB
/** Attempts for a reduction whose base moved underneath it (a cascade or a helper pin landing first). */
export const BASE_RETRIES = 3

/** The authenticated party of one request. Anonymous only on host.sock, and only for a few routes. */
export interface Caller {
  connection: ConnectionContext
  device?: Device
  /** Set only by the controlled native metadata/reduction routes. */
  nativeWindowExempt?: boolean
  nativeOpening?: NativeOpening
  renewAfter?: number
  presented?: Presented
  /** Hash of the credential this request was admitted with; event streams stay bound to it. */
  credentialHash?: string
}
export type DeviceCaller = Caller & { device: Device }

export type PreviewLine = PresencePreview['lines'][number]
export type AuditEvent = Parameters<AuditLog['append']>[0]

/**
 * The Host's services and request guards, the same ones server.ts uses; a route module keeps its own state and reaches
 * the rest of the Host only through this.
 */
export interface RouteContext {
  hostId: string
  hostId8: string
  dataDir: string
  /** The repository root, where `dist/native/` holds the native components. */
  codeRoot: string
  now: () => number
  /** What runs and messages are stamped with, so a record of a run can be matched to its messages by time. */
  clock: () => number
  log: (text: string) => void
  audit: AuditLog
  policy: PolicyStore
  devices: DeviceStore
  enrollments: EnrollmentService
  presence: PresenceService
  config: HostConfig
  plugins: PluginRegistry
  hub: HarnessHub
  /** Paths nothing outside the Host's own stores reads or writes. */
  guardedPaths: readonly string[]
  /**
   * The folders a session may use, as file handles get them: undefined with no such session, `removed` once one of them
   * has left its project or is gone.
   */
  sessionRoots: (sessionId: string) => Promise<ProjectFolder[] | 'removed' | undefined>
  /** What a device must pass to send new input to a session: its level's ceiling, the remote lists, the session's folders. */
  assertSessionInput: (caller: DeviceCaller, sessionId: string) => Promise<void>
  /** Runs starting and settling, sessions archived or deleted, and the Host stopping (`session-lifecycle.ts`). */
  lifecycle: LifecycleListeners
  limits: Record<BucketName, RateLimiter>
  /** True once the Host has begun to stop. */
  closing: () => boolean
  /** Tells clients to read the snapshot again, or one session's state. */
  refresh: (sessionId?: string) => void
  actorOf: (caller: Caller) => AuditActor
  requireDevice: (caller: Caller) => asserts caller is DeviceCaller
  requireScope: (caller: Caller, scope: DeviceScope) => asserts caller is DeviceCaller
  /** Only host.sock counts as this computer (`isLocalListener`); loopback and every other listener are remote. */
  requireLocal: (caller: Caller) => void
  /** Re-checks a caller after an await: a queued or slow request may outlive a revocation or a scope change. */
  recheck: (caller: Caller, scope?: DeviceScope) => void
  /**
   * Local presence confirmation for one exact request. Without `x-latch-confirmation` it starts a confirmation and answers
   * 403 stepup-required with the ticket; with it, it consumes the approved confirmation for exactly these parameters.
   */
  confirm: (
    req: IncomingMessage,
    caller: Caller,
    action: PresenceAction,
    params: Record<string, unknown>,
    subject: PresenceSubject,
    lines: PreviewLine[],
    warnings?: string[],
    target?: string,
    launchKey?: string,
  ) => Promise<StepupMethod>
  /** Serializes configuration changes; each re-checks the caller first. */
  serial: <T>(caller: Caller, scope: DeviceScope | undefined, operation: () => Promise<T>) => Promise<T>
  /**
   * Appends before the action takes effect. Privilege-granting actions fail with the audit; reducing ones (`tolerant`)
   * still proceed and the response says the record is missing.
   */
  audited: (event: AuditEvent, tolerant?: ServerResponse) => Promise<number | undefined>
}

/** One request under `/link/api/`. */
export interface RouteRequest {
  req: IncomingMessage
  res: ServerResponse
  listener: ListenerContext
  connection: ConnectionContext
  /** The native connection the request came over, if it came over one. */
  opening: NativeOpening | undefined
  path: string
  method: string
}

export interface CallerRequest extends RouteRequest {
  caller: Caller
}

/**
 * A group of routes. `handleApi` asks the modules in the order `routes/index.ts` lists them, at four points of every
 * request. Each answers true once it has handled the request (or closed its connection), false to pass it on, and
 * throws to refuse it.
 */
export interface RouteModule {
  /** First, for every request: checks of the connection it came over. */
  screen?(request: RouteRequest): Promise<boolean>
  /** Routes that need no credential, asked after the Host's health and host-state routes. */
  unauthenticated?(request: RouteRequest): Promise<boolean>
  /** Right after authentication, before the Host refuses anonymous callers outside the few routes they may use. */
  authenticated?(request: CallerRequest): Promise<boolean>
  /** Routes for a caller that passed every check, asked before the Host's own routes. */
  route?(request: CallerRequest): Promise<boolean>
  /** The `catalog.features` flags of this module's routes, as this caller can use them. */
  features?(caller: Caller): HostFeatures
}

export class RouteRegistry {
  constructor(private readonly modules: readonly RouteModule[]) {}

  async screen(request: RouteRequest): Promise<boolean> {
    for (const entry of this.modules) if (await entry.screen?.(request)) return true
    return false
  }

  async unauthenticated(request: RouteRequest): Promise<boolean> {
    for (const entry of this.modules) if (await entry.unauthenticated?.(request)) return true
    return false
  }

  async authenticated(request: CallerRequest): Promise<boolean> {
    for (const entry of this.modules) if (await entry.authenticated?.(request)) return true
    return false
  }

  async route(request: CallerRequest): Promise<boolean> {
    for (const entry of this.modules) if (await entry.route?.(request)) return true
    return false
  }

  features(caller: Caller): HostFeatures {
    return Object.assign({}, ...this.modules.map(entry => entry.features?.(caller) ?? {}))
  }
}
