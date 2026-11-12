'use strict'
// The Agent's side of the preview browser: main registers with its own Host as the browser provider and carries out the
// built-in harness's browser calls on the tabs of the calling session. The actions are a fixed list, apart from the
// page's `latchShell.browser`: no developer tools, no clearing data, no focus, no overlay, no script of the Agent's own.
// Reads run fixed scripts in the isolated world 标注 uses, through that world's prototypes; clicks and keys go in with
// `sendInputEvent` and text with `insertText`. Only tabs on this Mac's own addresses (or blank) are acted on, a call
// whose tab went elsewhere since the Host classified it is refused, and the values of password, one-time-code, card and
// hidden fields are never read. See docs/PREVIEW-BROWSER.md.
const { ANNOTATION_WORLD, CAPTURE_LIMITS, TAB_LIMIT, addressUrl, agentLocalHost, cleanText, lastOf } = require('./browser.cjs')

/** The calls main carries out, and nothing else. */
const AGENT_TOOLS = Object.freeze([
  'browser_tabs',
  'browser_open',
  'browser_navigate',
  'browser_read',
  'browser_find',
  'browser_screenshot',
  'browser_scroll',
  'browser_viewport',
  'browser_console',
  'browser_network',
  'browser_wait',
  'browser_click',
  'browser_key',
  'browser_select',
  'browser_type',
  'browser_close',
])
/** Calls that act on the page rather than look at it. */
const ACTIONS = new Set([
  'browser_open',
  'browser_navigate',
  'browser_click',
  'browser_key',
  'browser_select',
  'browser_type',
  'browser_scroll',
])
/** Calls that need the page laid out and painted, so the tab in sight: the rest work from main's own records. */
const IN_SIGHT = new Set([
  'browser_open',
  'browser_navigate',
  'browser_read',
  'browser_find',
  'browser_screenshot',
  'browser_scroll',
  'browser_wait',
  'browser_click',
  'browser_key',
  'browser_select',
  'browser_type',
])
/** How long a call waits for the page to show a tab it asked to see. */
const REVEAL_TRIES = 40
const REVEAL_STEP_MS = 50
/** Calls that may name a tab anywhere: every other call needs it on this Mac. */
const ANYWHERE = new Set(['browser_tabs', 'browser_close'])
const TAB_ID = /^brw_[A-Za-z0-9_-]{22}$/
const REF = /^e[0-9]{1,6}$/
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/
const CALL_ID = /^[0-9a-f-]{36}$/
/** Keys `browser_key` presses, as Electron names them. */
const NAMED_KEYS = Object.freeze({
  Enter: 'Enter',
  Tab: 'Tab',
  Escape: 'Escape',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Space: 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
})
const READ_CHARS = 12_000
const FIND_LIMIT = 20
const LIST_LIMIT = 100
const VALUE_LIMIT = 200
const NAME_LIMIT = 100
const WAIT_STEP_MS = 250
const QUIET_MS = 500
const RESULT_TEXT_LIMIT = 256 * 1024

const isPlainObject = value =>
  value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const str = (value, max) => typeof value === 'string' && value.length <= max
const opt = (value, check) => value === undefined || check(value)
const bool = value => typeof value === 'boolean'
const int = (min, max) => value => Number.isInteger(value) && value >= min && value <= max
const oneOf = list => value => list.includes(value)

/** Exactly these keys at most, each of its shape. */
function shaped(args, spec) {
  if (!isPlainObject(args)) return false
  for (const key of Object.keys(args)) if (!(key in spec)) return false
  return Object.entries(spec).every(([key, check]) => check(args[key]))
}
const tab = value => typeof value === 'string' && TAB_ID.test(value)
const ref = value => typeof value === 'string' && REF.test(value)
const required = check => value => value !== undefined && check(value)
const optional = check => value => opt(value, check)

/** Each call's arguments, checked again here whatever the Host sent: exactly its keys, of its shapes. */
const AGENT_INPUTS = Object.freeze({
  browser_tabs: args => shaped(args, {}),
  browser_open: args => shaped(args, { url: optional(value => str(value, 2048)) }),
  browser_navigate: args =>
    shaped(args, {
      tabId: required(tab),
      url: optional(value => str(value, 2048)),
      action: optional(oneOf(['back', 'forward', 'reload'])),
    }) && (args.url === undefined) !== (args.action === undefined),
  browser_read: args => shaped(args, { tabId: required(tab), interactive: optional(bool), maxChars: optional(int(1000, 40_000)) }),
  browser_find: args =>
    shaped(args, {
      tabId: required(tab),
      text: optional(value => str(value, 200)),
      selector: optional(simpleSelector),
      role: optional(value => typeof value === 'string' && /^[a-z]{1,32}$/u.test(value)),
      name: optional(value => str(value, 200)),
    })
    && [args.text, args.selector, args.role].filter(value => value !== undefined).length === 1
    && (args.name === undefined || args.role !== undefined),
  browser_screenshot: args => shaped(args, { tabId: required(tab), ref: optional(ref) }),
  browser_scroll: args =>
    shaped(args, {
      tabId: required(tab),
      ref: optional(ref),
      direction: optional(oneOf(['up', 'down', 'left', 'right'])),
      amount: optional(int(1, 10_000)),
    })
    && (args.ref !== undefined || args.direction !== undefined),
  browser_viewport: args =>
    shaped(args, {
      tabId: required(tab),
      preset: optional(oneOf(['fit', 'phone', 'tablet', 'desktop'])),
      rotated: optional(bool),
      colorScheme: optional(oneOf(['system', 'light', 'dark'])),
    }),
  browser_console: args =>
    shaped(args, {
      tabId: required(tab),
      errorsOnly: optional(bool),
      filter: optional(value => str(value, 200)),
      limit: optional(int(1, LIST_LIMIT)),
    }),
  browser_network: args =>
    shaped(args, {
      tabId: required(tab),
      failedOnly: optional(bool),
      filter: optional(value => str(value, 200)),
      limit: optional(int(1, LIST_LIMIT)),
    }),
  browser_wait: args =>
    shaped(args, {
      tabId: required(tab),
      text: optional(value => str(value, 200)),
      urlIncludes: optional(value => str(value, 512)),
      networkIdle: optional(bool),
      timeoutMs: optional(int(100, 30_000)),
    }) && [args.text, args.urlIncludes, args.networkIdle].some(value => value !== undefined),
  browser_click: args => shaped(args, { tabId: required(tab), ref: required(ref), double: optional(bool), hover: optional(bool) }),
  browser_key: args =>
    shaped(args, { tabId: required(tab), key: required(value => str(value, 16)) })
    && (Object.hasOwn(NAMED_KEYS, args.key) || [...args.key].length === 1),
  browser_select: args => shaped(args, { tabId: required(tab), ref: required(ref), value: required(value => str(value, 500)) }),
  browser_type: args =>
    shaped(args, {
      tabId: required(tab),
      ref: required(ref),
      text: required(value => str(value, 10_000)),
      clear: optional(bool),
      submit: optional(bool),
    }),
  browser_close: args => shaped(args, { tabId: required(tab) }),
})

/** A call as the Host's stream sends it, checked; anything else is undefined. */
function callInput(raw) {
  if (!isPlainObject(raw)) return undefined
  const { callId, sessionId, projectId, tool, args, origin, risk, deadline } = raw
  if (typeof callId !== 'string' || !CALL_ID.test(callId)) return undefined
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return undefined
  if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) return undefined
  if (!AGENT_TOOLS.includes(tool) || !AGENT_INPUTS[tool](args)) return { callId, invalid: true }
  if (origin !== null && !str(origin, 2048)) return { callId, invalid: true }
  if (!['R0', 'R1', 'R2'].includes(risk)) return { callId, invalid: true }
  const ms = Number.isInteger(deadline) && deadline > 0 && deadline <= 60_000 ? deadline : 15_000
  return { callId, sessionId, projectId, tool, args, origin, risk, deadline: ms }
}

