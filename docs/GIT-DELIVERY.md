---
description: 交付：会话仓库的状态、按文件暂存与取消暂存、提交与推送，以及经你的 gh 创建或绑定 PR、读检查与评论；两类 Git 进程（受限读写与以你的账户运行的交付）、环境、权限与审计、每个仓库一次一个写入、回执与结果未知、固定的失败原因。
sources:
  - apps/host/src/git-delivery.ts
  - apps/host/src/git-pr.ts
  - apps/host/src/changes/git-status.ts
  - apps/host/src/routes/git.ts
  - apps/host/src/audit-actions/git.ts
  - apps/host/src/session-meta.ts
  - packages/protocol/src/git-delivery.ts
  - apps/host/test/git-delivery.test.ts
  - apps/host/test/git-routes.test.ts
  - apps/host/test/git-pr.test.ts
  - packages/testkit/src/gh.ts
  - apps/web/src/panel/delivery
  - apps/web/test/delivery-model.test.ts
  - e2e/delivery.e2e.ts
  - e2e/pr-checks.e2e.ts
  - e2e/phone-review.e2e.ts
---
# 交付

交付是会话仓库的暂存、提交、推送与 PR：`GET /link/api/tasks/:id/git` 读状态，`POST …/git/stage`、`unstage`、`commit`、`push` 写入，`catalog.features.gitDelivery` 表示 Host 有这些路由。仓库是会话的工作目录：Host 为它新建的工作树，或项目的主文件夹，必须是 Git 工作树的顶层（[BRANCHES.md](BRANCHES.md) 的布局检查），否则 409 `git-not-repository`。多文件夹项目的其他文件夹尚未实现：交付只看主文件夹。会话侧栏的「交付」页签是它的界面（见「界面」）。

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

