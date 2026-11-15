import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { ChartNoAxesColumn } from 'lucide-react'
import { CloseGlyph, Icon, IconButton, Sheet } from '@latch/ui'
import type { HarnessInfo } from '@latch/protocol'
import { HarnessTile } from '../components/BrandTile.tsx'
import { QuotaPanel } from '../composer/HarnessQuota.tsx'
import { quotaView } from '../composer/harnessQuota.ts'
import { hostNow, useTicker } from '../core/hostClock.ts'
import { overlayDismissed } from '../escapeGrace.ts'
import type { ShellState } from './useShellLayout.tsx'

type Mode = 'closed' | 'preview' | 'pinned' | 'sheet'

function QuotaContents({ harnesses, offline }: { harnesses: readonly HarnessInfo[]; offline: boolean }) {
  useTicker('minute')
  const [, expire] = useState(0)
  const now = hostNow()
  const nextReset = Math.min(
    ...harnesses.flatMap(
      harness =>
        harness.quota?.windows.flatMap(window => {
          const at = Date.parse(window.resetsAt ?? '')
          return at > now && at <= now + 61_000 ? [at] : []
        }) ?? [],
    ),
  )
  useEffect(() => {
    if (!Number.isFinite(nextReset)) return
    const timer = setTimeout(() => expire(version => version + 1), Math.max(0, nextReset - hostNow()) + 1)
    return () => clearTimeout(timer)
  }, [nextReset])
  const reports = harnesses.flatMap(harness => {
    const view = quotaView(harness.quota, now)
    return view ? [{ harness, view }] : []
  })
  return (
    <div className="host-quota-content">
      {offline && <p className="host-quota-note">连接中断，显示上次收到的额度。</p>}
      {reports.length === 0 && <p className="host-quota-note">尚未收到有效额度。</p>}
      {reports.map(({ harness, view }) => (
        <section className="host-quota-harness" key={harness.id} aria-label={harness.name}>
          <h3>
            <HarnessTile harness={harness} size={20} />
            {harness.name}
          </h3>
          {view.state === 'limited' && view.rows.every(row => row.state !== 'limited') && <p className="host-quota-limit">额度已用尽</p>}
          <QuotaPanel view={view} showUsed />
        </section>
      ))}
    </div>
  )
}

function otherLayer(own: HTMLElement | null): boolean {
  return [...document.querySelectorAll('dialog[open], :popover-open:not([role="tooltip"]):not([aria-hidden="true"])')].some(
    layer => layer !== own,
  )
}

