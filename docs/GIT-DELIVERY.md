---
description: 交付：会话仓库的状态、按文件、按块与按行暂存与取消暂存、提交记录与基线比较、提交与推送，以及经你的 gh 创建或绑定 PR、读检查与评论；两类 Git 进程（受限读写与以你的账户运行的交付）、环境、权限与审计、每个仓库一次一个写入、回执与结果未知、固定的失败原因。
sources:
  - apps/host/src/git-delivery.ts
  - apps/host/src/git-pr.ts
  - apps/host/src/workbench-delivery.ts
  - apps/host/src/workbench-git-eligibility.ts
  - apps/host/src/changes/git-status.ts
  - apps/host/src/changes/git-hunks.ts
  - apps/host/src/changes/git-history.ts
  - apps/host/src/routes/git.ts
  - apps/host/src/audit-actions/git.ts
  - apps/host/src/session-meta.ts
  - packages/protocol/src/git-delivery.ts
  - packages/protocol/src/workbench.ts
  - apps/host/test/git-delivery.test.ts
  - apps/host/test/git-routes.test.ts
  - apps/host/test/git-hunks.test.ts
  - apps/web/src/panel/changes/staging.ts
  - apps/web/src/panel/changes/useStaging.ts
  - apps/web/src/panel/changes/StagingView.tsx
  - apps/web/src/panel/changes/GitHistoryView.tsx
  - apps/web/test/staging.test.ts
  - apps/host/test/git-pr.test.ts
  - apps/host/test/workbench-git-eligibility.test.ts
  - packages/testkit/src/gh.ts
  - apps/web/src/panel/delivery
  - apps/web/test/delivery-model.test.ts
  - e2e/delivery.e2e.ts
  - e2e/git-hunks.e2e.ts
  - e2e/pr-checks.e2e.ts
  - e2e/phone-review.e2e.ts
  - e2e/workbench-git-eligibility.e2e.ts
---
# 交付

交付是会话仓库的暂存、提交、推送与 PR：`GET /link/api/tasks/:id/git` 读状态，`POST …/git/stage`、`unstage`、`commit`、`push` 写入，`catalog.features.gitDelivery` 表示 Host 有这些路由。仓库是会话的工作目录：Host 为它新建的工作树，或项目的主文件夹，必须是 Git 工作树的顶层（[BRANCHES.md](BRANCHES.md) 的布局检查），否则 409 `git-not-repository`。多文件夹项目的其他文件夹尚未实现：交付只看主文件夹。会话侧栏的「交付」页签是它的界面（见「界面」）。

## 两类 Git 进程

