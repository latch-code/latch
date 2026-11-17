import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import {
  AppWindow,
  Camera,
  Circle,
  Hand,
  House,
  Keyboard,
  LayoutGrid,
  Link,
  Lock,
  Minus,
  Moon,
  PenLine,
  Plus,
  Power,
  RotateCcw,
  RotateCw,
  ScrollText,
  Smartphone,
  Square,
  Sun,
} from 'lucide-react'
import { Button, Icon, IconButton, Menu, Spinner, StatusWord } from '@latch/ui'
import type {
  SimulatorAppView,
  SimulatorControlView,
  SimulatorInputEvent,
  SimulatorInputOwner,
  SimulatorPrivacyAction,
  SimulatorPrivacyService,
} from '@latch/protocol'
import { AgentsGlyph } from '../../agents/AgentAvatar.tsx'
import { ApiError, api, errorMessage } from '../../core/api.ts'
import { currentShell } from '../../core/shell.ts'
import { VisibleText } from '../../components/VisibleText.tsx'
import { DeviceAnnotate, type AnnotateImage } from './DeviceAnnotate.tsx'
import { DeviceApps, SERVICE_LABELS } from './DeviceApps.tsx'
import { DeviceLogs } from './DeviceLogs.tsx'
import { DeviceScreen, type LiveState } from './DeviceScreen.tsx'
import { InputSender, deviceInput, inputReason, parseControl, writtenTouch } from './live.ts'
import { NewDeviceDialog } from './NewDeviceDialog.tsx'
import {
  frameDelay,
  LIST_EVERY_MS,
  chooseDevice,
  clock,
  deviceLabel,
  isEditable,
  panelShortcut,
  parseApps,
  parseOrientation,
  parseRecording,
  parseSimulators,
  shotName,
  sortDevices,
  type SimulatorList,
} from './model.ts'
import { fitScale, readZoom, screenSize, writeZoom, zoomIn, zoomLabel, zoomOut, type Zoom } from './zoom.ts'

export interface DevicePanelProps {
  /** Whether the panel is on screen: frames and the list are read only then. */
  shown: boolean
  /** Puts a picture in the draft as an attachment; absent while the draft takes none. */
  onAttach?: ((files: File[]) => void) | undefined
}

type Pending = 'boot' | 'shutdown' | 'appearance' | 'shot' | 'url' | 'hub' | 'rotate' | 'record' | 'annotate'

const INPUT_OWNER = {
  none: { icon: Circle, label: '空闲', title: '模拟器输入空闲' },
  you: { icon: Hand, label: '你', title: '你已接管模拟器输入' },
  other: { icon: AppWindow, label: '本机', title: '其他本机窗口已接管模拟器输入' },
  agent: { icon: AgentsGlyph, label: 'Agent', title: 'Agent 正在向模拟器输入' },
} as const

