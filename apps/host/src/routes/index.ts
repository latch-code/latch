import { createAgentLoginRoutes, type AgentLoginDeps, type AgentLoginRoutes } from './agent-login.ts'
import { createAgentRoutes, type AgentRouteDeps } from './agents.ts'
import { createAppRoutes, type AppRouteDeps, type AppRoutes } from './apps.ts'
import { createAutomationRoutes, type AutomationRouteDeps } from './automations.ts'
import { createBrowserRoutes, type BrowserRouteDeps } from './browser.ts'
import { createChangeRoutes, type ChangeRoutes } from './changes.ts'
import { createCustomizationRoutes, type CustomizationRouteDeps, type CustomizationRoutes } from './customization.ts'
import { createDeviceRoutes, type DeviceRouteDeps } from './devices.ts'
import { createHandoffRoutes, type HandoffRouteDeps } from './handoffs.ts'
import { createGitRoutes, type GitRouteOptions } from './git.ts'
import { createHistoryRoutes, type HistoryRouteDeps } from './history.ts'
import { createMcpRoutes, type McpRouteDeps } from './mcp.ts'
import { createNativeRoutes, type NativeRouteDeps, type NativeRoutes } from './native.ts'
import { RouteRegistry, type RouteContext } from './registry.ts'
import { createReviewNoteRoutes, type ReviewNoteRouteDeps } from './review-notes.ts'
import { createSimulatorRoutes } from './simulators.ts'
import type { Simulators } from '../simulators.ts'
import { createTerminalRoutes, type TerminalRoutes, type TerminalWorkspaceOperation } from './terminal.ts'
import type { TerminalService } from '../terminal/service.ts'

export interface RouteDeps {
  native: NativeRouteDeps
  devices: Omit<DeviceRouteDeps, 'deviceView'>
  terminals: TerminalService
  terminalWorkspaceOperation: TerminalWorkspaceOperation
  agents: AgentRouteDeps
  agentLogin: AgentLoginDeps
  automations: AutomationRouteDeps
  handoffs: HandoffRouteDeps
  history: HistoryRouteDeps
  reviewNotes: ReviewNoteRouteDeps
  git?: GitRouteOptions
  apps: AppRouteDeps
  browser: BrowserRouteDeps
  simulators: Simulators
  mcp: McpRouteDeps
  customization: CustomizationRouteDeps
}

/**
 * Every route module, in the order `handleApi` asks them. The native module comes first, so its connection checks run
 * before any other module sees a request.
 */
export function createRoutes(
  context: RouteContext,
  deps: RouteDeps,
): {
  native: NativeRoutes
  terminal: TerminalRoutes
  agentLogin: AgentLoginRoutes
  apps: AppRoutes
  changes: ChangeRoutes
  customization: CustomizationRoutes
  routes: RouteRegistry
} {
  const native = createNativeRoutes(context, deps.native)
  const apps = createAppRoutes(context, deps.apps)
  const terminal = createTerminalRoutes(context, deps.terminals, deps.terminalWorkspaceOperation)
  const agentLogin = createAgentLoginRoutes(context, { ...deps.agentLogin, terminals: deps.terminals })
  const changes = createChangeRoutes(context)
  const customization = createCustomizationRoutes(context, deps.customization)
  return {
    native,
    terminal,
    agentLogin,
    apps,
    changes,
    customization,
    routes: new RouteRegistry([
      native,
      createDeviceRoutes(context, { ...deps.devices, deviceView: device => native.deviceView(device) }),
      changes,
      createReviewNoteRoutes(context, deps.reviewNotes),
      createGitRoutes(context, deps.git),
      terminal,
      createBrowserRoutes(context, deps.browser),
      createSimulatorRoutes(context, deps.simulators),
      createMcpRoutes(context, deps.mcp),
      createAgentRoutes(context, deps.agents),
      agentLogin,
      createAutomationRoutes(context, deps.automations),
      createHandoffRoutes(context, deps.handoffs),
      createHistoryRoutes(context, deps.history),
      customization,
      apps,
    ]),
  }
}
