// The page's behaviour: the nav's glass, the hero film, the feature tabs, films in slots, the plugin filter and the
// download page. Everything readable is in the HTML already; this only changes state. Strings that change with state come
// from the page's #copy JSON. Links live in src/config.ts and are written into the HTML at build time.

type Copy = { copy: string; copied: string; pending: string; this: string; note: Record<string, string>; lang: string }

const $ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector<T>(s)
const $$ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => Array.from(r.querySelectorAll<T>(s))
const motionOK = () => !window.matchMedia('(prefers-reduced-motion: reduce)').matches
const C: Copy = JSON.parse($('#copy')?.textContent || '{}')
const restart = (el: Element, cls: string) => {
  el.classList.remove(cls)
  void (el as HTMLElement).offsetWidth
  el.classList.add(cls)
}
const idle = (fn: () => void) =>
  'requestIdleCallback' in window ? window.requestIdleCallback(fn, { timeout: 2500 }) : setTimeout(fn, 1200)
const store = {
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v)
    } catch {
      /* optional */
    }
  },
}
// Pictures kept in data attributes until they are about to be seen.
const warm = (root: ParentNode) => {
  $$<HTMLSourceElement>('source[data-srcset]', root).forEach(s => {
    s.srcset = s.dataset.srcset!
    s.removeAttribute('data-srcset')
  })
  $$<HTMLImageElement>('img[data-src]', root).forEach(i => {
    i.src = i.dataset.src!
    i.removeAttribute('data-src')
  })
  // Lazy pictures in a hidden tab panel load only when shown; asking for them early makes the switch instant.
  $$<HTMLImageElement>('img[loading="lazy"]', root).forEach(i => {
    i.loading = 'eager'
  })
}

/* ---------- Language choice is remembered ---------- */
$$('[data-lang-link]').forEach(a => a.addEventListener('click', () => store.set('latch-lang', a.dataset.langLink || '')))

/* ---------- Nav ---------- */
const nav = $('[data-nav]')
if (nav) {
  const onScroll = () => nav.classList.toggle('is-stuck', window.scrollY > 8)
  onScroll()
  window.addEventListener('scroll', onScroll, { passive: true })
}

/* ---------- A short note for links that are not live yet ---------- */
const toast = $('[data-toast]')
let toastTimer = 0
const say = (text: string) => {
  if (!toast) return
  toast.textContent = text
  restart(toast, 'is-on')
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => toast.classList.remove('is-on'), 3200)
}
document.addEventListener('click', e => {
  const soon = (e.target as Element).closest<HTMLElement>('[data-soon]')
  if (soon) say(soon.dataset.soon!)
})

/* ---------- Copy buttons ---------- */
document.addEventListener('click', e => {
  const btn = (e.target as Element).closest<HTMLButtonElement>('[data-copy]')
  if (!btn) return
  const code = btn.parentElement?.querySelector('code')
  const text = code?.textContent?.trim()
  if (!text) return
  const done = () => {
    btn.dataset.done = ''
    btn.setAttribute('aria-label', C.copied)
    setTimeout(() => {
      delete btn.dataset.done
      btn.setAttribute('aria-label', C.copy)
    }, 1400)
  }
  const select = () => {
    const r = document.createRange()
    r.selectNodeContents(code!)
    const s = window.getSelection()
    s?.removeAllRanges()
    s?.addRange(r)
  }
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, select)
  else select()
})

/* ---------- Strips that scroll ---------- */
// On narrow screens a strip of tabs or steps scrolls; the edge with more behind it fades.
const edges = (list: HTMLElement) => {
  const update = () => {
    list.classList.toggle('can-left', list.scrollLeft > 2)
    list.classList.toggle('can-right', list.scrollLeft + list.clientWidth < list.scrollWidth - 2)
  }
  list.addEventListener('scroll', update, { passive: true })
  window.addEventListener('resize', update, { passive: true })
  update()
}
// Bring an item of a scrolling strip into view without moving the page.
const reveal = (list: HTMLElement, item: HTMLElement, center = true) => {
  if (list.scrollWidth <= list.clientWidth + 2) return
  const left = center
    ? item.offsetLeft - (list.clientWidth - item.offsetWidth) / 2
    : Math.min(Math.max(list.scrollLeft, item.offsetLeft + item.offsetWidth - list.clientWidth), item.offsetLeft)
  list.scrollTo({ left, behavior: motionOK() ? 'smooth' : 'auto' })
}

