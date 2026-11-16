---
description: 交付：会话仓库的状态、按文件、按块与按行暂存与取消暂存、提交记录与基线比较、提交与推送，以及经你的 gh 创建或绑定 PR、读检查与评论；两类 Git 进程（受限读写与以你的账户运行的交付）、环境、权限与审计、每个仓库一次一个写入、回执与结果未知、固定的失败原因。
sources:
  - apps/host/src/git-delivery.ts
  - apps/host/src/git-pr.ts
  - apps/host/src/workbench-delivery.ts
  - apps/host/src/workbench-git-eligibility.ts
  - apps/host/src/changes/git.ts
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

交付是会话仓库的暂存、提交、推送与 PR。路由都在 `/link/api/tasks/:id/git` 之下；`catalog.features.gitDelivery` 表示 Host 有这些路由，`gitHunks` 表示有按行暂存与历史的路由。

- 仓库是会话的工作目录：Host 为它新建的工作树，或项目的主文件夹。它必须是 Git 工作树的顶层（[BRANCHES.md](BRANCHES.md) 的布局检查），否则 409 `git-not-repository`。
- 多文件夹项目的其他文件夹尚未实现：交付只看主文件夹。
- 找不到 Git 时 409 `git-no-git`；受限的 Git 读取失败是 500 `git-failed`；Host 正在关闭时写入是 503 `host-closing`。

## 两类 Git 进程

Host 不运行仓库里的程序，交付除外：读取与多数索引写入用受限的 Git，只有人按下的提交、推送与带 filter 的暂存以你的账户运行 Git。

### 受限的 Git

