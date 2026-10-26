import { useState } from 'react'
import { Kbd, SearchField } from '@latch/ui'
import { workbenchBindings } from '../workbenchShortcuts.ts'
import { Modal, ModalHeader } from './overlays.tsx'
const bindings = [
  ...workbenchBindings.map(binding => [binding.label, `${binding.desktop}（桌面） / ${binding.browser}（浏览器）`]),
  ['第 1–9 个会话', '⌘1–9（桌面） / Alt 1–9（浏览器）'],
  ['命令面板', '⌘K / Ctrl K'],
  ['会话内查找', '⌘F / Ctrl F'],
  ['Mac 文件预览中的快速查看', 'Space（仅支持的文件类型）'],
  ['查找下一个 / 上一个', 'Enter / Shift Enter'],
  ['下一个待处理请求（桌面端）', '⌥⌘A'],
  ['下一个待处理请求（浏览器）', 'Alt Shift A'],
  ['关闭当前浮层或查找', 'Esc'],
  ['命令面板移动 / 执行', '↑ ↓ / Enter'],
  ['空输入框取回上一条消息', '↑'],
  ['取消正在运行的任务（输入框内）', '连续两次 Esc'],
  ['批准 / 拒绝聚焦的请求', '⌘ Enter / Ctrl Enter · Esc'],
]
export function KeyboardHelp({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('')
  return (
    <Modal label="键盘快捷键" onClose={onClose}>
      <ModalHeader title="键盘快捷键" onClose={onClose} />
      <div className="keyboard-help">
        <SearchField autoFocus label="搜索快捷键" value={q} onValueChange={setQ} />
        {bindings
          .filter(([label, key]) => `${label} ${key}`.toLocaleLowerCase().includes(q.toLocaleLowerCase()))
          .map(([label, key]) => (
            <div key={label}>
              <span>{label}</span>
              <Kbd>{key}</Kbd>
            </div>
          ))}
      </div>
    </Modal>
  )
}
