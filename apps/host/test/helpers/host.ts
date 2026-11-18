// For the Host's own tests; tests outside the Host use e2e/helpers/host.ts and apps/desktop/test/helpers/host.ts,
// the same binding through @latch/host.
import { resolve } from 'node:path'
import { startHostFixture, type HostFixture, type TestPresence } from '@latch/testkit'
import { startServer, type ServerOptions, type StartedHost, type TlsListenerOptions } from '../../src/server.ts'

export interface TestHostOptions extends Omit<Partial<ServerOptions>, 'tls'> {
  presenceMode?: TestPresence['mode']
  /** `true`: a self-signed `latch-test.localhost` certificate on 127.0.0.1 with local peers allowed. */
  tls?: boolean | TlsListenerOptions
}

export type TestHost = HostFixture<StartedHost>

/**
 * A Host on fresh temp directories with test presence, relaxed rate limits and all three transports: the test kit's
 * Host fixture bound to this Host's `startServer`, with the page from dist/web and the demo model. Other
 * `ServerOptions` pass through; `presence` is always the fixture's test backend.
 */
export function startTestHost(options: TestHostOptions = {}): Promise<TestHost> {
  const { presenceMode, tls, presence: _presence, ...rest } = options
  return startHostFixture(
    setup =>
      startServer({
        uiDir: resolve('dist/web'),
        port: 0,
        demo: true,
        runtimeParent: setup.runtimeParent,
        rateLimits: 'relaxed',
        nativeNetwork: false,
        // A loopback socket cannot prove it is on the Mac's network; the gate's own tests inject a refusal or a fake backend.
        nativeNearby: () => true,
        // Never the person's own ~/.latch/relays: a folder of the fixture, empty unless a test fills it.
        relayFilesHome: setup.runtimeParent,
        ...rest,
        dataDir: setup.dataDir,
        workspaceRoot: setup.workspaceRoot,
        presence: setup.presence,
        ...(setup.tls ? { tls: setup.tls } : {}),
      }),
    { presenceMode, tls, dataDir: rest.dataDir, workspaceRoot: rest.workspaceRoot },
  )
}
