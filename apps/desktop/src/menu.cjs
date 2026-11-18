'use strict'
// The macOS menu bar: the app menu with 「检查更新…」, then Edit, View (with Code, 我的 Agent and 用默认外观打开) and Window.

const { isAppUrl } = require('./proxy.cjs')
const { defineCopy } = require('./locale.cjs')

const COPY = defineCopy(
  {
    about: '关于 Latch',
    updates: '检查更新…',
    services: '服务',
    hide: '隐藏 Latch',
    hideOthers: '隐藏其他',
    unhide: '全部显示',
    quit: '退出 Latch',
    edit: '编辑',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '拷贝',
    paste: '粘贴',
    selectAll: '全选',
    view: '显示',
    agents: '我的 Agent',
    defaultAppearance: '用默认外观打开',
    reload: '重新载入',
    developerTools: '开发者工具',
    actualSize: '实际大小',
    zoomIn: '放大',
    zoomOut: '缩小',
    fullScreen: '进入全屏幕',
    window: '窗口',
    minimize: '最小化',
    zoom: '缩放',
    closeWindow: '关闭窗口',
    front: '前置全部窗口',
  },
  {
    about: 'About Latch',
    updates: 'Check for Updates…',
    services: 'Services',
    hide: 'Hide Latch',
    hideOthers: 'Hide Others',
    unhide: 'Show All',
    quit: 'Quit Latch',
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select All',
    view: 'View',
    agents: 'My Agents',
    defaultAppearance: 'Open with Default Appearance',
    reload: 'Reload',
    developerTools: 'Developer Tools',
    actualSize: 'Actual Size',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    fullScreen: 'Toggle Full Screen',
    window: 'Window',
    minimize: 'Minimize',
    zoom: 'Zoom',
    closeWindow: 'Close Window',
    front: 'Bring All to Front',
  },
)

/**
 * The menu bar template for `Menu.buildFromTemplate`. The developer tools item exists only in a development run, as
 * the window's own `devTools` does. Code and 我的 Agent go to that place in the focused window, with the keys the page
 * itself answers to (⇧⌘1, ⇧⌘2). They start disabled: main enables them while the focused window's page has said it has
 * the two places (`SPACE_ITEMS`). 「用默认外观打开」 is always on: it is the way back when a customised page cannot be
 * used, so it asks nothing of the page.
 * The two items' keys are the focused window's own bindings (`spaceAccelerator`); the template is built again when they
 * change.
 * @param {{ packaged: boolean, onAbout?: () => void, onCheckForUpdates: () => void, onSpace?: (space: 'code' | 'agents') => void, onSafeMode?: () => void, accelerators?: SpaceAccelerators }} input
 * @returns {import('electron').MenuItemConstructorOptions[]}
 */
function menuTemplate({
  packaged,
  onAbout = () => {},
  onCheckForUpdates,
  onSpace = () => {},
  onSafeMode = () => {},
  accelerators = DEFAULT_SPACE_ACCELERATORS,
}) {
  return [
    {
      label: 'Latch',
      submenu: [
        // The app's own 设置 › 关于, not the system panel, which names the runtime when Latch runs from source.
        { label: COPY.about, id: 'about', click: () => onAbout() },
        { label: COPY.updates, id: 'check-for-updates', click: () => onCheckForUpdates() },
        { type: 'separator' },
        { role: 'services', label: COPY.services },
        { type: 'separator' },
        { role: 'hide', label: COPY.hide },
        { role: 'hideOthers', label: COPY.hideOthers },
        { role: 'unhide', label: COPY.unhide },
        { type: 'separator' },
        { role: 'quit', label: COPY.quit },
      ],
    },
    {
      label: COPY.edit,
      submenu: [
        { role: 'undo', label: COPY.undo },
        { role: 'redo', label: COPY.redo },
        { type: 'separator' },
        { role: 'cut', label: COPY.cut },
        { role: 'copy', label: COPY.copy },
        { role: 'paste', label: COPY.paste },
        { role: 'selectAll', label: COPY.selectAll },
      ],
    },
    {
      label: COPY.view,
      submenu: [
        {
          label: 'Code',
          id: 'space-code',
          ...(accelerators.code ? { accelerator: accelerators.code } : {}),
          enabled: false,
          click: () => onSpace('code'),
        },
        {
          label: COPY.agents,
          id: 'space-agents',
          ...(accelerators.agents ? { accelerator: accelerators.agents } : {}),
          enabled: false,
          click: () => onSpace('agents'),
        },
        { type: 'separator' },
        { label: COPY.defaultAppearance, id: 'safe-mode', click: () => onSafeMode() },
        { role: 'reload', label: COPY.reload },
        ...(packaged ? [] : [/** @type {const} */ ({ role: 'toggleDevTools', label: COPY.developerTools })]),
        { type: 'separator' },
        { role: 'resetZoom', label: COPY.actualSize },
        { role: 'zoomIn', label: COPY.zoomIn },
        { role: 'zoomOut', label: COPY.zoomOut },
        { type: 'separator' },
        { role: 'togglefullscreen', label: COPY.fullScreen },
      ],
    },
    {
      label: COPY.window,
      role: 'windowMenu',
      submenu: [
        { role: 'minimize', label: COPY.minimize },
        { role: 'zoom', label: COPY.zoom },
        { role: 'close', label: COPY.closeWindow },
        { type: 'separator' },
        { role: 'front', label: COPY.front },
      ],
    },
  ]
}

