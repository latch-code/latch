---
description: Host 只读分支元数据、受限 Git worktree 验证与非阻塞摘要缓存；Host 为会话新建、沿用与移除工作树时不运行仓库里的程序（交付是唯一具名的例外，见 GIT-DELIVERY.md）；新会话可以从 HEAD、其他分支或提交、已有分支在新工作树里开始，或沿用残留的工作树；会话菜单与项目设置可以移除工作树。
sources:
  - apps/host/src/branch-reader.ts
  - apps/host/src/worktrees.ts
  - apps/host/src/changes/git.ts
  - apps/host/test/worktrees.test.ts
  - apps/host/test/worktree-sessions.test.ts
  - apps/web/src/composer/FolderControl.tsx
  - apps/web/src/composer/WorktreeStartPanel.tsx
  - apps/web/src/components/RemoveWorktreeDialog.tsx
  - apps/web/src/settings/LeftoverWorktrees.tsx
  - apps/host/src/audit-actions/git.ts
  - e2e/worktree-lifecycle.e2e.ts
  - apps/host/src/hub.ts
  - apps/host/test/branch-reader.test.ts
  - packages/protocol/src/types.ts
  - apps/web/src/shell/ConversationHeader.tsx
  - apps/web/src/shell/ConversationHeader.tsx
  - apps/web/src/core/useHarness.ts
---
# 只读分支

`TaskSummary.branch` 是 Host 临时生成的展示字段。普通 HEAD 返回分支名，分离 HEAD 返回「分离于 3f2a1c9」；没有可验证元数据时省略，不把失败说成当前没有分支。它不写入会话存储，Hub 会移除 Driver 自报的值，由同一读取器装饰列表、摘要和详情。前端把它放在输入框的状态行（提示框写全名）与环境主文件夹旁，旧 Host 缺少字段时保持原显示。新会话还没有会话可装饰，`WorkspaceInfo.branch` 由同一读取器按项目主文件夹给出（`branchOf`）。

只读取 Git 元数据，不调用 Git，不读配置或 hooks；无法验证时页头不显示分支，标题行项目弹层写「读不到分支」。会话的文件夹与分支只写在页头，输入框下没有状态行。

`readGitLayout` 返回这次检查得到的工作树与 Git 目录；改动记录（[CHANGES.md](CHANGES.md)）只在通过检查的布局上以只读方式运行 Git，分支读取本身仍不调用 Git。

`BranchReader.decorate()` 同步返回缓存，不让列表等待磁盘。每个 Host 最多缓存 256 个根、1,024 个会话观察值，最多四个实际读取且不排队，同根请求合并。摘要再次被消费且缓存满 30 秒时刷新；观察到一轮结束或工作目录改变时立即失效重读。读取期间再次失效会丢弃旧结果，并在原读取真实结算后重读。只有值变化才通知 Host 更新列表，关闭等待实际读取结束并禁止迟到结果发布。页面可见时每 30 秒请求现有快照/同步即可驱动刷新；不可见页面无需新增轮询。

# 新建工作树

Host 写 Git 只在两处：`apps/host/src/worktrees.ts` 新建、沿用与移除工作树，交付（[GIT-DELIVERY.md](GIT-DELIVERY.md)）暂存、提交与推送。交付的提交、推送与有 filter 时的暂存是「不运行仓库里的程序」唯一具名的例外：由人按下、先写审计，以你的账户运行你的 Git；Host 自己做的其他事，包括这里新建工作树，仍不运行仓库里的程序。`worktrees.ts` 为一次开始请求从起点（默认项目文件夹当前 `HEAD` 的提交，见「起点」）新建一个 Git 工作树（worktree）和分支 `latch/<yyyymmdd>-<4 位十六进制>`，位置是 `<根>/<仓库名>-<源路径哈希前 8 位>/<yyyymmdd>-<4 位十六进制>`。根是启动目录旁边的 `worktrees`（默认 `~/Latch/worktrees`，`LATCH_WORKTREES_DIR` 可以换），不能在仓库、Host 数据目录或 Latch 自己的目录（程序目录、运行目录、Agent 安装目录）里或包含它们；测试传入自己的临时目录。未提交与未跟踪的改动不会带过去。工作树只分开文件：它与项目文件夹共用同一个仓库的 Git 配置、钩子与分支，端口、进程与本机权限仍与这台电脑上的其他会话共用，它不是隔离。会话元数据记下它（`sessions-meta.json` 的 `worktree: { path, branch, unfiltered?, removed? }`，摘要只给 `worktree: { branch, unfiltered?, removed? }`，Driver 自报的值被丢弃，也不会交给 Driver）。

