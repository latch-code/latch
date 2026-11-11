import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Circle,
  CircleAlert,
  CircleDot,
  Copy,
  Download,
  Ellipsis,
  Fingerprint,
  Folder,
  Info,
  Lock,
  PanelRight,
  Pencil,
  Plug,
  Plus,
  Puzzle,
  RotateCcw,
  Search,
  Settings,
  Shield,
  ShieldAlert,
  SquarePen,
  Terminal,
  Trash2,
  TriangleAlert,
  Undo2,
  X,
} from 'lucide-react'
import {
  Badge,
  Button,
  Checkbox,
  ChoiceList,
  Collapse,
  Count,
  DemoMark,
  DevMark,
  Dialog,
  DialogSurface,
  ModalHeader,
  EmptyState,
  ErrorState,
  FilterPills,
  Icon,
  IconButton,
  ICON_STROKE,
  Hint,
  InlineNotice,
  Kbd,
  Meter,
  LiveChanges,
  Loading,
  MenuFooterLink,
  MenuFooterNote,
  MenuPanel,
  MenuSearch,
  PermissionMenu,
  PickerSheetBody,
  Radio,
  ResizeHandle,
  SearchField,
  SegmentedControl,
  Sheet,
  SheetSurface,
  Shimmer,
  Skeleton,
  Spinner,
  StatusDot,
  StatusGlyph,
  StatusPill,
  StatusSlot,
  StatusWord,
  StatusWords,
  Swap,
  Switch,
  SwitchRow,
  Tabs,
  TextAreaField,
  TextField,
  Tile,
  TileAction,
  TileChoice,
  Toast,
  TooltipSurface,
  ValuePicker,
  useLivePrevious,
  type ButtonSize,
  type TileMark,
  type ButtonVariant,
  type IconSize,
  type PermissionLevel,
  type SlotStatus,
} from '../../src/index.ts'
import { Cell, Row, Section } from './parts.tsx'
import { Kit } from './Kit.tsx'

/**
 * Every primitive of @latch/ui in every state, on one page, for the design review and the visual capture (surface
 * ui-gallery). Hover, press and keyboard focus cannot be held on a static page, so the cells that show them carry
 * `data-force="<pseudo-class>"`: the capture forces that state on the cell's first element (or the one `data-force-at`
 * selects) through the browser's DevTools protocol, with the real stylesheet. Content is fixed and nothing depends on
 * the clock, so every capture is the same.
 */

const DEV_TEXT = '开发模式：Host 代码可被本机修改'

const VARIANTS: Array<[ButtonVariant, string, string]> = [
  ['primary', '主', '允许一次'],
  ['secondary', '次', '稍后'],
  ['outline', '描边', '拒绝'],
  ['ghost', '幽灵', '重置'],
  ['link', '链接', '管理模型服务'],
  ['danger', '危险操作', '撤销此设备'],
  ['destroy', '销毁', '删除'],
]
const STATES: Array<[string, string | undefined]> = [
  ['静止', undefined],
  ['悬停', 'hover'],
  ['按下', 'active'],
  ['焦点', 'focus-visible'],
]

function Icons() {
  const sizes: IconSize[] = [12, 14, 16, 20, 24]
  return (
    <Section title="图标">
      <Row label="尺寸 / 描边">
        {sizes.map(size => (
          <Cell key={size} caption={`${size} / ${ICON_STROKE[size]}`}>
            <span className="gallery-icons">
              <Icon icon={SquarePen} size={size} />
              <Icon icon={Search} size={size} />
              <Icon icon={Settings} size={size} />
            </span>
          </Cell>
        ))}
      </Row>
      <Row label="箭头">
        <Cell caption="进入下一层">
          <Icon icon={ChevronRight} size={12} />
        </Cell>
        <Cell caption="原地选值">
          <Icon icon={ChevronsUpDown} size={12} />
        </Cell>
        <Cell caption="下拉动作">
          <Icon icon={ChevronDown} size={12} />
        </Cell>
      </Row>
      <Row label="状态">
        <Cell caption="失败">
          <span className="gallery-err">
            <Icon icon={TriangleAlert} size={14} />
          </span>
        </Cell>
        <Cell caption="完全访问（已选中）">
          <span className="gallery-warn">
            <Icon icon={ShieldAlert} size={14} />
          </span>
        </Cell>
        <Cell caption="转圈 12 / 14 / 16 / 20">
          <span className="gallery-icons">
            <Spinner size={12} />
            <Spinner size={14} />
            <Spinner size={16} />
            <Spinner size={20} />
          </span>
        </Cell>
      </Row>
    </Section>
  )
}

function Buttons() {
  const sizes: ButtonSize[] = ['xs', 'sm', 'md', 'lg']
  return (
    <Section title="按钮">
      {VARIANTS.map(([variant, name, label]) => (
        <Row key={variant} label={name}>
          {STATES.map(([caption, force]) => (
            <Cell key={caption} caption={caption} force={force}>
              <Button variant={variant}>{label}</Button>
            </Cell>
          ))}
          <Cell caption="禁用">
            <Button variant={variant} disabled tooltip="填写名称后可以创建">
              {label}
            </Button>
          </Cell>
        </Row>
      ))}
      <Row label="尺寸">
        {sizes.map(size => (
          <Cell key={size} caption={`${size} · ${{ xs: 24, sm: 28, md: 32, lg: 44 }[size]}`}>
            <Button variant="secondary" size={size} icon={Plus}>
              添加
            </Button>
          </Cell>
        ))}
      </Row>
      <Row label="加载">
        <Cell caption="主">
          <Button variant="primary" loading loadingLabel="添加中…">
            添加服务
          </Button>
        </Cell>
        <Cell caption="次 · md">
          <Button variant="secondary" size="md" loading loadingLabel="检测中…">
            检测连接
          </Button>
        </Cell>
        <Cell caption="下拉动作">
          <Button variant="ghost" menu>
            计划 2/4
          </Button>
        </Cell>
      </Row>
      <Row label="色调上的次">
        <Cell caption="琥珀">
          <div className="gallery-tint" data-tint="warn">
            <Button variant="secondary" size="xs">
              重试
            </Button>
          </div>
        </Cell>
        <Cell caption="红 · 悬停" force="hover" at=".ui-button">
          <div className="gallery-tint" data-tint="err">
            <Button variant="secondary" icon={Lock}>
              在本机允许
            </Button>
          </div>
        </Cell>
      </Row>
      <Row label="卡片按钮行">
        <Cell caption="最多两个按钮，其余进 ⋯">
          <div className="gallery-actions">
            <IconButton label="更多批准选项" icon={Ellipsis} />
            <Button variant="outline">拒绝</Button>
            <Button variant="primary" shortcut="mod+enter">
              允许一次
            </Button>
          </div>
        </Cell>
        <Cell caption="此刻按键生效：键帽在按钮上（触屏不画）">
          <div className="gallery-actions">
            <Button variant="ghost" menu>
              更多
            </Button>
            <Button variant="outline" size="md" keys={['esc']}>
              拒绝
            </Button>
            <Button variant="primary" size="md" keys={['mod', 'enter']}>
              允许
            </Button>
          </div>
        </Cell>
      </Row>
      <Row label="键帽">
        {STATES.map(([caption, force]) => (
          <Cell key={caption} caption={caption} force={force}>
            <Button variant="outline" keys={['esc']}>
              拒绝
            </Button>
          </Cell>
        ))}
        {STATES.map(([caption, force]) => (
          <Cell key={`primary-${caption}`} caption={`主 · ${caption}`} force={force}>
            <Button variant="primary" keys={['mod', 'enter']}>
              允许
            </Button>
          </Cell>
        ))}
        <Cell caption="xs">
          <Button variant="secondary" size="xs" keys={['mod', 'k']}>
            搜索
          </Button>
        </Cell>
        <Cell caption="禁用">
          <Button variant="primary" keys={['mod', 'enter']} disabled tooltip="正在等待上一条消息">
            发送
          </Button>
        </Cell>
      </Row>
      <Row label="图标按钮">
        {(['xs', 'sm', 'md', 'lg'] as const).map(size => (
          <Cell key={size} caption={size}>
            <IconButton label="复制" icon={Copy} size={size} />
          </Cell>
        ))}
        <Cell caption="悬停" force="hover">
          <IconButton label="会话信息" icon={PanelRight} />
        </Cell>
        <Cell caption="开">
          <IconButton label="会话信息" icon={PanelRight} pressed />
        </Cell>
        <Cell caption="菜单打开">
          <IconButton label="更多批准选项" icon={Ellipsis} aria-haspopup="menu" aria-expanded />
        </Cell>
        <Cell caption="焦点" force="focus-visible">
          <IconButton label="设置" icon={Settings} />
        </Cell>
        <Cell caption="禁用">
          <IconButton label="复制" icon={Copy} disabled />
        </Cell>
        <Cell caption="计数">
          <IconButton label="2 项待批准" icon={ShieldAlert} badge={<Count value={2} tone="warn" />} />
        </Cell>
        <Cell caption="圆形">
          <span className="gallery-send">
            <IconButton label="发送" icon={ArrowUp} round size="md" />
          </span>
        </Cell>
      </Row>
    </Section>
  )
}

