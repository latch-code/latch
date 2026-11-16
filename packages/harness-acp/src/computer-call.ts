/**
 * 「操控这台 Mac」: how the `latch-mcp` bridge reads a call's shape (`ComputerCallShape` in `@latch/protocol`) for the
 * Host to check. This guards against an agent's mistakes, not against the agent; see docs/MCP.md (逐次核对).
 *
 * The reader is plain JavaScript, so that the bridge (one script given to `node -e`) and the tests run the same text.
 * It follows `run_steps` as Cua Driver parses it (`crates/cua-driver-core/src/batch_tools.rs`, the same at the tags
 * cua-driver-rs-v0.37.0, v0.44.0, v0.46.1 and v0.52.3): the step forms `{tool, args}`, `{tool, <fields>}` (0.48.0) and
 * `{<tool>: args}`; a check-only step; trailing reads; the alias table, key names and `triple_click`. Where the driver
 * rewrites a step into another tool (one-key `hotkey` to `press_key`, a symbol `press_key` to `type_text`, `press` on an
 * element to `click`), every tool it may become is listed. The driver also calls tools itself inside a batch: it finds a
 * named target and checks `wait_for`/`expect` through `list_apps`, `list_windows` and `get_window_state`
 * (`batch_tools/locate.rs`), reads the window again after a failed step (`OBSERVE_TOOL`), and sends a failed `click` on a
 * menu-bar item to `invoke_menu` (`menu_bar_route`). So every batch lists those three reads, and every `click` lists
 * `invoke_menu`.
 */
