// What the Host hands to a page draft: the SDK's declarations (written into `latch-app/sdk.d.ts` and used for the
// build's type check), the guide an Agent reads (`latch-app/README.md`) and the manifest skeleton. The declarations
// describe `@latch/app-sdk` (packages/app-sdk/src/index.ts, bridge.ts, ui.tsx) and the bridge types of
// `@latch/protocol` (app-bridge.ts); keep them in step when either changes.

/** The SDK as a page author sees it, plus the asset imports the build accepts. */
export const APP_SDK_DTS = `// Latch 页面 SDK（@latch/app-sdk 1.x）的声明。由 Latch 写入；构建时用 Latch 自带的这一份，改这里不起作用。
declare module '@latch/app-sdk' {
  import type { ComponentType, ReactNode } from 'react'

  export const APP_SDK_VERSION: string
  export type AppErrorCode =
    | 'capability-denied'
    | 'forbidden'
    | 'offline'
    | 'unknown'
    | 'rate-limited'
    | 'invalid-input'
    | 'not-found'
    | 'preview'

  export class AppBridgeError extends Error {
    readonly code: AppErrorCode
    readonly requestId: string | undefined
    readonly version: number | undefined
    constructor(code: AppErrorCode, requestId?: string, version?: number)
  }

  export interface AppTask {
    id: string
    title: string
    status: 'idle' | 'running' | 'waiting-approval' | 'cancelled' | 'failed' | 'interrupted'
    running: boolean
    runOutcome?: 'completed' | 'failed' | 'cancelled' | 'interrupted'
    projectId?: string
    projectName?: string
    harnessId: string
    originApp?: string
    updatedAt: string
  }
  export interface AppTaskFilter {
    projectId?: string
    mine?: boolean
    limit?: number
  }
  export interface AppHostInfo {
    sdk: string
    appProtocol: number
    theme: 'light' | 'dark'
    offline: boolean
    canRun: boolean
  }
  export interface AppStorageDocument {
    scope: string
    key: string
    version: number
    value: unknown
    updatedAt: string
  }
  export type AppLookup = { status: 'found'; sessionId: string } | { status: 'pending' } | { status: 'not-found' }
  export interface AppLastReply {
    sessionId: string
    status: string
    runOutcome?: string
    reply?: { messageId: string; text: string; truncated?: true }
  }
  export interface TaskUpdate {
    offline: boolean
    tasks: AppTask[]
  }

  export interface Latch {
    tasks: {
      list(filter?: AppTaskFilter): Promise<AppTask[]>
      subscribe(filter: AppTaskFilter | undefined, listener: (update: TaskUpdate) => void): () => void
      start(input: { prompt: string; title?: string; projectId?: string; harnessId?: string; requestId?: string }): Promise<{
        sessionId: string
        requestId: string
      }>
      continue(sessionId: string, input: { prompt: string; requestId?: string }): Promise<{ requestId: string }>
      lookup(requestId: string): Promise<AppLookup>
      readReply(sessionId: string): Promise<AppLastReply>
    }
    storage: {
      get(scope: string, key: string): Promise<AppStorageDocument | undefined>
      list(scope: string): Promise<AppStorageDocument[]>
      put(scope: string, key: string, value: unknown, options: { ifVersion: number; requestId?: string }): Promise<{ version: number }>
      delete(scope: string, key: string, options: { ifVersion: number; requestId?: string }): Promise<void>
      onChange(listener: (change: { scope: string; key: string; version: number }) => void): () => void
    }
    view: {
      getState<T = unknown>(): T | undefined
      setState(value: unknown): void
    }
    nav: {
      openSession(sessionId: string): Promise<void>
    }
    diag: {
      report(message: string): void
    }
    host: {
      info(): AppHostInfo
      onChange(listener: (info: AppHostInfo) => void): () => void
    }
  }

  type Tone = 'neutral' | 'warn' | 'err' | 'ok'
  export interface AppUi {
    Button: ComponentType<{
      children: ReactNode
      variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger'
      size?: 'xs' | 'sm' | 'md'
      disabled?: boolean
      loading?: boolean
      type?: 'button' | 'submit'
      onClick?: () => void
    }>
    TextField: ComponentType<{
      label: ReactNode
      value: string
      onChange: (value: string) => void
      placeholder?: string
      hint?: ReactNode
      error?: ReactNode
      disabled?: boolean
      maxLength?: number
    }>
    TextArea: ComponentType<{
      label: ReactNode
      value: string
      onChange: (value: string) => void
      placeholder?: string
      hint?: ReactNode
      error?: ReactNode
      disabled?: boolean
      rows?: number
      maxLength?: number
    }>
    Checkbox: ComponentType<{
      label: ReactNode
      checked: boolean
      onChange: (checked: boolean) => void
      description?: ReactNode
      disabled?: boolean
    }>
    Switch: ComponentType<{ label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }>
    Segmented: ComponentType<{
      label: string
      value: string
      options: ReadonlyArray<{ value: string; label: string; disabled?: boolean }>
      onChange: (value: string) => void
      disabled?: boolean
    }>
    Group: ComponentType<{ title?: ReactNode; description?: ReactNode; action?: ReactNode; children?: ReactNode }>
    Row: ComponentType<{ title: ReactNode; description?: ReactNode; children?: ReactNode }>
    Status: ComponentType<{ tone?: Tone; children: ReactNode }>
    Badge: ComponentType<{ tone?: Tone; children: ReactNode }>
    Count: ComponentType<{ value: number }>
    Notice: ComponentType<{ tone?: 'neutral' | 'warn' | 'error'; title?: ReactNode; children?: ReactNode; action?: ReactNode }>
    Hint: ComponentType<{ label: ReactNode; children?: ReactNode }>
    Loading: ComponentType<{ label: ReactNode }>
    Empty: ComponentType<{ title: ReactNode; description?: ReactNode; action?: ReactNode }>
    Progress: ComponentType<{ active: boolean; label?: string }>
  }

  export interface PageProps {
    latch: Latch
    ui: AppUi
  }
  export interface MigratedDocument {
    scope: string
    key: string
    value: unknown
  }
  export interface AppDefinition {
    page: ComponentType<PageProps>
    migrate?: (from: number, documents: AppStorageDocument[]) => MigratedDocument[] | Promise<MigratedDocument[]>
  }
  export function defineApp(definition: AppDefinition): AppDefinition
}

declare module '*.css' {}
declare module '*.png' {
  const url: string
  export default url
}
declare module '*.webp' {
  const url: string
  export default url
}
`