function Pills() {
  return (
    <Section title="状态词、徽标、计数与状态点">
      <Row label="状态词">
        <StatusWord tone="waiting">等你处理</StatusWord>
        <StatusWord tone="running">运行中 1:12</StatusWord>
        <StatusWord tone="failed">失败</StatusWord>
        <StatusWord tone="done">已完成</StatusWord>
        <StatusWord tone="warn">不可用</StatusWord>
        <StatusWord>已取消</StatusWord>
      </Row>
      <Row label="状态">
        <StatusPill>已取消</StatusPill>
        <StatusPill tone="warn">原内容未知</StatusPill>
        <StatusPill tone="err">高风险</StatusPill>
        <StatusPill tone="ok">已确认</StatusPill>
      </Row>
      <Row label="徽标">
        <Badge>本机</Badge>
        <Badge>默认</Badge>
        <Badge tone="warn">离线</Badge>
        <DevMark description={DEV_TEXT} />
        <DemoMark />
        <DemoMark compact />
      </Row>
      <Row label="计数">
        <Cell caption="被动">
          <span className="gallery-inline">
            排队 <Count value={3} /> 条
          </span>
        </Cell>
        <Cell caption="新结果">
          <span className="gallery-inline">
            定时任务 <Count value={2} tone="strong" />
          </span>
        </Cell>
        <Cell caption="等你处理">
          <span className="gallery-inline">
            等你处理 <Count value={128} tone="warn" />
          </span>
        </Cell>
      </Row>
      <Row label="状态点">
        <Cell caption="正在重新连接">
          <span className="gallery-inline">
            <StatusDot tone="warn" />
            正在重新连接
          </span>
        </Cell>
        <Cell caption="不在线">
          <span className="gallery-inline">
            <StatusDot tone="err" />
            Mac 不在线
          </span>
        </Cell>
        <Cell caption="新文档">
          <StatusDot tone="unread" label="未读" />
        </Cell>
      </Row>
      <Row label="按键">
        <Kbd>⌘K</Kbd>
        <Kbd>Esc</Kbd>
        <Kbd>⌘⏎</Kbd>
      </Row>
    </Section>
  )
}

function Meters() {
  return (
    <Section title="计量">
      <Row label="细条 · sm">
        {(
          [
            [0, '空'],
            [9, '一格'],
            [62, '62k / 128k'],
            [128, '满'],
          ] as const
        ).map(([value, caption]) => (
          <Cell key={caption} caption={caption}>
            <span className="gallery-inline">
              上下文 <Meter label="上下文" value={value} max={128} valueText={`${value}k / 128k`} />
            </span>
          </Cell>
        ))}
      </Row>
      <Row label="图例 · md">
        <Cell caption="12 格">
          <Meter label="上下文" value={62} max={128} size="md" valueText="62k / 128k" />
        </Cell>
        <Cell caption="18 格">
          <Meter label="上下文" value={84} max={272} cells={18} size="md" valueText="84k / 272k" />
        </Cell>
      </Row>
    </Section>
  )
}

const MODELS = [
  { value: 'fixture-large', label: 'fixture-large', tag: <Badge>默认</Badge> },
  { value: 'fixture-small', label: 'fixture-small' },
  { value: 'fixture-vision', label: 'fixture-vision', meta: '128k' },
]
const LEVELS: Array<PermissionLevel<'L0' | 'L1' | 'L2' | 'L3'>> = [
  { value: 'L0', title: '只读', description: '不改文件，不运行命令' },
  { value: 'L1', title: '逐项询问', description: '改文件、运行命令前先问你' },
  { value: 'L2', title: '自动编辑', description: '项目内直接编辑，命令仍会询问' },
  { value: 'L3', title: '完全访问', description: '不再询问，可以改动整台电脑 · 需本机确认', risk: true },
]