export const COMPUTER_SHAPE_SOURCE = String.raw`
function computerCallShape(tool, args) {
  var BATCHABLE = ['click', 'double_click', 'right_click', 'set_value', 'type_text', 'press_key', 'hotkey', 'scroll', 'drag', 'move_cursor']
  var ALIASES = { press: 'press_key', key: 'press_key', keypress: 'press_key', type: 'type_text', set: 'set_value', hover: 'move_cursor', mouse_move: 'move_cursor' }
  var KEY_NAMES = ['return', 'enter', 'tab', 'escape', 'esc', 'space', 'backspace', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown']
  var READS = ['get_window_state', 'get_desktop_state', 'get_accessibility_tree', 'get_browser_state', 'list_windows', 'verify_state', 'zoom']
  var STEP_KEYS = ['tool', 'args', 'wait_for', 'expect', 'timeout_ms']
  var RUN_STEPS_KEYS = ['steps', 'delay_ms', 'pid', 'window_id', 'app', 'window', 'delivery_mode', 'foreground_fallback', 'observe', 'session']
  var has = function (object, key) { return Object.prototype.hasOwnProperty.call(object, key) }
  var plain = function (value) { return typeof value === 'object' && value !== null && !Array.isArray(value) }
  var unknown = { form: 'unknown' }
  if (args === undefined || args === null) args = {}
  if (!plain(args)) return unknown
  var shape = {}
  // Names that mean Latch: an accident guard, not a boundary.
  var isLatch = function (key, value) {
    if (typeof value !== 'string') return false
    var text = value.trim().toLowerCase()
    // A bundle ID with a segment latch, wherever one is accepted: app and launch_app's name take one too.
    if (key !== 'window' && text.indexOf('.') > 0) {
      if (text.split('.').indexOf('latch') >= 0) return true
    }
    return text === 'latch' || text === 'latch.app'
  }
  // Every value, at most 8 deep and 4096 nodes: pids, Latch's name and a screenshot written to a file.
  var nodes = 0
  var pids = []
  var walk = function (value, depth) {
    if (++nodes > 4096 || depth > 8) return false
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) if (!walk(value[i], depth + 1)) return false
      return true
    }
    if (!plain(value)) return true
    var keys = Object.keys(value)
    for (var j = 0; j < keys.length; j++) {
      var key = keys[j]
      var item = value[key]
      if (/screenshot_out|out_file/i.test(key)) shape.screenshotFile = true
      if ((key === 'app' || key === 'window' || key === 'bundle_id') && isLatch(key, item)) shape.latchName = true
      // The driver turns a numeric string into a number (coerce_string_scalars), so "777" and "+777" are pid 777 too.
      var pid = typeof item === 'string' && /^\s*[+-]?\d+\s*$/.test(item) ? Number(item.trim()) : item
      if (key === 'pid' && typeof pid === 'number') {
        if (!Number.isSafeInteger(pid)) return false
        if (pids.indexOf(pid) < 0) pids.push(pid)
      }
      if (!walk(item, depth + 1)) return false
    }
    return true
  }
  if (!walk(args, 0) || pids.length > 64) return unknown
  if (pids.length) shape.pids = pids
  if (tool === 'launch_app') {
    var keys = Object.keys(args)
    var value = args[keys[0]]
    var ok = keys.length === 1 && typeof value === 'string' && (
      (keys[0] === 'bundle_id' && /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(value)) ||
      (keys[0] === 'name' && value.trim().length > 0 && value.length <= 255 && !/[\/\u0000-\u001f\u007f]/.test(value))
    )
    shape.launch = ok ? 'ok' : 'refused'
    if (keys.length === 1 && keys[0] === 'name' && isLatch('name', value)) shape.latchName = true
    return shape
  }
  if (tool !== 'run_steps') return shape
  // run_steps: the batch's own keys, then each step as the driver reads it.
  var top = Object.keys(args)
  for (var t = 0; t < top.length; t++) if (RUN_STEPS_KEYS.indexOf(top[t]) < 0) return Object.assign(shape, unknown)
  var steps = args.steps
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 64) return Object.assign(shape, unknown)
  var tools = []
  var add = function (name) { if (tools.indexOf(name) < 0) tools.push(name) }
  // What the driver may call itself in any batch: finding targets, checks, the read after a failed step.
  add('get_window_state')
  add('list_windows')
  add('list_apps')
  if (has(args, 'observe') && args.observe !== null && args.observe !== false) {
    if (!plain(args.observe)) return Object.assign(shape, unknown)
    add('get_window_state')
  }
  // The tools one action may run, or undefined when the driver would not run it.
  var actionTools = function (name, raw) {
    if (raw !== undefined && raw !== null && !plain(raw)) return undefined
    var out = []
    var named = has(ALIASES, name) ? ALIASES[name] : name
    var lower = String(name).toLowerCase()
    if (lower === 'triple_click') named = 'click'
    else if (KEY_NAMES.indexOf(lower) >= 0) named = 'press_key'
    if (BATCHABLE.indexOf(named) < 0) return undefined
    out.push(named)
    // press on an element is a click; a one-key hotkey a press_key; a symbol press_key is typed.
    if (name === 'press') out.push('click')
    if (named === 'hotkey' || named === 'press_key') out.push('press_key', 'type_text')
    // A failed click on a menu-bar item goes to invoke_menu.
    if (out.indexOf('click') >= 0) out.push('invoke_menu')
    return out
  }
  for (var s = 0; s < steps.length; s++) {
    var step = steps[s]
    if (!plain(step)) return Object.assign(shape, unknown)
    var checks = (has(step, 'wait_for') && step.wait_for !== null) || (has(step, 'expect') && step.expect !== null)
    // A read (get_window_state, zoom, "…screenshot…"): the end read, or skipped. Its own tool must be on.
    if (!has(step, 'wait_for') && !has(step, 'expect')) {
      var readName
      if (has(step, 'tool')) readName = typeof step.tool === 'string' ? step.tool : undefined
      else {
        var own = Object.keys(step).filter(function (key) { return STEP_KEYS.indexOf(key) < 0 })
        if (own.length === 1) readName = own[0]
      }
      if (readName !== undefined) {
        if (READS.indexOf(readName) >= 0) { add(readName); continue }
        if (readName.toLowerCase().indexOf('screenshot') >= 0) { add('get_window_state'); continue }
      }
    }
    var shorthand = Object.keys(step).filter(function (key) {
      if (STEP_KEYS.indexOf(key) >= 0) return false
      var item = step[key]
      if (item === null) return false
      if (plain(item) && Object.keys(item).length === 0 && has(step, 'tool')) return false
      return true
    })
    var argsAbsent = !has(step, 'args') || step.args === null
    var name
    var raw
    if (has(step, 'tool') && shorthand.length) {
      if (!argsAbsent || typeof step.tool !== 'string') return Object.assign(shape, unknown)
      name = step.tool
      raw = {}
      for (var k = 0; k < shorthand.length; k++) raw[shorthand[k]] = step[shorthand[k]]
    } else if (has(step, 'tool')) {
      if (typeof step.tool !== 'string') return Object.assign(shape, unknown)
      name = step.tool
      raw = step.args
    } else if (shorthand.length === 1) {
      if (has(step, 'args')) return Object.assign(shape, unknown)
      name = shorthand[0]
      raw = step[name]
    } else if (shorthand.length === 0) {
      if (has(step, 'args') || !checks) return Object.assign(shape, unknown)
      continue
    } else return Object.assign(shape, unknown)
    var found = actionTools(name, raw)
    if (!found) return Object.assign(shape, unknown)
    for (var f = 0; f < found.length; f++) add(found[f])
  }
  shape.steps = tools.sort()
  shape.stepCount = steps.length
  return shape
}
`
