import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DENY_READ_HOME_PATHS, canonicalPath, checkPrivateFile, checkWorkspaceCandidate, classifyDefaultWorkspace, hasProtectedComponent,
  isProtectedWorkspacePath, latchCodeRoot, prepareRuntimeDir, resolveLatchPaths, type WorkspaceGuardContext,
} from '../src/host/paths.ts'

const cleanups: string[] = []
afterEach(() => { for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true }) })

/** Short base so socket paths stay under the 104-byte limit on macOS. */
function temp(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'hl-paths-')))
  cleanups.push(path)
  return path
}

const uid = process.getuid!()

describe('resolveLatchPaths', () => {
  const none = () => false

  it('uses flag, then env, then a legacy ./.runtime, then the platform default', () => {
    const base = { env: {}, cwd: '/work', home: '/Users/me', platform: 'darwin' as const, exists: none }
    expect(resolveLatchPaths({ ...base, dataDir: 'data' })).toMatchObject({ dataDir: '/work/data', dataDirSource: 'flag' })
    expect(resolveLatchPaths({ ...base, env: { HARNESS_DATA_DIR: '/srv/latch' } })).toMatchObject({ dataDir: '/srv/latch', dataDirSource: 'env' })
    const legacy = resolveLatchPaths({ ...base, exists: path => path === '/work/.runtime' })
    expect(legacy).toMatchObject({ dataDir: '/work/.runtime', dataDirSource: 'legacy-runtime' })
    expect(legacy.warnings[0]).toBe('正在使用旧的数据目录 /work/.runtime。新安装默认使用 /Users/me/Library/Application Support/Latch/Host；如需迁移，请停止 Host 后移动目录并用 --data-dir 指定。')
    expect(resolveLatchPaths(base)).toMatchObject({
      dataDir: '/Users/me/Library/Application Support/Latch/Host', dataDirSource: 'default',
      agentsDir: '/Users/me/Library/Application Support/Latch/Agents', warnings: [],
    })
  })

  it('follows XDG on Linux and APPDATA on Windows', () => {
    expect(resolveLatchPaths({ env: {}, cwd: '/w', home: '/home/me', platform: 'linux', exists: none }))
      .toMatchObject({ dataDir: '/home/me/.local/share/latch/host', agentsDir: '/home/me/.local/share/latch/agents', workspaceRoot: '/home/me/Latch/workspace' })
    expect(resolveLatchPaths({ env: { XDG_DATA_HOME: '/xdg' }, cwd: '/w', home: '/home/me', platform: 'linux', exists: none }))
      .toMatchObject({ dataDir: '/xdg/latch/host', agentsDir: '/xdg/latch/agents' })
    expect(resolveLatchPaths({ env: { XDG_DATA_HOME: 'relative' }, cwd: '/w', home: '/home/me', platform: 'linux', exists: none }).dataDir)
      .toBe('/home/me/.local/share/latch/host')
    expect(resolveLatchPaths({ env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, cwd: 'C:\\w', home: 'C:\\Users\\me', platform: 'win32', exists: none }))
      .toMatchObject({ dataDir: 'C:\\Users\\me\\AppData\\Roaming\\Latch\\Host', agentsDir: 'C:\\Users\\me\\AppData\\Roaming\\Latch\\Agents' })
  })

  it('resolves the workspace and agents directory', () => {
    const base = { cwd: '/w', home: '/home/me', platform: 'linux' as const, exists: none }
    expect(resolveLatchPaths({ ...base, env: {}, workspace: 'proj' })).toMatchObject({ workspaceRoot: '/w/proj', workspaceSource: 'flag' })
    expect(resolveLatchPaths({ ...base, env: { HARNESS_WORKSPACE: '/p' } })).toMatchObject({ workspaceRoot: '/p', workspaceSource: 'env' })
    const legacy = resolveLatchPaths({ ...base, env: { HARNESS_DATA_DIR: '/d' }, exists: path => path === '/d/workspace' })
    expect(legacy).toMatchObject({ workspaceRoot: '/d/workspace', workspaceSource: 'legacy-data' })
    expect(legacy.warnings).toEqual(['工作区位于数据目录内（/d/workspace）。迁出之前只能使用内置 Harness。'])
    expect(resolveLatchPaths({ ...base, env: {} })).toMatchObject({ workspaceRoot: '/home/me/Latch/workspace', workspaceSource: 'default' })
    expect(resolveLatchPaths({ ...base, env: { HARNESS_AGENTS_DIR: '/agents' } }).agentsDir).toBe('/agents')
  })
})