function Pickers() {
  const [model, setModel] = useState('fixture-large')
  const [level, setLevel] = useState<'L0' | 'L1' | 'L2' | 'L3'>('L1')
  return (
    <Section title="选值">
      <Row label="标准">
        <Cell caption="静止">
          <ValuePicker label="模型" value={model} options={MODELS} onValueChange={setModel} />
        </Cell>
        <Cell caption="悬停" force="hover">
          <ValuePicker label="模型" value="fixture-large" options={MODELS} onValueChange={() => {}} />
        </Cell>
        <Cell caption="按下 · 菜单打开" force="active">
          <ValuePicker label="模型" value="fixture-large" options={MODELS} onValueChange={() => {}} />
        </Cell>
        <Cell caption="焦点" force="focus-visible">
          <ValuePicker label="模型" value="fixture-large" options={MODELS} onValueChange={() => {}} />
        </Cell>
        <Cell caption="前导即标签">
          <ValuePicker
            label="项目"
            leading={Folder}
            value="latch-app"
            options={[
              { value: 'latch-app', label: 'latch-app' },
              { value: 'website', label: 'website' },
            ]}
            onValueChange={() => {}}
          />
        </Cell>
      </Row>
      <Row label="状态">
        <Cell caption="只有一个值">
          <ValuePicker label="项目" value="latch-app" options={[{ value: 'latch-app', label: 'latch-app' }]} onValueChange={() => {}} />
        </Cell>
        <Cell caption="未选择">
          <ValuePicker label="模型" value={undefined} placeholder="选择模型" options={MODELS} onValueChange={() => {}} />
        </Cell>
        <Cell caption="等待验证">
          <PermissionMenu label="权限" leading={Shield} levels={LEVELS} value="L2" defaultValue="L1" pending onValueChange={() => {}} />
        </Cell>
        <Cell caption="工具栏：为「等待验证…」留宽">
          <PermissionMenu label="权限" leading={Shield} levels={LEVELS} value="L0" defaultValue="L1" onValueChange={() => {}} />
        </Cell>
        <Cell caption="风险值 · 设置行">
          <PermissionMenu label="权限" align="end" levels={LEVELS} value="L3" defaultValue="L1" onValueChange={() => {}} />
        </Cell>
        <Cell caption="禁用">
          <ValuePicker
            label="模型"
            value="fixture-large"
            options={MODELS}
            disabled
            disabledReason="运行中不能切换"
            onValueChange={() => {}}
          />
        </Cell>
        <Cell caption="可搜索">
          <ValuePicker
            label="模型"
            searchable
            value={model}
            groups={[{ id: 'local', label: '本地模型服务', options: MODELS }]}
            onValueChange={setModel}
          />
        </Cell>
      </Row>
      <Row label="检查器 xs">
        <Cell caption="静止">
          <span className="gallery-column">
            <ValuePicker
              label="权限"
              size="xs"
              chevron="hover"
              bleed="both"
              value="L1"
              options={LEVELS.map(item => ({ value: item.value, label: item.title }))}
              onValueChange={() => {}}
            />
          </span>
        </Cell>
        <Cell caption="悬停" force="hover" at=".ui-value-picker">
          <span className="gallery-column">
            <ValuePicker
              label="权限"
              size="xs"
              chevron="hover"
              bleed="both"
              value="L1"
              options={LEVELS.map(item => ({ value: item.value, label: item.title }))}
              onValueChange={() => {}}
            />
          </span>
        </Cell>
        <Cell caption="设置行尾部">
          <span className="gallery-setting-row">
            <span>新会话的模型</span>
            <ValuePicker label="模型" bleed="end" align="end" value="fixture-large" options={MODELS} onValueChange={() => {}} />
          </span>
        </Cell>
      </Row>
      <Row label="手机行">
        <div className="gallery-phone-row">
          <ValuePicker
            variant="row"
            label="模型"
            value={model}
            groups={[{ id: 'local', label: '本地模型服务', options: MODELS }]}
            onValueChange={setModel}
          />
          <PermissionMenu
            variant="row"
            label="权限"
            levels={LEVELS}
            value={level}
            defaultValue="L1"
            onValueChange={setLevel}
            footer={<MenuFooterNote>调高要在这台电脑上验证身份</MenuFooterNote>}
          />
        </div>
      </Row>
      <Row label="菜单">
        <Cell caption="选值菜单">
          <div className="ui-popover">
            <MenuPanel
              label="模型"
              selection
              header={{ title: '模型', meta: '执行端' }}
              sections={[
                {
                  id: 'local',
                  label: '本地模型服务',
                  items: MODELS.map(option => ({
                    id: option.value,
                    label: option.label,
                    tag: option.tag,
                    meta: option.meta,
                    checked: option.value === 'fixture-large',
                    onSelect: () => {},
                  })),
                },
              ]}
              footer={<MenuFooterLink onClick={() => {}}>管理模型服务…</MenuFooterLink>}
            />
          </div>
        </Cell>
        <Cell caption="权限菜单" force="focus-visible" at="[role='menuitemradio']:nth-of-type(2)">
          <div className="ui-popover" style={{ width: 320 }}>
            <MenuPanel
              label="权限"
              selection
              header={{ title: '在这台电脑上发起的会话' }}
              sections={[
                {
                  id: 'levels',
                  items: LEVELS.map(item => ({
                    id: item.value,
                    label: item.title,
                    description: item.description,
                    tag: item.value === 'L1' ? <Badge>默认</Badge> : undefined,
                    checked: item.value === 'L3',
                    onSelect: () => {},
                  })),
                },
              ]}
              footer={<MenuFooterNote>调高要在这台电脑上验证身份</MenuFooterNote>}
            />
          </div>
        </Cell>
        <Cell caption="操作菜单 · 说明">
          <div style={{ display: 'grid', gap: 'var(--sp-8)' }}>
            <div className="ui-popover">
              <MenuPanel
                label="文件"
                header={{ title: 'deck.pptx' }}
                sections={[{ id: 'copy', items: [{ id: 'copy', label: '复制路径', icon: Copy, onSelect: () => {} }] }]}
                footer={<MenuFooterNote icon={Info}>重新启动 Host 后可以在这里打开文件。</MenuFooterNote>}
              />
            </div>
            <div className="ui-popover">
              <MenuPanel
                label="文件"
                header={{ title: 'missing.md' }}
                sections={[{ id: 'copy', items: [{ id: 'copy', label: '复制路径', icon: Copy, onSelect: () => {} }] }]}
                footer={<MenuFooterNote icon={CircleAlert}>找不到这个文件。</MenuFooterNote>}
              />
            </div>
          </div>
        </Cell>
        <Cell caption="可搜索 · 打开">
          <div className="ui-popover" style={{ width: 360 }}>
            <MenuSearch label="模型" value="" onValueChange={() => {}} />
            <MenuPanel
              label="模型"
              selection
              sections={[
                {
                  id: 'local',
                  label: '本地模型服务',
                  items: MODELS.map(option => ({
                    id: option.value,
                    label: option.label,
                    tag: option.tag,
                    meta: option.meta,
                    checked: option.value === 'fixture-large',
                    onSelect: () => {},
                  })),
                },
                {
                  id: 'spare',
                  label: '备用模型服务',
                  items: [{ id: 'fixture-mini', label: 'fixture-mini', meta: '32k', onSelect: () => {} }],
                },
              ]}
            />
          </div>
        </Cell>
        <Cell caption="越级项">
          <div className="ui-popover" style={{ width: 320 }}>
            <MenuPanel
              label="权限"
              selection
              header={{ title: '从手机和其他电脑发起的会话' }}
              sections={[
                {
                  id: 'levels',
                  items: LEVELS.map(item => ({
                    id: item.value,
                    label: item.title,
                    description: item.description,
                    checked: item.value === 'L1',
                    disabledReason: item.value === 'L3' ? '只能在执行端电脑上调高' : undefined,
                    onSelect: () => {},
                  })),
                },
              ]}
            />
          </div>
        </Cell>
        <Cell caption="动作菜单" force="hover" at="[role='menuitem']">
          <div className="ui-popover">
            <MenuPanel
              label="会话"
              sections={[
                {
                  id: 'actions',
                  items: [
                    { id: 'rename', label: '重命名', icon: Pencil, onSelect: () => {} },
                    { id: 'export', label: '导出 Markdown', icon: Download, meta: <Kbd>⌘E</Kbd>, onSelect: () => {} },
                    { id: 'delete', label: '删除…', icon: Trash2, danger: true, onSelect: () => {} },
                  ],
                },
              ]}
            />
          </div>
        </Cell>
        <Cell caption="带磁贴的选值菜单 · 脚部动作">
          <div className="ui-popover" style={{ width: 280 }}>
            <MenuPanel
              label="模型"
              selection
              sections={[
                {
                  id: 'local',
                  label: '本地模型服务',
                  media: <Tile size={16} mark={MONO_MARK} />,
                  items: [
                    { id: 'large', label: 'fixture-large', tag: <Badge>默认</Badge>, onSelect: () => {} },
                    { id: 'small', label: 'fixture-small', checked: true, onSelect: () => {} },
                  ],
                },
                {
                  id: 'agents',
                  label: 'Agent',
                  items: [
                    {
                      id: 'agent',
                      label: '本地 Agent',
                      description: '完全访问',
                      media: <Tile size={20} icon={Puzzle} />,
                      onSelect: () => {},
                    },
                  ],
                },
              ]}
              footer={
                <>
                  <MenuFooterLink icon={Undo2} chevron={false} onClick={() => {}}>
                    撤销切换，继续使用 fixture-large
                  </MenuFooterLink>
                  <MenuFooterLink icon={Plus} chevron={false} onClick={() => {}}>
                    添加模型服务…
                  </MenuFooterLink>
                  <MenuFooterLink onClick={() => {}}>管理模型服务…</MenuFooterLink>
                </>
              }
            />
          </div>
        </Cell>
        <Cell caption="弹层里的脚部导航行（列表之外，可用 Tab 到达）">
          <div className="ui-popover" style={{ width: 280 }}>
            <p className="gallery-note">一列按钮之后，分隔线下的一行</p>
            <div className="ui-menu-separator" role="separator" />
            <MenuFooterLink onClick={() => {}}>管理 Agent 成员…</MenuFooterLink>
          </div>
        </Cell>
        <Cell caption="单选列表 · 带磁贴">
          <ChoiceList
            label="模型服务"
            value="local"
            options={[
              { value: 'local', title: '本地模型服务', description: '2 个模型', media: <Tile size={20} mark={MONO_MARK} /> },
              { value: 'other', title: '备用服务', description: '1 个模型', media: <Tile size={20} mark={COLOUR_MARK} /> },
            ]}
            onValueChange={() => {}}
          />
        </Cell>
        <Cell caption="动作菜单 · 无图标">
          <div className="ui-popover">
            <MenuPanel
              label="更多批准选项"
              sections={[
                {
                  id: 'more',
                  items: [{ id: 'always', label: '本会话始终允许', description: '只在这个会话里有效', onSelect: () => {} }],
                },
              ]}
            />
          </div>
        </Cell>
      </Row>
    </Section>
  )
}

