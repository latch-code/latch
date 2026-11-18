'use strict'
const { execFile } = require('node:child_process')
const { homedir } = require('node:os')
const { isAbsolute, join } = require('node:path')
const { hostEnvironment } = require('./lifecycle.cjs')

/** The application bootstrap has no Node dependency of its own. The native entry verifies system Node first. */
function runLauncher(launcher, args) {
  return new Promise((resolve, reject) => {
    execFile(
      launcher,
      args,
      { env: hostEnvironment(process.env), cwd: '/', timeout: 75_000, maxBuffer: 16 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || '无法启动 Latch，请检查 Node.js 安装。'))
        else resolve(stdout)
      },
    )
  })
}

async function packagedNode(launcher, run = runLauncher) {
  const value = JSON.parse(await run(launcher, ['--runtime-path']))
  if (!value || typeof value.path !== 'string' || !isAbsolute(value.path) || typeof value.version !== 'string')
    throw new Error('无法核对 Node.js 安装。')
  return value.path
}

/**
 * Starts (or finds) the Host for `dataDir`. The Host answers with where it runs: `dataDir`, or `legacyDataDir` when
 * its data stays at the old macOS place (a link there, or a default folder inside it); nothing else is accepted.
 */
async function startPackagedHost({ launcher, dataDir, legacyDataDir, run = runLauncher }) {
  const value = JSON.parse(await run(launcher, ['--internal-desktop-bootstrap', '--data-dir', dataDir, '--port', '0']))
  const accepted = [dataDir, ...(legacyDataDir ? [legacyDataDir] : [])].map(directory => join(directory, 'host.json'))
  if (!value || !accepted.includes(value.hostStatePath)) throw new Error('Latch 启动结果无法核对。')
  return value.hostStatePath
}

/** The macOS data directory from before `~/.latch/host`; as `legacyDataDir` in apps/host/src/paths.ts. */
function packagedLegacyHostDataDir({ platform = process.platform, appData }) {
  return platform === 'darwin' && appData ? join(appData, 'Latch', 'Host') : undefined
}

/**
 * The Host's default data directory, spelled here because the shell cannot import the Host. It must equal
 * `defaultDataDir` in apps/host/src/paths.ts (a Host test compares the two): the shell finds host.json through it. On
 * macOS that is `~/.latch/host`; the Host moves the old `Application Support/Latch/Host` there on its first start.
 * @param {{ platform?: NodeJS.Platform, home?: string, appData?: string }} [input]
 */
function packagedHostDataDir({ platform = process.platform, home = homedir(), appData } = {}) {
  if (platform === 'darwin') return join(home, '.latch', 'host')
  return join(appData ?? join(home, 'AppData', 'Roaming'), 'Latch', 'Host')
}

module.exports = { packagedHostDataDir, packagedLegacyHostDataDir, packagedNode, startPackagedHost }