运行器是 `apps/host/src/changes/git.ts` 的 `GitReader`，改动记录（[CHANGES.md](CHANGES.md#只读-git)）与工作树（[BRANCHES.md](BRANCHES.md#新建工作树)）用同一个。每个进程：

- **固定选项。** `--no-pager`、`core.fsmonitor=`、`core.hooksPath=/dev/null`、`diff.external=`、`protocol.allow=never`、`core.untrackedCache=false`、`core.alternateRefsCommand=`、`commit.gpgSign=false`、`tag.gpgSign=false`、`core.editor=:`。
- **重建的环境。** 只有 `PATH=/usr/bin:/bin:/usr/sbin:/sbin`、`HOME`、`GIT_OPTIONAL_LOCKS=0`、`GIT_NO_LAZY_FETCH=1`、`GIT_TERMINAL_PROMPT=0` 与调用给的变量；`GIT_DIR`、`GIT_WORK_TREE` 固定为检查过的布局，Host 自己的环境不传入。
- **配置里的钩子。** `core.hooksPath` 关不掉 Git 2.54 起的 `hook.<名>.*`，所以每次运行前先列出所有作用域的配置，为每个名字加 `-c hook.<名>.enabled=false`。`hook.` 下形状不认识、或名字含 `=` 与换行的键无法这样关掉：`unsafe-config`，什么也不运行。
- **边界。** 自己的进程组，超时（默认 10 秒，交付的读取 30 秒）或输出超限时 SIGKILL 整组；标准错误丢弃。
- **Git 的位置。** macOS 上依次找 `/opt/homebrew/bin/git`、`/usr/local/bin/git`、命令行工具与 Xcode 里的 Git，不用 `/usr/bin/git`（没有开发者工具时它会弹出安装窗口）。

它在交付里做这些事：

| 用途 | 命令与规则 |
| --- | --- |
| 状态 | `status --porcelain=v2 -z --branch --untracked-files=all --no-renames --ignore-submodules=all`。比较工作区会运行 clean filter，所以配置里的每个 filter 驱动在这个进程里经环境的命令行配置置空（不改文件）：这类文件可能显示为已修改。子模块不列出。领先落后只用本地引用，不 fetch：`fetchedAt` 是 `FETCH_HEAD` 的时间，落后数只作那时的数并与这个时间一起显示，没有它就不显示落后数，也不说已是最新。`base` 是 main 或 master（先远端的）与 HEAD 比它多的提交数，就在它上面时是 0。 |
| 无 filter 驱动的仓库的暂存 | `add --pathspec-from-file=- --pathspec-file-nul` |
| 取消暂存 | `reset --quiet --no-refresh --pathspec-from-file=- <HEAD>`；还没有提交时 `rm --cached --ignore-unmatch`。不碰也不比较工作区，filter 同样置空。 |
| 按行暂存与取消暂存 | `hash-object -w --no-filters --stdin` 与 `update-index -z --index-info`；不运行 `git apply`，不经任何 filter，有没有 filter 驱动都在这里。 |
| 历史 | `rev-list`、`merge-base --is-ancestor`、`diff-tree --raw` 与 `--numstat`（带 `--no-ext-diff --no-textconv --no-renames`）、`cat-file --batch`。行级差异由 Host 比较两个 blob，不让 Git 输出补丁。 |
| 提交前的检查 | `var GIT_COMMITTER_IDENT` 与 `GIT_AUTHOR_IDENT`、配置、钩子目录的文件名（只列出）。`write-tree` 会写树对象，所以在复查与审计之后才运行。 |
| 推送之后 | 记下上游：`config branch.<分支>.remote` 与 `.merge` |

受限的写入另加 `gc.auto=0`、`maintenance.auto=false`、`submodule.recurse=false`，路径按字面读（`GIT_LITERAL_PATHSPECS=1`）。

### 你的 Git

唯一具名的例外：提交、推送（含重试时的 `ls-remote`），以及仓库配置了 filter 驱动（如 Git LFS）时的按文件暂存。由人按下，先复查权限、先写审计，再以这台电脑上你的账户运行系统 Git：仓库的钩子、filter、凭据助手与 `core.sshCommand` 照常运行，与在终端里运行相同。它不是沙箱，也不隔离任何东西。

filter 驱动的名单在暂存之前读一次，名单为空就由受限的 Git 暂存。剩下的窗口：名单读出之后、`add` 启动之前（其间有复查与审计）才加进配置的驱动不在名单里，受限的 `add` 没有把它置空。

- **进程。** 你的登录 shell 读完 profile 后 `exec` Host 找到的 Git（`-C <仓库>`）。shell 取账户数据库里的 sh、bash、zsh、ksh 或 dash，`argv[0]` 以 `-` 开头；其他 shell 换成 `/bin/zsh`。进程在自己的进程组里、没有控制终端，标准输入为空，从不经 Agent 进程。
- **环境。** 终端的环境（`terminalEnvironment`，见 [TERMINAL.md](TERMINAL.md#终端服务)）去掉终端标记，`TERM=dumb`。profile 之后再设 `GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`、`SSH_ASKPASS_REQUIRE=never`、`GIT_EDITOR=:`、`GIT_PAGER=cat`、`LC_MESSAGES=C`（Git 的消息是英文，才能归类），去掉 `GIT_ASKPASS`、`SSH_ASKPASS`、`LC_ALL`、`LANGUAGE`：没有任何提示能等待回答。
- **秘密。** 模型密钥、设备凭据、`lmg1.`、`LATCH_*` 与 Node、Electron 开关都不在这个环境里。Latch 不读取、不保存、不审计任何 Git 凭据，也不把它们放进参数或环境。
- **内容不进参数。** 提交信息、路径与 PR 正文只写进新建的 0700 临时文件夹里的 0600 文件（`--file=`、`--pathspec-from-file=`、`--body-file=`），结束后删除。只替换整个占位参数，标题里的同样文字原样交出。
- **钩子名。** `GIT_TRACE2_EVENT` 写到同一个临时文件夹，Host 每 0.5 秒读顶层 Git 的 `child_start`/`child_exit` 事件，得到正在运行与失败的钩子名。
- **时限。** 提交（含钩子）10 分钟，推送与暂存各 2 分钟；超时向整个进程组发 SIGTERM，5 秒后 SIGKILL。钩子留下的后台进程拿着输出管道时，Git 退出 1 秒后关闭管道，不等它们。

## 权限

| 路由 | 权限 |
| --- | --- |
| `GET git` | `view`，数据范围 `files` |
| `GET git/diff`、`git/history`、`git/history/:sha`、`git/compare` | `view`，数据范围 `files` |
| `POST git/stage`、`git/unstage`、`git/stage-lines`、`git/unstage-lines` | `run`，数据范围 `files` |
| `POST git/commit`、`git/push` | `run`；私有会话要数据范围 `all` |
| `GET git/pr` | `view`；私有会话要 `all`；评论与默认标题只给 `all` |
| `POST git/pr` | `run`；私有会话要 `all` |
| `GET git/pr/checks/:job/log` | `view`，数据范围 `files`（日志可能含代码） |
| `POST /link/api/workbench/delivery` | `view`，数据范围 `files` |

- 列出或指定文件的路由只给能浏览会话文件的设备，其他设备 403 `file-scope`。私有会话（`hub.agentPrivate`）对范围不是 `all` 的设备一律 403 `agent-scope-required`。
- 提交与推送不涉及文件名，有 `run` 的设备（包括手机）都可以：这样的设备已能让 Agent 在这个仓库里执行任意命令，交付没有新增能力。
- 写入先过发消息的检查（`assertSessionInput`：会话的访问、只读会话、项目仍可用）。
- **复查。** Git 运行之前、写审计之前、所有异步读取之后再做一次：`assertSessionInput`、设备权限、数据范围、私有会话、会话的工作目录没有变（否则 409 `workspace-changed`）。读取在返回之前也再查一次，期间被收紧的不返回。
- **回合。** 暂存、取消暂存与提交时，同一文件夹里不能有运行中或等待审批的回合：这个会话自己的，以及文件夹相同、包含或位于其中的其他会话的，否则 409 `git-turn-running`。推送与 PR 不改文件，回合运行中也可以。
- **安装更新。** 更新窗口确定后，每个交付写入在读任何回执之前就是 409 `host-updating`；已在运行的写入计数，安装等它结束。

## 一次一个写入

- 同一仓库（共同 Git 目录，各工作树共用）同时只做一个写入，另一个得到 409 `git-busy` 与进行中的写入 `{ kind, requestId, startedAt, hook? }`。
- 移除这个仓库的一个工作树（[BRANCHES.md](BRANCHES.md#移除工作树)）持有同一把锁（`RepositoryHolds`），其间的交付写入同样 409 `git-busy`，反过来也是。
- `GET git` 的 `running` 让所有设备看到同一个进行中的写入；写入开始与结束时 Host 为这个会话推送新的修订。
- 仓库正在合并、变基、拣选或还原时，除 PR 外的写入 409 `git-operation-in-progress`，在终端里完成后再试；状态里给 `gitOperation`。标记读不出时按进行中处理。
- 同一 `requestId` 的请求进行中再来一次，等同一个答复；换了内容或操作是 409 `request-conflict`。

## 暂存与取消暂存

请求 `{ requestId, paths }`，1 到 1,000 个路径，回答 `{ files, filtered? }`（`filtered`：经你的 Git 与仓库的 filter 暂存）。

- 路径相对仓库顶层、`/` 分隔，至多 4,096 字节，不含空段、`.`、`..`、反斜杠、控制字符或 `.git`。沿途的文件夹不能是符号链接；文件本身可以是链接，Git 存的是链接。
- 有一个不符合就整次 400 `git-paths-invalid`，什么也不运行。
- Git 拒绝（例如被忽略的文件）时 422 `git-stage-failed`；超时是 504 `git-result-unknown`。
- 重复安全，所以同一 `requestId` 的回答只留在内存里（最近 512 个），没有回执。

## 按块与按行暂存

Host 从不接受客户端的补丁文字：它自己读文件与索引条目，用自己的行比较得到差异，再从选中的行拼出索引应有的内容（`changes/git-hunks.ts`）。

**读。** `GET …/git/diff?view=unstaged|staged&path=` 回答 `GitHunkDiff`：`unstaged` 是工作区对索引，`staged` 是索引对 HEAD。

- `hunks` 以整个文件作上下文，改动的行以 `oldLine` 或 `newLine` 为名。
- `base` 是读取时的版本：`worktree` 是文件字节的 SHA-256，`index` 与 `head` 是 Git 的对象 ID。
- 只能整个处理的文件只回答 `whole`，没有 `hunks`，也没有 `base`：它的内容连哈希也不给。

**写。** `POST …/git/stage-lines`、`unstage-lines`，请求 `{ requestId, path, base, old?, new? }`。`old` 是选中的删除行、`new` 是选中的新增行，各为闭区间 `[from, to]` 的数组。

- 每一边至多 500 段，从小到大、互不重叠，合计至多 20,000 行；不符合的在展开任何一段之前就是 400 `git-selection-invalid`。带别的字段（包括补丁文字）是 400。
- 一次写入按这个顺序进行，任何一步不成立就什么也不写：

| 步骤 | 规则 |
| --- | --- |
| 读取 | 路径与按文件暂存同样检查，按字面读。工作区文件用 `O_NOFOLLOW` 打开，再核对它的真实路径就是仓库真实文件夹下的这个位置、且那里的文件就是打开的这一个；沿途文件夹被换成链接时读到「没有这个文件」。至多读 1 MB 加一个字节，超过算太大。索引条目经 `ls-files -s --debug`、HEAD 的条目经 `ls-tree`、内容经 `cat-file --batch`、属性经 `check-attr`（读各级 `.gitattributes` 与 `info/attributes`，不运行任何东西）。 |
| 核对版本 | 暂存核对 `worktree` 与 `index`，取消暂存核对 `index` 与 `head`；有一项不同是 409 `git-file-changed`，`changed` 写 `worktree`、`index`、`head` 或 `both`。 |
| 拼出内容 | 选中的行号必须都是这份差异里的改动行，否则 409 `git-selection-invalid`；没有选中任何行或行号越界是 400。暂存是「索引的内容加上选中的改动」，取消暂存是「索引的内容退回选中的改动」。 |
| 复查与审计 | 调用方的复查，再写审计 `git.stage` / `git.unstage`（`files: 1` 与行数 `lines`，不写路径）；写不进去就不执行。 |
| 重读 | 审计之后再读一次，内容或被替换的条目不同就拒绝。 |
| 回执 | 记 `pending`（见下）。 |
| 写入 | `hash-object` 给出的对象 ID 必须等于 Host 算出的；再读一次这个索引条目，仍是计划时的模式与对象 ID 才由 `update-index` 换掉它（模式不变），否则 409 `git-file-changed`。两个写进程都在读取钩子配置之后再复查权限与回合。工作区的文件从不改动。 |

- **拼接细节。** 同一个改动块里删除行与新增行按位置配对，所以选中一对替换时新行落在旧行的位置。换行符逐字节保留（CRLF 文件仍是 CRLF）；原先没有结尾换行的行不再是最后一行时补上文件用的换行。
- **审计的结果。** 写过审计的每一次都以 `git.result` 结束：完成、结果未知，或失败与固定原因（`git-file-changed`、`git-file-whole`、`git-selection-invalid`、`git-stage-failed`）。
- **授权在中途失效。** 对象已写入但授权在更新索引前失效时，索引保持原样，当前调用返回权限或回合的拒绝，回执记失败；授权恢复后重试同一请求得到 `git-stage-failed` 与 `replay`，不会再更新索引。
- **剩下的窗口。** Git 没有针对单个索引条目的「比较后替换」。Host 之外的程序（终端里的 `git add`）在最后一次读取与 `update-index` 拿到 `index.lock` 之间写了这个条目时，它对这一个路径的改动会被盖掉；`index.lock` 保证索引本身不坏。

**回执。** 与提交同一种（操作 `stage` / `unstage`），记被替换的条目 `preIndex`、写入的 blob `resultOid` 与行数。写入之前记 `pending`，写不进去是 503 `git-receipt-unsaved`、不执行；之后记 `done`、`failed`，或超过 2 分钟记 `unknown` 并回答 504 `git-result-unknown`。同一请求重试：

| 回执 | 索引里这个条目 | 回答 |
| --- | --- | --- |
| `done` | 不看 | `{ lines, replay: true }`；不写入、不记审计，落地之后被别的设备取消暂存了也不会再写一次 |
| `failed` | 不看 | 原来的原因，带 `replay` |
| `pending` 或 `unknown`（含 Host 在写入前后停止） | 是 `resultOid` | 那次写入落地了：记 `done`，回答 `replay`，文件之后变没变都一样 |
| 同上 | 仍是 `preIndex` | 没有写入：这个请求照新的执行（重新核对、重新审计），这时的 409 才是定论，并记进回执 |
| 同上 | 两者都不是，或读不出 | 无从判断：504 `git-result-unknown`，回执不变 |

没有回执的请求从未开始写入，它的拒绝都是定论。

**只能整个处理的文件。** `GET git/diff` 给 `whole`，按行写入是 409 `git-file-whole`（带同一个 `whole`）；请求带着的版本已经过期时先回答 409 `git-file-changed`。

| `whole` | 情况 |
| --- | --- |
| `binary` | 不是 UTF-8 文字；或 Git 自己的判断（`text=auto`、`core.autocrlf`）把内容当作二进制：有单独的 CR，或每 128 个字符里有不止一个不可打印的 |
| `large` | 一边超过 1 MB，或超过 20,000 行（整个文件作上下文的上限） |
| `new`、`deleted` | 一边没有这个文件；重命名在这里是一个删除加一个新文件；`git add -N` 只登记了的文件也是 `new` |
| `mode`、`link`、`submodule` | 执行位变了（`core.fileMode=false` 时执行位不算改动，沿用索引里的）；符号链接；子模块 |
| `conflicted` | 有冲突，在终端里解决 |
| `filtered` | 这个文件有 `filter` 属性：只有按文件暂存才以你的 Git 运行 filter |
| `converted` | `ident`、`working-tree-encoding`，或 Git 会转换换行而 Host 不能确定结果（索引里已有 CR，或文件里有单独的 CR） |
| `secret` | 名称或内容像密钥，从不给内容 |
| `unchanged` | 两边的文字相同 |

Git 会把换行转成 LF 的文件（`text`、`eol` 属性或 `core.autocrlf`）在索引没有 CR、文件里的 CR 都属于 CRLF 时，按 Git 会存下的 LF 比较与写入，所以只显示真正改动的行。

## 历史

只读，都经受限的 Git，行级差异由 Host 比较两个 blob（`changes/git-history.ts`）。没有写入，不写审计。

提交、文件名与行都是会话文件夹里的内容，所以每个历史读取都只给数据范围 `files` 的设备，其他设备 403 `file-scope`：没有不带文件名的摘要，也无从用提交 ID 试探。

| 路由 | 内容 |
| --- | --- |
| `GET …/git/history` | 这个会话的提交，新的在前，最多 50 个（更多时 `more`）。`range` 说明是哪些，见下。 |
| `GET …/git/history?path=` | HEAD 的历史里改过这个文件的提交（`range: 'file'`），同样最多 50 个 |
| `GET …/git/history/:sha` | 这个提交相对第一父提交改动的文件（没有父提交时相对空树），最多 500 个，带增删行数；`?path=` 是其中一个文件的行 |
| `GET …/git/compare` | HEAD 相对它离开基线处（合并基点）已提交的改动，不含工作区；`?path=` 同上。没有基线时 409 `git-no-base` |

- **`range`。** `base`：当前分支离开 `main`（否则 `master`；先本地，再 `origin`）之后第一父提交线上的提交。没有这样的基线而有上游时 `upstream`：上游还没有的。都没有时 `recent`：HEAD 最近的。HEAD 就在基线分支上或分离时没有基线。
- **只读 HEAD 的祖先。** `:sha` 必须是 HEAD 的祖先，否则 404 `git-commit-not-found`，所以别的分支与悬空对象读不到。提交没有改这个文件时同样 404。
- **文字。** 主题（200 字符）与作者（100 字符）截短、去控制字符、经 `redactSecrets`。
- **不给行的文件。** 链接与子模块、超过 1 MB 或 20,000 行、二进制、名称或内容像密钥的文件不给 `hunks`，`hidden` 写原因；名称像密钥的文件在列表里也不给行数。超过 500 个文件的提交不算行数。
- **时限。** 列提交、列文件与算行数的进程最多 10 秒。

提交图、跨分支的历史与标签尚未实现。

## 提交

请求 `{ requestId, message, skipHooks? }`，成功回答 `{ commit, hookOutput? }`（钩子运行过且有输出时给 `hookOutput`）。

- 信息必填，最多 64 KB，不含 NUL，否则 400 `git-message-invalid`；`--cleanup=whitespace`。
- 默认运行钩子；`skipHooks` 是这一次的 `--no-verify`，从不记住。从不 `--amend`、`-a` 或允许空提交。
- 先拒绝（都是 409）：有冲突的文件 `git-conflicted`，没有暂存 `git-nothing-staged`，Git 不知道提交者 `git-identity-missing`。
- 失败时没有生成提交，暂存不变：钩子失败 422 `git-hook-failed` 带 `hook`、`exitCode` 与 `tail`，其他 422 `git-commit-failed` 带 `exitCode` 与 `tail`。
- `tail` 是 Git 与钩子输出的最后 256 KiB：去掉转义序列、回车覆盖与控制字符，再经 `redactKnownSecrets`。

## 推送

请求 `{ requestId }`，不接受地址；成功回答 `{ remote, ref, sha, setUpstream? }`。

- **引用。** 总是推到远端上与当前分支同名的分支（`refs/heads/<分支>`，先经 `check-ref-format`）。
- **远端只来自仓库配置**，所以不触发新出站地址的确认。按顺序取：

| 配置 | 远端 | 不成立时 |
| --- | --- | --- |
| 设了推送远端（`branch.<分支>.pushRemote`，否则 `remote.pushDefault`） | 它 | 不是仓库配置的远端：409 `git-remote-invalid` |
| 有上游（`branch.<分支>.remote` 与 `merge`） | 上游的远端 | 上游是另一个分支：409 `git-upstream-other-branch`；不是配置的远端：409 `git-remote-invalid` |
| 都没有而有 `origin` | `origin` | 没有 `origin`：409 `git-no-remote`（提交留在本地，不算失败） |

- 分支没有配置上游时（经推送远端或 `origin`），推送成功后由受限的 Git 记下上游（`setUpstream`）。

- **从不强制。** 命令是 `push --porcelain --no-follow-tags --recurse-submodules=no <远端> <提交>:refs/heads/<分支>`：没有 `--force`，引用规则不带 `+`；显式的引用规则让配置里的推送规则不适用；标签与子模块不随推送。
- 新请求遇到分离 HEAD 409 `git-detached`，还没有提交 409 `git-no-commit`。
- **失败归为固定原因，原始输出不给客户端**，都是 422：

| 原因 | 情况与附带 |
| --- | --- |
| `git-hook-failed` | `pre-push` 没通过，带 `hook`、`exitCode`、`tail` |
| `git-push-remote-rejected` | 远端钩子拒绝，带经脱敏的 `remote:` 行 `remoteLines`（最多 100 行） |
| `git-push-non-fast-forward` | 远端有这里没有的提交；界面给出 `git pull` 与「在终端里打开」 |
| `git-push-auth`、`git-push-host-key`、`git-push-unreachable` | 凭据、主机密钥、连不上 |
| `git-push-failed` | 其余，带 `exitCode` |

## 回执与结果未知

提交、推送、PR 与按行暂存的回执随会话元数据持久化（`sessions-meta.json` 的 `receipts`，种类 `git`，按会话、设备与 `requestId`，保留 7 天）。

- Git 运行之前写入 `pending`，写不进去就 503 `git-receipt-unsaved` 且不执行。
- 超时、Host 停止或重启后，回执是「结果未知」：504 `git-result-unknown`。从文件读回的 `pending` 也是未知。
- 同一 `requestId` 换了内容 409 `request-conflict`。
- `done` 的回执回答原结果，`failed` 的回答原因（不带输出），都带 `replay`，不再运行任何东西。

### 提交的重试

回执记 `preHead`（之前的 HEAD）、HEAD 指向的分支 `headRef`（分离时是 `HEAD`）、暂存的树、首行的哈希、是否跳过钩子。Git 说提交成功时，新的 HEAD 以 `preHead` 为第一父提交就是这次的提交（钩子改了信息也认得）。

结果未知的重试从不再运行提交，只看仓库：

| 仓库现在 | 回答 |
| --- | --- |
| HEAD 第一父提交线上最近 64 个提交里，有第一父提交是 `preHead`、首行相同（跳过钩子时树也相同）的 | 那个提交，带 `replay` |
| HEAD 仍在 `headRef` 上、仍是 `preHead`，且没有 `index.lock` | 409 `git-commit-not-made`（带 `replay`；可以用新请求重新提交） |
| 其余：换了分支（提交可能在原分支上）、文件夹已不是 Git 仓库、找不到 Git、回执没有 `headRef` | 仍是结果未知 |

钩子改了首行的提交在重启后找不回来，只会停在结果未知，不会提交第二次。

### 推送的重试

回执记远端、引用、提交与远端由哪条规则选出。重试只用回执里的这三项，不看 HEAD 现在在哪：分离 HEAD 或换了分支也照常。只有记下上游要等 HEAD 在那个分支上，否则不记，回答与审计也不带它。

重试在结果确定之前不改写回执；确定之后写不进去只记日志，原回执留着，下一次重试仍推同一个提交。

先查看远端的分支：`ls-remote` 只按远端名读取，从不把地址放进参数。推送去的地址与读取的地址不同（设了不同的 `pushurl`、有不止一个推送地址、配置里有 `pushInsteadOf`，或从配置解不出）时不读远端，算读不出。

| 远端的分支 | 之后 |
| --- | --- |
| 已是这个提交，或这个提交是它的祖先 | 完成 |
| 停在这个仓库没有的提交上 | 无法判断：结果未知（带 `remoteSha`），不再推送 |
| 没有这个提交，或读不出 | 把同一个提交再推到同一处（非强制推送同一提交本身幂等），成功就完成 |

再推失败时再查看一次远端（第一次可能仍在落地：服务器上慢的钩子，或 Host 重启后还在运行的 Git）：

- 已有这个提交：完成。
- 远端答复了、仍没有它：非快进，以及引用被锁或旧值不符（`cannot lock ref`、`failed to update ref`、`reference already exists`、`is at … but expected`）仍是结果未知；其余失败（远端钩子拒绝、`pre-push`、凭据、主机密钥、连不上、其他）记为失败。
- 第二次读不出：仍是结果未知，远端恢复后用同一请求再试。

在查看之前就拒绝的（文件夹已不是 Git 仓库、找不到 Git、仓库被另一个写入或移除工作树占用、合并进行中、Git 读取失败、审计没写进去、Host 正在关闭）都回答 504 `git-result-unknown`，回执不变。只有调用方的复查（设备权限、数据范围、会话、文件夹变了）与 `host-updating` 照原样拒绝。

## 审计

- 写入之前记 `git.stage`、`git.unstage`、`git.commit`、`git.push`、`git.pr.create` 或 `git.pr.link`，写不进去就不执行。
- 之后记 `git.result`（`outcome`：done、failed、unknown，固定原因，提交的 SHA 或 PR 编号），写不进去只记日志。
- 内容只有：会话、请求标识的哈希、文件数与行数、是否经 filter、提交前的 SHA、钩子名单（只取 Git 认识的钩子名）、是否跳过钩子、推送的提交、远端由哪条规则选出（`upstream`、`push-remote` 或 `origin`）、远端名与引用（PR 是分支与基线）的哈希、是否草稿。
- 不写路径、信息正文、标题、远端名或地址，也不写任何输出。
- 读取（状态、历史、只读的 `gh`）不写审计。

## 状态

`GET git` 回答 `GitDeliveryState`（`packages/protocol/src/git-delivery.ts`）。

- 四组文件 `staged`、`unstaged`、`untracked`、`conflicted` 合计最多 2,000 条，其余数目在 `more`。
- `hooks`：`core.hooksPath` 或共同 Git 目录 `hooks/` 下可执行的、Git 认识的钩子名，只列出，不运行；配置里的 `hook.*` 钩子不列出。
- `filters`：配置里有 filter 驱动。`remote`：推送会去的远端名。
- 分支与上游名按分支读取的规则显示：像密钥的不给，隐藏字符可见。
- 快照里的「有未提交 / 领先 N」摘要尚未实现：它会让每次快照都运行 Git。

**工作台摘要。** 只读的 `POST /link/api/workbench/delivery` 取至多 12 个当前可见会话的摘要，复用交付服务与权限检查，读取前后都复查，收紧权限时整批不返回。

- 只给文件数量（部分暂存的文件只计一次）、分支、领先落后、进行中的写入和已绑定 PR 的检查；不给文件名、钩子、评论或 PR 默认正文。
- 同批次相同目录只读一次，并发的相同读取共用在途结果；每批最多三个读取，全 Host 最多两批（再多 429 `rate-limited`），结束后不缓存、不轮询。
- 没有绑定 PR 的会话不启动 `gh`，也不查询远端。
- 仓库与 PR 各带实际读取时间；单项失败保留固定错误码，不把读取失败当成没有改动或检查通过。
- **普通文件夹。** 只有 Host 证明目录有效、直属 `.git` 确实不存在、读取前后目录与各级祖先的身份都没变时，才回答 `notApplicable: "not-repository"`（`workbench-git-eligibility.ts`）。损坏的 HEAD、不受信的元数据、链接、权限错误与读取竞态保留错误，不能只凭 `git-not-repository` 推断普通文件夹。这不是操作系统提供的原子目录快照。

## PR 与检查

PR 只做 GitHub，只经你的 `gh`（GitHub CLI）；其他平台尚未实现。`GET …/git/pr` 读，`POST …/git/pr` 创建或绑定，`GET …/git/pr/checks/:job/log` 读一个失败任务的日志。从不关闭、合并或改写 PR。

### 你的 gh

与提交、推送同一个运行器与环境：登录 shell 读完 profile 后 `exec gh`（profile 设定的 PATH 找到哪个就是哪个），标准输入为空。

- profile 之后去掉 `GH_ENTERPRISE_TOKEN`、`GITHUB_ENTERPRISE_TOKEN`、`GH_HOST`、`GH_REPO`、`GH_DEBUG`、`DEBUG`、`GH_MDWIDTH`：企业版 token 会发往 `--repo` 指的任何主机，其余会换主机或打印请求。
- 另设 `GH_PROMPT_DISABLED=1`、`GH_NO_UPDATE_NOTIFIER=1`、`GH_NO_EXTENSION_UPDATE_NOTIFIER=1`、`GH_SPINNER_DISABLED=1`、`GH_PAGER=cat`、`PAGER=cat`、`NO_COLOR=1`、`CLICOLOR=0`。
- `gh` 用它自己的登录（它的配置与系统钥匙串）。Latch 从不运行 `gh auth token`，不读取、不保存 token；Host 环境里的 `GH_TOKEN`、`GITHUB_TOKEN` 不在终端环境的白名单里，也不进参数。
- 只读的 `gh` 最多 30 秒（日志 60 秒），超时 504 `gh-unreachable`；`gh pr create` 最多 60 秒。

### 仓库与主机

- 远端与「推送」同一规则。它的地址经受限的 Git `ls-remote --get-url`（应用 `insteadOf`，不连接）读出，必须是 `http(s)://`、`ssh://`、`git://` 或 `user@host:` 形式的 `owner/repo`，否则 409 `gh-no-remote`。
- 每个 `gh` 命令都带 `--repo <host>/<owner>/<repo>`，`gh api` 总带 `--hostname`，不让 `gh` 自己从远端猜。
- 主机只能是 `github.com`、`*.ghe.com`，或 `gh auth status --hostname <主机>`（不打印 token，肯定的结果记 5 分钟）说已登录的 GitHub Enterprise Server；登录已失效是 409 `gh-logged-out`，其他主机什么也不运行。
- SSH 别名 `github.com-<名字>`（只在 SSH 形式里、名字里没有点）与 `ssh.github.com` 当作 `github.com`；https 的 443 端口不算主机的一部分。
- 分支名必须是 `gh` 接受、元数据能存下的名字（最多 200 个字符），否则 409 `pr-input-invalid`，在审计之前。

### 创建或绑定

请求 `{ requestId, title, body, base, draft? }`：标题一行、最多 256 个字符，基线是分支名，正文最多 64 KB，否则 400 `pr-input-invalid`。

1. 分支还不在远端（没有 `refs/remotes/<远端>/<分支>`）：409 `pr-not-pushed`。
2. 基线就是这个分支，或推送远端的基线引用（没有时用本地的同名分支）已含这个分支的全部提交：409 `pr-nothing-ahead`，界面也不给「创建 PR」。
3. `gh pr list --head=<分支> --state open`。这个分支在推送远端的仓库里有已开的 PR（不是分叉来的）就绑定它：复查、记审计 `git.pr.link`，回答 `linked`，不新建。它的基线存不进元数据（超过 256 个字符或有控制字符）时 409 `pr-exists-elsewhere`，同样不新建。
4. 没有才复查、记审计 `git.pr.create`、写 `pending` 回执，再 `gh pr create --head=<分支> --base=<基线> --title=<标题> --body-file=<0600 文件> [--draft]`。
5. 读出它打印的地址；地址不在推送远端的仓库里时不绑定，算结果未知。
6. `gh` 说这个分支已有 PR 时再查一次，查到就绑定，查不到是 409 `pr-exists-elsewhere`。

**回执。** 操作 `pr`，记下绑定的 PR。`gh pr create` 超时、答复里没有地址或连接中断是 504 `git-result-unknown`；同一请求重试先按分支查找，找到就是那一次建的（`replay`），找不到才再建。

**绑定。** 会话元数据 `pr: { number, url, base, head }`。

- 绑定的基线只用于显示，从不交回给 Git。
- 写不进去只记日志：下次「创建 PR」会查到它并绑定。
- 元数据的每次修改先按 schema 检查，不符合就 500 `session-meta-invalid`、不写入。
- 绑定的 PR 已合并或关闭、而这个分支在远端已前进到它的头提交之外时解除绑定，可以建下一个。

### 状态、评论与日志

- **有绑定。** `gh pr view <n> --json …`：PR 的状态、草稿、审阅结论、头提交，以及头提交的检查（最多 200 项）。检查归为 `pass`（`SUCCESS`）、`skipped`（`NEUTRAL`、`SKIPPED`、`STALE`）、`pending`（未完成）与 `fail`（其余）；失败的 GitHub Actions 任务带 `job`，只认详情地址在这个仓库里的。
- **没有绑定。** 回答 `draft`：仓库默认分支；`all` 的设备另有最后一个提交的主题作默认标题。
- **评论。** 只给数据范围 `files` 的设备。审阅与评论各取最新 100 条，行级评论取最新 100 条，合起来按时间排列、最多 200 条；每条正文最多 8 KiB，去控制字符并经 `redactKnownSecrets`。有省略时 `discussionCapped`。评论读不出来时检查照常显示。
- **检查日志。** 只给绑定 PR 当前检查里失败的那个任务：`gh run view --job <id> --log-failed`，去掉任务名、时间与分组标记，按步骤加 `[步骤]` 行，再去控制序列并脱敏，留最后 200 行、最多 32 KiB（`truncated`）。不是这样的任务，或日志已不在，都是 404 `pr-check-not-found`。
- **固定原因。** `gh` 的原始输出不给客户端：

| 原因 | 情况 |
| --- | --- |
| `gh-missing`（409） | 找不到 `gh`（退出码 127） |
| `gh-logged-out`（409） | 退出码 4、401 或要求 `gh auth login` |
| `gh-no-remote`（409） | 推送远端不在 GitHub，或 GitHub 上找不到这个仓库 |
| `gh-unreachable`（502，超时 504）、`gh-failed`（502） | 连不上；其余失败或输出读不出 |
| `pr-create-failed`（422） | 带经脱敏的 `gh` 输出最后 20 行、最多 4 KiB |
| `pr-exists-elsewhere`、`pr-not-pushed`、`pr-nothing-ahead`、`pr-input-invalid`、`pr-check-not-found` | 见上 |

## 验证

用例与运行方式见 [TESTING.md](TESTING.md#按改动选择回归) 的「Git 受限运行器、工作树与交付」一行。夹具的边界：

- Host 的用例用临时仓库、空的家目录和本地裸仓库作远端，不连网络。
- PR 的用例用 `@latch/testkit` 的假 `gh`（`installFakeGh`）：一个只把它放在 PATH 最前面、不是登录 shell 的 `/bin/sh` 交给测试的交付运行器，远端地址写成 GitHub、推送地址是本地裸仓库，所以不会找到真的 `gh`，也不连 GitHub。
- 假 `gh` 被要求 `auth token`、环境里有像 token 的变量或值时记一次违规并退出；用例在 Host 环境里放了 `GH_TOKEN` 并要求没有违规。
- 这些都不证明真实 GitHub、真实 `gh` 登录、凭据助手与登录 shell 的 profile 之下的行为。

## 界面

「交付」页签（`apps/web/src/panel/delivery`）在 Host 有 `gitDelivery`、设备有 `view`、会话不是只对话时出现。按行暂存与历史在「改动」页签范围菜单的「Git」一组（`apps/web/src/panel/changes`）。这里只写界面必须守的规则：

- **只按 Host 读回的状态显示。** 每次按下一个请求、一个 `requestId`，按顺序一次发一个；未答复前那一行转圈，列表不提前移动。任何设备发起的写入进行中时所有写入停用。
- **一个主按钮**，随状态是暂存全部、提交、推送或创建 PR。PR 一节只在分支已在远端（上游是同名的远端分支）时出现。
- **跳过钩子**每次提交后复位；结果未知时保持到重试，因为重试必须发同样的内容。
- **加入对话**（钩子输出、检查日志、评论）只把围栏摘录放进会话输入框的草稿，从不发送；钩子输出取最后 80 行，围栏比内容里最长的反引号多一个。
- **检查是唯一画出的依据。**「Agent 说通过」「命令通过」没有可靠记录，不画。头提交不是这里的 HEAD 时标「旧提交」；工作台总览在头提交不同、缺头提交、无结果、草稿或读取失败时只留文字。
- **需要复验。** 提交或推送之后，这个页面又在文件预览里保存过这个会话的文件（[DOCUMENT-PREVIEWS.md](DOCUMENT-PREVIEWS.md#编辑)）时标出：钩子的结果不包括那些修改。只记在页面内存里。
- **数据范围。** `GET git` 回答 403 `file-scope` 的设备看到锁住的列表，仍可提交已暂存的与推送非私有会话；只读会话与离线时不给写入。

**结果未知。** 没有答复（504 `git-result-unknown`、超时或断线）时是中性的一行与「重试同一请求」，沿用原 `requestId` 与原内容（`writeEnd`）。

- 重试只在这些答复上结束：完成；回执的答复（`replay`）；推送在查看远端之后的失败（`git-push-remote-rejected`、`git-hook-failed`、`git-push-auth`、`git-push-host-key`、`git-push-unreachable`、`git-push-failed`）；PR 按分支查找之后的 `pr-create-failed` 与 `pr-exists-elsewhere`；按行暂存的三种 409。
- 其他拒绝（400、403、429、会话的检查、`git-busy`、`git-turn-running`、`git-receipt-unsaved`、`host-closing`、断线）说明不了第一次：这一行保持，拒绝的原因写在下面，不自动重试。
- 「放弃这次结果」只在这个页面上放下它，电脑上的记录仍是结果未知。之后的新请求：提交只提交那时暂存的（没有再暂存时 409 `git-nothing-staged`），推送照常非强制，创建 PR 先按分支查找。
- 按文件暂存没有回执，重试的拒绝同样不算定论；「核对并放下」按读回的仓库状态显示并丢掉这台设备的待确认副本，不再发送。
- `host-updating` 从不算失败：第一次的写入什么也没变，更新结束后可以作为新请求再按；结果未知的重试遇到它仍是结果未知，保留原 `requestId`，跳过钩子也不复位。
- 这个会话的回合运行或等待时预先停用暂存与提交，推送照常；`git-operation-in-progress` 按 `gitOperation` 写合并、变基、拣选或还原进行中。

**读取的节奏。** 都是有界的跟读，不是后台轮询；页签藏起来时不读。

- 状态：打开页签、每次写入之后、回合结束、窗口回到前台、恢复连接，以及 Host 为这个会话推送新的修订且没有回合在运行时读一次。只有写入进行中且页签在屏幕上时每 1.5 秒读一次，写入结束即停。
- PR：打开页签、窗口回到前台、推送完成、按「刷新」与创建之后读一次。只有检查进行中且页签在屏幕上时每 30 秒读一次。

**手机与 App。** 手机的复核页（[CHANGES.md](CHANGES.md#界面)）把这个页签推成「提交」一页。iPhone/iPad App 的「提交」页由 `PhoneDelivery` 判断，规则与网页相同：

- 提交之后、暂存区已空而还有地方推送时，主按钮是「推送」：没勾上的文件是有意留下的。
- 提交最多等 630 秒，推送 270 秒（先 `ls-remote` 再推送），暂存 150 秒，之后是结果未知，只重试同一请求。
- App 里 PR 一节、按行暂存与历史尚未实现。