/** @typedef {{ code: string | null, agents: string | null }} SpaceAccelerators */

/** @type {SpaceAccelerators} */
const DEFAULT_SPACE_ACCELERATORS = Object.freeze({ code: 'Shift+CmdOrCtrl+1', agents: 'Shift+CmdOrCtrl+2' })

/**
 * Keys no page may give the two items, the same lists `packages/protocol/src/shortcuts.ts` refuses (checked by
 * `apps/desktop/test/menu-shortcuts.test.ts`): the system's, the menu's roles' and the page's fixed keys.
 */
const RESERVED_CHORDS = new Set([
  // The system's.
  'Mod+Space',
  'Mod+Alt+Space',
  'Mod+Tab',
  'Mod+Shift+Tab',
  'Mod+Backquote',
  'Mod+KeyQ',
  'Mod+KeyH',
  'Mod+Alt+KeyH',
  'Mod+KeyM',
  'Mod+Alt+KeyD',
  'Mod+Alt+Escape',
  'Mod+Shift+Digit3',
  'Mod+Shift+Digit4',
  'Mod+Shift+Digit5',
  // The menu's roles.
  'Mod+KeyZ',
  'Mod+Shift+KeyZ',
  'Mod+KeyX',
  'Mod+KeyC',
  'Mod+KeyV',
  'Mod+KeyA',
  'Mod+KeyR',
  'Mod+Alt+KeyI',
  'Mod+Digit0',
  'Mod+Equal',
  'Mod+Shift+Equal',
  'Mod+Minus',
  'Mod+KeyW',
  // The page's fixed keys.
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(digit => `Mod+Digit${digit}`),
  ...[1, 2, 3, 4].map(digit => `Mod+Alt+Digit${digit}`),
  'Mod+Backslash',
  'Mod+Shift+Backslash',
  'Mod+Alt+BracketRight',
  'Mod+Alt+BracketLeft',
  'Mod+Enter',
  'Mod+Alt+Shift+Digit0',
])

/**
 * Every key code a chord may end in (`KEY_CODES` of `packages/protocol/src/shortcuts.ts`, checked equal by
 * `apps/desktop/test/menu-shortcuts.test.ts`) and its Electron accelerator key. A Map, so no name reaches a prototype:
 * `constructor`, `toString` or `__proto__` is simply not a key.
 * @type {ReadonlyMap<string, string>}
 */
const ACCELERATOR_KEYS = new Map([
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(letter => /** @type {[string, string]} */ ([`Key${letter}`, letter])),
  ...'0123456789'.split('').map(digit => /** @type {[string, string]} */ ([`Digit${digit}`, digit])),
  ['Comma', ','],
  ['Period', '.'],
  ['Slash', '/'],
  ['Backslash', '\\'],
  ['BracketLeft', '['],
  ['BracketRight', ']'],
  ['Semicolon', ';'],
  ['Quote', "'"],
  ['Minus', '-'],
  ['Equal', '='],
  ['Backquote', '`'],
  ['Enter', 'Enter'],
  ['Space', 'Space'],
  ['Tab', 'Tab'],
  ['Escape', 'Escape'],
  ['Backspace', 'Backspace'],
  ['ArrowUp', 'Up'],
  ['ArrowDown', 'Down'],
  ['ArrowLeft', 'Left'],
  ['ArrowRight', 'Right'],
  ...Array.from({ length: 12 }, (_, index) => /** @type {[string, string]} */ ([`F${index + 1}`, `F${index + 1}`])),
])

/**
 * A page's chord for Code or 我的 Agent as an Electron accelerator, or null when it is not one main gives the menu:
 * outside the grammar (`Mod`, `Alt`, `Shift` in that order, then one key code of the list above, with `Mod` or `Alt`)
 * or reserved. Main checks every chord itself, whatever the preload already did.
 * @param {unknown} chord
 * @returns {string | null}
 */
function spaceAccelerator(chord) {
  if (typeof chord !== 'string' || chord.length > 32) return null
  const match = /^(Mod\+)?(Alt\+)?(Shift\+)?([A-Za-z0-9]+)$/u.exec(chord)
  if (!match || (!match[1] && !match[2]) || RESERVED_CHORDS.has(chord)) return null
  const key = ACCELERATOR_KEYS.get(match[4])
  if (key === undefined) return null
  return [match[3] && 'Shift', match[2] && 'Alt', match[1] && 'CmdOrCtrl', key].filter(Boolean).join('+')
}

/** The menu items main enables only for a page that has Code and 我的 Agent. */
const SPACE_ITEMS = ['space-code', 'space-agents']

