import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkBoundaries,
  checkScreensOnly,
  parsePbxproj,
  readWorkspaceProjects,
  type ProjectManifest,
  type ProjectRule,
} from '../scripts/boundaries.ts'

const RULES: Record<string, ProjectRule> = {
  root: { dir: '.', dependencies: ['@latch/server', '@latch/page', '@latch/kit'] },
  '@latch/shared': { dir: 'packages/shared', env: 'isomorphic', dependencies: [] },
  '@latch/server': { dir: 'packages/server', env: 'node', dependencies: ['@latch/shared'], devDependencies: ['@latch/kit'] },
  '@latch/kit': { dir: 'packages/kit', env: 'node', dependencies: ['@latch/shared'] },
  '@latch/page': { dir: 'packages/page', env: 'browser', dependencies: ['@latch/shared', '@latch/server'] },
}

function project(dir: string, name: string, fields: Record<string, unknown> = {}): ProjectManifest {
  const env = RULES[name]?.env
  return { dir, manifest: { name, ...(env ? { latch: { env } } : {}), ...fields } }
}

function workspace(overrides: Partial<Record<string, ProjectManifest>> = {}): ProjectManifest[] {
  const base: Record<string, ProjectManifest> = {
    root: project('.', 'root', { dependencies: { '@latch/server': 'workspace:*', '@latch/page': 'workspace:*', zod: 'catalog:' } }),
    '@latch/shared': project('packages/shared', '@latch/shared'),
    '@latch/server': project('packages/server', '@latch/server', {
      dependencies: { '@latch/shared': 'workspace:*' },
      devDependencies: { '@latch/kit': 'workspace:*' },
    }),
    '@latch/kit': project('packages/kit', '@latch/kit', { dependencies: { '@latch/shared': 'workspace:*' } }),
    '@latch/page': project('packages/page', '@latch/page', { dependencies: { '@latch/shared': 'workspace:*' } }),
  }
  return Object.values({ ...base, ...overrides }).filter(item => item !== undefined)
}

