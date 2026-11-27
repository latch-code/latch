import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'

const run = promisify(execFile)
const simctl = (...args: string[]) => run('/usr/bin/xcrun', ['simctl', ...args], { timeout: 120_000, maxBuffer: 16_777_216 })
/** A runtime's first boot migrates its data and can take minutes. */
const simctlSlow = (...args: string[]) => run('/usr/bin/xcrun', ['simctl', ...args], { timeout: 600_000, maxBuffer: 16_777_216 })
const pause = (ms: number) => new Promise(done => setTimeout(done, ms))

async function captureFirstRows(udid: string, token: string, shot: string, reader: string, started: number) {
  const container = (await simctl('get_app_container', udid, 'codes.latch.ios.screens', 'data')).stdout.trim()
  const gate = join(container, 'tmp', `inbox-${token}`)
  const titles = ['核对发布清单', '检查缓存读取', '整理接口说明']
  const ready = await vi.waitFor(() => stat(gate + '.ready'), { timeout: 15_000 })
  const frame = join(container, 'tmp', `visible-${token}.png`)
  for (const phase of ['first', 'flat', 'grouped'] as const) {
    const grouped = phase === 'grouped'
    if (grouped) await writeFile(gate, '')
    let capturedByMs = 0
    let capturedAfterMetadataByMs = 0
    const deadline = performance.now() + 30_000
    while (true) {
      await simctl('io', udid, 'screenshot', frame)
      capturedByMs = Math.round(performance.now() - started)
      capturedAfterMetadataByMs = Math.max(0, Math.round(Date.now() - ready.mtimeMs))
      const positions: unknown = JSON.parse(
        (await run(reader, [frame, ...(phase === 'first' ? [] : ['--settled']), ...titles, '先显示会话'])).stdout,
      )
      if (!positions || typeof positions !== 'object') throw new Error('Missing screenshot text positions')
      const [lead, member, ordinary, waiting] = [...titles, '先显示会话'].map(title => {
        const values: unknown = Reflect.get(positions, title)
        if (!Array.isArray(values) || !values.every((value): value is number => typeof value === 'number'))
          throw new Error('Missing fixture row positions')
        return values
      })
      if (waiting?.length) throw new Error('The team lookup hides the first project rows')
      if (lead?.length === 1 && member?.length === 1 && ordinary?.length === 1 && Math.abs(ordinary[0]! - lead[0]!) < 0.015) {
        const indent = member[0]! - lead[0]!
        if (grouped ? indent > 0.015 : Math.abs(indent) < 0.015) break
      }
      if (performance.now() >= deadline) throw new Error(`Expected ${grouped ? 'grouped' : 'flat'} rows, saw ${JSON.stringify(positions)}`)
      await pause(250)
    }
    await copyFile(frame, phase === 'flat' ? shot : shot.replace('.png', `-${phase}.png`))
    if (phase === 'first')
      await writeFile(
        shot.replace('.png', '-timing.json'),
        JSON.stringify({ firstRowsVisibleByMs: capturedByMs, afterMetadataReadyByMs: capturedAfterMetadataByMs }),
      )
  }
}

/** Count the code surface in the actual Simulator screenshot; a detached text view cannot verify what the user saw. */
async function expectCodeSurface(png: string, scratch: string, proof: unknown, theme: string) {
  const palettes = proof && typeof proof === 'object' && 'surfaceRGB' in proof ? proof.surfaceRGB : undefined
  const rgb: unknown = palettes && typeof palettes === 'object' ? Reflect.get(palettes, theme) : undefined
  if (!Array.isArray(rgb) || rgb.length !== 3 || !rgb.every(Number.isInteger)) throw new Error('Missing code surface colour')
  const bmp = join(scratch, 'markdown-prose.bmp')
  await run('/usr/bin/sips', ['-Z', '640', '-s', 'format', 'bmp', png, '--out', bmp])
  const bitmap = await readFile(bmp)
  expect(bitmap.toString('ascii', 0, 2)).toBe('BM')
  const width = bitmap.readInt32LE(18),
    height = Math.abs(bitmap.readInt32LE(22)),
    bytes = bitmap.readUInt16LE(28) / 8
  expect([3, 4]).toContain(bytes)
  const stride = Math.ceil((width * bytes) / 4) * 4,
    offset = bitmap.readUInt32LE(10)
  let pixels = 0
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = offset + y * stride + x * bytes
      if (rgb.every((channel, index) => Math.abs(channel - bitmap[at + 2 - index]) <= 1)) pixels += 1
    }
  expect(pixels).toBeGreaterThan(width * height * 0.002)
}