/** An address's origin, when it is http(s). */
function originOf(raw) {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null
  } catch {
    return null
  }
}

/** Whether a tab may be acted on: on this Mac (`agentLocalHost`, as the Host's broker says), or blank. */
function localOrBlank(raw) {
  try {
    const url = new URL(raw)
    if (url.protocol === 'about:') return url.href === 'about:blank'
    return (url.protocol === 'http:' || url.protocol === 'https:') && agentLocalHost(url.hostname)
  } catch {
    return raw === ''
  }
}

/** Origin and path, never the query: what the Host's table and the Agent's list say of where a tab is. */
function shortUrl(raw) {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return url.protocol === 'about:' ? 'about:blank' : ''
    return `${url.origin}${url.pathname}`.slice(0, 2048)
  } catch {
    return ''
  }
}

/**
 * The Agent's side of a tab's isolated world, the one 标注 uses: main sends its source (`agentWorld.toString()`) with a
 * task, so it may use nothing outside its own body. DOM members are called through this world's prototypes: a named
 * form control can shadow a member of its form, and of `document`, in this world too. The reference table and the set
 * of fields seen as sensitive live in this world alone, which the page's scripts never see.
 *
 * Fields whose value is never read: password and hidden inputs, and fields whose `autocomplete` names a password, a
 * one-time code or a card. Once seen as one, an element stays one (a 「显示密码」 toggle that makes it `type=text` does
 * not expose it).
 * @param {any} scope  the world's global object
 * @param {number} epoch  bumped when the person hands a tab back: references handed out before it are void
 * @param {{ name: number, value: number, find: number }} limits
 * @param {any} task
 */