function Inputs() {
  const [name, setName] = useState('我的电脑')
  const [query, setQuery] = useState('设置页')
  return (
    <Section title="输入">
      <Row label="文本">
        <Cell caption="静止">
          <TextField label="设备名称" placeholder="例如：工作电脑" defaultValue="" hint="只在这台 Host 的设备列表里显示。" />
        </Cell>
        <Cell caption="焦点" force="focus" at="input">
          <TextField label="设备名称" value={name} onChange={event => setName(event.target.value)} />
        </Cell>
        <Cell caption="错误">
          <TextField label="地址" defaultValue="api.example" error="地址要以 https:// 开头，例如 https://api.example.com。" />
        </Cell>
        <Cell caption="禁用">
          <TextField label="API Key" defaultValue="已保存（不回显）" disabled />
        </Cell>
      </Row>
      <Row label="多行">
        <TextAreaField label="参数" hint="每行一个" defaultValue={'acp\n--stdio'} />
      </Row>
      <Row label="搜索">
        <Cell caption="空">
          <SearchField label="搜索会话" value="" onValueChange={() => {}} trailing={<Kbd>⌘K</Kbd>} />
        </Cell>
        <Cell caption="有内容">
          <SearchField label="搜索会话" value={query} onValueChange={setQuery} />
        </Cell>
        <Cell caption="焦点" force="focus-within" at=".ui-search">
          <SearchField label="搜索会话" value="" onValueChange={() => {}} />
        </Cell>
      </Row>
      <Row label="搜索行">
        <Cell caption="静止（侧栏里的一行）">
          <div className="gallery-ground gallery-column">
            <SearchField variant="ghost" label="搜索会话" value="" onValueChange={() => {}} trailing={<Kbd>⌘K</Kbd>} />
          </div>
        </Cell>
        <Cell caption="悬停" force="hover" at=".ui-search">
          <div className="gallery-ground gallery-column">
            <SearchField variant="ghost" label="搜索会话" value="" onValueChange={() => {}} trailing={<Kbd>⌘K</Kbd>} />
          </div>
        </Cell>
        <Cell caption="焦点" force="focus-within" at=".ui-search">
          <div className="gallery-ground gallery-column">
            <SearchField variant="ghost" label="搜索会话" value="" onValueChange={() => {}} />
          </div>
        </Cell>
        <Cell caption="有内容">
          <div className="gallery-ground gallery-column">
            <SearchField variant="ghost" label="搜索会话" value="设置页" onValueChange={() => {}} />
          </div>
        </Cell>
      </Row>
    </Section>
  )
}

function Choices() {
  const [mode, setMode] = useState<'chat' | 'agent'>('agent')
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>('system')
  const [tab, setTab] = useState<'args' | 'output'>('args')
  const [filter, setFilter] = useState<'all' | 'chat' | 'agent'>('all')
  const [sendKey, setSendKey] = useState<'enter' | 'mod-enter'>('enter')
  const [allowRemote, setAllowRemote] = useState(true)
  return (
    <Section title="开关与选择">
      <Row label="开关">
        <Cell caption="开">
          <Switch label="开" checked onCheckedChange={() => {}} />
        </Cell>
        <Cell caption="关">
          <Switch label="关" checked={false} onCheckedChange={() => {}} />
        </Cell>
        <Cell caption="按住" force="active">
          <Switch label="按住" checked={false} onCheckedChange={() => {}} />
        </Cell>
        <Cell caption="焦点" force="focus-visible">
          <Switch label="焦点" checked onCheckedChange={() => {}} />
        </Cell>
        <Cell caption="禁用">
          <Switch label="禁用" checked disabled onCheckedChange={() => {}} />
        </Cell>
      </Row>
      <Row label="开关行">
        <div className="gallery-rows">
          <SwitchRow
            title="允许其他设备在这里新建会话"
            description="关闭后只能查看、批准或停止已有会话"
            checked={allowRemote}
            onCheckedChange={setAllowRemote}
          />
          <SwitchRow title="验收模型插件" checked={false} locked="已由本机策略关闭，无法在这里开启" onCheckedChange={() => {}} />
        </div>
      </Row>
      <Row label="分段">
        <Cell caption="两段 · sm">
          <SegmentedControl
            label="会话模式"
            value={mode}
            onValueChange={setMode}
            options={[
              { value: 'chat', label: '对话' },
              { value: 'agent', label: 'Agent' },
            ]}
          />
        </Cell>
        <Cell caption="三段 · md">
          <SegmentedControl
            label="外观"
            size="md"
            value={theme}
            onValueChange={setTheme}
            options={[
              { value: 'system', label: '跟随系统' },
              { value: 'light', label: '浅色' },
              { value: 'dark', label: '深色' },
            ]}
          />
        </Cell>
        <Cell caption="焦点" force="focus-visible" at="[aria-checked='true']">
          <SegmentedControl
            label="会话模式"
            value="chat"
            onValueChange={() => {}}
            options={[
              { value: 'chat', label: '对话' },
              { value: 'agent', label: 'Agent' },
            ]}
          />
        </Cell>
      </Row>
      <Row label="标签页">
        <Cell caption="文字标签页">
          <Tabs
            label="工具详情"
            value={tab}
            onValueChange={setTab}
            options={[
              { value: 'args', label: '参数' },
              { value: 'output', label: '输出' },
            ]}
            actions={<IconButton label="复制" icon={Copy} size="xs" />}
          />
        </Cell>
        <Cell caption="筛选胶囊">
          <FilterPills
            label="筛选会话"
            value={filter}
            onValueChange={setFilter}
            options={[
              { value: 'all', label: '全部' },
              { value: 'chat', label: '对话' },
              { value: 'agent', label: 'Agent' },
            ]}
          />
        </Cell>
        <Cell caption="悬停" force="hover" at="[aria-pressed='false']">
          <FilterPills
            label="筛选会话"
            value="all"
            onValueChange={() => {}}
            options={[
              { value: 'all', label: '全部' },
              { value: 'chat', label: '对话' },
            ]}
          />
        </Cell>
        <Cell caption="焦点" force="focus-visible" at="[aria-selected='true']">
          <Tabs
            label="工具详情"
            value="args"
            onValueChange={() => {}}
            options={[
              { value: 'args', label: '参数' },
              { value: 'output', label: '输出' },
            ]}
          />
        </Cell>
      </Row>
      <Row label="复选与单选">
        <Checkbox label="管理此 Host" description="模型服务、插件、项目和设备" defaultChecked />
        <Checkbox label="未勾选" />
        <Checkbox label="禁用" disabled defaultChecked />
        <Cell caption="焦点" force="focus-visible" at="input">
          <Checkbox label="复选" defaultChecked />
        </Cell>
        <Radio name="gallery-radio" label="选中" defaultChecked />
        <Radio name="gallery-radio" label="未选中" />
        <Cell caption="焦点" force="focus-visible" at="input">
          <Radio name="gallery-radio-focus" label="单选" defaultChecked />
        </Cell>
      </Row>
      <Row label="单选列表">
        <div className="gallery-choice">
          <ChoiceList
            label="发送消息"
            value={sendKey}
            onValueChange={setSendKey}
            options={[
              { value: 'enter', title: 'Enter 发送', description: 'Shift + Enter 换行' },
              { value: 'mod-enter', title: '⌘/Ctrl + Enter 发送', description: 'Enter 换行，适合输入长段落' },
            ]}
          />
          <ChoiceList
            label="在这台电脑上发起"
            value="L3"
            onValueChange={() => {}}
            options={LEVELS.map(level => ({
              value: level.value,
              title: level.title,
              description: level.description,
              risk: level.risk,
              disabledReason: level.value === 'L0' ? 'goose 无法保证此级别' : undefined,
            }))}
          />
        </div>
      </Row>
      <Row label="单选行">
        <Cell caption="焦点" force="focus-visible" at="[aria-checked='true']">
          <div className="gallery-choice">
            <ChoiceList
              label="发送消息"
              value="enter"
              onValueChange={() => {}}
              options={[
                { value: 'enter', title: 'Enter 发送', description: 'Shift + Enter 换行' },
                { value: 'mod-enter', title: '⌘/Ctrl + Enter 发送', description: 'Enter 换行，适合输入长段落' },
              ]}
            />
          </div>
        </Cell>
        <Cell caption="选中但不可选">
          <div className="gallery-choice">
            <ChoiceList
              label="从手机和其他电脑发起"
              value="L2"
              onValueChange={() => {}}
              options={LEVELS.slice(1, 3).map(level => ({
                value: level.value,
                title: level.title,
                description: level.description,
                disabledReason: level.value === 'L2' ? '不能高于本机发起的上限' : undefined,
              }))}
            />
          </div>
        </Cell>
      </Row>
      <Row label="选中的画法">
        <Cell caption="选项：蓝">
          <span className="gallery-icons">
            <Switch label="选项" checked onCheckedChange={() => {}} />
            <Checkbox aria-label="选项" defaultChecked />
            <Radio aria-label="选项" defaultChecked />
          </span>
        </Cell>
        <Cell caption="视图：中性">
          <span className="gallery-icons">
            <FilterPills label="视图" value="a" onValueChange={() => {}} options={[{ value: 'a', label: '全部' }]} />
            <IconButton label="切换" icon={PanelRight} pressed />
          </span>
        </Cell>
        <Cell caption="列表的选中行：中性">
          <span className="gallery-selected-row">选中的会话</span>
        </Cell>
      </Row>
    </Section>
  )
}

