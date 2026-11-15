import { useEffect, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import {
  Backdrop,
  BranchGlyph,
  Button,
  ChecksBar,
  Fact,
  FailedGlyph,
  Icon,
  KeyHint,
  LATCH_GLYPHS,
  LiveChanges,
  LiveDot,
  PillMove,
  Roll,
  RunningEdge,
  RunningGlyph,
  SMALL_GLYPHS,
  SectionTitle,
  Spinner,
  StatusStrip,
  Switch,
  TickFrame,
  WaitingGlyph,
  crossFade,
  enter,
  exit,
  flip,
  moveLane,
  resolveAndRise,
  sendLift,
  sheenOnce,
  stagger,
  useStreamingLayer,
  type BackdropKind,
  type BackdropLevel,
} from '../../src/index.ts'
import { Cell, Row, Section } from './parts.tsx'

/*
 * The v9 foundation: the moves, the small parts and the background layer, each in the state a still capture can show.
 * A move's cell shows where it ends, with a button that plays it; the frames that only exist while a move runs (the
 * cover of a resolved card, the light across a finished action, a figure half rolled) are held by the gallery's layout.
 */

/** A sample with the button that plays its move. */
function Play({ name, children }: { name: string; children: (play: (run: () => void) => ReactNode) => ReactNode }) {
  return (
    <span className="gallery-move">
      {children(run => (
        <Button size="xs" variant="ghost" onClick={run}>{`播放 ${name}`}</Button>
      ))}
    </span>
  )
}

const ROWS = ['升级 vite 到 7', '修复保存后密钥被清空', '补两条用例']

function EnterExit() {
  const row = useRef<HTMLSpanElement>(null)
  return (
    <Play name="进入">
      {play => (
        <>
          <span ref={row} className="gallery-move-row">
            {ROWS[0]}
          </span>
          {play(() => {
            if (row.current) enter(row.current)
          })}
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              const element = row.current
              if (element) void exit(element).then(left => left && enter(element))
            }}>
            播放 离开
          </Button>
        </>
      )}
    </Play>
  )
}

function Resolve() {
  const [cards, setCards] = useState(ROWS)
  const list = useRef<HTMLDivElement>(null)
  return (
    <Play name="处理完">
      {play => (
        <>
          <div ref={list} className="gallery-move-list">
            {cards.map(card => (
              <span key={card} className="gallery-move-card">
                {card}
              </span>
            ))}
          </div>
          {play(() => {
            const [first, ...rest] = Array.from(list.current?.children ?? []) as HTMLElement[]
            if (!first) {
              setCards(ROWS)
              return
            }
            void resolveAndRise(first, rest, () => {
              flushSync(() => {
                setCards(current => current.slice(1))
              })
            })
          })}
        </>
      )}
    </Play>
  )
}

function Lanes() {
  const [done, setDone] = useState(false)
  const lanes = useRef<HTMLDivElement>(null)
  return (
    <Play name="换道">
      {play => (
        <>
          <div ref={lanes} className="gallery-move-lanes">
            <div className="gallery-move-list">
              <span className="gallery-move-row">{ROWS[1]}</span>
              {!done && (
                <span className="gallery-move-row" data-moving>
                  {ROWS[0]}
                </span>
              )}
            </div>
            <div className="gallery-move-list">
              {done && (
                <span className="gallery-move-row" data-moving>
                  {ROWS[0]}
                </span>
              )}
              <span className="gallery-move-row">{ROWS[2]}</span>
            </div>
          </div>
          {play(() => {
            const root = lanes.current
            const row = root?.querySelector<HTMLElement>('[data-moving]')
            if (!root || !row) return
            const others = Array.from(root.querySelectorAll<HTMLElement>('.gallery-move-row:not([data-moving])'))
            void moveLane(row, others, () => {
              flushSync(() => {
                setDone(current => !current)
              })
              return root.querySelector<HTMLElement>('[data-moving]')
            })
          })}
        </>
      )}
    </Play>
  )
}

function Reorder() {
  const [order, setOrder] = useState(ROWS)
  const list = useRef<HTMLDivElement>(null)
  return (
    <Play name="重排">
      {play => (
        <>
          <div ref={list} className="gallery-move-list">
            {order.map(row => (
              <span key={row} className="gallery-move-row">
                {row}
              </span>
            ))}
          </div>
          {play(() => {
            flip(Array.from(list.current?.children ?? []) as HTMLElement[], () => {
              flushSync(() => {
                setOrder(current => [...current.slice(1), current[0]!])
              })
            })
          })}
        </>
      )}
    </Play>
  )
}

