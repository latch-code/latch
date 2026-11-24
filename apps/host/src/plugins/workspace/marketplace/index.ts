import { PLUGIN_MARKETPLACE_PAGE, type BundledWorkspacePage } from '@latch/protocol'
import type { LatchPlugin } from '@latch/sdk'

const DESCRIPTION = '浏览随 Latch 提供的插件，并从此电脑批准的 npm 源查看和下载插件。'

export function createMarketplacePlugin(publish: (page: BundledWorkspacePage) => () => void): LatchPlugin {
  return {
    id: PLUGIN_MARKETPLACE_PAGE.pluginId,
    name: '插件市场',
    version: '1.0.0',
    description: DESCRIPTION,
    activate(context) {
      context.onDispose(publish(PLUGIN_MARKETPLACE_PAGE))
    },
  }
}
