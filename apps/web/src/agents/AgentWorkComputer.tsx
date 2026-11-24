import { useEffect, useRef, useState } from 'react'
import type { CustomAgentSummary } from '@latch/protocol'
import { Button, InlineNotice, LaptopGlyph, MenuFooterLink, PlusGlyph, ValuePicker } from '@latch/ui'
import { useViewport } from '../breakpoints.ts'
import { computerState, useComputers } from '../core/computers.ts'
import { defineCopy } from '../core/i18n.ts'
import { computerLabel, describeFailure } from '../core/securityCopy.ts'
import { shellComputers } from '../core/shell.ts'

type Target = NonNullable<CustomAgentSummary['workComputer']>

const COPY = defineCopy(
  {
    workComputer: '工作电脑',
    cloud: (id: string) => `云电脑 · ${id}`,
    pair: '添加云电脑…',
    createThere: '在工作电脑上创建 Agent 后，回到这里选中它。',
    newAgent: '新委托会使用工作电脑上所选 Agent 的配置。',
    delegate: '新委托会使用工作电脑上所选 Agent 的配置。聊天和记忆留在原电脑，已启用的定时任务会暂停。',
    localAgain: '选回这台 Mac 后，新委托在这里运行，已暂停的定时任务需手动开启。',
    open: (name: string) => `在 ${name} 上打开 Agent`,
    needApp: (name: string) => `请用已与 ${name} 配对的桌面端打开这个 Agent，或直接到那台电脑上继续。`,
    missing: '这台桌面端尚未配对该工作电脑。请在「设置 › 电脑」添加。',
    reading: '正在读取已配对的电脑…',
  },
  {
    workComputer: 'Work computer',
    cloud: (id: string) => `Cloud computer · ${id}`,
    pair: 'Add cloud computer…',
    createThere: 'After creating the assistant on the work computer, return here to select it.',
    newAgent: 'New requests use the target assistant’s settings.',
    delegate: 'New requests use the target assistant’s settings. Chats and memory stay on this Mac. Active schedules pause.',
    localAgain: 'Switch back to this Mac to run new requests here. Re-enable paused schedules manually.',
    open: (name: string) => `Open assistant on ${name}`,
    needApp: (name: string) => `Use a desktop app paired with ${name}, or continue directly on that computer.`,
    missing: 'This desktop app has not paired with the work computer. Add it in Settings › Computers.',
    reading: 'Loading paired computers…',
  },
)

/** The bound destination of manual requests. Only a real click opens its own authenticated window. */
export function AgentWorkDestination({ owner, target }: { owner: string; target: Target }) {
  const api = shellComputers()
  const view = useComputers()
  const computer = view?.computers.find(item => item.hostId === target.hostId)
  const name = computer?.name ?? COPY.cloud(target.hostId.slice(0, 8))
  const [failure, setFailure] = useState('')
  const [opening, setOpening] = useState(false)
  const open = api?.openWorkAgent
  const unavailable = !open
    ? COPY.needApp(name)
    : !view
      ? COPY.reading
      : !computer
        ? COPY.missing
        : computer.state !== 'online'
          ? computerState(computer).text
          : undefined
  return (
    <div className="agent-work-destination" data-work-destination="">
      <Button
        icon={LaptopGlyph}
        disabled={Boolean(unavailable) || opening}
        loading={opening}
        onClick={async () => {
          if (!open || unavailable || opening) return
          setFailure('')
          setOpening(true)
          try {
            const result = await open(target.hostId, target.agentId, owner)
            if (!result.ok) setFailure(describeFailure(0, result.error))
          } catch {
            setFailure(describeFailure(0, 'work-computer-unavailable'))
          } finally {
            setOpening(false)
          }
        }}>
        {COPY.open(name)}
      </Button>
      {(unavailable || failure) && <InlineNotice>{unavailable || failure}</InlineNotice>}
    </div>
  )
}

/** Only the initiating desktop page sees the one remote ID the person chooses in main's native menu. */
export function AgentWorkComputerField({
  target,
  creating = false,
  disabled,
  onManage,
  onPicking,
  onChange,
}: {
  target: Target | undefined
  creating?: boolean
  disabled: boolean
  onManage: () => void
  onPicking?: (picking: boolean) => void
  onChange: (target: Target | undefined) => void | Promise<void>
}) {
  const api = shellComputers()
  const view = useComputers()
  const phone = useViewport() === 'phone'
  const [notice, setNotice] = useState('')
  const alive = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      onPicking?.(false)
    }
  }, [onPicking])
  const local = view?.computers.find(row => row.local)
  const pick = api?.pickWorkAgent
  if (!pick || !local) return null
  const options = (view?.computers ?? []).map(row => ({
    value: row.hostId,
    label: row.local ? computerLabel(true) : row.name,
    ...(row.local || row.state === 'online' ? {} : { disabledReason: computerState(row).text }),
  }))
  return (
    <div className="agent-work-field" data-work-computer="">
      {!phone && (
        <span className="agent-work-label" aria-hidden="true">
          {COPY.workComputer}
        </span>
      )}
      <ValuePicker<string>
        label={COPY.workComputer}
        variant={phone ? 'row' : 'inline'}
        leading={LaptopGlyph}
        value={target?.hostId ?? local.hostId}
        options={options}
        header={{
          title: COPY.workComputer,
          meta: creating ? COPY.newAgent : target ? `${COPY.newAgent} ${COPY.localAgain}` : COPY.delegate,
        }}
        reselect
        disabled={disabled}
        placeholder={target ? COPY.cloud(target.hostId.slice(0, 8)) : undefined}
        footer={
          <MenuFooterLink icon={PlusGlyph} closes onClick={onManage}>
            {COPY.pair}
          </MenuFooterLink>
        }
        onValueChange={async next => {
          setNotice('')
          if (next === local.hostId) {
            if (target) await onChange(undefined)
            return
          }
          onPicking?.(true)
          try {
            const result = await pick(next)
            if (!alive.current) return
            if (!result.ok) {
              if (result.error !== 'canceled') setNotice(describeFailure(0, result.error))
              return
            }
            if (result.hostId === next && result.agentId) await onChange({ hostId: next, agentId: result.agentId })
            else setNotice(COPY.createThere)
          } catch {
            if (alive.current) setNotice(describeFailure(0, 'work-computer-unavailable'))
          } finally {
            if (alive.current) onPicking?.(false)
          }
        }}
      />
      {notice && <InlineNotice>{notice}</InlineNotice>}
    </div>
  )
}
