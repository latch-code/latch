import { createAgentRoutes } from './agents.ts'
import { createAutomationRoutes } from './automations.ts'
import { createChangeRoutes } from './changes.ts'
import { createConversationRoutes } from './conversation.ts'
import { createDeviceRoutes, type DeviceRouteDeps } from './devices.ts'
import { createGitRoutes } from './git.ts'
import { createNativeApprovalRoutes } from './native-approvals.ts'
import { createNativeRoutes, type NativeRouteDeps, type NativeRoutes } from './native.ts'
import { createPushRoutes } from './push.ts'
import { RouteRegistry, type RouteContext } from './registry.ts'
import { createTerminalRoutes } from './terminal.ts'

export interface RouteDeps {
  native: NativeRouteDeps
  devices: Omit<DeviceRouteDeps, 'deviceView'>
}

/**
 * Every route module, in the order `handleApi` asks them. The native module comes first, so its connection checks run
 * before any other module sees a request.
 */
export function createRoutes(context: RouteContext, deps: RouteDeps): { native: NativeRoutes; routes: RouteRegistry } {
  const native = createNativeRoutes(context, deps.native)
  return {
    native,
    routes: new RouteRegistry([
      native,
      createDeviceRoutes(context, { ...deps.devices, deviceView: device => native.deviceView(device) }),
      createChangeRoutes(context),
      createGitRoutes(context),
      createTerminalRoutes(context),
      createAgentRoutes(context),
      createAutomationRoutes(context),
      createConversationRoutes(context),
      createNativeApprovalRoutes(context),
      createPushRoutes(context),
    ]),
  }
}
