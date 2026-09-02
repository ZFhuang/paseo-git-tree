# paseo-git-tree

在 Paseo 的 explorer 侧边栏里显示当前 workspace 的 git 分支树（`git log --graph --all`），
与「文件」「更改」并列的一个 tab。

## 功能

- Explorer 侧边栏 tab（也可以作为普通 workspace tab 打开）
- 窗口化渲染分支拓扑（默认 500 条，最多 2000），展开卡片时点和线位置不变
- 顶部当前分支是下拉菜单：按分支着色，可 checkout / pull / merge / 新建 / 删除 / 复制分支名
- 显示 commit 主题、作者、日期、ref 装饰（HEAD / 分支名 / tag），分支名与下拉使用同一套颜色
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

分支操作：点标题栏里带颜色的当前分支，展开下拉后点某个分支再选 Checkout / Pull / Merge / Delete。新建分支用下拉里的 **+ New branch**。删除需要点两次确认，且走 `git branch -d`（未合并的分支会报错，不会强制删）。

## 类型检查

```bash
npm install
npm run typecheck
```

改完源码后用 `paseo plugin reload git-tree` 重新加载。