function LayoutFade() {
  const [side, setSide] = useState(true)
  return (
    <Play name="布局切换">
      {play => (
        <>
          <span className="gallery-move-layout" data-layout={side ? 'side' : 'top'}>
            <i />
            <i />
          </span>
          {play(() => {
            void crossFade(() => {
              flushSync(() => {
                setSide(current => !current)
              })
            })
          })}
        </>
      )}
    </Play>
  )
}

function MenuItems() {
  const menu = useRef<HTMLDivElement>(null)
  return (
    <Play name="菜单错开">
      {play => (
        <>
          <div ref={menu} className="gallery-move-list gallery-raised">
            {['/review', '/test', '/plan', '/compact'].map(command => (
              <span key={command} className="gallery-move-row">
                <Fact>{command}</Fact>
              </span>
            ))}
          </div>
          {play(() => {
            stagger(Array.from(menu.current?.children ?? []) as HTMLElement[])
          })}
        </>
      )}
    </Play>
  )
}

function Pill() {
  const [show, setShow] = useState(true)
  return (
    <span className="gallery-move">
      <span className="gallery-move-slot">
        <PillMove show={show}>
          <span className="gallery-move-pill">回到最新</span>
        </PillMove>
      </span>
      <Button
        size="xs"
        variant="ghost"
        onClick={() => {
          setShow(current => !current)
        }}>
        播放 药丸
      </Button>
    </span>
  )
}

function Send() {
  const input = useRef<HTMLSpanElement>(null)
  const message = useRef<HTMLSpanElement>(null)
  return (
    <Play name="发送">
      {play => (
        <>
          <span className="gallery-move-send">
            <span ref={message} className="gallery-move-bubble">
              修一下保存逻辑
            </span>
            <span ref={input} className="gallery-move-input" />
          </span>
          {play(() => {
            if (input.current && message.current) sendLift(message.current, input.current.getBoundingClientRect())
          })}
        </>
      )}
    </Play>
  )
}

function Counts() {
  const [count, setCount] = useState(4)
  return (
    <span className="gallery-move">
      <LiveChanges value="gallery">
        <span className="gallery-move-figure">
          <Roll value={count} label={`等你处理 ${count} 件`} />
        </span>
      </LiveChanges>
      <Button
        size="xs"
        variant="ghost"
        onClick={() => {
          setCount(current => current - 1)
        }}>
        减一
      </Button>
      <Button
        size="xs"
        variant="ghost"
        onClick={() => {
          setCount(current => current + 1)
        }}>
        加一
      </Button>
    </span>
  )
}

/** A count shown as it changes once after mounting, so the roll's frames exist; the layout holds them halfway. */
function HeldRoll() {
  const [count, setCount] = useState(4)
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setCount(3)
    })
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [])
  return (
    <LiveChanges value="gallery">
      <span className="gallery-move-figure gallery-frame-roll">
        <Roll value={count} />
      </span>
    </LiveChanges>
  )
}

function Sheen() {
  const button = useRef<HTMLButtonElement>(null)
  return (
    <span className="gallery-move">
      <Button ref={button} variant="primary">
        允许写入
      </Button>
      <Button
        size="xs"
        variant="ghost"
        onClick={() => {
          if (button.current) sheenOnce(button.current)
        }}>
        播放 完成的光
      </Button>
    </span>
  )
}

function Rule() {
  const [turn, setTurn] = useState(0)
  return (
    <span className="gallery-move gallery-move-wide">
      <LiveChanges value="gallery">
        <SectionTitle key={turn} title="等你处理" count={4} lead={<Icon icon={WaitingGlyph} size={16} />} />
      </LiveChanges>
      <Button
        size="xs"
        variant="ghost"
        onClick={() => {
          setTurn(current => current + 1)
        }}>
        播放 标题线
      </Button>
    </span>
  )
}

