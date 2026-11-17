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
  - apps/web/src/core/useHarness.ts
---
# 只读分支

`TaskSummary.branch` 是 Host 临时生成的展示字段：普通 HEAD 是分支名，分离 HEAD 是「分离于 3f2a1c9」。

- 只读取 Git 元数据文件，不调用 Git，不读配置或 hooks（`apps/host/src/branch-reader.ts`）。
- 没有可验证的元数据时省略字段，不把失败说成当前没有分支；界面写「读不到分支」。
- 不写入会话存储。Hub 移除 Driver 自报的值，由同一读取器装饰列表、摘要和详情。新会话还没有会话可装饰，`WorkspaceInfo.branch` 由同一读取器按项目主文件夹给出（`branchOf`）。
- 分支名超过 256 个字符或像密钥时不给；隐藏字符经 `escapeSecurityText` 变为可见。

**布局检查。** `readGitLayout` 返回检查过的工作树根、Git 目录与 HEAD；通不过就是「不是仓库」。改动记录（[CHANGES.md](CHANGES.md)）、交付（[GIT-DELIVERY.md](GIT-DELIVERY.md)）与工作树只在通过检查的布局上运行受限的 Git，`GIT_DIR` 来自这次检查。

| 布局 | 条件 |
| --- | --- |
| `<根>/.git` 是目录 | 真实目录，不是链接 |
| `.git` 是文件，`gitdir:` 指向根内 | 沿途每一级都是真实目录 |
| `.git` 是文件，指向根外（链接工作树） | 只认 `<仓库>/.git/worktrees/<名>`；这些目录与 `objects`、`refs` 属于本用户、组与其他人不可写；`commondir` 是 `../..`；`gitdir` 反向指回这个 `.git` 文件 |

- 文件夹必须是工作树的顶层：路径是至多 4,096 字节的绝对路径，根是真实目录。
- 元数据文件是不超过 4,096 字节、只有一个硬链接的普通文件，用 `O_NOFOLLOW` 打开，读取前后身份、大小与时间不变。
- HEAD 只能是 `ref: refs/heads/<名字>` 或完整的提交 ID。
- 结束前把检查过的每个路径再核对一次；期间被换掉就不通过。

**缓存。** `BranchReader.decorate()` 同步返回缓存，不让列表等待磁盘。

- 每个 Host 最多缓存 256 个根、1,024 个会话观察值；最多四个实际读取且不排队，同根请求合并。
- 摘要再次被消费且缓存满 30 秒时刷新；观察到一轮结束或工作目录改变时立即失效重读。读取期间再次失效会丢弃旧结果，在原读取结算后重读。
- 只有值变化才通知 Host 更新列表。关闭时等待实际读取结束，迟到的结果不发布。
- 页面可见时每 30 秒请求现有的快照即可驱动刷新，不为它另加轮询。

# 新建工作树

Host 写 Git 只在两处：`apps/host/src/worktrees.ts` 新建、沿用与移除工作树，交付（[GIT-DELIVERY.md](GIT-DELIVERY.md)）暂存、提交与推送。这里的每一步都不运行仓库里的程序；交付的提交、推送与有 filter 时的暂存是唯一具名的例外。

一次开始请求从起点新建一个 Git 工作树与分支：

| 项 | 值 |
| --- | --- |
| 分支 | `latch/<yyyymmdd>-<4 位十六进制>` |
| 位置 | `<根>/<仓库名>-<源路径哈希前 8 位>/<yyyymmdd>-<4 位十六进制>` |
| 根 | 启动目录旁边的 `worktrees`（默认 `~/Latch/worktrees`，`LATCH_WORKTREES_DIR` 可以换）。不能在仓库、Host 数据目录或 Latch 自己的目录（程序、运行、Agent 安装目录）里，也不能包含它们 |
| 元数据 | `sessions-meta.json` 的 `worktree: { path, branch, unfiltered?, removed? }`；摘要只给 `{ branch, unfiltered?, removed? }`。Driver 自报的值被丢弃，也不交给 Driver |

- 未提交与未跟踪的改动不会带过去（沿用除外）。
- **它不是隔离。** 工作树只分开文件：与项目文件夹共用同一个仓库的 Git 配置、钩子与分支，端口、进程与本机权限仍与这台电脑上的其他会话共用。

