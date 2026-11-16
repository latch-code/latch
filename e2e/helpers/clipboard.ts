import type { Page } from '@playwright/test'

function installClipboardRecorder(): void {
  if (window !== window.top) return
  const writes: string[] = []
  Reflect.set(window, 'latchTestClipboardWrites', writes)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      async writeText(text: string) {
        writes.push(text)
      },
    },
  })
  Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false })
}

/** Records each copy in order on the opted-in page, including after unexpected navigation. */
export async function recordClipboardWrites(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(installClipboardRecorder)
  await page.evaluate(installClipboardRecorder)
  return () =>
    page.evaluate(() => {
      const writes = Reflect.get(window, 'latchTestClipboardWrites') as string[] | undefined
      if (!writes) throw new Error('The clipboard recorder is missing')
      return writes
    })
}
