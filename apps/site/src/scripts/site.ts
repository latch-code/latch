// The page's behaviour: the nav's glass, the hero session, the feature tabs and their video, and the download
// page. Everything readable is in the HTML already; this only changes state. Strings that change with state come
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

/* ---------- Hero: the film ---------- */
// Two recordings of the same seconds, the Mac's and the phone's: the Mac's clock leads and the phone follows. The film
// stops where the approval waits on the phone and goes on when the visitor taps Allow, or by itself a few seconds later.
// Reduced motion: nothing plays by itself; the needs-you pictures show and Allow turns them into the handed-back ones.
const film = $('[data-film]')
if (film) {
  const mac = $<HTMLVideoElement>('[data-film-video="mac"]', film)!
  const phone = $<HTMLVideoElement>('[data-film-video="phone"]', film)!
  const videos = [mac, phone]
  const marks = JSON.parse(film.dataset.marks || '{}') as Record<string, number>
  const duration = Number(film.dataset.duration) || mac.duration
  const allow = $<HTMLButtonElement>('[data-allow]', film)!
  const bar = $('[data-chapters]')!
  const chapters = $$<HTMLButtonElement>('[data-chapter]', bar)
  const toggle = $<HTMLButtonElement>('[data-film-toggle]', bar)!
  const phoneBox = $('.film__phone', film)!
  const HOLD = (marks.hold_start ?? marks.needs ?? 0) + 0.6
  const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true
  let wanted = motionOK() && !saveData
  let ended = false
  let inView = false
  let loaded = false
  let passed = false
  let holding = false
  let holdTimer = 0
  let frame = 0
  bar.hidden = false
  // Allow's box on the phone (set on the button) also places the hint.
  for (const k of ['--l', '--t', '--w', '--h']) phoneBox.style.setProperty(k, allow.style.getPropertyValue(k))

  const load = () => {
    if (loaded) return
    loaded = true
    videos.forEach(v => {
      v.preload = 'auto'
      v.load()
    })
  }
  const showToggle = () => {
    const paused = !wanted || holding || ended
    toggle.classList.toggle('is-paused', paused)
    toggle.setAttribute('aria-label', ended ? toggle.dataset.replay! : paused ? toggle.dataset.play! : toggle.dataset.pause!)
  }
  const paint = (t: number) => {
    chapters.forEach(c => {
      const from = Number(c.dataset.from),
        to = Number(c.dataset.to)
      const p = Math.min(1, Math.max(0, (t - from) / (to - from)))
      c.style.setProperty('--p', String(p))
      const current = t >= from && t < to
      c.classList.toggle('is-current', current)
      if (current) c.setAttribute('aria-current', 'step')
      else c.removeAttribute('aria-current')
    })
  }
  const play = () => {
    if (!wanted || !inView || holding || ended || document.hidden) return
    load()
    videos.forEach(v => v.play().catch(() => undefined))
  }
  const pause = () => videos.forEach(v => v.pause())
  const seek = (t: number) => {
    videos.forEach(v => {
      v.currentTime = Math.min(Math.max(t, 0), duration - 0.05)
    })
    passed = t >= HOLD
    paint(t)
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
      seek((marks.allowed ?? HOLD) - 0.05)
    }
    showToggle()
    play()
  }
  const tick = () => {
    frame = 0
    const t = mac.currentTime
    if (!mac.paused) {
      if (Math.abs(phone.currentTime - t) > 0.12) phone.currentTime = t
      if (!passed && t >= HOLD) hold()
    }
    paint(t)
    if (!mac.paused) frame = requestAnimationFrame(tick)
  }
  mac.addEventListener('playing', () => {
    film.classList.add('has-video')
    if (phone.paused && !holding) phone.play().catch(() => undefined)
    if (!frame) frame = requestAnimationFrame(tick)
  })
  // Frames drive the bars; timeupdate also guards the wait where frames are throttled (a background tab).
  mac.addEventListener('timeupdate', () => {
    if (!mac.paused && !passed && mac.currentTime >= HOLD) hold()
    if (Math.abs(phone.currentTime - mac.currentTime) > 0.25) phone.currentTime = mac.currentTime
  })
  mac.addEventListener('pause', () => {
    if (!phone.paused) phone.pause()
    paint(mac.currentTime)
  })
  // One pass, then it rests on the result; the toggle offers it again.
  mac.addEventListener('ended', () => {
    ended = true
    paint(duration)
    showToggle()
  })
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
  chapters.forEach(c =>
    c.addEventListener('click', () => {
      const from = Number(c.dataset.from)
      load()
      film.classList.remove('is-still', 'is-end')
      clearTimeout(holdTimer)
      holding = false
      film.classList.remove('is-holding')
      bar.classList.remove('film-wait')
      allow.hidden = true
      // The needs-you step opens on the wait itself.
      ended = false
      seek(c.dataset.chapter === 'needs' ? HOLD - 0.4 : from + 0.02)
      if (c.dataset.chapter === 'needs') passed = false
      wanted = true
      showToggle()
      if (mac.readyState < 2) mac.addEventListener('canplay', () => play(), { once: true })
      play()
    }),
  )
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
    // The first frame is already on screen as a picture; the videos load once the page has settled.
    // After the page has settled, and a moment more, so starting the videos never competes with the first paint.
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
    allow.hidden = false
    paint(HOLD)
  }
  showToggle()
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
  // On narrow screens the strip scrolls; fade the edge that has more tabs behind it.
  const edges = () => {
    list.classList.toggle('can-left', list.scrollLeft > 2)
    list.classList.toggle('can-right', list.scrollLeft + list.clientWidth < list.scrollWidth - 2)
  }
  list.addEventListener('scroll', edges, { passive: true })
  window.addEventListener('resize', edges, { passive: true })
  edges()
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
  // Warm a tab's picture as the pointer reaches it, and all of them once the section is close.
  items.forEach((b, i) => b.addEventListener('pointerenter', () => warm(panels[i]!), { once: true }))
  new IntersectionObserver(
    entries => {
      if (entries[0]?.isIntersecting) idle(() => panels.forEach(p => warm(p)))
    },
    { rootMargin: '200px 0px', threshold: 0 },
  ).observe(tabs)
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
