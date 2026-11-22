// Every visible string of the site, in English and Chinese. Pages are rendered once per language, so the
// HTML that search engines and no-script visitors get is already in the right language.

export type Lang = 'en' | 'zh'

export const LANGS: Record<Lang, { tag: string; og: string; prefix: string; name: string }> = {
  en: { tag: 'en', og: 'en_US', prefix: '', name: 'English' },
  zh: { tag: 'zh-CN', og: 'zh_CN', prefix: '/zh', name: '中文' },
}

export const href = (lang: Lang, path: string) => `${LANGS[lang].prefix}${path}`

const en = {
  meta: {
    homeTitle: 'Latch | One workbench for the agents on your computer',
    homeDescription:
      'Latch runs Codex, Claude Code and other coding agents on your Mac as one team. Your iPhone and iPad follow the same conversation and approve the next step.',
    dlTitle: 'Download Latch for Mac, iPhone and iPad',
    dlDescription: 'Download Latch for Mac, iPhone and iPad. Windows, Linux and Android are coming later.',
    notFoundTitle: 'Page not found | Latch',
    ogAlt: 'Latch on a Mac and an iPhone: a team of three agents, and the phone asking to allow a test command.',
  },
  skip: 'Skip to content',
  nav: {
    download: 'Download',
    home: 'Latch home',
    switchTo: '中文',
    switchLabel: '切换到中文',
    github: 'GitHub',
    githubLabel: 'Latch on GitHub',
  },
  cta: { mac: 'Download for Mac', github: 'View on GitHub', soon: 'GitHub link coming soon' },
  hero: {
    title1: 'One workbench for the agents on your computer,',
    title2: 'open on every device you own.',
    lede: 'One conversation runs the team. Your phone approves the next step.',
    alsoA: 'Also on ',
    alsoLink: 'iPhone and iPad',
    alsoB: '. Windows, Linux and Android are coming.',
    film: 'Latch at work: a team of agents on the Mac, an approval on the iPhone',
    chapters: { ask: 'You ask', team: 'The team runs', needs: 'Needs you', allow: 'Allowed on iPhone', done: 'Handed back' },
    steps: 'Steps of the demo',
    hint: 'Tap Allow',
    play: 'Play the demo',
    pause: 'Pause the demo',
    replay: 'Play the demo again',
    allow: 'Allow on the phone',
    macAlt: {
      running: 'Latch full screen on a Mac: the “Review offline drafts” session splits the work across three members, all running.',
      needs: 'Latch on a Mac: Draft storage and Reconnect sync are done, and Recovery tests needs you.',
      done: 'Latch on a Mac: all three members are done, the work is handed back and each result is listed.',
    },
    phoneAlt: {
      running: 'The same session on iPhone, with the same members and states.',
      needs: 'On iPhone, Claude Agent asks to run “pnpm test recovery”, with Deny and Allow buttons.',
      done: 'On iPhone, every member is done and the results are listed.',
    },
  },
  agents: { label: 'Works with the agents you already use', any: 'Any ACP agent' },
  features: {
    title: 'From the first ask to the merged pull request.',
    label: 'What Latch does',
    play: 'Play the video',
    pause: 'Pause the video',
    items: {
      team: {
        tab: 'Team',
        title: 'One conversation runs a team.',
        body: 'Split a job across Codex, Claude Code and the built-in agent. Each member can work in its own Git worktree, and every result comes back to the lead.',
        alt: 'A Latch conversation splits a review across three members from different Harnesses; they run in parallel and hand their results back.',
      },
      board: {
        tab: 'Board',
        title: 'Every session on one board.',
        body: 'What needs you, what’s running and what’s ready to deliver, across every project.',
        alt: 'The Board view: columns for Needs you, In progress, Ready to deliver and Ended, filled with session cards.',
      },
      models: {
        tab: 'Models',
        title: 'Pick the agent, then the model.',
        body: 'The Harness and the model are separate choices, and any model service you add is on the list. Thinking level and permissions sit right in the composer.',
        alt: 'The composer’s model menu open on a local model service, with three models and the thinking level, next to the Harness and permission controls.',
      },
      handoff: {
        tab: 'Handoff',
        title: 'Hand the thread to another agent.',
        body: 'Let Codex find the cause, then hand the fix to Claude Code. The next agent starts with the record of the conversation.',
        alt: 'Codex explains why a note opens slowly, the conversation passes to Claude Agent with the record of one turn, and Claude Agent adds the cache and a test.',
      },
      review: {
        tab: 'Review',
        title: 'Review every turn.',
        body: 'See what each turn changed, leave a note on a line, or undo the whole turn.',
        alt: 'The Changes panel beside the conversation: Turn 1, plus six and minus two lines across two files, with Undo turn.',
      },
      ship: {
        tab: 'Ship',
        title: 'Commit, push, open the pull request.',
        body: 'Stage what you want, write the commit and push from the side panel. Open the pull request when it’s right.',
        alt: 'The Delivery panel: two files staged, a commit message written, and the push target below.',
      },
      browser: {
        tab: 'Browser',
        title: 'A browser beside the chat.',
        body: 'Open the page the agent just changed, pick an element, and put its screenshot in your next message.',
        alt: 'The Browser panel next to the conversation, showing a local web app the agent is working on.',
      },
      simulator: {
        tab: 'Simulator',
        title: 'The iOS Simulator, in the panel.',
        body: 'Watch your app live on a simulator next to the conversation, read its logs, and mark up a screen for the agent.',
        alt: 'The Device panel showing an iPhone simulator live, next to the conversation.',
      },
      computer: {
        tab: 'Mac control',
        title: 'Let an agent use your Mac.',
        body: 'With Cua Driver installed, an agent can open apps, click and type for you. Every step shows in the conversation, and Stop ends it.',
        alt: 'A conversation in which an agent opens TextEdit, types a note and saves it, with the Mac control chip and Stop.',
      },
      tools: {
        tab: 'Terminal',
        title: 'A terminal beside the conversation.',
        body: 'Run the tests yourself in the same project, without leaving the window.',
        alt: 'A terminal under the conversation, with seven passing tests.',
      },
    },
  },
  phone: {
    title: 'Leave the desk. The team keeps going.',
    body: 'Closing the window leaves the agents running on your Mac. Open the same conversation on iPhone or iPad.',
    f1: 'Pair once: scan a QR code, confirm on the Mac.',
    f2: 'On the same network, the phone connects directly.',
    f3: 'Away from home, it goes through a relay you run, which can’t read your sessions.',
    alts: [
      'On iPhone: the team card with all three members running.',
      'On iPhone: Draft storage and Reconnect sync are done, and Recovery tests needs you.',
      'On iPhone: the members’ results, with Recovery tests opened, and the lead’s closing reply.',
    ],
  },
  trust: {
    title: 'Your Mac holds the keys.',
    body: 'Each device does only what you allow. Giving one more permission asks for Touch ID on the Mac; taking one away is instant.',
    caption: 'A paired iPhone’s permissions, set on the Mac.',
    alt: 'A paired iPhone’s settings on the Mac: it can see project files, but not manage this Mac or see private content, and it can be removed.',
    k1t: 'Keys stay put.',
    k1: 'Model keys live in a file on the Mac and never go to a device.',
    k2t: 'Only hashes on disk.',
    k2: 'The Mac keeps each device’s public key and a hash of its credential.',
    k3t: 'A record you can check.',
    k3: 'Every grant is written to a hash-chained audit log first.',
    fine: 'Agents and plugins run with your Mac user’s permissions. Latch decides who may ask for what; it is not a sandbox.',
  },
  close: { title: 'Start a team on your Mac.', note: 'Open source under the MIT License. Windows, Linux and Android are coming.' },
  foot: {
    line: 'Agents on your Mac, in reach of every device you own.',
    label: 'Footer',
    get: 'Download',
    mac: 'Mac',
    ios: 'iPhone and iPad',
    later: 'Other platforms',
    open: 'Open source',
    github: 'GitHub',
    license: 'MIT License',
    source: 'Build from source',
    legal: '© 2026 The Latch Authors. Agent names and icons belong to their owners.',
  },
  copy: 'Copy',
  copied: 'Copied',
  dl: {
    title: 'Download Latch',
    lede: 'Agents run on your Mac. Your iPhone and iPad connect to it.',
    cards: 'Mac, iPhone and iPad',
    this: 'This device',
    macTitle: 'Latch for Mac',
    macBody: 'The Host and the desktop app. Sessions, keys and device records stay on this Mac.',
    macCta: 'Download for Mac',
    iosTitle: 'Latch for iPhone and iPad',
    iosBody: 'Show the QR code in Settings › Devices on your Mac, scan it with the app, then confirm on the Mac.',
    iosCta: 'Get it on the App Store',
    pending: 'Download link coming soon',
    laterTitle: 'Other platforms',
    soon: 'Coming soon',
    stepsTitle: 'Your first team in three steps',
    s1t: 'Install an agent',
    s1: 'On the Mac, install one supported agent and sign in. With Codex:',
    s2t: 'Start a session',
    s2: 'Open Latch, choose New session, pick your agent and add a project folder.',
    s3t: 'Pair your phone',
    s3: 'Show the QR code in Settings › Devices, scan it with your iPhone and confirm on the Mac.',
    srcTitle: 'Build from source',
    srcBody: 'You’ll need Node.js 24.22.1, pnpm 11.28.6, Go 1.26.10 and the Xcode Command Line Tools. From the repository root:',
    note: {
      win: 'You’re on Windows. Latch is on Mac, iPhone and iPad for now.',
      linux: 'You’re on Linux. Latch is on Mac, iPhone and iPad for now.',
      android: 'You’re on Android. Latch is on Mac, iPhone and iPad for now.',
    },
  },
  notFound: { title: 'This page isn’t here.', body: 'The link may be old. The home page has everything.', home: 'Go to the home page' },
}

