import { useState } from 'react'
import { Fingerprint } from 'lucide-react'
import {
  Button,
  Collapse,
  CopyButton,
  Group,
  ProgressBar,
  Row as GroupRow,
  Scrim,
  Toast,
  TooltipSurface,
  keyGlyphs,
  Drawer,
  DrawerStack,
  FoldHeader,
  IconButton,
  LiveChanges,
  MenuPanel,
  PanelTabs,
  SegmentedControl,
  SelectButton,
  Shimmer,
  SplitButton,
  StatusSlot,
  Tile,
  type PanelTab,
  FileGlyph,
  CommitGlyph,
  GlobeGlyph,
  PlusGlyph,
  TrashGlyph,
  MoreGlyph,
  ArchiveGlyph,
  ModelGlyph,
} from '../../src/index.ts'
import { Cell, Row, Section } from './parts.tsx'

const GIT_MENU = [
  {
    id: 'git',
    items: [
      { id: 'push', label: '推送', onSelect: () => {} },
      { id: 'branch', label: '新建分支', icon: PlusGlyph, onSelect: () => {} },
    ],
  },
]

function Actions() {
  return (
    <Section title="动作的进行与完成">
      <Row label="分体按钮">
        <Cell caption="描边">
          <SplitButton icon={CommitGlyph} menuLabel="更多 Git 操作" sections={GIT_MENU}>
            提交
          </SplitButton>
        </Cell>
        <Cell caption="主">
          <SplitButton variant="primary" size="md" menuLabel="更多提交方式" sections={GIT_MENU}>
            提交 3 个文件
          </SplitButton>
        </Cell>
        <Cell caption="菜单仍可用" force="hover" at=".ui-split-more">
          <SplitButton disabled tooltip="没有改动可提交" menuLabel="更多 Git 操作" sections={GIT_MENU}>
            提交
          </SplitButton>
        </Cell>
        <Cell caption="菜单不可用">
          <SplitButton size="xs" disabled menuDisabled menuLabel="更多 Git 操作" sections={GIT_MENU}>
            提交
          </SplitButton>
        </Cell>
      </Row>
      <Row label="系统表单">
        <Cell caption="等待（有图标）">
          <Button variant="primary" icon={Fingerprint} pending>
            用 Touch ID 允许
          </Button>
        </Cell>
        <Cell caption="等待（无图标）">
          <Button variant="primary" pending>
            允许
          </Button>
        </Cell>
        <Cell caption="完成">
          <Button done doneLabel="已允许" variant="outline">
            允许
          </Button>
        </Cell>
        <Cell caption="完成（主）">
          <Button done doneLabel="已允许" variant="primary">
            允许
          </Button>
        </Cell>
      </Row>
      <Row label="设置行的值">
        <Cell caption="图块">
          <SelectButton leading={<Tile size={16} icon={ModelGlyph} />}>通用</SelectButton>
        </Cell>
        <Cell caption="图标">
          <SelectButton icon={GlobeGlyph}>简体中文</SelectButton>
        </Cell>
        <Cell caption="需要处理">
          <SelectButton tone="warn">模型已不可用</SelectButton>
        </Cell>
        <Cell caption="不可用">
          <SelectButton disabled>跟随系统</SelectButton>
        </Cell>
      </Row>
      <Row label="24 分段">
        <Cell caption="xs">
          <SegmentedControl
            label="差异布局"
            size="xs"
            value="auto"
            options={[
              { value: 'auto', label: '自动' },
              { value: 'unified', label: '上下' },
              { value: 'split', label: '左右' },
            ]}
            onValueChange={() => {}}
          />
        </Cell>
      </Row>
    </Section>
  )
}

const TABS: Array<PanelTab<string>> = [
  { value: 'changes', label: '改动', icon: CommitGlyph, stat: { added: 60, removed: 6 } },
  { value: 'files', label: '文件', icon: FileGlyph },
  { value: 'deck', label: 'presentation-template.html', icon: FileGlyph, closeLabel: '关闭 presentation-template.html', fresh: true },
  { value: 'notes', label: 'notes.md', icon: FileGlyph, closeLabel: '关闭 notes.md' },
]

