import { useEffect, useRef, useState } from 'react'
import { Circle, ListChecks, Scale, Square } from 'lucide-react'
import {
  EyeGlyph,
  HistoryGlyph,
  Icon,
  MenuFooterLink,
  ModelGlyph,
  ModeStrip,
  PickerBoard,
  PickerSheetBody,
  SheetSurface,
  SegmentedControl,
  ShieldAlertGlyph,
  ShieldGlyph,
  type BoardLevels,
  type BoardSource,
} from '../../src/index.ts'
import { Cell, Row, Section } from './parts.tsx'

export const GALLERY_MODES = [
  { value: 'plan', label: '只看不改', line: '只读文件、回答问题，不改任何东西。', icon: EyeGlyph },
  { value: 'ask', label: '先问你', line: '改文件、运行命令前先问你。', icon: ShieldGlyph },
  { value: 'rule', label: '按规则放行', line: '规则允许的直接做，其余先问你。', icon: ListChecks },
  { value: 'model', label: '由模型判断', line: '模型判断风险，危险的才问你。', icon: Scale },
  { value: 'never', label: '不再询问', line: '改文件、运行命令都不再问你。', icon: ShieldAlertGlyph, risk: true },
]

export const GALLERY_SOURCES: Array<BoardSource<string>> = [
  {
    id: 'recent',
    label: '最近使用',
    icon: <Icon icon={HistoryGlyph} size={16} />,
    items: [{ value: 'lab/alpha', label: 'alpha-long-model-name-2026-preview' }],
  },
  {
    id: 'lab',
    label: 'Lab · 经 Latch',
    hint: '请求由 Latch 在这台 Mac 上转发，用设置里的密钥。协议转换，实验性：略去或受限的有音频、引用标注、概率详情。',
    note: {
      lead: '请求由 Latch 在这台 Mac 上转发，用设置里的密钥。协议转换，实验性。',
      fold: { label: '略去或受限', items: ['音频', '引用标注', '概率详情'] },
    },
    icon: <Icon icon={ModelGlyph} size={16} />,
    items: ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda'].map(name => ({
      value: `lab/${name}`,
      label: name,
    })),
  },
  {
    id: 'held',
    label: '模型服务',
    icon: <Icon icon={ModelGlyph} size={16} />,
    items: [{ value: 'held/one', label: 'Held', disabledReason: '开始后不能换服务' }],
  },
]

export const galleryLevels = (item: string | undefined): BoardLevels<string> =>
  item === 'lab/gamma'
    ? { value: 'default', options: [{ value: 'default', label: '默认' }], note: '用模型默认值' }
    : {
        value: item === 'lab/beta' ? 'high' : 'default',
        options: ['默认', '低', '中', '高'].map((label, index) => ({ value: ['default', 'low', 'medium', 'high'][index]!, label })),
        ...(item === 'lab/delta' ? { pending: true } : {}),
      }

/** A phone picker's group whose heading has more to say: tapped open here, as a finger would. */
function HintedSheet() {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>('.ui-sheet-group-toggle')?.click()
  }, [])
  return (
    <div ref={box} className="gallery-phone">
      <SheetSurface title="模型" onClose={() => {}}>
        <PickerSheetBody
          label="模型"
          groups={[
            {
              id: 'lab',
              label: 'Lab · 经 Latch',
              hint: '请求由 Latch 在这台 Mac 上转发，用设置里的密钥。',
              options: [
                { value: 'alpha', label: 'alpha' },
                { value: 'beta', label: 'beta' },
              ],
            },
          ]}
          value="alpha"
          onValueChange={() => {}}
        />
      </SheetSurface>
    </div>
  )
}

/** A phone's board whose group heading was tapped, its note's folded list opened, as a finger would. */
function NotedBoard() {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>('.ui-board-heading-toggle')?.click()
    requestAnimationFrame(() => box.current?.querySelector<HTMLButtonElement>('.ui-board-hint-fold')?.click())
  }, [])
  return (
    <div ref={box} className="ui-sheet-surface">
      <PickerBoard
        label="模型"
        levelsLabel="思考"
        layout="sheet"
        sources={[GALLERY_SOURCES[1]!]}
        value="lab/beta"
        levels={galleryLevels}
        onItem={() => {}}
        onLevel={() => {}}
      />
    </div>
  )
}