describe('workspace boundaries', () => {
  it('accepts projects that declare their environment and use only the workspace packages they are allowed', () => {
    expect(checkBoundaries(workspace(), RULES)).toEqual([])
  })

  it('reports a project whose declared environment is missing or differs from its rule, and a root that declares one', () => {
    const problems = checkBoundaries(
      workspace({
        root: { dir: '.', manifest: { name: 'root', latch: { env: 'node' } } },
        '@latch/shared': { dir: 'packages/shared', manifest: { name: '@latch/shared' } },
        '@latch/kit': { dir: 'packages/kit', manifest: { name: '@latch/kit', latch: { env: 'browser' } } },
        '@latch/page': { dir: 'packages/page', manifest: { name: '@latch/page', latch: { env: 'web' } } },
      }),
      RULES,
    )
    expect(problems).toEqual([
      './package.json：仓库根不声明 latch.env',
      'packages/shared/package.json：latch.env 应为 "isomorphic"，现为 未声明',
      'packages/kit/package.json：latch.env 应为 "node"，现为 "browser"',
      'packages/page/package.json：latch.env 应为 "browser"，现为 "web"（可用：isomorphic、browser、node、electron-main、workerd）',
    ])
  })

  it('reports workspace dependencies outside the rule, including dev-only packages listed as runtime dependencies', () => {
    const problems = checkBoundaries(
      workspace({
        '@latch/shared': project('packages/shared', '@latch/shared', { peerDependencies: { '@latch/kit': 'workspace:*' } }),
        '@latch/server': project('packages/server', '@latch/server', { dependencies: { '@latch/kit': 'workspace:*' } }),
        '@latch/kit': project('packages/kit', '@latch/kit', { devDependencies: { '@latch/server': 'workspace:*' } }),
      }),
      RULES,
    )
    expect(problems).toEqual([
      'packages/shared/package.json 的 peerDependencies.@latch/kit：@latch/shared 不能使用任何 workspace 包',
      'packages/server/package.json 的 dependencies.@latch/kit：@latch/server 只能使用 @latch/shared',
      'packages/kit/package.json 的 devDependencies.@latch/server：@latch/kit 只能使用 @latch/shared',
    ])
  })

  it('reports a dev-only package listed anywhere but devDependencies, by the root as well', () => {
    const rules: Record<string, ProjectRule> = { ...RULES, '@latch/kit': { ...RULES['@latch/kit'], devOnly: true } }
    const problems = checkBoundaries(
      workspace({
        root: project('.', 'root', { dependencies: { '@latch/kit': 'workspace:*' }, devDependencies: { '@latch/kit': 'workspace:*' } }),
        '@latch/server': project('packages/server', '@latch/server', {
          dependencies: { '@latch/shared': 'workspace:*' },
          peerDependencies: { '@latch/kit': 'workspace:*' },
          devDependencies: { '@latch/kit': 'workspace:*' },
        }),
      }),
      rules,
    )
    expect(problems).toEqual([
      './package.json 的 dependencies.@latch/kit：@latch/kit 只供测试使用，只能写在 devDependencies',
      'packages/server/package.json 的 peerDependencies.@latch/kit：@latch/kit 只供测试使用，只能写在 devDependencies',
    ])
  })

  it('reports a dependency on a package of an environment the project cannot load, even when its rule lists it', () => {
    const problems = checkBoundaries(
      workspace({ '@latch/page': project('packages/page', '@latch/page', { dependencies: { '@latch/server': 'workspace:*' } }) }),
      RULES,
    )
    expect(problems).toEqual(['packages/page/package.json 的 dependencies.@latch/server：browser 项目不能依赖 node 项目'])
  })

  it('accepts Node projects in devDependencies, which only tests and tools running in Node load, and still refuses other environments', () => {
    const rules: Record<string, ProjectRule> = {
      ...RULES,
      '@latch/kit': { ...RULES['@latch/kit'], devDependencies: ['@latch/page'] },
      '@latch/page': { ...RULES['@latch/page'], devDependencies: ['@latch/kit'] },
    }
    const problems = checkBoundaries(
      workspace({
        '@latch/kit': project('packages/kit', '@latch/kit', {
          dependencies: { '@latch/shared': 'workspace:*' },
          devDependencies: { '@latch/page': 'workspace:*' },
        }),
        '@latch/page': project('packages/page', '@latch/page', {
          dependencies: { '@latch/shared': 'workspace:*' },
          devDependencies: { '@latch/server': 'workspace:*', '@latch/kit': 'workspace:*' },
        }),
      }),
      rules,
    )
    expect(problems).toEqual(['packages/kit/package.json 的 devDependencies.@latch/page：node 项目不能依赖 browser 项目'])
  })

  it('reports workspace packages taken from the registry, scoped names outside the workspace, and dependencies on the root', () => {
    const problems = checkBoundaries(
      workspace({
        root: project('.', 'root', { dependencies: { '@latch/server': '0.1.0', '@latch/telemetry': '1.0.0' } }),
        '@latch/kit': project('packages/kit', '@latch/kit', { dependencies: { '@latch/shared': 'workspace:*', root: 'workspace:*' } }),
      }),
      RULES,
    )
    expect(problems).toEqual([
      './package.json 的 dependencies.@latch/server 必须写成 workspace:*，否则会从 registry 安装同名包',
      './package.json 的 dependencies.@latch/telemetry 不是本仓库的 workspace 项目；@latch/ 下的包只能来自 workspace',
      'packages/kit/package.json 的 dependencies.root：仓库根不是可依赖的包',
    ])
  })

  it('checks the repository root like every project, reporting a workspace package its rule does not list', () => {
    const rules: Record<string, ProjectRule> = {
      ...RULES,
      root: { dir: '.', dependencies: ['@latch/server'], devDependencies: ['@latch/kit'] },
    }
    const problems = checkBoundaries(
      workspace({
        root: project('.', 'root', {
          dependencies: { '@latch/server': 'workspace:*', '@latch/page': 'workspace:*' },
          devDependencies: { '@latch/kit': 'workspace:*', '@latch/shared': 'workspace:*' },
        }),
      }),
      rules,
    )
    expect(problems).toEqual([
      './package.json 的 dependencies.@latch/page：root 只能使用 @latch/server',
      './package.json 的 devDependencies.@latch/shared：root 只能使用 @latch/server、@latch/kit',
    ])
  })

  it('reports projects missing from the rules, rules without a project, misplaced projects and duplicate names', () => {
    const problems = checkBoundaries(
      [
        ...workspace({ '@latch/kit': undefined, '@latch/page': project('packages/web', '@latch/page') }),
        project('packages/extra', '@latch/extra', { latch: { env: 'node' } }),
        project('packages/copy', '@latch/shared'),
        { dir: 'packages/nameless', manifest: {} },
      ],
      RULES,
    )
    expect(problems).toEqual([
      'packages/copy/package.json：@latch/shared 与 packages/shared 重名',
      'packages/nameless/package.json 没有 name',
      'packages/server/package.json 的 devDependencies.@latch/kit 不是本仓库的 workspace 项目；@latch/ 下的包只能来自 workspace',
      'packages/web/package.json：@latch/page 应位于 packages/page',
      'packages/extra/package.json：@latch/extra 不在 scripts/boundaries.ts 的 PROJECTS 中，新项目要在那里写明运行环境与可用的 workspace 包',
      'PROJECTS 中的 @latch/kit（packages/kit）不在 pnpm-workspace.yaml 列出的项目中',
    ])
  })
})