/** How to write a page, for the Agent working in a draft's folder. */
export const APP_GUIDE = `# 做 Latch 应用

这个文件夹是一个 Latch 应用（插件页面）的草稿。页面在 Latch 的隔离框里运行，拿不到凭据，只能用 \`latch-app.json\` 里声明的能力。

## 文件

- \`latch-app.json\`：插件声明（\`formatVersion: 2\`）。改 \`id\`、\`name\`、\`apps[].title\` 与 \`capabilities\`；入口是 \`apps[].entry\`。
- 页面源码：\`.ts\`、\`.tsx\`，样式 \`.css\`，图片 \`.png\`、\`.webp\`。别的文件不会被导入；不能有 \`.mjs\`，不能声明 \`host\` 或 \`panels\`。
- \`sdk.d.ts\`：SDK 的类型，只读。
- 最多 64 个文件，单个 ≤ 512 KiB，合计 ≤ 2 MiB；构建产物 ≤ 2 MiB。

## 写法

\`\`\`tsx
import { useEffect, useState } from 'react'
import { defineApp, type AppTask, type PageProps } from '@latch/app-sdk'

function Page({ latch, ui }: PageProps) {
  const [tasks, setTasks] = useState<AppTask[]>([])
  useEffect(() => latch.tasks.subscribe({ limit: 20 }, update => setTasks(update.tasks)), [])
  return (
    <ui.Group title="最近的会话">
      {tasks.map(task => <ui.Row key={task.id} title={task.title} />)}
    </ui.Group>
  )
}

export default defineApp({ page: Page })
\`\`\`

- 只能导入包内的相对路径、\`react\`、\`react/jsx-runtime\` 与 \`@latch/app-sdk\`；不能装依赖，不能联网（没有 fetch）。
- 界面用 \`ui\` 里的原语：Button、TextField、TextArea、Checkbox、Switch、Segmented、Group、Row、Status、Badge、Count、Notice、Hint、Loading、Empty、Progress。没有对话框、菜单或 Toast。
- 构建是严格的 TypeScript（strict），类型错误会让构建失败。

## 能力（\`capabilities\`）

| 能力 | 可以做 |
| --- | --- |
| \`"tasks.read": true\` | \`latch.tasks.list/subscribe\`：会话摘要（标题、状态、项目） |
| \`"tasks.start": { "projects": "any" }\` | \`latch.tasks.start\`：用项目默认权限开始会话；也可以写具体项目 ID |
| \`"tasks.continue": true\` | \`latch.tasks.continue\`：给本页面开始的会话发新消息（要同时声明 tasks.start） |
| \`"tasks.readOwn": true\` | \`latch.tasks.readReply\`：本页面开始的会话的最后回复 |
| \`"storage": ["plugin", "project", "session"]\` | \`latch.storage.*\`：作用域 \`plugin\`、\`project:<id>\`、\`session:<id>\` 的 JSON 文档 |

只声明需要的能力；能力变多时，应用要在这台 Mac 上确认一次。

- 写请求失败码是 \`AppBridgeError.code\`：\`capability-denied\`、\`forbidden\`、\`offline\`、\`unknown\`（用同一个 \`requestId\` 重试）、\`rate-limited\`、\`invalid-input\`、\`not-found\`；预览里开始或继续会话得到 \`preview\`。
- \`latch.view.setState\` 保存滚动、展开等界面状态（≤ 64 KiB），重新加载与新版本会带过去。
- \`apps[].preview.tasks\` 可以给预览写几条样例会话：\`[{ "title": "…", "status": "idle" }]\`。

## 布局

页面在壳层的主区域里，宽度从手机（约 360）到桌面。用一列为主，\`ui.Group\` 分组，\`ui.Row\` 列项目，主要操作只用一个 \`variant="primary"\` 的按钮。颜色跟随 Latch 的主题，不写死颜色。
`

/** A draft's manifest as the Host writes it before the session's first input. */
export function appSkeleton(id: string): string {
  return (
    JSON.stringify(
      {
        formatVersion: 2,
        id,
        name: '新应用',
        version: '0.1.0',
        description: '',
        requires: { appSdk: '^1' },
        apps: [{ id: 'main', title: '新应用', icon: 'layout-grid', entry: 'index.tsx', dataVersion: 1, capabilities: {} }],
      },
      null,
      2,
    ) + '\n'
  )
}
