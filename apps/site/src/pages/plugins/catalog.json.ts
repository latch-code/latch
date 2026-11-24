import type { APIRoute } from 'astro'
import { marketplaceDownloads } from '../../marketplace.ts'

export const GET: APIRoute = async () => {
  const plugins = (await marketplaceDownloads()).map(({ entry, version, sha256, href }) => ({
    id: entry.id,
    version,
    publisher: 'Latch',
    sha256,
    url: href,
    en: entry.en,
    zh: entry.zh,
  }))
  return Response.json({ formatVersion: 1, plugins })
}
