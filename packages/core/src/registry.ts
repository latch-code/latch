import { randomUUID } from 'node:crypto'
import { Context, type Fiber } from 'cordis'
import type { PluginInfo, SkillInfo, UiPanelInfo } from '@latch/protocol'
import {
  AppError,
  type HarnessDriver,
  type CapabilityLease,
  type HarnessLease,
  type HarnessPlugin,
  type ModelProvider,
  type PluginContext,
  type RuntimeRegistry,
  type ToolDefinition,
  type UiPanelDefinition,
  type UiPanelLease,
  type ClientPanelDefinition,
  type ClientPanelLease,
  type SkillDefinition,
  type TransportDriver,
  type TransportLease,
} from '@latch/sdk'
import { z } from 'zod'
import { checkedClientPanel, checkedUiPanel, renderUiPanel } from './ui-panels.ts'
import { sha256Hex } from './node-kit/digest.ts'

const skillSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u),
    name: z.string().trim().min(1).max(80),
    description: z.string().max(500),
    content: z.string().trim().min(1).max(32_000),
  })
  .strict()

interface Entry {
  revision?: string
  activation: string
  plugin: HarnessPlugin
  managed?: PluginInfo['managed']
  enabled: boolean
  /** Every lease: runs and harness mounts. A plugin with any cannot be disabled, removed or collected. */
  leases: number
  /** Leases of runs only (`acquire`), which is what the plugin list calls in use; a mounted harness is not a run. */
  runs: number
  providers: ModelProvider[]
  tools: ToolDefinition[]
  harnesses: HarnessDriver[]
  transports: TransportDriver[]
  transportLeases: Set<{ invalidate(): void; done: Promise<void> }>
  panels: UiPanelDefinition[]
  clientPanels: Array<ClientPanelDefinition & { hash: string }>
  skills: SkillDefinition[]
  disposers: Array<() => void | Promise<void>>
  cleanupFailures: unknown[]
  fiber?: Fiber
}

export interface RegisterOptions {
  /** Host-verified complete applied source/config revision. Absence means this activation only. */
  revision?: string
  managed?: PluginInfo['managed']
}
export interface ReplaceOptions extends RegisterOptions {
  /** Keep a plugin the user disabled disabled; the new generation is installed without activation. */
  preserveEnabled?: boolean
}
export interface AcquireOptions {
  /** A saved execution grant must still name exactly these enabled plugin revisions. */
  expectedRevisions?: Readonly<Record<string, string>>
  /** `pluginId:skillId` to lease, from any enabled plugin; `pluginIds` then limits tools only. */
  skillIds?: string[]
  /** Explicit capability owners; an empty list leases no tools or skills. Provider availability is independent. */
  pluginIds?: ReadonlyArray<string>
  /** `false` leases only the provider's plugin, so tool plugins stay free to change during chat runs. */
  tools?: boolean
}
export interface PluginRevisionSnapshot {
  revisions: Record<string, string>
  persistent: boolean
}
export type RegistryLogger = (message: string, error: unknown) => void

const IN_USE = '任务、界面读取或当前加载的 Harness 正在使用此插件，请结束任务或关闭节点后再'

/** Cordis owns plugin fibers; leases and staged publication are application policy. */
export class PluginRegistry implements RuntimeRegistry {
  private readonly root: Context
  private readonly log: RegistryLogger
  private readonly entries = new Map<string, Entry>()
  private readonly mutating = new Set<string>()
  private readonly staged = new Map<string, Entry>()
  /** Replaced generations that still serve leases; each is disposed when its last lease ends. */
  private readonly retired = new Set<Entry>()
  private readonly disposals = new Set<Promise<void>>()

  constructor(
    root: Context = new Context(),
    log: RegistryLogger = (message, error) => console.error(`[Latch] ${message}:`, error instanceof Error ? error.message : error),
  ) {
    this.root = root
    this.log = log
  }

