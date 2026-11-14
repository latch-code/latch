import type { Page } from '@playwright/test'
import { expect } from 'vitest'
import { noHorizontalOverflow } from './layout.ts'

export async function measureWorkbenchSwitch(page: Page, output: string, name: string, action: () => Promise<void>) {
  await page.screenshot({ path: `${output}/${name}-before.png`, animations: 'disabled' })
  const recording = page.evaluate(
    expected =>
      new Promise<{
        intervals: number[]
        switches: number[]
        fades: number[]
        transitions: number[]
        marked: boolean
        firstVisibleMs?: number
        longtasks: number[]
      }>(resolve => {
        let previous = performance.now(),
          clickAt: number | undefined,
          firstVisibleMs: number | undefined
        const began = previous,
          intervals: number[] = [],
          switches: number[] = [],
          fades = new Set<number>(),
          transitions = new Set<number>(),
          longtasks: number[] = []
        let marked = false
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
          // The layout switch is one control that stays in sight through the change, never two and never none.
          switches.push(
            [...document.querySelectorAll<HTMLElement>('[role="radiogroup"][aria-label="布局"]')].filter(
              element => element.checkVisibility({ visibilityProperty: true }) && !element.closest('[inert]'),
            ).length,
          )
          // A layout change is the window's own cross-fade; its pseudo-elements are the document's animations.
          marked ||= document.documentElement.hasAttribute('data-layout-switch')
          for (const animation of document.getAnimations()) {
            const effect = animation.effect
            if (!(effect instanceof KeyframeEffect) || !effect.pseudoElement?.startsWith('::view-transition')) continue
            const duration = effect.getComputedTiming().duration
            if (typeof duration === 'number') transitions.add(duration)
          }
          for (const element of document.querySelectorAll('.workbench-home, .workspace-view, .agents-page'))
            for (const animation of element.getAnimations()) {
              const duration = animation.effect?.getComputedTiming().duration
              if (typeof duration === 'number') fades.add(duration)
            }
          const shell = document.querySelector<HTMLElement>('.app-shell')
          const target = document.querySelector<HTMLElement>(expected.entry === 'agents' ? '.agents-page' : '.workbench-home')
          const content = target?.querySelector<HTMLElement>(expected.entry === 'agents' ? '[data-agent-id]' : '.approval-panel')
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
            resolve({ intervals, switches, fades: [...fades], transitions: [...transitions], marked, firstVisibleMs, longtasks })
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
  expect(result.switches.every(count => count === 1)).toBe(true)
  await noHorizontalOverflow(page)
  await page.screenshot({ path: `${output}/${name}-after.png`, animations: 'disabled' })
  const sorted = result.intervals.toSorted((a, b) => a - b)
  return {
    name,
    frames: sorted.length,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.floor(sorted.length * 0.95)],
    maxMs: sorted.at(-1),
    /** The arriving page's own fade, which only a move between Code and 我的 Agent draws. */
    fades: result.fades,
    /** The durations of the window's view transition; empty with reduced motion or without the API. */
    transitions: result.transitions,
    /** Whether `html[data-layout-switch]` was seen in any frame. */
    marked: result.marked,
    clickToFirstVisibleMs: result.firstVisibleMs,
    longtasksMs: result.longtasks,
  }
}