/** The composer's 权限 strip and the shared 模型 · 思考 board, as they are drawn in their layers. */
export function Boards() {
  const [mode, setMode] = useState('ask')
  const [model, setModel] = useState<string | undefined>('lab/beta')
  return (
    <Section title="模式条与选择面板">
      <Row label="模式条">
        <Cell caption="五档 · 先问你">
          <div className="ui-popover" data-size="sm">
            <ModeStrip label="什么时候问你？" keys="⌥⌘4" value={mode} options={GALLERY_MODES} onChoose={setMode} />
          </div>
        </Cell>
        <Cell caption="两档 · 不再询问 · 一档不可选">
          <div className="ui-popover" data-size="sm">
            <ModeStrip
              label="什么时候问你？"
              value="never"
              options={[{ ...GALLERY_MODES[1]!, disabledReason: '这台设备不能发送消息' }, GALLERY_MODES[4]!]}
              onChoose={() => {}}
            />
          </div>
        </Cell>
        <Cell caption="七档 · 第二行">
          <div className="ui-popover" data-size="sm">
            <ModeStrip
              label="什么时候问你？"
              value="extra-1"
              options={[
                ...GALLERY_MODES,
                { value: 'extra-1', label: 'Profile A', icon: Circle },
                { value: 'extra-2', label: 'Profile B', icon: Square },
              ]}
              onChoose={() => {}}
            />
          </div>
        </Cell>
        <Cell caption="面板脚部 · 一行 · 写入中">
          <div className="ui-popover" data-size="md">
            <ModeStrip compact pending label="权限" value={mode} options={GALLERY_MODES.slice(1)} onChoose={setMode} />
          </div>
        </Cell>
      </Row>
      <Row label="选择面板">
        <Cell caption="单个模型 · 思考只读">
          <div className="ui-popover" data-size="md">
            <PickerBoard
              compact
              fixedLevelPlacement="inline"
              label="模型"
              levelsLabel="思考"
              sources={[{ ...GALLERY_SOURCES[1]!, items: [{ value: 'lab/gamma', label: 'gamma' }] }]}
              value="lab/gamma"
              levels={galleryLevels}
              onItem={() => {}}
              onLevel={() => {}}
              footer={
                <MenuFooterLink icon={ModelGlyph} onClick={() => {}}>
                  管理模型…
                </MenuFooterLink>
              }
            />
          </div>
        </Cell>
        <Cell caption="具名来源 · 档位 · 设置">
          <div className="ui-popover" data-size="lg">
            <PickerBoard
              label="模型"
              levelsLabel="思考"
              sources={GALLERY_SOURCES}
              sourceLabels
              value={model}
              levels={galleryLevels}
              onItem={setModel}
              onLevel={() => {}}
              keyCaps={index => `⌘${index + 1}`}
              settings={
                <SegmentedControl
                  label="速度"
                  size="xs"
                  value="standard"
                  onValueChange={() => {}}
                  options={[
                    { value: 'standard', label: '标准' },
                    { value: 'fast', label: '快' },
                  ]}
                />
              }
              footer={
                <MenuFooterLink icon={ModelGlyph} chevron={false} onClick={() => {}}>
                  管理模型…
                </MenuFooterLink>
              }
            />
          </div>
        </Cell>
        <Cell caption="脚部 · 速度与权限 · 选了不关">
          <div className="ui-popover" data-size="lg">
            <PickerBoard
              keepOpen
              label="模型"
              levelsLabel="思考"
              sources={GALLERY_SOURCES.slice(1)}
              value={model}
              levels={galleryLevels}
              onItem={setModel}
              onLevel={() => {}}
              foot={
                <>
                  <SegmentedControl
                    label="速度"
                    size="xs"
                    value="standard"
                    onValueChange={() => {}}
                    options={[
                      { value: 'standard', label: '标准' },
                      { value: 'fast', label: '快速' },
                    ]}
                  />
                  <ModeStrip compact label="权限" value="never" options={GALLERY_MODES.slice(1)} onChoose={() => {}} />
                </>
              }
            />
          </div>
        </Cell>
        <Cell caption="手机 · 来源与档位是一行">
          <div className="ui-sheet-surface">
            <PickerBoard
              label="模型"
              levelsLabel="思考"
              layout="sheet"
              sources={GALLERY_SOURCES}
              value={model}
              levels={galleryLevels}
              onItem={setModel}
              onLevel={() => {}}
            />
          </div>
        </Cell>
        <Cell caption="手机选值 · 组标题的说明点开">
          <HintedSheet />
        </Cell>
        <Cell caption="手机 · 组的说明点开，略去的各项展开">
          <NotedBoard />
        </Cell>
        <Cell caption="一个来源 · 搜不到 · 只有默认">
          <div className="ui-popover" data-size="lg">
            <PickerBoard
              label="模型"
              levelsLabel="思考"
              sources={[GALLERY_SOURCES[1]!]}
              query={{ query: 'none-such', revision: 1 }}
              value="lab/gamma"
              levels={() => ({ value: 'default', options: [{ value: 'default', label: '默认' }], note: '用模型默认值' })}
              onItem={() => {}}
              onLevel={() => {}}
            />
          </div>
        </Cell>
      </Row>
    </Section>
  )
}