describe('prepareRuntimeDir', () => {
  it('creates a private runtime directory with a socket path and tmp root', async () => {
    const parent = temp()
    const result = await prepareRuntimeDir({ hostId8: 'abcdefgh', parent })
    expect(result).toEqual({ runtimeDir: join(parent, 'latch-abcdefgh'), socketPath: join(parent, 'latch-abcdefgh', 'host.sock'), tmpRoot: join(parent, 'latch-abcdefgh', 'tmp') })
    const { statSync } = await import('node:fs')
    expect(statSync(result.runtimeDir).mode & 0o777).toBe(0o700)
    expect(statSync(result.tmpRoot).mode & 0o777).toBe(0o700)
    // Idempotent on restart.
    await expect(prepareRuntimeDir({ hostId8: 'abcdefgh', parent })).resolves.toEqual(result)
  })

  it('uses getconf on macOS when no parent is given', async () => {
    const parent = temp()
    const result = await prepareRuntimeDir({ hostId8: 'abcdefgh', platform: 'darwin', getconf: () => `${parent}/\n` })
    expect(result.runtimeDir).toBe(join(parent, 'latch-abcdefgh'))
  })

  it('refuses a symlinked, loose, foreign or too-long runtime directory', async () => {
    const insecure = expect.objectContaining({ status: 500, code: 'runtime-dir-insecure' })
    const parent = temp()
    const elsewhere = temp()
    symlinkSync(elsewhere, join(parent, 'latch-linkedaa'))
    await expect(prepareRuntimeDir({ hostId8: 'linkedaa', parent })).rejects.toEqual(insecure)

    mkdirSync(join(parent, 'latch-looseaaa'), { mode: 0o700 })
    chmodSync(join(parent, 'latch-looseaaa'), 0o755)
    await expect(prepareRuntimeDir({ hostId8: 'looseaaa', parent })).rejects.toEqual(insecure)

    await expect(prepareRuntimeDir({ hostId8: 'foreignx', parent, uid: uid + 1 })).rejects.toEqual(insecure)

    const shared = temp()
    chmodSync(shared, 0o777)
    await expect(prepareRuntimeDir({ hostId8: 'sharedaa', parent: shared })).rejects.toEqual(insecure)

    const long = join(temp(), 'x'.repeat(90))
    mkdirSync(long, { mode: 0o700 })
    await expect(prepareRuntimeDir({ hostId8: 'longpath', parent: long })).rejects.toEqual(expect.objectContaining({ code: 'runtime-dir-too-long' }))
  })
})

