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
  panels: UiPanelDefinition[]
  clientPanels: Array<ClientPanelDefinition & { hash: string }>
  skills: SkillDefinition[]
  disposers: Array<() => void | Promise<void>>
  cleanupFailures: unknown[]
  fiber?: Fiber
}

export interface RegisterOptions {
  managed?: PluginInfo['managed']
}
export interface ReplaceOptions extends RegisterOptions {
  /** Keep a plugin the user disabled disabled; the new generation is installed without activation. */
  preserveEnabled?: boolean
}
export interface AcquireOptions {
  /** `false` leases only the provider's plugin, so tool plugins stay free to change during chat runs. */
  tools?: boolean
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

  private newEntry(plugin: HarnessPlugin, managed?: PluginInfo['managed']): Entry {
    return {
      plugin,
      ...(managed ? { managed } : {}),
      enabled: false,
      leases: 0,
      runs: 0,
      providers: [],
      tools: [],
      harnesses: [],
      panels: [],
      clientPanels: [],
      skills: [],
      disposers: [],
      cleanupFailures: [],
    }
  }

  register(plugin: HarnessPlugin, options: RegisterOptions = {}): void {
    if (this.mutating.has(plugin.id)) throw new AppError(409, 'plugin-busy', '插件正在变更，请稍后重试')
    if (this.entries.has(plugin.id)) throw new AppError(409, 'plugin-exists', `插件 ${plugin.id} 已安装`)
    this.entries.set(plugin.id, this.newEntry(plugin, options.managed))
  }

  async enable(id: string): Promise<void> {
    const entry = this.entry(id)
    if (entry.enabled) return
    if (this.mutating.has(id)) throw new AppError(409, 'plugin-busy', '插件正在变更，请稍后重试')
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
    if (this.leases(id)) throw new AppError(409, 'plugin-in-use', `${IN_USE}停用`)
    if (this.mutating.has(id)) throw new AppError(409, 'plugin-busy', '插件正在变更，请稍后重试')
    this.mutating.add(id)
    try {
      await this.dispose(entry)
    } finally {
      this.mutating.delete(id)
    }
  }

  /** Disables and forgets a plugin. The entry is forgotten even when its cleanup reports failures. */
  async unregister(id: string): Promise<void> {
    const entry = this.entry(id)
    if (this.leases(id)) throw new AppError(409, 'plugin-in-use', `${IN_USE}删除`)
    if (this.mutating.has(id)) throw new AppError(409, 'plugin-busy', '插件正在变更，请稍后重试')
    this.mutating.add(id)
    try {
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

  acquire(providerId: string, options: AcquireOptions = {}): CapabilityLease {
    const selected = [...this.entries.values()].filter(e => e.enabled)
    const owner = selected.find(e => e.providers.some(p => p.id === providerId))
    const provider = owner?.providers.find(p => p.id === providerId)
    if (!owner || !provider) throw new AppError(409, 'provider-unavailable', '请先配置并启用模型接口')
    const withTools = options.tools !== false
    const contributors = selected.filter(e => e === owner || e.skills.length || (withTools && e.tools.length))
    if (contributors.some(entry => this.mutating.has(entry.plugin.id))) {
      throw new AppError(409, 'plugin-busy', '本次任务需要的插件正在变更，请稍后重试')
    }
    const tools = withTools ? contributors.flatMap(e => e.tools) : []
    const skills = contributors.flatMap(entry => entry.skills.map(skill => ({ ...skill, id: `${entry.plugin.id}:${skill.id}` })))
    if (skills.reduce((size, skill) => size + skill.content.length, 0) > 256_000) {
      throw new AppError(409, 'skills-too-large', '已启用技能的总长度超过 256 KB，请停用部分需求包后重试。')
    }
    return { provider, tools, ...(skills.length ? { skills } : {}), release: this.lease(contributors, true) }
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
      ...('hash' in panel ? { moduleHash: panel.hash } : {}),
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
    if (this.mutating.has(entry.plugin.id)) throw new AppError(409, 'plugin-busy', '面板插件正在变更，请稍后重试。')
    return { info: this.panelInfo(entry, panel), source: panel.source, release: this.lease([entry], false) }
  }

  acquireUiPanel(id: string): UiPanelLease {
    const entry = [...this.entries.values()].find(item => item.enabled && item.panels.some(panel => `${item.plugin.id}:${panel.id}` === id))
    const panel = entry?.panels.find(item => `${entry.plugin.id}:${item.id}` === id)
    if (!entry || !panel) throw new AppError(404, 'ui-panel-unavailable', '这个扩展面板已停用或移除。')
    if (this.mutating.has(entry.plugin.id)) throw new AppError(409, 'plugin-busy', '面板插件正在变更，请稍后重试。')
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
        ...e.panels.map(panel => `${panel.listed === false ? 'data' : 'ui'}:${panel.id}`),
        ...e.clientPanels.map(panel => `ui:${panel.id}`),
        ...e.skills.map(skill => `skill:${skill.id}`),
      ],
      ...(e.managed ? { managed: e.managed } : {}),
    }))
  }

  acquireHarness(id: string): HarnessLease {
    const entry = [...this.entries.values()].find(entry => entry.enabled && entry.harnesses.some(driver => driver.id === id))
    const driver = entry?.harnesses.find(driver => driver.id === id)
    if (!entry || !driver) throw new AppError(409, 'harness-unavailable', `请先配置并启用 Harness ${id}`)
    if (this.mutating.has(entry.plugin.id)) throw new AppError(409, 'plugin-busy', 'Harness 插件正在变更，请稍后重试')
    return { driver, release: this.lease([entry], false) }
  }

  /**
   * Stage activation, persist external state, then publish the new generation without another await.
   * A previous generation that still holds leases keeps serving them and is disposed after the last
   * release. Once published, cleanup failures of the old generation are logged, not thrown.
   */
  async replace(plugin: HarnessPlugin, beforeCommit?: () => Promise<void>, options: ReplaceOptions = {}): Promise<void> {
    const previous = this.entries.get(plugin.id)
    if (this.mutating.has(plugin.id)) throw new AppError(409, 'plugin-busy', '插件正在变更，请稍后重试')
    const staged = this.newEntry(plugin, options.managed ?? previous?.managed)
    const keepDisabled = options.preserveEnabled === true && previous !== undefined && !previous.enabled
    this.mutating.add(plugin.id)
    this.staged.set(plugin.id, staged)
    let committed = false
    try {
      if (!keepDisabled) await this.activate(staged, previous)
      await beforeCommit?.()
      staged.enabled = !keepDisabled
      this.entries.set(plugin.id, staged)
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
    if (this.mutating.size) throw new AppError(409, 'plugin-busy', '插件正在变更，请稍后关闭')
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
