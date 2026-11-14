import { describe, expect, it } from 'vitest'
import type { CustomAgent, HarnessInfo, ModelRef } from '@latch/protocol'
import { testHarness } from '@latch/testkit'
import { AgentPlans } from '../src/agent-plans.ts'

const PROJECT: ModelRef = { providerId: 'project-service', model: 'project-model' }
const HOST: ModelRef = { providerId: 'host-service', model: 'host-model' }

function agent(change: Partial<CustomAgent>): CustomAgent {
  return {
    id: 'agt_00000000-0000-4000-8000-000000000000',
    name: 'Reviewer',
    description: '',
    harnessId: 'codex',
    mode: 'agent',
    instructions: '',
    skills: [],
    avatar: 'a1' as unknown as CustomAgent['avatar'],
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...change,
  }
}

/** Plans over one saved Agent and two Harnesses, with a project whose default model both can use. */
function plans(saved: CustomAgent) {
  const harnesses: Record<string, HarnessInfo> = {
    standard: { ...testHarness('standard', { kind: 'builtin', label: 'Latch 内置' }), agentContext: 'private' },
    codex: { ...testHarness('codex', { kind: 'agent', label: 'Codex' }), agentContext: 'first-turn' },
  }
  return new AgentPlans({
    agents: {
      get: () => saved,
      general: () => ({ instructions: '', skills: undefined }),
      memories: () => [],
      definitionHash: () => 'definition',
    } as never,
    harness: id => harnesses[id],
    plugins: () => [],
    skills: () => [],
    skillBodies: () => [],
    defaultModel: () => HOST,
    modelAvailable: () => true,
    providerOwner: id => id,
    revisions: ids => ({ revisions: Object.fromEntries(ids.map(id => [id, 'r'])), hashed: ids, persistent: true }),
    projectUsable: () => true,
    projectModel: projectId => (projectId === 'project' ? PROJECT : undefined),
    automationAllowed: () => true,
    environment: () => null,
  })
}

const run = (saved: CustomAgent, change: Record<string, unknown> = {}) =>
  plans(saved).automation({ customAgentId: saved.id, projectId: 'project', ...change } as never, 'manual')

describe("the model of an Agent's scheduled run", () => {
  it("takes the run's own, then the Agent's, then the project's default, then the Host's where the Harness has none", () => {
    const builtin = agent({ harnessId: 'standard' })
    expect(run(builtin, { model: { providerId: 'run', model: 'run-model' } }).model).toEqual({ providerId: 'run', model: 'run-model' })
    expect(run(agent({ harnessId: 'standard', model: { providerId: 'own', model: 'own-model' } })).model).toEqual({
      providerId: 'own',
      model: 'own-model',
    })
    expect(run(builtin).model).toEqual(PROJECT)
    expect(run(builtin, { projectId: undefined }).model).toEqual(HOST)
    // A Harness with its own models: the project's default routes it through Latch; without one it keeps its own.
    expect(run(agent({})).model).toEqual(PROJECT)
    expect(run(agent({}), { projectId: undefined }).model).toBeUndefined()
  })

  it("leaves an Agent's own picks for its Harness alone: a model among them is the Agent's choice, before the project's default", () => {
    const picked = agent({ engineOptions: { model: 'gpt-own', thought_level: 'high' } })
    const plan = run(picked)
    expect(plan.model).toBeUndefined()
    expect(plan.config).toEqual([
      { configId: 'model', value: 'gpt-own' },
      { configId: 'thought_level', value: 'high' },
    ])
    // An Agent's explicit service model still routes, whatever else it picked.
    expect(run(agent({ engineOptions: { thought_level: 'high' }, model: { providerId: 'own', model: 'own-model' } })).model).toEqual({
      providerId: 'own',
      model: 'own-model',
    })
  })
})