describe('workspace guard', () => {
  async function context(): Promise<WorkspaceGuardContext & { root: string }> {
    const root = temp()
    const home = join(root, 'home')
    for (const path of ['home', 'data', 'agents', 'runtime', 'code', 'home/.ssh', 'home/.config/gcloud', 'home/Library/Keychains', 'home/projects/a', 'home/projects/b', 'tls'])
      mkdirSync(join(root, path), { recursive: true })
    writeFileSync(join(root, 'code', 'package.json'), '{}')
    writeFileSync(join(root, 'tls', 'key.pem'), 'k', { mode: 0o600 })
    return {
      root, home, dataDir: join(root, 'data'), agentsDir: join(root, 'agents-not-created'), runtimeDir: join(root, 'runtime'),
      codeRoot: join(root, 'code'), existing: [{ id: 'b', name: '项目 B', path: join(home, 'projects', 'b') }], tlsKeyPath: join(root, 'tls', 'key.pem'),
    }
  }

  it('accepts an ordinary project directory and returns its realpath', async () => {
    const guard = await context()
    symlinkSync(join(guard.home, 'projects', 'a'), join(guard.root, 'alias'))
    await expect(checkWorkspaceCandidate(join(guard.root, 'alias'), guard)).resolves.toEqual({ ok: true, realPath: join(guard.home, 'projects', 'a') })
  })

  it('reports each rule with its code', async () => {
    const guard = await context()
    const verdict = async (path: string) => {
      const result = await checkWorkspaceCandidate(path, guard)
      return result.ok ? 'ok' : `${result.error.status} ${result.error.code} ${result.error.message}`
    }
    expect(await verdict('relative/path')).toBe('400 workspace-invalid 目录不存在或无法访问')
    expect(await verdict(join(guard.root, 'missing'))).toBe('400 workspace-invalid 目录不存在或无法访问')
    expect(await verdict(join(guard.root, 'code', 'package.json'))).toBe('400 workspace-invalid 目录不存在或无法访问')
    expect(await verdict(`${guard.root}\u0000x`)).toBe('400 workspace-invalid 目录不存在或无法访问')
    expect(await verdict(guard.dataDir)).toBe('409 workspace-overlap 该目录与 Latch 的数据目录重叠，不能作为项目')
    expect(await verdict(guard.root)).toBe('409 workspace-overlap 该目录与 Latch 的数据目录重叠，不能作为项目')
    mkdirSync(join(guard.dataDir, 'inner'))
    expect(await verdict(join(guard.dataDir, 'inner'))).toBe('409 workspace-overlap 该目录与 Latch 的数据目录重叠，不能作为项目')
    mkdirSync(join(guard.root, 'agents-not-created'))
    expect(await verdict(join(guard.root, 'agents-not-created'))).toBe('409 workspace-overlap 该目录与 Latch 的Agent 安装目录重叠，不能作为项目')
    expect(await verdict(guard.runtimeDir)).toBe('409 workspace-overlap 该目录与 Latch 的运行目录重叠，不能作为项目')
    expect(await verdict(guard.home)).toBe('409 workspace-overlap 不能把主目录整体作为项目')
    const sensitive = '409 workspace-overlap 该目录包含或位于敏感目录（如 ~/.ssh），不能作为项目'
    expect(await verdict(join(guard.home, '.ssh'))).toBe(sensitive)
    expect(await verdict(join(guard.home, '.config'))).toBe(sensitive)
    expect(await verdict(join(guard.home, '.config', 'gcloud'))).toBe(sensitive)
    expect(await verdict(join(guard.home, 'Library'))).toBe(sensitive)
    expect(await verdict(join(guard.root, 'tls'))).toBe(sensitive)
    expect(await verdict(guard.codeRoot)).toBe('409 workspace-code-root 该目录与 Latch 程序目录重叠，不能作为项目')
    mkdirSync(join(guard.codeRoot, 'src'))
    expect(await verdict(join(guard.codeRoot, 'src'))).toBe('409 workspace-code-root 该目录与 Latch 程序目录重叠，不能作为项目')
    expect(await verdict(join(guard.home, 'projects', 'b'))).toBe('409 workspace-exists 该目录已添加为项目「项目 B」')
    expect(await verdict(join(guard.home, 'projects', 'a'))).toBe('ok')
  })

  it('flags code-root ancestors as code-root', async () => {
    const guard = await context()
    const wrapper = join(guard.root, 'wrap')
    mkdirSync(join(wrapper, 'latch'), { recursive: true })
    const result = await checkWorkspaceCandidate(wrapper, { ...guard, codeRoot: join(wrapper, 'latch') })
    expect(result.ok ? undefined : result.error.code).toBe('workspace-code-root')
  })

  it('classifies the startup workspace without refusing it', async () => {
    const guard = await context()
    mkdirSync(join(guard.dataDir, 'workspace'))
    await expect(classifyDefaultWorkspace(join(guard.dataDir, 'workspace'), guard)).resolves.toEqual({ insideData: true, codeRoot: false })
    await expect(classifyDefaultWorkspace(guard.codeRoot, guard)).resolves.toEqual({ insideData: false, codeRoot: true })
    await expect(classifyDefaultWorkspace(join(guard.home, 'projects', 'a'), guard)).resolves.toEqual({ insideData: false, codeRoot: false })
  })

  it('reports a startup workspace that would expose secrets or Latch\'s own directories', async () => {
    const guard = await context()
    mkdirSync(join(guard.root, 'agents-not-created'))
    const sensitive = async (path: string) => (await classifyDefaultWorkspace(path, guard)).sensitive
    expect(await sensitive(guard.home)).toEqual({ reason: 'home', message: '不能把主目录整体作为项目' })
    expect(await sensitive(join(guard.home, '.ssh'))).toEqual({ reason: 'deny-read', message: '该目录包含或位于敏感目录（如 ~/.ssh），不能作为项目' })
    expect(await sensitive(join(guard.home, 'Library'))).toEqual({ reason: 'deny-read', message: '该目录包含或位于敏感目录（如 ~/.ssh），不能作为项目' })
    expect(await sensitive(join(guard.root, 'tls'))).toEqual({ reason: 'tls-key', message: '该目录包含或位于敏感目录（如 ~/.ssh），不能作为项目' })
    expect(await sensitive(guard.runtimeDir)).toEqual({ reason: 'runtime', message: '该目录与 Latch 的运行目录重叠，不能作为项目' })
    expect(await sensitive(join(guard.root, 'agents-not-created'))).toEqual({ reason: 'agents', message: '该目录与 Latch 的Agent 安装目录重叠，不能作为项目' })
    expect(await sensitive(join(guard.home, 'projects', 'a'))).toBeUndefined()
    expect(await sensitive(join(guard.dataDir, 'workspace'))).toBeUndefined()
  })

  it('lists the documented sensitive home paths', () => {
    expect(DENY_READ_HOME_PATHS).toContain('.ssh')
    expect(DENY_READ_HOME_PATHS).toContain('Library/Keychains')
  })

  it('finds the code root of this checkout', () => {
    expect(latchCodeRoot()).toBe(realpathSync(process.cwd()))
  })
})