**受限的 Git** 与改动记录（[CHANGES.md](CHANGES.md#只读-git)）用同一个运行器：重建的环境、钩子目录 `/dev/null`、`core.fsmonitor=`、`protocol.allow=never`，不运行仓库里的任何程序。它做读取与这几种写入：

- 状态：`status --porcelain=v2 -z --branch --untracked-files=all --no-renames --ignore-submodules=all`。比较工作区会运行 clean filter，所以配置里出现的每个 filter 驱动在这个进程里都被置空（经环境里的命令行配置，不改任何文件）：这类文件可能显示为已修改。子模块不列出。领先落后只用本地引用，不 fetch。
- 仓库配置没有任何 filter 驱动时的暂存：`add --pathspec-from-file=- --pathspec-file-nul`，另加 `gc.auto=0`、`maintenance.auto=false`、`submodule.recurse=false`。
- 取消暂存：`reset --quiet --no-refresh <HEAD> --pathspec-from-file=-`，还没有提交时 `rm --cached --ignore-unmatch`；都不碰也不比较工作区，filter 同样置空。
- 按行暂存与取消暂存（见「按块与按行暂存」）：`hash-object -w --no-filters --stdin` 写入 Host 自己拼出的内容，`update-index -z --index-info` 换掉这一个索引条目；不运行 `git apply`，不经任何 filter，有没有 filter 驱动的仓库都在这里。两个写进程都在读取钩子配置之后复查权限和运行状态。若对象已写入但授权在更新索引前失效，索引保持原样。当前调用返回权限或运行状态的拒绝。授权恢复后重试同一个请求会收到失败回执（`git-stage-failed` 和 `replay`），不会再更新索引。
- 历史（见「历史」）：`rev-list`、`merge-base --is-ancestor`、`diff-tree --raw` 与 `--numstat`（带 `--no-ext-diff --no-textconv --no-renames`）、`cat-file --batch`；行级差异由 Host 自己比较两个 blob，不让 Git 输出补丁。
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
| `POST git/stage`、`git/unstage`、`git/stage-lines`、`git/unstage-lines` | `run`，数据范围 `all` |
| `GET git/diff`、`git/history`、`git/history/:sha`、`git/compare`（带不带 `path`） | `view`，数据范围 `all` |
| `POST git/commit`、`git/push` | `run`；私有会话（Agent、助手或自动化的会话）要数据范围 `all` |

状态与暂存列出或指定会话文件夹里的文件，和改动面板一样只给能浏览这些文件的设备；提交与推送不涉及文件名，有 `run` 的设备（包括手机）都可以，因为有 `run` 的设备已能让 Agent 在这个仓库里执行任意命令，交付没有新增能力。写入还要经过发消息的检查（`assertSessionInput`：会话的访问、只读会话、项目仍可用）。这些检查在 Git 运行之前、写审计之前、所有异步读取之后再做一次：设备权限、数据范围、私有会话、会话的工作目录没有变，以及暂存、取消暂存与提交时同一文件夹里没有运行中的回合（含这个会话自己的回合，以及文件夹相同、包含或位于其中的其他会话的回合），否则 409 `git-turn-running`。推送不改文件，回合运行中也可以推送。

## 一次一个写入

同一仓库（共同 Git 目录，各工作树共用）同时只做一个写入，另一个得到 409 `git-busy` 与进行中的写入 `{ kind, requestId, startedAt, hook? }`；移除这个仓库的一个工作树（[BRANCHES.md](BRANCHES.md#移除工作树)）也持有它（`RepositoryHolds`），其间的交付写入同样 409 `git-busy`；`GET git` 的 `running` 让所有设备看到同样的内容。仓库正在合并、变基、拣选或还原时所有写入 409 `git-operation-in-progress`，在终端里完成后再试；状态里给 `gitOperation`。

## 暂存与取消暂存

`{ requestId, paths }`，1 到 1,000 个路径：相对仓库顶层、`/` 分隔，不含空段、`.`、`..`、反斜杠、控制字符或 `.git`，沿途的文件夹不能是符号链接（文件本身可以是链接，Git 存的是链接）；有一个不符合就整次 400 `git-paths-invalid`，什么也不运行。回答 `{ files, filtered? }`，`filtered` 表示经你的 Git 与仓库的 filter 暂存。Git 拒绝（例如被忽略的文件）时 422 `git-stage-failed`。重复安全，所以同一 `requestId` 的回答只留在内存里。

## 按块与按行暂存

`GET …/git/diff?view=unstaged|staged&path=` 读一个文件的行：`unstaged` 是工作区对索引，`staged` 是索引对 HEAD，两个视图分开。回答 `GitHunkDiff`：整个文件作上下文的 `hunks`（改动的行以 `oldLine` 或 `newLine` 为名）、增删行数，以及读取时的版本 `base`：`worktree` 是文件字节的 SHA-256，`index` 与 `head` 是 Git 的对象 ID。只能整个处理的文件（见下表）只回答 `whole`，没有 `hunks`，也没有 `base`：它的内容连哈希也不给。`catalog.features.gitHunks` 表示 Host 有这些路由与「历史」的路由。

`POST …/git/stage-lines`、`unstage-lines` 的请求是 `{ requestId, path, base, old?, new? }`：`old` 是选中的删除行、`new` 是选中的新增行，各为闭区间 `[from, to]` 的数组，整块就是它的全部行。每一边至多 500 段，必须从小到大、互不重叠，合计至多 20,000 行；不符合的在展开任何一段之前就是 400 `git-selection-invalid`。请求里没有补丁文字，带别的字段是 400。Host 自己做其余的事（`changes/git-hunks.ts`）：

- **读取。** 路径与按文件暂存同样检查，并且按字面读（`GIT_LITERAL_PATHSPECS`：名字里的 `*` 与 `:(glob)` 这样的写法只是名字）。工作区的文件用 `O_NOFOLLOW` 打开，打开之后核对它的真实路径就是仓库真实文件夹下的这个位置、且那里的文件就是打开的这一个；沿途的文件夹在检查之后被换成链接时读到的是「没有这个文件」，与 Git 的看法相同。至多读 1 MB 加一个字节，超过就算太大，不管打开之后文件长了多少。索引条目经 `ls-files -s --debug`、HEAD 的条目经 `ls-tree`、内容经 `cat-file --batch`，属性经 `check-attr`（读各级 `.gitattributes` 与 `info/attributes`，不运行任何东西）。
- **核对版本。** 暂存核对 `worktree` 与 `index`，取消暂存核对 `index` 与 `head`；有一项不同就是 409 `git-file-changed`，`changed` 写 `worktree`、`index`、`head` 或 `both`，什么也不写。审计与调用方检查之后、写入之前再读一次，内容不同同样拒绝。
- **拼出内容。** Host 用自己的行比较（与改动面板同一个）得到两边的差异，选中的行号必须都是这份差异里的改动行，否则 409 `git-selection-invalid`（没有选中任何行、行号越界是 400）。暂存时索引的新内容是「索引的内容加上选中的改动」，取消暂存时是「索引的内容退回选中的改动」；同一个改动块里删除行与新增行按位置配对，所以选中一对替换时新行落在旧行的位置。换行符逐字节保留（CRLF 文件仍是 CRLF）；原先没有结尾换行的行不再是最后一行时补上文件用的换行，不会把两行连成一行。
- **写入。** 内容经 `hash-object -w --no-filters` 成为 blob，Git 给出的对象 ID 必须等于 Host 算出的；然后再读一次这个索引条目，仍是计划时读到的那一条（模式与对象 ID）才由 `update-index --index-info` 换掉它（模式不变），否则 409 `git-file-changed`。工作区的文件从不改动。与其他交付写入一样，同一仓库一次一个写入，合并进行中与同一文件夹有回合运行时拒绝，先写审计（`git.stage` / `git.unstage`，`files: 1` 与行数 `lines`，不写路径），写不进去就不执行。写过审计的每一次都以 `git.result` 结束：完成、结果未知，或失败与固定原因（`git-file-changed`、`git-file-whole`、`git-selection-invalid`、`git-stage-failed`）。
- **剩下的窗口。** Git 没有针对单个索引条目的「比较后替换」。Host 的各个写入由每个仓库一次一个的锁排开，但 Host 之外的程序（终端里的 `git add`）在最后一次读取与 `update-index` 拿到 `index.lock` 之间写了这个条目时，它对这一个路径的改动会被这次写入盖掉；`index.lock` 保证索引本身不坏。这个窗口是一次 `ls-files` 到一次 `update-index` 的启动时间。
- **回执与结果未知。** 与提交相同的回执（`sessions-meta.json`，操作 `stage` / `unstage`，记被替换的条目 `preIndex`、写入的 blob `resultOid` 与行数）：写入之前记 `pending`，写不进去就是 503 `git-receipt-unsaved`、不执行；之后记 `done`、`failed` 或（超过 2 分钟）`unknown`，那时回答 504 `git-result-unknown`。同一请求重试时：`done` 的回执直接回答 `{ lines, replay: true }`，不看仓库、不写入、不记审计，所以写入落地之后别的设备又把它取消暂存了也不会再写一次；`failed` 的回执回答原来的原因（带 `replay`）。回执还开着（`pending` 或 `unknown`，Host 在写入前后停止也是）时只看索引：它是 `resultOid` 就是那次写入落地了，记 `done` 并回答 `replay`，文件之后变没变都一样；它仍是 `preIndex` 就是没有写入，这个请求照新的执行（重新核对、重新审计），这时的 409 才是定论，并记进回执；两者都不是时无从判断，仍是 504 `git-result-unknown`，回执不变。没有回执的请求从未开始写入，它的拒绝都是定论。同一 `requestId` 换了内容或操作是 409 `request-conflict`。

只能整个暂存或取消暂存的文件，`GET git/diff` 不给 `hunks` 而给 `whole`，按行写入是 409 `git-file-whole`（带同一个 `whole`；请求带着的版本已经过期时先回答 409 `git-file-changed`）：

| `whole` | 情况 |
| --- | --- |
| `binary` | 不是 UTF-8 文字；或 Git 自己的判断（`text=auto`、`core.autocrlf`）把内容当作二进制：有单独的 CR，或每 128 个字符里有不止一个不可打印的 |
| `large` | 一边超过 1 MB，或超过 20,000 行（整个文件作上下文的上限） |
| `new`、`deleted` | 一边没有这个文件；重命名在这里是一个删除加一个新文件；`git add -N` 只登记了的文件也是 `new` |
| `mode`、`link`、`submodule` | 执行位变了（`core.fileMode=false` 时执行位不算改动，沿用索引里的）；符号链接；子模块 |
| `conflicted` | 有冲突，在终端里解决 |
| `filtered` | 这个文件有 `filter` 属性：只有按文件暂存才以你的 Git 运行 filter（见「两类 Git 进程」） |
| `converted` | `ident`、`working-tree-encoding`，或 Git 会转换换行而 Host 不能确定结果（索引里已有 CR，或 `text`、`eol` 属性之下文件里有单独的 CR） |
| `secret` | 名称或内容像密钥，从不给内容 |
| `unchanged` | 两边的文字相同 |

Git 会把换行转成 LF 的文件（`text`、`eol` 属性或 `core.autocrlf`）在索引没有 CR、文件里的 CR 都属于 CRLF 时按 Git 会存下的 LF 比较与写入，所以只显示真正改动的行。

## 历史

只读，都经受限的 Git，行级差异由 Host 比较两个 blob（`changes/git-history.ts`）；每个 Git 进程最多 10 秒。提交、文件名与行都是会话文件夹里的内容，所以每一个历史读取都只给数据范围 `all` 的设备，其他设备 403 `file-scope`：没有不带文件名的摘要，也无从用提交 ID 试探。读取之后再查一次数据范围，期间被收紧的不返回。

- `GET …/git/history`：这个会话的提交，新的在前，最多 50 个（更多时 `more`）。`range` 说明是哪些：`base` 是当前分支离开 `main`（或 `master`，本地或 `origin`）之后第一父提交线上的提交；没有这样的基线而有上游时 `upstream` 是上游还没有的；都没有时 `recent` 是 HEAD 最近的。主题与作者各截短、去控制字符、经 `redactSecrets`。
- `GET …/git/history?path=`：HEAD 的历史里改过这个文件的提交（`range: 'file'`），同样最多 50 个。
- `GET …/git/history/:sha`：这个提交相对第一父提交改动的文件（没有父提交时相对空树），最多 500 个，带增删行数；`?path=` 是其中一个文件的行。提交必须是 HEAD 的祖先，否则 404 `git-commit-not-found`，所以别的分支与悬空对象读不到。
- `GET …/git/compare`：当前分支的 HEAD 相对它离开基线处（合并基点）已提交的改动，不含工作区；`?path=` 同上。没有基线时 409 `git-no-base`。
- 单个文件：链接与子模块、超过 1 MB 或 20,000 行、二进制、名称或内容像密钥的文件不给 `hunks`，`hidden` 写原因；像密钥的文件在列表里也不给行数。

没有写入，不写审计。提交图、跨分支的历史与标签尚未实现。

## 提交

`{ requestId, message, skipHooks? }`。信息必填，最多 64 KB，`--cleanup=whitespace`。默认运行钩子；`skipHooks` 是这一次的 `--no-verify`，从不记住。从不 `--amend`、`-a` 或允许空提交。先拒绝：有冲突的文件 409 `git-conflicted`，没有暂存 409 `git-nothing-staged`，Git 不知道提交者 409 `git-identity-missing`。

成功回答 `{ commit, hookOutput? }`：钩子运行过且有输出时给 `hookOutput`。失败时没有生成提交，暂存不变：钩子失败 422 `git-hook-failed` 带 `hook`、`exitCode` 与 `tail`，其他 422 `git-commit-failed` 带 `exitCode` 与 `tail`。`tail` 是 Git 与钩子输出的最后 256 KiB：去掉转义序列与回车覆盖，再经 `redactSecrets`。

## 推送

`{ requestId }`，不接受地址。总是推到远端上与当前分支同名的分支（`refs/heads/<分支>`，先经 `check-ref-format`），远端按顺序取：设了推送远端（`branch.<分支>.pushRemote`，否则 `remote.pushDefault`）就用它，它须是仓库配置的远端，否则 409 `git-remote-invalid`；否则用上游的远端（`branch.<分支>.remote` 与 `merge`），上游是另一个分支时 409 `git-upstream-other-branch`（界面可以说「上游是另一个分支」），上游不是配置的远端时 409 `git-remote-invalid`；没有上游时推到 `origin`。没有上游的分支推送成功后记下上游（`setUpstream`）。都没有时 409 `git-no-remote`（界面应说「没有远端，提交留在本地」，不算失败）。新请求遇到分离 HEAD 409 `git-detached`（结果未知的重试不看 HEAD，见「回执与结果未知」），还没有提交 409 `git-no-commit`。命令是 `push --porcelain --no-follow-tags --recurse-submodules=no <远端> <提交>:refs/heads/<分支>`：从不强制，引用规则不带 `+`，显式的引用规则让配置里的推送规则不适用，标签与子模块不随推送。远端地址只来自仓库配置，所以不触发新出站地址的确认。

成功回答 `{ remote, ref, sha, setUpstream? }`。失败归为固定原因，原始输出不给客户端：`git-hook-failed`（`pre-push`，带 `tail`）、`git-push-remote-rejected`（远端钩子拒绝，带经脱敏的 `remote:` 行 `remoteLines`，最多 100 行）、`git-push-non-fast-forward`、`git-push-auth`、`git-push-host-key`、`git-push-unreachable`，其余 `git-push-failed`（带 `exitCode`），都是 422。

## 回执与结果未知

提交与推送的回执随会话元数据持久化（`sessions-meta.json` 的 `receipts`，种类 `git`，按会话、设备与 `requestId`，保留 7 天）。Git 运行之前写入 `pending`，写不进去就 503 `git-receipt-unsaved` 且不执行；同一 `requestId` 换了内容 409 `request-conflict`。

- 提交的回执记 `preHead`（之前的 HEAD）、HEAD 指向的分支（`headRef`，分离时是 `HEAD`）、暂存的树、首行的哈希、是否跳过钩子。Git 说提交成功时，新的 HEAD 以 `preHead` 为第一父提交就是这次的提交（钩子改了信息也认得）。超时（提交含钩子 10 分钟，推送与暂存 2 分钟，结束整个进程组；钩子留下的后台进程拿着输出管道时，Git 退出 1 秒后关闭管道，不等它们）、Host 停止或重启后，回执是「结果未知」，504 `git-result-unknown`。同一请求重试从不再运行提交：在 HEAD 第一父提交线上最近 64 个提交里找第一父提交是 `preHead`、首行相同（跳过钩子时还要树相同）的那个，找到就回答原提交（`replay`）；HEAD 仍在回执记下的分支上、仍是 `preHead` 且没有 `index.lock` 时回答 409 `git-commit-not-made`（可以用新请求重新提交）；否则仍是结果未知：换到了别的分支（提交可能在原分支上）、会话文件夹已不是 Git 仓库或找不到 Git 时也是，没有 `headRef` 的旧回执同样只会找到提交或停在结果未知。钩子改了首行的提交在重启后找不回来，只会停在结果未知，不会提交第二次。
- 推送的回执记远端、引用、提交与远端由哪条规则选出。结果未知时，同一请求重试只用回执里的远端、引用与提交，不看 HEAD 现在在哪：分离 HEAD 或换了分支也照常查看，只有记下上游（`setUpstream`，审计记的也是实际会记下的）要等 HEAD 在那个分支上，否则不记，回答也不带它。重试在结果确定之前不改写回执：确定之后写不进去只记日志，原来的结果未知回执原样留在内存与磁盘上，下一次重试仍推同一个提交。重试先查看远端的分支：`ls-remote` 只按远端名读取，从不把地址放进参数。推送去的地址与读取的地址不同（设了不同的 `pushurl`、有不止一个推送地址、配置里有 `pushInsteadOf`，或受限的 Git 从配置解不出）时不读远端，算无法判断。
  - 已是这个提交，或这个提交是它的祖先（远端之后又前进了）：完成。
  - 远端的分支停在这个仓库没有的提交上：无法判断，仍是结果未知（带 `remoteSha`），不再推送。
  - 远端答复了而分支没有这个提交，或 `ls-remote` 失败、超时、输出不可用：把同一个提交再推到同一处（非强制推送同一提交本身幂等）。成功就完成。失败时再查看一次远端（第一次可能仍在落地：服务器上慢的钩子，或 Host 重启后还在运行的 Git）：已有这个提交就完成；仍没有它时，非快进与引用被锁或旧值不符（`cannot lock ref`、`failed to update ref`、`reference already exists`、`is at … but expected`）仍是结果未知，其余失败（远端钩子拒绝、`pre-push`、凭据、主机密钥、连不上、其他）记为失败；第二次查看无法判断时仍是结果未知，回执保持未知，远端恢复后用同一请求再试。
  - 在查看之前就拒绝的（会话文件夹已不是 Git 仓库、找不到 Git、仓库正被另一个写入或移除工作树占用、合并进行中、Git 读取失败、审计没写进去、Host 正在关闭）都回答 504 `git-result-unknown`，回执不变；只有调用方的检查（设备权限、数据范围、会话、文件夹变了）与安装更新期间的 `host-updating` 照原样拒绝。
  - 完成的回答原结果，失败的回答原因（不带输出）。

## 审计

写入之前记 `git.stage`、`git.unstage`（按行时另有行数 `lines`）、`git.commit`、`git.push`，写不进去就不执行；之后记 `git.result`（`outcome`：done、failed、unknown，固定原因，提交的 SHA），写不进去只记日志。内容只有会话、请求标识的哈希、文件数、是否经 filter、提交前的 SHA、钩子名单（只取 Git 认识的钩子名）、是否跳过钩子、远端由哪条规则选出（`upstream`、`push-remote` 或 `origin`）以及远端名与引用的哈希；不写路径、信息正文、远端地址或任何输出。

## 状态

工作台通过只读 `POST /link/api/workbench/delivery` 请求至多 12 个当前可见会话的交付摘要。它复用交付服务与权限检查：需要 `view` 和数据范围 `all`，读取前后都复查设备与私有会话权限；收紧权限时整批不返回。摘要只给文件数量、分支、领先/落后、进行中的写入和已绑定 PR 的检查，不给文件名、钩子配置、评论或 PR 默认正文。部分暂存的文件只计一次，超过读取上限仍带 `more`。

同批次相同目录只读一次，并发相同读取共用在途结果；每批最多三个读取，全 Host 最多两批，结束后不缓存或继续轮询。没有绑定 PR 的会话不启动 `gh`，也不查询远端。仓库与 PR 分别带实际读取时间，单项失败保留固定错误码，不把读取失败当成没有改动或检查通过。只有 Host 证明当前目录有效、直属 `.git` 确实不存在且读取前后目录身份保持一致时，摘要返回 `notApplicable: "not-repository"`，不伪造空 Git 状态；该项仍计入已观察范围。损坏的 HEAD、不受信的元数据、链接、权限错误和读取竞态仍保留错误，不能仅按 `git-not-repository` 错误码推断普通文件夹。目录或祖先目录在检查期间发生变化时也保守失败，由显式刷新重新读取；这不是操作系统提供的原子目录快照。客户端只在总览可见时跟读；写入仍使用既有交付接口和回执。

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

`git-hunks.test.ts` 用真实的临时仓库核对按行暂存：只选新增、只选删除与两者都选，没有结尾换行、CRLF 与 `core.autocrlf`、相邻的改动块，行段的顺序、重叠与上限，空的与过期的选择，文件或索引变了之后的 409 与不覆盖，带 filter 属性（含子文件夹的 `.gitattributes` 与 `info/attributes`）、二进制（含 Git 自己判断的）、过长、重命名、`git add -N`、执行位与 `core.fileMode=false`、链接、子模块、冲突与像密钥的文件只能整个处理且不给 `base`，名字里的 `*` 与 `:(glob)` 按字面读，文件夹被换成链接时读不到文件、读取不超过上限，审计与调用方检查先于写入（失败时连 blob 也不写）、审计之后重读、每次审计都有结果，对象 ID 不符或条目已变时不换索引；回执：超时后未落地的重试只写一次，落地而没记下结束的在文件变了之后仍找回，落地后被别的设备取消暂存的不再写第二次，无从判断时保持结果未知，有证据才说没有写入；`post-index-change` 钩子与 filter 从不运行。历史：分支的提交、文件历史、提交的文件与行、基线比较、只读 HEAD 的祖先、50 个提交与 20,000 行的上限。`git-routes.test.ts` 另经真实 Host 核对这些路由的权限、请求里不接受补丁文字与不合规的行段、数据范围为 `work` 的设备读不到任何历史、私有会话、设备限额，以及读取之后数据范围被收紧时不返回。`apps/web/test/staging.test.ts` 覆盖选择模型与键盘、两个视图的划分、拒绝的短词与重试何时算定论。`e2e/git-hunks.e2e.ts` 在真实临时仓库与假 ACP Agent 上走完这些视图：按块、用键盘按行与 Shift 选一段暂存，二进制文件整个暂存，从已暂存取消一行，答复丢失后的「暂存结果未知」与同一请求的重试（一次写入、一条审计、`replay`），文件变了之后的拒绝与重读，提交、文件历史与分支比较，数据范围为 `work` 的设备每个历史路由都是 403；截图在 `test-results/git-hunks/`（1440、768、390，浅色与深色）。

PR 的用例（`git-pr.test.ts`、`git-routes.test.ts`、`e2e/pr-checks.e2e.ts`）用 `@latch/testkit` 的假 `gh`（`installFakeGh`）：一个只把它放在 PATH 最前面、不是登录 shell 的 `/bin/sh` 交给测试的交付运行器，远端地址写成 GitHub、推送地址是本地裸仓库，所以不会找到真的 `gh`，也不连 GitHub。假 `gh` 记下每次的参数，按 JSON 状态回答；被要求 `auth token`、环境里有像 token 的变量或值时它记一次违规并退出，用例要求没有违规（Host 环境里放了 `GH_TOKEN`）。

## 界面

「交付」页签（`apps/web/src/panel/delivery`）在 Host 有 `gitDelivery`、设备有 `view`、会话不是只对话时出现在会话面板与启动面板里，排在「文件」之后。顶部是进度「暂存 › 提交 › 推送 › PR」，之前的步骤带对勾；写入进行中（任何设备发起的）右侧写「提交中… pre-commit」这样的状态词，所有写入停用。

- **文件。** 已暂存、未暂存、未跟踪、冲突四组，部分暂存的文件在两组里各一行。每行的勾选框暂存或取消暂存这一个文件，组头的勾选框处理整组，「全部暂存」处理剩下的全部；每次按下各带一个 `requestId`，按顺序一次发一个（Host 每个仓库一次一个写入），未答复前那一行转圈，列表只按 Host 读回的状态移动。点文件名打开「改动」页签的「未提交」范围并定位到这个文件（设备读不了改动时打开文件预览）。超过 2,000 条时写「还有 N 个」。
- **主按钮。** 一个蓝色按钮随状态变化：「暂存全部」→「提交 N 个文件」→「推送」（有上游且领先时「推送 N 个提交」）；都做完时没有主按钮。提交要先写信息。
- **提交。** 信息框下是「运行仓库钩子」，ⓘ 里列出 `hooks`、`filters` 与以你的账户和凭据运行；「跳过钩子」每次提交后复位，结果未知时保持到重试，因为重试必须发同样的内容。钩子失败是一张卡：钩子名、退出码、等宽可滚动的输出尾部（Host 已脱敏）、「没有生成提交，暂存保持不变」和「加入对话」，后者把输出的最后 80 行放进会话输入框的草稿（围栏比输出里最长的反引号多一个），不发送。
- **推送。** 写出远端与分支、领先落后或「新分支」。没有远端时是中性的「没有远端，提交留在本地」；上游是另一个分支时写「上游是另一个分支」，原因在 ⓘ 里，不给推送。失败按固定原因写短标签，远端钩子拒绝时列出 `remoteLines`。
- **PR。** 分支已在远端（上游是同名的远端分支）时「推送」下面是 PR 一节。没有绑定时是标题（默认最后一个提交的主题）、合入的基线（默认仓库的默认分支）、正文与「草稿」开关，主按钮是蓝色的「创建 PR」；有绑定时是一行 `#编号 标题`、开启 / 已关闭 / 已合并、草稿、审阅结论（「要求修改」为琥珀色）、基线 ← 分支，以及「打开」（新窗口打开 GitHub）与「刷新」。检查按头提交列出：名字、通过的用时或「失败」「进行中」「跳过」；头提交不是这里的 HEAD 时标「旧提交」；页头右侧写「检查失败」「检查进行中」或「检查通过」，只画检查这一种依据（「Agent 说通过」「命令通过」没有可靠记录，不画）。失败的任务有「查看日志」，在行下展开 Host 给的摘录，「加入对话」把带检查名与提交的围栏摘录放进草稿，不发送。数据范围 `all` 的设备看到评论：作者、位置（文件:行，或审阅结论、评论）与原文，各有「加入对话」。`gh-missing`、`gh-logged-out` 写「没有 gh」「gh 未登录」，ⓘ 里是在终端里运行 `gh auth login`；PR 结果未知时与提交相同，「重试同一请求」沿用原 `requestId` 与内容。
- **需要复验。** 「已提交」或「已推送」那一行之后，这个页面又在文件预览里保存过这个会话的文件（[DOCUMENT-PREVIEWS.md](DOCUMENT-PREVIEWS.md#编辑)）时，行尾加琥珀的「需要复验」，ⓘ 写钩子的结果不包括那些修改。只记在这个页面的内存里。
- **结果未知。** 提交或推送没有答复（504 `git-result-unknown`、超时或断线）时是中性的一行与问号图形「推送结果未知」和「重试同一请求」，重试沿用原 `requestId` 与原内容。重试只在这些答复上结束：完成、回执的答复（`replay`）、推送在查看远端之后的失败（远端钩子拒绝、`pre-push`、凭据、主机密钥、连不上、其他），以及 PR 按分支查找之后的 `pr-create-failed` 与 `pr-exists-elsewhere`；其他拒绝（400、403、429、会话的检查、`git-receipt-unsaved`、`host-closing`、断线）都说明不了第一次，这一行保持结果未知与原 `requestId`，拒绝的短标签写在它下面，不自动重试。「放弃这次结果」只在这个页面上放下它（ⓘ 里写电脑上的记录仍是结果未知），之后可以发起新的请求：新的提交只提交那时暂存的文件，第一次已提交的不再暂存，所以之后没有再暂存别的文件时是 409 `git-nothing-staged`；新的推送照常非强制推送；新的创建 PR 先按分支查找，找到就绑定。
- **拒绝。** `git-turn-running` 写「Agent 正在改这个文件夹」（这个会话的回合运行或等待时预先停用暂存与提交，推送照常），`git-operation-in-progress` 写「合并进行中，在终端里完成」（按 `gitOperation` 换成变基、拣选或还原），`host-updating`（安装更新期间 Host 在读任何回执之前拒绝交付写入）写「这台电脑正在安装更新」，从不算失败：第一次的写入什么也不变，更新结束后可以作为新请求再按；结果未知的重试仍是结果未知，保留原 `requestId` 与「重试同一请求」，跳过钩子也不复位。离线时停用写入，写「… 不在线 · 恢复后再交付」。
- **数据范围。** `GET git` 回答 403 `file-scope` 的设备看到锁住的列表与去哪里开启，下面仍有提交信息、「提交已暂存的」与「推送」，因为 Host 允许有 `run` 的设备提交与推送非私有会话；只读会话不给写入。
- **刷新。** 打开页签、每次写入之后、回合结束、窗口回到前台或页面重新可见、恢复连接，以及 Host 为这个会话推送新的修订（交付写入开始与结束时 Host 都会推送）且没有回合在运行时读一次状态；只有写入进行中（任何设备发起的）且页签在屏幕上时每 1.5 秒读一次，以显示正在运行的钩子，写入结束即停；这是有界的跟读，不是后台轮询。页签藏起来时不读。PR 一节在打开页签、窗口回到前台、推送完成、按「刷新」与创建之后读一次；只有检查进行中且页签在屏幕上时每 30 秒读一次，其余时间不读。

- **手机。** 手机的复核页（[CHANGES.md](CHANGES.md#界面)）把这个页签推成「提交」一页，页脚是页面的底栏，按钮 44 高。提交之后、暂存区已空而还有地方推送时，主按钮是「推送」：没勾上的文件是有意留下的，「全部暂存」留在列表里；提交或推送之后，这一页的返回直接回到会话列表。点文件名回到复核页的「未提交」并停在那个文件。iPhone/iPad App 的「提交」页同样由 `PhoneDelivery` 判断：每次暂存与取消暂存一个请求、一个 `requestId`，行在 Host 读回之前转圈；提交最多等 630 秒，推送 270 秒（先 `ls-remote` 再推送），暂存 150 秒；没有答复时写「提交结果未知」或「推送结果未知」，只重试同一请求。重试与网页的 `writeEnd` 同一规则：带 `replay` 的回答（Host 从回执回答，包括 `git-commit-not-made`）算定论，推送另有读过远端后给出的失败（`git-push-remote-rejected`、`git-hook-failed`、`git-push-auth`、`git-push-host-key`、`git-push-unreachable`、`git-push-failed`）；400、403、429、会话检查、`host-updating`、`git-result-unknown` 与网络错误都仍是未知，沿用原 `requestId`，拒绝的说明写在这一行下面。「放弃这次结果」丢掉这台设备的待确认副本，之后可以发起新的请求，电脑上的记录仍是结果未知。暂存与取消暂存没有失败的回执，重试的拒绝同样不算定论，页面另给「核对并放下」：按读回的仓库状态显示，丢掉这台设备的待确认副本，不再发送；钩子失败卡的「加入对话」把尾部 80 行放进那个会话的草稿，不发送。PR 一节在 App 里尚未实现。

「改动」页签选「未提交」范围时，范围行有「去交付」打开这个页签。

**按行暂存与历史的界面**在「改动」页签的范围菜单里，「Git」一组（`apps/web/src/panel/changes`）：

- **未暂存、已暂存。** 两个列表分开，顶上的分段控件带各自的文件数（来自 `GET git`），部分暂存的文件在两边各一行。点开文件读 `GET git/diff`：每个改动行在行号处有一个勾选框，按下或 Space 选中或取消，Shift 加按或 Shift Space 从上次按的行选到这一行（中间未改动的行跳过），↑ ↓ 在改动行之间移动，Shift ↑ ↓ 增减一行；双击或「选这一块」选整块，「全选」选全部。选中的行带蓝色的选择边。「暂存所选」（已暂存里是「取消暂存所选」）是这一页唯一的蓝色按钮，行尾的「暂存文件」处理整个文件。暂存始终上下排列，触屏改动行的选择区至少 44px 高。排列、文件树和复制补丁只出现在支持它们的视图。
- **只能整个处理的文件**点开后写原因与做法，如「二进制 · 只能整个暂存」「文件太大 · 只能整个暂存」「新文件 · 只能整个取消暂存」「有冲突 · 在终端里解决」。
- **写入。** 每次按下一个请求、一个 `requestId`；答复之前那一行转圈，之后列表与打开的差异都从 Host 重读，仍是改动的行保留选中。409 `git-file-changed`、`git-selection-invalid`、`git-file-whole` 在行上写「文件已变 · 已重新读取」这样的短词并重读；没有答复时是中性的一行「暂存结果未知」与「重试同一请求」（沿用原请求）。重试只在 Host 知道第一次做了什么的答复上结束：完成、回执的答复（`replay`），以及它看过文件与索引之后的拒绝（这三种 409 它只在确知第一次没有写入时给，无从判断时回答 `git-result-unknown`）；别的拒绝（仓库忙、回合运行中、安装更新、权限、限额）说明不了第一次，这一行保持、原因写在下面。切换改动范围或关闭面板后，重新打开同一会话仍可核对原请求。Host 拒绝读取文件时只显示权限说明，权限恢复后仍可重试原请求。「核对并放下」按读回的状态显示并丢掉此设备页面的待确认副本。有待确认的写入、仓库有写入在进行、回合运行中（「Agent 正在改这个文件夹」）、只读会话或离线时不能写，分段控件旁写原因。
- **提交。** 这个分支的提交（标题按 `range` 写「离开 main 之后的提交」「还没推送的提交」「最近的提交」），点开一个提交列出它改的文件，再点开文件看行；只读。
- **分支与 main。** 已提交的改动相对基线，与「与 main 比较」范围的区别是不含未提交的改动。
- **文件历史。** 「未暂存」「已暂存」、提交里的文件，以及「未提交」「与 main 比较」范围里主文件夹的文件，行尾有「文件历史」：列出改过它的提交，点开看那次提交里这个文件的行，「返回」回到来处。
- 数据范围不是 `all` 的设备看不到「改动」页签的内容，这些视图也在其中；多文件夹项目只看主文件夹。iPhone/iPad App 里尚未实现。