function agentWorld(scope, epoch, limits, task) {
  const {
    Element,
    Node,
    Document,
    HTMLElement,
    HTMLInputElement,
    HTMLTextAreaElement,
    HTMLSelectElement,
    HTMLOptionElement,
    HTMLIFrameElement,
    CharacterData,
    EventTarget,
    Event,
    document,
    location,
  } = scope
  const method = (type, name) => {
    const run = type.prototype[name]
    return (target, ...args) => run.apply(target, args)
  }
  /** The accessor `name` of an interface, found on its prototype chain (a member an engine lacks reads as nothing). */
  const accessor = (type, name) => {
    for (let proto = type.prototype; proto; proto = Object.getPrototypeOf(proto)) {
      const found = Object.getOwnPropertyDescriptor(proto, name)
      if (found) return found
    }
    return {}
  }
  /** @type {(type: any, name: string) => (target: any) => any} */
  const getter = (type, name) => {
    const read = accessor(type, name).get
    return target => (read ? read.call(target) : undefined)
  }
  /** @type {(type: any, name: string) => (target: any, value: any) => void} */
  const setter = (type, name) => {
    const write = accessor(type, name).set
    return (target, value) => write?.call(target, value)
  }
  const localName = getter(Element, 'localName')
  const getAttribute = method(Element, 'getAttribute')
  const hasAttribute = method(Element, 'hasAttribute')
  const getBox = method(Element, 'getBoundingClientRect')
  const childrenOf = getter(Element, 'children')
  const shadowOf = getter(Element, 'shadowRoot')
  const childNodes = getter(Node, 'childNodes')
  const nodeType = getter(Node, 'nodeType')
  const isConnected = getter(Node, 'isConnected')
  const ownerOf = getter(Node, 'ownerDocument')
  const contains = method(Node, 'contains')
  const parentOf = getter(Node, 'parentElement')
  const textData = getter(CharacterData, 'data')
  const querySelectorAll = method(Document, 'querySelectorAll')
  const getElementById = method(Document, 'getElementById')
  const elementFromPoint = method(Document, 'elementFromPoint')
  const activeOf = getter(Document, 'activeElement')
  const bodyOf = getter(Document, 'body')
  const titleOf = getter(Document, 'title')
  const viewOf = getter(Document, 'defaultView')
  const inputType = getter(HTMLInputElement, 'type')
  const inputValue = getter(HTMLInputElement, 'value')
  const inputChecked = getter(HTMLInputElement, 'checked')
  const areaValue = getter(HTMLTextAreaElement, 'value')
  const selectOptions = getter(HTMLSelectElement, 'options')
  const selectedIndex = getter(HTMLSelectElement, 'selectedIndex')
  const optionLabel = getter(HTMLOptionElement, 'label')
  const optionValue = getter(HTMLOptionElement, 'value')
  const frameDocument = getter(HTMLIFrameElement, 'contentDocument')
  const frameSource = getter(HTMLIFrameElement, 'src')
  const clientLeft = getter(Element, 'clientLeft')
  const clientTop = getter(Element, 'clientTop')
  const clean = (text, limit) =>
    String(text ?? '')
      .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, limit)
  const own = scope
  const state =
    own.__latchAgentRefs && own.__latchAgentRefs.epoch === epoch
      ? own.__latchAgentRefs
      : (own.__latchAgentRefs = { epoch, next: 1, refs: new Map(), ids: new WeakMap() })
  const seenSensitive = own.__latchAgentSensitive || (own.__latchAgentSensitive = new WeakSet())
  const refOf = element => {
    let id = state.ids.get(element)
    if (!id) {
      id = 'e' + state.next++
      state.ids.set(element, id)
      state.refs.set(id, new WeakRef(element))
    }
    return id
  }
  const byRef = id => {
    const element = state.refs.get(id)?.deref()
    return element && isConnected(element) ? element : null
  }
  const SENSITIVE_AUTOCOMPLETE = /(?:^|\s)(?:current-password|new-password|one-time-code|cc-[a-z-]+)(?:\s|$)/i
  const sensitiveNow = element => {
    const name = localName(element)
    if (name !== 'input' && name !== 'textarea') return false
    if (name === 'input' && ['password', 'hidden'].includes(inputType(element))) return true
    return SENSITIVE_AUTOCOMPLETE.test(getAttribute(element, 'autocomplete') || '')
  }
  const sensitive = element => {
    if (seenSensitive.has(element)) return true
    if (!sensitiveNow(element)) return false
    seenSensitive.add(element)
    return true
  }
  const FRAMES = new Set(['iframe', 'frame', 'embed', 'object'])
  const SKIPPED = new Set(['script', 'style', 'noscript', 'template'])
  const hidden = element => {
    if (hasAttribute(element, 'hidden') || getAttribute(element, 'aria-hidden') === 'true') return true
    if (localName(element) === 'input' && inputType(element) === 'hidden') return true
    const view = viewOf(ownerOf(element))
    const computed = view ? view.getComputedStyle(element) : null
    return !!computed && (computed.display === 'none' || computed.visibility === 'hidden')
  }
  // A field's own text (a textarea's default value) is never read as words either.
  const ownText = (element, limit) => {
    let text = ''
    const walk = node => {
      if (text.length > limit * 2) return
      for (const child of childNodes(node)) {
        const type = nodeType(child)
        if (type === 3) text += ' ' + textData(child)
        else if (type === 1 && !SKIPPED.has(localName(child)) && localName(child) !== 'textarea' && !hidden(child)) walk(child)
      }
    }
    if (localName(element) !== 'textarea') walk(element)
    return clean(text, limit)
  }
  const labelOf = element => {
    const doc = ownerOf(element)
    const aria = getAttribute(element, 'aria-label')
    if (aria && aria.trim()) return clean(aria, limits.name)
    const by = getAttribute(element, 'aria-labelledby')
    if (by) {
      const text = by
        .split(/\s+/)
        .map(id => {
          const found = getElementById(doc, id)
          return found ? ownText(found, limits.name) : ''
        })
        .join(' ')
      if (text.trim()) return clean(text, limits.name)
    }
    const id = getAttribute(element, 'id')
    if (id) {
      for (const label of querySelectorAll(doc, 'label'))
        if (getAttribute(label, 'for') === id) {
          const text = ownText(label, limits.name)
          if (text) return text
        }
    }
    for (let node = parentOf(element); node; node = parentOf(node))
      if (localName(node) === 'label') {
        const text = ownText(node, limits.name)
        if (text) return text
        break
      }
    for (const name of ['alt', 'title', 'placeholder']) {
      const value = getAttribute(element, name)
      if (value && value.trim()) return clean(value, limits.name)
    }
    return ''
  }
  const INPUT_ROLES = {
    checkbox: 'checkbox',
    radio: 'radio',
    button: 'button',
    submit: 'button',
    reset: 'button',
    image: 'button',
    range: 'slider',
    search: 'searchbox',
    file: 'button',
    number: 'spinbutton',
  }
  const roleOf = element => {
    const explicit = getAttribute(element, 'role')
    if (explicit) return clean(explicit.split(/\s+/)[0], 32)
    const name = localName(element)
    if (name === 'a') return hasAttribute(element, 'href') ? 'link' : ''
    if (name === 'button' || name === 'summary') return 'button'
    if (name === 'input') return INPUT_ROLES[inputType(element)] || 'textbox'
    if (name === 'textarea') return 'textbox'
    if (name === 'select') return 'combobox'
    if (/^h[1-6]$/.test(name)) return 'heading'
    if (name === 'img') return 'img'
    if (name === 'ul' || name === 'ol') return 'list'
    if (name === 'li') return 'listitem'
    if (name === 'nav') return 'navigation'
    if (name === 'main') return 'main'
    if (name === 'form') return 'form'
    if (name === 'table') return 'table'
    if (name === 'dialog') return 'dialog'
    if (FRAMES.has(name)) return 'iframe'
    if (getAttribute(element, 'contenteditable') === 'true' || getAttribute(element, 'contenteditable') === '') return 'textbox'
    return ''
  }
  const INTERACTIVE = new Set([
    'link',
    'button',
    'textbox',
    'searchbox',
    'checkbox',
    'radio',
    'combobox',
    'slider',
    'spinbutton',
    'switch',
    'tab',
    'menuitem',
    'option',
    'listbox',
  ])
  const interactive = (element, role) =>
    INTERACTIVE.has(role) || (getAttribute(element, 'tabindex') !== null && Number(getAttribute(element, 'tabindex')) >= 0)
  const kindOf = element => {
    if (localName(element) === 'input' && inputType(element) === 'hidden') return '隐藏字段'
    const auto = getAttribute(element, 'autocomplete') || ''
    if (/one-time-code/i.test(auto)) return '验证码'
    if (/cc-/i.test(auto)) return '卡号等支付信息'
    return '密码框'
  }
  const valueOf = element => {
    if (sensitive(element)) return null
    const name = localName(element)
    if (name === 'input') {
      const type = inputType(element)
      if (type === 'checkbox' || type === 'radio' || type === 'file') return null
      return clean(inputValue(element), limits.value)
    }
    if (name === 'textarea') return clean(areaValue(element), limits.value)
    if (name === 'select') {
      const option = selectOptions(element)[selectedIndex(element)]
      return option ? clean(optionLabel(option), limits.value) : ''
    }
    return null
  }
  const describe = (element, role) => {
    const name = localName(element)
    let label = labelOf(element)
    if (!label && ['link', 'button', 'heading', 'listitem', 'option', 'tab', 'menuitem'].includes(role))
      label = ownText(element, limits.name)
    let line = role + (label ? ' ' + JSON.stringify(label) : '')
    if (role === 'heading') {
      const level = /^h([1-6])$/.exec(name)
      if (level) line += ' level=' + level[1]
    }
    if (sensitive(element)) line += ' （' + kindOf(element) + '，值不读取）'
    else {
      const value = valueOf(element)
      if (value) line += ' value=' + JSON.stringify(value)
    }
    if (name === 'input' && ['checkbox', 'radio'].includes(inputType(element))) line += inputChecked(element) ? ' checked' : ' unchecked'
    if (hasAttribute(element, 'disabled') || getAttribute(element, 'aria-disabled') === 'true') line += ' disabled'
    const expanded = getAttribute(element, 'aria-expanded')
    if (expanded) line += expanded === 'true' ? ' expanded' : ' collapsed'
    if (getAttribute(element, 'aria-selected') === 'true') line += ' selected'
    if (hasAttribute(element, 'required')) line += ' required'
    return line
  }
  /** A same-origin frame's document, or null for one of another origin. */
  const innerDocument = element => {
    try {
      return localName(element) === 'iframe' || localName(element) === 'frame' ? frameDocument(element) : null
    } catch {
      return null
    }
  }
  /** Where an element's document starts in the top frame's viewport: the boxes of the frames it sits in, inside their borders. */
  const frameOffset = element => {
    let x = 0
    let y = 0
    for (let view = viewOf(ownerOf(element)); view && view.frameElement; view = viewOf(ownerOf(view.frameElement))) {
      const frame = view.frameElement
      const box = getBox(frame)
      x += box.x + (clientLeft(frame) ?? 0)
      y += box.y + (clientTop(frame) ?? 0)
    }
    return { x, y }
  }
  /** The element with the keyboard, through same-origin frames and open shadow roots. */
  const focused = () => {
    let element = activeOf(document)
    for (let depth = 0; element && depth < 32; depth++) {
      const inner = innerDocument(element)
      const next = inner ? activeOf(inner) : shadowOf(element)?.activeElement
      if (!next || next === element) break
      element = next
    }
    return element
  }

  /** The accessibility tree of the main frame and its same-origin frames, with references. */
  const read = () => {
    const lines = []
    const refs = {}
    let size = 0
    let cut = false
    const push = line => {
      if (size + line.length + 1 > task.maxChars) {
        cut = true
        return false
      }
      lines.push(line)
      size += line.length + 1
      return true
    }
    const walk = (node, depth) => {
      if (cut) return
      for (const child of childNodes(node)) {
        if (cut) return
        const type = nodeType(child)
        if (type === 3) {
          if (task.interactive) continue
          const text = clean(textData(child), 300)
          if (text && !push('  '.repeat(depth) + '- text ' + JSON.stringify(text))) return
          continue
        }
        if (type !== 1) continue
        const element = child
        const name = localName(element)
        if (SKIPPED.has(name) || ['head', 'meta', 'link'].includes(name) || hidden(element)) continue
        if (FRAMES.has(name)) {
          const inner = innerDocument(element)
          if (!inner) {
            let origin = ''
            try {
              origin = new URL(
                name === 'iframe' || name === 'frame'
                  ? frameSource(element)
                  : getAttribute(element, 'src') || getAttribute(element, 'data') || '',
                location.href,
              ).origin
            } catch {}
            push('  '.repeat(depth) + '- 外部框架 ' + JSON.stringify(origin || '未知'))
            continue
          }
          push('  '.repeat(depth) + '- iframe')
          if (bodyOf(inner)) walk(bodyOf(inner), depth + 1)
          continue
        }
        const role = roleOf(element)
        const acts = interactive(element, role)
        if (role && (acts || !task.interactive)) {
          const id = acts ? refOf(element) : null
          if (id) refs[id] = sensitive(element)
          if (!push('  '.repeat(depth) + '- ' + describe(element, role) + (id ? ' [' + id + ']' : ''))) return
          if (['heading', 'button', 'link', 'option'].includes(role) || name === 'textarea') continue
          walk(element, task.interactive ? depth : depth + 1)
        } else walk(element, depth)
      }
    }
    push('页面：' + JSON.stringify(clean(titleOf(document), 256)) + ' ' + location.origin + location.pathname)
    if (bodyOf(document)) walk(bodyOf(document), 0)
    if (cut) lines.push('…（已截断，可用 interactive 只看可操作的元素）')
    return { text: lines.join('\n'), refs }
  }

  /**
   * Up to `limits.find` elements: by visible words (the deepest that hold them), by role and name, or by a selector
   * of tags, ids and classes only (no attribute, pseudo-class or escape), which main checked before sending it.
   */
  const find = () => {
    const found = []
    const visible = element => !hidden(element) && !SKIPPED.has(localName(element))
    if (typeof task.selector === 'string') {
      let list = []
      try {
        list = Array.from(querySelectorAll(document, task.selector))
      } catch {
        return { error: 'invalid' }
      }
      for (const element of list) {
        if (found.length >= limits.find) break
        if (visible(element)) found.push(element)
      }
    } else if (typeof task.role === 'string') {
      const name = typeof task.name === 'string' ? task.name.toLowerCase() : ''
      const visit = element => {
        if (found.length >= limits.find || !visible(element)) return
        const role = roleOf(element)
        if (role === task.role && (labelOf(element) + ' ' + ownText(element, 2000)).toLowerCase().includes(name)) found.push(element)
        for (const child of childrenOf(element)) visit(child)
      }
      if (bodyOf(document)) visit(bodyOf(document))
    } else {
      const needle = String(task.text).toLowerCase()
      const visit = element => {
        if (found.length >= limits.find || !visible(element)) return false
        if (!(ownText(element, 2000) + ' ' + labelOf(element)).toLowerCase().includes(needle)) return false
        let deeper = false
        for (const child of childrenOf(element)) if (visit(child)) deeper = true
        if (!deeper && found.length < limits.find) found.push(element)
        return true
      }
      if (bodyOf(document)) visit(bodyOf(document))
    }
    const refs = {}
    const lines = found.map(element => {
      const id = refOf(element)
      refs[id] = sensitive(element)
      const role = roleOf(element) || localName(element)
      return '- ' + describe(element, role) + ' [' + id + ']'
    })
    return { text: lines.length ? lines.join('\n') : '没有找到。', refs }
  }

  /**
   * What an action needs of a referenced element: brought into view, its box in the top frame's CSS pixels, its name,
   * whether it is a field whose value is never read, a file chooser or a frame. `hit` checks that its centre is really
   * it (or inside it) and nothing laid over it; `focus` focuses it (selecting its text with `select`) and then says
   * what has the keyboard; `option` picks a select's option by value or label.
   */
  const target = () => {
    const element = byRef(task.ref)
    if (!element) return { error: 'stale-ref' }
    const name = localName(element)
    if (FRAMES.has(name)) return { error: 'frame-target' }
    if (task.scroll) method(Element, 'scrollIntoView')(element, { block: 'center', inline: 'center' })
    const file = name === 'input' && inputType(element) === 'file'
    const label = labelOf(element) || ownText(element, limits.name)
    const box = getBox(element)
    if (task.hit) {
      const at = elementFromPoint(ownerOf(element), box.x + box.width / 2, box.y + box.height / 2)
      if (!at || !(at === element || contains(element, at))) return { error: 'obscured' }
    }
    /** @type {{ target: boolean, sensitive: boolean } | null} */
    let focus = null
    if (task.focus) {
      method(HTMLElement, 'focus')(element)
      if (task.select && (name === 'input' || name === 'textarea'))
        method(name === 'input' ? HTMLInputElement : HTMLTextAreaElement, 'select')(element)
      const now = focused()
      focus = { target: now === element, sensitive: !!now && sensitive(now) }
    }
    if (task.option !== null && task.option !== undefined) {
      if (name !== 'select') return { error: 'not-select' }
      const options = Array.from(selectOptions(element))
      const index = options.findIndex(item => optionValue(item) === task.option)
      const at = index >= 0 ? index : options.findIndex(item => clean(optionLabel(item), 500) === task.option)
      if (at < 0) return { error: 'no-option' }
      setter(HTMLSelectElement, 'selectedIndex')(element, at)
      method(EventTarget, 'dispatchEvent')(element, new Event('input', { bubbles: true }))
      method(EventTarget, 'dispatchEvent')(element, new Event('change', { bubbles: true }))
    }
    const offset = frameOffset(element)
    return {
      tag: name,
      label,
      sensitive: sensitive(element),
      file,
      focus,
      rect: { x: box.x + offset.x, y: box.y + offset.y, width: box.width, height: box.height },
    }
  }

  /** What has the keyboard now: whether it is a field whose value is never read, and whether it is `ref`. */
  const keyboard = () => {
    const now = focused()
    return { sensitive: !!now && sensitive(now), target: typeof task.ref === 'string' && now === byRef(task.ref) }
  }

  if (task.kind === 'read') return read()
  if (task.kind === 'find') return find()
  if (task.kind === 'target') return target()
  if (task.kind === 'keyboard') return keyboard()
  return { error: 'invalid' }
}