describe('isProtectedWorkspacePath', () => {
  it.each([
    ['.git/config', true], ['.GIT/config', true], ['sub/.git/HEAD', true], ['.g\u200Cit/config', true], ['.git./config', true],
    ['sub/package.json', true], ['Package.JSON', true], ['Makefile', true], ['go.sum', true], ['pnpm-lock.yaml', true],
    ['.github/workflows/x.yml', true], ['.GitHub/Workflows/ci.yml', true], ['.github/ISSUE_TEMPLATE.md', false],
    ['.env', true], ['.env.local', true], ['config/.ENV.production', true], ['.envrc', true], ['env.example', false],
    ['AGENTS.md', true], ['docs/claude.md', true], ['.vscode/settings.json', true], ['.husky/pre-commit', true],
    ['opencode.jsonc', true], ['.latch/x', true], ['ｐａｃｋａｇｅ.json', true],
    ['.pnpmfile.cjs', true], ['.npmrc', true], ['.yarnrc.yml', true], ['.yarn/releases/yarn.cjs', true], ['pnpm-workspace.yaml', true],
    ['bunfig.toml', true], ['node_modules/.bin/vitest', true], ['.venv/lib/python3.12/site-packages/x.py', true], ['venv/bin/activate', true],
    ['lib/site-packages/evil.pth', true], ['.githooks/pre-commit', true], ['.pre-commit-config.yaml', true], ['lefthook.yml', true],
    ['.gitmodules', true], ['.gitconfig', true], ['sub/.GitConfig', true], ['.mcp.json', true], ['.cursor/rules', true], ['.idea/workspace.xml', true], ['.devcontainer/devcontainer.json', true],
    ['AGENTS.override.md', true], ['.goosehints', true], ['mise.toml', true], ['.cargo/config.toml', true], ['build.rs', true],
    ['Cargo.toml', true], ['rust-toolchain.toml', true], ['go.mod', true], ['pyproject.toml', true], ['setup.py', true],
    ['requirements.txt', true], ['Gemfile', true], ['composer.json', true], ['CMakeLists.txt', true], ['build.gradle.kts', true],
    ['gradlew', true], ['.mvn/jvm.config', true], ['pom.xml', true],
    ['src/index.ts', false], ['README.md', false], ['notes/package.json.bak', false], ['./src/app.ts', false],
    ['tests/conftest.py', false], ['docs/requirements.md', false], ['src/venv.ts', false], ['path.txt', false],
    ['', true], ['   ', true], ['/etc/passwd', true], ['C:\\Windows', true], ['../outside', true], ['a/../../b', true], ['a/../b', true], ['.', true],
  ])('%j → %s', (path, expected) => {
    expect(isProtectedWorkspacePath(path)).toBe(expected)
  })
})