function LiveLayers() {
  const [dialog, setDialog] = useState(false)
  const [dock, setDock] = useState(false)
  const [sheet, setSheet] = useState(false)
  const [form, setForm] = useState(false)
  return (
    <>
      <Button
        onClick={() => {
          setDialog(true)
        }}>
        打开对话框
      </Button>
      <Button
        onClick={() => {
          setDock(true)
        }}>
        打开停靠框
      </Button>
      <Dialog
        open={dock}
        onClose={() => {
          setDock(false)
        }}
        placement="dock"
        secure
        bare
        icon={<Fingerprint size={20} strokeWidth={ICON_STROKE[20]} aria-hidden="true" />}
        title="为设备增加权限"
        footer={
          <Button
            size="md"
            onClick={() => {
              setDock(false)
            }}>
            取消
          </Button>
        }>
        已打开确认窗口。核对窗口里的内容，然后用 Touch ID 或登录密码确认。
      </Dialog>
      <Button
        onClick={() => {
          setSheet(true)
        }}>
        打开底部面板
      </Button>
      <Dialog
        open={dialog}
        onClose={() => {
          setDialog(false)
        }}
        title="确认"
        bare
        footer={
          <>
            <Button
              size="md"
              onClick={() => {
                setDialog(false)
              }}>
              取消
            </Button>
            <Button size="md" variant="primary">
              继续
            </Button>
          </>
        }>
        没有页头和页脚的确认对话框，四边留 24。
      </Dialog>
      <Sheet
        open={sheet}
        title="会话信息"
        onClose={() => {
          setSheet(false)
        }}>
        <p className="gallery-sheet-text">拖动顶部向下关闭，向上展开。</p>
      </Sheet>
      <Button
        onClick={() => {
          setForm(true)
        }}>
        打开新会话面板
      </Button>
      <Sheet
        open={form}
        detent="large"
        title="新会话"
        onClose={() => {
          setForm(false)
        }}
        action={
          <Button variant="primary" disabled>
            开始
          </Button>
        }>
        <p className="gallery-sheet-text">表单类面板一打开就占窗口的 92%。</p>
      </Sheet>
    </>
  )
}