function Panels() {
  const [value, setValue] = useState('changes')
  const [tabs, setTabs] = useState(TABS)
  return (
    <Section title="面板标签">
      <Row label="标签条">
        <Cell caption="统计、新内容与关闭">
          <PanelTabs
            label="面板"
            value={value}
            tabs={tabs}
            onValueChange={setValue}
            onClose={closed => {
              setTabs(list => list.filter(tab => tab.value !== closed))
            }}
            actions={<IconButton label="关闭面板" icon={TrashGlyph} size="xs" />}
          />
        </Cell>
        <Cell caption="悬停：图标变为 ×" force="hover" at=".ui-panel-tab[data-closable]">
          <PanelTabs label="面板 2" value="deck" tabs={TABS.slice(2)} onValueChange={() => {}} />
        </Cell>
        <Cell caption="放不下：其余的收进 +N，当前标签留在行里">
          <div style={{ width: 240 }}>
            <PanelTabs label="面板 4" value={TABS.at(-1)!.value} tabs={TABS} onValueChange={() => {}} />
          </div>
        </Cell>
        <Cell caption="末尾的 +：打开菜单，字母键直接选">
          <div style={{ display: 'grid', gap: 'var(--sp-8)', width: 320 }}>
            <PanelTabs
              label="面板 5"
              value="files"
              tabs={TABS.slice(0, 2)}
              onValueChange={() => {}}
              add={<IconButton label="打开面板" icon={PlusGlyph} size="xs" />}
            />
            <div className="ui-popover" style={{ width: 200 }}>
              <MenuPanel
                label="打开面板"
                sections={[
                  {
                    id: 'open',
                    items: [
                      { id: 'browser', label: '浏览器', icon: GlobeGlyph, accelerator: 'B', onSelect: () => {} },
                      { id: 'files', label: '文件', icon: FileGlyph, accelerator: 'F', onSelect: () => {} },
                      { id: 'changes', label: '改动', icon: CommitGlyph, accelerator: 'D', onSelect: () => {} },
                    ],
                  },
                ]}
              />
            </div>
          </div>
        </Cell>
        <Cell caption="可关闭但没有图标：× 有自己的一格" force="hover" at=".ui-panel-tab[data-closable]">
          <PanelTabs
            label="面板 3"
            value="notes"
            tabs={[{ value: 'notes', label: 'notes.md', closeLabel: '关闭 notes.md' }]}
            onValueChange={() => {}}
          />
        </Cell>
      </Row>
    </Section>
  )
}

function Waiting({ text, count }: { text: string; count?: string }) {
  return (
    <div className="gallery-drawer-line">
      <span>
        {text} {count}
      </span>
      <Button size="xs" variant="outline">
        拒绝
      </Button>
      <Button size="xs" variant="primary">
        允许
      </Button>
    </div>
  )
}

/** A composer's card under its stack, above the drawers in stacking order as a composer's is. */
function Card() {
  return <div className="gallery-composer">输入内容会拒绝并告诉 Agent 改做什么</div>
}

function Drawers() {
  const [count, setCount] = useState(1)
  return (
    <Section title="附在输入框上的抽屉">
      <Row label="一个">
        <Cell caption="等你处理">
          <div className="gallery-drawers">
            <DrawerStack>
              <Drawer key="a" label="等你处理">
                <Waiting text="写入 Sidebar.tsx" count="1/2" />
              </Drawer>
            </DrawerStack>
            <Card />
          </div>
        </Cell>
        <Cell caption="中性">
          <div className="gallery-drawers">
            <DrawerStack>
              <Drawer key="a" label="接下来">
                <div className="gallery-drawer-line">
                  <span>接下来 · 2</span>
                </div>
              </Drawer>
            </DrawerStack>
            <Card />
          </div>
        </Cell>
      </Row>
      <Row label="叠放">
        <Cell caption="每张都完整，间隔 8px">
          <div className="gallery-drawers">
            <DrawerStack>
              <Drawer key="q" label="接下来">
                <div className="gallery-drawer-line">
                  <span>接下来 · 2</span>
                </div>
              </Drawer>
              <Drawer key="a" label="等你处理">
                <Waiting text="运行 git push" />
              </Drawer>
            </DrawerStack>
            <Card />
          </div>
        </Cell>
        <Cell caption="点按钮看滑入与滑出">
          <LiveChanges.Provider value="gallery">
            <div className="gallery-drawers">
              <DrawerStack>
                {Array.from({ length: count }, (_, index) => (
                  <Drawer key={index} label="等你处理">
                    <Waiting text={`第 ${index + 1} 项`} />
                  </Drawer>
                ))}
              </DrawerStack>
              <Card />
            </div>
          </LiveChanges.Provider>
          <div className="gallery-drawer-line">
            <Button
              size="xs"
              onClick={() => {
                setCount(value => value + 1)
              }}>
              再来一项
            </Button>
            <Button
              size="xs"
              onClick={() => {
                setCount(value => Math.max(0, value - 1))
              }}>
              处理一项
            </Button>
          </div>
        </Cell>
      </Row>
    </Section>
  )
}

