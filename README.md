# paseo-git-tree

**A git branch tree for Paseo — `git log --graph --all` in your sidebar.**

[English](README.md) · [简体中文](README.zh-CN.md)

A [Paseo](https://paseo.sh) plugin that renders the current workspace's branch
history as a lane-based commit graph, alongside the File and Changes tabs in
the explorer sidebar.

## Features

| Feature | Description |
|---------|-------------|
| **Explorer tab** | Branch tree as a sidebar tab (also openable as a normal workspace panel). |
| **Windowed graph** | Lane-based topology rendering — 500 commits by default, up to 2000 — with dot and line positions that stay put when a card expands. |
| **Branch picker** | Current-branch dropdown in the header: left-click to preview a branch's history (no checkout), right-click or ⋯ for checkout / merge / rebase / push / pull / fetch / rename / delete. |
| **Branch chips** | On-graph branch chips: left-click previews, right-click opens the same branch menu as the header. Right-click a commit for create branch / checkout / cherry-pick / revert / merge / rebase / reset / tag. |
| **Commit cards** | Subject, author, relative time, ref decorations (HEAD / branch names / tags), with branch names sharing one color system between chips and the dropdown. |
| **Scope switch** | Branch (current branch + upstream label), Local (local branches), All (including remotes — other branch tips appear on the graph). |
| **Search** | Match message / author / hash / branch name; `f: <path>` filters by file across history beyond the loaded window. |
| **Compare** | Ctrl/Cmd-click two commits to diff them; expands to a per-file diff view. |
| **Uncommitted card** | Working-tree summary at the top: changed + untracked file counts and ± line counts. |
| **Expandable cards** | Click a commit to expand full detail (author, date, parents, message body, per-file diff). Expanded cards refresh in place on fetch/reload. |
| **Rename-aware files** | File lists show R status with old ⟶ new paths. |
| **Manual refresh** | ↻ button in the panel header. |

## Install

```bash
git clone <this-repo>
cd paseo-git-tree
npm install

# Install into Paseo
paseo plugin install /absolute/path/to/paseo-git-tree

# Verify it's running
paseo plugin ls
```

Requirements:

- Paseo 0.5.0-beta or newer (local plugin support)
- `pluginsEnabled: true` in the daemon's `config.json` (Settings → Plugins)

## Usage

1. Open any project, click the sidebar switch button in the top-right corner.
2. Find the **Git Tree** tab next to **File** and **Changes**.
3. Click commits to expand; click branch chips to preview branches.

**Refresh:** ↻ icon in the panel header.

**Search:** 🔍 opens the input. Type to match message/author/hash/branch name;
`f: path` (e.g. `f: src/foo.ts`) filters by file across the whole repository
history, not just the loaded 500 commits.

**Compare:** Ctrl/Cmd-click the first commit to set it as the base (marked
⇔ base on the row), then Ctrl/Cmd-click a second commit to expand the per-file
diff between the two. Click the base row again to cancel.

**Branch ops:** click the colored current-branch chip in the header.
Left-clicking a branch previews its commit graph without moving HEAD; click
again to cancel the preview. Checkout, merge / rebase / push / pull / fetch /
rename / delete live in the right-click or ⋯ menu. Remote checkouts use
`git checkout --track` or switch to an existing local branch. New branches can
optionally be checked out immediately.

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
└── README.md / README.zh-CN.md
```

## Testing

```bash
npm test
```

Pure logic tests on the node built-in test runner (no UI dependencies):

- Hand-picked edge cases: empty graph, single root, linear chains,
  fork/merge/octopus merges, multi-child convergence, ref parsing and scope
  rules, list-geometry round-trips.
- Programmatically generated cases: a seeded PRNG (mulberry32) builds random
  commit DAGs, ref decorations, and list-geometry parameters, then checks
  structural invariants (lane continuity, color assignment,
  `itemOffset`/`indexAtY` inversion, window coverage).
- Reproducing a failure: test names carry `seed=N`; edit the seed arrays in
  `git-tree.shared.test.ts` to replay one generation.

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

Apache-2.0