function Moves() {
  return (
    <Section title="v9 动效">
      <Row label="行与卡">
        <Cell caption="行进入 160 · 离开 112">
          <EnterExit />
        </Cell>
        <Cell caption="处理完：遮片 140，其余上升 200">
          <Resolve />
        </Cell>
        <Cell caption="遮片扫到一半">
          <span className="gallery-move-card" data-resolving="">
            {ROWS[0]}
            <i className="ui-wipe gallery-frame-wipe" aria-hidden="true" />
          </span>
        </Cell>
        <Cell caption="换道：出 112，让位 200，进 160">
          <Lanes />
        </Cell>
        <Cell caption="重排 200">
          <Reorder />
        </Cell>
      </Row>
      <Row label="面">
        <Cell caption="布局切换：整窗交叉淡化 160">
          <LayoutFade />
        </Cell>
        <Cell caption="菜单条目错开 18，最多 8 条">
          <MenuItems />
        </Cell>
        <Cell caption="药丸：升起 420，离开 112">
          <Pill />
        </Cell>
        <Cell caption="发送：从输入框升到对话里 320">
          <Send />
        </Cell>
      </Row>
      <Row label="控件">
        <Cell caption="按压：按 80，松 420">
          <button type="button" className="ui-press gallery-move-chip">
            Codex
          </button>
        </Cell>
        <Cell caption="按下" force="active">
          <button type="button" className="ui-press gallery-move-chip">
            Codex
          </button>
        </Cell>
        <Cell caption="完成的一道光，一次">
          <Sheen />
        </Cell>
        <Cell caption="光过到一半">
          <Button variant="primary">
            允许写入
            <i className="ui-sheen" aria-hidden="true">
              <i className="gallery-frame-sheen" />
            </i>
          </Button>
        </Cell>
      </Row>
      <Row label="读数与线">
        <Cell caption="数字滚动 240">
          <Counts />
        </Cell>
        <Cell caption="滚到一半">
          <HeldRoll />
        </Cell>
        <Cell caption="标题线：从左画出 420">
          <Rule />
        </Cell>
      </Row>
      <Row label="活的">
        <Cell caption="运行行的活动边">
          <span className="gallery-move-running">
            <Spinner size={12} />
            {ROWS[0]}
            <Fact>1:12</Fact>
            <RunningEdge />
          </span>
        </Cell>
        <Cell caption="连接点：在线 / 离线">
          <span className="gallery-inline">
            <LiveDot live label="在线" />
            MacBook Pro
            <LiveDot live={false} label="离线" />
            Mac mini
          </span>
        </Cell>
      </Row>
    </Section>
  )
}