function Layers() {
  return (
    <Section title="对话框、底部面板与浮层">
      <Row label="内容自管的模态层">
        {(['dialog', 'sheet', 'page'] as const).map(variant => (
          <Cell key={variant} caption={variant}>
            <div
              className={`ui-modal ui-modal-${variant}`}
              style={{ width: 300, height: 220, maxWidth: '100%', position: 'relative', margin: 0 }}>
              <div className="ui-modal-surface">
                {variant === 'sheet' && <span className="ui-modal-grabber" />}
                <ModalHeader title="工作台页面" onClose={() => {}} />
                <div className="ui-modal-body ui-modal-sheet-body">
                  <div className="ui-sheet-dialog-body">
                    <p className="ui-confirm-message">页面与表单共用焦点、键盘和关闭行为。</p>
                  </div>
                </div>
                <footer className="ui-modal-footer">
                  <Button>取消</Button>
                  <Button variant="primary">保存</Button>
                </footer>
              </div>
            </div>
          </Cell>
        ))}
      </Row>
      <Row label="打开">
        <LiveLayers />
      </Row>
      <Row label="对话框">
        <Cell caption="确认 480">
          <DialogSurface
            title="删除会话"
            subtitle="修复设置页保存后密钥被清空的问题"
            onClose={() => {}}
            note="此操作无法撤销"
            footer={
              <>
                <Button variant="secondary" size="md">
                  取消
                </Button>
                <Button variant="destroy" size="md">
                  删除
                </Button>
              </>
            }>
            删除这个会话及其全部记录，执行端上也不再保留。
          </DialogSurface>
        </Cell>
        <Cell caption="表单 · 主按钮不可用">
          <DialogSurface
            title="添加项目"
            size="form"
            onClose={() => {}}
            footer={
              <>
                <Button variant="secondary" size="md">
                  取消
                </Button>
                <Button variant="primary" size="md" disabled tooltip="填写路径后可以添加">
                  添加
                </Button>
              </>
            }>
            <TextField label="路径" placeholder="/Users/me/code/latch-app" />
          </DialogSurface>
        </Cell>
        <Cell caption="确认 · 无页头页脚">
          <DialogSurface
            bare
            title="移除这个项目？"
            footer={
              <>
                <Button variant="secondary" size="md">
                  取消
                </Button>
                <Button variant="destroy" size="md">
                  移除
                </Button>
              </>
            }>
            移除后新会话不能再选它，项目目录里的文件不受影响。
          </DialogSurface>
        </Cell>
        <Cell caption="停靠 400 · 状态图块">
          <DialogSurface
            bare
            placement="dock"
            icon={<Fingerprint size={20} strokeWidth={ICON_STROKE[20]} aria-hidden="true" />}
            title="为设备增加权限"
            footer={
              <Button variant="secondary" size="md">
                取消
              </Button>
            }>
            已打开确认窗口。核对窗口里的内容，然后用 Touch ID 或登录密码确认。
          </DialogSurface>
        </Cell>
        <Cell caption="停靠 · 没有执行">
          <DialogSurface
            bare
            placement="dock"
            icon={<X size={20} strokeWidth={ICON_STROKE[20]} aria-hidden="true" />}
            title="为设备增加权限"
            footer={
              <Button variant="secondary" size="md">
                关闭
              </Button>
            }>
            操作没有执行。本机确认没有通过。
          </DialogSurface>
        </Cell>
      </Row>
      <Row label="弹层">
        <Cell caption="内容弹层 · 失败磁贴">
          <div className="ui-popover" role="dialog" aria-label="Agent 状态" style={{ width: 320 }}>
            <div className="gallery-popover">
              <Tile mark={MONO_MARK} size={32} state="failed" label="goose：上次启动失败" />
              <span className="gallery-popover-text">
                <span className="gallery-popover-title">goose</span>
                <span>上次启动失败，退出码 1</span>
              </span>
              <Button variant="link" size="xs">
                Agent 设置
              </Button>
            </div>
          </div>
        </Cell>
        <Cell caption="计数 · 浮层上">
          <div className="ui-popover">
            <span className="gallery-icons">
              <IconButton label="2 项待批准" icon={ShieldAlert} badge={<Count value={2} tone="warn" />} />
              <Tile mark={MONO_MARK} size={24} state="failed" label="goose：上次启动失败" />
            </span>
          </div>
        </Cell>
      </Row>
      <Row label="底部面板">
        <div className="gallery-phone">
          <SheetSurface title="权限" onClose={() => {}}>
            <PickerSheetBody
              label="权限"
              header={{ title: '权限', meta: 'goose · MacBook Pro' }}
              groups={[
                {
                  id: 'levels',
                  options: LEVELS.map(level => ({
                    value: level.value,
                    label: level.title,
                    description: level.description,
                    risk: level.risk,
                    tag: level.value === 'L1' ? <Badge>默认</Badge> : undefined,
                    disabledReason: level.value === 'L2' ? 'goose 无法保证此级别' : undefined,
                  })),
                },
              ]}
              value="L1"
              footer={<MenuFooterNote>调高要在这台电脑上验证身份</MenuFooterNote>}
              onValueChange={() => {}}
            />
          </SheetSurface>
        </div>
        <div className="gallery-phone">
          <SheetSurface title="会话操作" onClose={() => {}}>
            <MenuPanel
              label="会话操作"
              sections={[
                {
                  id: 'actions',
                  items: [
                    { id: 'rename', label: '重命名', icon: Pencil, onSelect: () => {} },
                    { id: 'export', label: '导出 Markdown', icon: Download, onSelect: () => {} },
                    { id: 'delete', label: '删除…', icon: Trash2, danger: true, onSelect: () => {} },
                  ],
                },
              ]}
            />
          </SheetSurface>
        </div>
        <div className="gallery-phone">
          <SheetSurface
            title="修复设置页保存模型服务之后 API Key 会被清空的问题"
            onClose={() => {}}
            action={
              <Button variant="primary" disabled>
                保存
              </Button>
            }>
            <p className="gallery-sheet-text">长标题在两侧按钮之间以省略号结束。</p>
          </SheetSurface>
        </div>
        <div className="gallery-phone">
          <SheetSurface title="计划 1/2" cancelLabel={null} action={<Button variant="secondary">完成</Button>}>
            <ol className="gallery-sheet-card">
              <li>读取设置页的保存逻辑</li>
              <li>修复空密钥被清除的问题</li>
            </ol>
          </SheetSurface>
        </div>
        <div className="gallery-phone">
          <SheetSurface title="运行设置" action={<Button variant="secondary">完成</Button>} onClose={() => {}}>
            <div className="gallery-sheet-card">
              <ValuePicker variant="row" label="模型" value="fixture-large" options={MODELS} onValueChange={() => {}} />
              <ValuePicker
                variant="row"
                label="项目"
                value="latch-app"
                options={[
                  { value: 'latch-app', label: 'latch-app' },
                  { value: 'website', label: 'website' },
                ]}
                onValueChange={() => {}}
              />
            </div>
          </SheetSurface>
        </div>
      </Row>
      <Row label="提示与 Toast">
        <TooltipSurface content="允许一次" shortcut="⌘⏎" />
        <TooltipSurface content="填写名称后可以创建" />
        <Toast duration={null}>已由「我的手机」处理</Toast>
        <Toast tone="error" duration={null}>
          重命名失败，请重试
        </Toast>
      </Row>
    </Section>
  )
}

function Notices() {
  return (
    <Section title="横幅与内联提示">
      <Hint label="OpenCode 自己的设置" defaultOpen>
        Latch 只核对它选的是哪一项，不核对它实际怎么做，也不隔离它。
      </Hint>
      <Hint label="发第一条消息后可以换" />
      <InlineNotice tone="warn" title="连接已中断，正在重连…" action={<Button size="xs">重试</Button>}>
        已显示的内容都在，重连后会补齐这一轮的输出。
      </InlineNotice>
      <InlineNotice tone="error" title="审计记录被回滚" secure action={<Button size="xs">已核对</Button>} onClose={() => {}}>
        上次看到的记录不在了，请在执行端核对。
      </InlineNotice>
      <InlineNotice title="此 Host 仍是旧版本">重启 Host 后启用设备确认。</InlineNotice>
      <InlineNotice
        tone="error"
        title="模型服务出错"
        action={
          <Button size="xs" icon={Copy}>
            复制错误
          </Button>
        }>
        改动已保留在工作区。服务返回 503：服务暂时不可用。
      </InlineNotice>
    </Section>
  )
}

function States() {
  return (
    <Section title="空状态、加载与错误">
      <Row label="空">
        <EmptyState
          title="还没有会话"
          description="新建会话后，会话会保存在这里。"
          action={
            <Button size="xs" icon={SquarePen}>
              新建会话
            </Button>
          }
        />
      </Row>
      <Row label="加载">
        <Loading label="正在读取…" />
        <div className="gallery-page-loading">
          <Loading variant="page" label="正在连接执行端…" />
        </div>
      </Row>
      <Row label="骨架">
        <div className="gallery-skeleton">
          {[180, 140, 200].map(width => (
            <span key={width} className="gallery-inline">
              <Skeleton width={20} height={20} />
              <Skeleton width={width} height={12} round />
            </span>
          ))}
        </div>
      </Row>
      <Row label="界面出错">
        <ErrorState
          title="界面出错，当前内容无法显示。"
          description="会话和草稿都在执行端，重新加载不会丢失。"
          actions={
            <>
              <Button variant="secondary">回到新会话</Button>
              <Button variant="primary" icon={RotateCcw}>
                重新加载
              </Button>
            </>
          }
        />
      </Row>
    </Section>
  )
}

/** Harness choices as tiles: the chosen one, one that cannot be chosen, and the action that adds another. */
function TileChoices() {
  const [value, setValue] = useState('agent')
  const options = [
    { value: 'agent', label: 'Latch 内置', note: 'Agent', tile: <Tile size={40} mark={APP_ICON} />, description: '可以读写项目里的文件' },
    { value: 'chat', label: 'Latch 内置', note: '只对话', tile: <Tile size={40} mark={APP_ICON} />, description: '不读写文件、不运行命令' },
    { value: 'goose', label: 'goose', note: '完全访问', tile: <Tile size={40} mark={MONO_MARK} />, description: '自带模型与登录' },
    {
      value: 'codex',
      label: 'Codex',
      note: '仅本机桌面端',
      tile: <Tile size={40} mark={COLOUR_MARK} state="cold" />,
      disabledReason: '完全访问会话只能在运行 Latch 的电脑上开启',
    },
  ]
  return (
    <Section title="磁贴选择">
      <Row label="一行">
        <Cell caption="选中、可选、不可选，加一项动作">
          <TileChoice label="Agent" value={value} options={options} onValueChange={setValue}>
            <TileAction icon={Plus} label="添加 Agent" note="5 个可添加" />
          </TileChoice>
        </Cell>
      </Row>
      <Row label="紧凑">
        <Cell caption="工作台：图标与标签同一行">
          <TileChoice
            variant="compact"
            label="紧凑 Agent"
            value={value}
            options={options.map(option => ({ ...option, tile: <Tile size={20} mark={APP_ICON} /> }))}
            onValueChange={setValue}>
            <TileAction variant="compact" icon={Plus} label="添加 Agent" />
          </TileChoice>
        </Cell>
      </Row>
      <Row label="状态">
        <Cell caption="悬停" force="hover" at=".ui-tile-choice-item:not([aria-checked='true'])">
          <TileChoice label="Agent 悬停" value="agent" options={options.slice(0, 2)} onValueChange={() => {}} />
        </Cell>
        <Cell caption="键盘聚焦" force="focus-visible" at=".ui-tile-choice-item">
          <TileChoice label="Agent 聚焦" value="agent" options={options.slice(0, 2)} onValueChange={() => {}} />
        </Cell>
        <Cell caption="动作展开">
          <TileAction icon={Plus} label="添加 Agent" note="5 个可添加" aria-expanded />
        </Cell>
        <Cell caption="按下不可选的一项：原因在行下展开">
          <Explained options={options} />
        </Cell>
      </Row>
    </Section>
  )
}

