'use strict'
const { execFile } = require('node:child_process')
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

async function startPackagedHost({ launcher, dataDir, run = runLauncher }) {
  const value = JSON.parse(await run(launcher, ['--internal-desktop-bootstrap', '--data-dir', dataDir, '--port', '0']))
  if (!value || value.hostStatePath !== join(dataDir, 'host.json')) throw new Error('Latch 启动结果无法核对。')
  return value.hostStatePath
}

module.exports = { packagedNode, startPackagedHost }
