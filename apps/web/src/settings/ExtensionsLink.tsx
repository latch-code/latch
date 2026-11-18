import { useContext } from 'react'
import { NavRow, SettingsGroup } from './common.tsx'
import { EXTENSION_COPY } from './extensions.ts'
import { OpenExtensions } from './extensionsLinkContext.ts'

/** Where a Harness's own skills, commands, MCP servers and plugins are shown: one place, 设置 › 扩展. */
export function ExtensionsLink({ title, harnessId }: { title: string; harnessId?: string }) {
  const open = useContext(OpenExtensions)
  if (!open) return null
  return (
    <SettingsGroup>
      <NavRow title={title} value={EXTENSION_COPY.title} onClick={() => open(harnessId)} />
    </SettingsGroup>
  )
}