/** A row whose item that cannot be chosen has been pressed, so its reason shows under the row. */
function Explained({ options }: { options: ComponentProps<typeof TileChoice<string>>['options'] }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>('[aria-disabled="true"]')?.click()
  }, [])
  return (
    <div ref={box}>
      <TileChoice label="Agent 原因" value="agent" options={options.filter(option => option.value !== 'goose')} onValueChange={() => {}} />
    </div>
  )
}

function Tiles() {
  const sizes = [16, 20, 24, 32, 40, 56] as const
  return (
    <Section title="磁贴">
      <Row label="单色标志">
        {sizes.map(size => (
          <Cell key={size} caption={String(size)}>
            <Tile size={size} mark={MONO_MARK} />
          </Cell>
        ))}
      </Row>
      <Row label="彩色标志">
        <Cell caption="32">
          <Tile size={32} mark={COLOUR_MARK} />
        </Cell>
        <Cell caption="20">
          <Tile size={20} mark={COLOUR_MARK} />
        </Cell>
        <Cell caption="浅色与深色两份 32">
          <Tile size={32} mark={THEMED_MARK} />
        </Cell>
        <Cell caption="自带留白 32">
          <Tile size={32} mark={MARGIN_MARK} />
        </Cell>
        <Cell caption="应用图标 32">
          <Tile size={32} mark={APP_ICON} />
        </Cell>
        <Cell caption="应用图标 20">
          <Tile size={20} mark={APP_ICON} />
        </Cell>
      </Row>
      <Row label="没有图标时的图形">
        <Cell caption="32">
          <Tile size={32} icon={Plug} />
        </Cell>
        <Cell caption="20">
          <Tile size={20} icon={Puzzle} />
        </Cell>
        <Cell caption="plain 16">
          <Tile size={16} plain icon={Plug} />
        </Cell>
        <Cell caption="单色 plain 16">
          <Tile size={16} plain mark={MONO_MARK} />
        </Cell>
      </Row>
      <Row label="就绪度">
        <Cell caption="就绪">
          <Tile mark={MONO_MARK} size={32} />
        </Cell>
        <Cell caption="不可用">
          <Tile mark={MONO_MARK} size={32} state="cold" />
        </Cell>
        <Cell caption="检测中">
          <Tile mark={MONO_MARK} size={32} state="arriving" />
        </Cell>
        <Cell caption="60%">
          <Tile mark={MONO_MARK} size={32} state="arriving" progress={0.6} />
        </Cell>
        <Cell caption="失败">
          <Tile mark={MONO_MARK} size={32} state="failed" label="goose：上次运行异常" />
        </Cell>
      </Row>
    </Section>
  )
}

/** A sidebar on the ground beside its paper, with the resize handle on the paper's edge, at rest or in a held state. */
function ResizeSample({ force }: { force?: string }) {
  return (
    <Cell caption={force === 'hover' ? '悬停' : force === 'focus-visible' ? '键盘聚焦' : '静止'} force={force} at=".ui-resize-handle">
      <div className="gallery-columns">
        <div className="gallery-column-side" />
        <ResizeHandle label="调整侧栏宽度" value={264} min={220} max={480} onResize={() => {}} onReset={() => {}} onToggle={() => {}} />
        <div className="gallery-column-paper" />
      </div>
    </Cell>
  )
}

/** A side column's edge: the handle at rest (invisible), under a held hover, and with keyboard focus. */
function Resize() {
  return (
    <Section title="调整宽度">
      <Row label="侧栏边缘">
        <ResizeSample />
        <ResizeSample force="hover" />
        <ResizeSample force="focus-visible" />
      </Row>
    </Section>
  )
}

const svg = (body: string, viewBox = '0 0 24 24') =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`)}`

/**
 * Stand-ins for brand marks, as the files a page ships: a one-colour shape (drawn in ink through a mask), one that
 * brings its own colours (placed as it is), a coloured one with the brand's own dark file, one whose file holds a wide
 * margin, and an app icon with its own background and corners.
 */
const MONO_MARK: TileMark = { src: svg('<path fill-rule="evenodd" d="M12 2 22 20H2ZM12 11a3 3 0 1 0 0 6 3 3 0 1 0 0-6Z"/>'), mono: true }
const COLOUR_MARK: TileMark = {
  src: svg('<circle cx="9" cy="12" r="7" fill="#2f80ed"/><circle cx="15" cy="12" r="7" fill="#f2994a" fill-opacity=".85"/>'),
}
const THEMED_MARK: TileMark = {
  src: svg('<rect x="4" y="2" width="16" height="20" fill="#211e1e"/><rect x="8" y="10" width="8" height="8" fill="#cfcecd"/>'),
  dark: svg('<rect x="4" y="2" width="16" height="20" fill="#f1ecec"/><rect x="8" y="10" width="8" height="8" fill="#4b4646"/>'),
}
const MARGIN_MARK: TileMark = {
  src: svg(
    '<path fill="#f09082" d="M7 7h11v7h-4v-4H7z"/><path fill="#4d9abf" d="M7 10h3v4h4v3h-4v3H7z"/><path fill="#f1be58" d="M15 14h3v6h-3z"/>',
  ),
  margin: true,
}
const APP_ICON: TileMark = {
  src: svg(
    '<rect width="24" height="24" rx="4.5" fill="#20202e"/><path d="M8 7l8 5-8 5" fill="none" stroke="#2f80ed" stroke-width="2.4"/>',
  ),
  tile: true,
}

/**
 * Shows `before`, then `after` a frame after mounting, as a change the page saw happen, so the one-shot it drives plays
 * once; the capture shows its still frame, which is the end state.
 */
function Replay<T>({ before, after, children }: { before: T; after: T; children: (value: T) => ReactNode }) {
  const [value, setValue] = useState(before)
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setValue(after)
    })
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [after])
  return <LiveChanges value="gallery">{children(value)}</LiveChanges>
}

/** A row that shows its waiting count only above zero, as the sidebar's 等你处理 row does. */
function Arrival({ value }: { value: number }) {
  const before = useLivePrevious(value)
  return (
    <span className="gallery-inline">
      等你处理
      {value > 0 && <Count value={value} tone="warn" from={before} />}
    </span>
  )
}

const SLOTS: Array<[SlotStatus, string]> = [
  ['running', '运行中'],
  ['waiting', '等你处理'],
  ['failed', '失败'],
  ['unread', '未读'],
  ['time', '时间'],
  ['none', '打开的会话运行中'],
]

/** A few rows of a session list on the sidebar, each with its status slot. */
const SIDEBAR_ROWS: Array<[string, SlotStatus, string?]> = [
  ['补充审批的端到端测试', 'waiting'],
  ['修复设置页密钥丢失', 'none'],
  ['侧栏按项目分组', 'unread'],
  ['升级 Electron 到 44.9', 'failed'],
  ['迁移文档站构建', 'running'],
  ['每日依赖检查', 'time', '09:00'],
]

