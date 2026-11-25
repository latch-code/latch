import { createHash } from 'node:crypto'
import { vi } from 'vitest'
import { officialGithubResponse } from '@latch/testkit'
import type { FetchLike } from '../../src/egress.ts'
import { requireBundledPlugin } from '../../src/plugin-catalog.ts'

const id = 'context-insights'
const ids = ['shift-handoff', 'release-review', 'release-check', id]

function snapshot(version?: string, suffix = '') {
  const files = new Map<string, string>()
  const catalog = ids.map(pluginId => {
    const { manifest, files: contents } = requireBundledPlugin(pluginId).bundle
    const folder = `plugins/${pluginId}`
    const declaration = manifest.formatVersion === 2 ? 'latch-app.json' : 'latch-plugin.json'
    files.set(`${folder}/${declaration}`, JSON.stringify(pluginId === id && version ? { ...manifest, version } : manifest))
    for (const file of contents) files.set(`${folder}/${file.path}`, file.content + (pluginId === id ? suffix : ''))
    return { id: pluginId, folder, manifest: declaration, files: contents.map(file => file.path) }
  })
  files.set('latch.catalog.json', JSON.stringify({ formatVersion: 1, plugins: catalog }))
  return {
    files,
    commit: createHash('sha1')
      .update(JSON.stringify([...files]))
      .digest('hex'),
  }
}

/** A public GitHub main branch whose four packages start as the Host's own bundled release. */
export function officialCatalogFixture() {
  let head = snapshot()
  const commits = new Map([[head.commit, head]])
  const fetch = vi.fn<FetchLike>(async input => {
    const pin = new URL(input).pathname.split('/').find(part => commits.has(part))
    const snapshot = pin ? commits.get(pin)! : head
    return officialGithubResponse(input, snapshot.commit, snapshot.files)
  })
  return {
    fetch,
    publishContext(version: string, suffix = '') {
      head = snapshot(version, suffix)
      commits.set(head.commit, head)
      return head.commit
    },
  }
}
