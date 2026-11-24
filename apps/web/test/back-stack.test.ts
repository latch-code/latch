import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackStack, type SessionHistory } from '../src/hooks/backStack.ts'

/**
 * A browser's session history for one document: pushing drops the entries ahead, and a traversal the page asks for
 * lands a task later, relative to wherever the page is then, as the browser does it.
 */
class FakeHistory implements SessionHistory {
  entries: unknown[]
  index: number
  stack: BackStack | undefined
  urls: string[]
  constructor(entries: unknown[] = [null], index = entries.length - 1) {
    this.entries = entries
    this.index = index
    this.urls = entries.map(() => '/link/')
  }
  get state(): unknown {
    return this.entries[this.index]
  }
  get url(): string {
    return this.urls[this.index]!
  }
  pushState(state: unknown, _unused: string, url = this.url): void {
    this.entries = [...this.entries.slice(0, this.index + 1), state]
    this.urls = [...this.urls.slice(0, this.index + 1), url]
    this.index += 1
  }
  replaceState(state: unknown, _unused: string, url = this.url): void {
    this.entries[this.index] = state
    this.urls[this.index] = url
  }
  go(delta: number): void {
    setTimeout(() => {
      this.index = Math.max(0, Math.min(this.entries.length - 1, this.index + delta))
      this.stack?.moved(this.state, false)
    }, 0)
  }
  /** The person goes back (the platform's back), with the browser drawing it or not. */
  back(visual = false): void {
    this.index -= 1
    this.stack?.moved(this.state, visual)
  }
  forward(): void {
    this.index += 1
    this.stack?.moved(this.state, false)
  }
}

function setup(history = new FakeHistory()) {
  const stack = new BackStack(history)
  history.stack = stack
  return { history, stack }
}

/** Lets the page's microtasks and any traversal it asked for run. */
const settle = () => vi.runAllTimersAsync()

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('back stack', () => {
  it('pushes one entry per open layer and closes the top one when the person goes back', async () => {
    const { history, stack } = setup()
    const page = vi.fn()
    const sheet = vi.fn()
    stack.open(page)
    stack.open(sheet)
    expect(history.entries).toHaveLength(3)
    history.back()
    expect(sheet).toHaveBeenCalledWith(false)
    expect(page).not.toHaveBeenCalled()
    history.back(true)
    // The browser drew the way back itself, so the page does not animate it again.
    expect(page).toHaveBeenCalledWith(true)
    await settle()
    expect(history.index).toBe(0)
  })

  it('gives the entries back in one traversal when layers close on the page', async () => {
    const { history, stack } = setup()
    const go = vi.spyOn(history, 'go')
    const page = vi.fn()
    const releasePage = stack.open(page)
    const releaseSheet = stack.open(vi.fn())
    releaseSheet()
    releasePage()
    await settle()
    expect(go.mock.calls).toEqual([[-2]])
    expect(history.index).toBe(0)
    expect(page).not.toHaveBeenCalled()
  })

  it('hands the entry of a layer that closes to one that opens in the same change, without moving', async () => {
    const { history, stack } = setup()
    const go = vi.spyOn(history, 'go')
    stack.open(vi.fn())
    const releaseMenu = stack.open(vi.fn())
    // A menu's item closes the menu and opens its confirmation.
    releaseMenu()
    const confirm = vi.fn()
    stack.open(confirm)
    await settle()
    expect(go).not.toHaveBeenCalled()
    expect(history.entries).toHaveLength(3)
    history.back()
    expect(confirm).toHaveBeenCalledOnce()
  })

  it('reuses settings history for the workspace page URL and keeps modal reviews above it', async () => {
    const { history, stack } = setup()
    const closeSettings = stack.open(vi.fn())
    closeSettings()
    const closeMarket = vi.fn()
    stack.open(closeMarket, '/link/?page=marketplace')
    const closeReview = vi.fn()
    stack.open(closeReview)
    expect(history.url).toBe('/link/?page=marketplace')
    history.back()
    expect(closeReview).toHaveBeenCalledOnce()
    expect(closeMarket).not.toHaveBeenCalled()
    expect(history.url).toBe('/link/?page=marketplace')
    history.back()
    expect(closeMarket).toHaveBeenCalledOnce()
    expect(history.url).toBe('/link/')
    await settle()
  })

  it('gives a layer that opens during its own traversal an entry once it lands, so the traversal never closes it', async () => {
    const { history, stack } = setup()
    const release = stack.open(vi.fn())
    release()
    // The traversal back over the page's entry is asked for once the change settles, and lands a task later.
    await Promise.resolve()
    const sheet = vi.fn()
    stack.open(sheet)
    await settle()
    expect(sheet).not.toHaveBeenCalled()
    expect(history.index).toBe(1)
    history.back()
    expect(sheet).toHaveBeenCalledOnce()
  })

  it('takes the entry a reload left for the page restored there, and skips entries no layer holds', async () => {
    // Reloaded on the panel page (depth 2) over a session (depth 1); only the session comes back.
    const history = new FakeHistory([null, { latchLayer: 1 }, { latchLayer: 2 }])
    const { stack } = setup(history)
    const session = vi.fn()
    stack.open(session)
    expect(history.entries).toHaveLength(3)
    history.back()
    expect(session).toHaveBeenCalledOnce()
    // The entry under it is held by nothing, so the same press lands on the list's.
    await settle()
    expect(history.index).toBe(0)
    // Going forward to a closed layer's entry comes straight back.
    history.forward()
    await settle()
    expect(history.index).toBe(0)
  })
})