/* ---------- Hero: the film ---------- */
// Recordings of the Mac and the phone on one clock: the Mac's leads and the phone follows. The film may come in
// segments (src/hero.json); each device then has two video elements, the one playing and the next segment loading
// behind it, so a cut never shows a gap. Only the first segment loads before the page is idle; the next starts loading
// once the one before it plays. The film stops where the approval waits on the phone and goes on when the visitor taps
// Allow, or by itself a few seconds later. Reduced motion: nothing plays by itself; the needs-you pictures show and
// Allow turns them into the handed-back ones.
type Source = { src: string; small?: string }
type Segment = { from: number; to: number; mac: Source; phone: Source }
const film = $('[data-film]')
if (film) {
  const lanes = {
    mac: [$<HTMLVideoElement>('[data-film-video="mac"]', film)!],
    phone: [$<HTMLVideoElement>('[data-film-video="phone"]', film)!],
  }
  const segments = JSON.parse(film.dataset.segments || '[]') as Segment[]
  const duration = Number(film.dataset.duration) || 0
  const HOLD = film.dataset.hold === undefined ? Infinity : Number(film.dataset.hold)
  const ALLOWED = film.dataset.allowed === undefined ? HOLD : Number(film.dataset.allowed)
  const allow = $<HTMLButtonElement>('[data-allow]', film)!
  const bar = $('[data-chapters]')!
  const list = $('.chapters__list', bar)!
  const chapters = $$<HTMLButtonElement>('[data-chapter]', bar)
  const toggle = $<HTMLButtonElement>('[data-film-toggle]', bar)!
  const phoneBox = $('.film__phone', film)!
  const small = window.matchMedia('(max-width: 52rem)').matches
  const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true
  let wanted = motionOK() && !saveData
  let ended = false
  let inView = false
  let loaded = false
  let passed = false
  let holding = false
  let holdTimer = 0
  let frame = 0
  let seg = 0
  let slot = 0
  let current = -1
  bar.hidden = false
  edges(list)
  // A second element per device carries the next segment while the current one plays.
  if (segments.length > 1)
    for (const lane of [lanes.mac, lanes.phone]) {
      const next = lane[0]!.cloneNode() as HTMLVideoElement
      next.classList.remove('is-active')
      lane[0]!.after(next)
      lane.push(next)
    }
  const mac = () => lanes.mac[slot]!
  const phone = () => lanes.phone[slot]!
  const videos = () => [mac(), phone()]
  const now = () => (segments[seg]?.from ?? 0) + mac().currentTime
  // Allow's box on the phone (set on the button) also places the hint.
  for (const k of ['--l', '--t', '--w', '--h']) phoneBox.style.setProperty(k, allow.style.getPropertyValue(k))

  const url = (s: Source) => (small && s.small ? s.small : s.src)
  // Point an element at a segment's file once; the browser starts fetching it now.
  const assign = (v: HTMLVideoElement, index: number, device: 'mac' | 'phone') => {
    if (v.dataset.segment === String(index)) return
    v.dataset.segment = String(index)
    v.preload = 'auto'
    v.src = url(segments[index]![device])
    v.load()
  }
  const load = () => {
    if (loaded) return
    loaded = true
    assign(mac(), seg, 'mac')
    assign(phone(), seg, 'phone')
  }
  const loadNext = () => {
    const next = seg + 1
    if (next >= segments.length) return
    assign(lanes.mac[1 - slot]!, next, 'mac')
    assign(lanes.phone[1 - slot]!, next, 'phone')
  }
  // Make segment `index` the playing one, on whichever element already holds it.
  const enter = (index: number) => {
    if (index === seg) return
    const ready = lanes.mac.findIndex(v => v.dataset.segment === String(index))
    if (ready >= 0) slot = ready
    seg = index
    assign(mac(), seg, 'mac')
    assign(phone(), seg, 'phone')
    for (const lane of [lanes.mac, lanes.phone]) lane.forEach((v, i) => v.classList.toggle('is-active', i === slot))
    for (const lane of [lanes.mac, lanes.phone]) lane.forEach((v, i) => i !== slot && v.pause())
  }
  const showToggle = () => {
    const paused = !wanted || holding || ended
    toggle.classList.toggle('is-paused', paused)
    toggle.setAttribute('aria-label', ended ? toggle.dataset.replay! : paused ? toggle.dataset.play! : toggle.dataset.pause!)
  }
  const paint = (t: number) => {
    chapters.forEach((c, i) => {
      const from = Number(c.dataset.from),
        to = Number(c.dataset.to)
      const p = Math.min(1, Math.max(0, (t - from) / (to - from)))
      c.style.setProperty('--p', String(p))
      const on = t >= from && (t < to || (i === chapters.length - 1 && t >= to))
      c.classList.toggle('is-current', on)
      if (on) c.setAttribute('aria-current', 'step')
      else c.removeAttribute('aria-current')
      if (on && current !== i) {
        current = i
        if (!document.activeElement?.matches('.chapter')) reveal(list, c.parentElement!)
      }
    })
  }
  const play = () => {
    if (!wanted || !inView || holding || ended || document.hidden) return
    load()
    videos().forEach(v => v.play().catch(() => undefined))
  }
  const pause = () => [...lanes.mac, ...lanes.phone].forEach(v => v.pause())
  const at = (v: HTMLVideoElement, local: number) => {
    const set = () => {
      v.currentTime = local
    }
    if (v.readyState >= 1) set()
    else v.addEventListener('loadedmetadata', set, { once: true })
  }
  const seek = (t: number) => {
    const clamped = Math.min(Math.max(t, 0), duration - 0.05)
    let index = segments.findIndex(s => clamped >= s.from && clamped < s.to)
    if (index < 0) index = segments.length - 1
    enter(index)
    const local = clamped - segments[seg]!.from
    videos().forEach(v => at(v, local))
    passed = clamped >= HOLD
    paint(clamped)
  }
  const hold = () => {
    holding = true
    pause()
    film.classList.add('is-holding')
    bar.classList.add('film-wait')
    allow.hidden = false
    showToggle()
    holdTimer = window.setTimeout(() => release(false), 3500)
  }
  const release = (byVisitor: boolean) => {
    clearTimeout(holdTimer)
    holding = false
    passed = true
    film.classList.remove('is-holding')
    bar.classList.remove('film-wait')
    allow.hidden = true
    if (byVisitor) {
      // The visitor's own tap stands in for the recorded one.
      const ring = document.createElement('span')
      ring.className = 'tap'
      ring.style.left = `calc(${allow.style.getPropertyValue('--l')} + ${allow.style.getPropertyValue('--w')} / 2)`
      ring.style.top = `calc(${allow.style.getPropertyValue('--t')} + ${allow.style.getPropertyValue('--h')} / 2)`
      phoneBox.append(ring)
      setTimeout(() => ring.remove(), 700)
      seek(ALLOWED - 0.05)
      passed = true
    }
    showToggle()
    play()
  }
  const tick = () => {
    frame = 0
    const t = now()
    if (!mac().paused) {
      if (Math.abs(phone().currentTime - mac().currentTime) > 0.12) phone().currentTime = mac().currentTime
      if (!passed && t >= HOLD) hold()
      else if (overrun()) advance()
    }
    paint(t)
    if (!mac().paused) frame = requestAnimationFrame(tick)
  }
  const mine = (v: HTMLVideoElement) => v === mac()
  // The next segment takes over at the end of this one's file, or at its `to` if the file runs longer.
  const advance = () => {
    enter(seg + 1)
    videos().forEach(x => at(x, 0))
    play()
  }
  const overrun = () => seg + 1 < segments.length && now() >= segments[seg]!.to - 0.02
  for (const v of lanes.mac) {
    v.addEventListener('playing', () => {
      if (!mine(v)) return
      film.classList.add('has-video')
      if (phone().paused && !holding)
        phone()
          .play()
          .catch(() => undefined)
      if (!frame) frame = requestAnimationFrame(tick)
      // The next segment loads once this one plays, never before the page is idle.
      loadNext()
    })
    // Frames drive the bars; timeupdate also guards the wait where frames are throttled (a background tab).
    v.addEventListener('timeupdate', () => {
      if (!mine(v)) return
      if (!v.paused && !passed && now() >= HOLD) hold()
      else if (!v.paused && overrun()) advance()
      if (Math.abs(phone().currentTime - v.currentTime) > 0.25) phone().currentTime = v.currentTime
    })
    v.addEventListener('pause', () => {
      if (!mine(v)) return
      if (!phone().paused) phone().pause()
      paint(now())
    })
    // At a segment's end the next one takes over; after the last, the film rests on the result and the toggle offers it again.
    v.addEventListener('ended', () => {
      if (!mine(v)) return
      if (seg + 1 < segments.length) return advance()
      ended = true
      paint(duration)
      showToggle()
    })
  }
  const restart = () => {
    ended = false
    passed = false
    seek(0)
  }

  allow.addEventListener('click', () => {
    if (film.classList.contains('is-still')) {
      film.classList.add('is-end')
      warm(film)
      $$('.film__end', film).forEach(p => p.removeAttribute('aria-hidden'))
      allow.hidden = true
      return
    }
    release(true)
  })
  chapters.forEach((c, i) => {
    c.addEventListener('click', () => {
      const from = Number(c.dataset.from)
      load()
      film.classList.remove('is-still', 'is-end')
      clearTimeout(holdTimer)
      holding = false
      film.classList.remove('is-holding')
      bar.classList.remove('film-wait')
      allow.hidden = true
      ended = false
      // The step that waits opens on the wait itself.
      const waits = c.dataset.hold !== undefined && HOLD < Infinity
      seek(waits ? HOLD - 0.4 : from + 0.02)
      if (waits) passed = false
      wanted = true
      showToggle()
      if (mac().readyState < 2) mac().addEventListener('canplay', () => play(), { once: true })
      play()
    })
    // Arrow keys, Home and End move between steps; Enter or Space plays from the focused one.
    c.addEventListener('keydown', e => {
      const next =
        e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? chapters.length - 1 : -2
      if (next === -2) return
      e.preventDefault()
      const target = chapters[(next + chapters.length) % chapters.length]!
      target.focus({ preventScroll: true })
      reveal(list, target.parentElement!, false)
    })
    c.addEventListener('focus', () => reveal(list, c.parentElement!, false))
  })
  toggle.addEventListener('click', () => {
    if (holding) {
      release(false)
      wanted = true
      showToggle()
      return
    }
    if (ended) {
      restart()
      wanted = true
      film.classList.remove('is-still', 'is-end')
      showToggle()
      play()
      return
    }
    wanted = !wanted
    film.classList.remove('is-still', 'is-end')
    if (wanted) play()
    else pause()
    showToggle()
  })

  new IntersectionObserver(
    entries => {
      inView = entries[0]?.isIntersecting ?? false
      if (inView) play()
      else pause()
    },
    { threshold: 0.25 },
  ).observe(film)

  document.addEventListener('visibilitychange', () => (document.hidden ? pause() : play()))
  if (wanted) {
    // The first frame is already on screen as a picture; the videos load once the page has settled, and a moment
    // more, so starting them never competes with the first paint.
    window.addEventListener('load', () =>
      idle(() =>
        setTimeout(() => {
          load()
          play()
        }, 1200),
      ),
    )
  } else {
    film.classList.add('is-still')
    if (HOLD < Infinity) {
      allow.hidden = false
      paint(HOLD)
    } else paint(0)
  }
  showToggle()
}