describe('protected workspace roots', () => {
  it.each([
    ['hooks/pre-commit', '/r/proj/.git', true], ['workflows/ci.yml', '/r/proj/.github', true], ['ci.yml', '/r/proj/.github/workflows', true],
    ['pre-commit', '/r/proj/.husky', true], ['x.js', '/r/proj/node_modules/pkg', true], ['config.toml', 'C:\\proj\\.cargo', true],
    ['src/app.ts', '/r/proj', false], ['ISSUE_TEMPLATE.md', '/r/proj/.github', false], ['app.ts', 'C:\\proj\\src', false],
    ['src/app.ts', 'relative/root', true], ['src/app.ts', '/r/../proj', true],
  ])('%j under %j → %s', (path, root, expected) => {
    expect(isProtectedWorkspacePath(path, root)).toBe(expected)
  })

  it('finds protected components of absolute directories', () => {
    expect(hasProtectedComponent('/r/proj/.git')).toBe(true)
    expect(hasProtectedComponent('/r/proj/.GIT/hooks')).toBe(true)
    expect(hasProtectedComponent('/r/proj/.github/workflows')).toBe(true)
    expect(hasProtectedComponent('/r/proj/.github')).toBe(false)
    expect(hasProtectedComponent('/r/proj/src')).toBe(false)
    expect(hasProtectedComponent('relative')).toBe(true)
  })

  it('refuses to register a directory inside a protected one, also through a symlink', async () => {
    const root = temp()
    for (const path of ['home', 'data', 'runtime', 'code', 'repo/.git/hooks', 'repo/.github/workflows', 'repo/.husky', 'repo/node_modules/pkg', 'repo/src'])
      mkdirSync(join(root, path), { recursive: true })
    symlinkSync(join(root, 'repo', '.git'), join(root, 'repo', 'docs'))
    const guard: WorkspaceGuardContext = {
      dataDir: join(root, 'data'), agentsDir: join(root, 'agents'), runtimeDir: join(root, 'runtime'), home: join(root, 'home'), codeRoot: join(root, 'code'), existing: [],
    }
    const protectedMessage = '409 workspace-overlap 该目录位于受保护目录（如 .git）内，不能作为项目'
    for (const path of ['repo/.git', 'repo/.git/hooks', 'repo/docs', 'repo/.github/workflows', 'repo/.husky', 'repo/node_modules/pkg']) {
      const verdict = await checkWorkspaceCandidate(join(root, path), guard)
      expect(verdict.ok ? 'ok' : `${verdict.error.status} ${verdict.error.code} ${verdict.error.message}`, path).toBe(protectedMessage)
    }
    await expect(checkWorkspaceCandidate(join(root, 'repo', 'src'), guard)).resolves.toMatchObject({ ok: true })
    await expect(checkWorkspaceCandidate(join(root, 'repo', '.github'), guard)).resolves.toMatchObject({ ok: true })
  })

  it('refuses the login-autostart directories', async () => {
    const root = temp()
    const home = join(root, 'home')
    for (const path of ['home/Library/LaunchAgents', 'home/.config/autostart', 'home/.config/systemd/user', 'data', 'runtime', 'code'])
      mkdirSync(join(root, path), { recursive: true })
    const guard: WorkspaceGuardContext = { dataDir: join(root, 'data'), agentsDir: join(root, 'agents'), runtimeDir: join(root, 'runtime'), home, codeRoot: join(root, 'code'), existing: [] }
    for (const path of ['Library/LaunchAgents', '.config/autostart', '.config/systemd/user']) {
      const verdict = await checkWorkspaceCandidate(join(home, path), guard)
      expect(verdict.ok ? 'ok' : verdict.error.message, path).toBe('该目录包含或位于敏感目录（如 ~/.ssh），不能作为项目')
    }
  })
})