const WORLD_LIMITS = Object.freeze({ name: NAME_LIMIT, value: VALUE_LIMIT, find: FIND_LIMIT })

/** A task for the Agent's side of the isolated world, as the code main runs there. */
function worldScript(epoch, task) {
  return `(${agentWorld.toString()})(globalThis, ${Number(epoch)}, ${JSON.stringify(WORLD_LIMITS)}, ${JSON.stringify(task)})`
}

/** The accessibility tree of the tab's main frame and its same-origin frames, with references. */
function readScript({ epoch, interactive, maxChars }) {
  return worldScript(epoch, { kind: 'read', interactive, maxChars })
}

/** Up to 20 elements by visible words, by role and name, or by a selector of tags, ids and classes. */
function findScript({ epoch, ...by }) {
  return worldScript(epoch, { kind: 'find', ...by })
}

/** A referenced element for an action (see `agentWorld`'s `target`). */
function targetScript({ epoch, ref, scroll = true, hit = false, focus = false, select = false, option = null }) {
  return worldScript(epoch, { kind: 'target', ref, scroll, hit, focus, select, option })
}

/** What has the keyboard now (see `agentWorld`'s `keyboard`). */
function keyboardScript({ epoch, ref }) {
  return worldScript(epoch, { kind: 'keyboard', ...(ref ? { ref } : {}) })
}

/**
 * A selector `browser_find` accepts: tags, ids and classes, joined by descendant or child combinators. No attribute
 * selector, pseudo-class or escape: those could test a field's value (`input[value^="h"]`, `:has(…)`) one guess at a time.
 */
