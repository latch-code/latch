---
description: 交付：会话仓库的状态、按文件暂存与取消暂存、提交与推送；两类 Git 进程（受限读写与以你的账户运行的交付）、环境、权限与审计、每个仓库一次一个写入、回执与结果未知、固定的失败原因。
sources:
  - apps/host/src/git-delivery.ts
  - apps/host/src/changes/git-status.ts
  - apps/host/src/routes/git.ts
  - apps/host/src/audit-actions/git.ts
  - apps/host/src/session-meta.ts
  - packages/protocol/src/git-delivery.ts
  - apps/host/test/git-delivery.test.ts
  - apps/host/test/git-routes.test.ts
  - apps/web/src/panel/delivery
  - apps/web/test/delivery-model.test.ts
  - e2e/delivery.e2e.ts
---
# 交付

交付是会话仓库的暂存、提交与推送：`GET /link/api/tasks/:id/git` 读状态，`POST …/git/stage`、`unstage`、`commit`、`push` 写入，`catalog.features.gitDelivery` 表示 Host 有这些路由。仓库是会话的工作目录：Host 为它新建的工作树，或项目的主文件夹，必须是 Git 工作树的顶层（[BRANCHES.md](BRANCHES.md) 的布局检查），否则 409 `git-not-repository`。多文件夹项目的其他文件夹尚未实现：交付只看主文件夹。会话侧栏的「交付」页签是它的界面（见「界面」）。

## 两类 Git 进程