/* ---------- Films in slots ---------- */
// Each loads only when its slot comes near, plays muted and looped while on screen, and never starts by itself when
// motion is reduced or data is saved; the control plays and pauses it either way.
const clips = $$('[data-clip]')
if (clips.length) {
  const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true
  const small = window.matchMedia('(max-width: 52rem)').matches
  for (const clip of clips) {
    const video = $<HTMLVideoElement>('video', clip)!
    const button = $<HTMLButtonElement>('[data-clip-toggle]', clip)!
    let wanted = motionOK() && !saveData
    let visible = false
    const show = () => {
      const paused = video.paused
      button.classList.toggle('is-paused', paused)
      button.setAttribute('aria-label', paused ? button.dataset.play! : button.dataset.pause!)
    }
    const load = () => {
      if (video.src) return
      video.src = (small && video.dataset.srcSmall) || video.dataset.src!
      video.preload = 'auto'
    }
    const run = () => {
      if (wanted && visible && !document.hidden) {
        load()
        video.play().catch(() => undefined)
      } else video.pause()
    }
    video.addEventListener('playing', () => clip.classList.add('is-playing'))
    video.addEventListener('play', show)
    video.addEventListener('pause', show)
    button.hidden = false
    show()
    button.addEventListener('click', () => {
      wanted = video.paused
      if (wanted) visible = true
      run()
    })
    new IntersectionObserver(entries => wanted && entries[0]?.isIntersecting && load(), { rootMargin: '300px 0px' }).observe(clip)
    new IntersectionObserver(
      entries => {
        visible = entries[0]?.isIntersecting ?? false
        run()
      },
      { threshold: 0.4 },
    ).observe(clip)
    document.addEventListener('visibilitychange', run)
  }
}

