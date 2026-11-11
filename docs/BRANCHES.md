---
description: Host 只读分支元数据、受限 Git worktree 验证与非阻塞摘要缓存；Host 为会话新建工作树与分支时不运行仓库里的程序（交付是唯一具名的例外，见 GIT-DELIVERY.md）；新会话可以在新工作树里开始。
sources:
  - apps/host/src/branch-reader.ts
  - apps/host/src/worktrees.ts
  - apps/host/src/changes/git.ts
  - apps/host/test/worktrees.test.ts
  - apps/host/test/worktree-sessions.test.ts
  - apps/web/src/composer/FolderControl.tsx
  - apps/host/src/hub.ts
  - apps/host/test/branch-reader.test.ts
  - packages/protocol/src/types.ts
  - apps/web/src/shell/ConversationHeader.tsx
  - apps/web/src/shell/ConversationHeader.tsx
  - apps/web/src/core/useHarness.ts
---
# 只读分支

`TaskSummary.branch` 是 Host 临时生成的展示字段。普通 HEAD 返回分支名，分离 HEAD 返回「分离于 3f2a1c9」；没有可验证元数据时省略，不把失败说成当前没有分支。它不写入会话存储，Hub 会移除 Driver 自报的值，由同一读取器装饰列表、摘要和详情。前端把它放在输入框的状态行（提示框写全名）与环境主文件夹旁，旧 Host 缺少字段时保持原显示。新会话还没有会话可装饰，`WorkspaceInfo.branch` 由同一读取器按项目主文件夹给出（`branchOf`）。

只读取 Git 元数据，不调用 Git，不读配置或 hooks；无法验证时状态行不显示分支，标题行项目弹层写「读不到分支」。

`readGitLayout` 返回这次检查得到的工作树与 Git 目录；改动记录（[CHANGES.md](CHANGES.md)）只在通过检查的布局上以只读方式运行 Git，分支读取本身仍不调用 Git。

`BranchReader.decorate()` 同步返回缓存，不让列表等待磁盘。每个 Host 最多缓存 256 个根、1,024 个会话观察值，最多四个实际读取且不排队，同根请求合并。摘要再次被消费且缓存满 30 秒时刷新；观察到一轮结束或工作目录改变时立即失效重读。读取期间再次失效会丢弃旧结果，并在原读取真实结算后重读。只有值变化才通知 Host 更新列表，关闭等待实际读取结束并禁止迟到结果发布。页面可见时每 30 秒请求现有快照/同步即可驱动刷新；不可见页面无需新增轮询。

# 新建工作树

Host 写 Git 只在两处：`apps/host/src/worktrees.ts` 新建工作树，交付（[GIT-DELIVERY.md](GIT-DELIVERY.md)）暂存、提交与推送。交付的提交、推送与有 filter 时的暂存是「不运行仓库里的程序」唯一具名的例外：由人按下、先写审计，以你的账户运行你的 Git；Host 自己做的其他事，包括这里新建工作树，仍不运行仓库里的程序。`worktrees.ts` 为一次开始请求从项目文件夹当前 `HEAD` 的提交新建一个 Git 工作树（worktree）和分支 `latch/<yyyymmdd>-<4 位十六进制>`，位置是 `<根>/<仓库名>-<源路径哈希前 8 位>/<yyyymmdd>-<4 位十六进制>`。根是启动目录旁边的 `worktrees`（默认 `~/Latch/worktrees`，`LATCH_WORKTREES_DIR` 可以换），不能在仓库、Host 数据目录或 Latch 自己的目录（程序目录、运行目录、Agent 安装目录）里或包含它们；测试传入自己的临时目录。未提交与未跟踪的改动不会带过去。工作树只分开文件：它与项目文件夹共用同一个仓库的 Git 配置、钩子与分支，端口、进程与本机权限仍与这台电脑上的其他会话共用，它不是隔离。会话元数据记下它（`sessions-meta.json` 的 `worktree: { path, branch, unfiltered? }`，摘要只给 `worktree: { branch, unfiltered? }`，Driver 自报的值被丢弃，也不会交给 Driver）。

**不运行仓库里的程序。** 每个 Git 进程都用重建的环境（不继承 Host 的任何 `GIT_*` 变量），带上只读 Git 的固定选项（钩子目录 `/dev/null`、`core.fsmonitor=`、`protocol.allow=never` 等），再加 `core.attributesFile=`、`attr.tree=`、`safe.bareRepository=explicit`、`submodule.recurse=false`、关掉自动 gc，以及 `GIT_LFS_SKIP_SMUDGE=1`、`GIT_NO_REPLACE_OBJECTS=1`。步骤：

1. 在项目文件夹读出全部 Git 配置（含 include 与全局配置），找出每个 filter 驱动；
2. `git worktree add --no-checkout -b <分支> <位置> <提交>`，不检出文件；
3. 在新工作树的 Git 元数据里写标记 `latch-session.json`（这次请求的哈希）；
4. 在新工作树里再读一次配置（配置可能随工作树与分支变化），把读到的每个 filter 驱动的 `clean`、`smudge`、`process` 置空、`required` 设为 false（经命令行配置，不改任何配置文件）；
5. `git reset --hard --no-recurse-submodules <提交>` 写出文件。被跳过 filter 的文件保持 Git 里存的样子，Git LFS 文件因此留为指针，结果里的 `unfiltered` 是这类文件的数目；子模块不检出。

