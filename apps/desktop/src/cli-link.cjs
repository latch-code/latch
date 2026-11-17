'use strict'
const { lstat, mkdir, readlink, symlink } = require('node:fs/promises')
const { userInfo } = require('node:os')
const { delimiter, join, resolve } = require('node:path')

/** A user-level command link. Creation is exclusive; an existing command is never overwritten or removed. */
function createCliLink({ target, available, home = userInfo().homedir, uid = process.getuid?.(), path = process.env.PATH ?? '' }) {
  const bin = join(home, '.local', 'bin')
  const destination = join(bin, 'latch')
  const inPath = path.split(delimiter).some(entry => entry && resolve(entry) === bin)
  async function view() {
    if (!available) return { status: 'unavailable', path: destination, target, inPath }
    const info = await lstat(destination).catch(() => undefined)
    if (!info) return { status: 'unlinked', path: destination, target, inPath }
    const linked = info.isSymbolicLink() && info.uid === uid && (await readlink(destination).catch(() => '')) === target
    return { status: linked ? 'linked' : 'occupied', path: destination, target, inPath }
  }
  async function install() {
    if (!available) return view()
    for (const directory of [join(home, '.local'), bin]) {
      await mkdir(directory, { mode: 0o755 }).catch(error => {
        if (error.code !== 'EEXIST') throw error
      })
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o022) !== 0)
        throw new Error('命令行目录的属主或权限不安全，未创建链接。')
    }
    try {
      await symlink(target, destination)
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error
    }
    return view()
  }
  return { view, install }
}

module.exports = { createCliLink }