/** Hands a file to the person: into the draft when it takes one, else as a download. */
function deliver(file: File, onAttach: DevicePanelProps['onAttach']): void {
  if (onAttach) {
    onAttach([file])
    return
  }
  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = file.name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

/**
 * 设备: this Mac's iOS simulators through the Host's simctl and devicectl routes. The chosen device's live picture
 * (latch-simulator's stream), or screenshots refreshed while the panel shows when there is none, at the panel's fit or a
 * chosen zoom. Pointer, wheel, keys, Home and Lock go to the device through the person's idb_companion once they act on
 * it (taking control, recorded once); where that is unavailable the state says why and Device Hub stays the way to tap.
 * The bottom bar has the device's tools; each button is one Host action, recorded there.
 */
export function DevicePanel({ shown, onAttach }: DevicePanelProps) {
  const [list, setList] = useState<SimulatorList | null>(null)
  const [chosen, setChosen] = useState<string>()
  const [pending, setPending] = useState<Pending>()
  const [failure, setFailure] = useState<{ udid: string; text: string }>()
  const [frame, setFrame] = useState<{ udid: string; url: string; width: number; height: number }>()
  const [frameMs, setFrameMs] = useState<number>()
  /** Why the last frames did not come, once two in a row failed; the panel then asks less often. */
  const [frameFailure, setFrameFailure] = useState<string>()
  const [appearance, setAppearance] = useState<'light' | 'dark'>()
  const [address, setAddress] = useState<string>()
  const [rotatable, setRotatable] = useState(false)
  const [recording, setRecording] = useState<{ udid: string; since: number }>()
  const [now, setNow] = useState(() => Date.now())
  const [annotating, setAnnotating] = useState<AnnotateImage>()
  const [pane, setPane] = useState<'apps' | 'logs'>()
  const [apps, setApps] = useState<SimulatorAppView[]>()
  const [appBusy, setAppBusy] = useState<string>()
  const [creating, setCreating] = useState(false)
  const [zoom, setZoom] = useState<Zoom>('fit')
  const [box, setBox] = useState({ width: 0, height: 0 })
  /** The live picture of a device: connecting, on, or unavailable (then screenshots). */
  const [live, setLive] = useState<{ udid: string; state: LiveState; reason?: string; size?: { width: number; height: number } }>()
  const [liveOwner, setLiveOwner] = useState<{ udid: string; value: SimulatorInputOwner }>()
  /** What input can do on the device, once the person took control of it. */
  const [control, setControl] = useState<{ udid: string; view: SimulatorControlView }>()
  const [inputFailure, setInputFailure] = useState<{ udid: string; text: string; textOnly?: true }>()
  const [keysOn, setKeysOn] = useState(false)
  const addressInput = useRef<HTMLInputElement>(null)
  const canvas = useRef<HTMLDivElement>(null)
  const devices = list ? sortDevices(list.devices) : []
  const device = chooseDevice(devices, chosen)
  const udid = device?.udid
  const running = device?.state === 'booted'
  const abilities = list?.abilities ?? { rotate: false, record: false, logs: false }
  const desktop = currentShell() !== null
  const pixelRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1

  const read = async () => {
    try {
      setList(parseSimulators(await api<unknown>('simulators', { timeoutMs: 30_000 })))
    } catch (error) {
      setList(previous => previous ?? { xcode: true, devices: [], abilities: { rotate: false, record: false, logs: false } })
      setFailure({ udid: '', text: errorMessage(error) })
    }
  }

  useEffect(() => {
    if (!shown) return
    void read()
    const timer = setInterval(() => void read(), LIST_EVERY_MS)
    return () => clearInterval(timer)
  }, [shown])

  // The zoom this browser kept for the device.
  useEffect(() => {
    setZoom(udid ? readZoom(udid) : 'fit')
  }, [udid])

  useLayoutEffect(() => {
    const element = canvas.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setBox({ width: entry.contentRect.width - 32, height: entry.contentRect.height - 32 })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [list !== null && list.xcode])

  const liveOff = live !== undefined && live.udid === udid && live.state === 'unavailable'
  // Screenshots only while shown, the device runs and there is no live picture: the next once the last arrived.
  useEffect(() => {
    if (!shown || !udid || !running || !liveOff) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let last: string | undefined
    const times: number[] = []
    let failures = 0
    const next = async () => {
      const started = performance.now()
      try {
        const bytes = await api<ArrayBuffer>(`simulators/${udid}/frame`, {
          response: 'bytes',
          signal: controller.signal,
          timeoutMs: 30_000,
        })
        if (controller.signal.aborted) return
        const blob = new Blob([bytes], { type: 'image/jpeg' })
        const bitmap = await createImageBitmap(blob).catch(() => undefined)
        const url = URL.createObjectURL(blob)
        if (last) URL.revokeObjectURL(last)
        last = url
        setFrame({ udid, url, width: bitmap?.width ?? 0, height: bitmap?.height ?? 0 })
        bitmap?.close()
        times.push(performance.now() - started)
        if (times.length > 10) times.shift()
        setFrameMs(Math.round(times.reduce((sum, value) => sum + value, 0) / times.length))
        failures = 0
        setFrameFailure(undefined)
      } catch (error) {
        if (controller.signal.aborted) return
        failures++
        if (failures >= 2) setFrameFailure(errorMessage(error))
      }
      timer = setTimeout(() => void next(), frameDelay(failures))
    }
    void next()
    return () => {
      controller.abort()
      if (timer) clearTimeout(timer)
      if (last) URL.revokeObjectURL(last)
      setFrame(undefined)
      setFrameFailure(undefined)
    }
  }, [shown, udid, running, liveOff])

  // A new device, or the same one started again: its live picture is tried first.
  useEffect(() => {
    setLive(undefined)
  }, [udid, running, shown])

  // ── Input: control is taken when the person first acts on the device, and given back when the panel leaves it ──

  const takingRef = useRef<{ udid: string; waiting: SimulatorInputEvent[] } | undefined>(undefined)
  const controlRef = useRef(control)
  controlRef.current = control
  const sender = useRef<{ udid: string; sender: InputSender } | undefined>(undefined)
  const feedback = useRef(new WeakMap<SimulatorInputEvent, () => void>())

  const senderFor = (target: string): InputSender => {
    if (sender.current?.udid === target) return sender.current.sender
    const created: InputSender = new InputSender(
      async events => {
        if (sender.current?.sender !== created) return
        const receipt = await api<unknown>(`simulators/${target}/input`, { method: 'POST', body: { events }, timeoutMs: 15_000 })
        if (sender.current?.sender !== created) return
        const touch = writtenTouch(receipt, events)
        if (touch) feedback.current.get(touch)?.()
      },
      error => {
        if (sender.current?.sender !== created) return
        // Text the device's keyboard would change is refused whole; control stays.
        const code = error instanceof ApiError ? error.code : undefined
        if (code === 'simulator-text-unavailable' || code === 'simulator-text-unsupported') {
          setInputFailure({ udid: target, text: errorMessage(error), textOnly: true })
          return
        }
        setInputFailure({ udid: target, text: errorMessage(error) })
        // Control lapsed (the Host restarted or the companion stopped): the next touch takes it again.
        sender.current = undefined
        controlRef.current = undefined
        setControl(current => (current?.udid === target ? undefined : current))
      },
    )
    sender.current = { udid: target, sender: created }
    return created
  }

  const sendInput = (event: SimulatorInputEvent, written?: () => void) => {
    if (!udid || !shown || !running) return
    const target = udid
    if (written) feedback.current.set(event, written)
    const held = controlRef.current
    if (held?.udid === target) {
      const kind =
        event.type === 'touch'
          ? held.view.touch
          : event.type === 'key'
            ? held.view.keys
            : event.type === 'text'
              ? held.view.text
              : held.view.buttons
      if (event.type === 'text') setInputFailure(current => (current?.textOnly ? undefined : current))
      if (kind.available) senderFor(target).send(event)
      // Not sent, and said so: never dropped without a word.
      else setInputFailure({ udid: target, text: inputReason(kind), ...(event.type === 'text' ? { textOnly: true as const } : {}) })
      return
    }
    if (takingRef.current?.udid === target) {
      takingRef.current.waiting.push(event)
      return
    }
    const taking = { udid: target, waiting: [event] }
    takingRef.current = taking
    setInputFailure(undefined)
    void api<unknown>(`simulators/${target}/control`, { method: 'POST', body: { action: 'take' }, timeoutMs: 45_000 })
      .then(answer => {
        if (takingRef.current !== taking) {
          if (takingRef.current?.udid !== target && controlRef.current?.udid !== target)
            void api(`simulators/${target}/control`, { method: 'POST', body: { action: 'release' } }).catch(() => undefined)
          return
        }
        const view = parseControl(answer)
        controlRef.current = { udid: target, view }
        setControl({ udid: target, view })
        takingRef.current = undefined
        for (const waiting of taking.waiting) sendInput(waiting)
      })
      .catch(error => {
        if (takingRef.current !== taking) return
        takingRef.current = undefined
        setInputFailure({ udid: target, text: errorMessage(error) })
      })
  }

  // The panel hidden, another device chosen or the device stopped: control is given back.
  useEffect(() => {
    if (!shown || !udid || !running) return
    const target = udid
    return () => {
      sender.current = undefined
      takingRef.current = undefined
      controlRef.current = undefined
      setControl(undefined)
      setInputFailure(undefined)
      setKeysOn(false)
      void api(`simulators/${target}/control`, { method: 'POST', body: { action: 'release' } }).catch(() => {})
    }
  }, [shown, udid, running])

  // Keys to the device while the toggle is on and focus is in the panel, never while a field of Latch's has focus.
  const section = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!keysOn || !running) return
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (isEditable(event.target) || !(event.target instanceof Node) || !section.current?.contains(event.target)) return
      const input = deviceInput(event)
      if (!input) return
      event.preventDefault()
      event.stopPropagation()
      if (input === 'refused') {
        if (udid) setInputFailure({ udid, text: '只能逐键输入可打印的 ASCII 字符；中文等请在 Device Hub 里输入', textOnly: true })
        return
      }
      sendInput(input)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  useEffect(() => {
    setAppearance(undefined)
    if (!shown || !udid || !running) return
    const controller = new AbortController()
    void api<{ appearance: 'light' | 'dark' | null }>(`simulators/${udid}/appearance`, { signal: controller.signal })
      .then(answer => {
        if (!controller.signal.aborted && answer.appearance) setAppearance(answer.appearance)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [shown, udid, running])

  // Whether devicectl can turn this device: asked again a few times, since right after a boot it may not say yet.
  useEffect(() => {
    setRotatable(false)
    if (!shown || !udid || !running || !abilities.rotate) return
    const controller = new AbortController()
    let tries = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const ask = () => {
      void api<unknown>(`simulators/${udid}/orientation`, { signal: controller.signal, timeoutMs: 30_000 })
        .then(answer => {
          if (controller.signal.aborted) return
          const { supported } = parseOrientation(answer)
          setRotatable(supported)
          if (!supported && ++tries < 6) timer = setTimeout(ask, 5_000)
        })
        .catch(() => {})
    }
    ask()
    return () => {
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [shown, udid, running, abilities.rotate])

  const fail = (text: string) => udid && setFailure({ udid, text })

  const act = async (kind: Pending, path: string, body?: object) => {
    if (!udid) return
    setPending(kind)
    setFailure(undefined)
    try {
      await api(`simulators/${udid}/${path}`, { method: 'POST', ...(body ? { body } : {}), timeoutMs: kind === 'boot' ? 150_000 : 60_000 })
      return true
    } catch (error) {
      setFailure({ udid, text: errorMessage(error) })
      return false
    } finally {
      setPending(undefined)
      void read()
    }
  }

  const takePicture = async (): Promise<ArrayBuffer | undefined> => {
    if (!udid) return
    try {
      return await api<ArrayBuffer>(`simulators/${udid}/screenshot`, { method: 'POST', response: 'bytes', timeoutMs: 30_000 })
    } catch (error) {
      setFailure({ udid, text: errorMessage(error) })
      return
    }
  }

  const screenshot = async () => {
    if (!udid || !device || pending) return
    setPending('shot')
    setFailure(undefined)
    const bytes = await takePicture()
    if (bytes) deliver(new File([bytes], shotName(device), { type: 'image/png' }), onAttach)
    setPending(undefined)
  }

  const annotate = async () => {
    if (!udid || !device || pending || !onAttach) return
    setPending('annotate')
    setFailure(undefined)
    const bytes = await takePicture()
    setPending(undefined)
    if (!bytes) return
    const blob = new Blob([bytes], { type: 'image/png' })
    const bitmap = await createImageBitmap(blob).catch(() => undefined)
    if (!bitmap) {
      fail('没有读懂截图')
      return
    }
    setAnnotating({ url: URL.createObjectURL(blob), width: bitmap.width, height: bitmap.height, name: shotName(device) })
    bitmap.close()
  }

  const closeAnnotate = () => {
    if (annotating) URL.revokeObjectURL(annotating.url)
    setAnnotating(undefined)
  }

  const rotate = async (direction: 'left' | 'right') => {
    if (!rotatable || pending) return
    await act('rotate', 'rotate', { direction })
  }

  // ── Recording: started and stopped here, ended by the Host at a minute or 25 MB, thrown away if the panel goes ──

  /** A take in flight: the timer's poll and the button must not both take it. */
  const taking = useRef(false)
  const takeRecording = useCallback(async (target: string, name: string) => {
    if (taking.current) return
    taking.current = true
    setPending('record')
    try {
      const bytes = await api<ArrayBuffer>(`simulators/${target}/record`, {
        method: 'POST',
        body: { action: 'stop' },
        response: 'bytes',
        timeoutMs: 60_000,
      })
      // A movie is saved, not put in the draft: most model services take no video, and the draft's limits would refuse it.
      deliver(new File([bytes], name, { type: 'video/mp4' }), undefined)
    } catch (error) {
      setFailure({ udid: target, text: errorMessage(error) })
    } finally {
      taking.current = false
      setRecording(undefined)
      setPending(undefined)
    }
  }, [])

  const record = async () => {
    if (!udid || !device || !abilities.record) return
    if (recording) {
      await takeRecording(recording.udid, shotName(device, new Date(recording.since), 'mp4'))
      return
    }
    if (pending) return
    setPending('record')
    setFailure(undefined)
    try {
      const view = parseRecording(
        await api<unknown>(`simulators/${udid}/record`, { method: 'POST', body: { action: 'start' }, timeoutMs: 30_000 }),
      )
      if (view.state === 'recording') setRecording({ udid, since: Date.now() - (view.seconds ?? 0) * 1000 })
    } catch (error) {
      setFailure({ udid, text: errorMessage(error) })
    } finally {
      setPending(undefined)
    }
  }

  // The timer, and whether the Host ended it by itself (then it is taken at once).
  useEffect(() => {
    if (!recording || !device) return
    const target = recording.udid
    const name = shotName(device, new Date(recording.since), 'mp4')
    const timer = setInterval(() => {
      setNow(Date.now())
      void api<unknown>(`simulators/${target}/record`, { timeoutMs: 10_000 })
        .then(answer => {
          const view = parseRecording(answer)
          if (view.state === 'ready') void takeRecording(target, name)
          else if (view.state === 'none') {
            setRecording(undefined)
            setFailure({ udid: target, text: '录屏已结束' })
          }
        })
        .catch(() => {})
    }, 1_000)
    return () => clearInterval(timer)
  }, [recording, device?.udid, takeRecording])

  // Hidden, another device chosen or the device stopped: a recording is thrown away.
  useEffect(() => {
    if (!recording) return
    if (shown && recording.udid === udid && running) return
    void api(`simulators/${recording.udid}/record`, { method: 'POST', body: { action: 'discard' } }).catch(() => {})
    setRecording(undefined)
  }, [shown, udid, running, recording])

  // ── Apps ──

  const readApps = async () => {
    if (!udid) return
    setApps(undefined)
    try {
      setApps(parseApps(await api<unknown>(`simulators/${udid}/apps`, { timeoutMs: 30_000 })))
    } catch (error) {
      setApps([])
      setFailure({ udid, text: errorMessage(error) })
    }
  }

  useEffect(() => {
    setApps(undefined)
    if ((pane === 'apps' || pane === 'logs') && udid && running && shown) void readApps()
  }, [pane, udid, running, shown])

  useEffect(() => {
    if (!running) setPane(undefined)
  }, [running])

  const appAction = async (app: SimulatorAppView, path: 'launch' | 'terminate', body: object) => {
    if (!udid) return
    setAppBusy(app.bundleId)
    setFailure(undefined)
    try {
      await api(`simulators/${udid}/${path}`, { method: 'POST', body, timeoutMs: 30_000 })
    } catch (error) {
      setFailure({ udid, text: errorMessage(error) })
    } finally {
      setAppBusy(undefined)
    }
  }

  const privacy = async (app: SimulatorAppView, action: SimulatorPrivacyAction, service: SimulatorPrivacyService) => {
    if (!udid) return
    setAppBusy(app.bundleId)
    setFailure(undefined)
    try {
      await api(`simulators/${udid}/privacy`, { method: 'POST', body: { action, service, bundleId: app.bundleId }, timeoutMs: 30_000 })
    } catch (error) {
      setFailure({ udid, text: `${SERVICE_LABELS[service]}：${errorMessage(error)}` })
    } finally {
      setAppBusy(undefined)
    }
  }

  const openAddress = async (event: FormEvent) => {
    event.preventDefault()
    const url = address?.trim()
    if (!url) return
    if (await act('url', 'open-url', { url })) setAddress(undefined)
  }

  useEffect(() => {
    if (address !== undefined) addressInput.current?.focus()
  }, [address !== undefined])

  const changeZoom = (next: Zoom) => {
    setZoom(next)
    if (udid) writeZoom(udid, next)
  }

  /** ⌘S, ⇧⌘R, ⌘← and ⌘→ while focus is in the panel; only in the desktop app, where the panel exists, never in a field. */
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!desktop || !running || annotating) return
    const shortcut = panelShortcut({
      key: event.key,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      editable: isEditable(event.target),
    })
    if (!shortcut) return
    if ((shortcut === 'rotate-left' || shortcut === 'rotate-right') && !rotatable) return
    if (shortcut === 'record' && !abilities.record) return
    event.preventDefault()
    event.stopPropagation()
    if (shortcut === 'shot') void screenshot()
    else if (shortcut === 'record') void record()
    else void rotate(shortcut === 'rotate-left' ? 'left' : 'right')
  }

  if (list === null)
    return (
      <section className="sim-panel" aria-label="设备" aria-busy="true">
        <div className="sim-canvas" />
      </section>
    )
  if (!list.xcode)
    return (
      <section className="sim-panel" aria-label="设备">
        <div className="sim-canvas sim-quiet">
          <span>未安装 Xcode</span>
        </div>
      </section>
    )

  const failed =
    (failure && (failure.udid === '' || failure.udid === udid) ? failure.text : undefined) ?? (running ? frameFailure : undefined)
  const liveHere = live?.udid === udid ? live : undefined
  const liveOn = running && liveHere?.state === 'live'
  // Running, but no picture yet: still starting as far as anyone can see.
  const pictured = liveOn || (running && frame !== undefined && frame.udid === udid)
  const owner = (liveOff ? device?.inputOwner : liveOwner?.udid === udid ? liveOwner?.value : undefined) ?? 'none'
  const ownerLabel = INPUT_OWNER[owner]
  const controlHere = control && control.udid === udid ? control.view : undefined
  const inputFailed = inputFailure && inputFailure.udid === udid && !inputFailure.textOnly ? inputFailure.text : undefined
  const textFailed = inputFailure && inputFailure.udid === udid && inputFailure.textOnly ? inputFailure.text : undefined
  const inputOff = controlHere && !controlHere.touch.available ? inputReason(controlHere.touch) : inputFailed
  const booting = pending === 'boot' || device?.state === 'booting' || (running && !pictured && !failed)
  const stopping = pending === 'shutdown' || device?.state === 'shutting-down'
  const agent = device?.agent === true || (running && list.agentUnnamed === true)
  const recordingHere = recording !== undefined && recording.udid === udid
  const state = failed ? (
    <StatusWord tone="failed" title={failed}>
      失败
    </StatusWord>
  ) : booting ? (
    <StatusWord tone="running">启动中</StatusWord>
  ) : stopping ? (
    <StatusWord tone="running">关机中</StatusWord>
  ) : recordingHere ? (
    <StatusWord tone="running" title="最长 1 分钟或 25 MB · 关闭面板即丢弃">
      录屏 {clock((now - recording.since) / 1000)}
    </StatusWord>
  ) : pictured && agent ? (
    <StatusWord tone="running" title="一个会话的 Agent 正经 Xcode 的设备工具使用它">
      Agent 正在使用
    </StatusWord>
  ) : pictured && textFailed ? (
    <StatusWord tone="warn" title={textFailed}>
      文字未输入
    </StatusWord>
  ) : pictured && inputOff ? (
    <StatusWord tone="warn" title={`${inputOff} · 可在 Device Hub 中点按`}>
      输入不可用
    </StatusWord>
  ) : pictured ? (
    <StatusWord
      tone="done"
      title={
        liveOn
          ? `实时画面 · 两指不可用：${inputReason(controlHere?.twoFingers ?? { available: false, reason: 'single-touch' })}`
          : `截图画面${liveHere?.reason ? ` · ${liveHere.reason}` : ''}`
      }>
      运行中
    </StatusWord>
  ) : device ? (
    <StatusWord tone="neutral">未启动</StatusWord>
  ) : null

  const natural =
    liveOn && liveHere?.size
      ? liveHere.size
      : frame && frame.udid === udid
        ? { width: frame.width, height: frame.height }
        : { width: 0, height: 0 }
  const fit = fitScale(natural, box, pixelRatio)
  const size = screenSize(zoom, natural, box, pixelRatio)
  const busy = pending !== undefined
  const tools = running && !annotating

  return (
    <section ref={section} className="sim-panel" aria-label="设备" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="sim-toolbar" role="toolbar" aria-label="设备">
        <Menu
          label="选择设备"
          selection
          sections={[
            {
              id: 'devices',
              items: devices.map(item => ({
                id: item.udid,
                label: item.name,
                meta: item.state === 'booted' ? `${item.os} · 运行中` : item.os,
                checked: item.udid === udid,
                onSelect: () => {
                  setChosen(item.udid)
                  setFailure(undefined)
                },
              })),
            },
            { id: 'new', items: [{ id: 'new', label: '新建设备…', icon: Plus, onSelect: () => setCreating(true) }] },
          ]}
          trigger={props => (
            <Button {...props} size="xs" variant="ghost" icon={Smartphone} className="sim-picker">
              {device ? <VisibleText text={deviceLabel(device)} /> : '选择设备'}
              {running && <span className="sim-on" aria-label="运行中" role="img" />}
            </Button>
          )}
        />
        <span className="sim-state">{state}</span>
        <span className="sim-spacer" />
        {pictured && !annotating && (
          <span className="sim-zoom" role="group" aria-label="缩放">
            <IconButton size="xs" icon={Minus} label="缩小" disabled={zoom === 'fit'} onClick={() => changeZoom(zoomOut(zoom, fit))} />
            <button
              type="button"
              className="sim-zoom-value"
              title={zoom === 'fit' ? '切到 1:1（一个设备像素对一个屏幕像素）' : '适应面板'}
              aria-label={zoom === 'fit' ? '缩放：适应，切到 1:1' : `缩放：${zoomLabel(zoom, fit)}，切到适应`}
              onClick={() => changeZoom(zoom === 'fit' ? 1 : 'fit')}>
              {zoom === 'fit' ? '适应' : zoomLabel(zoom, fit)}
            </button>
            <IconButton size="xs" icon={Plus} label="放大" disabled={zoom === 2} onClick={() => changeZoom(zoomIn(zoom, fit))} />
          </span>
        )}
        <IconButton
          size="xs"
          icon={Power}
          label={running ? '关机' : '启动'}
          tooltip={running && !device?.ours ? '只关闭 Latch 启动的设备' : running ? '关机' : '启动'}
          pressed={running}
          disabled={!device || busy || booting || stopping || (running && !device.ours)}
          onClick={() => void (running ? act('shutdown', 'shutdown') : act('boot', 'boot'))}
        />
      </div>
      {address !== undefined && (
        <form className="sim-address" onSubmit={event => void openAddress(event)}>
          <input
            ref={addressInput}
            type="text"
            aria-label="设备上打开的地址"
            placeholder="https://… 或 myapp://…"
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            value={address}
            onChange={event => setAddress(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') setAddress(undefined)
            }}
          />
        </form>
      )}
      {pictured && desktop && !annotating && (owner !== 'none' || !inputOff) && (
        <div className="sim-input-status">
          <span className="sim-input-owner" data-owner={owner} role="status" aria-label={ownerLabel.title}>
            <Icon icon={ownerLabel.icon} size={12} />
            {ownerLabel.label}
          </span>
        </div>
      )}
      <div
        ref={canvas}
        className="sim-canvas"
        data-running={running ? '' : undefined}
        data-frame-ms={frameMs}
        data-zoom={zoom === 'fit' ? 'fit' : String(zoom)}
        data-pane={pane}>
        {annotating ? (
          <DeviceAnnotate
            image={annotating}
            onCancel={closeAnnotate}
            onFailure={fail}
            onDone={file => {
              onAttach?.([file])
              closeAnnotate()
            }}
          />
        ) : running && shown && udid && device && !liveOff ? (
          <DeviceScreen
            key={udid}
            udid={udid}
            name={device.name}
            zoom={zoom}
            box={box}
            pixelRatio={pixelRatio}
            onState={(state, detail) =>
              setLive({ udid, state, ...(detail?.reason ? { reason: detail.reason } : {}), ...(detail?.size ? { size: detail.size } : {}) })
            }
            onOwner={value => setLiveOwner(value ? { udid, value } : undefined)}
            onInput={desktop ? sendInput : undefined}
          />
        ) : running && frame && frame.udid === udid ? (
          <img
            className="sim-screen"
            src={frame.url}
            alt={device ? `${device.name} 的画面` : '设备画面'}
            draggable={false}
            style={
              zoom === 'fit' || natural.width === 0
                ? undefined
                : { width: size.width, height: size.height, maxWidth: 'none', maxHeight: 'none' }
            }
          />
        ) : running ? (
          <Spinner size={14} />
        ) : (
          <ul className="sim-list" aria-label="设备">
            {devices.length === 0 && <li className="sim-quiet">没有模拟器</li>}
            {devices.map(item => {
              const selected = item.udid === udid
              return (
                <li key={item.udid} data-selected={selected ? '' : undefined}>
                  <button type="button" className="sim-row" aria-pressed={selected} onClick={() => setChosen(item.udid)}>
                    <Icon icon={Smartphone} size={14} />
                    <span className="sim-row-name">
                      <VisibleText text={item.name} />
                    </span>
                    <span className="sim-row-os">{item.os}</span>
                    {item.state === 'booted' && <span className="sim-on" aria-label="运行中" role="img" />}
                  </button>
                  <span className="sim-row-action" aria-hidden={!selected}>
                    {selected && item.state === 'shutdown' && (
                      <Button size="xs" variant="ghost" disabled={busy} onClick={() => void act('boot', 'boot')}>
                        {pending === 'boot' ? <Spinner size={12} /> : '启动'}
                      </Button>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      {pane === 'apps' && udid && running && (
        <DeviceApps
          apps={apps}
          busy={appBusy}
          onLaunch={app => void appAction(app, 'launch', { bundleId: app.bundleId })}
          onTerminate={app => void appAction(app, 'terminate', { bundleId: app.bundleId })}
          onPrivacy={(app, action, service) => void privacy(app, action, service)}
          onReload={() => void readApps()}
          onClose={() => setPane(undefined)}
        />
      )}
      {pane === 'logs' && udid && running && <DeviceLogs udid={udid} apps={apps ?? []} onClose={() => setPane(undefined)} />}
      <div className="sim-foot" role="toolbar" aria-label="设备工具">
        {abilities.rotate
          && (['left', 'right'] as const).map(direction => (
            <IconButton
              key={direction}
              size="xs"
              icon={direction === 'left' ? RotateCcw : RotateCw}
              label={direction === 'left' ? '向左旋转' : '向右旋转'}
              tooltip={rotatable ? (direction === 'left' ? '向左转 90°' : '向右转 90°') : '这台设备不能旋转'}
              shortcut={desktop && rotatable ? (direction === 'left' ? '⌘←' : '⌘→') : undefined}
              disabled={!tools || !rotatable || busy}
              busy={pending === 'rotate'}
              onClick={() => void rotate(direction)}
            />
          ))}
        <IconButton
          size="xs"
          icon={Camera}
          label="截图"
          tooltip={onAttach ? '截图放进草稿 · 发送后交给模型服务' : '截图下载到这台电脑'}
          shortcut={desktop ? '⌘S' : undefined}
          disabled={!tools || busy}
          busy={pending === 'shot'}
          onClick={() => void screenshot()}
        />
        {abilities.record && (
          <IconButton
            size="xs"
            icon={recordingHere ? Square : Circle}
            label={recordingHere ? '停止录屏' : '录屏'}
            tooltip={recordingHere ? '停止并保存到这台电脑' : '录屏 · 最长 1 分钟或 25 MB · 停止后保存到这台电脑'}
            shortcut={desktop ? '⇧⌘R' : undefined}
            pressed={recordingHere}
            className={recordingHere ? 'sim-recording' : undefined}
            disabled={!tools || (busy && pending !== 'record') || (recording !== undefined && !recordingHere)}
            busy={pending === 'record'}
            onClick={() => void record()}
          />
        )}
        <IconButton
          size="xs"
          icon={House}
          label="主屏幕"
          tooltip={controlHere && !controlHere.buttons.available ? inputReason(controlHere.buttons) : '主屏幕'}
          disabled={!tools || !desktop || (controlHere !== undefined && !controlHere.buttons.available)}
          onClick={() => sendInput({ type: 'button', button: 'home' })}
        />
        <IconButton
          size="xs"
          icon={Lock}
          label="锁屏"
          tooltip={controlHere && !controlHere.buttons.available ? inputReason(controlHere.buttons) : '锁屏键'}
          disabled={!tools || !desktop || (controlHere !== undefined && !controlHere.buttons.available)}
          onClick={() => sendInput({ type: 'button', button: 'lock' })}
        />
        <IconButton
          size="xs"
          icon={Keyboard}
          label="键盘输入到设备"
          tooltip={
            controlHere && !controlHere.keys.available
              ? inputReason(controlHere.keys)
              : controlHere && !controlHere.text.available
                ? `⏎ ⌫ ⇥ ⎋ 与方向键发到设备 · 文字：${inputReason(controlHere.text)}`
                : '按键与 ASCII 文字发到设备 · 文字只在设备的 English (US) 键盘上输入'
          }
          pressed={keysOn}
          disabled={!tools || !desktop || (controlHere !== undefined && !controlHere.keys.available)}
          onClick={() => {
            setKeysOn(value => !value)
            section.current?.querySelector<HTMLElement>('canvas.sim-live')?.focus()
          }}
        />
        <IconButton
          size="xs"
          icon={PenLine}
          label="标注截图"
          tooltip={onAttach ? '截图后标注，再放进草稿' : '现在不能添加附件'}
          disabled={!tools || busy || !onAttach}
          busy={pending === 'annotate'}
          onClick={() => void annotate()}
        />
        <span className="sim-foot-gap" />
        <IconButton
          size="xs"
          icon={LayoutGrid}
          label="App"
          tooltip="设备上的 App：启动、结束、预先授权"
          pressed={pane === 'apps'}
          disabled={!tools}
          onClick={() => setPane(value => (value === 'apps' ? undefined : 'apps'))}
        />
        {abilities.logs && (
          <IconButton
            size="xs"
            icon={ScrollText}
            label="日志"
            tooltip="设备的实时日志 · 只在这里显示，不保存"
            pressed={pane === 'logs'}
            disabled={!tools}
            onClick={() => setPane(value => (value === 'logs' ? undefined : 'logs'))}
          />
        )}
        <IconButton
          size="xs"
          icon={Link}
          label="打开地址"
          tooltip="在设备上打开网址或深链接"
          pressed={address !== undefined}
          disabled={!tools}
          onClick={() => setAddress(value => (value === undefined ? '' : undefined))}
        />
        <IconButton
          size="xs"
          icon={appearance === 'dark' ? Moon : Sun}
          label={appearance === 'dark' ? '外观：深色' : '外观：浅色'}
          tooltip="切换设备的浅色与深色"
          pressed={appearance === 'dark'}
          disabled={!tools || busy}
          onClick={async () => {
            const next = appearance === 'dark' ? 'light' : 'dark'
            if (await act('appearance', 'appearance', { appearance: next })) setAppearance(next)
          }}
        />
        <span className="sim-spacer" />
        <IconButton
          size="xs"
          icon={AppWindow}
          label="在 Device Hub 中打开"
          tooltip="在 Device Hub 里查看和点按"
          disabled={!device || busy}
          onClick={() => void act('hub', 'device-hub')}
        />
      </div>
      <NewDeviceDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={created => {
          setCreating(false)
          setChosen(created)
          void read()
        }}
      />
    </section>
  )
}