## 不运行仓库里的程序

每个 Git 进程都经受限的运行器（固定选项、重建的环境与配置钩子的规则见 [GIT-DELIVERY.md](GIT-DELIVERY.md#git-进程)），这里另加：

- 选项 `core.attributesFile=`、`attr.tree=`、`safe.bareRepository=explicit`、`submodule.recurse=false`、`gc.auto=0`、`maintenance.auto=false`。
- 环境 `GIT_LFS_SKIP_SMUDGE=1`、`GIT_NO_REPLACE_OBJECTS=1`。

步骤：

1. 在项目文件夹读出全部 Git 配置（含 include 与全局配置），找出每个 filter 驱动。
2. `git worktree add --no-checkout -b <分支> <位置> <提交>`，不检出文件。
3. 在新工作树的 Git 元数据里写标记 `latch-session.json`（这次请求的哈希）。
4. 在新工作树里再读一次配置（配置可能随工作树与分支变化），把读到的每个 filter 驱动的 `clean`、`smudge`、`process` 置空、`required` 设为 false：经命令行配置，不改任何配置文件。
5. `git reset --hard --no-recurse-submodules <提交>` 写出文件。

被跳过 filter 的文件保持 Git 里存的样子，Git LFS 文件因此留为指针；结果里的 `unfiltered` 是这类文件的数目，界面提示需要时在终端运行 `git lfs pull`。子模块不检出。Latch 不运行任何 setup 脚本。

## 拒绝

都是 409，写明原因与怎么改，不建工作树，也不建分支：

| 原因 | 情况 |
| --- | --- |
| `worktree-not-repository`、`worktree-no-commit`、`worktree-no-git` | 项目文件夹不是仓库顶层；仓库还没有提交；找不到 Git |
| `worktree-filter-name`、`worktree-hook-name` | filter 驱动或配置钩子的名字含 `=` 或换行：无法从命令行关掉 |
| `worktree-include-if` | 仓库配置（`local` 与 `worktree` 范围）里有 `includeIf`。全局配置里的允许：它带进来的配置同样经过第 4 步 |
| `worktree-lfs-program` | 有 `lfs.customtransfer.*.path` 或 `lfs.extension.*.clean/smudge` 这类指向程序的 LFS 设置 |
| `worktree-symlink` | 位置或它的任何一级父目录是符号链接 |
| `worktree-location` | 位置不是完整路径或不是文件夹、在这个仓库里面，或与 Host 数据目录重叠 |

读取与移除已有的工作树不拒绝 `includeIf` 与 LFS 程序设置：它们只影响新建。

## 回滚

任何一步失败（含超时，检出最多等 10 分钟）都撤销这次做过的事，返回 500 `worktree-failed`：

- `git worktree remove --force --force` 移除工作树，失败时直接删除这个目录。
- 分支只在是这次建的、且仍指向起点时删除。
- 空的仓库目录一并删除。
- 撤销本身没完成时返回 500 `worktree-rollback-failed`，写出剩下的位置与分支。

## 起点

`POST /tasks` 的 `worktree` 是 `true`（等于 `{ from: 'head' }`：项目文件夹当前 `HEAD` 的提交）或下面之一。

| `worktree` | 做什么 | 拒绝 |
| --- | --- | --- |
| `{ from: 'commit', ref }` | 从另一个本地分支或提交新建 `latch/` 分支。`ref` 先按本地分支名找，再按 7 到 64 位十六进制提交找 | 都没有：409 `worktree-start-missing` |
| `{ from: 'branch', branch }` | 把已有的本地分支检出到新工作树（不带 `-b`），Agent 的提交直接落在这个分支上 | 没有这个分支：409 `worktree-branch-missing`；它已在任何工作树（含项目文件夹）检出：409 `worktree-branch-checked-out` |
| `{ from: 'reuse', name }` | 沿用这个项目里 Latch 建的另一个工作树（`name` 是它的文件夹名） | 409 `worktree-reuse-unknown`、`worktree-reuse-busy`、`worktree-reuse-held` |

- **已有分支不是 Latch 建的。** 标记记下 `existingBranch`，回滚、`discard` 与移除都不删除它。
- **沿用的条件。** 工作树在根下、标记有效、属于同一个仓库，不在开始或移除中，且它的会话已不存在，或已归档并且没有运行。
- **沿用之后。** 标记改为这次请求（会话建成后再写会话 ID）；文件、分支与未提交的改动保持原样，不复制 `.worktreeinclude`。开始没有发生时它留下成为残留，不被移除。原会话此后每一轮都得到 `workspace-changed`。
- **分支名。** 人输入的名字先过固定规则（`BRANCH_NAME`：最多 200 个字符，不以 `-` 或 `refs/` 开头，不是 `HEAD` 或 `@`，没有空白、控制字符与 `~^:?*[\`）。Host 总在前面加 `refs/heads/`，再由 `git check-ref-format` 判定；不合格是 400 `worktree-branch-name`。
- `GET /workspaces/:id/worktree` 列出本地分支（`branches`，按最近提交，最多 200 个，已在某个工作树检出的带 `checkedOut`）与可沿用的工作树（`reusable`）。

## `.worktreeinclude`

项目文件夹顶层有这个文件（gitignore 语法）时，把项目文件夹里既被它匹配、又被 Git 忽略的文件（`.env` 之类）复制到新工作树的同一路径。

- 已跟踪的文件与未被忽略的文件不复制；新工作树里已有的不覆盖；两边都不跟随符号链接；保留文件权限。
- 复制失败就撤销整个工作树。
- 它不是普通文件、超过 64 KB 或匹配超过 10,000 个文件时拒绝（`worktree-include`）。

## 只认带标记的

- 同一 `requestId` 重试得到同一个工作树；Host 重启之后，按标记里的请求哈希在同一个仓库目录里找回它。
- 会话建成后 `bind` 把会话 ID 写进标记。标记不是这次开始建的是 409 `worktree-unmarked`，已属于另一个会话是 409 `worktree-owned`。
- 此后只有根下符合命名、真实目录（不是链接）、布局检查通过且标记属于这个用户的链接工作树才被当作 Latch 的（`sessionOf`）。别人用 `git worktree add` 放在同样形状路径上的工作树、标记被改坏的都不算。
- Agent 在工作树里换分支或处于分离 HEAD（例如变基中途）时，它仍是这个会话的。

**没开始就移除。** 开始请求在工作树建好之后确定失败（4xx，408 除外，会话还没建成）时，`discard` 移除它：

- 只移除标记属于这次请求、还没有会话的工作树。
- 用不带 `--force` 的 `git worktree remove`：Git 发现已跟踪的文件有改动或有未跟踪的文件时保留它并记日志。
- 分支只在仍指向起点时删除。

# 移除工作树

`catalog.features.worktreeLifecycle` 表示 Host 有这些路由。会话建成之后的工作树只由人移除；归档保留工作树。

## 谁能移除

- 要 `run` 与数据范围 `all`。
- 只动根下、带有效标记、属于这个会话（残留则没有存在的会话）的工作树。别人建的、标记坏的、根之外的路径都是 404 `worktree-not-found`；属于会话的工作树当作残留移除是 409 `worktree-owned`。
- **残留**是没有会话的 Latch 工作树（会话已删除、开始没有完成、崩溃）。归属按 Host 自己的会话元数据判断，不按 Harness 当前列出的会话：元数据已删除才是残留；有元数据却没有被列出（它的 Harness 未启用）的会话仍持有工作树，不能沿用，也不能作为残留移除。
- **私有会话**的工作树只有数据范围 `all` 的设备能沿用，其他设备在列表里看不到它的会话 ID 与分支。标记在会话建成时、以及删除一个私有会话之前记下 `private`（记不下是 500 `worktree-mark-failed`，会话不删除）；会话删除之后它作为残留仍是私有的。

## 清单

`GET /tasks/:id/worktree` 与 `GET /workspaces/:id/worktrees/:name`（数据范围 `all`）回答 `WorktreeInventory`；`GET /workspaces/:id/worktrees` 列出这个项目的全部 Latch 工作树与归属（`session`、`archived`、`leftover`）。

清单经受限的 Git 读出（`status --porcelain=v2 --ignored=matching` 与 `diff --numstat HEAD`，每个 filter 驱动置空）：

| 字段 | 内容 |
| --- | --- |
| 数目 | 已暂存、未暂存、未跟踪与不同文件的数目，增删行数 |
| 被忽略的 | 文件数（被忽略的文件夹逐个计入其中的文件）、最大的三个文件夹 `ignoredFolders` 与一个例子 |
| 提交 | 有上游时领先的提交数；没有上游时只在这条分支上（不在其他本地分支、远端引用与标签上）的提交数 |
| `busy` | 回合运行（`turn`）、交付进行中（`delivery`）、工作树内有终端（`terminal`）、开始中或移除中 |
| `nested` | 一个本身是 Git 仓库的未跟踪或被忽略的文件夹（逐级查找 `.git`，不跟随链接） |
| `tooLarge` | 查找超过 30 万个条目时停在哪个文件夹 |
| `submodules` | 已检出的子模块数（索引里的 gitlink 且文件夹里有东西） |
| `submoduleData` | 工作树 Git 数据里的 `modules/`（`submodule deinit` 留下的子模块仓库），只要里面有东西就给出 |
| `merged` | 分支可以删除的依据，见「分支」 |
| `digest` | 这份清单的摘要：每条状态记录（路径与状态）、被忽略的条目与被忽略文件夹里的文件数 |

## 移除

`POST …/remove` 带 `{ requestId, discard?, digest?, deleteBranch? }`，在项目的启动队列里、持有这个仓库运行（与交付共用 `RepositoryHolds`：一方进行时另一方 409 `git-busy` / `worktree-busy`）。

先拒绝（都是 409）：

| 原因 | 情况 |
| --- | --- |
| `worktree-turn-running` | 回合在其中运行或等待 |
| `worktree-terminal-open` | 会话或项目的终端在这个工作树或它的子目录里运行或尚未结束（按实际目录检查）。标记移除中后，新终端得到 `worktree-removing` |
| `worktree-too-large` | 查找超过上限，`folder` 写出是哪个 |
| `worktree-nested-repository` | 有嵌套仓库，`folder` 写出是哪个 |
| `worktree-submodules` | 有已检出的子模块：先在终端里 `git submodule deinit --all` |
| `worktree-submodule-data` | `modules/` 里有子模块仓库：先确认需要的提交已推送，再自己删除这个文件夹 |
| `worktree-dirty` | 有未提交或被忽略的文件，而 `discard` 不等于此刻两者之和（`files` 是当前数目） |
| `worktree-changed` | 请求带回的 `digest` 不是此刻的清单（数目相同但换了文件也算），界面重新读取 |

- **为什么这些检查在 Latch 里。** Git 删除被忽略的文件不需要 `--force`，所以嵌套仓库、子模块数据与被忽略的文件由 Latch 自己数。Latch 从不自己删除 `modules/`：其中的提交（游离 HEAD、reflog、嵌套子模块）它无法可靠判断。
- **审计先写。** `worktree.remove`：项目、会话、路径的哈希、请求的哈希、三种数目、是否强制、是否 Latch 建的分支、`deleteBranch` 与 `merged`、领先或未推送的提交数；不写路径与文件名。写不进去就不执行。
- **执行。** `git worktree remove`，干净时不带 `--force`，有未提交的文件时带一个 `--force`；锁定的工作树仍被拒绝（409 `worktree-remove-failed`）。Git 删除目录时不跟随符号链接。
- **之后**记 `worktree.result`（`removed` 带删除的文件数；Git 在 `worktree.remove` 之后失败时记 `failed`）。
- **不做快照。** 改动记录的快照按回合与会话文件夹保存，文件夹已不存在就无处写回。所以确认里直接写「这些文件会被删除，无法恢复」。
- 移除计入安装窗口的忙碌计数，窗口提交后 409 `host-updating`（[UPDATES.md](./UPDATES.md)）。

## 分支

分支从不强制删除。只删 Latch 建的 `latch/<名字>`，而且只在这几条都成立时：

1. 清单的 `merged` 与对话框都说它会删除，请求带回 `deleteBranch: true`。没有带它的请求从不删除分支。
2. 此刻它没有损失，是下面两种之一：
   - `default`：每个提交都已在默认分支上。默认分支是本地或任一远端的 `main`、`master`、`init.defaultBranch` 这几个确切的名字，或远端 `HEAD` 指向的分支；从不是 `latch/` 分支或与它同名的分支，所以只推送过它不算合并。按完整引用名判断，读不出的引用跳过。
   - `start`：它没有超出新建时记在标记里的起点（`base`）的提交，且另一个引用（分支、远端引用或标签，不是它自己）持有它的提交。标记谁都能改，起点也可能已被删除，所以只凭标记不算。
3. 它是普通引用（不是符号引用），没有在任何工作树检出。

删除用一次 `update-ref --no-deref --stdin` 事务：`verify` 那个默认分支（或持有它的引用）仍在检查时的值，再 `delete refs/heads/<名字> <检查时的提交>`；两者之间任何一方移动都保留分支。结果的 `branch` 是 `deleted`、`kept` 或 `none`（检出的已有分支）。

## 移除之后与重试

会话保留，元数据记 `removed`，摘要带 `worktree.removed`：会话只能查看，不再给「撤销本轮」；新一轮、文件与交付得到 409 `worktree-removed`，终端得到 409 `terminal-folder-unavailable`。

| 重试同一 `requestId` | 回答 |
| --- | --- |
| 同一个 Host 进程里 | 同一个回答 |
| Host 重启后，会话的工作树 | `worktree-removed`（界面当作已完成） |
| Host 重启后，残留 | 按审计里的 `worktree.result` 得到原来的回答 |

- `worktree.result` 在标记会话之前写入：标记失败时，重试看到文件夹已不在、审计记着移除，就补上标记。
- Git 已删除文件夹、Host 却在写 `worktree.result` 之前停止时（标记随文件夹一起没了），重启后会话的重试按这个工作树的 `worktree.remove` 记录补记 `worktree.result` 并标记会话。`branch` 按项目仓库里这个分支此刻还在不在写 `kept` 或 `deleted`（读不出时 `kept`），不是 Latch 建的分支写 `none`。

## 界面

界面必须守的规则：

- 会话菜单的「移除工作树…」只在工作树还在、Host 有 `worktreeLifecycle`、设备有 `run` 且数据范围是 `all` 时出现，回合运行或等待时停用。残留的工作树在设置 › 项目里，只对只有一个文件夹的 Git 项目。
- 有未提交或被忽略的文件时，必须勾选写明数目的丢弃确认（并列出一个例子）；数目或清单变了就重新读取。
- 「分支」一行只按 `merged` 写会删除或保留；没有依据时写保留。

# 在工作树里开始会话

`POST /tasks` 带 `worktree` 时：

- **只接受**保存的、只有一个文件夹的项目（否则 400 `worktree-project`、409 `worktree-project-folders`）；分叉（400 `worktree-fork`）与只对话（400 `worktree-mode`）都不接受。
- **顺序。** 先建工作树；引用的文件按工作树重新核对（工作树里只有已提交的文件，未跟踪的文件 403 `file-reference-refused`）；再在工作树里读项目配置算启动指纹。所以审计与会话记下的启动是工作树里的配置，不是项目文件夹里尚未提交的版本。
- **工作目录。** 会话的工作目录是工作树，不传项目的文件夹列表；会话照常属于原项目（`workspaceId`）。
- **建不了**时回答 Host 的原因，不开始会话，也不留下分支或工作树。
- **队列。** 建工作树与开始会话都在这个项目的启动队列里：同一项目的移除、改文件夹与其他启动等它结束，其他项目的不等。

之后的每一轮要求原项目仍在且可用、会话的工作目录仍是记下的工作树、工作树的标记仍属于这个会话，否则 409 `workspace-changed`。工作树在项目可用时列入 Driver 可用的工作目录，开始中的也列入。终端、文件与改动面板都在工作树里工作；「与 main 比较」照常比较这条分支与 main 的分叉点。

**草稿里的选择。** 项目只有一个文件夹、Host 读到了它的分支、Agent 模式且不是分叉时，「文件夹」菜单有「当前文件夹」与「新工作树」。

- 「新工作树」写明不带未提交的改动与起点。它们来自 `GET /workspaces/:id/worktree`（`run`）：这个请求做开始时写入之前的同样检查，只运行 Git 读 `HEAD` 的提交与配置项的名字，不写任何东西。Host 拒绝时回答同一个 409 与原因，菜单里这一项停用并写出原因。
- 选择只属于这个草稿与这个项目，随待发送的请求保存，重试时原样带上；开始后下一个草稿回到「当前文件夹」。