同一仓库（共同 Git 目录，各工作树共用）同时只做一个写入，另一个得到 409 `git-busy` 与进行中的写入 `{ kind, requestId, startedAt, hook? }`；移除这个仓库的一个工作树（[BRANCHES.md](BRANCHES.md#移除工作树)）也持有它（`RepositoryHolds`），其间的交付写入同样 409 `git-busy`；`GET git` 的 `running` 让所有设备看到同样的内容。仓库正在合并、变基、拣选或还原时所有写入 409 `git-operation-in-progress`，在终端里完成后再试；状态里给 `gitOperation`。

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

## PR 与检查

PR 只做 GitHub，只经你的 `gh`（GitHub CLI）。`GET /link/api/tasks/:id/git/pr` 读，`POST …/git/pr` 创建或绑定，`GET …/git/pr/checks/:job/log` 读一个失败任务的日志；其他平台的 PR 尚未实现。

- **你的 `gh`。** 与提交、推送同一个运行器与环境：你的登录 shell 读完 profile 后 `exec gh`（profile 设定的 PATH 找到哪个就是哪个），先去掉 profile 可能设下的 `GH_ENTERPRISE_TOKEN`、`GITHUB_ENTERPRISE_TOKEN`、`GH_HOST`、`GH_REPO`、`GH_DEBUG`、`DEBUG`（企业版 token 会发往 `--repo` 指的任何主机），另加 `GH_PROMPT_DISABLED=1`、`GH_NO_UPDATE_NOTIFIER=1`、`GH_NO_EXTENSION_UPDATE_NOTIFIER=1`、`GH_SPINNER_DISABLED=1`、`GH_PAGER=cat`、`NO_COLOR=1`，标准输入为空。`gh` 用它自己的登录（它的配置与系统钥匙串）；Latch 从不运行 `gh auth token`，不读取、不保存 token，Host 环境里的 `GH_TOKEN`、`GITHUB_TOKEN` 不在白名单里，也不进参数。
- **仓库。** 推送会去的远端（与「推送」同一规则）的地址经 `ls-remote --get-url`（应用 `insteadOf`，不连接）读出，必须是 `https://`、`ssh://`、`git://` 或 `user@host:` 形式的 `owner/repo`，每个 `gh` 命令都带 `--repo <host>/<owner>/<repo>`，`gh api` 总带 `--hostname`，不让 `gh` 自己从远端猜。主机只能是 `github.com`、`*.ghe.com`，或 `gh auth status --hostname <主机>`（不打印 token，结果记 5 分钟）说已登录的 GitHub Enterprise Server（登录已失效时是 `gh-logged-out`）；其他主机什么也不运行。否则 409 `gh-no-remote`（界面「这个远端不是 GitHub」）。SSH 别名 `github.com-<名字>`（只用 SSH 形式、名字里没有点）当作 `github.com`，https 的 443 端口不算主机的一部分。分支名必须是 `gh` 接受、元数据能存下的名字（最多 200 个字符），否则 409 `pr-input-invalid`，在审计之前。
- **创建或绑定。** `{ requestId, title, body, base, draft? }`：标题一行、最多 256 个字符，基线是分支名，正文最多 64 KB，否则 400 `pr-input-invalid`。分支还不在远端（没有 `refs/remotes/<远端>/<分支>`）时 409 `pr-not-pushed`。先 `gh pr list --head=<分支> --state open`：有这个分支在推送远端仓库里的已开 PR（不是分叉来的）就绑定它；它的基线存不进元数据（超过 256 个字符或有控制字符）时 409 `pr-exists-elsewhere`，两种情况都不新建。绑定的基线只用于显示，从不交回给 Git，记审计 `git.pr.link`，不新建（回答 `linked`）；没有才记审计 `git.pr.create` 与 `pending` 回执，再 `gh pr create --head=<分支> --base=<基线> --title=<标题> --body-file=<0600 文件> [--draft]`，读出它打印的地址，地址不在推送远端的仓库里时不绑定、算结果未知。正文只在临时文件里；临时文件只替换整个占位参数（如 `--body-file=BODY`），标题里的同样文字原样交给 `gh`。`gh` 说这个分支已有 PR 时再查一次，查到就绑定，查不到是 409 `pr-exists-elsewhere`。从不关闭、合并或改写 PR。
- **回执与结果未知。** 与提交、推送同一种回执（操作 `pr`，记下绑定的 PR）。`gh pr create` 60 秒没有答复、答复里没有地址或连接中断时是 504 `git-result-unknown`；同一请求重试先按分支查找，找到就是那一次建的（`replay`），找不到才再建。完成与失败的回执回答重试，不再运行 `gh`。
- **绑定。** 会话元数据 `pr: { number, url, base, head }`（`sessions-meta.json`，zod）。写不进去只记日志：下次「创建 PR」会查到它并绑定。元数据的每次修改先按 schema 检查，不符合就 500 `session-meta-invalid`、不写入，所以文件里不会有读不回的内容。绑定的 PR 已合并或关闭、而这个分支在远端已前进到它的头提交之外（又推送了）时解除绑定，「创建 PR」可以建下一个。
- **状态。** 有绑定时 `gh pr view <n> --json number,url,title,state,isDraft,reviewDecision,headRefOid,headRefName,baseRefName,statusCheckRollup`：PR 的状态、草稿、审阅结论、头提交，以及头提交的检查，归为 `pass`、`fail`、`pending`、`skipped`（`SUCCESS` 通过；`NEUTRAL`、`SKIPPED`、`STALE` 跳过；未完成的进行中；其余失败）；失败的 GitHub Actions 任务带 `job`。数据范围 `all` 的设备另得评论：`reviews` 与 `comments` 由单独的 `gh pr view --json reviews,comments --jq …` 读，各取最新 100 条、正文先截短；行级评论（`gh api repos/<owner>/<repo>/pulls/<n>/comments?sort=created&direction=desc`）取最新 100 条。合起来按时间排列，最多 200 条，每条正文最多 8 KiB，经 `redactSecrets` 并去掉控制字符；有省略时 `discussionCapped`（界面「只显示最新 N 条」）。评论读不出来时检查照常显示。失败任务只认详情地址在这个仓库里的。没有绑定时回答 `draft`：仓库默认分支（`gh repo view --json defaultBranchRef`），`all` 的设备另有最后一个提交的主题作默认标题。只读的 `gh` 命令不写审计。
- **检查日志。** 只给绑定 PR 当前检查里失败的那个任务：`gh run view --job <id> --log-failed`，去掉每行的任务名与时间、按步骤加 `[步骤]` 行、去掉分组标记，再去控制序列、经 `redactSecrets`，留最后 200 行、最多 32 KiB（`truncated`）。不是这样的任务，或日志已不在（`gh` 回答 404），都是 404 `pr-check-not-found`。
- **固定原因。** `gh-missing`（找不到 `gh`，退出码 127）、`gh-logged-out`（退出码 4、401 或要求 `gh auth login`）、`gh-no-remote`（推送远端不在 GitHub，或 GitHub 上找不到这个仓库）、`gh-unreachable`、`gh-failed`、`pr-exists-elsewhere`、`pr-not-pushed`、`pr-create-failed`（带经脱敏的 `gh` 输出最后 20 行、最多 4 KiB）、`pr-input-invalid`、`pr-check-not-found`；`gh` 的原始输出不给客户端。安装更新期间创建 PR 与其他交付写入一样 409 `host-updating`。
- **权限与审计。** 读 PR 状态 `view`（私有会话要 `all`）；读检查日志要 `view` 与数据范围 `all`（日志可能含代码）；创建或绑定 `run`（私有会话要 `all`），在按分支查找之后、绑定或 `gh pr create` 之前再复查一次，先写审计，写不进去就不执行。`git.pr.create` 记远端名、分支与基线的哈希和是否草稿，`git.pr.link` 记编号与远端名、分支的哈希，`git.result` 记结果与编号；从不写标题、正文或地址。

## 验证

`apps/host/test/git-delivery.test.ts` 用临时仓库、空的家目录和本地裸仓库作远端，不连网络：读状态、无 filter 的暂存与取消暂存不留下钩子、fsmonitor 与 filter 的标记，提交留下，跳过钩子不留；有 filter 的仓库经你的 Git 暂存；钩子看到的环境没有 Latch 的秘密且有不提示的变量，信息不在参数里；审计与调用方检查先于执行，失败时什么也不运行；钩子失败的名字与脱敏输出；同一仓库一次一个写入与进行中的钩子；超时的提交是结果未知，重试不再运行；回执在重新打开元数据后找回提交；推送到上游、推送远端与 `origin`，上游是另一个分支时拒绝，不带标签，非快进、远端钩子拒绝、`pre-push` 失败、分离 HEAD、连不上，重试时第一次已推到；钩子留下后台进程时 Git 退出即结算。`git-routes.test.ts` 经真实 Host 与假 ACP Agent 核对功能标记、权限与数据范围、私有会话、审计先写与写入失败、运行中的回合与合并中，以及 PR 路由的权限、元数据与安装更新期间的拒绝。

PR 的用例（`git-pr.test.ts`、`git-routes.test.ts`、`e2e/pr-checks.e2e.ts`）用 `@latch/testkit` 的假 `gh`（`installFakeGh`）：一个只把它放在 PATH 最前面、不是登录 shell 的 `/bin/sh` 交给测试的交付运行器，远端地址写成 GitHub、推送地址是本地裸仓库，所以不会找到真的 `gh`，也不连 GitHub。假 `gh` 记下每次的参数，按 JSON 状态回答；被要求 `auth token`、环境里有像 token 的变量或值时它记一次违规并退出，用例要求没有违规（Host 环境里放了 `GH_TOKEN`）。

## 界面

「交付」页签（`apps/web/src/panel/delivery`）在 Host 有 `gitDelivery`、设备有 `view`、会话不是只对话时出现在会话面板与启动面板里，排在「文件」之后。顶部是进度「暂存 › 提交 › 推送 › PR」，之前的步骤带对勾；写入进行中（任何设备发起的）右侧写「提交中… pre-commit」这样的状态词，所有写入停用。

- **文件。** 已暂存、未暂存、未跟踪、冲突四组，部分暂存的文件在两组里各一行。每行的勾选框暂存或取消暂存这一个文件，组头的勾选框处理整组，「全部暂存」处理剩下的全部；每次按下各带一个 `requestId`，按顺序一次发一个（Host 每个仓库一次一个写入），未答复前那一行转圈，列表只按 Host 读回的状态移动。点文件名打开「改动」页签的「未提交」范围并定位到这个文件（设备读不了改动时打开文件预览）。超过 2,000 条时写「还有 N 个」。
- **主按钮。** 一个蓝色按钮随状态变化：「暂存全部」→「提交 N 个文件」→「推送」（有上游且领先时「推送 N 个提交」）；都做完时没有主按钮。提交要先写信息。
- **提交。** 信息框下是「运行仓库钩子」，ⓘ 里列出 `hooks`、`filters` 与以你的账户和凭据运行；「跳过钩子」每次提交后复位，结果未知时保持到重试，因为重试必须发同样的内容。钩子失败是一张卡：钩子名、退出码、等宽可滚动的输出尾部（Host 已脱敏）、「没有生成提交，暂存保持不变」和「加入对话」，后者把输出的最后 80 行放进会话输入框的草稿（围栏比输出里最长的反引号多一个），不发送。
- **推送。** 写出远端与分支、领先落后或「新分支」。没有远端时是中性的「没有远端，提交留在本地」；上游是另一个分支时写「上游是另一个分支」，原因在 ⓘ 里，不给推送。失败按固定原因写短标签，远端钩子拒绝时列出 `remoteLines`。
- **PR。** 分支已在远端（上游是同名的远端分支）时「推送」下面是 PR 一节。没有绑定时是标题（默认最后一个提交的主题）、合入的基线（默认仓库的默认分支）、正文与「草稿」开关，主按钮是蓝色的「创建 PR」；有绑定时是一行 `#编号 标题`、开启 / 已关闭 / 已合并、草稿、审阅结论（「要求修改」为琥珀色）、基线 ← 分支，以及「打开」（新窗口打开 GitHub）与「刷新」。检查按头提交列出：名字、通过的用时或「失败」「进行中」「跳过」；头提交不是这里的 HEAD 时标「旧提交」；页头右侧写「检查失败」「检查进行中」或「检查通过」，只画检查这一种依据（「Agent 说通过」「命令通过」没有可靠记录，不画）。失败的任务有「查看日志」，在行下展开 Host 给的摘录，「加入对话」把带检查名与提交的围栏摘录放进草稿，不发送。数据范围 `all` 的设备看到评论：作者、位置（文件:行，或审阅结论、评论）与原文，各有「加入对话」。`gh-missing`、`gh-logged-out` 写「没有 gh」「gh 未登录」，ⓘ 里是在终端里运行 `gh auth login`；PR 结果未知时与提交相同，「重试同一请求」沿用原 `requestId` 与内容。
- **需要复验。** 「已提交」或「已推送」那一行之后，这个页面又在文件预览里保存过这个会话的文件（[DOCUMENT-PREVIEWS.md](DOCUMENT-PREVIEWS.md#编辑)）时，行尾加琥珀的「需要复验」，ⓘ 写钩子的结果不包括那些修改。只记在这个页面的内存里。
- **结果未知。** 提交或推送没有答复（504 `git-result-unknown`、超时或断线）时是中性的一行与问号图形「推送结果未知」和「重试同一请求」，重试沿用原 `requestId` 与原内容。
- **拒绝。** `git-turn-running` 写「Agent 正在改这个文件夹」（这个会话的回合运行或等待时预先停用暂存与提交，推送照常），`git-operation-in-progress` 写「合并进行中，在终端里完成」（按 `gitOperation` 换成变基、拣选或还原），`host-updating`（安装更新期间 Host 在读任何回执之前拒绝交付写入）写「这台电脑正在安装更新」，从不算失败：第一次的写入什么也不变，更新结束后可以作为新请求再按；结果未知的重试仍是结果未知，保留原 `requestId` 与「重试同一请求」，跳过钩子也不复位。离线时停用写入，写「… 不在线 · 恢复后再交付」。
- **数据范围。** `GET git` 回答 403 `file-scope` 的设备看到锁住的列表与去哪里开启，下面仍有提交信息、「提交已暂存的」与「推送」，因为 Host 允许有 `run` 的设备提交与推送非私有会话；只读会话不给写入。
- **刷新。** 打开页签、每次写入之后、回合结束、窗口回到前台或页面重新可见、恢复连接，以及 Host 为这个会话推送新的修订（交付写入开始与结束时 Host 都会推送）且没有回合在运行时读一次状态；只有写入进行中（任何设备发起的）且页签在屏幕上时每 1.5 秒读一次，以显示正在运行的钩子，写入结束即停；这是有界的跟读，不是后台轮询。页签藏起来时不读。PR 一节在打开页签、窗口回到前台、推送完成、按「刷新」与创建之后读一次；只有检查进行中且页签在屏幕上时每 30 秒读一次，其余时间不读。

- **手机。** 手机的复核页（[CHANGES.md](CHANGES.md#界面)）把这个页签推成「提交」一页，页脚是页面的底栏，按钮 44 高。提交之后、暂存区已空而还有地方推送时，主按钮是「推送」：没勾上的文件是有意留下的，「全部暂存」留在列表里；提交或推送之后，这一页的返回直接回到会话列表。点文件名回到复核页的「未提交」并停在那个文件。

「改动」页签选「未提交」范围时，范围行有「去交付」打开这个页签。