**受限的 Git** 与改动记录（[CHANGES.md](CHANGES.md#只读-git)）用同一个运行器：重建的环境、钩子目录 `/dev/null`、`core.fsmonitor=`、`protocol.allow=never`，不运行仓库里的任何程序。它做读取与这几种写入：

- 状态：`status --porcelain=v2 -z --branch --untracked-files=all --no-renames --ignore-submodules=all`。比较工作区会运行 clean filter，所以配置里出现的每个 filter 驱动在这个进程里都被置空（经环境里的命令行配置，不改任何文件）：这类文件可能显示为已修改。子模块不列出。领先落后只用本地引用，不 fetch。
- 仓库配置没有任何 filter 驱动时的暂存：`add --pathspec-from-file=- --pathspec-file-nul`，另加 `gc.auto=0`、`maintenance.auto=false`、`submodule.recurse=false`。
- 取消暂存：`reset --quiet --no-refresh <HEAD> --pathspec-from-file=-`，还没有提交时 `rm --cached --ignore-unmatch`；都不碰也不比较工作区，filter 同样置空。
- 提交前的检查：`var GIT_COMMITTER_IDENT` 与 `GIT_AUTHOR_IDENT`（身份）、配置与钩子目录的文件名；`write-tree`（暂存的树，会写入树对象）在复查与审计之后才运行。
- 这些进程都关掉配置里的钩子（Git 2.54 起的 `hook.*`），规则与选项见 [BRANCHES.md](BRANCHES.md#新建工作树)。

**你的 Git** 是唯一具名的例外：提交、推送，以及仓库配置了 filter 驱动（如 Git LFS）时的暂存（驱动的名单在暂存之前读出：读出之后、`add` 之前才加进配置的驱动，由受限的 Git 置空、不运行，那次暂存不经过它），由你按下、先写审计，再以这台电脑上你的账户运行系统 Git，仓库的钩子、filter、凭据助手与 `core.sshCommand` 照常运行，与在终端里运行相同。它不是沙箱，也不隔离任何东西；Host 自己做的其他事仍不运行仓库里的程序。

- 进程：你的登录 shell（账户数据库里的 sh、bash、zsh、ksh 或 dash，以 `-` 开头的 `argv[0]`；其他 shell 换成 `/bin/zsh`）读完 profile 后 `exec` 找到的 Git（与改动记录同一份列表），`-C <仓库>`，在自己的进程组里、没有控制终端，标准输入为空。从不经 Agent 进程。
- 环境：终端的环境（`terminalEnvironment`，见 [TERMINAL.md](TERMINAL.md#终端服务)）去掉终端标记，`TERM=dumb`，加 `GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`、`SSH_ASKPASS_REQUIRE=never`。profile 之后再次设定这三项与 `GIT_EDITOR=:`、`GIT_PAGER=cat`，去掉 `GIT_ASKPASS`、`SSH_ASKPASS`、`LC_ALL`、`LANGUAGE`，`LC_MESSAGES=C` 让 Git 的消息是英文、可以分类。模型密钥、设备凭据、`lmg1.`、`LATCH_*` 与 Node、Electron 开关都不在其中；Latch 不读取、不保存、不审计任何 Git 凭据，也不把它们放进参数或环境。
- 提交信息与路径只写进新建的 0700 临时文件夹里的 0600 文件（`--file=`、`--pathspec-from-file=`），结束后删除，从不进参数。路径按字面（`GIT_LITERAL_PATHSPECS=1`）。
- 钩子：`GIT_TRACE2_EVENT` 写到同一个临时文件夹，Host 每 0.5 秒读一次顶层 Git 的 `child_start`/`child_exit` 事件，得到正在运行的钩子与失败的钩子名。

## 权限

| 路由 | 权限 |
| --- | --- |
| `GET git` | `view`，数据范围 `all` |
| `POST git/stage`、`git/unstage` | `run`，数据范围 `all` |
| `POST git/commit`、`git/push` | `run`；私有会话（Agent、助手或自动化的会话）要数据范围 `all` |

状态与暂存列出或指定会话文件夹里的文件，和改动面板一样只给能浏览这些文件的设备；提交与推送不涉及文件名，有 `run` 的设备（包括手机）都可以，因为有 `run` 的设备已能让 Agent 在这个仓库里执行任意命令，交付没有新增能力。写入还要经过发消息的检查（`assertSessionInput`：会话的访问、只读会话、项目仍可用）。这些检查在 Git 运行之前、写审计之前、所有异步读取之后再做一次：设备权限、数据范围、私有会话、会话的工作目录没有变，以及暂存、取消暂存与提交时同一文件夹里没有运行中的回合（含这个会话自己的回合，以及文件夹相同、包含或位于其中的其他会话的回合），否则 409 `git-turn-running`。推送不改文件，回合运行中也可以推送。

## 一次一个写入

同一仓库（共同 Git 目录，各工作树共用）同时只做一个写入，另一个得到 409 `git-busy` 与进行中的写入 `{ kind, requestId, startedAt, hook? }`；`GET git` 的 `running` 让所有设备看到同样的内容。仓库正在合并、变基、拣选或还原时所有写入 409 `git-operation-in-progress`，在终端里完成后再试；状态里给 `gitOperation`。

## 暂存与取消暂存

`{ requestId, paths }`，1 到 1,000 个路径：相对仓库顶层、`/` 分隔，不含空段、`.`、`..`、反斜杠、控制字符或 `.git`，沿途的文件夹不能是符号链接（文件本身可以是链接，Git 存的是链接）；有一个不符合就整次 400 `git-paths-invalid`，什么也不运行。回答 `{ files, filtered? }`，`filtered` 表示经你的 Git 与仓库的 filter 暂存。Git 拒绝（例如被忽略的文件）时 422 `git-stage-failed`。重复安全，所以同一 `requestId` 的回答只留在内存里。

## 提交

`{ requestId, message, skipHooks? }`。信息必填，最多 64 KB，`--cleanup=whitespace`。默认运行钩子；`skipHooks` 是这一次的 `--no-verify`，从不记住。从不 `--amend`、`-a` 或允许空提交。先拒绝：有冲突的文件 409 `git-conflicted`，没有暂存 409 `git-nothing-staged`，Git 不知道提交者 409 `git-identity-missing`。

成功回答 `{ commit, hookOutput? }`：钩子运行过且有输出时给 `hookOutput`。失败时没有生成提交，暂存不变：钩子失败 422 `git-hook-failed` 带 `hook`、`exitCode` 与 `tail`，其他 422 `git-commit-failed` 带 `exitCode` 与 `tail`。`tail` 是 Git 与钩子输出的最后 256 KiB：去掉转义序列与回车覆盖，再经 `redactSecrets`。

## 推送

`{ requestId }`，不接受地址。总是推到远端上与当前分支同名的分支（`refs/heads/<分支>`，先经 `check-ref-format`），远端按顺序取：设了推送远端（`branch.<分支>.pushRemote`，否则 `remote.pushDefault`）就用它，它须是仓库配置的远端，否则 409 `git-remote-invalid`；否则用上游的远端（`branch.<分支>.remote` 与 `merge`），上游是另一个分支时 409 `git-upstream-other-branch`（界面可以说「上游是另一个分支」），上游不是配置的远端时 409 `git-remote-invalid`；没有上游时推到 `origin`。没有上游的分支推送成功后记下上游（`setUpstream`）。都没有时 409 `git-no-remote`（界面应说「没有远端，提交留在本地」，不算失败）。分离 HEAD 409 `git-detached`，还没有提交 409 `git-no-commit`。命令是 `push --porcelain --no-follow-tags --recurse-submodules=no <远端> <提交>:refs/heads/<分支>`：从不强制，引用规则不带 `+`，显式的引用规则让配置里的推送规则不适用，标签与子模块不随推送。远端地址只来自仓库配置，所以不触发新出站地址的确认。

成功回答 `{ remote, ref, sha, setUpstream? }`。失败归为固定原因，原始输出不给客户端：`git-hook-failed`（`pre-push`，带 `tail`）、`git-push-remote-rejected`（远端钩子拒绝，带经脱敏的 `remote:` 行 `remoteLines`，最多 100 行）、`git-push-non-fast-forward`、`git-push-auth`、`git-push-host-key`、`git-push-unreachable`，其余 `git-push-failed`（带 `exitCode`），都是 422。

## 回执与结果未知

提交与推送的回执随会话元数据持久化（`sessions-meta.json` 的 `receipts`，种类 `git`，按会话、设备与 `requestId`，保留 7 天）。Git 运行之前写入 `pending`，写不进去就 503 `git-receipt-unsaved` 且不执行；同一 `requestId` 换了内容 409 `request-conflict`。

- 提交的回执记 `preHead`（之前的 HEAD）、暂存的树、首行的哈希、是否跳过钩子。Git 说提交成功时，新的 HEAD 以 `preHead` 为第一父提交就是这次的提交（钩子改了信息也认得）。超时（提交含钩子 10 分钟，推送与暂存 2 分钟，结束整个进程组；钩子留下的后台进程拿着输出管道时，Git 退出 1 秒后关闭管道，不等它们）、Host 停止或重启后，回执是「结果未知」，504 `git-result-unknown`。同一请求重试从不再运行提交：在 HEAD 第一父提交线上最近 64 个提交里找第一父提交是 `preHead`、首行相同（跳过钩子时还要树相同）的那个，找到就回答原提交（`replay`）；HEAD 仍是 `preHead` 且没有 `index.lock` 时回答 409 `git-commit-not-made`（可以用新请求重新提交）；否则仍是结果未知。钩子改了首行的提交在重启后找不回来，只会停在结果未知，不会提交第二次。
- 推送的回执记远端、引用、提交与远端由哪条规则选出。结果未知时，同一请求重试先用你的 Git `ls-remote` 那个引用：已是这个提交，或这个提交是它的祖先（远端之后又前进了），就算完成；远端的分支停在这个仓库没有的提交上时无法判断，仍是结果未知（带 `remoteSha`），不再推送；否则把同一个提交再推到同一处，非强制推送同一提交本身幂等，这次重试被拒为非快进时也仍是结果未知，不算失败。完成的回答原结果，失败的回答原因（不带输出）。

## 审计

写入之前记 `git.stage`、`git.unstage`、`git.commit`、`git.push`，写不进去就不执行；之后记 `git.result`（`outcome`：done、failed、unknown，固定原因，提交的 SHA），写不进去只记日志。内容只有会话、请求标识的哈希、文件数、是否经 filter、提交前的 SHA、钩子名单（只取 Git 认识的钩子名）、是否跳过钩子、远端由哪条规则选出（`upstream`、`push-remote` 或 `origin`）以及远端名与引用的哈希；不写路径、信息正文、远端地址或任何输出。

## 状态

`GET git` 回答 `GitDeliveryState`（`packages/protocol/src/git-delivery.ts`）：`branch`、`head`、`upstream`、`ahead`、`behind`、`staged`、`unstaged`、`untracked`、`conflicted`（合计最多 2,000 条，其余数目在 `more`）、`gitOperation`、`running`、`hooks`（`core.hooksPath` 或共同 Git 目录 `hooks/` 下可执行的、Git 认识的钩子名，只列出，不运行；配置里的 `hook.*` 钩子不列出）、`filters`、`remote`。分支与上游名按分支读取的规则显示：像密钥的不给，隐藏字符可见。快照里的「有未提交 / 领先 N」摘要尚未实现：它会让每次快照都运行 Git。

## 验证

`apps/host/test/git-delivery.test.ts` 用临时仓库、空的家目录和本地裸仓库作远端，不连网络：读状态、无 filter 的暂存与取消暂存不留下钩子、fsmonitor 与 filter 的标记，提交留下，跳过钩子不留；有 filter 的仓库经你的 Git 暂存；钩子看到的环境没有 Latch 的秘密且有不提示的变量，信息不在参数里；审计与调用方检查先于执行，失败时什么也不运行；钩子失败的名字与脱敏输出；同一仓库一次一个写入与进行中的钩子；超时的提交是结果未知，重试不再运行；回执在重新打开元数据后找回提交；推送到上游、推送远端与 `origin`，上游是另一个分支时拒绝，不带标签，非快进、远端钩子拒绝、`pre-push` 失败、分离 HEAD、连不上，重试时第一次已推到；钩子留下后台进程时 Git 退出即结算。`git-routes.test.ts` 经真实 Host 与假 ACP Agent 核对功能标记、权限与数据范围、私有会话、审计先写与写入失败、运行中的回合与合并中。

## 界面

「交付」页签（`apps/web/src/panel/delivery`）在 Host 有 `gitDelivery`、设备有 `view`、会话不是只对话时出现在会话面板与启动面板里，排在「文件」之后。顶部是进度「暂存 › 提交 › 推送」，之前的步骤带对勾；写入进行中（任何设备发起的）右侧写「提交中… pre-commit」这样的状态词，所有写入停用。

- **文件。** 已暂存、未暂存、未跟踪、冲突四组，部分暂存的文件在两组里各一行。每行的勾选框暂存或取消暂存这一个文件，组头的勾选框处理整组，「全部暂存」处理剩下的全部；每次按下各带一个 `requestId`，按顺序一次发一个（Host 每个仓库一次一个写入），未答复前那一行转圈，列表只按 Host 读回的状态移动。点文件名打开「改动」页签的「未提交」范围并定位到这个文件（设备读不了改动时打开文件预览）。超过 2,000 条时写「还有 N 个」。
- **主按钮。** 一个蓝色按钮随状态变化：「暂存全部」→「提交 N 个文件」→「推送」（有上游且领先时「推送 N 个提交」）；都做完时没有主按钮。提交要先写信息。
- **提交。** 信息框下是「运行仓库钩子」，ⓘ 里列出 `hooks`、`filters` 与以你的账户和凭据运行；「跳过钩子」每次提交后复位，结果未知时保持到重试，因为重试必须发同样的内容。钩子失败是一张卡：钩子名、退出码、等宽可滚动的输出尾部（Host 已脱敏）、「没有生成提交，暂存保持不变」和「加入对话」，后者把输出的最后 80 行放进会话输入框的草稿（围栏比输出里最长的反引号多一个），不发送。
- **推送。** 写出远端与分支、领先落后或「新分支」。没有远端时是中性的「没有远端，提交留在本地」；上游是另一个分支时写「上游是另一个分支」，原因在 ⓘ 里，不给推送。失败按固定原因写短标签，远端钩子拒绝时列出 `remoteLines`。
- **结果未知。** 提交或推送没有答复（504 `git-result-unknown`、超时或断线）时是中性的一行与问号图形「推送结果未知」和「重试同一请求」，重试沿用原 `requestId` 与原内容。
- **拒绝。** `git-turn-running` 写「Agent 正在改这个文件夹」（这个会话的回合运行或等待时预先停用暂存与提交，推送照常），`git-operation-in-progress` 写「合并进行中，在终端里完成」（按 `gitOperation` 换成变基、拣选或还原），`host-updating`（安装更新期间 Host 在读任何回执之前拒绝交付写入）写「这台电脑正在安装更新」，从不算失败：第一次的写入什么也不变，更新结束后可以作为新请求再按；结果未知的重试仍是结果未知，保留原 `requestId` 与「重试同一请求」，跳过钩子也不复位。离线时停用写入，写「… 不在线 · 恢复后再交付」。
- **数据范围。** `GET git` 回答 403 `file-scope` 的设备看到锁住的列表与去哪里开启，下面仍有提交信息、「提交已暂存的」与「推送」，因为 Host 允许有 `run` 的设备提交与推送非私有会话；只读会话不给写入。
- **刷新。** 打开页签、每次写入之后、回合结束、窗口回到前台或页面重新可见、恢复连接，以及 Host 为这个会话推送新的修订（交付写入开始与结束时 Host 都会推送）且没有回合在运行时读一次状态；只有写入进行中（任何设备发起的）且页签在屏幕上时每 1.5 秒读一次，以显示正在运行的钩子，写入结束即停；这是有界的跟读，不是后台轮询。页签藏起来时不读。

「改动」页签选「未提交」范围时，范围行有「去交付」打开这个页签。