function Slots() {
  const [open, setOpen] = useState(true)
  return (
    <Section title="行的状态位与折叠">
      <Row label="状态位">
        <Cell caption="静止">
          <div className="gallery-status-row" data-status-row="">
            <span>修复 provider 密钥</span>
            <StatusSlot
              status="running"
              running="运行中 1:12"
              actions={
                <>
                  <IconButton label="归档" icon={ArchiveGlyph} size="xs" />
                  <IconButton label="更多" icon={MoreGlyph} size="xs" />
                </>
              }
            />
          </div>
        </Cell>
        <Cell caption="悬停：让位给动作" force="hover" at="[data-status-row]">
          <div className="gallery-status-row" data-status-row="">
            <span>修复 provider 密钥</span>
            <StatusSlot
              status="time"
              time="2 分钟"
              actions={
                <>
                  <IconButton label="归档" icon={ArchiveGlyph} size="xs" />
                  <IconButton label="更多" icon={MoreGlyph} size="xs" />
                </>
              }
            />
          </div>
        </Cell>
      </Row>
      <Row label="折叠头">
        <Cell caption="展开">
          <div className="gallery-fold">
            <FoldHeader open={open} onOpenChange={setOpen} meta="4 步">
              已工作 2 分 13 秒
            </FoldHeader>
            <Collapse open={open}>
              <p className="gallery-disclosure-body">读取 3 个文件，编辑 1 个文件。</p>
            </Collapse>
          </div>
        </Cell>
        <Cell caption="收起">
          <div className="gallery-fold">
            <FoldHeader open={false} onOpenChange={() => {}}>
              已工作 47 秒
            </FoldHeader>
          </div>
        </Cell>
      </Row>
      <Row label="运行中的文字">
        <Cell caption="思考">
          <Shimmer>正在思考</Shimmer>
        </Cell>
        <Cell caption="工作">
          <Shimmer variant="working">运行中</Shimmer>
        </Cell>
      </Row>
    </Section>
  )
}

function Feedback() {
  return (
    <Section title="复制、进度与提示">
      <Row label="复制">
        <Cell caption="点一下：对勾与「已复制」">
          <CopyButton text="latch" label="复制路径" />
        </Cell>
        <Cell caption="紧凑">
          <CopyButton text="latch" label="复制回复" size="xs" />
        </Cell>
      </Row>
      <Row label="进度">
        <Cell caption="加载中">
          <div className="gallery-progress">
            <ProgressBar active />
          </div>
        </Cell>
      </Row>
      <Row label="提示的字">
        <Cell caption="标签 (⌘X)">
          <TooltipSurface content="侧边面板" shortcut={keyGlyphs('alt+mod+b', true)} />
        </Cell>
        <Cell caption="其他平台">
          <TooltipSurface content="新会话" shortcut={keyGlyphs('mod+n', false)} />
        </Cell>
      </Row>
      <Row label="底部提示">
        <Cell caption="2.2 秒后消失">
          <div className="gallery-toast">
            <Toast duration={null} placement="bottom">
              已由「iPhone」处理
            </Toast>
          </div>
        </Cell>
      </Row>
      <Row label="遮罩">
        <Cell caption="滑出层背后">
          <div className="gallery-scrim">
            <Scrim open label="关闭会话列表" onDismiss={() => {}} />
          </div>
        </Cell>
      </Row>
      <Row label="滚动条">
        <Cell caption="静止时隐藏">
          <div className="gallery-scroller" tabIndex={0} aria-label="静止的列表">
            <div />
          </div>
        </Cell>
        <Cell caption="滚动时显示">
          <div className="gallery-scroller ui-scrolling" tabIndex={0} aria-label="滚动中的列表">
            <div />
          </div>
        </Cell>
      </Row>
    </Section>
  )
}

function Settings() {
  return (
    <Section title="设置分组">
      <div className="gallery-group">
        <Group
          title="通用"
          description="这些选项只影响这台设备。"
          action={
            <Button size="xs" variant="ghost">
              重置
            </Button>
          }>
          <GroupRow title="主题" description="跟随系统时随系统切换">
            <SelectButton>跟随系统</SelectButton>
          </GroupRow>
          <GroupRow title="默认模型" leading={<Tile size={24} icon={ModelGlyph} />}>
            <SelectButton leading={<Tile size={16} icon={ModelGlyph} />}>通用</SelectButton>
          </GroupRow>
          <p className="gallery-note">不是行的内容也有内边距。</p>
        </Group>
      </div>
    </Section>
  )
}

/** Further primitives, in the same grid. */
export function Kit() {
  return (
    <>
      <Actions />
      <Panels />
      <Drawers />
      <Slots />
      <Feedback />
      <Settings />
    </>
  )
}
