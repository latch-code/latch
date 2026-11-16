import { useEffect, useRef, useState, type FormEvent } from 'react'
import { AppWindow, Camera, Link, Moon, Power, Smartphone, Sun } from 'lucide-react'
import { Button, Icon, IconButton, Menu, Spinner, StatusWord } from '@latch/ui'
import { api, errorMessage } from '../../core/api.ts'
import { VisibleText } from '../../components/VisibleText.tsx'
import {
  frameDelay,
  LIST_EVERY_MS,
  chooseDevice,
  deviceLabel,
  parseSimulators,
  shotName,
  sortDevices,
  type SimulatorList,
} from './model.ts'

export interface DevicePanelProps {
  /** Whether the panel is on screen: frames and the list are read only then. */
  shown: boolean
  /** Puts a picture in the draft as an attachment; absent while the draft takes none. */
  onAttach?: ((files: File[]) => void) | undefined
}

type Pending = 'boot' | 'shutdown' | 'appearance' | 'shot' | 'url' | 'hub'

/**
 * 设备: this Mac's iOS simulators through the Host's simctl routes. A picture of the chosen device, refreshed while the
 * panel shows and the device runs; it is not interactive (tapping is in Device Hub's own window). Each button is one
 * Host action, recorded there.
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
  const addressInput = useRef<HTMLInputElement>(null)
  const devices = list ? sortDevices(list.devices) : []
  const device = chooseDevice(devices, chosen)
  const udid = device?.udid
  const running = device?.state === 'booted'

  const read = async () => {
    try {
      setList(parseSimulators(await api<unknown>('simulators', { timeoutMs: 30_000 })))
    } catch (error) {
      setList(previous => previous ?? { xcode: true, devices: [] })
      setFailure({ udid: '', text: errorMessage(error) })
    }
  }

  useEffect(() => {
    if (!shown) return
    void read()
    const timer = setInterval(() => void read(), LIST_EVERY_MS)
    return () => clearInterval(timer)
  }, [shown])

  // Frames only while shown and the device runs: the next is asked for once the last arrived; nothing when hidden.
  useEffect(() => {
    if (!shown || !udid || !running) return
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
  }, [shown, udid, running])

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

  const screenshot = async () => {
    if (!udid || !device || !onAttach) return
    setPending('shot')
    setFailure(undefined)
    try {
      const bytes = await api<ArrayBuffer>(`simulators/${udid}/screenshot`, { method: 'POST', response: 'bytes', timeoutMs: 30_000 })
      onAttach([new File([bytes], shotName(device), { type: 'image/png' })])
    } catch (error) {
      setFailure({ udid, text: errorMessage(error) })
    } finally {
      setPending(undefined)
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
  // Running, but no picture yet: still starting as far as anyone can see.
  const pictured = running && frame !== undefined && frame.udid === udid
  const booting = pending === 'boot' || device?.state === 'booting' || (running && !pictured && !failed)
  const stopping = pending === 'shutdown' || device?.state === 'shutting-down'
  const agent = device?.agent === true || (running && list.agentUnnamed === true)
  const state = failed ? (
    <StatusWord tone="failed" title={failed}>
      失败
    </StatusWord>
  ) : booting ? (
    <StatusWord tone="running">启动中</StatusWord>
  ) : stopping ? (
    <StatusWord tone="running">关机中</StatusWord>
  ) : pictured && agent ? (
    <StatusWord tone="running" title="一个会话的 Agent 正经 Xcode 的设备工具使用它">
      Agent 正在使用
    </StatusWord>
  ) : pictured ? (
    <StatusWord tone="done">运行中</StatusWord>
  ) : device ? (
    <StatusWord tone="neutral">未启动</StatusWord>
  ) : null

  return (
    <section className="sim-panel" aria-label="设备">
      <div className="sim-toolbar" role="toolbar" aria-label="设备工具">
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
          ]}
          trigger={props => (
            <Button {...props} size="xs" variant="ghost" icon={Smartphone} className="sim-picker">
              {device ? <VisibleText text={deviceLabel(device)} /> : '选择设备'}
              {running && <span className="sim-on" aria-label="运行中" role="img" />}
            </Button>
          )}
        />
        <span className="sim-spacer" />
        <IconButton
          size="xs"
          icon={appearance === 'dark' ? Moon : Sun}
          label={appearance === 'dark' ? '外观：深色' : '外观：浅色'}
          tooltip="切换设备的浅色与深色"
          pressed={appearance === 'dark'}
          disabled={!running || pending !== undefined}
          onClick={async () => {
            const next = appearance === 'dark' ? 'light' : 'dark'
            if (await act('appearance', 'appearance', { appearance: next })) setAppearance(next)
          }}
        />
        <IconButton
          size="xs"
          icon={Link}
          label="打开地址"
          tooltip="在设备上打开网址或深链接"
          pressed={address !== undefined}
          disabled={!running}
          onClick={() => setAddress(value => (value === undefined ? '' : undefined))}
        />
        <IconButton
          size="xs"
          icon={Camera}
          label="截图"
          tooltip={onAttach ? '截图放进草稿 · 发送后交给模型服务' : '现在不能添加附件'}
          disabled={!running || !onAttach || pending !== undefined}
          onClick={() => void screenshot()}
        />
        <IconButton
          size="xs"
          icon={AppWindow}
          label="在 Device Hub 中打开"
          tooltip="在 Device Hub 里实时查看和点按"
          disabled={!device || pending !== undefined}
          onClick={() => void act('hub', 'device-hub')}
        />
        <IconButton
          size="xs"
          icon={Power}
          label={running ? '关机' : '启动'}
          tooltip={running && !device?.ours ? '只关闭 Latch 启动的设备' : running ? '关机' : '启动'}
          pressed={running}
          disabled={!device || pending !== undefined || booting || stopping || (running && !device.ours)}
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
      <div className="sim-canvas" data-running={running ? '' : undefined} data-frame-ms={frameMs}>
        {running && frame && frame.udid === udid ? (
          <img className="sim-screen" src={frame.url} alt={device ? `${device.name} 的画面` : '设备画面'} draggable={false} />
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
                      <Button size="xs" variant="ghost" disabled={pending !== undefined} onClick={() => void act('boot', 'boot')}>
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
      <footer className="sim-foot">{state}</footer>
    </section>
  )
}