/* ---------- Plugin filter ---------- */
// Without scripting the pills are in-page links and :target filters the list. With it they become buttons that show
// only the plugins providing that kind, keep focus where it is and announce how many remain.
const filter = $('[data-filter]')
if (filter) {
  const status = $('[data-filter-status]', filter)!
  const plugins = $$('.plugin[data-facets]')
  const buttons = $$<HTMLAnchorElement>('a[data-facet]', filter).map(a => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = a.className
    b.dataset.facet = a.dataset.facet
    b.textContent = a.textContent
    a.replaceWith(b)
    return b
  })
  const choose = (facet: string, announce: boolean) => {
    let shown = 0
    for (const p of plugins) {
      const on = facet === 'all' || (p.dataset.facets || '').split(' ').includes(facet)
      p.hidden = !on
      if (on) shown += 1
    }
    buttons.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.facet === facet)))
    if (announce) status.textContent = shown === 1 ? filter.dataset.one! : filter.dataset.many!.replace('{n}', String(shown))
  }
  buttons.forEach(b => b.addEventListener('click', () => choose(b.dataset.facet!, true)))
  const pills = $('.pills', filter)!
  edges(pills)
  // A link to a plugin that the filter hides shows every plugin again.
  const follow = () => {
    const target = location.hash.length > 1 ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null
    if (target?.matches('.plugin[hidden]')) {
      choose('all', false)
      target.scrollIntoView()
    }
    const facet = /^#provides-(\w+)$/u.exec(location.hash)?.[1]
    if (facet) choose(facet, false)
  }
  choose('all', false)
  follow()
  window.addEventListener('hashchange', follow)
}