type ProcessState = 'running' | 'completed' | 'failed'
const PROCESS_WORDS: Record<ProcessState, string> = { running: '执行中', completed: '完成', failed: '失败' }

/** A process row as the session details draw one: the status glyph, the title and the state's words. */
function ProcessRow({ state }: { state: ProcessState }) {
  return (
    <span className="gallery-process">
      <StatusGlyph running={state === 'running'}>
        <Icon icon={Terminal} size={14} />
      </StatusGlyph>
      <span>运行测试</span>
      <StatusWords state={state} className={state === 'failed' ? 'gallery-err' : undefined}>
        {PROCESS_WORDS[state]}
      </StatusWords>
    </span>
  )
}

type PlanState = 'pending' | 'in_progress' | 'completed'

/** A plan step: its still mark changes with its state. */
function PlanStep({ state }: { state: PlanState }) {
  return (
    <span className="gallery-process">
      <StatusGlyph state={state}>
        <Icon icon={state === 'completed' ? Check : state === 'in_progress' ? CircleDot : Circle} size={14} />
      </StatusGlyph>
      <span>补充回归用例</span>
    </span>
  )
}

function Live() {
  return (
    <Section title="状态">
      <Row label="运行中">
        {([12, 14, 16, 20] as const).map(size => (
          <Cell key={size} caption={`转圈 ${size}`}>
            <Spinner size={size} />
          </Cell>
        ))}
        <Cell caption="运行条">
          <span className="gallery-inline">
            <Spinner size={12} />
            正在停止…
          </span>
        </Cell>
      </Row>
      <Row label="状态槽">
        {SLOTS.map(([status, caption]) => (
          <Cell key={status} caption={caption}>
            <StatusSlot status={status} time="2 分钟" />
          </Cell>
        ))}
        <Cell caption="权限模式已变化">
          <StatusSlot status="failed" failed="权限已变化" />
        </Cell>
        <Cell caption="运行中带时间">
          <StatusSlot status="running" running="运行中 1:12" />
        </Cell>
      </Row>
      <Row label="侧栏">
        <Cell caption="每行只说一件事；选中的行是白色卡片">
          <ul className="gallery-sidebar" aria-label="会话">
            {SIDEBAR_ROWS.map(([title, status, time], index) => (
              <li key={title} aria-current={index === 1 ? 'page' : undefined}>
                <span>{title}</span>
                <StatusSlot status={status} time={time} />
              </li>
            ))}
          </ul>
        </Cell>
      </Row>
      <Row label="变化">
        <Cell caption="运行 → 未读：交叉淡化">
          <Replay<SlotStatus> before="running" after="unread">
            {status => <StatusSlot status={status} />}
          </Replay>
        </Cell>
        <Cell caption="未读 → 时间">
          <Replay<SlotStatus> before="unread" after="time">
            {status => <StatusSlot status={status} time="2 分钟" />}
          </Replay>
        </Cell>
        <Cell caption="交叉淡化（定格）">
          <span className="gallery-frame-slot">
            <Replay<SlotStatus> before="waiting" after="running">
              {status => <StatusSlot status={status} />}
            </Replay>
          </span>
        </Cell>
        <Cell caption="计数 +1：新数字淡入">
          <Replay before={2} after={3}>
            {value => <Count value={value} tone="warn" label={`${value} 项等你处理`} />}
          </Replay>
        </Cell>
        <Cell caption="首次到达 0 → 1">
          <Replay before={0} after={1}>
            {value => <Arrival value={value} />}
          </Replay>
        </Cell>
      </Row>
      <Row label="过程行">
        <Cell caption="运行中">
          <ProcessRow state="running" />
        </Cell>
        <Cell caption="完成">
          <ProcessRow state="completed" />
        </Cell>
        <Cell caption="失败">
          <ProcessRow state="failed" />
        </Cell>
        <Cell caption="运行 → 完成：交叉淡化">
          <Replay<ProcessState> before="running" after="completed">
            {state => <ProcessRow state={state} />}
          </Replay>
        </Cell>
        <Cell caption="交叉淡化（定格）">
          <span className="gallery-frame-glyph">
            <Replay<ProcessState> before="running" after="completed">
              {state => <ProcessRow state={state} />}
            </Replay>
          </span>
        </Cell>
        <Cell caption="计划步骤 进行中 → 完成">
          <Replay<PlanState> before="in_progress" after="completed">
            {state => <PlanStep state={state} />}
          </Replay>
        </Cell>
      </Row>
      <Row label="思考">
        <Cell caption="600ms 后每 4 秒扫过一次；离开视野时暂停">
          <Shimmer>正在思考</Shimmer>
        </Cell>
        <Cell caption="扫过中（定格）">
          <span className="gallery-frame-think">
            <Shimmer>正在思考</Shimmer>
          </span>
        </Cell>
      </Row>
    </Section>
  )
}

/** A disclosure with its header, as a tool row or a session-info block draws one. */
function Disclosure({ initial }: { initial: boolean }) {
  const [open, setOpen] = useState(initial)
  return (
    <div className="gallery-disclosure">
      <button
        type="button"
        className="gallery-disclosure-header"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open)
        }}>
        <Icon icon={open ? ChevronDown : ChevronRight} size={14} />
        运行测试
      </button>
      <Collapse
        open={open}
        onReveal={() => {
          setOpen(true)
        }}>
        <p className="gallery-disclosure-body">pnpm test · 116 项通过</p>
      </Collapse>
    </div>
  )
}

function Motion() {
  return (
    <Section title="动效">
      <Row label="展开">
        <Cell caption="收起（页内查找可达）">
          <Disclosure initial={false} />
        </Cell>
        <Cell caption="展开">
          <Disclosure initial />
        </Cell>
      </Row>
      <Row label="替换">
        <Cell caption="复制 → 已复制：缩放淡入">
          <Replay before={false} after>
            {copied => <IconButton label={copied ? '已复制' : '复制'} icon={copied ? Check : Copy} swap />}
          </Replay>
        </Cell>
        <Cell caption="文字：原地淡入">
          <Replay before="live" after="settled">
            {value => (
              <Swap value={value} effect="fade">
                {value === 'live' ? '正在思考' : '思考了 6 秒'}
              </Swap>
            )}
          </Replay>
        </Cell>
      </Row>
    </Section>
  )
}

function Focus() {
  return (
    <Section title="焦点">
      <Row label="所在面">
        <Cell caption="画布" force="focus-visible">
          <Button variant="outline">拒绝</Button>
        </Cell>
        <Cell caption="侧栏" force="focus-visible" at=".ui-button">
          <div className="gallery-ground">
            <Button variant="ghost" icon={X}>
              关闭
            </Button>
          </div>
        </Cell>
        <Cell caption="浮起" force="focus-visible" at=".ui-button">
          <div className="gallery-raised">
            <Button variant="primary">允许一次</Button>
          </div>
        </Cell>
      </Row>
    </Section>
  )
}

export function Gallery() {
  return (
    <main className="gallery" aria-label="@latch/ui">
      <header className="gallery-header">
        <h1>Latch 界面原语</h1>
        <p>蓝色只给动作、焦点与勾选，琥珀只表示等你处理，红色只表示真实的失败与风险；状态是一个词，最多带一个图形。</p>
      </header>
      <div className="gallery-grid">
        <Buttons />
        <Pills />
        <Meters />
        <Pickers />
        <Inputs />
        <Choices />
        <Layers />
        <Notices />
        <States />
        <Live />
        <Motion />
        <Tiles />
        <TileChoices />
        <Resize />
        <Icons />
        <Focus />
        <Kit />
      </div>
    </main>
  )
}