describe('home configuration directories', () => {
  const darwin = process.platform === 'darwin'
  const HOME_CONFIG = '409 workspace-overlap 主目录下的隐藏目录、配置目录和系统目录不能作为项目'

  function setup(): WorkspaceGuardContext & { root: string } {
    const root = temp()
    const home = join(root, 'users', 'me')
    for (const path of [
      '.config/fish', '.config/git', '.local/bin', '.local/share/latch/host/workspace', 'bin', '.oh-my-zsh/custom', '.zshrc.d',
      'Library/Application Support/Code/User', 'projects/a/.cache', 'binaries', 'Documents',
    ]) mkdirSync(join(home, path), { recursive: true })
    for (const path of ['data', 'runtime', 'code']) mkdirSync(join(root, path))
    symlinkSync(join(home, '.oh-my-zsh', 'custom'), join(home, 'Documents', 'shell'))
    return { root, home, dataDir: join(root, 'data'), agentsDir: join(root, 'agents'), runtimeDir: join(root, 'runtime'), codeRoot: join(root, 'code'), existing: [] }
  }

  it('refuses hidden entries directly under $HOME, ~/.config, ~/.local, ~/bin and (on macOS) all of ~/Library', async () => {
    const guard = setup()
    const verdict = async (path: string) => {
      const result = await checkWorkspaceCandidate(join(guard.home, path), guard)
      return result.ok ? 'ok' : `${result.error.status} ${result.error.code} ${result.error.message}`
    }
    for (const path of ['.config/fish', '.config/git', '.local', '.local/bin', 'bin', '.oh-my-zsh', '.oh-my-zsh/custom', '.zshrc.d', 'Documents/shell']) {
      expect(await verdict(path), path).toBe(HOME_CONFIG)
    }
    expect(await verdict('Library/Application Support/Code/User')).toBe(darwin ? HOME_CONFIG : 'ok')
    // Rules checked earlier keep their own wording.
    expect(await verdict('.config')).toBe('409 workspace-overlap 该目录包含或位于敏感目录（如 ~/.ssh），不能作为项目')
    expect((await checkWorkspaceCandidate(join(guard.root, 'users'), guard)).ok).toBe(false)
    for (const path of ['projects/a', 'projects/a/.cache', 'binaries', 'Documents']) expect(await verdict(path), path).toBe('ok')
  })

  it('refuses them as the startup workspace too, except the legacy workspace inside the data directory', async () => {
    const guard = setup()
    const sensitive = async (path: string, context: WorkspaceGuardContext = guard) => (await classifyDefaultWorkspace(join(guard.home, path), context)).sensitive
    const homeConfig = { reason: 'home-config', message: '主目录下的隐藏目录、配置目录和系统目录不能作为项目' }
    for (const path of ['.config/fish', '.local/bin', 'bin', '.oh-my-zsh/custom', 'Documents/shell']) expect(await sensitive(path), path).toEqual(homeConfig)
    expect(await sensitive('Library/Application Support/Code/User')).toEqual(darwin ? homeConfig : undefined)
    expect(await sensitive('projects/a')).toBeUndefined()
    // The Linux default data directory lives in ~/.local/share; its legacy workspace stays usable for the built-in harness.
    const legacy = { ...guard, dataDir: join(guard.home, '.local', 'share', 'latch', 'host') }
    await expect(classifyDefaultWorkspace(join(legacy.dataDir, 'workspace'), legacy)).resolves.toEqual({ insideData: true, codeRoot: false })
  })
})

