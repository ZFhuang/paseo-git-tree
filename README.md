# paseo-git-tree

**A git branch tree for Paseo — `git log --graph` as a panel tab.**

[English](README.md) · [简体中文](README.zh-CN.md)

A [Paseo](https://paseo.sh) plugin that draws the current workspace's branch history as a lane-based commit graph.

## Features

| Feature | Description |
|---------|-------------|
| **Workspace tab** | Branch tree as a panel tab; also allowed in the explorer sidebar pane. |
| **Windowed graph** | Lane-based topology rendering — 500 commits by default, up to 2000 — with dot and line positions that stay put when a card expands. |
| **Branch picker** | Current-branch dropdown in the header: left-click to preview a branch's history (no checkout), right-click or ⋯ for checkout / merge / rebase / push / pull / fetch / rename / delete. |
| **Branch chips** | On-graph branch chips: left-click previews, right-click opens the same branch menu as the header. Right-click a commit for create branch / checkout / cherry-pick / revert / merge / rebase / reset / tag. |
| **Commit cards** | Subject, author, relative time, ref decorations (HEAD / branch names / tags), with branch names sharing one color system between chips and the dropdown. |
| **Scope switch** | Branch (checked-out branch only), Local (all local branches), All (local + remotes + tags). |
| **Search** | Client-side match on message / author / hash prefix / branch name; `f: <path>` switches to a server-side `git log -- <path>` filter. |
| **Compare** | Ctrl/Cmd-click two commits to diff them; expands to a per-file diff view. |
| **Uncommitted row** | Working-tree summary at the top: changed + untracked file counts and ± line counts. |
| **Expandable cards** | Click a commit to expand full detail (author, date, parents, message body, per-file diff). Expanded cards refresh in place on fetch/reload. |
| **Rename-aware files** | File lists show R status with old ⟶ new paths. |
| **Manual refresh** | ↻ button in the panel header. |

## Install

```bash
git clone https://github.com/ZFhuang/paseo-git-tree.git
cd paseo-git-tree
npm install

# Install into Paseo
paseo plugin install /absolute/path/to/paseo-git-tree

# Verify it's running
paseo plugin ls
```

Requirements:

- Paseo 0.7.2 or newer (local plugin support; verified against the bundled `paseo` CLI)
- `pluginsEnabled: true` in the daemon's `config.json` (Settings → Plugins in the desktop app)

## Usage

### Opening the panel

The panel registers both the `explorer` and `workspace` locations. Paseo's explorer sidebar only renders its own built-in Files / Changes / Pull request tabs, so plugin panels are not appended there. Open Git Tree from the new-tab menu:

1. Open a workspace.
2. Click **+ (New tab)** on the tab strip at the top of the main area.
3. Pick **Git Tree** from the dropdown. It is listed after the built-in tabs, in the plugin group.

It opens as a regular workspace tab. To open it inside the explorer sidebar pane instead, right-click the sidebar's tab rail and choose **New tab** — that runs the new-tab launcher inside the sidebar, where Git Tree is listed too. Send a sidebar tab back to the main area with its context menu → **Move to main panel**.

### Header controls

Left to right: title + commit count, current-branch chip, scope filter, search, pull, push, refresh.

| Control | What it does |
|---------|--------------|
| **Current branch chip** | Opens the branch list. |
| **Scope (Filter icon)** | Switch refs: **Branch** (checked-out branch only), **Local** (all local branches), **All** (local + remotes + tags). |
| **🔍** | Toggles the search input. |
| **↓ / ↑** | Pull / push the current branch. Push is hidden when the repo has no remotes; both are hidden when HEAD is detached. |
| **↻** | Reload. Runs `git fetch --all --prune` first when the repo has remotes. |

### Rows

Click a commit to expand it: author, date, parents, message body, and a per-file diff. Hovering shows a tooltip with the full commit message.

When the worktree is dirty, the top row is an **Uncommitted changes** pseudo-commit with the short hash `WT`. Expanding it lists the working-tree files.

Right-click or long-press a row for the commit menu: create branch, checkout (detached), cherry-pick, revert, merge, rebase, reset (mixed / hard), add tag, copy message / hash. Uncommitted rows only offer the copy actions.

### Comparing two commits

Ctrl/Cmd/Alt-click a commit to set it as the base. The row is badged `⇔ base`. Ctrl/Cmd/Alt-click a second commit to expand the per-file diff between the two; that row is badged `⇔ target`. Ctrl-click the base again to cancel.

### Search

Type to match subject, author, hash prefix, or branch name. The graph is re-laid out over the matches.

Prefix the query with `f:` to filter by file instead — for example `f: src/foo.ts`. This runs `git log -- <path>` on the server, so it covers history beyond the loaded window. Input is debounced by 250 ms.

### Branch menu

Click the colored current-branch chip, or right-click a branch chip on the graph to open that ref's actions directly.

The list has a filter box and a `+ Create branch…` entry, which can check the new branch out immediately. Left-clicking a branch previews its history without moving HEAD; click it again to cancel the preview.

Right-click, long-press, or ⋯ opens that branch's actions:

- **Checkout** — remotes use `git checkout --track`, or switch to the existing local branch of the same name.
- **Merge / rebase** into the current branch.
- **Pull / fetch** for remotes.
- **Push**, or force push with `--force-with-lease`.
- **Rename**, **copy name**, **delete**.

Rebase, force push, and delete ask for a second confirming click.

### File rows

Right-click a file for **Filter commits by this file** (fills in `f: <path>`) or **Copy path**.

## Plugin structure

```
paseo-git-tree/
├── paseo-plugin.json        # Manifest (id: "git-tree")
├── index.ts                 # Entry: RPC handlers + workspace panel registration
├── git-tree-panel.client.tsx # Panel UI (React Native) — client bundle
├── git-tree.server.ts       # git subprocess wrapper — server bundle
├── git-tree.shared.ts       # Zod RPC contracts + pure graph/layout algorithms
├── git-tree.shared.test.ts  # Logic tests (node:test) incl. seeded random cases
├── package.json
├── tsconfig.json
├── LICENSE
└── README.md / README.zh-CN.md
```

## Testing

```bash
npm test
```

Pure logic tests on the node built-in test runner, with no UI dependencies:

- Hand-picked edge cases: empty graph, single root, linear chains, fork/merge/octopus merges, multi-child convergence, ref parsing and scope rules, list-geometry round-trips.
- Programmatically generated cases: a seeded PRNG (mulberry32) builds random commit DAGs, ref decorations, and list-geometry parameters, then checks structural invariants — lane continuity, color assignment, `itemOffset`/`indexAtY` inversion, window coverage.
- Reproducing a failure: test names carry `seed=N`. Edit the seed arrays in `git-tree.shared.test.ts` to replay one generation.

## Development

```bash
# Type-check after changes
npm run typecheck

# Reload the plugin
paseo plugin reload git-tree

# Check logs
paseo plugin logs git-tree
```

## License

MIT — see [LICENSE](./LICENSE).