const SELECTOR_PART = /^(?:[A-Za-z][A-Za-z0-9-]*|\*)?(?:[#.][A-Za-z_][A-Za-z0-9_-]*)*$/u
function simpleSelector(text) {
  if (typeof text !== 'string') return false
  const parts = text.trim().split(/\s*>\s*|\s+/u)
  return parts.length > 0 && parts.length <= 8 && parts.every(part => part.length > 0 && part.length <= 64 && SELECTOR_PART.test(part))
}

/** Scrolls the page by a direction. */
function scrollScript(direction, amount) {
  const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0
  const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0
  return `(() => { Window.prototype.scrollBy.call(window, ${dx}, ${dy}); return { x: Math.round(scrollX), y: Math.round(scrollY) } })()`
}

/** Whether the page's visible text contains `text`. */
function textScript(text) {
  return `(() => { const read = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText').get; const body = Object.getOwnPropertyDescriptor(Document.prototype, 'body').get.call(document); return !!body && read.call(body).toLowerCase().includes(${JSON.stringify(String(text).toLowerCase())}) })()`
}

/** What the model hears of an element: its tag and name, never a value. */
function targetName(target) {
  const label = cleanText(target?.label, 40)
  return label ? `「${label}」` : (target?.tag ?? '元素')
}

function plainTarget(raw) {
  if (!isPlainObject(raw)) return undefined
  if (typeof raw.error === 'string') return { error: raw.error }
  const rect = raw.rect
  if (
    !isPlainObject(rect)
    || ![rect.x, rect.y, rect.width, rect.height].every(value => typeof value === 'number' && Number.isFinite(value))
  )
    return undefined
  return {
    tag: typeof raw.tag === 'string' ? raw.tag.slice(0, 64) : 'element',
    label: cleanText(raw.label, NAME_LIMIT),
    sensitive: raw.sensitive === true,
    file: raw.file === true,
    focus: isPlainObject(raw.focus) ? { target: raw.focus.target === true, sensitive: raw.focus.sensitive !== false } : null,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  }
}

/** @type {(ms: number, signal?: AbortSignal) => Promise<void>} */
const sleep = (ms, signal) =>
  new Promise(done => {
    const timer = setTimeout(done, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        done()
      },
      { once: true },
    )
  })

/** A failure the runner answers with: `dispatched` says whether anything reached the page. */
class AgentFailure extends Error {
  constructor(code, dispatched = false) {
    super(code)
    this.code = code
    this.dispatched = dispatched
  }
}

/**
 * Carries out the Host's calls on the preview tabs.
 * @param {object} options
 * @param {ReturnType<ReturnType<typeof import('./browser.cjs').createPreviewBrowser>['agentAccess']>} options.access
 * @param {ReturnType<typeof import('./browser.cjs').createPreviewBrowser>} options.controller
 * @param {() => number} [options.now]
 */
function createAgentRunner({ access, controller, now = Date.now }) {
  /** Calls in progress: how to stop each, and the tab it works in. */
  const running = new Map()
  // 接手 stops what the Agent is doing in that tab: each step checks, and waits end.
  access.onControl?.(tab => {
    if (tab.control !== 'person') return
    for (const entry of running.values()) if (entry.tabId === tab.id) entry.stop.abort('taken-over')
  })

  const tabsOf = sessionId => access.tabs().filter(item => item.sessionId === sessionId)

  /** The tab a call names, the session's own; refused when it is gone elsewhere or not on this Mac. */
  function tabFor(call) {
    const found = access.tab(call.args.tabId)
    if (!found || found.sessionId !== call.sessionId) throw new AgentFailure('not-found')
    if (ANYWHERE.has(call.tool)) return found
    const url = found.contents.getURL()
    if (call.origin !== null && originOf(url) !== call.origin) throw new AgentFailure('origin-changed')
    if (!localOrBlank(url)) throw new AgentFailure('not-local')
    if (found.control === 'person') throw new AgentFailure('taken-over')
    return found
  }

  const inSightNow = target => target.bounds !== null && !target.occluded

  /**
   * A tab out of sight does not lay out, paint or take input, so the call needs it shown: in the session's panel, which
   * the page is asked to switch to it. Without the panel open on the session the call is refused with `panel-closed`,
   * with a layer of the page over the shown tab with `panel-covered`, before anything happens.
   */
  async function inSight(target, sessionId) {
    if (access.showing() !== sessionId) throw new AgentFailure('panel-closed')
    if (inSightNow(target)) return
    access.reveal(target)
    for (let attempt = 0; attempt < REVEAL_TRIES && !inSightNow(target); attempt++) await sleep(REVEAL_STEP_MS)
    if (access.showing() !== sessionId) throw new AgentFailure('panel-closed')
    // The panel is open on the session and placed the tab, but a layer of the page (a menu, a dialog, 选取元素) covers it.
    if (!inSightNow(target)) throw new AgentFailure(target.bounds !== null && target.occluded ? 'panel-covered' : 'panel-closed')
    // Its first frame after it was placed.
    await sleep(150)
  }

  async function inWorld(target, code, ms) {
    let timer
    try {
      return await Promise.race([
        target.contents.executeJavaScriptInIsolatedWorld(ANNOTATION_WORLD, [{ code }]),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new AgentFailure('timeout')), ms)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  /** A guest CSS pixel in view DIP: the tab's own zoom and a preset's scale. */
  const zoomOf = target => target.contents.getZoomFactor() * target.scale

  /** The page keeps painting at full rate while the Agent works in it. */
  function prepare(target) {
    target.contents.setBackgroundThrottling(false)
  }

  /** Runs an action as the Agent's: no click of the person's counts, during it or a second after. */
  async function acting(target, activity, run) {
    access.gesture(target)?.clear()
    target.agentBusy = true
    target.touched = true
    target.control = 'agent'
    target.activity = activity
    access.changed(target, true)
    try {
      return await run()
    } finally {
      target.agentBusy = false
      target.agentUntil = now() + access.aftermath
      if (target.control === 'agent') target.control = null
      target.activity = null
      access.changed(target, true)
    }
  }

  async function waitForLoad(target, signal, ms) {
    const until = now() + ms
    await sleep(50, signal)
    while (!target.contents.isDestroyed() && target.contents.isLoading()) {
      if (signal.aborted) {
        target.contents.stop()
        throw new AgentFailure('cancelled', true)
      }
      if (now() > until) throw new AgentFailure('timeout', true)
      await sleep(WAIT_STEP_MS, signal)
    }
  }

  function mouse(target, point, kind, clicks) {
    const zoom = zoomOf(target)
    const x = Math.round(point.x * zoom)
    const y = Math.round(point.y * zoom)
    target.contents.sendInputEvent({ type: 'mouseMove', x, y })
    if (kind === 'hover') return
    for (let count = 1; count <= clicks; count++) {
      target.contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: count })
      target.contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: count })
    }
  }

  function key(target, name) {
    const code = NAMED_KEYS[name]
    if (code) {
      target.contents.sendInputEvent({ type: 'keyDown', keyCode: code })
      if (code === 'Enter' || code === 'Space') target.contents.sendInputEvent({ type: 'char', keyCode: code === 'Enter' ? '\r' : ' ' })
      target.contents.sendInputEvent({ type: 'keyUp', keyCode: code })
      return
    }
    target.contents.sendInputEvent({ type: 'keyDown', keyCode: name })
    target.contents.sendInputEvent({ type: 'char', keyCode: name })
    target.contents.sendInputEvent({ type: 'keyUp', keyCode: name })
  }

  function state(target) {
    const url = target.contents.getURL()
    return { tabId: target.id, url: shortUrl(url), title: cleanText(target.contents.getTitle(), 256) }
  }

  /**
   * Before each input the Agent sends: the person may have taken the tab over (or the call been stopped) since the
   * last one. `sent` says whether an earlier input of this call reached the page.
   */
  function step(target, signal, sent) {
    if (target.control === 'person' || signal.reason === 'taken-over') throw new AgentFailure('taken-over', sent)
    if (signal.aborted) throw new AgentFailure('cancelled', sent)
  }

  /** What has the keyboard: refused when it is a field whose value is never read and the call was not approved at R2. */
  async function keyboardAllows(target, call, ms) {
    const raw = await inWorld(target, keyboardScript({ epoch: target.refEpoch, ref: call.args.ref }), ms)
    if (!isPlainObject(raw)) throw new AgentFailure('no-target')
    if (raw.sensitive !== false && call.risk !== 'R2') throw new AgentFailure('sensitive-field')
    return raw.target === true
  }

  /** The note a result carries once after the person handed the tab back. */
  function note(target) {
    if (!target.handedBack) return ''
    target.handedBack = false
    return '\n（人操作过这个页面；之前的元素引用都已作废，请重新读取。）'
  }

  /** @returns {Promise<{ tag: string, label: string, sensitive: boolean, file: boolean, focus: { target: boolean, sensitive: boolean } | null, rect: { x: number, y: number, width: number, height: number } }>} */
  async function element(target, args, ms) {
    const raw = await inWorld(target, targetScript({ epoch: target.refEpoch, ...args }), ms)
    const found = plainTarget(raw)
    if (!found) throw new AgentFailure('no-target')
    if (['stale-ref', 'frame-target', 'obscured', 'invalid'].includes(found.error)) throw new AgentFailure(found.error)
    if (found.error || !found.rect) throw new AgentFailure('no-target')
    return /** @type {any} */ (found)
  }

  const TOOLS = {
    async browser_tabs(call) {
      const lines = tabsOf(call.sessionId).map(item => {
        const facts = access.stateOf(item)
        const who = item.control === 'person' ? ' · 人在操作' : item.control === 'agent' ? ' · Agent 在操作' : ''
        return `- ${item.id} ${JSON.stringify(facts?.title ?? '')} ${shortUrl(facts?.url ?? '')}${facts?.loading ? ' · 加载中' : ''}${who}${item.opener === 'agent' ? ' · Agent 打开' : ''}`
      })
      return { text: lines.length ? lines.join('\n') : '这个会话还没有标签。' }
    },
    async browser_open(call, signal) {
      if (access.tabs().length >= TAB_LIMIT) throw new AgentFailure('tab-limit')
      let target = null
      if (call.args.url !== undefined) {
        target = addressUrl(call.args.url)
        if (!target) throw new AgentFailure('invalid-url')
        if (!localOrBlank(target) || !access.verdict(target).ok) throw new AgentFailure('not-local')
      }
      // The tab must show in the session's panel; the page selects a tab the Agent opened as it hears of it.
      if (access.showing() !== call.sessionId) throw new AgentFailure('panel-closed')
      // The session's tabs share a project partition: the person's tabs name it, the Host's record otherwise.
      const projectId = tabsOf(call.sessionId)[0]?.projectId ?? call.projectId
      const opened = controller.open({ projectId, sessionId: call.sessionId, url: null, opener: 'agent' })
      if (!opened.ok) throw new AgentFailure(opened.error === 'tab-limit' ? 'tab-limit' : 'unavailable')
      const created = access.tab(opened.tabId)
      if (!created) throw new AgentFailure('unavailable')
      if (!target) return { text: `已打开空白标签 ${created.id}。`, tab: state(created) }
      return acting(created, '正在打开页面', async () => {
        prepare(created)
        access.load(created, target)
        // The page places the Agent's tab once it is no longer blank.
        await inSight(created, call.sessionId)
        await waitForLoad(created, signal, call.deadline - 2_500)
        const facts = state(created)
        return { text: `已在 ${created.id} 打开 ${facts.url}：${JSON.stringify(facts.title)}`, tab: facts, dispatched: true }
      })
    },
    async browser_navigate(call, signal) {
      const target = tabFor(call)
      let url
      if (call.args.url !== undefined) {
        url = addressUrl(call.args.url)
        if (!url) throw new AgentFailure('invalid-url')
        if (!localOrBlank(url) || !access.verdict(url).ok) throw new AgentFailure('not-local')
      }
      return acting(target, '正在打开页面', async () => {
        prepare(target)
        const history = target.contents.navigationHistory
        // Back and forward go only to an entry on this Mac.
        const entry = action => {
          const at = history.getActiveIndex() + (action === 'back' ? -1 : 1)
          const found = at >= 0 && at < history.length() ? history.getEntryAtIndex(at) : undefined
          if (found && !localOrBlank(found.url)) throw new AgentFailure('not-local')
          return found !== undefined
        }
        if (url) access.load(target, url)
        else if (call.args.action === 'back' && history.canGoBack() && entry('back')) history.goBack()
        else if (call.args.action === 'forward' && history.canGoForward() && entry('forward')) history.goForward()
        else if (call.args.action === 'reload') target.contents.reload()
        await waitForLoad(target, signal, call.deadline - 500)
        const facts = state(target)
        return { text: `现在在 ${facts.url}：${JSON.stringify(facts.title)}${note(target)}`, tab: facts, dispatched: true }
      })
    },
    async browser_read(call) {
      const target = tabFor(call)
      prepare(target)
      const raw = await inWorld(
        target,
        readScript({ epoch: target.refEpoch, interactive: call.args.interactive === true, maxChars: call.args.maxChars ?? READ_CHARS }),
        call.deadline - 500,
      )
      if (!isPlainObject(raw) || typeof raw.text !== 'string' || !isPlainObject(raw.refs)) throw new AgentFailure('no-target')
      return { text: `${raw.text}${note(target)}`, tab: state(target), refs: cleanRefs(raw.refs) }
    },
    async browser_find(call) {
      const target = tabFor(call)
      prepare(target)
      const raw = await inWorld(
        target,
        findScript({
          epoch: target.refEpoch,
          ...(call.args.text !== undefined ? { text: call.args.text } : {}),
          ...(call.args.selector !== undefined ? { selector: call.args.selector } : {}),
          ...(call.args.role !== undefined ? { role: call.args.role, name: call.args.name ?? '' } : {}),
        }),
        call.deadline - 500,
      )
      if (isPlainObject(raw) && raw.error === 'invalid') throw new AgentFailure('invalid')
      if (!isPlainObject(raw) || typeof raw.text !== 'string' || !isPlainObject(raw.refs)) throw new AgentFailure('no-target')
      return { text: `${raw.text}${note(target)}`, tab: state(target), refs: cleanRefs(raw.refs) }
    },
    async browser_screenshot(call) {
      const target = tabFor(call)
      prepare(target)
      await sleep(30)
      let rect
      if (call.args.ref !== undefined) {
        const found = await element(target, { ref: call.args.ref }, call.deadline - 1000)
        const zoom = zoomOf(target)
        const view = target.view.getBounds()
        const x = Math.max(0, Math.floor(found.rect.x * zoom))
        const y = Math.max(0, Math.floor(found.rect.y * zoom))
        const right = Math.min(view.width, Math.ceil((found.rect.x + found.rect.width) * zoom))
        const bottom = Math.min(view.height, Math.ceil((found.rect.y + found.rect.height) * zoom))
        if (right <= x || bottom <= y) throw new AgentFailure('no-target')
        rect = { x, y, width: right - x, height: bottom - y }
      }
      let image
      try {
        image = await access.snapshot(target, rect, CAPTURE_LIMITS)
      } catch {
        image = undefined
      }
      if (!image) throw new AgentFailure('capture-failed')
      return { text: `截图 ${image.width}×${image.height}，${state(target).url}${note(target)}`, tab: state(target), image }
    },
    async browser_scroll(call) {
      const target = tabFor(call)
      return acting(target, '正在滚动页面', async () => {
        prepare(target)
        if (call.args.ref !== undefined) {
          const found = await element(target, { ref: call.args.ref }, call.deadline - 500)
          return { text: `已把 ${targetName(found)} 滚到视野里。${note(target)}`, tab: state(target), dispatched: true }
        }
        const raw = await inWorld(target, scrollScript(call.args.direction, call.args.amount ?? 600), call.deadline - 500)
        const at = isPlainObject(raw) ? `（现在在 ${Number(raw.x) || 0}, ${Number(raw.y) || 0}）` : ''
        return { text: `已滚动${at}。${note(target)}`, tab: state(target), dispatched: true }
      })
    },
    async browser_viewport(call) {
      const target = tabFor(call)
      if (call.args.preset !== undefined) {
        const answer = controller.viewport({ tabId: target.id, preset: call.args.preset, rotated: call.args.rotated === true })
        if (!answer.ok) throw new AgentFailure('invalid')
      }
      if (call.args.colorScheme !== undefined) {
        const answer = await controller.colorScheme({ tabId: target.id, scheme: call.args.colorScheme })
        if (!answer.ok) throw new AgentFailure('emulation-failed')
      }
      const facts = access.stateOf(target)
      return {
        text: `视口 ${facts?.viewport.preset ?? 'fit'}${facts?.viewport.rotated ? '（旋转）' : ''}，外观 ${facts?.colorScheme ?? 'system'}。`,
        tab: state(target),
      }
    },
    async browser_console(call) {
      const target = tabFor(call)
      const filter = call.args.filter?.toLowerCase()
      const entries = lastOf(target.console, 500)
        .filter(entry => (!call.args.errorsOnly || entry.level === 'error') && (!filter || entry.text.toLowerCase().includes(filter)))
        .slice(-(call.args.limit ?? 50))
      const lines = entries.map(entry => `- ${entry.level} ${entry.text}${entry.source ? ` (${entry.source}:${entry.line})` : ''}`)
      return { text: lines.length ? lines.join('\n') : '没有控制台消息。', tab: state(target) }
    },
    async browser_network(call) {
      const target = tabFor(call)
      const filter = call.args.filter?.toLowerCase()
      const failed = entry => entry.error !== null || (entry.status !== null && entry.status >= 400)
      const entries = lastOf(target.network, 500)
        .filter(entry => (!call.args.failedOnly || failed(entry)) && (!filter || entry.url.toLowerCase().includes(filter)))
        .slice(-(call.args.limit ?? 50))
      const lines = entries.map(
        entry =>
          `- ${entry.method} ${entry.url} ${entry.error ?? entry.status ?? '…'}${entry.duration !== null ? ` ${entry.duration}ms` : ''}${entry.size !== null ? ` ${entry.size}B` : ''}`,
      )
      return { text: lines.length ? lines.join('\n') : '没有请求。', tab: state(target) }
    },
    async browser_wait(call, signal) {
      const target = tabFor(call)
      prepare(target)
      const until = now() + Math.min(call.args.timeoutMs ?? 10_000, call.deadline - 500)
      for (;;) {
        if (signal.aborted) throw new AgentFailure('cancelled')
        // The page may have gone elsewhere while the Agent waits.
        if (!localOrBlank(target.contents.getURL())) throw new AgentFailure('not-local')
        let met = true
        if (call.args.text !== undefined)
          met = met && (await inWorld(target, textScript(call.args.text), 2_000).catch(() => false)) === true
        if (call.args.urlIncludes !== undefined) met = met && shortUrl(target.contents.getURL()).includes(call.args.urlIncludes)
        if (call.args.networkIdle === true) met = met && target.inflight === 0 && now() - target.quietSince >= QUIET_MS
        if (met) return { text: `已满足，现在在 ${state(target).url}。${note(target)}`, tab: state(target) }
        if (now() >= until) throw new AgentFailure('timeout')
        await sleep(WAIT_STEP_MS, signal)
      }
    },
    async browser_click(call, signal) {
      const target = tabFor(call)
      const verb = call.args.hover ? '悬停' : call.args.double ? '双击' : '点击'
      return acting(target, `正在${verb}`, async () => {
        prepare(target)
        // Its centre must be the element itself, not something the page laid over it.
        const found = await element(target, { ref: call.args.ref, hit: true }, call.deadline - 1000)
        // A file chooser would open a native panel on the person's screen.
        if (found.file) throw new AgentFailure('file-input')
        target.activity = `正在${verb}${targetName(found)}`
        access.changed(target, true)
        step(target, signal, false)
        mouse(
          target,
          { x: found.rect.x + found.rect.width / 2, y: found.rect.y + found.rect.height / 2 },
          call.args.hover ? 'hover' : 'click',
          call.args.double ? 2 : 1,
        )
        await sleep(100)
        return { text: `已${verb} ${targetName(found)}。${note(target)}`, tab: state(target), dispatched: true }
      })
    },
    async browser_key(call, signal) {
      const target = tabFor(call)
      return acting(target, '正在按键', async () => {
        prepare(target)
        // A character into a password field one key at a time is typing into it: refused below R2, as browser_type is.
        const printable = call.args.key === 'Space' || !Object.hasOwn(NAMED_KEYS, call.args.key)
        if (printable) await keyboardAllows(target, call, call.deadline - 1000)
        step(target, signal, false)
        key(target, call.args.key)
        await sleep(50)
        return { text: `已按 ${call.args.key}。${note(target)}`, tab: state(target), dispatched: true }
      })
    },
    async browser_select(call) {
      const target = tabFor(call)
      return acting(target, '正在选择', async () => {
        prepare(target)
        const found = await element(target, { ref: call.args.ref, option: call.args.value }, call.deadline - 500)
        return {
          text: `已在 ${targetName(found)} 选择 ${JSON.stringify(call.args.value)}。${note(target)}`,
          tab: state(target),
          dispatched: true,
        }
      })
    },
    async browser_type(call, signal) {
      const target = tabFor(call)
      return acting(target, '正在输入', async () => {
        prepare(target)
        // Only check, don't focus yet: a field whose value is never read takes text only at R2.
        const peek = await element(target, { ref: call.args.ref, scroll: true }, call.deadline - 1000)
        if (peek.sensitive && call.risk !== 'R2') throw new AgentFailure('sensitive-field')
        if (peek.file) throw new AgentFailure('file-input')
        target.activity = `正在输入${targetName(peek)}`
        access.changed(target, true)
        const focused = await element(
          target,
          { ref: call.args.ref, scroll: false, focus: true, select: call.args.clear === true },
          call.deadline - 1000,
        )
        // Focusing may move the keyboard elsewhere (the page's own script): it must be this field, and checked again.
        if (!focused.focus?.target) throw new AgentFailure('focus-moved')
        if (focused.focus.sensitive && call.risk !== 'R2') throw new AgentFailure('sensitive-field')
        step(target, signal, false)
        if (call.args.clear === true) key(target, 'Backspace')
        // Right before the text goes in: still this field, and still allowed.
        if (!(await keyboardAllows(target, call, 2_000))) throw new AgentFailure('focus-moved', call.args.clear === true)
        step(target, signal, call.args.clear === true)
        await target.contents.insertText(call.args.text)
        if (call.args.submit === true) {
          step(target, signal, true)
          key(target, 'Enter')
        }
        await sleep(50)
        const what = peek.sensitive ? '（敏感字段，内容不回显）' : `${[...call.args.text].length} 个字`
        return {
          text: `已在 ${targetName(peek)} 输入 ${what}${call.args.submit ? '并按回车' : ''}。${note(target)}`,
          tab: state(target),
          dispatched: true,
        }
      })
    },
    async browser_close(call) {
      const target = tabFor(call)
      access.drop(target)
      return { text: `已关闭 ${target.id}。`, dispatched: true }
    },
  }

  return {
    /** Carries out one call; resolves with what goes back to the Host. Never throws. */
    async run(raw) {
      const call = callInput(raw)
      if (!call) return undefined
      if (call.invalid) return { callId: call.callId, ok: false, dispatched: false, error: 'invalid' }
      const stop = new AbortController()
      running.set(call.callId, { stop, tabId: typeof call.args.tabId === 'string' ? call.args.tabId : undefined })
      try {
        if (IN_SIGHT.has(call.tool) && call.tool !== 'browser_open') await inSight(tabFor(call), call.sessionId)
        const result = await TOOLS[call.tool](call, stop.signal)
        const text = (result.text ?? '').slice(0, RESULT_TEXT_LIMIT)
        return {
          callId: call.callId,
          ok: true,
          dispatched: result.dispatched === true || ACTIONS.has(call.tool),
          text,
          ...(result.tab ? { tab: result.tab } : {}),
          ...(result.refs ? { refs: result.refs } : {}),
          ...(result.image ? { image: result.image } : {}),
        }
      } catch (error) {
        const dispatched = error instanceof AgentFailure ? error.dispatched : ACTIONS.has(call.tool)
        const takenOver = stop.signal.reason === 'taken-over' || (error instanceof AgentFailure && error.code === 'taken-over')
        let code = error instanceof AgentFailure ? error.code : 'failed'
        // Stopped part-way: what reached the page cannot be taken back, so its result is unknown.
        if (takenOver) code = dispatched ? 'result-unknown' : 'taken-over'
        else if (stop.signal.aborted) code = dispatched ? 'result-unknown' : 'cancelled'
        return { callId: call.callId, ok: false, dispatched, error: code }
      } finally {
        running.delete(call.callId)
        // A tab out of sight goes back to sleeping between calls.
        const touched = typeof call.args.tabId === 'string' ? access.tab(call.args.tabId) : undefined
        if (touched && !touched.contents.isDestroyed()) touched.contents.setBackgroundThrottling(true)
      }
    },
    /** The Host stopped a call: waits end, loads stop; the call then settles and says whether it reached the page. */
    cancel(callId) {
      running.get(callId)?.stop.abort('cancelled')
    },
    /** The session ended: its tabs close. */
    sessionEnded(sessionId) {
      for (const item of tabsOf(sessionId)) access.drop(item)
    },
    /** A turn ended: the person's takeover of the session's tabs ends with it, and the Agent no longer counts as there. */
    turnEnded(sessionId) {
      for (const item of tabsOf(sessionId)) {
        item.touched = false
        if (item.control === 'person') {
          item.control = null
          item.refEpoch++
          access.changed(item, true)
        }
      }
    },
    /** What the Host's table and the phone get: never a query. */
    report() {
      return access.tabs().map(item => {
        const facts = access.stateOf(item)
        return {
          tabId: item.id,
          sessionId: item.sessionId,
          title: cleanText(facts?.title ?? '', 256),
          url: shortUrl(facts?.url ?? ''),
          loading: facts?.loading === true,
          control: item.control,
          opener: item.opener,
        }
      })
    },
    stopAll() {
      for (const entry of running.values()) entry.stop.abort('cancelled')
    },
  }
}

