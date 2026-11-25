import { PLUGIN_MARKETPLACE_PAGE, type CurrentDevice, type HostCatalog } from '@latch/protocol'

export type MarketplaceTab = 'bundled' | 'installed' | 'add'

/** The desktop-style Safari UA on iPad identifies as Mac, with a multi-touch pointer. */
export function isAppleMobile({
  userAgent,
  platform,
  maxTouchPoints,
}: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'>): boolean {
  const client = `${userAgent} ${platform}`
  return /\b(iPad|iPhone|iPod)\b/iu.test(client) || (maxTouchPoints > 1 && /\b(Macintosh|MacIntel|MacPPC)\b/iu.test(client))
}

export function marketplaceAvailable(
  snapshot: { catalog?: Pick<HostCatalog, 'workspacePages'>; device: Pick<CurrentDevice, 'scopes'> },
  client: Parameters<typeof isAppleMobile>[0],
): boolean {
  return (
    !isAppleMobile(client)
    && snapshot.device.scopes?.includes('view') === true
    && snapshot.catalog?.workspacePages?.some(
      page =>
        page.pluginId === PLUGIN_MARKETPLACE_PAGE.pluginId
        && page.pageId === PLUGIN_MARKETPLACE_PAGE.pageId
        && page.version === PLUGIN_MARKETPLACE_PAGE.version,
    ) === true
  )
}

export function isMarketplaceLink(url: string): boolean {
  return new URL(url).searchParams.get('page') === 'marketplace'
}

export function marketplaceUrl(url: string, open: boolean): string {
  const next = new URL(url)
  if (open) next.searchParams.set('page', 'marketplace')
  else if (isMarketplaceLink(url)) next.searchParams.delete('page')
  return `${next.pathname}${next.search}${next.hash}`
}