/**
 * Which pages have said they have the two places, and the items' state for the focused one. A page's word holds until
 * its window loads another document: `did-navigate` fires for a top-level, cross-document navigation only, so a frame
 * (an 应用 page, a preview) or a same-document history entry (a phone layer's pushState) leaves it standing; the page
 * says it again once the new document subscribes.
 * @param {{ focused: () => import('electron').WebContents | null | undefined, item: (id: string) => { enabled: boolean } | null | undefined, rebuild?: (accelerators: SpaceAccelerators) => void }} input
 */
function spaceMenu({ focused, item, rebuild = () => {} }) {
  const pages = new WeakSet()
  const watched = new WeakSet()
  /** @type {WeakMap<object, SpaceAccelerators>} */
  const keysOf = new WeakMap()
  let shown = DEFAULT_SPACE_ACCELERATORS
  const sync = (rebuildLabels = false) => {
    const contents = focused()
    const wanted = (contents && keysOf.get(contents)) ?? DEFAULT_SPACE_ACCELERATORS
    if (rebuildLabels || wanted.code !== shown.code || wanted.agents !== shown.agents) {
      shown = wanted
      rebuild(wanted)
    }
    const enabled = Boolean(contents && pages.has(contents))
    for (const id of SPACE_ITEMS) {
      const entry = item(id)
      if (entry) entry.enabled = enabled
    }
  }
  /** @param {import('electron').WebContents} contents @param {boolean} ready */
  const ready = (contents, ready) => {
    if (!watched.has(contents)) {
      watched.add(contents)
      contents.on('did-navigate', () => {
        pages.delete(contents)
        keysOf.delete(contents)
        sync()
      })
    }
    if (ready) pages.add(contents)
    else pages.delete(contents)
    sync()
  }
  /**
   * A page's keys for the two items. Each is checked here again (`spaceAccelerator`); one that is not given or does not
   * pass leaves that item without keys rather than with keys the page did not ask for.
   * @param {import('electron').WebContents} contents @param {unknown} value
   */
  const keys = (contents, value) => {
    const record = value && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {}
    keysOf.set(contents, { code: spaceAccelerator(record.code), agents: spaceAccelerator(record.agents) })
    sync()
  }
  return { ready, sync, keys }
}

/**
 * Where 「用默认外观打开」 sends a window: the page it shows, with `#safe` as its fragment. The page reads the fragment
 * before it renders, shows the default look and takes the fragment out of the address; a fragment is never sent to a
 * Host. The address stays the window's own: only a Latch page of this app (`latch://app/link/…`, or another computer's
 * `latch://h-<hostId>/link/…`) gets one, and anything else is left alone.
 * @param {string} current
 * @param {string} [home] the owning window's Host source
 * @returns {string | null}
 */
function safeModeUrl(current, home) {
  let url
  try {
    url = new URL(current)
  } catch {
    return null
  }
  if (!/^(?:app|h-[a-z2-7]{52})$/u.test(url.hostname) || !isAppUrl(current, home ?? url.hostname) || !url.pathname.startsWith('/link/'))
    return null
  url.hash = 'safe'
  return url.href
}

/**
 * 用默认外观打开, for one window: its page gets `#safe` and is loaded again, so it reads the fragment before it renders.
 * Nothing is asked of the page's own script, which may be what failed. A change of fragment alone is a move inside the
 * same document. Reload only if the main frame reaches that exact address on the same computer.
 * @param {Pick<import('electron').WebContents, 'getURL' | 'on' | 'removeListener' | 'loadURL' | 'reloadIgnoringCache' | 'isDestroyed'> | null | undefined} contents
 * @param {{ home?: string, wait?: (run: () => void, ms: number) => unknown }} [options]
 * @returns {boolean} whether the window was sent anywhere
 */
function openSafeMode(contents, { home, wait = setTimeout } = {}) {
  const target = contents && !contents.isDestroyed() ? safeModeUrl(contents.getURL(), home) : null
  if (!contents || !target) return false
  let done = false
  const reached = () => !contents.isDestroyed() && contents.getURL() === target
  /** @param {boolean} shouldReload */
  const finish = shouldReload => {
    if (done) return
    done = true
    contents.removeListener('did-navigate-in-page', landed)
    if (shouldReload && reached()) contents.reloadIgnoringCache()
  }
  /** @type {(event: import('electron').Event, url: string, isMainFrame: boolean) => void} */
  const landed = (_event, url, isMainFrame) => {
    if (isMainFrame && url === target && reached()) finish(true)
  }
  contents.on('did-navigate-in-page', landed)
  void contents.loadURL(target).then(
    () => {
      if (reached()) finish(true)
    },
    () => finish(false),
  )
  wait(() => finish(true), 1_000)
  return true
}

module.exports = {
  menuTemplate,
  SPACE_ITEMS,
  spaceMenu,
  spaceAccelerator,
  ACCELERATOR_KEYS,
  RESERVED_CHORDS,
  DEFAULT_SPACE_ACCELERATORS,
  safeModeUrl,
  openSafeMode,
}