**不运行仓库里的程序。** 每个 Git 进程都用重建的环境（不继承 Host 的任何 `GIT_*` 变量），带上只读 Git 的固定选项（钩子目录 `/dev/null`、`core.fsmonitor=`、`diff.external=`、`protocol.allow=never`、`core.untrackedCache=false`、`core.alternateRefsCommand=`、`commit.gpgSign=false`、`tag.gpgSign=false`、`core.editor=:`，不用分页器），并在每次运行前读出全部配置（含全局、系统与 include）里的配置钩子（Git 2.54 起的 `hook.<名字>.command` 与 `.event`，`core.hooksPath` 关不掉它们），逐个加 `-c hook.<名字>.enabled=false`；名字含 `=` 或换行时不运行，再加 `core.attributesFile=`、`attr.tree=`、`safe.bareRepository=explicit`、`submodule.recurse=false`、关掉自动 gc，以及 `GIT_LFS_SKIP_SMUDGE=1`、`GIT_NO_REPLACE_OBJECTS=1`。步骤：

1. 在项目文件夹读出全部 Git 配置（含 include 与全局配置），找出每个 filter 驱动；
2. `git worktree add --no-checkout -b <分支> <位置> <提交>`，不检出文件；
3. 在新工作树的 Git 元数据里写标记 `latch-session.json`（这次请求的哈希）；
4. 在新工作树里再读一次配置（配置可能随工作树与分支变化；配置钩子每个 Git 进程都按它所在的工作树重读），把读到的每个 filter 驱动的 `clean`、`smudge`、`process` 置空、`required` 设为 false（经命令行配置，不改任何配置文件）；
5. `git reset --hard --no-recurse-submodules <提交>` 写出文件。被跳过 filter 的文件保持 Git 里存的样子，Git LFS 文件因此留为指针，结果里的 `unfiltered` 是这类文件的数目；子模块不检出。

**拒绝。** 下列情况返回 409 并写明原因与怎么改，不建工作树，也不建分支：项目文件夹不是仓库顶层（`worktree-not-repository`）、仓库还没有提交（`worktree-no-commit`）、找不到 Git（`worktree-no-git`）；某个 filter 驱动名含 `=` 或换行（`worktree-filter-name`）；某个配置钩子的名字含 `=` 或换行（`worktree-hook-name`）；仓库配置（`local` 与 `worktree` 范围）里有 `includeIf`（`worktree-include-if`）；有 `lfs.customtransfer.*.path` 或 `lfs.extension.*.clean/smudge` 这类指向程序的 LFS 设置（`worktree-lfs-program`）；位置或它的任何一级父目录是符号链接（`worktree-symlink`），位置不是完整路径或不是文件夹、在这个仓库里面或与 Host 数据目录重叠（`worktree-location`）。全局配置里的 `includeIf` 是允许的，它在新工作树里带进来的配置同样经过第 4 步检查。

**回滚。** 任何一步失败（含超时，检出最多等 10 分钟）都撤销这次做过的事：`git worktree remove --force` 移除工作树（失败时直接删除这个目录），分支只在仍指向起点时删除，空的仓库目录一并删除，返回 500 `worktree-failed`；撤销本身没完成时返回 500 `worktree-rollback-failed` 并写出剩下的位置与分支。

**起点。** `POST /tasks` 的 `worktree` 是 `true`（等于 `{ from: 'head' }`）或下面之一，`GET /workspaces/:id/worktree` 同时列出本地分支（`branches`，按最近提交，最多 200 个，已在某个工作树检出的带 `checkedOut`）与可沿用的工作树（`reusable`）：

- `{ from: 'commit', ref }`：从另一个本地分支或提交新建 `latch/` 分支。`ref` 先按本地分支名找，再按 7 到 64 位十六进制提交找；都没有时 409 `worktree-start-missing`。
- `{ from: 'branch', branch }`：把一个已有的本地分支检出到新工作树（`worktree add --no-checkout <位置> <分支>`，不带 `-b`），Agent 的提交直接落在这个分支上。它在任何工作树（含项目文件夹）里已检出时 409 `worktree-branch-checked-out`，原因写出在哪里检出；Git 自己也拒绝同一分支检出两次。这个分支不是 Latch 建的：标记记下 `existingBranch`，回滚、`discard` 与移除都不删除它。
- `{ from: 'reuse', name }`：沿用这个项目里 Latch 建的另一个工作树（`name` 是它的文件夹名）。它必须在根下、标记有效、属于同一个仓库，不在开始或移除中，且它的会话已不存在或已归档并且没有运行（`worktree-reuse-held`，原因写出）；否则 409 `worktree-reuse-unknown` 或 `worktree-reuse-busy`。标记改为这次请求（会话建成后再写会话 ID），文件、分支与未提交的改动保持原样，不复制 `.worktreeinclude`；开始没有发生时它留下，成为残留，不被移除。原会话此后每一轮都得到 `workspace-changed`。