export type Copy = typeof en

const zh: Copy = {
  meta: {
    homeTitle: 'Latch | 把电脑上的 Agent 放进同一个工作台',
    homeDescription: 'Latch 在你的 Mac 上让 Codex、Claude Code 等编程 Agent 组队干活，iPhone 和 iPad 打开同一段对话，随时查看与批准。',
    dlTitle: '下载 Latch：Mac、iPhone 与 iPad 版',
    dlDescription: '下载 Latch 的 Mac、iPhone 与 iPad 版。Windows、Linux 与 Android 版稍后推出。',
    notFoundTitle: '找不到这个页面 | Latch',
    ogAlt: 'Mac 与 iPhone 上的 Latch：三个 Agent 组成的团队，手机上正在请求允许运行一条测试命令。',
  },
  skip: '跳到正文',
  nav: {
    download: '下载',
    home: 'Latch 首页',
    switchTo: 'EN',
    switchLabel: 'Switch to English',
    github: 'GitHub',
    githubLabel: 'GitHub 上的 Latch',
  },
  cta: { mac: '下载 Mac 版', github: '在 GitHub 查看', soon: 'GitHub 链接即将开放' },
  hero: {
    title1: '把电脑上的 Agent 放进同一个工作台，',
    title2: '连接你的所有设备。',
    lede: '一段对话带起一个团队，​下一步在手机上批准。',
    alsoA: '也可以在 ',
    alsoLink: 'iPhone 和 iPad',
    alsoB: ' 上用。Windows、Linux 与 Android 版即将推出。',
    film: 'Latch 工作中：Mac 上一队 Agent，iPhone 上一次批准',
    chapters: { ask: '提出需求', team: '团队并行', needs: '等你处理', allow: '手机上允许', done: '交回结果' },
    steps: '演示的步骤',
    hint: '点「Allow」',
    play: '播放演示',
    pause: '暂停演示',
    replay: '重新播放演示',
    allow: '在手机上允许',
    macAlt: {
      running: 'Mac 全屏的 Latch：「Review offline drafts」会话把工作分给三个成员，都在运行。',
      needs: 'Mac 上的 Latch：Draft storage 和 Reconnect sync 已完成，Recovery tests 等你处理。',
      done: 'Mac 上的 Latch：三个成员都已完成，工作已交回，列出了各自的结果。',
    },
    phoneAlt: {
      running: 'iPhone 上的同一段会话，成员与状态都一样。',
      needs: 'iPhone 上，Claude Agent 请求运行「pnpm test recovery」，下面是拒绝与允许按钮。',
      done: 'iPhone 上，所有成员都已完成，列出了各自的结果。',
    },
  },
  agents: { label: '接入你已经在用的 Agent', any: '任意 ACP Agent' },
  features: {
    title: '从第一句需求，​到合并的 PR。',
    label: 'Latch 能做什么',
    play: '播放视频',
    pause: '暂停视频',
    items: {
      team: {
        tab: '团队',
        title: '一段对话带起一个团队。',
        body: '把一项工作分给 Codex、Claude Code 和内置 Agent。成员可以在各自的 Git 工作树里干活，结果都交回带队的那一个。',
        alt: 'Latch 的一段对话把审阅分给三个不同 Harness 的成员，它们并行干活，再把结果交回。',
      },
      board: {
        tab: '看板',
        title: '所有会话，\u200b一块看板。',
        body: '哪些等你处理、哪些在运行、哪些可以交付，所有项目一眼看完。',
        alt: '看板视图：等你处理、进行中、待交付和已结束几列，摆满会话卡片。',
      },
      models: {
        tab: '模型',
        title: '先选 Agent，再选模型。',
        body: 'Harness 和模型分开选，你加的模型服务都在列表里。思考强度和权限就在输入框里。',
        alt: '输入框的模型菜单打开在一个本地模型服务上，列出三个模型和思考强度，旁边是 Harness 与权限控件。',
      },
      handoff: {
        tab: '交接',
        title: '换一个 Agent 接着做。',
        body: '让 Codex 找原因，再交给 Claude Code 去修。接手的 Agent 带着之前的对话记录开始。',
        alt: 'Codex 解释笔记打开慢的原因，对话带着 1 轮记录交给 Claude Agent，Claude Agent 加上缓存和测试。',
      },
      review: {
        tab: '审阅',
        title: '逐轮审阅改动。',
        body: '看每一轮改了什么，在某一行留言，或者撤销整轮。',
        alt: '对话旁的「改动」面板：第 1 轮，两个文件新增 6 行、删除 2 行，以及撤销本轮。',
      },
      ship: {
        tab: '交付',
        title: '提交、推送、开 PR。',
        body: '在侧栏里挑要暂存的改动、写提交并推送，没问题了就开 PR。',
        alt: '「交付」面板：两个文件已暂存，写好了提交信息，下面是推送目标。',
      },
      browser: {
        tab: '浏览器',
        title: '对话旁边\u200b就有浏览器。',
        body: '打开 Agent 刚改好的页面，选中一个元素，把它的截图放进下一条消息。',
        alt: '对话旁的浏览器面板，打开着 Agent 正在改的本地网页。',
      },
      simulator: {
        tab: '模拟器',
        title: 'iOS 模拟器\u200b就在侧栏里。',
        body: '在对话旁实时看 App 在模拟器里的样子，读日志，圈出问题交给 Agent。',
        alt: '设备面板实时显示一台 iPhone 模拟器，旁边是对话。',
      },
      computer: {
        tab: '操控 Mac',
        title: '让 Agent\u200b操作你的 Mac。',
        body: '装好 Cua Driver 后，Agent 可以替你打开 App、点按和输入。每一步都在对话里，按「停」就结束。',
        alt: '一段对话里，Agent 打开文本编辑、写下一段笔记并保存，旁边是「操控这台 Mac」和「停」。',
      },
      tools: {
        tab: '终端',
        title: '对话旁边就有终端。',
        body: '在同一个项目里自己跑一遍测试，不用离开窗口。',
        alt: '对话下方的终端，七个测试全部通过。',
      },
    },
  },
  phone: {
    title: '人离开桌子，​团队照常干活。',
    body: '关掉窗口，Agent 仍在 Mac 上运行。在 iPhone 或 iPad 上打开同一段对话。',
    f1: '扫码配对一次，在 Mac 上确认。',
    f2: '同一网络下，手机直接连到 Mac。',
    f3: '不在一个网络时，经你自己运行的中继连回，中继看不到会话内容。',
    alts: [
      'iPhone App 的会话列表：等你处理的会话排在最前，下面按项目分组。',
      'iPhone App 里，Codex 请求修改一个文件，下面是更多、拒绝与允许。',
      'iPhone App 的额度与用量：Claude Agent、Codex 与 Antigravity 各自用了多少、何时重置。',
    ],
  },
  trust: {
    title: '钥匙​只在你的 Mac 上。',
    body: '每台设备只做你允许的事。多给一项权限要在 Mac 上用 Touch ID 确认，收回立即生效。',
    caption: '一部已配对 iPhone 的权限，在 Mac 上设置。',
    alt: 'Mac 上一部已配对 iPhone 的设置：可以看项目文件，不能管理这台 Mac，也看不到私有内容，还可以移除。',
    k1t: '密钥不离开 Mac。',
    k1: '模型密钥存在 Mac 上的文件里，从不发给任何设备。',
    k2t: '磁盘上只有哈希。',
    k2: 'Mac 只保存每台设备的公钥和凭据的哈希。',
    k3t: '记录可以核对。',
    k3: '每次授权都先写进哈希链审计记录。',
    fine: 'Agent 与插件以你的 Mac 用户权限运行。Latch 管的是谁能让它做什么，它不是沙箱。',
  },
  close: { title: '在 Mac 上​组建你的团队。', note: '以 MIT 许可证开源。Windows、Linux 与 Android 版即将推出。' },
  foot: {
    line: 'Agent 在你的 Mac 上运行，你的每台设备都能接上。',
    label: '页脚',
    get: '下载',
    mac: 'Mac',
    ios: 'iPhone 与 iPad',
    later: '其他平台',
    open: '开源',
    github: 'GitHub',
    license: 'MIT 许可证',
    source: '从源码构建',
    legal: '© 2026 The Latch Authors。各 Agent 的名称与图标归其所有者。',
  },
  copy: '复制',
  copied: '已复制',
  dl: {
    title: '下载 Latch',
    lede: 'Agent 在你的 Mac 上运行，​iPhone 和 iPad 连到它。',
    cards: 'Mac、iPhone 与 iPad',
    this: '这台设备',
    macTitle: 'Latch Mac 版',
    macBody: 'Host 与桌面端。会话、密钥和设备记录都留在这台 Mac 上。',
    macCta: '下载 Mac 版',
    iosTitle: 'Latch iPhone 与 iPad 版',
    iosBody: '在 Mac 的「设置 › 设备」显示二维码，用 App 扫码，再在 Mac 上确认。',
    iosCta: '在 App Store 获取',
    pending: '下载链接即将开放',
    laterTitle: '其他平台',
    soon: '即将推出',
    stepsTitle: '三步组建​第一个团队',
    s1t: '装好一个 Agent',
    s1: '在 Mac 上装好一个支持的 Agent 并登录。以 Codex 为例：',
    s2t: '开一个会话',
    s2: '打开 Latch，点「新会话」，选你的 Agent，加一个项目文件夹。',
    s3t: '连上手机',
    s3: '在「设置 › 设备」显示二维码，用 iPhone 扫码，在 Mac 上确认。',
    srcTitle: '从源码构建',
    srcBody: '需要 Node.js 24.22.1、pnpm 11.28.6、Go 1.26.10 与 Xcode 命令行工具。在仓库根目录运行：',
    note: {
      win: '你在用 Windows。Latch 目前有 Mac 版和 iPhone、iPad 版。',
      linux: '你在用 Linux。Latch 目前有 Mac 版和 iPhone、iPad 版。',
      android: '你在用 Android。Latch 目前有 Mac 版和 iPhone、iPad 版。',
    },
  },
  notFound: { title: '这个页面不在这里。', body: '链接可能已经过期，首页上什么都有。', home: '回到首页' },
}