function Parts() {
  return (
    <Section title="v9 事实与小部件">
      <Row label="事实">
        <Cell caption="用时、计数、分支、路径">
          <span className="gallery-inline">
            <Fact>1:12</Fact>
            <Fact>未提交 7</Fact>
            <Fact tone="add">+61</Fact>
            <Fact tone="del">−4</Fact>
            <Icon icon={BranchGlyph} size={12} />
            <Fact>fix/keep-api-key</Fact>
          </span>
        </Cell>
      </Row>
      <Row label="检查分段条">
        <Cell caption="4/6">
          <span className="gallery-inline">
            <Fact>检查 4/6</Fact>
            <ChecksBar passed={4} total={6} />
          </span>
        </Cell>
        <Cell caption="6/6">
          <span className="gallery-inline">
            <Fact>检查 6/6</Fact>
            <ChecksBar passed={6} total={6} />
          </span>
        </Cell>
        <Cell caption="3/6，1 项失败">
          <span className="gallery-inline">
            <Icon icon={FailedGlyph} size={12} />
            <Fact>检查 3/6</Fact>
            <ChecksBar passed={3} failed={1} total={6} />
          </span>
        </Cell>
        <Cell caption="没有检查：不画">
          <span className="gallery-inline">
            <Fact>未提交 2</Fact>
            <ChecksBar passed={0} total={0} />
          </span>
        </Cell>
      </Row>
      <Row label="状态条">
        <Cell caption="只写传给它的事实">
          <div className="gallery-move-wide">
            <StatusStrip
              label="连接"
              facts={[
                { id: 'computer', text: 'MacBook Pro', lead: <LiveDot live /> },
                { id: 'link', text: 'host.sock' },
                { id: 'online', text: '2 台在线' },
                { id: 'palette', text: '⌘K', end: true },
              ]}
            />
          </div>
        </Cell>
      </Row>
      <Row label="带线的标题">
        <Cell caption="图标、标题、计数、动作">
          <div className="gallery-move-wide">
            <SectionTitle
              title="进行中"
              count={3}
              lead={<Icon icon={RunningGlyph} size={16} />}
              action={
                <Button size="xs" variant="ghost">
                  全部会话
                </Button>
              }
            />
          </div>
        </Cell>
        <Cell caption="0 件：变淡，不写句子">
          <div className="gallery-move-wide">
            <SectionTitle title="可交付" count={0} />
          </div>
        </Cell>
      </Row>
      <Row label="角标">
        <Cell caption="按键作用在这张卡">
          <TickFrame on className="gallery-move-ticked">
            <span className="gallery-move-card">写入 docs/settings.md</span>
          </TickFrame>
        </Cell>
        <Cell caption="到位时向内收 6">
          <TickFrame on lock className="gallery-move-ticked">
            <span className="gallery-move-card">写入 docs/settings.md</span>
          </TickFrame>
        </Cell>
        <Cell caption="不在这张卡">
          <TickFrame on={false} className="gallery-move-ticked">
            <span className="gallery-move-card">核对 codesign 的结果</span>
          </TickFrame>
        </Cell>
      </Row>
      <Row label="键位提示">
        <Cell caption="按住 ⌘、⏎ 或 1 就亮">
          <span className="gallery-inline">
            <KeyHint keys={['mod', 'enter']} />
            <KeyHint keys={['1']} />
            <KeyHint keys={['esc']} />
          </span>
        </Cell>
        <Cell caption="主按钮上">
          <Button variant="primary">
            允许写入
            <KeyHint keys={['mod', 'enter']} />
          </Button>
        </Cell>
      </Row>
      <Row label="12px 另画">
        <Cell caption="12 / 16">
          <span className="gallery-icons">
            {SMALL_GLYPHS.map(name => (
              <span key={name} className="gallery-icons">
                <Icon icon={LATCH_GLYPHS[name]} size={12} />
                <Icon icon={LATCH_GLYPHS[name]} size={16} />
              </span>
            ))}
          </span>
        </Cell>
      </Row>
    </Section>
  )
}

const KINDS: Array<[BackdropKind, string]> = [
  ['grid', '点阵'],
  ['field', '粒子场'],
  ['glow', '柔光'],
]

function Stage({
  kind,
  level,
  focus = false,
  secure = false,
}: {
  kind: BackdropKind
  level: BackdropLevel
  focus?: boolean
  secure?: boolean
}) {
  const input = useRef<HTMLSpanElement>(null)
  return (
    <span className="gallery-backdrop ui-backdrop-host">
      <Backdrop kind={kind} level={level} running={2} focus={focus} focusTarget={input} />
      <span ref={input} className="gallery-backdrop-card" data-secure={secure ? '' : undefined}>
        {secure ? '安全界面：上下都不画' : focus ? '专注输入' : '不透明的卡'}
      </span>
    </span>
  )
}

/** While this is on, a layer on which text streams is in view: every background layer and every loop holds still. */
function StreamingSwitch() {
  const [streaming, setStreaming] = useState(true)
  const layer = useRef<HTMLSpanElement>(null)
  useStreamingLayer(layer, streaming)
  return (
    <span ref={layer} className="gallery-inline">
      <Switch label="视野里有流式输出" checked={streaming} onCheckedChange={setStreaming} />
      视野里有流式输出
    </span>
  )
}

function Backdrops() {
  return (
    <Section title="v9 背景层">
      <Row label="暂停">
        <Cell caption="流式输出在视野里：背景与循环停在一帧">
          <StreamingSwitch />
        </Cell>
      </Row>
      {KINDS.map(([kind, name]) => (
        <Row key={kind} label={name}>
          <Cell caption="标准">
            <Stage kind={kind} level="standard" />
          </Cell>
          <Cell caption="轻">
            <Stage kind={kind} level="light" />
          </Cell>
          <Cell caption="专注输入">
            <Stage kind={kind} level="standard" focus />
          </Cell>
        </Row>
      ))}
      <Row label="边界">
        <Cell caption="安全界面">
          <Stage kind="field" level="standard" secure />
        </Cell>
        <Cell caption="关：没有这一层">
          <Stage kind="field" level="off" />
        </Cell>
      </Row>
    </Section>
  )
}

export function V9() {
  return (
    <>
      <Moves />
      <Parts />
      <Backdrops />
    </>
  )
}
