'use strict'

const { constants } = require('node:fs')
const { mkdir, open, rename, rm, writeFile } = require('node:fs/promises')
const { randomUUID } = require('node:crypto')
const { join } = require('node:path')

/** @typedef {'zh-CN' | 'en'} Locale */
/** @typedef {Locale | 'system'} Preference */

/** @type {Locale} */
let current = 'zh-CN'
/** @param {unknown} value @returns {value is Locale} */
const isLocale = value => value === 'zh-CN' || value === 'en'
/** @param {unknown} value @returns {value is Preference} */
const isPreference = value => isLocale(value) || value === 'system'
const currentLocale = () => current

/** @param {readonly string[]} languages @returns {Locale} */
function systemLocale(languages) {
  for (const language of languages) {
    if (/^zh(?:-|$)/iu.test(language)) return 'zh-CN'
    if (/^en(?:-|$)/iu.test(language)) return 'en'
  }
  return languages.length === 0 ? 'zh-CN' : 'en'
}

/** @template {object} T @param {T} zh @param {T} en */
function defineCopy(zh, en) {
  return new Proxy(zh, {
    get(target, key) {
      return Reflect.get(current === 'en' ? en : target, key)
    },
  })
}

/** @param {string} directory @param {() => readonly string[]} system */
function createLocale(directory, system) {
  const path = join(directory, 'locale.json')
  /** @type {Preference | undefined} */
  let pending = 'system'
  let writes = Promise.resolve()

  async function load() {
    let file
    try {
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      const info = await file.stat()
      if (info.isFile() && info.size <= 16) {
        const buffer = Buffer.alloc(17)
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        const stored = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
        if (isPreference(stored)) pending = stored
      }
    } catch {
      // An unreadable preference follows the system.
    } finally {
      await file?.close().catch(() => {})
    }
    current = isLocale(pending) ? pending : systemLocale(system())
  }

  /** @param {unknown} preference @param {unknown} language */
  function set(preference, language) {
    if (!isPreference(preference) || !isLocale(language) || (preference !== 'system' && preference !== language)) return false
    const next = preference === 'system' ? systemLocale(system()) : preference
    const changed = current !== next
    current = next
    if (pending !== preference) {
      pending = preference
      writes = writes
        .then(async () => {
          await mkdir(directory, { recursive: true, mode: 0o700 })
          const temp = join(directory, '.locale-' + randomUUID())
          try {
            await writeFile(temp, JSON.stringify(preference), { flag: 'wx', mode: 0o600 })
            await rename(temp, path)
          } finally {
            await rm(temp, { force: true }).catch(() => {})
          }
        })
        .catch(() => {
          if (pending === preference) pending = undefined
        })
    }
    return changed
  }

  return { load, set }
}

module.exports = { createLocale, currentLocale, defineCopy }