  private newEntry(plugin: HarnessPlugin, managed?: PluginInfo['managed'], revision?: string): Entry {
    if (revision !== undefined && !/^[a-f0-9]{64}$/u.test(revision))
      throw new AppError(400, 'plugin-revision-invalid', '插件修订摘要无效。')
    return {
      plugin,
      activation: randomUUID(),
      ...(revision ? { revision } : {}),
      ...(managed ? { managed } : {}),
      enabled: false,
      leases: 0,
      runs: 0,
      providers: [],
      tools: [],
      harnesses: [],
      transports: [],
      transportLeases: new Set(),
      panels: [],
      clientPanels: [],
      skills: [],
      disposers: [],
      cleanupFailures: [],
    }
  }

  register(plugin: HarnessPlugin, options: RegisterOptions = {}): void {
    if (this.mutating.has(plugin.id)) throw new AppError(409, 'plugin-busy', '插件正在更新，请稍后重试')
    if (this.entries.has(plugin.id)) throw new AppError(409, 'plugin-exists', `插件 ${plugin.id} 已安装`)
    this.entries.set(plugin.id, this.newEntry(plugin, options.managed, options.revision))
  }

  async enable(id: string): Promise<void> {
    const entry = this.entry(id)
    if (entry.enabled) return
    if (this.mutating.has(id)) throw new AppError(409, 'plugin-busy', '插件正在更新，请稍后重试')
    this.mutating.add(id)
    try {
      await this.activate(entry)
      entry.enabled = true
    } catch (error) {
      try {
        await this.dispose(entry)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Plugin activation and cleanup failed')
      }
      throw error
    } finally {
      this.mutating.delete(id)
    }
  }