/** Non-modal while browsing with a mouse or keyboard. Only the touch sheet takes the whole window's focus. */
function QuotaControl({
  harnesses,
  offline,
  appearance,
  phone,
}: {
  harnesses: readonly HarnessInfo[]
  offline: boolean
  appearance: 'icon' | 'row' | 'tab'
  phone: boolean
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const sheet = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<Mode>('closed')
  const leave = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const anchor = useRef<DOMRect | null>(null)
  const resumeHoverOnMovement = useRef(false)
  const close = useCallback(() => {
    if (panel.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true })
    setMode('closed')
  }, [])
  const floating = mode === 'preview' || mode === 'pinned'

  useLayoutEffect(() => {
    const surface = panel.current
    const button = trigger.current
    if (!floating || !surface || !button) return
    surface.showPopover()
    const place = () => {
      const box = button.getBoundingClientRect()
      const gap = 5
      const margin = 12
      const above = box.top - gap
      const below = innerHeight - box.bottom - gap
      const up = above > below
      const left = Math.min(appearance === 'row' ? box.left : box.right - surface.offsetWidth, innerWidth - surface.offsetWidth - margin)
      surface.style.left = `${Math.max(margin, left)}px`
      surface.style.top = up ? 'auto' : `${box.bottom + gap}px`
      surface.style.bottom = up ? `${innerHeight - above}px` : 'auto'
      surface.style.maxHeight = `${Math.max(0, (up ? above : below) - margin)}px`
      anchor.current = box
    }
    place()
    const scroll = () => {
      const box = button.getBoundingClientRect()
      if (anchor.current && (box.top !== anchor.current.top || box.left !== anchor.current.left)) close()
    }
    window.addEventListener('resize', place)
    window.addEventListener('scroll', scroll, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', scroll, true)
      if (surface.matches(':popover-open')) surface.hidePopover()
    }
  }, [appearance, close, floating])

  useLayoutEffect(() => {
    if (mode === 'pinned') panel.current?.querySelector('button')?.focus({ preventScroll: true })
  }, [mode])

  useLayoutEffect(() => {
    if (mode === 'closed') return
    const own = mode === 'sheet' ? (sheet.current?.closest('dialog') ?? null) : panel.current
    const covered = () => trigger.current?.closest('[inert], [hidden], [aria-hidden="true"]') != null
    const dismiss = () => {
      resumeHoverOnMovement.current = true
      setMode('closed')
    }
    const observer = new MutationObserver(() => {
      if (covered()) dismiss()
    })
    for (let element: HTMLElement | null = trigger.current; element; element = element.parentElement) {
      observer.observe(element, { attributes: true, attributeFilter: ['inert', 'hidden', 'aria-hidden'] })
    }
    const layerOpening = (event: Event) => {
      const layer = event.target
      if (
        event instanceof ToggleEvent
        && event.newState === 'open'
        && layer instanceof HTMLElement
        && layer !== own
        && layer.matches('dialog, [popover]:not([role="tooltip"]):not([aria-hidden="true"])')
      )
        dismiss()
    }
    const outside = (event: globalThis.PointerEvent) => {
      if (mode === 'sheet' || !(event.target instanceof Node)) return
      if (!trigger.current?.contains(event.target) && !panel.current?.contains(event.target)) close()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229) return
      if (mode === 'sheet' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      resumeHoverOnMovement.current = true
      if (covered() || otherLayer(own)) {
        dismiss()
        return
      }
      event.preventDefault()
      event.stopPropagation()
      overlayDismissed()
      close()
    }
    // Popovers change top-layer state without changing their DOM attributes.
    document.addEventListener('beforetoggle', layerOpening, true)
    window.addEventListener('keydown', escape, true)
    window.addEventListener('pointerdown', outside, true)
    return () => {
      observer.disconnect()
      document.removeEventListener('beforetoggle', layerOpening, true)
      window.removeEventListener('keydown', escape, true)
      window.removeEventListener('pointerdown', outside, true)
      clearTimeout(leave.current)
    }
  }, [close, mode])

  const clearLeave = () => clearTimeout(leave.current)
  const scheduleLeave = () => {
    clearLeave()
    if (mode === 'preview') leave.current = setTimeout(close, 200)
  }
  const preview = () => {
    if (!phone && mode === 'closed' && !otherLayer(null)) setMode('preview')
  }
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={appearance === 'tab' ? 'phone-tab host-quota-trigger' : 'host-quota-trigger'}
        data-quota-appearance={appearance}
        aria-label="额度"
        aria-haspopup="dialog"
        aria-expanded={mode !== 'closed'}
        aria-controls={floating ? id : undefined}
        onPointerEnter={event => {
          clearLeave()
          if (event.pointerType === 'mouse' && !resumeHoverOnMovement.current) preview()
        }}
        onPointerMove={event => {
          if (event.pointerType !== 'mouse' || !resumeHoverOnMovement.current || !event.nativeEvent.isTrusted) return
          if (!event.movementX && !event.movementY) return
          resumeHoverOnMovement.current = false
          preview()
        }}
        onPointerLeave={scheduleLeave}
        onClick={event => {
          clearLeave()
          if (mode === 'pinned' || mode === 'sheet') close()
          else if (!otherLayer(panel.current)) {
            const touch = event.nativeEvent instanceof PointerEvent && event.nativeEvent.pointerType === 'touch'
            const coarse = touch || matchMedia('(pointer: coarse)').matches
            setMode(phone || coarse ? 'sheet' : 'pinned')
          }
        }}>
        <Icon icon={ChartNoAxesColumn} size={appearance === 'tab' ? 20 : 16} />
        {appearance !== 'icon' && <span>额度</span>}
      </button>
      {floating && (
        <div
          ref={panel}
          id={id}
          popover="manual"
          role="dialog"
          aria-label="Harness 额度"
          className="host-quota-popover"
          onPointerEnter={clearLeave}
          onPointerLeave={scheduleLeave}>
          <header className="host-quota-heading">
            <h2>Harness 额度</h2>
            {mode === 'pinned' && <IconButton label="关闭额度" icon={CloseGlyph} onClick={close} />}
          </header>
          <QuotaContents harnesses={harnesses} offline={offline} />
        </div>
      )}
      {mode === 'sheet' && (
        <Sheet open title="Harness 额度" cancelLabel="关闭" onClose={close}>
          <div ref={sheet}>
            <QuotaContents harnesses={harnesses} offline={offline} />
          </div>
        </Sheet>
      )}
    </>
  )
}

export function ShellQuota({ shell, appearance = 'icon' }: { shell: ShellState; appearance?: 'icon' | 'row' | 'tab' }) {
  const { snapshot, access, route, space, phone, connection } = shell
  if (!access.scopes.has('view')) return null
  return (
    <QuotaControl
      key={JSON.stringify([
        snapshot.host?.hostId,
        snapshot.device.id,
        snapshot.device.dataScope,
        snapshot.device.scopes,
        route.entry,
        space,
      ])}
      harnesses={snapshot.catalog?.harnesses ?? []}
      offline={connection === 'offline' || connection === 'reconnecting'}
      appearance={appearance}
      phone={phone}
    />
  )
}