人输入的分支名先过固定规则（`BRANCH_NAME`：最多 200 个字符，不以 `-` 开头，不以 `refs/` 开头，不是 `HEAD` 或 `@`，没有空白、控制字符与 `~^:?*[\`），Host 总在前面加 `refs/heads/`，再由 `git check-ref-format refs/heads/<名字>` 判定；不合格时 400 `worktree-branch-name`。之前的所有检查与受限的 Git 不变；未提交的改动照旧不带过去（沿用除外），菜单照旧写明。同一 `requestId` 重试得到同一个工作树。界面上「文件夹」菜单的脚注「其他起点…」打开面板：「新分支 / 检出分支 / 沿用」三段、搜索框与列表，已检出的分支停用并写原因，细节在 ⓘ 里；选择只属于这个草稿与这个项目。

**`.worktreeinclude`。** 项目文件夹顶层有这个文件（gitignore 语法）时，复制项目文件夹里既被它匹配、又被 Git 忽略的文件（`.env` 之类）到新工作树的同一路径：已跟踪的文件与未被忽略的文件不复制，新工作树里已有的不覆盖，两边都不跟随符号链接，保留文件权限；复制失败就撤销整个工作树。它不是普通文件、超过 64 KB 或匹配超过 10,000 个文件时拒绝（`worktree-include`）。Latch 不运行任何 setup 脚本。

**只认带标记的。** 同一 `requestId` 重试得到同一个工作树；Host 重启之后，按标记里的请求哈希在同一个仓库目录里找回它。会话建成后 `bind` 把会话 ID 写进标记，此后只有根下符合命名、真实目录（不是链接）、元数据检查通过且标记属于这个用户的链接工作树才被当作 Latch 的（`sessionOf`）；别人用 `git worktree add` 放在同样形状路径上的工作树、标记被改坏的都不算。Agent 在工作树里换分支或处于分离 HEAD（例如变基中途）时，它仍是这个会话的。

**没开始就移除。** 开始请求在工作树建好之后确定失败（4xx，408 除外，会话还没建成）时，`discard` 移除它：只移除标记属于这次请求、还没有会话的工作树，用不带 `--force` 的 `git worktree remove`，所以 Git 发现已跟踪的文件有改动或有未跟踪的文件时保留它并记日志；分支只在仍指向起点时删除。会话建成之后由「移除工作树」处理（见下）。

# 移除工作树

会话菜单（⋯、标题菜单、手机长按）在会话的工作树还在、Host 有 `worktreeLifecycle`、设备有 `run` 且数据范围是 `all` 时有「移除工作树…」，回合运行或等待时停用。归档照旧保留工作树。设置 › 项目里只有一个文件夹的 Git 项目有「残留的工作树」：没有会话（会话已删除、开始没有完成、崩溃）的 Latch 工作树，各有同样的「移除…」。

- `GET /tasks/:id/worktree` 与 `GET /workspaces/:id/worktrees/:name`（数据范围 `all`）回答 `WorktreeInventory`：经受限的 Git（`status --porcelain=v2 --ignored=matching` 与 `diff --numstat HEAD`，每个 filter 驱动置空，钩子与 fsmonitor 关闭）读出的已暂存、未暂存、未跟踪与不同文件的数目、被忽略的文件数（被忽略的文件夹逐个计入其中的文件，`ignoredFolders` 列出最大的三个，如「data/ 50 个」）和一个例子（`.env`），增删行数，以及有上游时领先的提交数，没有上游时只在这条分支上（不在其他本地分支与任何远端引用上）的提交数（「从未推送」）；`busy` 写出回合运行（`turn`）、交付进行中（`delivery`）、会话有打开的终端（`terminal`）、开始中或移除中。`nested` 是一个本身是 Git 仓库的未跟踪或被忽略的文件夹（逐级查找 `.git`，不跟随链接）；查找超过 30 万个条目就停下，`tooLarge` 写出停在哪个文件夹。`submodules` 是已检出的子模块数（索引里的 gitlink 且它的文件夹里有东西）；`submoduleData` 是工作树 Git 数据里的 `modules/`（`submodule deinit` 留下的子模块仓库，可能有只在 reflog 里的提交或嵌套的子模块），只要里面有东西就给出。`digest` 是这份清单的摘要：每条状态记录（路径与状态）、被忽略的条目与被忽略文件夹里的文件数。`GET /workspaces/:id/worktrees` 列出这个项目的全部 Latch 工作树与它们属于谁（`session`、`archived`、`leftover`）。归属按 Host 自己的会话元数据判断，不按 Harness 当前列出的会话：元数据已删除（会话已删除）才是残留；有元数据却没有被列出（它的 Harness 未启用）的会话仍持有工作树，不能沿用，也不能作为残留移除。私有会话（个人、我的 Agent 或带私有上下文）的工作树只有数据范围 `all` 的设备能沿用，其他设备在列表里看不到它的会话 ID 与分支；标记在会话建成时、以及删除一个私有会话之前记下 `private`（会话之后才变成私有的也算），会话删除之后它作为残留仍是私有的；会话还在时按它的记录实时判断。读取不拒绝 `includeIf` 与 LFS 程序设置：它们只影响新建。
- `POST …/remove` 带 `{ requestId, discard?, digest?, deleteBranch? }`，要 `run` 与数据范围 `all`，在项目的启动队列里、持有这个仓库（与交付共用 `RepositoryHolds`，一方进行时另一方 409 `git-busy` / `worktree-busy`）运行。回合在其中运行或等待时 409 `worktree-turn-running`；任何终端（任何会话的，包括文件夹在其中的项目的会话）的文件夹是这个工作树或在它里面时 409 `worktree-terminal-open`（检查之后不再有 await 就把工作树标为移除中，此后终端打不开）。查找超过上限时 409 `worktree-too-large`（`folder` 写出是哪个），有嵌套仓库时 409 `worktree-nested-repository`（`folder` 写出是哪个），有已检出的子模块时 409 `worktree-submodules`（先在终端里 `git submodule deinit --all`），`modules/` 里有任何子模块仓库时 409 `worktree-submodule-data`（`folder` 是它的路径，消息说明先在终端里用 `git --git-dir=<仓库> log --all --reflog` 确认需要的提交已推送，再 `rm -rf` 这个文件夹）。Latch 从不自己删除 `modules/`：只在其中的提交（游离 HEAD、reflog、嵌套子模块）Latch 无法可靠判断：Git 删除被忽略的文件不需要 `--force`，所以这些检查在 Latch 里。有未提交或被忽略的文件时 `discard` 必须等于此刻两者之和，否则 409 `worktree-dirty`（`files` 是当前数目）；请求还要带回界面显示的那份 `digest`，清单变了（数目相同但换了文件也算）就 409 `worktree-changed`，界面重新读取。界面因此要求勾选「丢弃 N 个未提交的文件」（有被忽略的文件时写明「和 M 个被忽略的文件」，并列出一个例子），数目变了就重新读取。
- 只动根下、带有效标记、属于这个会话（残留则没有存在的会话）的工作树；别人建的、标记坏的、`worktrees.ts` 之外的路径都是 404 `worktree-not-found`。
- 先写审计 `worktree.remove`（项目、会话、路径的哈希、请求的哈希、三种数目、是否强制、是否 Latch 建的分支、领先或未推送的提交数；不写路径与文件名），写不进去就不执行；然后 `git worktree remove`，干净时不带 `--force`，有未提交的文件时带一个 `--force`（锁定的工作树仍被拒绝，409 `worktree-remove-failed`）。Git 删除目录时不跟随符号链接。
- 分支从不强制删除：只删 Latch 建的 `latch/<名字>`，而且只在这几条都成立时：清单（`merged`）与对话框说它会删除、请求带回 `deleteBranch: true`；此刻它没有损失（`merged`）：每个提交都已在默认分支上（本地或任一远端的 `main`、`master` 或 `init.defaultBranch` 这几个确切的名字，或远端 `HEAD` 指向的分支，但从不是 `latch/` 分支或与它同名的分支，所以只推送过它、哪怕它成了新仓库的 `HEAD`，也不算合并（按完整引用名判断，远端名里可以有 `/`）；读不出的引用跳过），或它没有超出新建时记在标记里的起点（`base`）的提交、且另一个引用（分支、远端引用或标签，不是它自己）持有它的提交——标记谁都能改，起点也可能已被删除，所以只凭标记不算；它是普通引用（不是符号引用），没有在任何工作树检出。删除用一次 `update-ref --no-deref --stdin` 事务：`verify` 那个默认分支（或持有它的引用）仍在检查时的值，`delete refs/heads/<名字> <检查时的提交>`，两者之间任何一方移动都保留分支。没有带 `deleteBranch` 的请求从不删除分支。结果的 `branch` 是 `deleted`、`kept` 或 `none`（检出的已有分支），对话框在「分支」一行写「已合并，会删除」「没有新提交，会删除」或「保留」（ⓘ 写「没有找到它已合并的证据」），移除后写「分支 … 已保留」。`worktree.remove` 审计另记 `deleteBranch` 与 `merged`（`default`、`start` 或 `none`）。之后记 `worktree.result`（`removed` 带删除的文件数；Git 在 `worktree.remove` 之后失败时记 `failed`）。
- 会话保留，元数据记 `removed`：摘要带 `worktree.removed`，页头与侧栏写「工作树已移除」，输入框换成「只能查看」（ⓘ 说明工作树已移除），没有附件按钮，本轮卡片与改动页签不再给「撤销本轮」，新一轮、终端、文件与交付得到 409 `worktree-removed`。同一 `requestId` 的重试在这个 Host 进程里得到同一个回答；Host 重启后，会话的重试得到 `worktree-removed`（界面把它当作已完成），残留的重试按审计里的 `worktree.result` 得到原来的回答。`worktree.result` 在标记会话之前写入：标记失败时，重试看到文件夹已不在、审计记着移除，就补上标记。Git 已删除文件夹、Host 却在写 `worktree.result` 之前停止时（标记随文件夹一起没了），重启后会话的重试按这个工作树的 `worktree.remove` 记录补记 `worktree.result` 并标记会话：`branch` 按项目仓库里这个分支此刻还在不在写 `kept` 或 `deleted`（读不出时 `kept`），不是 Latch 建的分支写 `none`。移除计入安装窗口的忙碌计数，窗口提交后 409 `host-updating`（[UPDATES.md](./UPDATES.md)）。
- 不做快照：改动记录的快照按回合与会话文件夹保存，恢复写回会话的文件夹，而文件夹已不存在，能恢复就要重建工作树，不便宜。所以确认里直接写「这些文件会被删除，无法恢复」。

# 在工作树里开始会话

新会话草稿里，项目只有一个文件夹、Host 读到了它的分支、Agent 模式且不是分叉时，总览输入框地点行里的「文件夹」菜单有两项：「当前文件夹」与「新工作树」。第二项先写「不带未提交的改动」再写起点（「从 main 的 3f2a1c9」，分离 HEAD 时只写提交）；它们来自 `GET /workspaces/:id/worktree`（`run`），这个请求做开始时写入之前的同样检查，只运行 Git 读 `HEAD` 的提交与配置项的名字，不写任何东西，Host 拒绝时回答同一个 409 与原因，菜单里这一项停用并写出原因。选择只属于这个草稿，随待发送的请求保存，重试时原样带上，开始后下一个草稿回到「当前文件夹」。

`POST /tasks` 带 `worktree: true` 时，Host 只接受保存的、只有一个文件夹的项目（否则 400 `worktree-project`、409 `worktree-project-folders`），分叉（400 `worktree-fork`）与只对话（400 `worktree-mode`）都不接受。它先建工作树，引用的文件按工作树重新核对（工作树里只有已提交的文件，未跟踪的文件 403 `file-reference-refused`，消息说它不在新工作树里），再在工作树里读项目配置算启动指纹，所以审计与会话记下的启动是工作树里的配置，不是项目文件夹里尚未提交的版本。会话的工作目录是工作树，不传项目的文件夹列表；会话照常属于原项目（`workspaceId`），在侧栏归在项目下。建不了时回答 Host 的原因，不开始会话，也不留下分支或工作树。建工作树与开始会话都在这个项目的启动队列里：同一项目的移除、改文件夹与其他启动等它结束，其他项目的启动与变更不等。

之后的每一轮要求原项目仍在且可用，会话的工作目录仍是记下的工作树，工作树的标记仍属于这个会话，否则 409 `workspace-changed`。工作树在项目可用时列入 Driver 可用的工作目录，开始中的也列入。终端、文件与改动面板都在工作树里工作；「与 main 比较」照常比较这条分支与 main 的分叉点。界面在输入框的状态行、顶栏项目旁与侧栏的行上写「工作树 · <分支>」；被跳过 filter 的文件（`unfiltered`）在会话记录最上面说一句，提示需要时在终端运行 `git lfs pull`。

