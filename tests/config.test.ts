import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HostConfig, availableId, originOf, type ProviderRecord } from '../src/host/config.ts'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

async function dataDir() {
  const directory = await mkdtemp(join(tmpdir(), 'latch-config-'))
  directories.push(directory)
  return directory
}

const record = (id: string, extra: Partial<ProviderRecord> = {}): ProviderRecord => ({
  id, name: id, kind: 'openai-compatible', baseURL: 'https://example.test/v1', apiKey: `key-${id}`, keyOrigin: 'https://example.test:443',
  enabled: true, models: ['model-a', 'model-b'], defaultModel: 'model-a', ...extra,
})
const mode = async (file: string) => (await stat(file)).mode & 0o777
const posix = process.platform !== 'win32'

describe('HostConfig', () => {
  it('starts empty without writing files', async () => {
    const directory = await dataDir()
    const config = await HostConfig.open(directory)
    expect(config.providers()).toEqual([])
    expect(config.settings()).toEqual({ version: 1, defaults: {}, plugins: { disabled: [] }, workspaces: [], agents: [] })
    expect(await readdir(directory)).toEqual([])
  })

  it('migrates a legacy provider.json once and leaves it untouched', async () => {
    const directory = await dataDir()
    const legacy = `${JSON.stringify({ baseURL: 'https://api.deepseek.com/v1/', apiKey: 'legacy-secret', model: 'deepseek-chat' })}\n`
    await writeFile(join(directory, 'provider.json'), legacy, { mode: 0o644 })
    const config = await HostConfig.open(directory)
    expect(config.providers()).toEqual([{
      id: 'openai-compatible', name: 'DeepSeek', kind: 'openai-compatible', presetId: 'deepseek',
      baseURL: 'https://api.deepseek.com/v1/', apiKey: 'legacy-secret', keyOrigin: 'https://api.deepseek.com:443', enabled: true,
      models: ['deepseek-chat'], defaultModel: 'deepseek-chat',
    }])
    expect(await readFile(join(directory, 'provider.json'), 'utf8')).toBe(legacy)
    if (posix) expect(await mode(join(directory, 'providers.json'))).toBe(0o600)

    // providers.json now wins; later edits to the legacy file are not re-imported.
    await writeFile(join(directory, 'provider.json'), JSON.stringify({ baseURL: 'https://other.test/v1', apiKey: '', model: 'other' }))
    expect((await HostConfig.open(directory)).provider('openai-compatible')?.defaultModel).toBe('deepseek-chat')
  })

  it('names an unknown legacy endpoint generically', async () => {
    const directory = await dataDir()
    await writeFile(join(directory, 'provider.json'), JSON.stringify({ baseURL: 'http://127.0.0.1:9/v1', apiKey: '', model: 'local' }))
    expect((await HostConfig.open(directory)).provider('openai-compatible')).toMatchObject({ name: 'OpenAI 兼容接口', apiKey: '' })
    expect((await HostConfig.open(directory)).provider('openai-compatible')).not.toHaveProperty('presetId')
    expect((await HostConfig.open(directory)).provider('openai-compatible')).not.toHaveProperty('keyOrigin')
  })

  it('binds keys saved before origin binding to their current base URL and persists that once', async () => {
    const directory = await dataDir()
    const file = join(directory, 'providers.json')
    const { keyOrigin: _unbound, ...keyed } = record('keyed', { baseURL: 'http://127.0.0.1:11434/v1' })
    const { keyOrigin: _none, ...keyless } = record('keyless', { apiKey: '' })
    await writeFile(file, JSON.stringify({ version: 1, providers: [keyed, keyless] }), { mode: 0o600 })
    const config = await HostConfig.open(directory)
    expect(config.provider('keyed')?.keyOrigin).toBe('http://127.0.0.1:11434')
    expect(config.provider('keyless')).not.toHaveProperty('keyOrigin')
    const migrated = await readFile(file, 'utf8')
    expect(JSON.parse(migrated).providers.map((item: ProviderRecord) => item.keyOrigin)).toEqual(['http://127.0.0.1:11434', undefined])
    if (posix) expect(await mode(file)).toBe(0o600)

    const written = await stat(file)
    const reopened = await HostConfig.open(directory)
    expect(reopened.providers()).toEqual(config.providers())
    expect(await readFile(file, 'utf8')).toBe(migrated)
    expect((await stat(file)).ino).toBe(written.ino)
    expect(await readdir(directory)).toEqual(['providers.json'])
  })

  it('rejects a saved key without a canonical origin once migrated', async () => {
    const config = await HostConfig.open(await dataDir())
    for (const keyOrigin of [undefined, 'https://example.test', 'https://example.test:443/v1', 'HTTPS://example.test:443', 'ftp://example.test:21']) {
      await expect(config.updateProviders(draft => { draft.push(record('a', { keyOrigin })) }))
        .rejects.toMatchObject({ status: 400, code: 'invalid-provider' })
    }
    await expect(config.updateProviders(draft => { draft.push(record('a', { keyOrigin: undefined })) }))
      .rejects.toMatchObject({ message: expect.stringContaining('API Key 必须绑定保存时的服务地址') })
    expect(config.providers()).toEqual([])
    // A key bound to another origin may be stored; it is simply never sent (see usableKey).
    await config.updateProviders(draft => { draft.push(record('a', { keyOrigin: 'https://other.test:443' }), record('b', { apiKey: '', keyOrigin: undefined })) })
    expect(config.providers().map(item => [item.id, item.keyOrigin])).toEqual([['a', 'https://other.test:443'], ['b', undefined]])
    expect(originOf('https://example.test/v1')).toBe('https://example.test:443')
  })

  it.each([
    ['providers.json', '{"version":1,"providers":[{"apiKey":"sk-corrupt-secret",'],
    ['providers.json', JSON.stringify({ version: 1, providers: [{ ...record('a'), defaultModel: 'missing' }] })],
    ['settings.json', '{"version":2}'],
    ['provider.json', '{"baseURL":"not a url","apiKey":"sk-corrupt-secret","model":"m"}'],
  ])('reports a corrupt %s by name without leaking or overwriting it', async (file, content) => {
    const directory = await dataDir()
    await writeFile(join(directory, file), content)
    const failure = await HostConfig.open(directory).then(() => undefined, (error: unknown) => error)
    expect(failure).toMatchObject({ name: 'AppError', status: 500, code: 'config-corrupt', message: expect.stringContaining(file) })
    expect(String((failure as Error).message)).not.toContain('sk-corrupt-secret')
    expect(await readFile(join(directory, file), 'utf8')).toBe(content)
    expect((await readdir(directory)).sort()).toEqual([file])
  })

  it('writes 0600 files atomically and returns deep copies', async () => {
    const directory = await dataDir()
    const config = await HostConfig.open(directory)
    await config.updateProviders(draft => { draft.push(record('openai')) })
    await config.updateSettings(draft => {
      draft.defaults = { harnessId: 'standard', mode: 'agent', workspaceId: 'default', model: { providerId: 'openai', model: 'model-b' } }
      draft.workspaces.push({ id: 'site', name: '站点', path: directory })
      draft.agents.push({ id: 'codex', name: 'Codex', presetId: 'codex', command: 'codex-acp', args: [], env: { OPENAI_API_KEY: 'agent-secret' }, enabled: true })
      draft.plugins.disabled.push('safe-tools')
    })
    expect((await readdir(directory)).sort()).toEqual(['providers.json', 'settings.json'])
    if (posix) {
      expect(await mode(join(directory, 'providers.json'))).toBe(0o600)
      expect(await mode(join(directory, 'settings.json'))).toBe(0o600)
    }
    const reopened = await HostConfig.open(directory)
    expect(reopened.providers()).toEqual(config.providers())
    expect(reopened.settings()).toEqual(config.settings())
    expect(reopened.settings().agents[0]?.env).toEqual({ OPENAI_API_KEY: 'agent-secret' })

    const copy = config.providers()
    copy[0]!.models.push('mutated')
    config.settings().workspaces.length = 0
    expect(config.provider('openai')?.models).toEqual(['model-a', 'model-b'])
    expect(config.settings().workspaces).toHaveLength(1)
  })

  it.each([
    ['a default model outside the list', [record('a', { defaultModel: 'other' })], '默认模型必须在模型列表中'],
    ['duplicate IDs', [record('a'), record('a')], '服务标识不能重复'],
    ['an invalid ID', [record('A b')], '服务标识'],
    ['a URL with credentials', [record('a', { baseURL: 'https://user:pass@example.test/v1' })], '服务地址'],
    ['a key with a newline', [record('a', { apiKey: 'a\nb' })], 'API Key'],
    ['no models', [record('a', { models: [] })], '至少需要一个模型'],
  ])('rejects %s before writing', async (_label, providers, message) => {
    const directory = await dataDir()
    const config = await HostConfig.open(directory)
    await expect(config.updateProviders(draft => { draft.push(...providers) }))
      .rejects.toMatchObject({ status: 400, code: 'invalid-provider', message: expect.stringContaining(message) })
    expect(config.providers()).toEqual([])
    expect(await readdir(directory)).toEqual([])
  })

  it.each([
    ['the reserved default workspace', { workspaces: [{ id: 'default', name: 'x', path: '/tmp' }] }],
    ['a relative workspace path', { workspaces: [{ id: 'site', name: 'x', path: 'relative/dir' }] }],
    ['the built-in harness ID', { agents: [{ id: 'standard', name: 'x', command: 'x', args: [], env: {}, enabled: true }] }],
    ['an invalid env name', { agents: [{ id: 'pi', name: 'pi', command: 'pi', args: [], env: { 'BAD-NAME': 'x' }, enabled: true }] }],
  ])('rejects settings with %s', async (_label, patch) => {
    const config = await HostConfig.open(await dataDir())
    await expect(config.updateSettings(draft => { Object.assign(draft, patch) })).rejects.toMatchObject({ status: 400, code: 'invalid-settings' })
    expect(config.settings().workspaces).toEqual([])
  })

  it('aborts on a beforePublish failure without publishing or leaving temporary files', async () => {
    const directory = await dataDir()
    const config = await HostConfig.open(directory)
    await config.updateProviders(draft => { draft.push(record('a')) })
    const before = await readFile(join(directory, 'providers.json'), 'utf8')
    await expect(config.updateProviders(draft => { draft[0]!.name = 'changed' }, async next => {
      expect(next[0]?.name).toBe('changed')
      throw new Error('registry refused')
    })).rejects.toThrow('registry refused')
    expect(config.provider('a')?.name).toBe('a')
    expect(await readFile(join(directory, 'providers.json'), 'utf8')).toBe(before)
    expect(await readdir(directory)).toEqual(['providers.json'])
  })

  it('lets beforePublish place the commit inside its own transaction', async () => {
    const directory = await dataDir()
    const config = await HostConfig.open(directory)
    const order: string[] = []
    await config.updateProviders(draft => { draft.push(record('a')) }, async (_next, commit) => {
      order.push('staged')
      await commit()
      order.push(JSON.parse(await readFile(join(directory, 'providers.json'), 'utf8')).providers[0].id)
      expect(config.providers()).toEqual([])
    })
    expect(order).toEqual(['staged', 'a'])
    expect(config.provider('a')).toBeDefined()

    // Once the file is renamed, memory follows the disk even if the caller fails afterwards.
    await expect(config.updateProviders(draft => { draft[0]!.name = 'persisted' }, async (_next, commit) => {
      await commit()
      throw new Error('late failure')
    })).rejects.toThrow('late failure')
    expect(config.provider('a')?.name).toBe('persisted')
    expect((await HostConfig.open(directory)).provider('a')?.name).toBe('persisted')
  })

  it('serializes concurrent updates in call order', async () => {
    const directory = await dataDir()
    const config = await HostConfig.open(directory)
    const seen: string[][] = []
    let release: () => void = () => { throw new Error('not initialized') }
    const gate = new Promise<void>(resolve => { release = resolve })
    const first = config.updateProviders(draft => { draft.push(record('a')) }, async () => { await gate })
    const second = config.updateProviders(draft => { draft.push(record('b')) }, async next => { seen.push(next.map(item => item.id)) })
    const failed = config.updateProviders(() => { throw new Error('bad mutation') })
    const third = config.updateProviders(draft => { draft.push(record('c')) })
    await Promise.resolve()
    expect(seen).toEqual([])
    release()
    await Promise.all([first, second, third])
    await expect(failed).rejects.toThrow('bad mutation')
    expect(seen).toEqual([['a', 'b']])
    expect(config.providers().map(item => item.id)).toEqual(['a', 'b', 'c'])
    expect(JSON.parse(await readFile(join(directory, 'providers.json'), 'utf8')).providers.map((item: ProviderRecord) => item.id)).toEqual(['a', 'b', 'c'])
  })

  it.runIf(posix)('tightens a hand-created secrets file to 0600', async () => {
    const directory = await dataDir()
    const file = join(directory, 'providers.json')
    await writeFile(file, JSON.stringify({ version: 1, providers: [record('a')] }))
    await chmod(file, 0o644)
    await HostConfig.open(directory)
    expect(await mode(file)).toBe(0o600)
  })

  it('derives free IDs from names', () => {
    expect(availableId('DeepSeek', [])).toBe('deepseek')
    expect(availableId('deepseek', ['deepseek', 'deepseek-2'])).toBe('deepseek-3')
    expect(availableId('智谱 GLM', [])).toBe('glm')
    expect(availableId('自定义', [])).toBe('item')
  })
})