/* ---------- Feature tabs ---------- */
const tabs = $('[data-tabs]')
if (tabs) {
  const list = $('[role="tablist"]', tabs)!
  const items = $$<HTMLButtonElement>('[role="tab"]', tabs)
  const panels = items.map(b => document.getElementById(b.getAttribute('aria-controls')!)!)

  const select = (i: number, focus = false) => {
    items.forEach((b, j) => {
      const on = j === i
      b.setAttribute('aria-selected', String(on))
      b.tabIndex = on ? 0 : -1
      panels[j]!.toggleAttribute('data-inactive', !on)
    })
    warm(panels[i]!)
    if (motionOK()) restart(panels[i]!, 'is-entering')
    // Keep the chosen tab in view in the scrolling strip without moving the page.
    const b = items[i]!
    const left = b.offsetLeft - (list.clientWidth - b.offsetWidth) / 2
    list.scrollTo({ left, behavior: motionOK() ? 'smooth' : 'auto' })
    if (focus) b.focus({ preventScroll: true })
  }
  items.forEach((b, i) => b.addEventListener('click', () => select(i)))
  edges(list)
  list.addEventListener('keydown', e => {
    const i = items.findIndex(b => b.getAttribute('aria-selected') === 'true')
    const key = e.key
    const next =
      key === 'ArrowRight'
        ? (i + 1) % items.length
        : key === 'ArrowLeft'
          ? (i - 1 + items.length) % items.length
          : key === 'Home'
            ? 0
            : key === 'End'
              ? items.length - 1
              : -1
    if (next < 0) return
    e.preventDefault()
    select(next, true)
  })
  // A tab's picture must be there when the tab opens, also on a slow connection. Once the person scrolls, the
  // pictures of the other tabs are fetched one after another at low priority, so they neither compete with each other
  // nor with the hero film; the tab the pointer reaches or the person picks jumps the queue at high priority.
  const picture = (panel: Element) => $<HTMLImageElement>('img', panel)
  const fetchNow = (panel: Element, priority: 'high' | 'low') => {
    const img = picture(panel)
    if (img && !img.complete) img.fetchPriority = priority
    warm(panel)
  }
  items.forEach((b, i) => {
    b.addEventListener('pointerenter', () => fetchNow(panels[i]!, 'high'), { once: true })
    b.addEventListener('click', () => fetchNow(panels[i]!, 'high'), { capture: true })
  })
  const queue = panels.slice(1)
  const next = () => {
    const panel = queue.shift()
    if (!panel) return
    fetchNow(panel, 'low')
    const img = picture(panel)
    if (!img || img.complete) next()
    else {
      img.addEventListener('load', next, { once: true })
      img.addEventListener('error', next, { once: true })
    }
  }
  const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true
  // The queue starts with the first scroll: the first screen stays as light as it was, and the tabs are still a
  // screen or more away.
  if (!saveData) window.addEventListener('scroll', () => idle(next), { once: true, passive: true })
}