**拒绝。** 下列情况返回 409 并写明原因与怎么改，不建工作树，也不建分支：项目文件夹不是仓库顶层（`worktree-not-repository`）、仓库还没有提交（`worktree-no-commit`）、找不到 Git（`worktree-no-git`）；某个 filter 驱动名含 `=` 或换行（`worktree-filter-name`）；仓库配置（`local` 与 `worktree` 范围）里有 `includeIf`（`worktree-include-if`）；有 `lfs.customtransfer.*.path` 或 `lfs.extension.*.clean/smudge` 这类指向程序的 LFS 设置（`worktree-lfs-program`）；位置或它的任何一级父目录是符号链接（`worktree-symlink`），位置不是完整路径或不是文件夹、在这个仓库里面或与 Host 数据目录重叠（`worktree-location`）。全局配置里的 `includeIf` 是允许的，它在新工作树里带进来的配置同样经过第 4 步检查。

**回滚。** 任何一步失败（含超时，检出最多等 10 分钟）都撤销这次做过的事：`git worktree remove --force` 移除工作树（失败时直接删除这个目录），分支只在仍指向起点时删除，空的仓库目录一并删除，返回 500 `worktree-failed`；撤销本身没完成时返回 500 `worktree-rollback-failed` 并写出剩下的位置与分支。

**`.worktreeinclude`。** 项目文件夹顶层有这个文件（gitignore 语法）时，复制项目文件夹里既被它匹配、又被 Git 忽略的文件（`.env` 之类）到新工作树的同一路径：已跟踪的文件与未被忽略的文件不复制，新工作树里已有的不覆盖，两边都不跟随符号链接，保留文件权限；复制失败就撤销整个工作树。它不是普通文件、超过 64 KB 或匹配超过 10,000 个文件时拒绝（`worktree-include`）。Latch 不运行任何 setup 脚本。

**只认带标记的。** 同一 `requestId` 重试得到同一个工作树；Host 重启之后，按标记里的请求哈希在同一个仓库目录里找回它。会话建成后 `bind` 把会话 ID 写进标记，此后只有根下符合命名、真实目录（不是链接）、元数据检查通过且标记属于这个用户的链接工作树才被当作 Latch 的（`sessionOf`）；别人用 `git worktree add` 放在同样形状路径上的工作树、标记被改坏的都不算。Agent 在工作树里换分支或处于分离 HEAD（例如变基中途）时，它仍是这个会话的。

**没开始就移除。** 开始请求在工作树建好之后确定失败（4xx，408 除外，会话还没建成）时，`discard` 移除它：只移除标记属于这次请求、还没有会话的工作树，用不带 `--force` 的 `git worktree remove`，所以 Git 发现已跟踪的文件有改动或有未跟踪的文件时保留它并记日志；分支只在仍指向起点时删除。会话建成之后不再移除。删除会话的工作树尚未实现。

# 在工作树里开始会话

新会话草稿里，项目只有一个文件夹、Host 读到了它的分支、Agent 模式且不是分叉时，输入框状态行里的「文件夹」菜单有两项：「当前文件夹」与「新工作树」。第二项先写「不带未提交的改动」再写起点（「从 main 的 3f2a1c9」，分离 HEAD 时只写提交）；它们来自 `GET /workspaces/:id/worktree`（`run`），这个请求做开始时写入之前的同样检查，只运行 Git 读 `HEAD` 的提交与配置项的名字，不写任何东西，Host 拒绝时回答同一个 409 与原因，菜单里这一项停用并写出原因。选择只属于这个草稿，随待发送的请求保存，重试时原样带上，开始后下一个草稿回到「当前文件夹」。

`POST /tasks` 带 `worktree: true` 时，Host 只接受保存的、只有一个文件夹的项目（否则 400 `worktree-project`、409 `worktree-project-folders`），分叉（400 `worktree-fork`）与只对话（400 `worktree-mode`）都不接受。它先建工作树，引用的文件按工作树重新核对（工作树里只有已提交的文件，未跟踪的文件 403 `file-reference-refused`，消息说它不在新工作树里），再在工作树里读项目配置算启动指纹，所以审计与会话记下的启动是工作树里的配置，不是项目文件夹里尚未提交的版本。会话的工作目录是工作树，不传项目的文件夹列表；会话照常属于原项目（`workspaceId`），在侧栏归在项目下。建不了时回答 Host 的原因，不开始会话，也不留下分支或工作树。建工作树与开始会话都在这个项目的启动队列里：同一项目的移除、改文件夹与其他启动等它结束，其他项目的启动与变更不等。

之后的每一轮要求原项目仍在且可用，会话的工作目录仍是记下的工作树，工作树的标记仍属于这个会话，否则 409 `workspace-changed`。工作树在项目可用时列入 Driver 可用的工作目录，开始中的也列入。终端、文件与改动面板都在工作树里工作；「与 main 比较」照常比较这条分支与 main 的分叉点。界面在输入框的状态行、顶栏项目旁与侧栏的行上写「工作树 · <分支>」；被跳过 filter 的文件（`unfiltered`）在会话记录最上面说一句，提示需要时在终端运行 `git lfs pull`。