  private async activate(entry: Entry, previous?: Entry): Promise<void> {
    entry.activation = randomUUID()
    // A retired generation is no longer acquirable, so its registrations do not block a new one.
    const candidates = () => [...this.entries.values(), ...this.staged.values()].filter(other => other !== previous)
    const loading = this.root.plugin({
      name: entry.plugin.id,
      apply: async (ctx: Context) => {
        // One effect preserves awaited LIFO cleanup even though Cordis unloads
        // independent effects concurrently and only logs their exceptions.
        ctx.effect(() => () => this.cleanup(entry), 'Latch plugin contributions')
        const context: PluginContext = {
          registerProvider: provider => {
            ctx.fiber.assertActive()
            if (candidates().some(e => e.providers.some(p => p.id === provider.id))) {
              throw new AppError(409, 'provider-exists', `模型接口 ${provider.id} 已注册`)
            }
            entry.providers.push(provider)
          },
          registerTool: tool => {
            ctx.fiber.assertActive()
            if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)) throw new Error('Invalid tool name')
            if (candidates().some(e => e.tools.some(t => t.name === tool.name))) {
              throw new AppError(409, 'tool-exists', `工具 ${tool.name} 已注册`)
            }
            entry.tools.push(tool)
          },
          registerHarness: driver => {
            ctx.fiber.assertActive()
            if (!/^[a-zA-Z0-9_-]{1,64}$/.test(driver.id)) throw new Error('Invalid harness id')
            if (candidates().some(e => e.harnesses.some(h => h.id === driver.id))) {
              throw new AppError(409, 'harness-exists', `Harness ${driver.id} 已注册`)
            }
            entry.harnesses.push(driver)
          },
          registerTransport: driver => {
            ctx.fiber.assertActive()
            if (
              !/^[A-Za-z0-9_-]{1,64}$/u.test(driver.id)
              || !['native-stream-v1', 'latch-relay-v1', 'latch-relay-v2'].includes(driver.profile)
              || typeof driver.open !== 'function'
              || (driver.listen !== undefined && typeof driver.listen !== 'function')
            )
              throw new AppError(400, 'transport-invalid', '连接插件的传输声明无效。')
            if (candidates().some(e => e.transports.some(item => item.id === driver.id)))
              throw new AppError(409, 'transport-exists', '连接传输标识已注册。')
            const descriptors = z
              .array(
                z.strictObject({
                  version: z.literal(1),
                  driverId: z.literal(driver.id),
                  channelId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
                  endpoint: z.string().min(1).max(1024),
                }),
              )
              .max(16)
              .parse(driver.descriptors ?? [])
            if (new Set(descriptors.map(value => value.channelId)).size !== descriptors.length)
              throw new AppError(400, 'transport-invalid', '连接通道标识重复。')
            if (
              candidates().reduce(
                (sum, owner) => sum + owner.transports.reduce((count, item) => count + (item.descriptors?.length ?? 0), 0),
                0,
              )
                + descriptors.length
              > 8
            )
              throw new AppError(409, 'transport-limit', '最多启用八个插件连接通道。')
            entry.transports.push({
              id: driver.id,
              profile: driver.profile,
              descriptors: Object.freeze(descriptors.map(value => Object.freeze(value))),
              open: input => driver.open(input),
              ...(driver.listen ? { listen: input => driver.listen!(input) } : {}),
            })
          },
          registerUiPanel: panel => {
            ctx.fiber.assertActive()
            const checked = checkedUiPanel(panel)
            if ([...entry.panels, ...entry.clientPanels].some(item => item.id === checked.id))
              throw new AppError(409, 'ui-panel-exists', '扩展面板标识重复。')
            entry.panels.push(checked)
          },
          registerClientPanel: panel => {
            ctx.fiber.assertActive()
            const checked = checkedClientPanel(panel)
            if ([...entry.panels, ...entry.clientPanels].some(item => item.id === checked.id))
              throw new AppError(409, 'ui-panel-exists', '扩展面板标识重复。')
            entry.clientPanels.push({ ...checked, hash: sha256Hex(checked.source) })
          },
          registerSkill: skill => {
            ctx.fiber.assertActive()
            const checked = skillSchema.parse(skill)
            if (entry.skills.some(item => item.id === checked.id)) throw new AppError(409, 'skill-exists', '技能标识重复。')
            entry.skills.push(checked)
          },
          onDispose: disposer => {
            ctx.fiber.assertActive()
            entry.disposers.push(disposer)
          },
        }
        await entry.plugin.activate(context)
      },
    })
    // Save the handle before awaiting: a failed activation still owns a fiber.
    entry.fiber = loading
    await loading
  }

  async disable(id: string): Promise<void> {
    const entry = this.entry(id)
    const transports = this.transportLeases(id)
    if (this.leases(id) > transports.length) throw new AppError(409, 'plugin-in-use', `${IN_USE}停用`)
    if (this.mutating.has(id)) throw new AppError(409, 'plugin-busy', '插件正在更新，请稍后重试')
    this.mutating.add(id)
    try {
      entry.enabled = false
      for (const lease of transports) lease.invalidate()
      await Promise.all(transports.map(lease => lease.done))
      await this.dispose(entry)
    } finally {
      this.mutating.delete(id)
    }
  }

  /** Stop new acquisitions immediately; existing leases own the old generation until their real settlement. */
  retire(id: string, forget = false): void {
    const entry = this.entry(id)
    if (this.mutating.has(id)) throw new AppError(409, 'plugin-busy', '插件正在更新，请稍后重试')
    entry.enabled = false
    for (const lease of entry.transportLeases) lease.invalidate()
    if (forget) this.entries.delete(id)
    else this.entries.set(id, this.newEntry(entry.plugin, entry.managed, entry.revision))
    if (entry.leases) this.retired.add(entry)
    else this.collect(entry)
  }

  /** Disables and forgets a plugin. The entry is forgotten even when its cleanup reports failures. */
  async unregister(id: string): Promise<void> {
    const entry = this.entry(id)
    const transports = this.transportLeases(id)
    if (this.leases(id) > transports.length) throw new AppError(409, 'plugin-in-use', `${IN_USE}删除`)
    if (this.mutating.has(id)) throw new AppError(409, 'plugin-busy', '插件正在更新，请稍后重试')
    this.mutating.add(id)
    try {
      entry.enabled = false
      for (const lease of transports) lease.invalidate()
      await Promise.all(transports.map(lease => lease.done))
      await this.dispose(entry)
    } finally {
      if (this.entries.get(id) === entry) this.entries.delete(id)
      this.mutating.delete(id)
    }
  }

  private async dispose(entry: Entry): Promise<void> {
    entry.enabled = false
    const fiber = entry.fiber
    entry.fiber = undefined
    await fiber?.dispose()
    const failures = entry.cleanupFailures.splice(0)
    if (failures.length) throw new AggregateError(failures, 'Plugin cleanup failed')
  }

  private async cleanup(entry: Entry): Promise<void> {
    entry.enabled = false
    entry.providers = []
    entry.tools = []
    entry.harnesses = []
    entry.transports = []
    entry.panels = []
    entry.clientPanels = []
    entry.skills = []
    const disposers = entry.disposers.splice(0).reverse()
    for (const dispose of disposers) {
      try {
        await dispose()
      } catch (error) {
        entry.cleanupFailures.push(error)
      }
    }
  }

  /** Leases (or with `runs`, run leases) held by every generation of a plugin, including retired ones still finishing runs. */
  private transportLeases(id: string): Array<{ invalidate(): void; done: Promise<void> }> {
    return [...this.entries.values(), ...this.retired].filter(entry => entry.plugin.id === id).flatMap(entry => [...entry.transportLeases])
  }

  private leases(id: string, count: 'leases' | 'runs' = 'leases'): number {
    let total = this.entries.get(id)?.[count] ?? 0
    for (const entry of this.retired) if (entry.plugin.id === id) total += entry[count]
    return total
  }

  /** `run`: the lease of a run, counted in the plugin list; a harness mount holds the other kind. */
  private lease(entries: Entry[], run: boolean): () => void {
    for (const entry of entries) {
      entry.leases++
      if (run) entry.runs++
    }
    let released = false
    return () => {
      if (released) return
      released = true
      for (const entry of entries) {
        entry.leases--
        if (run) entry.runs--
        if (!entry.leases && this.retired.delete(entry)) this.collect(entry)
      }
    }
  }

  /** Disposes a retired generation outside the caller's stack; nobody awaits a lease release. */
  private collect(entry: Entry): void {
    const disposal = this.dispose(entry).catch(error => {
      this.log(`Retired plugin ${entry.plugin.id} cleanup failed`, error)
    })
    this.disposals.add(disposal)
    void disposal.finally(() => this.disposals.delete(disposal))
  }

  /** A conservative revision for legacy closures; only a Host-supplied content revision survives restart. */
  revisionSnapshot(ids: ReadonlyArray<string>): PluginRevisionSnapshot {
    if (ids.length > 128 || ids.some(id => !/^[A-Za-z0-9_-]{1,64}$/u.test(id)))
      throw new AppError(400, 'plugin-revision-invalid', '插件修订范围无效。')
    const revisions = new Map<string, string>()
    let persistent = true
    for (const id of [...new Set(ids)].sort()) {
      const entry = this.entries.get(id)
      if (!entry?.enabled) throw new AppError(409, 'plugin-unavailable', '需要的插件已停用或移除。')
      if (this.mutating.has(id)) throw new AppError(409, 'plugin-busy', '需要的插件正在更新，请稍后重试。')
      revisions.set(id, entry.revision ?? sha256Hex('latch-plugin-activation-v1\0' + entry.activation))
      if (entry.revision === undefined) persistent = false
    }
    return { revisions: Object.fromEntries(revisions), persistent }
  }
  providerOwner(providerId: string): string | undefined {
    return [...this.entries.values()].find(entry => entry.enabled && entry.providers.some(provider => provider.id === providerId))?.plugin
      .id
  }

  acquire(providerId: string, options: AcquireOptions = {}): CapabilityLease {
    if (options.expectedRevisions !== undefined) {
      const ids = Object.keys(options.expectedRevisions)
      const current = this.revisionSnapshot(ids)
      if (ids.some(id => current.revisions[id] !== options.expectedRevisions![id]))
        throw new AppError(409, 'plugin-revision-changed', '插件已更新，原执行授权暂停，请重新确认设置。')
    }
    const selected = [...this.entries.values()].filter(e => e.enabled)
    const owner = selected.find(e => e.providers.some(p => p.id === providerId))
    const provider = owner?.providers.find(p => p.id === providerId)
    if (!owner || !provider) throw new AppError(409, 'provider-unavailable', '请先配置并启用模型接口')
    const withTools = options.tools !== false
    const requested = options.pluginIds === undefined ? undefined : new Set(options.pluginIds)
    if (requested && [...requested].some(id => !selected.some(entry => entry.plugin.id === id)))
      throw new AppError(409, 'agent-plugin-unavailable', '选择的插件已停用或移除，请更新这个 Agent。')
    const capabilities = selected.filter(entry => requested === undefined || requested.has(entry.plugin.id))
    const skillIds = options.skillIds === undefined ? undefined : new Set(options.skillIds)
    const skillOwners = skillIds
      ? selected.filter(entry => entry.skills.some(skill => skillIds.has(`${entry.plugin.id}:${skill.id}`)))
      : capabilities
    const contributors = [
      ...new Set([owner, ...capabilities.filter(e => withTools && e.tools.length), ...skillOwners.filter(e => e.skills.length)]),
    ]
    // Only what the run actually receives: a plugin giving it nothing, such as an engine, is not part of the authority.
    if (options.expectedRevisions !== undefined && contributors.some(entry => !Object.hasOwn(options.expectedRevisions!, entry.plugin.id)))
      throw new AppError(409, 'plugin-revision-missing', '执行授权缺少实际插件修订，请重新确认设置。')
    if (contributors.some(entry => this.mutating.has(entry.plugin.id))) {
      throw new AppError(409, 'plugin-busy', '本次任务需要的插件正在更新，请稍后重试')
    }
    const tools = withTools ? capabilities.flatMap(e => e.tools) : []
    const skills = skillOwners
      .flatMap(entry => entry.skills.map(skill => ({ ...skill, id: `${entry.plugin.id}:${skill.id}` })))
      .filter(skill => skillIds === undefined || skillIds.has(skill.id))
    if (skillIds && skills.length !== skillIds.size)
      throw new AppError(409, 'agent-skill-unavailable', '选择的技能已停用或移除，请更新这个 Agent。')
    if (skills.reduce((size, skill) => size + skill.content.length, 0) > 256_000) {
      throw new AppError(409, 'skills-too-large', '已启用技能的总长度超过 256 KB，请停用部分插件后重试。')
    }
    return { provider, tools, ...(skills.length ? { skills } : {}), release: this.lease(contributors, true) }
  }

  /** The text of enabled skills by `pluginId:skillId`, for the skills server; same limit as a lease. */
  skillBodies(ids: readonly string[]): Array<{ id: string; name: string; description: string; content: string }> {
    const wanted = new Set(ids)
    const skills = [...this.entries.values()]
      .filter(entry => entry.enabled)
      .flatMap(entry => entry.skills.map(skill => ({ ...skill, id: `${entry.plugin.id}:${skill.id}` })))
      .filter(skill => wanted.has(skill.id))
    if (skills.length !== wanted.size) throw new AppError(409, 'agent-skill-unavailable', '选择的技能已停用或移除，请更新这个 Agent。')
    if (skills.reduce((size, skill) => size + skill.content.length, 0) > 256_000)
      throw new AppError(409, 'skills-too-large', '已启用技能的总长度超过 256 KB，请停用部分插件后重试。')
    return skills.map(({ id, name, description, content }) => ({ id, name, description, content }))
  }

  /** Providers of enabled plugins, for catalogs. Use `acquire` to run one. */
  providers(): ModelProvider[] {
    return [...this.entries.values()].filter(e => e.enabled).flatMap(e => e.providers)
  }

  /** Harness drivers of enabled plugins, for catalogs. Use `acquireHarness` to run one. */
  harnesses(): HarnessDriver[] {
    return [...this.entries.values()].filter(e => e.enabled).flatMap(e => e.harnesses)
  }

  skills(): SkillInfo[] {
    return [...this.entries.values()]
      .filter(entry => entry.enabled)
      .flatMap(entry =>
        entry.skills.map(skill => ({
          id: `${entry.plugin.id}:${skill.id}`,
          pluginId: entry.plugin.id,
          pluginName: entry.plugin.name,
          name: skill.name,
          description: skill.description,
        })),
      )
  }

  private panelInfo(entry: Entry, panel: UiPanelDefinition | (ClientPanelDefinition & { hash: string })): UiPanelInfo {
    return {
      id: `${entry.plugin.id}:${panel.id}`,
      pluginId: entry.plugin.id,
      pluginName: entry.plugin.name,
      title: panel.title,
      ...(panel.description === undefined ? {} : { description: panel.description }),
      ...(panel.harnessIds === undefined ? {} : { harnessIds: [...panel.harnessIds] }),
      ...('hash' in panel ? { moduleHash: panel.hash, ...(panel.context ? { context: true } : {}) } : {}),
    }
  }

  uiPanels(): UiPanelInfo[] {
    return [...this.entries.values()]
      .filter(entry => entry.enabled)
      .flatMap(entry =>
        [...entry.panels.filter(panel => panel.listed !== false), ...entry.clientPanels].map(panel => this.panelInfo(entry, panel)),
      )
  }

  acquireClientPanel(id: string, hash: string): ClientPanelLease {
    const entry = [...this.entries.values()].find(
      item => item.enabled && item.clientPanels.some(panel => `${item.plugin.id}:${panel.id}` === id && panel.hash === hash),
    )
    const panel = entry?.clientPanels.find(item => `${entry.plugin.id}:${item.id}` === id && item.hash === hash)
    if (!entry || !panel) throw new AppError(404, 'ui-panel-unavailable', '这个界面模块已更新或停用，请刷新。')
    if (this.mutating.has(entry.plugin.id)) throw new AppError(409, 'plugin-busy', '面板插件正在更新，请稍后重试。')
    return { info: this.panelInfo(entry, panel), source: panel.source, release: this.lease([entry], false) }
  }

  acquireUiPanel(id: string): UiPanelLease {
    const entry = [...this.entries.values()].find(item => item.enabled && item.panels.some(panel => `${item.plugin.id}:${panel.id}` === id))
    const panel = entry?.panels.find(item => `${entry.plugin.id}:${item.id}` === id)
    if (!entry || !panel) throw new AppError(404, 'ui-panel-unavailable', '这个扩展面板已停用或移除。')
    if (this.mutating.has(entry.plugin.id)) throw new AppError(409, 'plugin-busy', '面板插件正在更新，请稍后重试。')
    return {
      info: this.panelInfo(entry, panel),
      render: context => renderUiPanel(panel, context, this.log),
      release: this.lease([entry], false),
    }
  }

  list(): PluginInfo[] {
    return [...this.entries.values()].map(e => ({
      id: e.plugin.id,
      name: e.plugin.name,
      version: e.plugin.version,
      description: e.plugin.description,
      ...(e.plugin.package ? { package: e.plugin.package } : {}),
      enabled: e.enabled,
      activeRuns: this.leases(e.plugin.id, 'runs'),
      capabilities: [
        ...e.providers.map(p => `provider:${p.id}`),
        ...e.tools.map(t => `tool:${t.name}`),
        ...e.harnesses.map(h => `harness:${h.id}`),
        ...e.transports.map(driver => `transport:${driver.id}`),
        ...e.panels.map(panel => `${panel.listed === false ? 'data' : 'ui'}:${panel.id}`),
        ...e.clientPanels.flatMap(panel => [`ui:${panel.id}`, ...(panel.context ? [`ui-context:${panel.id}`] : [])]),
        ...e.skills.map(skill => `skill:${skill.id}`),
      ],
      ...(e.managed ? { managed: e.managed } : {}),
    }))
  }

  transports(): Array<{
    id: string
    profile: TransportDriver['profile']
    descriptors: ReadonlyArray<import('@latch/sdk').TransportDescriptor>
  }> {
    return [...this.entries.values()]
      .filter(entry => entry.enabled)
      .flatMap(entry =>
        entry.transports.map(driver => ({
          id: driver.id,
          profile: driver.profile,
          descriptors: driver.descriptors ?? [],
        })),
      )
  }

  acquireTransport(id: string): TransportLease {
    const entry = [...this.entries.values()].find(entry => entry.enabled && entry.transports.some(driver => driver.id === id))
    const driver = entry?.transports.find(driver => driver.id === id)
    if (!entry || !driver) throw new AppError(409, 'transport-unavailable', '请先安装并启用这个连接插件。')
    if (this.mutating.has(entry.plugin.id)) throw new AppError(409, 'plugin-busy', '连接插件正在更新，请稍后重试。')
    let invalidate!: () => void,
      finish!: () => void,
      released = false
    const invalidated = new Promise<void>(resolve => {
        invalidate = resolve
      }),
      done = new Promise<void>(resolve => {
        finish = resolve
      }),
      reference = { invalidate, done },
      release = this.lease([entry], false)
    entry.transportLeases.add(reference)
    return {
      driver,
      isCurrent: () => this.entries.get(entry.plugin.id) === entry && entry.enabled && !this.mutating.has(entry.plugin.id),
      invalidated,
      release() {
        if (released) return
        released = true
        entry.transportLeases.delete(reference)
        release()
        finish()
      },
    }
  }

  acquireHarness(id: string): HarnessLease {
    const entry = [...this.entries.values()].find(entry => entry.enabled && entry.harnesses.some(driver => driver.id === id))
    const driver = entry?.harnesses.find(driver => driver.id === id)
    if (!entry || !driver) throw new AppError(409, 'harness-unavailable', `请先配置并启用 Harness ${id}`)
    if (this.mutating.has(entry.plugin.id)) throw new AppError(409, 'plugin-busy', 'Harness 插件正在更新，请稍后重试')
    return { driver, release: this.lease([entry], false) }
  }

  /**
   * Stage activation, persist external state, then publish the new generation without another await.
   * A previous generation that still holds leases keeps serving them and is disposed after the last
   * release. Once published, cleanup failures of the old generation are logged, not thrown.
   */
  async replace(plugin: HarnessPlugin, beforeCommit?: () => Promise<void>, options: ReplaceOptions = {}): Promise<void> {
    const previous = this.entries.get(plugin.id)
    if (this.mutating.has(plugin.id)) throw new AppError(409, 'plugin-busy', '插件正在更新，请稍后重试')
    const staged = this.newEntry(plugin, options.managed ?? previous?.managed, options.revision)
    const keepDisabled = options.preserveEnabled === true && previous !== undefined && !previous.enabled
    this.mutating.add(plugin.id)
    this.staged.set(plugin.id, staged)
    let committed = false
    try {
      if (!keepDisabled) await this.activate(staged, previous)
      await beforeCommit?.()
      staged.enabled = !keepDisabled
      this.entries.set(plugin.id, staged)
      if (previous) for (const lease of previous.transportLeases) lease.invalidate()
      committed = true
      if (previous?.leases) this.retired.add(previous)
      else if (previous)
        await this.dispose(previous).catch(error => {
          this.log(`Replaced plugin ${plugin.id} cleanup failed`, error)
        })
    } catch (error) {
      if (!committed) {
        try {
          await this.dispose(staged)
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Plugin replacement and cleanup failed')
        }
      }
      throw error
    } finally {
      this.staged.delete(plugin.id)
      this.mutating.delete(plugin.id)
    }
  }

  async close(): Promise<void> {
    if (this.retired.size || [...this.entries.values()].some(entry => entry.leases)) {
      throw new AppError(409, 'plugin-in-use', '关闭插件前必须释放任务与 Harness')
    }
    if (this.mutating.size) throw new AppError(409, 'plugin-busy', '插件正在更新，请稍后关闭')
    const failures: unknown[] = []
    for (const id of [...this.entries.keys()].reverse()) {
      try {
        await this.disable(id)
      } catch (error) {
        failures.push(error)
      }
    }
    await Promise.all(this.disposals)
    await this.root.fiber.dispose()
    if (failures.length) throw new AggregateError(failures, 'Plugin registry cleanup failed')
  }

  private entry(id: string): Entry {
    const entry = this.entries.get(id)
    if (!entry) throw new AppError(404, 'plugin-not-found', '找不到该插件')
    return entry
  }
}