describe('workspace project listing', () => {
  let root: string | undefined
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  async function tree(workspaceYaml: string, manifests: Record<string, unknown>): Promise<string> {
    root = await mkdtemp(join(tmpdir(), 'latch-boundaries-'))
    await writeFile(join(root, 'pnpm-workspace.yaml'), workspaceYaml)
    for (const [dir, manifest] of Object.entries(manifests)) {
      await mkdir(join(root, dir), { recursive: true })
      if (manifest !== null) await writeFile(join(root, dir, 'package.json'), JSON.stringify(manifest))
    }
    return root
  }

  it('lists the root, named directories and the children of dir/*, skipping directories without a package.json', async () => {
    const dir = await tree('packages:\n  - .\n  - packages/*\n  - tools/cli\n', {
      '.': { name: 'root' },
      'packages/b': { name: '@latch/b' },
      'packages/a': { name: '@latch/a' },
      'packages/empty': null,
      'tools/cli': { name: '@latch/cli' },
      'tools/other': { name: '@latch/other' },
    })
    const { projects, problems } = await readWorkspaceProjects(dir)
    expect(problems).toEqual([])
    expect(projects.map(item => [item.dir, item.manifest.name])).toEqual([
      ['.', 'root'],
      ['packages/a', '@latch/a'],
      ['packages/b', '@latch/b'],
      ['tools/cli', '@latch/cli'],
    ])
  })

  it('reports patterns it cannot expand instead of skipping the projects they would match', async () => {
    const dir = await tree("packages:\n  - .\n  - 'packages/**'\n  - '!packages/old'\n  - 'apps/{web,host}'\n", { '.': { name: 'root' } })
    const { projects, problems } = await readWorkspaceProjects(dir)
    expect(projects.map(item => item.dir)).toEqual(['.'])
    expect(problems).toEqual([
      'pnpm-workspace.yaml 的 packages 项 "packages/**" 不受支持：只能写目录或「目录/*」',
      'pnpm-workspace.yaml 的 packages 项 "!packages/old" 不受支持：只能写目录或「目录/*」',
      'pnpm-workspace.yaml 的 packages 项 "apps/{web,host}" 不受支持：只能写目录或「目录/*」',
    ])
  })
})

