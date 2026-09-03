# paseo-git-tree

**Paseo 的 git 分支树插件 —— 侧边栏里的 `git log --graph --all`。**

[English](README.md) · [简体中文](README.zh-CN.md)

一个 [Paseo](https://paseo.sh) 插件:把当前 workspace 的分支历史渲染为车道式提交图,
显示在 explorer 侧边栏中,与「文件」「更改」并列。

## 功能

| 功能 | 说明 |
|------|------|
| **Explorer 标签页** | 分支树作为侧边栏 tab(也可作为普通 workspace 面板打开)。 |
| **窗口化渲染** | 车道式拓扑渲染——默认 500 条提交,最多 2000 条;展开卡片时点和线位置不变。 |
| **分支选择器** | 顶部当前分支下拉:左键预览分支历史(不 checkout),右键或 ⋯ 打开 checkout / merge / rebase / push / pull / fetch / rename / delete。 |
| **分支芯片** | 图上的分支芯片:左键预览,右键打开与顶栏相同的分支菜单;右键 commit 可 create branch / checkout / cherry-pick / revert / merge / rebase / reset / tag。 |
| **提交卡片** | 主题、作者、相对时间、ref 装饰(HEAD / 分支名 / tag),分支名与下拉共用同一套颜色。 |
| **范围切换** | Branch(当前分支 + upstream 标签)、Local(本地分支)、All(含 remote,其它分支 tip 标在图上)。 |
| **搜索** | 按 message / 作者 / hash / 分支名过滤;`f: <路径>` 按文件过滤,覆盖已加载窗口外的历史。 |
| **对比** | Ctrl/Cmd 点击两个 commit 任意对比,展开逐文件 diff。 |
| **未提交卡片** | 顶部工作区摘要:修改 + 新增文件数、± 行数。 |
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

- Paseo 0.5.0-beta 或更新(local plugin 支持)
- daemon 的 `config.json` 里 `pluginsEnabled: true`(Settings → Plugins 里开启)

## 使用

1. 打开任意项目,点击右上角侧边栏切换按钮。
2. 在「文件」「更改」旁边找到 **Git Tree** tab。
3. 点击 commit 展开;点击分支芯片预览分支。

**刷新:** 面板右上角的 ↻ 图标。

**搜索:** 🔍 图标打开输入框,直接输入匹配 message / 作者 / hash / 分支名;输入
`f: 路径`(如 `f: src/foo.ts`)改为按文件过滤,覆盖整个仓库历史而不只是已加载的
500 条。

**对比:** Ctrl/Cmd 点击第一个 commit 设为基点(行上标 ⇔ base),再 Ctrl/Cmd 点击
第二个 commit 展开两者的逐文件差异;再点基点本身取消。

**分支操作:** 点顶部带颜色的当前分支。左键某个分支只预览它的提交图(不切换
HEAD);再点一次取消预览。Checkout 以及 merge / rebase / push / pull / fetch /
rename / delete 都在右键或 ⋯ 菜单里。远程 checkout 会 `git checkout --track`
或切到已有本地分支。新建分支可选择是否立刻 checkout。

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

纯逻辑测试(node 内置 test runner,无 UI 依赖):

- 手写边界用例:空图、单根、线性链、fork/merge/octopus、多子收敛、ref 解析与
  scope 规则、几何往返。
- 程序化生成用例:种子 PRNG(mulberry32)随机生成提交 DAG、ref 装饰、列表几何
  参数,验证结构性不变量(车道连续性、颜色分配、`itemOffset`/`indexAtY` 互逆、
  窗口覆盖)。
- 复现失败样本:测试名带 `seed=N`,修改 `git-tree.shared.test.ts` 里的种子数组
  即可重放。

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