/** Scenes of the LatchScreens target (`native/ios/Screens/ScreensStage.swift`), chosen by a launch argument. */
const SCENES = [
  'code',
  'inbox-first-rows',
  'workspace',
  'workspace-offline',
  'session-team',
  'team-results',
  'team-graph',
  'harness-accounts',
  'usage-empty',
  'usage-quota',
  'usage-spend',
  'question-reminder',
  'push-approval',
  'conversation',
  'conversation-sending',
  'reply-quote-draft',
  'terminal-draft',
  'recovering-chat',
  'offline-draft',
  'markdown',
  'markdown-code',
  'markdown-prose',
  'markdown-dense',
  'markdown-diagram',
  'pictures',
  'conversation-limited',
  'conversation-reading',
  'project-files',
  'conversation-actions',
  'subagents',
  'steer',
  'prompt-queue',
  'clearing',
  'approval-more',
  'approval-hidden',
  'fork',
  'rename',
  'delete',
  'archived',
  'code-status',
  'search',
  'agents',
  'agents-loading',
  'agents-faces',
  'agents-locked',
  'agent-chat',
  'agent-new',
  'agent-mentions',
  'agent-consultation',
  'agent-consultation-approval',
  'agent-consent',
  'agent-create',
  'agent-work-computer',
  'agent-waiting',
  'agent-unavailable',
  'agent-profile',
  'agent-memory',
  'agent-schedules',
  'agent-computer',
  'agent-results',
  'agent-activity',
  'agent-library',
  'general',
  'apps',
  'app-page',
  'pairing',
  'pairing-compare',
  'review-list',
  'updating',
  'review',
  'review-locked',
  'work-list',
  'work-list-offline',
  'work-waiting',
  'work-question',
  'work-approval',
  'work-read-only',
  'work-empty',
  'work-running',
  'work-failed',
  'work-unknown',
  'work-offline',
  'work-locked',
  'work-reply',
  'work-evidence',
  'work-pr',
  'work-log',
  'work-commit',
  'work-review',
  'commit',
  'commit-hook',
  'commit-unknown',
  'handoff',
  'returned',
  'history-entry',
  'history-locked',
  'history-list',
  'history-preview',
  'history-rebuild',
  'history-unknown',
  'history-busy',
  'history-imported',
  'history-seed',
  'history-lost',
  'brands',
  'harness-menu',
  'account-models',
  'account-thinking',
  'about',
  'licenses',
  'computers',
  'computers-settings',
  'attach',
  'attach-unavailable',
  'attach-held',
  'attach-new',
  'attach-topic',
  'attach-sent',
]
/** A narrow and a wide iPhone, and an iPad; the first device type of each list that this Xcode has. */
const DEVICES = [
  { name: 'iphone-narrow', types: ['iPhone-16e', 'iPhone-17e', 'iPhone-16'] },
  { name: 'iphone-wide', types: ['iPhone-17-Pro-Max', 'iPhone-16-Pro-Max', 'iPhone-16-Plus'] },
  { name: 'ipad', types: ['iPad-Pro-11-inch-M5-12GB', 'iPad-Pro-11-inch-M4-8GB', 'iPad-Air-11-inch-M3'] },
]

/**
 * `LATCH_IOS_SCREENS_DEVICE=<udid>`: run on that existing simulator alone, which the test boots when it is not running
 * and never creates, shuts down, erases or deletes; its light or dark appearance is put back at the end.
 */
const DEVICE = process.env.LATCH_IOS_SCREENS_DEVICE
const KEEP_RUNNING = process.env.LATCH_IOS_SCREENS_KEEP_RUNNING === '1'
type Listed = { devices: Record<string, Array<{ name: string; udid: string; state?: string; deviceTypeIdentifier?: string }>> }

