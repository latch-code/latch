import type { Page } from '@playwright/test'
import { expect } from 'vitest'
import { noHorizontalOverflow } from './layout.ts'

export async function measureWorkbenchSwitch(page: Page, output: string, name: string, action: () => Promise<void>) {
  await page.screenshot({ path: `${output}/${name}-before.png`, animations: 'disabled' })
  const recording = page.evaluate(
    expected =>
      new Promise<{ intervals: number[]; triggers: number[]; fades: number[]; firstVisibleMs?: number; longtasks: number[] }>(resolve => {
        let previous = performance.now(),
          clickAt: number | undefined,
          firstVisibleMs: number | undefined
        const began = previous,
          intervals: number[] = [],
          triggers: number[] = [],
          fades = new Set<number>(),
          longtasks: number[] = []
        const clicked = () => {
          clickAt ??= performance.now()
        }
        document.addEventListener('click', clicked, { capture: true, once: true })
        const observer = new PerformanceObserver(list => {
          for (const entry of list.getEntries())
            if (clickAt !== undefined && entry.startTime + entry.duration >= clickAt) longtasks.push(entry.duration)
        })
        observer.observe({ type: 'longtask' })
        const frame = (now: number) => {
          intervals.push(now - previous)
          previous = now
          triggers.push(
            [...document.querySelectorAll<HTMLElement>('[data-layout-trigger]')].filter(
              element => element.checkVisibility({ visibilityProperty: true }) && !element.closest('[inert]'),
            ).length,
          )
          for (const element of document.querySelectorAll('.workbench-home, .workspace-view, .agents-page'))
            for (const animation of element.getAnimations()) {
              const duration = animation.effect?.getComputedTiming().duration
              if (typeof duration === 'number') fades.add(duration)
            }
          const shell = document.querySelector<HTMLElement>('.app-shell')
          const target = document.querySelector<HTMLElement>(expected.entry === 'agents' ? '.agents-page' : '.workbench-home')
          const content = target?.querySelector<HTMLElement>(
            expected.entry === 'agents' ? '.agents-list-row:not([data-skeleton])' : '.approval-panel',
          )
          if (
            clickAt !== undefined
            && firstVisibleMs === undefined
            && target?.checkVisibility({ visibilityProperty: true })
            && content?.checkVisibility({ visibilityProperty: true })
            && Number(getComputedStyle(target).opacity) > 0
            && (!expected.layout || shell?.dataset.workbenchLayout === expected.layout)
            && (!expected.entry || shell?.dataset.entry === expected.entry)
          )
            firstVisibleMs = now - clickAt
          if ((clickAt === undefined && now - began < 5000) || (clickAt !== undefined && now - clickAt < 500)) requestAnimationFrame(frame)
          else {
            observer.disconnect()
            document.removeEventListener('click', clicked, true)
            resolve({ intervals, triggers, fades: [...fades], firstVisibleMs, longtasks })
          }
        }
        requestAnimationFrame(frame)
      }),
    {
      layout: name.includes('to-b') ? 'triage' : name === 'b-to-a' ? 'overview' : undefined,
      entry: name === 'code-to-agent' ? 'agents' : name === 'agent-to-code' ? 'sessions' : undefined,
    },
  )
  await action()
  const result = await recording
  expect(result.firstVisibleMs).toBeDefined()
  expect(result.triggers.every(count => count === 1)).toBe(true)
  await noHorizontalOverflow(page)
  await page.screenshot({ path: `${output}/${name}-after.png`, animations: 'disabled' })
  const sorted = result.intervals.toSorted((a, b) => a - b)
  return {
    name,
    frames: sorted.length,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.floor(sorted.length * 0.95)],
    maxMs: sorted.at(-1),
    fades: result.fades,
    clickToFirstVisibleMs: result.firstVisibleMs,
    longtasksMs: result.longtasks,
  }
}
