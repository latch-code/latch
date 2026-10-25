import { afterEach, describe, expect, it, vi } from 'vitest'
import { shellFolders } from '../src/core/shell.ts'

afterEach(() => vi.unstubAllGlobals())
describe('desktop folder protocol compatibility', () => {
  it('requires the signed folder protocol even when an older shell already has folder methods', () => {
    const folders = { pick: vi.fn(), drop: vi.fn(), reveal: vi.fn() }
    vi.stubGlobal('window', { latchShell: { kind: 'electron', folders } })
    expect(shellFolders()).toBeNull()
    const signed = { ...folders, protocolVersion: 1 }
    vi.stubGlobal('window', { latchShell: { kind: 'electron', folders: signed } })
    expect(shellFolders()).toBe(signed)
    vi.stubGlobal('window', { latchShell: { kind: 'electron', folders: { ...signed, reveal: undefined } } })
    expect(shellFolders()).toBeNull()
  })
})
