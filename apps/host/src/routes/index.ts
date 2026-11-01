import { createAgentRoutes, type AgentRouteDeps } from './agents.ts'
import { createAutomationRoutes, type AutomationRouteDeps } from './automations.ts'
import { createChangeRoutes } from './changes.ts'
import { createConversationRoutes } from './conversation.ts'
import { createDeviceRoutes, type DeviceRouteDeps } from './devices.ts'
import { createGitRoutes } from './git.ts'
import { createNativeApprovalRoutes } from './native-approvals.ts'
import { createNativeRoutes, type NativeRouteDeps, type NativeRoutes } from './native.ts'
import { createPushRoutes } from './push.ts'
import { RouteRegistry, type RouteContext } from './registry.ts'
import { createTerminalRoutes, type TerminalRoutes } from './terminal.ts'
import type { TerminalService } from '../terminal/service.ts'

export interface RouteDeps {
  native: NativeRouteDeps
  devices: Omit<DeviceRouteDeps, 'deviceView'>
  terminals: TerminalService
  agents: AgentRouteDeps
  automations: AutomationRouteDeps
}

/**
 * Every route module, in the order `handleApi` asks them. The native module comes first, so its connection checks run
 * before any other module sees a request.
 */
export function createRoutes(
  context: RouteContext,
  deps: RouteDeps,
): { native: NativeRoutes; terminal: TerminalRoutes; routes: RouteRegistry } {
  const native = createNativeRoutes(context, deps.native)
  const terminal = createTerminalRoutes(context, deps.terminals)
  return {
    native,
    terminal,
    routes: new RouteRegistry([
      native,
      createDeviceRoutes(context, { ...deps.devices, deviceView: device => native.deviceView(device) }),
      createChangeRoutes(context),
      createGitRoutes(context),
      terminal,
      createAgentRoutes(context, deps.agents),
      createAutomationRoutes(context, deps.automations),
      createConversationRoutes(context),
      createNativeApprovalRoutes(context),
      createPushRoutes(context),
    ]),
  }
}
