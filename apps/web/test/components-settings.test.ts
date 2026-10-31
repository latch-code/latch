import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeviceAccess } from '../src/core/permissions.ts'
import { ENROLLMENT_COPY, NATIVE_LINK_COPY, PAIRING_COPY, PAIRING_WAITING_COPY } from '../src/core/securityCopy.ts'
import { missingText } from '../src/settings/AgentsSettings.tsx'
import { PairingSection } from '../src/settings/PhonePairing.tsx'
import { ProjectCard } from '../src/settings/WorkspacesSettings.tsx'

const noop = () => {}
afterEach(() => {
  vi.unstubAllGlobals()
})
/** An adapter preset's detection: the adapter `found`, and the agent it connects to when `companion` is given. */
const adapter = (found: boolean, companion?: boolean) => ({
  command: 'pi-acp',
  detected: { found, ...(companion === undefined ? {} : { companion: { command: 'pi', found: companion } }) },
})

describe('phone pairing', () => {
  const access = (local: boolean, admin = true): DeviceAccess => ({
    legacy: false,
    local,
    scopes: new Set(admin ? ['view', 'admin'] : ['view']),
    admin,
    device: null,
  })
  const FLAG = /(?:^|[\s「（(])--[a-z]/u

  it('names where to make the code, in words, on a device that cannot, and never a flag in any body text', () => {
    const html = renderToStaticMarkup(createElement(PairingSection, { access: access(false) }))
    // Read on the computer running Latch (in its browser) as well as on a phone.
    expect(html).toContain('配对二维码要在 Latch 桌面端生成：在运行 Latch 的电脑上打开桌面端的 设置 › 设备。')
    // A laptop has no camera flow: it uses the copied link.
    expect(ENROLLMENT_COPY.invitationRequired).toContain('其他电脑打开用「复制链接」得到的配对链接')
    expect(html).not.toContain('pnpm latch')
    const body = [
      NATIVE_LINK_COPY.intro,
      ...NATIVE_LINK_COPY.steps,
      PAIRING_COPY.computerRow,
      PAIRING_COPY.needsDesktop,
      PAIRING_COPY.needsAdmin,
      ENROLLMENT_COPY.invitationRequired,
    ]
    for (const text of body) {
      expect(text).not.toMatch(FLAG)
      expect(text).not.toContain('pnpm ')
    }
  })

  it('tells nothing of codes, countdowns, addresses or fingerprints in the pairing words', () => {
    const words = JSON.stringify([
      NATIVE_LINK_COPY.title,
      NATIVE_LINK_COPY.intro,
      NATIVE_LINK_COPY.steps,
      NATIVE_LINK_COPY.contended,
      NATIVE_LINK_COPY.offNetwork,
      PAIRING_WAITING_COPY.nativeConfirm,
    ])
    for (const word of ['六位', '核对码', '指纹', '剩余', '直连', '中继', '局域网']) expect(words).not.toContain(word)
  })
})

describe('agent settings', () => {
  it('names both programs when an adapter preset is missing one of them', () => {
    const agent = adapter
    expect(missingText(agent(true))).toBeUndefined()
    expect(missingText(agent(false))).toBe('未找到命令 pi-acp')
    expect(missingText(agent(true, true))).toBeUndefined()
    expect(missingText(agent(true, false))).toBe('已找到适配器 pi-acp，还没找到 pi')
    expect(missingText(agent(false, true))).toBe('已安装 pi，还差让 Latch 连接它的适配器 pi-acp')
    expect(missingText(agent(false, false))).toBe('未找到 pi 和它的适配器 pi-acp')
  })
})

describe('workspace settings', () => {
  it('lists a workspace the Host disabled with its reason and keeps the remove action', () => {
    const reason = '该目录位于受保护目录（如 .git）内，不能作为项目'
    const html = renderToStaticMarkup(
      createElement(ProjectCard, {
        workspace: { id: 'w1', name: 'hooks', path: '/w/.git/hooks', unavailable: reason },
        owner: true,
        isDefault: false,
        folders: null,
        onRemove: noop,
      }),
    )
    expect(html).toContain('class="settings-card project-card is-unavailable"')
    expect(html).toContain('<span class="ui-status-word" data-tone="warn">不可用</span>')
    expect(html).toContain(`<span class="workspace-unavailable">${reason}</span>`)
    // Removing is in the project's ⋯ menu; a browser copies the folder's path instead of showing it in Finder.
    expect(html).toContain('aria-label="hooks 的操作"')
    expect(html).toContain('aria-label="复制路径"')
    const usable = renderToStaticMarkup(
      createElement(ProjectCard, {
        workspace: { id: 'w2', name: 'app', path: '/w/app' },
        owner: false,
        isDefault: true,
        folders: null,
        onRemove: noop,
      }),
    )
    expect(usable).not.toMatch(/不可用|的操作/)
    expect(usable).toContain('默认')
  })
})