function cleanRefs(raw) {
  const refs = {}
  let count = 0
  for (const [key, value] of Object.entries(raw)) {
    if (!REF.test(key) || count >= 2000) continue
    refs[key] = value === true
    count++
  }
  return refs
}

/**
 * main as the browser provider of its own Host: a nonce, a registration signed with the device key, then a stream of
 * calls over host.sock, each answered with its result (a picture first, when it has one). It runs while the main window
 * exists; without it the Host has no provider and calls fail at once. A broken stream is opened again after a pause.
 * @param {object} options
 * @param {(method: string, path: string, body?: unknown) => Promise<{ status: number, json: any }>} options.request
 * @param {(path: string, body: unknown, signal: AbortSignal) => Promise<Response>} options.stream
 * @param {(path: string, data: Uint8Array) => Promise<{ status: number }>} options.putImage
 * @param {(body: Record<string, unknown>) => string} options.sign
 * @param {ReturnType<typeof createAgentRunner>} options.runner
 * @param {(listener: (urgent: boolean) => void) => () => void} options.onTabs
 * @param {(message: string) => void} [options.log]
 */
function createBrowserProvider({ request, stream, putImage, sign, runner, onTabs, log = () => {} }) {
  let active = false
  let session
  let providerId
  let stopTabs
  let reportTimer
  let lastReport = 0

  async function register() {
    const grant = await request('POST', '/link/api/browser-provider/nonce', {})
    if (grant.status !== 200 || typeof grant.json?.nonce !== 'string') return undefined
    const body = { nonce: grant.json.nonce, purpose: 'browser-provider' }
    const answer = await request('POST', '/link/api/browser-provider/register', { ...body, signature: sign(body) })
    return answer.status === 201 && typeof answer.json?.providerId === 'string' ? answer.json.providerId : undefined
  }

  async function report() {
    reportTimer = undefined
    lastReport = Date.now()
    if (!providerId) return
    await request('POST', '/link/api/browser-provider/tabs', { providerId, tabs: runner.report() }).catch(() => {})
  }

  /** At most one report a second; who acts in a tab goes at once. */
  function scheduleReport(urgent) {
    if (!providerId) return
    if (urgent) {
      clearTimeout(reportTimer)
      void report()
      return
    }
    if (reportTimer !== undefined) return
    reportTimer = setTimeout(() => void report(), Math.max(0, 1000 - (Date.now() - lastReport)))
  }

  async function answer(call) {
    const result = await runner.run(call)
    if (!result) return
    const { image, ...rest } = /** @type {any} */ (result)
    if (image) {
      const put = await putImage(`/link/api/browser-provider/results/${result.callId}/image`, image.data).catch(() => ({ status: 0 }))
      rest.image = put.status === 200
    }
    await request('POST', '/link/api/browser-provider/results', rest).catch(() => log('浏览器调用的结果没有交回 Latch 服务'))
  }

  function handle(event, data) {
    if (event === 'call') void answer(data)
    else if (event === 'cancel' && typeof data?.callId === 'string') runner.cancel(data.callId)
    else if (event === 'session-ended' && typeof data?.sessionId === 'string') runner.sessionEnded(data.sessionId)
    else if (event === 'turn-ended' && typeof data?.sessionId === 'string') runner.turnEnded(data.sessionId)
  }

  /** Reads one stream until it ends. */
  async function read(response, controller) {
    const reader = response.body.getReader()
    controller.signal.addEventListener('abort', () => void reader.cancel().catch(() => {}), { once: true })
    const decoder = new TextDecoder()
    let buffer = ''
    let heard = Date.now()
    const watchdog = setInterval(() => {
      if (Date.now() - heard > 45_000) controller.abort()
    }, 5_000)
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        heard = Date.now()
        buffer += decoder.decode(value, { stream: true })
        if (buffer.length > 4 * 1024 * 1024) return
        let end
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const name = /^event: (.+)$/mu.exec(block)?.[1]
          const data = /^data: (.*)$/mu.exec(block)?.[1]
          if (!name || data === undefined) continue
          if (name === 'ended') return
          let parsed
          try {
            parsed = JSON.parse(data)
          } catch {
            continue
          }
          handle(name, parsed)
        }
      }
    } finally {
      clearInterval(watchdog)
    }
  }

  async function loop(current) {
    let pause = 1_000
    while (active && session === current) {
      try {
        providerId = await register()
        if (providerId) {
          const response = await stream('/link/api/browser-provider/stream', { providerId }, current.signal)
          if (response.status === 200 && response.body) {
            pause = 1_000
            scheduleReport(true)
            await read(response, current)
          } else await response.body?.cancel().catch(() => {})
        }
      } catch {
        /* The Host is away or restarting: try again after a pause. */
      }
      providerId = undefined
      runner.stopAll()
      if (!active || session !== current) return
      await sleep(pause, current.signal)
      pause = Math.min(pause * 2, 30_000)
    }
  }

  return {
    /** Registers and keeps the stream open until `stop`. */
    start() {
      if (active) return
      active = true
      session = new AbortController()
      stopTabs = onTabs(urgent => scheduleReport(urgent))
      void loop(session)
    },
    /** The window went away: the stream closes, so the Host has no provider and its calls fail at once. */
    stop() {
      if (!active) return
      active = false
      session?.abort()
      session = undefined
      providerId = undefined
      stopTabs?.()
      clearTimeout(reportTimer)
      reportTimer = undefined
      runner.stopAll()
    },
    /** Test view. */
    state() {
      return { active, registered: providerId !== undefined }
    },
  }
}

module.exports = {
  AGENT_TOOLS,
  AGENT_INPUTS,
  NAMED_KEYS,
  callInput,
  agentWorld,
  readScript,
  findScript,
  targetScript,
  keyboardScript,
  simpleSelector,
  localOrBlank,
  shortUrl,
  createAgentRunner,
  createBrowserProvider,
}
