import { createAgentLoginRoutes, type AgentLoginDeps, type AgentLoginRoutes } from './agent-login.ts'
import { createAgentRoutes, type AgentRouteDeps } from './agents.ts'
import { createAppRoutes, type AppRouteDeps, type AppRoutes } from './apps.ts'
import { createAutomationRoutes, type AutomationRouteDeps } from './automations.ts'
import { createBranchRoutes, type BranchRouteDeps } from './branches.ts'
import { createBrowserRoutes, type BrowserRouteDeps } from './browser.ts'
import { createChangeRoutes, type ChangeRoutes } from './changes.ts'
import { createCustomizationRoutes, type CustomizationRouteDeps, type CustomizationRoutes } from './customization.ts'
import { createDataRoutes, type DataRouteDeps } from './data.ts'
import { createDeviceRoutes, type DeviceRouteDeps } from './devices.ts'
import { createHandoffRoutes, type HandoffRouteDeps } from './handoffs.ts'
import { createGitRoutes, type GitRouteOptions } from './git.ts'
import { createHistoryRoutes, type HistoryRouteDeps } from './history.ts'
import { createMcpRoutes, type McpRouteDeps } from './mcp.ts'
import { createNativeRoutes, type NativeRouteDeps, type NativeRoutes } from './native.ts'
import { RouteRegistry, type RouteContext } from './registry.ts'
import { createReviewNoteRoutes, type ReviewNoteRouteDeps } from './review-notes.ts'
import { createShortcutRoutes, type ShortcutRouteDeps } from './shortcuts.ts'
import { createSimulatorRoutes } from './simulators.ts'
import type { Simulators } from '../simulators.ts'
import type { SimulatorControl } from '../simulator-control.ts'
import type { SimulatorLive } from '../simulator-live.ts'
import { createWorkItemRoutes, type WorkItemRouteDeps } from './work-items.ts'
import { createWorkThreadRoutes, type WorkThreadRouteDeps, type WorkThreadRoutes } from './work-threads.ts'
import { createWorkProposalRoutes, type WorkProposalRouteDeps, type WorkProposalRoutes } from './work-proposals.ts'
import { createTeamRoutes, type TeamRouteDeps, type TeamRoutes } from './teams.ts'
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
  workItems: WorkItemRouteDeps
  workThreads: WorkThreadRouteDeps
  workProposals: WorkProposalRouteDeps
  teams: TeamRouteDeps
  history: HistoryRouteDeps
  reviewNotes: ReviewNoteRouteDeps
  git?: GitRouteOptions
  branches: BranchRouteDeps
  apps: AppRouteDeps
  browser: BrowserRouteDeps
  simulators: { simulators: Simulators; live: SimulatorLive; control: SimulatorControl }
  mcp: McpRouteDeps
  customization: CustomizationRouteDeps
  shortcuts: ShortcutRouteDeps
  data: DataRouteDeps
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
  workProposals: WorkProposalRoutes
  workThreads: WorkThreadRoutes
  teams: TeamRoutes
  routes: RouteRegistry
} {
  const native = createNativeRoutes(context, deps.native)
  const apps = createAppRoutes(context, deps.apps)
  const terminal = createTerminalRoutes(context, deps.terminals, deps.terminalWorkspaceOperation)
  const agentLogin = createAgentLoginRoutes(context, { ...deps.agentLogin, terminals: deps.terminals })
  const changes = createChangeRoutes(context)
  const customization = createCustomizationRoutes(context, deps.customization)
  const workProposals = createWorkProposalRoutes(context, deps.workProposals)
  const workThreads = createWorkThreadRoutes(context, deps.workThreads)
  const workItems = createWorkItemRoutes(context, { ...deps.workItems, postAttention: workThreads.attention })
  const teams = createTeamRoutes(context, deps.teams, { itemRoutes: workItems, proposals: workProposals })
  const simulators = createSimulatorRoutes(context, deps.simulators.simulators, deps.simulators.live, deps.simulators.control)
  return {
    native,
    terminal,
    agentLogin,
    apps,
    changes,
    customization,
    workProposals,
    workThreads,
    teams,
    routes: new RouteRegistry([
      native,
      createDeviceRoutes(context, {
        ...deps.devices,
        deviceView: device => native.deviceView(device),
        endDisallowedStreams() {
          deps.devices.endDisallowedStreams()
          simulators.endDisallowedStreams()
        },
      }),
      changes,
      createReviewNoteRoutes(context, deps.reviewNotes),
      createGitRoutes(context, deps.git),
      createBranchRoutes(context, deps.branches),
      terminal,
      createBrowserRoutes(context, deps.browser),
      simulators,
      createMcpRoutes(context, deps.mcp),
      createAgentRoutes(context, deps.agents),
      agentLogin,
      createAutomationRoutes(context, deps.automations),
      createHandoffRoutes(context, deps.handoffs),
      // Before the 待办's own routes, which answer every other path under them.
      workThreads,
      workItems.module,
      workProposals.module,
      // `POST /tasks/:id/team` is answered here, before the Host's own session routes.
      teams.module,
      createHistoryRoutes(context, deps.history),
      customization,
      createShortcutRoutes(context, deps.shortcuts),
      createDataRoutes(context, deps.data),
      apps,
    ]),
  }
}