/**
 * Opt-in (`LATCH_IOS_SCREENS=1`, macOS with an iOS Simulator runtime): builds the separate LatchScreens target, whose
 * canned scenes never enter the Latch product (`ios-app.e2e.ts` checks the product), then screenshots each scene light
 * and dark on simulators this test creates and deletes. No Host, key or secret is involved. Screenshots go to
 * `LATCH_IOS_SCREENS_DIR`, or `test-results/ios-screens/`; `LATCH_IOS_SCENES` (comma-separated prefixes) keeps only the
 * scenes a change touches.
 */
it.skipIf(process.platform !== 'darwin' || process.env.LATCH_IOS_SCREENS !== '1')(
  'screenshots the App’s scenes from the LatchScreens target on simulators of its own',
  async context => {
    const runtimes = JSON.parse((await simctl('list', 'runtimes', '-j')).stdout) as {
      runtimes: Array<{ identifier: string; version?: string; isAvailable?: boolean; supportedDeviceTypes?: Array<{ identifier: string }> }>
    }
    // A runtime may be for one device alone (iOS 27.2's iPhone Duo build), so it is chosen by what it can run: the newest
    // that has a type from each list, never simply the last one listed.
    const typeId = (name: string) => `com.apple.CoreSimulator.SimDeviceType.${name}`
    const newer = (a: string, b: string) => b.localeCompare(a, undefined, { numeric: true })
    const runtime = runtimes.runtimes
      .filter(item => item.isAvailable && item.identifier.includes('iOS'))
      .filter(item => {
        const supported = new Set((item.supportedDeviceTypes ?? []).map(type => type.identifier))
        return DEVICES.every(device => device.types.some(name => supported.has(typeId(name))))
      })
      .toSorted((a, b) => newer(a.version ?? '', b.version ?? ''))[0]
    if (!runtime && !DEVICE) {
      context.skip('No installed iOS Simulator runtime supports a narrow iPhone, a wide iPhone and an iPad from the lists')
      return
    }
    const supported = new Set((runtime?.supportedDeviceTypes ?? []).map(type => type.identifier))
    const prefixes = (process.env.LATCH_IOS_SCENES ?? '').split(',').filter(Boolean)
    const chosen = prefixes.length ? SCENES.filter(scene => prefixes.some(prefix => scene.startsWith(prefix))) : SCENES
    const types = JSON.parse((await simctl('list', 'devicetypes', '-j')).stdout) as { devicetypes: Array<{ identifier: string }> }
    const known = new Set(types.devicetypes.map(item => item.identifier))
    const output = resolve(process.env.LATCH_IOS_SCREENS_DIR ?? 'test-results/ios-screens')
    await mkdir(output, { recursive: true })
    // A caller can share its private incremental build with the product build and owns cleanup in that case.
    const buildCache = process.env.LATCH_IOS_SCREENS_DERIVED_DATA
    const derived = buildCache ? resolve(buildCache) : await mkdtemp(join(tmpdir(), 'latch-ios-screens-'))
    const created: string[] = []
    let borrowed: { udid: string; appearance: string } | undefined
    try {
      await run(
        '/usr/bin/xcodebuild',
        [
          '-project',
          'native/ios/Latch.xcodeproj',
          '-scheme',
          'LatchScreens',
          '-configuration',
          'Debug',
          '-sdk',
          'iphonesimulator',
          '-destination',
          'generic/platform=iOS Simulator',
          '-derivedDataPath',
          derived,
          '-clonedSourcePackagesDirPath',
          'native/ios/.build/xcode-packages',
          '-disableAutomaticPackageResolution',
          '-onlyUsePackageVersionsFromResolvedFile',
          ...(buildCache ? ['-jobs', '2', 'OTHER_SWIFT_FLAGS=$(inherited) -j2'] : []),
          'CODE_SIGNING_ALLOWED=NO',
          'ARCHS=arm64',
          'ONLY_ACTIVE_ARCH=YES',
          'build',
        ],
        { timeout: 300_000, maxBuffer: 16_777_216 },
      )
      const textReader = join(derived, 'read-screen-text')
      if (
        chosen.some(scene =>
          [
            'inbox-first-rows',
            'agent-consent',
            'harness-accounts',
            'account-models',
            'account-thinking',
            'usage-empty',
            'prompt-queue',
            'steer',
            'conversation-sending',
            'reply-quote-draft',
            'terminal-draft',
          ].includes(scene),
        )
      )
        await run('/usr/bin/xcrun', ['swiftc', 'native/ios/Tools/InboxScreenshotRows.swift', '-o', textReader])
      const application = join(derived, 'Build/Products/Debug-iphonesimulator/LatchScreens.app')
      // The marker the product check looks for is really in this target, so its absence there means something.
      const libraries = (await readdir(application)).filter(name => name.endsWith('.dylib'))
      const product = Buffer.concat(
        await Promise.all(
          [join(application, 'LatchScreens'), ...libraries.map(name => join(application, name))].map(file => readFile(file)),
        ),
      )
      expect(product.includes(Buffer.from('LatchScreens fixture state'))).toBe(true)
      const given = DEVICE
        ? Object.values((JSON.parse((await simctl('list', 'devices', '-j')).stdout) as Listed).devices)
            .flat()
            .find(item => item.udid === DEVICE)
        : undefined
      if (DEVICE && !given) throw new Error('LATCH_IOS_SCREENS_DEVICE names no simulator on this Mac')
      if (KEEP_RUNNING && !given) throw new Error('Keeping the fixture app open requires an explicit screenshot device')
      const targets = given ? [{ name: given.deviceTypeIdentifier?.includes('iPad') ? 'ipad' : 'iphone', types: [] as string[] }] : DEVICES
      let used = 0
      for (const device of targets) {
        let udid: string
        if (given) {
          udid = given.udid
          if (given.state !== 'Booted') await simctlSlow('boot', udid)
        } else {
          const type = device.types.map(typeId).find(id => known.has(id) && supported.has(id))
          if (!type || !runtime) continue
          udid = (await simctl('create', `latch-screens-${device.name}-${Date.now()}`, type, runtime.identifier)).stdout.trim()
          created.push(udid)
          await simctlSlow('boot', udid)
        }
        used += 1
        await simctlSlow('bootstatus', udid, '-b')
        await simctl('install', udid, application)
        await simctl('privacy', udid, 'grant', 'camera', 'codes.latch.ios.screens').catch(() => {})
        if (given) borrowed = { udid, appearance: (await simctl('ui', udid, 'appearance')).stdout.trim() }
        // A fresh install's first launch is slow, so the first scene would be shot blank.
        await simctl('launch', '--terminate-running-process', udid, 'codes.latch.ios.screens', '-LatchScene', chosen[0] ?? 'code')
        await pause(6000)
        for (const theme of ['light', 'dark']) {
          await simctl('ui', udid, 'appearance', theme)
          for (const scene of chosen) {
            const probe = scene === 'markdown-prose' || scene === 'markdown-dense' ? randomUUID() : undefined
            const quoteProbe = scene === 'reply-quote-draft' || scene === 'terminal-draft' ? randomUUID() : undefined
            const inboxProbe = scene === 'inbox-first-rows' ? randomUUID() : undefined
            const started = performance.now()
            await simctl(
              'launch',
              '--terminate-running-process',
              udid,
              'codes.latch.ios.screens',
              '-LatchScene',
              scene,
              ...(probe ? ['-LatchMarkdownProbe', probe] : []),
              ...(quoteProbe ? ['-LatchReplyQuoteProbe', quoteProbe] : []),
              ...(inboxProbe ? ['-LatchInboxProbe', inboxProbe] : []),
            )
            const shot = join(output, `${scene}--${theme}--${device.name}.png`)
            if (inboxProbe) {
              await captureFirstRows(udid, inboxProbe, shot, textReader, started)
              continue
            }
            await pause(2500)
            if (quoteProbe) {
              const container = (await simctl('get_app_container', udid, 'codes.latch.ios.screens', 'data')).stdout.trim()
              const proof = join(container, 'tmp', `reply-quote-${quoteProbe}.json`)
              await vi.waitFor(() => stat(proof), { timeout: 20_000 })
              expect(JSON.parse(await readFile(proof, 'utf8'))).toEqual({
                restored: true,
                keptSource: true,
                deletedOnce: true,
                undoRestoredSource: true,
                undoRestoredText: true,
                undoRestoredAttachment: true,
                redoRemovedSource: true,
                oversizeDraftKept: true,
                shortenedDraftCanSend: true,
                mixedMounted: true,
                distinctSubmitKeys: true,
                compositionKeptSource: true,
                mixedCopy: true,
                mixedPlainEdit: true,
                mixedQuoteUndo: true,
                mixedFileUndo: true,
              })
              await vi.waitFor(
                async () => {
                  await simctl('io', udid, 'screenshot', shot)
                  const words = scene === 'terminal-draft' ? ['Build', 'Done', 'Keep'] : ['Release', 'notes', 'Keep']
                  const positions = JSON.parse((await run(textReader, [shot, ...words, '引用原句'])).stdout) as Record<string, number[]>
                  for (const word of words) expect(positions[word], word).toHaveLength(1)
                  expect(positions['引用原句']).toEqual([])
                },
                { timeout: 20_000, interval: 500 },
              )
            } else if (probe) {
              const container = (await simctl('get_app_container', udid, 'codes.latch.ios.screens', 'data')).stdout.trim()
              const proof = join(container, 'tmp', `markdown-${probe}.json`)
              const readProof = async (): Promise<unknown> => JSON.parse(await readFile(proof, 'utf8'))
              await expect.poll(readProof, { timeout: 20_000, interval: 500 }).toMatchObject({
                codeWraps: true,
                codeInkHasBalancedInsets: true,
                copyPreservesSource: true,
                selectionSurvivesResolution: true,
                authorizedFileBytes: true,
                distinctLinkStyles: true,
                inactiveLinksStayWords: true,
              })
              const palette = await readProof()
              const frame = join(derived, 'markdown-frame.png')
              // The launch transition can still cover a fully laid out iPad scene. Keep the first verified screen frame.
              await vi.waitFor(
                async () => {
                  await simctl('io', udid, 'screenshot', frame)
                  await expectCodeSurface(frame, derived, palette, theme)
                },
                { timeout: 20_000, interval: 500 },
              )
              await copyFile(frame, shot)
            } else if (scene === 'harness-accounts') {
              await vi.waitFor(
                async () => {
                  await simctl('io', udid, 'screenshot', shot)
                  const settled = JSON.parse((await run(textReader, [shot, '--settled', 'Codex'])).stdout) as Record<string, number[]>
                  expect(settled.Codex).toHaveLength(1)
                  const visible = ['Codex', '默认账号', '工作', '研究项目', '自定命令', 'Qwen Code', '管理账号']
                  const absent = ['Grok Build', '插件实例']
                  const positions = JSON.parse((await run(textReader, [shot, ...visible, ...absent, '小组件'])).stdout) as Record<
                    string,
                    number[]
                  >
                  for (const word of visible) expect(positions[word], word).toHaveLength(1)
                  for (const word of absent) expect(positions[word], word).toHaveLength(0)
                  // Vision can misread the small light-on-dark badges even when the account rows have settled.
                  const badges =
                    theme === 'dark' && positions['小组件']?.length !== 2
                      ? (JSON.parse((await run(textReader, [shot, '--invert', '小组件'])).stdout) as Record<string, number[]>)['小组件']
                      : positions['小组件']
                  expect(badges, '小组件').toHaveLength(2)
                  const brandX = positions.Codex?.[0] ?? Number.NaN
                  for (const alias of ['默认账号', '工作', '研究项目']) {
                    const aliasX = positions[alias]?.[0] ?? Number.NaN
                    expect(Math.abs(aliasX - brandX), alias).toBeLessThan(0.006)
                  }
                },
                { timeout: 20_000, interval: 500 },
              )
            } else if (
              scene === 'agent-consent'
              || scene === 'account-models'
              || scene === 'account-thinking'
              || scene === 'usage-empty'
              || scene === 'prompt-queue'
              || scene === 'steer'
              || scene === 'conversation-sending'
            ) {
              const filteredModels = scene === 'account-models'
              const account = filteredModels || scene === 'account-thinking'
              const frame = account ? join(derived, 'account-frame.png') : shot
              await vi.waitFor(
                async () => {
                  await simctl('io', udid, 'screenshot', frame)
                  if (scene === 'agent-consent' || account) {
                    const words = filteredModels
                      ? ['工作', 'Fast', '刷新模型列表']
                      : scene === 'account-thinking'
                        ? ['工作', 'Fast', '深入思考']
                        : ['允许主动联系', '允许按自身权限接单']
                    const positions = JSON.parse(
                      (await run(textReader, [frame, '--settled', ...words, ...(filteredModels ? ['Balanced'] : [])])).stdout,
                    ) as Record<string, number[]>
                    for (const word of words) expect(positions[word], word).toHaveLength(1)
                    if (filteredModels) expect(positions.Balanced).toHaveLength(0)
                    return
                  }
                  if (scene === 'conversation-sending') {
                    const words = ['再看一下发送回执', '正在发送', '回复 Codex', '重试这次提交'] as const
                    const positions = JSON.parse((await run(textReader, [shot, '--vertical', ...words])).stdout) as Record<
                      (typeof words)[number],
                      number[]
                    >
                    for (const word of words.slice(0, 3)) expect(positions[word], word).toHaveLength(1)
                    expect(positions['再看一下发送回执'][0]).toBeLessThan(positions['正在发送'][0]!)
                    expect(positions['正在发送'][0]).toBeLessThan(positions['回复 Codex'][0]!)
                    expect(positions['重试这次提交']).toHaveLength(0)
                    return
                  }
                  if (scene === 'prompt-queue') {
                    const queueRows = async (...options: string[]): Promise<number[]> => {
                      const positions = JSON.parse(
                        (await run(textReader, [shot, '--settled', '--vertical', ...options, '引导'])).stdout,
                      ) as Record<string, number[]>
                      return positions['引导']!
                    }
                    let rows = await queueRows()
                    if (rows.length < 3 && device.name !== 'ipad') {
                      rows = await queueRows('--queue-actions')
                      if (theme === 'dark' && rows.length < 3) rows = await queueRows('--queue-actions', '--invert')
                    }
                    expect(rows).toHaveLength(3)
                    const [first, second, third] = rows.toSorted((a, b) => a - b)
                    expect(second! - first!).toBeGreaterThan(0.015)
                    expect(third! - second!).toBeGreaterThan(0.015)
                    return
                  }
                  if (scene === 'steer') {
                    const positions = JSON.parse((await run(textReader, [shot, '--settled', '立即发送'])).stdout) as Record<
                      string,
                      number[]
                    >
                    expect(positions['立即发送']).toHaveLength(1)
                    return
                  }
                  // The last word of the empty message starts to the right of centre when the sheet shrinks to fit it.
                  const positions = JSON.parse((await run(textReader, [shot, 'Harness'])).stdout) as { Harness: number[] }
                  expect(positions.Harness).toHaveLength(1)
                  expect(positions.Harness[0]).toBeLessThan(0.5)
                },
                { timeout: account ? 60_000 : 20_000, interval: 500 },
              )
              if (frame !== shot) await copyFile(frame, shot)
            } else await simctl('io', udid, 'screenshot', shot)
          }
        }
        if (!given) {
          // Fresh runtimes consume several GB each; release our completed device before booting the next.
          await simctl('shutdown', udid).catch(() => {})
          await simctl('delete', udid)
          created.splice(created.indexOf(udid), 1)
        }
      }
      expect(used).toBeGreaterThan(0)
    } finally {
      if (borrowed) {
        if (!KEEP_RUNNING) await simctl('terminate', borrowed.udid, 'codes.latch.ios.screens').catch(() => {})
        if (borrowed.appearance === 'light' || borrowed.appearance === 'dark') {
          await simctl('ui', borrowed.udid, 'appearance', borrowed.appearance)
        }
      }
      // Only the simulators this test made are shut down and deleted.
      for (const udid of created) {
        await simctl('shutdown', udid).catch(() => {})
        await simctl('delete', udid).catch(() => {})
      }
      if (!buildCache) await rm(derived, { recursive: true, force: true })
    }
  },
  2_700_000,
)