/* ---------- Download page ---------- */
const platform = (() => {
  const ua = navigator.userAgent
  const p = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || ''
  if (/iPhone|iPad|iPod/.test(ua) || (/Mac/.test(p) && navigator.maxTouchPoints > 1)) return 'ios'
  if (/Android/i.test(ua)) return 'android'
  if (/Win/i.test(p) || /Windows/.test(ua)) return 'win'
  if (/Mac/i.test(p)) return 'mac'
  if (/Linux|X11/i.test(p) || /Linux/.test(ua)) return 'linux'
  return ''
})()
$$('[data-platform]').forEach(el => {
  const mine = el.dataset.platform === platform
  el.classList.toggle('is-this', mine)
  const tag = $('[data-this]', el)
  if (tag) tag.hidden = !mine
})
const platformNote = $('[data-platform-note]')
if (platformNote && C.note?.[platform]) {
  platformNote.textContent = C.note[platform]!
  platformNote.hidden = false
}

$$<HTMLAnchorElement>('[data-download]').forEach(btn => {
  let timer = 0
  btn.addEventListener('click', e => {
    e.preventDefault()
    const live = document.getElementById(`${btn.dataset.download}-pending`)
    if (!live) return
    live.textContent = C.pending
    restart(live, 'is-on')
    clearTimeout(timer)
    timer = window.setTimeout(() => live.classList.remove('is-on'), 2600)
  })
})

// "Build from source" opens when a link points at it.
const source = $<HTMLDetailsElement>('[data-source]')
const openSource = () => {
  if (source && location.hash === '#source') source.open = true
}
openSource()
window.addEventListener('hashchange', openSource)
