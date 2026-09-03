# paseo-git-tree

在 Paseo 的 explorer 侧边栏里显示当前 workspace 的 git 分支树（`git log --graph --all`），
与「文件」「更改」并列的一个 tab。

## 功能

- Explorer 侧边栏 tab（也可以作为普通 workspace tab 打开）
- 窗口化渲染分支拓扑（默认 500 条，最多 2000），展开卡片时点和线位置不变
- 顶部当前分支下拉：左键预览该分支历史（不 checkout），右键或 ⋯ 打开操作（checkout / merge / rebase / push / pull / fetch / rename / delete）
- 图上的分支芯片：左键预览，右键打开与顶栏相同的分支操作；右键 commit 可 create branch / checkout / cherry-pick / revert / merge / rebase / reset / tag
- 显示 commit 主题、作者、相对时间、ref 装饰（HEAD / 分支名 / tag），分支名与下拉使用同一套颜色
- 范围切换：默认 Branch（当前分支 + upstream 标签）；Local（本地分支）；All（含 remote，其它分支 tip 才会标在图上）
- 搜索框：按 message / 作者 / hash / 分支名过滤；`f: <路径>` 按文件过滤（覆盖已加载窗口外的历史）
- Ctrl/Cmd 点击两个 commit：任意两者对比，展开逐文件 diff
- 顶部未提交改动摘要卡（修改 + 新增文件数、± 行数）
- rename 感知的文件列表（显示 R 状态与 old ⟶ new）
- 刷新按钮手动重新加载

## 安装

在运行 Paseo daemon 的机器上：

```bash
git clone <this-repo>
paseo plugin install "<absolute-path>/paseo-git-tree"
```

前置条件：

- Paseo 0.5.0-beta 或更新（local plugin 支持）
- daemon 的 `config.json` 里 `pluginsEnabled: true`（Settings → Plugins 里开启）

## 使用

1. 打开任意项目，点击右上角侧边栏切换按钮
2. 在「文件」「更改」旁边找到 **Git Tree** tab
3. 点击查看该 workspace 的分支树

刷新：点面板右上角的 ↻ 图标。

搜索：点🔍图标打开输入框，直接输入匹配 message/作者/hash/分支名；输入 `f: 路径`（如 `f: src/foo.ts`）改为按文件过滤，覆盖整个仓库历史而不只是已加载的 500 条。

对比：Ctrl/Cmd 点击第一个 commit 设为基点（行上标 ⇔ base），再 Ctrl/Cmd 点击第二个 commit 展开两者的逐文件差异；再点基点本身取消。

分支操作：点标题栏里带颜色的当前分支。左键某个分支只预览它的提交图（不切换 HEAD）；再点一次取消预览。Checkout 以及 merge / rebase / push / pull / fetch / rename / delete 都在右键或 ⋯ 菜单里。远程 checkout 会 `git checkout --track` 或切到已有本地分支。新建分支可选择是否立刻 checkout。

## 类型检查

```bash
npm install
npm run typecheck
```

改完源码后用 `paseo plugin reload git-tree` 重新加载。