export const COPY: Record<Lang, Copy> = { en, zh }

// The agents Latch ships presets for (docs/USAGE.md), with the command Latch runs and how each is installed.
export type Agent = {
  id: string
  name: string
  src?: string
  dark?: string
  margin?: boolean
  tile?: boolean
  mono?: boolean
  install?: string
  docs?: string
  runs?: string
}

export const AGENTS: Agent[] = [
  { id: 'codex', name: 'Codex', src: 'codex.png', margin: true, install: 'npm i -g @openai/codex', runs: 'codex app-server' },
  {
    id: 'claude',
    name: 'Claude Code',
    src: 'claude.svg',
    install: 'npm i -g @agentclientprotocol/claude-agent-acp',
    runs: 'claude-agent-acp',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    src: 'opencode-light.svg',
    dark: 'opencode-dark.svg',
    install: 'npm i -g @opencode/cli',
    runs: 'opencode serve',
  },
  { id: 'pi', name: 'pi', src: 'pi.svg', margin: true, install: 'npm i -g @earendil-works/pi-coding-agent', runs: 'pi --mode rpc' },
  { id: 'dsh', name: 'DeepSeek Harness', mono: true, install: 'npm i -g @deepseek-ai/dsh', runs: 'dsh --profile acp' },
  { id: 'qwen', name: 'Qwen Code', src: 'qwen-code.svg', install: 'npm i -g @qwen-code/qwen-code', runs: 'qwen --acp' },
  { id: 'goose', name: 'goose', mono: true, install: 'brew install block-goose-cli', runs: 'goose acp' },
  {
    id: 'cursor',
    name: 'Cursor',
    src: 'cursor-light.svg',
    dark: 'cursor-dark.svg',
    tile: true,
    docs: 'https://cursor.com/docs/cli/acp',
    runs: 'cursor-agent acp',
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    src: 'antigravity.svg',
    margin: true,
    docs: 'https://antigravity.google/docs/ide/extensions/acp/',
    runs: 'agy acp …',
  },
  {
    id: 'grok',
    name: 'Grok Build',
    src: 'grok-dark.svg',
    dark: 'grok-light.svg',
    margin: true,
    install: 'npm i -g @xai-official/grok',
    runs: 'grok … agent stdio',
  },
]

export const FEATURES = ['board', 'models', 'handoff', 'review', 'ship', 'tools', 'browser', 'simulator', 'computer'] as const
export type Feature = (typeof FEATURES)[number]