describe('macOS path aliases', () => {
  const darwin = process.platform === 'darwin'
  const dataVolume = (path: string) => `/System/Volumes/Data${path}`

  async function guarded(): Promise<WorkspaceGuardContext & { root: string }> {
    const root = temp()
    for (const path of ['home/.ssh', 'home/projects/a', 'data/inner', 'runtime', 'code/src', 'tls'])
      mkdirSync(join(root, path), { recursive: true })
    writeFileSync(join(root, 'code', 'package.json'), '{}')
    writeFileSync(join(root, 'tls', 'key.pem'), 'k', { mode: 0o600 })
    return {
      root, home: join(root, 'home'), dataDir: join(root, 'data'), agentsDir: join(root, 'agents'), runtimeDir: join(root, 'runtime'),
      codeRoot: join(root, 'code'), existing: [{ id: 'a', name: '项目 A', path: join(root, 'home', 'projects', 'a') }], tlsKeyPath: join(root, 'tls', 'key.pem'),
    }
  }

  it.skipIf(!darwin)('gives every spelling of a directory the same canonical path', async () => {
    const guard = await guarded()
    const plain = await canonicalPath(guard.home)
    expect(plain).toBe(guard.home.toLowerCase())
    expect(await canonicalPath(dataVolume(guard.home))).toBe(plain)
    expect(await canonicalPath(`/.nofollow${guard.home}`)).toBe(plain)
    expect(await canonicalPath(`/.nofollow${dataVolume(guard.home)}`)).toBe(plain)
    expect(await canonicalPath(guard.home.toUpperCase())).toBe(plain)
    await expect(canonicalPath(join(guard.root, 'missing'))).rejects.toThrow()
    // A Data-volume spelling with no counterpart at / stays as it is.
    expect(await canonicalPath('/System/Volumes/Data')).toBe('/system/volumes/data')
  })

  it.skipIf(!darwin)('refuses aliased spellings of reserved, sensitive and existing directories', async () => {
    const guard = await guarded()
    const verdict = async (path: string) => {
      const result = await checkWorkspaceCandidate(path, guard)
      return result.ok ? `ok ${result.realPath}` : `${result.error.code} ${result.error.message}`
    }
    for (const alias of [dataVolume, (path: string) => `/.nofollow${path}`]) {
      expect(await verdict(alias(guard.dataDir))).toBe('workspace-overlap 该目录与 Latch 的数据目录重叠，不能作为项目')
      expect(await verdict(alias(join(guard.dataDir, 'inner')))).toBe('workspace-overlap 该目录与 Latch 的数据目录重叠，不能作为项目')
      expect(await verdict(alias(guard.runtimeDir))).toBe('workspace-overlap 该目录与 Latch 的运行目录重叠，不能作为项目')
      expect(await verdict(alias(guard.home))).toBe('workspace-overlap 不能把主目录整体作为项目')
      expect(await verdict(alias(join(guard.home, '.ssh')))).toBe('workspace-overlap 该目录包含或位于敏感目录（如 ~/.ssh），不能作为项目')
      expect(await verdict(alias(join(guard.root, 'tls')))).toBe('workspace-overlap 该目录包含或位于敏感目录（如 ~/.ssh），不能作为项目')
      expect(await verdict(alias(guard.codeRoot))).toBe('workspace-code-root 该目录与 Latch 程序目录重叠，不能作为项目')
      expect(await verdict(alias(join(guard.codeRoot, 'src')))).toBe('workspace-code-root 该目录与 Latch 程序目录重叠，不能作为项目')
      expect(await verdict(alias(join(guard.home, 'projects', 'a')))).toBe('workspace-exists 该目录已添加为项目「项目 A」')
    }
    // The stored path is the plain spelling.
    mkdirSync(join(guard.home, 'projects', 'b'))
    expect(await verdict(dataVolume(join(guard.home, 'projects', 'b')))).toBe(`ok ${join(guard.home, 'projects', 'b')}`)
    // The alias roots themselves contain everything.
    for (const path of ['/System/Volumes/Data', '/System/Volumes', '/System', '/.nofollow', '/.vol']) {
      expect((await checkWorkspaceCandidate(path, guard)).ok, path).toBe(false)
    }
  })

  it.skipIf(!darwin)('classifies an aliased startup workspace like the plain one', async () => {
    const guard = await guarded()
    await expect(classifyDefaultWorkspace(dataVolume(guard.codeRoot), guard)).resolves.toEqual({ insideData: false, codeRoot: true })
    await expect(classifyDefaultWorkspace(`/.nofollow${join(guard.dataDir, 'inner')}`, guard)).resolves.toEqual({ insideData: true, codeRoot: false })
    await expect(classifyDefaultWorkspace(dataVolume(guard.home), guard)).resolves.toMatchObject({ sensitive: { reason: 'home' } })
  })

  it.skipIf(!darwin)('finds a TLS key inside an aliased workspace', async () => {
    const guard = await guarded()
    await expect(checkPrivateFile(guard.tlsKeyPath!, { uid, notInside: [dataVolume(join(guard.root, 'tls'))], label: 'HTTPS 私钥' }))
      .rejects.toMatchObject({ code: 'private-file-insecure' })
    await expect(checkPrivateFile(guard.tlsKeyPath!, { uid, notInside: [dataVolume(guard.home)], label: 'HTTPS 私钥' })).resolves.toBeUndefined()
  })
})