describe('iOS LatchScreens code', () => {
  const settings = {
    latch: 'PRODUCT_BUNDLE_IDENTIFIER = codes.latch.ios; SUPPORTED_PLATFORMS = "iphoneos iphonesimulator";',
    screens:
      'PRODUCT_BUNDLE_IDENTIFIER = codes.latch.ios.screens; SUPPORTED_PLATFORMS = iphonesimulator; SWIFT_ACTIVE_COMPILATION_CONDITIONS = "DEBUG LATCH_SCREENS";',
  }
  function project(change: { latch?: string; latchGroups?: string; screensName?: string; screensPath?: string; latchBase?: string } = {}) {
    return `// !$*UTF8*$!
{
 objects = {
  P1 = {isa = PBXProject; buildConfigurationList = P2; targets = (T1, T2); };
  P2 = {isa = XCConfigurationList; buildConfigurations = (P3); };
  P3 = {isa = XCBuildConfiguration; buildSettings = {SWIFT_OPTIMIZATION_LEVEL = "-Onone"; }; name = Debug; };
  T1 = {isa = PBXNativeTarget; buildConfigurationList = L1; fileSystemSynchronizedGroups = (${change.latchGroups ?? 'G1'}); name = Latch; };
  L1 = {isa = XCConfigurationList; buildConfigurations = (C1); };
  C1 = {isa = XCBuildConfiguration; ${change.latchBase ?? ''}buildSettings = {${change.latch ?? settings.latch}}; name = Debug; };
  G1 = {isa = PBXFileSystemSynchronizedRootGroup; path = App; sourceTree = "<group>"; };
  G2 = {isa = PBXFileSystemSynchronizedRootGroup; path = ${change.screensPath ?? 'Screens'}; sourceTree = "<group>"; };
  T2 = {isa = PBXNativeTarget; buildConfigurationList = L2; fileSystemSynchronizedGroups = (G1, G2); name = ${change.screensName ?? 'LatchScreens'}; };
  L2 = {isa = XCConfigurationList; buildConfigurations = (C2); };
  C2 = {isa = XCBuildConfiguration; buildSettings = {${settings.screens}}; name = Debug; };
 };
 rootObject = P1;
}
`
  }
  const SCOPE = 'LatchScreens 的代码只写在 native/ios/Screens/ 或 App/ 的 #if LATCH_SCREENS 中'
  const SOFTWARE = '产品只用 Secure Enclave 密钥；软件密钥只在 LatchScreens 的 #if LATCH_SCREENS 中'

  it('allows live mode and the scenes only in Screens/ and inside #if LATCH_SCREENS in App/', () => {
    const files = [
      { path: 'native/ios/Screens/LiveKeys.swift', text: 'final class LiveSoftwareKeys {}\nlet key = P256.Signing.PrivateKey()' },
      {
        path: 'native/ios/App/Pairing/PhoneKeys.swift',
        text: '#if LATCH_SCREENS\nif PhoneLive.isOn { return LiveSoftwareKeys.create() }\n#endif\n// PhoneLive in a comment\nreturn SecureDeviceKeys.create()',
      },
    ]
    expect(checkScreensOnly(files, project())).toEqual([])
  })

  it('reports live mode or software keys outside LATCH_SCREENS, in its #else, and in the shared core', () => {
    const files = [
      { path: 'native/ios/App/Root/PhoneModel.swift', text: 'let keys = LiveIdentityProvider(reference: host.keys)' },
      { path: 'native/ios/App/PhoneStore.swift', text: '#if LATCH_SCREENS\n#else\nif PhoneLive.isOn {}\n#endif' },
      { path: 'native/ios/Sources/LatchNativeCore/Identity.swift', text: '#if LATCH_SCREENS\nlet flag = "-LatchLive"\n#endif' },
      { path: 'native/ios/Sources/LatchNativeCore/Keys.swift', text: 'let key = SecKeyCreateWithData(bytes as CFData, attributes, nil)' },
      { path: 'native/ios/App/Pairing/Draft.swift', text: 'let key = P256.Signing.PrivateKey()' },
    ]
    expect(checkScreensOnly(files, project())).toEqual([
      `native/ios/App/Root/PhoneModel.swift:1：${SCOPE}`,
      `native/ios/App/PhoneStore.swift:3：${SCOPE}`,
      `native/ios/Sources/LatchNativeCore/Identity.swift:2：${SCOPE}`,
      `native/ios/Sources/LatchNativeCore/Keys.swift:1：${SOFTWARE}`,
      `native/ios/App/Pairing/Draft.swift:1：${SOFTWARE}`,
    ])
  })

  it('reports a product target that builds Screens/ or sets LATCH_SCREENS, directly or through a variable or xcconfig', () => {
    expect(checkScreensOnly([], project({ latchGroups: 'G1, G2' }))).toEqual([
      'project.pbxproj：只有 LatchScreens 目标构建 Screens/，Latch 不能',
    ])
    const indirect = 'project.pbxproj：Latch 与项目的 SWIFT_ACTIVE_COMPILATION_CONDITIONS 不设置 LATCH_SCREENS，也不经变量间接设置'
    expect(checkScreensOnly([], project({ latch: 'SWIFT_ACTIVE_COMPILATION_CONDITIONS = "$(LIVE_FLAGS)";' }))).toEqual([indirect])
    expect(checkScreensOnly([], project({ latch: 'SWIFT_ACTIVE_COMPILATION_CONDITIONS = "DEBUG LATCH_SCREENS";' }))).toEqual([
      indirect,
      'project.pbxproj：只有 LatchScreens（仅模拟器）设置 LATCH_SCREENS',
    ])
    expect(
      checkScreensOnly([], project({ latch: '"SWIFT_ACTIVE_COMPILATION_CONDITIONS[sdk=iphonesimulator*]" = LATCH_SCREENS;' })),
    ).toContain('project.pbxproj：只有 LatchScreens（仅模拟器）设置 LATCH_SCREENS')
    expect(checkScreensOnly([], project({ latchBase: 'baseConfigurationReference = X1; ' }))).toEqual([
      'project.pbxproj：Latch 与项目的配置不引用 xcconfig 文件，设置都写在项目里',
    ])
  })

  /** Xcode's own layout: one key per line, section and name comments, quoted values that look like comments. */
  function xcodeProject(latchConditions = 'DEBUG') {
    return `// !$*UTF8*$!
{
	archiveVersion = 1;
	classes = {
	};
	objectVersion = 77;
	objects = {

/* Begin PBXFileSystemSynchronizedRootGroup section */
		A00000000000000000000006 /* App */ = {
			isa = PBXFileSystemSynchronizedRootGroup;
			path = App;
			sourceTree = "<group>";
		};
		A00000000000000000000014 /* Screens */ = {
			isa = PBXFileSystemSynchronizedRootGroup;
			path = Screens;
			sourceTree = "<group>";
		};
/* End PBXFileSystemSynchronizedRootGroup section */

/* Begin PBXNativeTarget section */
		A00000000000000000000005 /* Latch */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = A00000000000000000000008 /* Build configuration list for PBXNativeTarget "Latch" */;
			fileSystemSynchronizedGroups = (
				A00000000000000000000006 /* App */,
			);
			name = Latch;
		};
		A00000000000000000000016 /* LatchScreens */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = A00000000000000000000017 /* Build configuration list for PBXNativeTarget "LatchScreens" */;
			fileSystemSynchronizedGroups = (
				A00000000000000000000006 /* App */,
				A00000000000000000000014 /* Screens */,
			);
			name = LatchScreens;
		};
/* End PBXNativeTarget section */

/* Begin PBXProject section */
		A00000000000000000000001 /* Project object */ = {
			isa = PBXProject;
			buildConfigurationList = A00000000000000000000002 /* Build configuration list for PBXProject "Latch" */;
			targets = (
				A00000000000000000000005 /* Latch */,
				A00000000000000000000016 /* LatchScreens */,
			);
		};
/* End PBXProject section */

/* Begin XCBuildConfiguration section */
		A0000000000000000000000A /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				HEADER_SEARCH_PATHS = "$(SRCROOT)/**";
				OTHER_LDFLAGS = "// not a comment";
			};
			name = Debug;
		};
		A00000000000000000000009 /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				PRODUCT_BUNDLE_IDENTIFIER = codes.latch.ios;
				SUPPORTED_PLATFORMS = "iphoneos iphonesimulator";
				SWIFT_ACTIVE_COMPILATION_CONDITIONS = "${latchConditions}";
			};
			name = Debug;
		};
		A00000000000000000000018 /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				PRODUCT_BUNDLE_IDENTIFIER = codes.latch.ios.screens;
				SUPPORTED_PLATFORMS = iphonesimulator;
				SWIFT_ACTIVE_COMPILATION_CONDITIONS = "DEBUG LATCH_SCREENS";
			};
			name = Debug;
		};
/* End XCBuildConfiguration section */

/* Begin XCConfigurationList section */
		A00000000000000000000002 /* Build configuration list for PBXProject "Latch" */ = {
			isa = XCConfigurationList;
			buildConfigurations = (
				A0000000000000000000000A /* Debug */,
			);
			defaultConfigurationName = Debug;
		};
		A00000000000000000000008 /* Build configuration list for PBXNativeTarget "Latch" */ = {
			isa = XCConfigurationList;
			buildConfigurations = (
				A00000000000000000000009 /* Debug */,
			);
			defaultConfigurationName = Debug;
		};
		A00000000000000000000017 /* Build configuration list for PBXNativeTarget "LatchScreens" */ = {
			isa = XCConfigurationList;
			buildConfigurations = (
				A00000000000000000000018 /* Debug */,
			);
			defaultConfigurationName = Debug;
		};
/* End XCConfigurationList section */
	};
	rootObject = A00000000000000000000001 /* Project object */;
}
`
  }

  it('reads Xcode’s multi-line, commented layout, keeping quoted values that look like comments', () => {
    expect(parsePbxproj(xcodeProject()).objects).toMatchObject({
      A0000000000000000000000A: { buildSettings: { HEADER_SEARCH_PATHS: '$(SRCROOT)/**', OTHER_LDFLAGS: '// not a comment' } },
      A00000000000000000000005: { fileSystemSynchronizedGroups: ['A00000000000000000000006'], name: 'Latch' },
    })
    expect(checkScreensOnly([], xcodeProject())).toEqual([])
    expect(checkScreensOnly([], xcodeProject('DEBUG $(EXTRA)'))).toEqual([
      'project.pbxproj：Latch 与项目的 SWIFT_ACTIVE_COMPILATION_CONDITIONS 不设置 LATCH_SCREENS，也不经变量间接设置',
    ])
  })

  it('reports a random key made without the Secure Enclave in product code, across the call’s lines', () => {
    const enclave =
      'let key = SecKeyCreateRandomKey([\n  kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,\n  kSecAttrTokenID: kSecAttrTokenIDSecureEnclave,\n] as CFDictionary, nil)'
    const software =
      'let key = SecKeyCreateRandomKey([\n  kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,\n] as CFDictionary, nil)\nlet other = kSecAttrTokenIDSecureEnclave'
    expect(
      checkScreensOnly(
        [
          { path: 'native/ios/Sources/LatchNativeCore/Identity.swift', text: enclave },
          { path: 'native/ios/App/Keys.swift', text: software },
          { path: 'native/ios/App/Live.swift', text: `#if LATCH_SCREENS\n${software}\n#endif` },
          { path: 'native/ios/Testkit/main.swift', text: software },
        ],
        project(),
      ),
    ).toEqual([`native/ios/App/Keys.swift:1：${SOFTWARE}`])
  })

  it('fails instead of skipping when the Screens group, the LatchScreens target or the project cannot be read', () => {
    expect(checkScreensOnly([], project({ screensPath: 'Scenes' }))).toEqual(['project.pbxproj：找不到唯一的 Screens 组'])
    expect(checkScreensOnly([], project({ screensName: 'Screenshots' }))).toContain('project.pbxproj：找不到 LatchScreens 目标')
    expect(checkScreensOnly([], '{ objects = { A = {isa = PBXProject; ')).toHaveLength(1)
  })
})
