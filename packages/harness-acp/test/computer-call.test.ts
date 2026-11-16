import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import type { ComputerCallShape } from '@latch/protocol'
import { COMPUTER_SHAPE_SOURCE } from '../src/computer-call.ts'

/** The reader as the bridge runs it: the same text, in a context of its own. */
const read = runInNewContext(`${COMPUTER_SHAPE_SOURCE}\ncomputerCallShape`) as (tool: string, args: unknown) => ComputerCallShape
/** Copied out of that context, so it compares as plain data. */
const shapeOf = (tool: string, args: unknown) => JSON.parse(JSON.stringify(read(tool, args))) as ComputerCallShape
const steps = (...items: unknown[]) => shapeOf('run_steps', { steps: items })
/** What the driver may call itself in any batch: finding a target, checks, the read after a failed step. */
const ALWAYS = ['get_window_state', 'list_apps', 'list_windows']
/** The tools a batch needs on: the step's own, the driver's own reads, and invoke_menu wherever a click may run. */
const needs = (...tools: string[]) => [...new Set([...tools, ...ALWAYS, ...(tools.includes('click') ? ['invoke_menu'] : [])])].sort()

describe('the shape of a 「操控这台 Mac」 call, as the bridge reads it', () => {
  it.each([
    // The three step forms.
    ['{tool, args}', [{ tool: 'click', args: { element_token: 's1:2' } }], ['click']],
    ['{tool, <fields>} (0.48.0)', [{ tool: 'hotkey', keys: ['cmd', 's'] }], ['hotkey', 'press_key', 'type_text']],
    ['{<tool>: args}', [{ type_text: { text: 'Hello' } }], ['type_text']],
    ['{tool} with an empty extra object', [{ tool: 'scroll', args: { dy: 3 }, extra: {} }], ['scroll']],
    // Aliases, key names and rewrites.
    ['alias type', [{ type: { text: 'x' } }], ['type_text']],
    ['alias set', [{ tool: 'set', args: { value: 'x' } }], ['set_value']],
    ['alias key', [{ key: { key: 'a' } }], ['press_key', 'type_text']],
    ['alias keypress', [{ tool: 'keypress', args: { key: 'a' } }], ['press_key', 'type_text']],
    ['alias hover', [{ hover: { x: 1, y: 2 } }], ['move_cursor']],
    ['alias mouse_move', [{ tool: 'mouse_move', args: { x: 1, y: 2 } }], ['move_cursor']],
    ['press on an element is a click', [{ press: { role: 'button', name: 'OK' } }], ['click', 'press_key', 'type_text']],
    ['press with a key', [{ press: { key: 'return' } }], ['click', 'press_key', 'type_text']],
    ['a key name as the tool', [{ tool: 'Return' }], ['press_key', 'type_text']],
    ['triple_click', [{ TRIPLE_CLICK: { x: 1, y: 1 } }], ['click']],
    ['drag', [{ drag: { from: [0, 0], to: [1, 1] } }], ['drag']],
    // Checks and reads.
    ['a check-only step', [{ click: { role: 'button' } }, { wait_for: { text: 'Saved' } }], ['click']],
    ['a trailing get_window_state', [{ click: {} }, { tool: 'get_window_state', args: { query: 'x' } }], ['click', 'get_window_state']],
    ['a screenshot read', [{ click: {} }, { take_screenshot: {} }], ['click', 'get_window_state']],
    ['a trailing zoom', [{ click: {} }, { zoom: { x: 0 } }], ['click', 'zoom']],
    ['a read the driver skips still counts', [{ get_desktop_state: {} }, { click: {} }], ['click', 'get_desktop_state']],
  ])('%s', (_, items, tools) => {
    expect(steps(...items)).toEqual({ steps: needs(...tools), stepCount: items.length })
  })

  it.each([
    ['a click', [{ click: { x: 1, y: 1 } }]],
    ['a press on an element', [{ press: { role: 'menu bar item', name: 'File' } }]],
    ['a triple_click', [{ triple_click: { x: 1, y: 1 } }]],
  ])('lists invoke_menu for %s: the driver sends a failed click on the menu bar there', (_, items) => {
    expect(steps(...items).steps).toContain('invoke_menu')
  })

  it.each([
    ['a check-only step', [{ wait_for: { text: 'Saved' } }]],
    ['a typed step', [{ type_text: { text: 'x' } }]],
    ['a step that names its target', [{ click: { app: 'TextEdit', role: 'button', name: 'OK' } }]],
  ])('lists the driver’s own reads for %s: lookups, checks and the read after a failed step', (_, items) => {
    expect(steps(...items).steps).toEqual(expect.arrayContaining(ALWAYS))
  })

  it('counts observe as a get_window_state', () => {
    expect(shapeOf('run_steps', { steps: [{ click: {} }], observe: {} })).toEqual({ steps: needs('click'), stepCount: 1 })
    expect(shapeOf('run_steps', { steps: [{ type_text: {} }], observe: false })).toEqual({ steps: needs('type_text'), stepCount: 1 })
  })

  it.each([
    ['no steps', { steps: [] }],
    ['65 steps', { steps: Array.from({ length: 65 }, () => ({ click: {} })) }],
    ['steps not a list', { steps: { click: {} } }],
    ['a key the batch does not take', { steps: [{ click: {} }], script: 'x' }],
    ['a reserved key', { steps: [{ click: {} }], _public_session_label: 'x' }],
    ['observe not an object', { steps: [{ click: {} }], observe: 'all' }],
    ['a step not an object', { steps: ['click'] }],
    ['two actions in one step', { steps: [{ click: {}, type_text: {} }] }],
    ['fields beside tool and args', { steps: [{ tool: 'click', args: {}, x: 1 }] }],
    ['args without tool', { steps: [{ args: { x: 1 } }] }],
    ['shorthand with args', { steps: [{ click: { x: 1 }, args: {} }] }],
    ['tool not a string', { steps: [{ tool: 7 }] }],
    ['args not an object', { steps: [{ tool: 'click', args: [1, 2] }] }],
    ['an empty step', { steps: [{}] }],
    ['a tool the batch does not run', { steps: [{ tool: 'run_script', args: {} }] }],
    ['an alias in another case', { steps: [{ tool: 'Type', args: {} }] }],
    ['launch_app in a batch', { steps: [{ launch_app: { bundle_id: 'com.apple.TextEdit' } }] }],
    ['a read with a check', { steps: [{ tool: 'get_window_state', expect: { text: 'x' } }] }],
    ['arguments not an object', [1, 2]],
  ])('refuses %s as a form it does not read', (_, args) => {
    expect(shapeOf('run_steps', args)).toEqual({ form: 'unknown' })
  })

  it.each([
    [{ bundle_id: 'com.apple.TextEdit' }, 'ok'],
    [{ name: 'TextEdit' }, 'ok'],
    [{ name: 'Calculator.app' }, 'ok'],
    [{ bundle_id: 'com.apple.TextEdit', urls: ['/tmp/x.txt'] }, 'refused'],
    [{ bundle_id: 'com.apple.TextEdit', additional_arguments: ['--x'] }, 'refused'],
    [{ bundle_id: 'com.apple.TextEdit', session: 's' }, 'refused'],
    [{ name: '/System/Applications/TextEdit.app' }, 'refused'],
    [{ name: '' }, 'refused'],
    [{ name: 'a\nb' }, 'refused'],
    [{ bundle_id: 'com.apple.TextEdit; rm' }, 'refused'],
    [{ bundle_id: 7 }, 'refused'],
    [{}, 'refused'],
  ])('reads launch_app %j as %s', (args, launch) => {
    expect(shapeOf('launch_app', args).launch).toBe(launch)
  })

  it('names pids, Latch and a screenshot written to a file, wherever they are', () => {
    expect(shapeOf('click', { pid: 777, window_id: 1 })).toEqual({ pids: [777] })
    expect(shapeOf('click', { pid: '777', window_id: 1 })).toEqual({ pids: [777] })
    expect(shapeOf('click', { pid: '+777' })).toEqual({ pids: [777] })
    expect(shapeOf('click', { pid: '\t777\n' })).toEqual({ pids: [777] })
    expect(shapeOf('launch_app', { name: 'app.latch.desktop' })).toMatchObject({ launch: 'ok', latchName: true })
    expect(shapeOf('click', { app: 'app.latch.desktop' })).toMatchObject({ latchName: true })
    expect(shapeOf('click', { window: 'notes.latch.txt' })).toEqual({})
    expect(shapeOf('run_steps', { steps: [{ click: { pid: ' 777 ' } }] })).toMatchObject({ pids: [777] })
    expect(shapeOf('get_window_state', { pid: 1, screenshot_out_file: '/tmp/x.png' })).toEqual({ pids: [1], screenshotFile: true })
    expect(shapeOf('run_steps', { steps: [{ click: { app: 'Latch' } }] })).toMatchObject({ latchName: true })
    expect(shapeOf('run_steps', { app: 'latch', steps: [{ click: {} }] })).toMatchObject({ latchName: true })
    expect(shapeOf('run_steps', { steps: [{ click: {}, expect: { window: 'Latch' } }] })).toMatchObject({ latchName: true })
    expect(shapeOf('run_steps', { steps: [{ tool: 'click', pid: 777 }], observe: { pid: 778 } })).toMatchObject({ pids: [777, 778] })
    expect(shapeOf('run_steps', { steps: [{ click: {} }], observe: { screenshot_out_file: '/tmp/x' } })).toMatchObject({
      screenshotFile: true,
    })
    expect(shapeOf('launch_app', { bundle_id: 'app.latch.desktop' })).toMatchObject({ launch: 'ok', latchName: true })
    expect(shapeOf('launch_app', { name: 'Latch' })).toMatchObject({ latchName: true })
    // A window or app whose name only contains the word is not Latch.
    expect(shapeOf('click', { app: 'TextEdit', window: 'latch-notes.txt' })).toEqual({})
  })

  it('keeps what an unread batch names, so a call at Latch is refused as one', () => {
    expect(shapeOf('run_steps', { steps: [{ set_window_frame: { pid: 777, window_id: 22, minimized: true } }] })).toEqual({
      pids: [777],
      form: 'unknown',
    })
  })

  it('refuses arguments too deep or too many to read', () => {
    let deep: unknown = {}
    for (let level = 0; level < 12; level++) deep = { a: deep }
    expect(shapeOf('click', deep)).toEqual({ form: 'unknown' })
    expect(shapeOf('click', { list: Array.from({ length: 5000 }, () => 1) })).toEqual({ form: 'unknown' })
    expect(shapeOf('click', 'x')).toEqual({ form: 'unknown' })
    expect(shapeOf('click', undefined)).toEqual({})
  })

  it('gives only enumerations and numbers: no value the agent typed', () => {
    const shape = shapeOf('run_steps', {
      steps: [{ type_text: { text: 'my secret words' } }, { tool: 'click', args: { name: 'Pay now' } }],
      observe: { query: 'balance' },
    })
    expect(JSON.stringify(shape)).not.toMatch(/secret|Pay now|balance/u)
  })
})
