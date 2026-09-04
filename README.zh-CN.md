# paseo-git-tree

**Paseo 的 git 分支树插件 —— 面板标签页里的 `git log --graph`。**

[English](README.md) · [简体中文](README.zh-CN.md)

一个 [Paseo](https://paseo.sh) 插件:把当前 workspace 的分支历史渲染为车道式提交图,作为一个面板标签页打开,也可以放进 explorer 侧边栏窗格。

## 功能

| 功能 | 说明 |
|------|------|
| **面板标签页** | 分支树作为一个面板 tab(也可放在 explorer 侧边栏窗格里)。 |
| **窗口化渲染** | 车道式拓扑渲染——默认 500 条提交,最多 2000 条;展开卡片时点和线位置不变。 |
| **分支选择器** | 顶部当前分支下拉:左键预览分支历史(不 checkout),右键或 ⋯ 打开 checkout / merge / rebase / push / pull / fetch / rename / delete。 |
| **分支芯片** | 图上的分支芯片:左键预览,右键打开与顶栏相同的分支菜单;右键 commit 可 create branch / checkout / cherry-pick / revert / merge / rebase / reset / tag。 |
| **提交卡片** | 主题、作者、相对时间、ref 装饰(HEAD / 分支名 / tag),分支名与下拉共用同一套颜色。 |
| **范围切换** | Branch(仅当前检出分支)、Local(所有本地分支)、All(本地 + remote + tag)。 |
| **搜索** | 客户端按 message / 作者 / hash 前缀 / 分支名匹配;`f: <路径>` 改为服务端 `git log -- <路径>` 过滤。 |
| **对比** | Ctrl/Cmd 点击两个 commit 任意对比,展开逐文件 diff。 |
| **未提交行** | 顶部工作区摘要:修改 + 新增文件数、± 行数。 |
| **可展开卡片** | 点击 commit 展开完整详情(作者、日期、parents、message 正文、逐文件 diff);fetch/刷新时展开内容原地更新。 |
| **rename 感知** | 文件列表显示 R 状态与 old ⟶ new 路径。 |
| **手动刷新** | 面板右上角 ↻ 按钮。 |

## 安装

```bash
git clone <this-repo>
cd paseo-git-tree
npm install

# 安装到 Paseo
paseo plugin install /absolute/path/to/paseo-git-tree

# 确认运行状态
paseo plugin ls
```

前置条件:

- Paseo 0.7.2 或更新(local plugin 支持;已用随附的 `paseo` CLI 验证)
- daemon 的 `config.json` 里 `pluginsEnabled: true`(桌面端 Settings → Plugins 里开启)

## 使用

### 打开面板

面板同时注册了 `explorer` 和 `workspace` 两个 location。Paseo 的 explorer 侧边栏只渲染它内建的「文件」「更改」「Pull request」三个 tab,插件面板不会被追加到那里。请从新建 tab 菜单打开 Git Tree:

1. 打开一个 workspace。
2. 点击主区域顶部 tab 条上的 **+(New tab)** 按钮。
3. 在下拉菜单里选 **Git Tree**,它列在内建 tab 之后的插件分组里。

面板会作为一个普通 workspace tab 打开。想让它在 explorer 侧边栏窗格里打开,就右键侧边栏的 tab 条并选 **New tab** —— 这会在侧边栏内部打开新建 tab 菜单,里面同样列出 Git Tree。想把侧边栏里的 tab 移回主区域,用它的右键菜单 → **Move to main panel**。

### 顶部控件

从左到右依次是:标题 + 提交数、当前分支芯片、范围筛选、搜索、pull、push、刷新。

| 控件 | 作用 |
|------|------|
| **当前分支芯片** | 打开分支列表。 |
| **范围(Filter 图标)** | 切换 ref:**Branch**(仅当前检出分支)、**Local**(所有本地分支)、**All**(本地 + remote + tag)。 |
| **🔍** | 开关搜索输入框。 |
| **↓ / ↑** | 对当前分支 pull / push。仓库没有 remote 时隐藏 push;HEAD 处于 detached 时两者都隐藏。 |
| **↻** | 重新加载,仓库有 remote 时会先跑 `git fetch --all --prune`。 |

### 提交行

点击一个 commit 展开:作者、日期、parents、message 正文和逐文件 diff。悬停会显示带完整 message 的浮层。

工作区有改动时,顶部会出现一行 **Uncommitted changes** 伪提交,短 hash 是 `WT`,展开后是工作区文件列表。

右键或长按某一行打开 commit 菜单:create branch、checkout(进入 detached HEAD)、cherry-pick、revert、merge、rebase、reset(mixed / hard)、add tag、copy message / hash。未提交行只提供复制项。

### 对比两个 commit

Ctrl/Cmd/Alt 点击一个 commit 设为基点,该行会标上 `⇔ base`。再 Ctrl/Cmd/Alt 点击第二个 commit,展开两者之间的逐文件 diff,该行标 `⇔ target`。再 Ctrl 点击基点即取消。

### 搜索

直接输入按主题、作者、hash 前缀或分支名匹配,图会基于匹配结果重新布局。

查询加 `f:` 前缀改为按文件过滤,例如 `f: src/foo.ts`。该请求走服务端 `git log -- <path>`,能覆盖已加载窗口之外的历史,输入有 250 ms 防抖。

### 分支菜单

点击顶部带颜色的当前分支芯片;或者直接右键图上的分支芯片,打开该 ref 的操作菜单。

列表里有筛选框,以及 `+ Create branch…`(可选择是否立刻 checkout)。左键某个分支是预览它的历史,不移动 HEAD;再点一次取消预览。

右键、长按或 ⋯ 打开该分支的操作:

- **Checkout** —— 远程分支用 `git checkout --track`,或切到同名的已有本地分支。
- **Merge / rebase** 到当前分支。
- 远程分支的 **pull / fetch**。
- **Push**,或用 `--force-with-lease` 强推。
- **Rename**、**copy name**、**delete**。

rebase、force push、delete 需要再点一次确认。

### 文件行

右键文件可 **Filter commits by this file**(自动填入 `f: <路径>`)或 **Copy path**。

## 插件结构

```
paseo-git-tree/
├── paseo-plugin.json        # 清单(id: "git-tree")
├── index.ts                 # 入口:RPC 处理器 + workspace 面板注册
├── git-tree-panel.client.tsx # 面板 UI(React Native)—— client bundle
├── git-tree.server.ts       # git 子进程封装 —— server bundle
├── git-tree.shared.ts       # Zod RPC 契约 + 纯函数图/布局算法
├── git-tree.shared.test.ts  # 逻辑测试(node:test),含种子随机用例
├── package.json
├── tsconfig.json
└── README.md / README.zh-CN.md
```

## 测试

```bash
npm test
```

纯逻辑测试,跑在 node 内置 test runner 上,无 UI 依赖:

- 手写边界用例:空图、单根、线性链、fork/merge/octopus、多子收敛、ref 解析与 scope 规则、几何往返。
- 程序化生成用例:种子 PRNG(mulberry32)随机生成提交 DAG、ref 装饰、列表几何参数,再验证结构性不变量——车道连续性、颜色分配、`itemOffset`/`indexAtY` 互逆、窗口覆盖。
- 复现失败样本:测试名带 `seed=N`,改 `git-tree.shared.test.ts` 里的种子数组即可重放。

## 开发

```bash
# 改完类型检查
npm run typecheck

# 重新加载插件
paseo plugin reload git-tree

# 查看日志
paseo plugin logs git-tree
```

## 许可证

Apache-2.0