describe('checkPrivateFile', () => {
  it('accepts a 0600 file outside the listed directories and refuses everything else', async () => {
    const root = temp()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const good = join(root, 'key.pem')
    writeFileSync(good, 'k', { mode: 0o600 })
    const rule = { uid, notInside: [workspace], label: 'TLS 私钥' }
    await expect(checkPrivateFile(good, rule)).resolves.toBeUndefined()
    const failure = expect.objectContaining({ status: 500, code: 'private-file-insecure', message: 'TLS 私钥 必须是仅本用户可读的文件（0600），且不能位于工作区内' })
    const loose = join(root, 'loose.pem')
    writeFileSync(loose, 'k', { mode: 0o644 })
    chmodSync(loose, 0o644)
    await expect(checkPrivateFile(loose, rule)).rejects.toEqual(failure)
    const link = join(root, 'link.pem')
    symlinkSync(good, link)
    await expect(checkPrivateFile(link, rule)).rejects.toEqual(failure)
    const inside = join(workspace, 'key.pem')
    writeFileSync(inside, 'k', { mode: 0o600 })
    await expect(checkPrivateFile(inside, rule)).rejects.toEqual(failure)
    await expect(checkPrivateFile(good, { ...rule, uid: uid + 1 })).rejects.toEqual(failure)
    await expect(checkPrivateFile(join(root, 'missing.pem'), rule)).rejects.toEqual(failure)
    await expect(checkPrivateFile(root, rule)).rejects.toEqual(failure)
  })
})
