import { useRef, useState, type KeyboardEvent } from 'react'
import {
  AGENT_BRACKETS,
  AGENT_EYES,
  AGENT_HUES,
  type AgentAvatar as Avatar,
  type AgentFace,
  type CustomAgentSummary,
} from '@latch/protocol'
import { Button, InlineNotice, Popover } from '@latch/ui'
import { AgentAvatar } from './AgentAvatar.tsx'
import { WriteNotice } from './AgentForm.tsx'
import { BRACKET_NAMES, EYES_NAMES, HUE_NAMES, type AvatarState } from './avatarFace.ts'
import { PictureRow, useAvatarUpload } from './AvatarPicture.tsx'
import { writeFor, type AgentWrites } from './useAgentWrites.ts'

type Part = 'bracket' | 'eyes' | 'hue'
const ROWS: Array<{ part: Part; label: string; values: readonly string[]; name: (value: string) => string }> = [
  { part: 'bracket', label: '括号', values: AGENT_BRACKETS, name: value => BRACKET_NAMES[value as Avatar['bracket']] },
  { part: 'eyes', label: '眼睛', values: AGENT_EYES, name: value => EYES_NAMES[value as Avatar['eyes']] },
  { part: 'hue', label: '颜色', values: AGENT_HUES, name: value => HUE_NAMES[value as Avatar['hue']] },
]

/**
 * One row of the picker: a radio group whose choices are faces, with a roving Tab stop. Arrows move focus from the
 * focused face, Space or Enter picks it; the checked one is the Host's value, ringed in ink. Leaving the row puts its
 * Tab stop back on the checked face.
 */
function PartRow({
  row,
  avatar,
  disabled,
  onPick,
}: {
  row: (typeof ROWS)[number]
  avatar: Avatar
  disabled: boolean
  onPick: (next: Avatar) => void
}) {
  const group = useRef<HTMLDivElement>(null)
  // Under a picture the rows show the face it would go back to, with none of them checked as what is shown now.
  const pictured = avatar.kind === 'image'
  const parts: AgentFace = { bracket: avatar.bracket, eyes: avatar.eyes, hue: avatar.hue }
  const current = avatar[row.part]
  const [focused, setFocused] = useState<number | null>(null)
  const stop = focused ?? row.values.indexOf(current)
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]
    const edge = event.key === 'Home' ? 0 : event.key === 'End' ? row.values.length - 1 : undefined
    if (step === undefined && edge === undefined) return
    event.preventDefault()
    const next = edge ?? (stop + step! + row.values.length) % row.values.length
    setFocused(next)
    group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus()
  }
  return (
    <div className="avatar-picker-row">
      <span className="avatar-picker-label" id={`avatar-picker-${row.part}`}>
        {row.label}
      </span>
      <div
        ref={group}
        role="radiogroup"
        aria-labelledby={`avatar-picker-${row.part}`}
        className="avatar-picker-options"
        data-part={row.part}
        onKeyDown={move}
        onBlur={event => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocused(null)
        }}>
        {row.values.map((value, index) => {
          const option = { kind: 'face', ...parts, [row.part]: value } as Avatar
          const checked = !pictured && value === current
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={row.name(value)}
              aria-disabled={disabled || undefined}
              title={row.name(value)}
              tabIndex={index === stop ? 0 : -1}
              className="avatar-picker-option"
              onFocus={() => {
                setFocused(index)
              }}
              onClick={() => {
                if (!disabled && !checked) onPick(option)
              }}>
              <AgentAvatar avatar={option} size={28} still />
            </button>
          )
        })}
      </div>
    </div>
  )
}

/**
 * The Agent page's face, which opens the picker: the moving face above three rows of 括号, 眼睛 and 颜色, and a last row,
 * 图片, to put a picture in the face's place or clear it. A choice is sent at once with the Agent's revision and shows
 * only once the Host has it; a refusal, a conflict or an unknown result says so here, and retrying an unknown one repeats
 * the same request. Choosing a face while a picture shows puts the face back.
 */
export function AvatarPicker({
  agent,
  state,
  writes,
  disabled,
  onReload,
}: {
  agent: CustomAgentSummary
  state: AvatarState
  writes: AgentWrites
  disabled: boolean
  onReload: () => void
}) {
  const key = `avatar:${agent.id}`
  const write = writeFor(writes.state, key)
  const upload = useAvatarUpload(agent, onReload)
  const locked = disabled || writes.saving || writes.held || upload.held
  const [open, setOpen] = useState(false)
  const notice = (
    <WriteNotice
      state={write}
      onRetry={() => void writes.retry()}
      onReload={() => {
        writes.clear()
        onReload()
      }}
    />
  )
  const pick = (avatar: Avatar) => {
    upload.clear()
    void writes.run(key, `custom-agents/${encodeURIComponent(agent.id)}`, 'PATCH', { avatar, baseRevision: agent.revision })
  }
  const clearPicture = () => {
    upload.clear()
    void writes.run(key, `custom-agents/${encodeURIComponent(agent.id)}/avatar-image`, 'DELETE', { baseRevision: agent.revision })
  }
  return (
    <>
      <Popover
        label="头像"
        size="md"
        side="auto"
        align="start"
        onOpenChange={setOpen}
        trigger={props => (
          <button {...props} type="button" className="agent-head-avatar" aria-label={`${agent.name} 的头像`}>
            <AgentAvatar avatar={agent.avatar} size={56} state={state} />
          </button>
        )}>
        <div className="avatar-picker" aria-busy={write !== null && 'phase' in write && write.phase === 'saving'}>
          <div className="avatar-picker-preview">
            <AgentAvatar avatar={agent.avatar} size={64} />
          </div>
          {ROWS.map(row => (
            <PartRow key={row.part} row={row} avatar={agent.avatar} disabled={locked} onPick={pick} />
          ))}
          <PictureRow
            hasPicture={agent.avatar.kind === 'image'}
            upload={upload.state}
            disabled={disabled || writes.saving || writes.held}
            onChoose={file => {
              writes.clear()
              void upload.choose(file)
            }}
            onRetry={() => void upload.retry()}
            onClear={clearPicture}
            onReload={() => {
              upload.clear()
              onReload()
            }}
          />
          {notice}
        </div>
      </Popover>
      {/* Closed, the header still says what became of the last choice, since it holds every other change back. */}
      {!open && write && 'kind' in write && <div className="avatar-picker-notice">{notice}</div>}
      {!open && upload.state.phase === 'unknown' && (
        <div className="avatar-picker-notice">
          <InlineNotice tone="warn" title="头像上传结果未知" action={<Button onClick={() => void upload.retry()}>重试同一请求</Button>}>
            {upload.state.message}
          </InlineNotice>
        </div>
      )}
    </>
  )
}

/**
 * The face of a helper still being created: the same picker, with nothing written until 创建. The preview moves as the
 * person picks.
 */
export function DraftAvatarPicker({ avatar, name, onPick }: { avatar: Avatar; name: string; onPick: (next: Avatar) => void }) {
  return (
    <Popover
      label="头像"
      size="md"
      side="auto"
      align="start"
      trigger={props => (
        <button {...props} type="button" className="agent-head-avatar helper-create-face" aria-label={`${name || '它'}的头像`}>
          <AgentAvatar avatar={avatar} size={72} />
        </button>
      )}>
      <div className="avatar-picker">
        <div className="avatar-picker-preview">
          <AgentAvatar avatar={avatar} size={64} />
        </div>
        {ROWS.map(row => (
          <PartRow key={row.part} row={row} avatar={avatar} disabled={false} onPick={onPick} />
        ))}
      </div>
    </Popover>
  )
}
