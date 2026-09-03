import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

/**
 * One commit row of the computed branch graph.
 *
 * `lane` is the track the commit dot sits on. `edges` are the line segments
 * drawn across this row's vertical span: each goes from lane `from` at the top
 * of the row to lane `to` at the bottom — equal values render as a vertical
 * line, different values as a diagonal (branch out / merge in).
 */
export const rowSchema = z.object({
  hash: z.string(),
  shortHash: z.string(),
  subject: z.string(),
  author: z.string(),
  /** ISO-8601 date. */
  date: z.string(),
  refs: z.array(z.string()),
  /** Parent hashes, in order. Needed to re-lane a filtered subset. */
  parents: z.array(z.string()),
  lane: z.number().int(),
  /** Palette index for this commit's dot and the lines leaving it. */
  color: z.number().int(),
  /** Palette index of the line arriving at this commit, if any. */
  incomingColor: z.number().int().nullable(),
  /** `fromTop: true` marks a segment that enters this row's dot from above
   *  (a lane converging into this commit); others leave the dot downwards. */
  edges: z.array(
    z.object({
      from: z.number().int(),
      to: z.number().int(),
      fromTop: z.boolean().default(false),
      color: z.number().int(),
    }),
  ),
});

export const treeScope = z.enum(["current", "local", "all"]);
export type TreeScope = z.output<typeof treeScope>;

export const gitTree = defineRpc({
  name: "gittree.get",
  input: z.object({
    directory: z.string().min(1),
    limit: z.number().int().positive().max(2000).default(500),
    /** Which refs feed the log: the checked-out branch, all local branches
     *  (heads), or everything including remotes and tags. Ignored when
     *  `preview` is set. */
    scope: treeScope.default("current"),
    /** Show this ref's history without checking it out. */
    preview: z.string().min(1).optional(),
    /** Only commits touching this path (file or directory). Optional. */
    path: z.string().optional(),
  }),
  output: z.object({
    rows: z.array(rowSchema),
    heads: z.array(
      z.object({
        name: z.string(),
        hash: z.string(),
        isCurrent: z.boolean(),
        /** True for `origin/foo`-style refs from `refs/remotes`. */
        remote: z.boolean().default(false),
      }),
    ),
    /** Remote names (`git remote`), used to pair `origin/foo` with local `foo`. */
    remotes: z.array(z.string()),
    /** Uncommitted changes summary: index + worktree + untracked, vs HEAD.
 *  Null when clean or on a repo with no commits. */
    uncommitted: z
      .object({
        count: z.number().int(),
        additions: z.number().int(),
        deletions: z.number().int(),
        /** Untracked files (no diff stat). */
        untracked: z.number().int(),
      })
      .nullable(),
    /** Human-readable failure reason; null when data is usable. */
    error: z.string().nullable(),
  }),
});

export type GitTreeOutput = z.output<typeof gitTree.output>;
export type GitTreeRow = z.output<typeof rowSchema>;

/** Sentinel hash for the working-tree pseudo-commit. Not a git object. */
export const UNCOMMITTED_HASH = "UNCOMMITTED";

export function isUncommittedHash(hash: string): boolean {
  return hash === UNCOMMITTED_HASH;
}

export function uncommittedRow(
  summary: NonNullable<GitTreeOutput["uncommitted"]>,
): GitTreeRow {
  const bits = [
    `${summary.count} file${summary.count === 1 ? "" : "s"}`,
    summary.additions > 0 ? `+${summary.additions}` : "",
    summary.deletions > 0 ? `−${summary.deletions}` : "",
    summary.untracked > 0 ? `${summary.untracked} untracked` : "",
  ].filter(Boolean);
  return {
    hash: UNCOMMITTED_HASH,
    shortHash: "WT",
    subject: "Uncommitted changes",
    author: bits.join("  ·  "),
    date: "",
    refs: [],
    parents: [],
    lane: 0,
    color: 0,
    incomingColor: null,
    edges: [],
  };
}

/** Full detail for one commit, including changed files with stats. */
export const commitDetail = defineRpc({
  name: "gittree.commit",
  input: z.object({
    directory: z.string().min(1),
    hash: z.string().min(1),
  }),
  output: z.object({
    hash: z.string(),
    author: z.string(),
    email: z.string(),
    date: z.string(),
    subject: z.string(),
    body: z.string(),
    parents: z.array(z.string()),
    files: z.array(
      z.object({
        path: z.string(),
        /** Path before a rename; null for non-renames. */
        oldPath: z.string().nullable(),
        status: z.string(),
        additions: z.number().int(),
        deletions: z.number().int(),
      }),
    ),
    error: z.string().nullable(),
  }),
});

export type CommitDetailOutput = z.output<typeof commitDetail.output>;

/** Unified diff of one file in one commit (vs first parent for merges). */
export const commitDiff = defineRpc({
  name: "gittree.diff",
  input: z.object({
    directory: z.string().min(1),
    hash: z.string().min(1),
    path: z.string().min(1),
  }),
  output: z.object({
    patch: z.string(),
    error: z.string().nullable(),
  }),
});

export type CommitDiffOutput = z.output<typeof commitDiff.output>;

/** Files changed between two arbitrary commits (additions/deletions
 *  relative to `base`). */
export const commitCompare = defineRpc({
  name: "gittree.compare",
  input: z.object({
    directory: z.string().min(1),
    base: z.string().min(1),
    head: z.string().min(1),
  }),
  output: z.object({
    files: z.array(
      z.object({
        path: z.string(),
        /** Path before a rename; null for non-renames. */
        oldPath: z.string().nullable(),
        status: z.string(),
        additions: z.number().int(),
        deletions: z.number().int(),
      }),
    ),
    error: z.string().nullable(),
  }),
});

export type CommitCompareOutput = z.output<typeof commitCompare.output>;

/** Unified diff of one file between two arbitrary commits. */
export const commitCompareDiff = defineRpc({
  name: "gittree.compare.diff",
  input: z.object({
    directory: z.string().min(1),
    base: z.string().min(1),
    head: z.string().min(1),
    path: z.string().min(1),
  }),
  output: z.object({
    patch: z.string(),
    error: z.string().nullable(),
  }),
});

export type CommitCompareDiffOutput = z.output<typeof commitCompareDiff.output>;

const branchOp = z.enum([
  "checkout",
  "merge",
  "delete",
  "pull",
  "create",
  "rename",
  "rebase",
  "push",
  "fetch",
]);

/** Mutating git branch operations for the header dropdown. */
export const gitBranchOp = defineRpc({
  name: "gittree.branch",
  input: z.object({
    directory: z.string().min(1),
    op: branchOp,
    /** Target / new branch name. Required for every op except current-branch `pull`. */
    name: z.string().optional(),
    /** New local name for `rename`. */
    newName: z.string().optional(),
    /** `delete -D` or `push --force-with-lease`. */
    force: z.boolean().optional(),
    /** Create and switch to the new branch. Defaults to true. */
    checkOut: z.boolean().optional(),
  }),
  output: z.object({
    error: z.string().nullable(),
  }),
});

export type GitBranchOp = z.infer<typeof branchOp>;
export type GitBranchOpOutput = z.output<typeof gitBranchOp.output>;

const commitAct = z.enum([
  "checkout",
  "cherry-pick",
  "revert",
  "merge",
  "rebase",
  "reset",
  "tag",
  "create-branch",
]);

/** Mutating git operations targeting a commit (Git Graph commit menu). */
export const gitCommitOp = defineRpc({
  name: "gittree.commitact",
  input: z.object({
    directory: z.string().min(1),
    op: commitAct,
    hash: z.string().min(1),
    /** New branch or tag name. */
    name: z.string().optional(),
    /** Reset mode; defaults to mixed. */
    mode: z.enum(["soft", "mixed", "hard"]).optional(),
    /** Create-branch: also check it out. Defaults to true. */
    checkOut: z.boolean().optional(),
  }),
  output: z.object({
    error: z.string().nullable(),
  }),
});

export type GitCommitOp = z.infer<typeof commitAct>;
export type GitCommitOpOutput = z.output<typeof gitCommitOp.output>;

/**
 * Compute the lane graph from topologically-sorted commits.
 *
 * Modelled on vscode-git-graph's determinePath. `lanes` holds one "tip" per
 * lane — the childless parent a vertical line is running towards. Every row
 * emits:
 *
 *  - a vertical segment for each lane merely passing through (keeps
 *    through-lines continuous),
 *  - the commit's own routing segments from its dot down to each parent
 *    (vertical when the lane is kept, diagonal when merging/forking),
 *  - a converging diagonal for extra tips of the same commit (multiple
 *    children pointing at it), entering the dot from above.
 *
 * The client draws each row's segments in that row's local coordinates:
 * y=0 is this card's top, y=height is the next card's top. fromTop edges
 * enter from y=0; other edges leave from the header-center toward y=height.
 */
/** The fields computeGraph reads; rows satisfy this, and so does the
 *  server's raw parsed-commit shape. */
export type GraphInputCommit = Pick<
  GitTreeRow,
  "hash" | "parents" | "subject" | "author" | "date" | "refs"
>;

export function computeGraph(commits: GraphInputCommit[], remotes: string[] = []): GitTreeRow[] {
  const lanes: (string | null)[] = [];
  const rows: GitTreeRow[] = [];

  for (const commit of commits) {
    const before = lanes.slice();
    const segs = new Map<string, { from: number; to: number; fromTop: boolean }>();
    const add = (from: number, to: number, fromTop: boolean) =>
      segs.set(`${from}>${to}@${fromTop}`, { from, to, fromTop });

    // 1. Locate this commit's tips. Several children may point at it, so it
    //    can occupy several lanes; keep the first, converge the others.
    const indices: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === commit.hash) indices.push(i);
    }
    let lane: number;
    const collapsed = new Set<number>();
    if (indices.length > 0) {
      lane = indices[0];
      for (let k = 1; k < indices.length; k++) {
        add(indices[k], lane, true);
        lanes[indices[k]] = null;
        collapsed.add(indices[k]);
      }
    } else {
      // New branch tip: never fill a retired hole. Reusing lane 0 after it
      // was nulled produces a disconnected "ghost" dot on the far left.
      lane = lanes.length;
      lanes.push(null);
    }

    // 2. Verticals for every lane that merely passes through this row.
    for (let i = 0; i < before.length; i++) {
      if (i !== lane && !collapsed.has(i) && before[i] != null) add(i, i, false);
    }

    // 3. Route the commit's own lane to its parents.
    const parents = commit.parents;
    if (parents.length === 0) {
      lanes[lane] = null; // root: no outgoing line; incoming drawn by the row above
    } else {
      const [p1, ...others] = parents;
      const j = lanes.indexOf(p1);
      if (j !== -1) {
        add(lane, j, false); // first parent already has a lane: merge into it
        lanes[lane] = null;
      } else {
        lanes[lane] = p1;
        add(lane, lane, false);
      }
      for (const p of others) {
        const e = lanes.indexOf(p);
        if (e !== -1) {
          add(lane, e, false); // merge into the parent's existing lane
        } else {
          let k = lanes.indexOf(null);
          if (k === -1) {
            k = lanes.length;
            lanes.push(null);
          }
          lanes[k] = p;
          add(lane, k, false); // fork a new lane to the right
        }
      }
    }

    rows.push({
      hash: commit.hash,
      shortHash: commit.hash.slice(0, 7),
      parents: commit.parents,
      subject: commit.subject,
      author: commit.author,
      date: commit.date,
      refs: commit.refs,
      lane,
      color: 0,
      incomingColor: null,
      edges: [...segs.values()].map((e) => ({ ...e, color: 0 })),
    });
  }

  return paintGraph(rows, remotes);
}

/** mhutchie Git Graph default palette. */
export const GRAPH_COLORS = [
  "#0085d9",
  "#d9008f",
  "#00d90a",
  "#d98500",
  "#a300d9",
  "#ff0000",
  "#00d9cc",
  "#e138e8",
  "#85d900",
  "#dc5b23",
  "#6f24d6",
  "#ffcc00",
];

export function graphColor(index: number): string {
  return GRAPH_COLORS[((index % GRAPH_COLORS.length) + GRAPH_COLORS.length) % GRAPH_COLORS.length];
}

type ParsedRef = { label: string; family: string; remote: boolean };

/** Strip `HEAD ->` / tags and split `origin/foo` using known remote names. */
export function parseBranchRef(raw: string, remotes: string[]): ParsedRef | null {
  let ref = raw.trim();
  if (ref === "HEAD") return null;
  if (ref.startsWith("tag:")) return null;
  if (ref.startsWith("HEAD -> ")) ref = ref.slice("HEAD -> ".length).trim();
  if (!ref || ref === "HEAD") return null;
  const sorted = remotes.slice().sort((a, b) => b.length - a.length);
  for (const remote of sorted) {
    const prefix = `${remote}/`;
    if (ref === `${remote}/HEAD`) return null;
    if (ref.startsWith(prefix)) {
      const family = ref.slice(prefix.length);
      if (!family) return null;
      return { label: ref, family, remote: true };
    }
  }
  return { label: ref, family: ref, remote: false };
}

/**
 * Git Graph only paints labels for refs in the current view: the checked-out
 * branch (+ its upstream) in Branch scope, local heads in Local, everything
 * in All. Ancestor tips like `feat/…` stay off the current-branch line.
 */
export function refVisibleInScope(
  raw: string,
  scope: TreeScope,
  remotes: string[],
  currentBranch: string | null,
  preview?: string,
): boolean {
  const t = raw.trim();
  if (!t) return false;
  if (t === "HEAD" || t.startsWith("HEAD ->") || t.startsWith("tag:")) return true;
  const parsed = parseBranchRef(t, remotes);
  if (!parsed) return false;
  if (preview) {
    const want = parseBranchRef(preview, remotes);
    const family = want?.family ?? preview;
    return parsed.family === family || parsed.label === preview;
  }
  if (scope === "all") return true;
  if (scope === "local") return !parsed.remote;
  if (!currentBranch || currentBranch === "HEAD") return false;
  return parsed.family === currentBranch || parsed.label === currentBranch;
}

/** Split `origin/foo` into `{ remote: "origin", branch: "foo" }`. */
export function splitRemoteRef(
  name: string,
  remotes: string[],
): { remote: string; branch: string } | null {
  const parsed = parseBranchRef(name, remotes);
  if (!parsed?.remote) return null;
  const remote = name.slice(0, name.length - parsed.family.length - 1);
  if (!remote) return null;
  return { remote, branch: parsed.family };
}

/**
 * Local and its upstream share a colour only when they point at the same
 * commit. Otherwise each head gets its own slot so unpushed (and unpulled)
 * stretches read as a different colour on the graph.
 */
export function assignRefColors(rows: GitTreeRow[], remotes: string[]): Map<string, number> {
  const byFamily = new Map<string, Array<ParsedRef & { hash: string }>>();
  const order: string[] = [];
  for (const row of rows) {
    for (const raw of row.refs) {
      const parsed = parseBranchRef(raw, remotes);
      if (!parsed) continue;
      let list = byFamily.get(parsed.family);
      if (!list) {
        list = [];
        byFamily.set(parsed.family, list);
        order.push(parsed.family);
      }
      if (!list.some((m) => m.label === parsed.label)) list.push({ ...parsed, hash: row.hash });
    }
  }

  const map = new Map<string, number>();
  let next = 0;
  for (const family of order) {
    const members = byFamily.get(family) ?? [];
    const locals = members.filter((m) => !m.remote);
    const remoteMembers = members.filter((m) => m.remote);
    const localHash = locals[0]?.hash;
    const remoteHashes = [...new Set(remoteMembers.map((m) => m.hash))];
    const overlap =
      localHash !== undefined &&
      (remoteMembers.length === 0 || (remoteHashes.length === 1 && remoteHashes[0] === localHash));

    if (overlap) {
      const c = next++;
      for (const m of members) map.set(m.label, c);
      continue;
    }
    if (localHash === undefined) {
      const byHash = new Map<string, number>();
      for (const m of remoteMembers) {
        let c = byHash.get(m.hash);
        if (c === undefined) {
          c = next++;
          byHash.set(m.hash, c);
        }
        map.set(m.label, c);
      }
      continue;
    }
    const localColor = next++;
    for (const m of locals) map.set(m.label, localColor);
    const byHash = new Map<string, number>();
    for (const m of remoteMembers) {
      let c = byHash.get(m.hash);
      if (c === undefined) {
        c = next++;
        byHash.set(m.hash, c);
      }
      map.set(m.label, c);
    }
  }
  return map;
}

/**
 * Colour each commit and edge. A lane keeps its colour until it hits a ref
 * with a different assigned colour (typically `origin/branch` below unpushed
 * local commits).
 */
export function paintGraph(rows: GitTreeRow[], remotes: string[]): GitTreeRow[] {
  const refColors = assignRefColors(rows, remotes);
  const laneColors: Array<number | undefined> = [];
  let anon = -1;
  for (const c of refColors.values()) if (c > anon) anon = c;
  anon += 1;

  return rows.map((row) => {
    const incoming = laneColors[row.lane];
    const onCommit: number[] = [];
    let localColor: number | undefined;
    for (const raw of row.refs) {
      const parsed = parseBranchRef(raw, remotes);
      if (!parsed) continue;
      const c = refColors.get(parsed.label);
      if (c === undefined) continue;
      onCommit.push(c);
      if (!parsed.remote && localColor === undefined) localColor = c;
    }
    const dot =
      localColor ??
      onCommit[0] ??
      incoming ??
      anon++;

    const edges = row.edges.map((edge) => {
      let color: number;
      if (edge.fromTop) color = laneColors[edge.from] ?? dot;
      else if (edge.from === edge.to && edge.from !== row.lane) color = laneColors[edge.from] ?? 0;
      else color = dot;
      return { ...edge, color };
    });

    const keepsOwn = row.edges.some((e) => !e.fromTop && e.from === row.lane && e.to === row.lane);
    if (keepsOwn) {
      laneColors[row.lane] = dot;
    } else {
      laneColors[row.lane] = undefined;
    }
    for (const edge of row.edges) {
      if (edge.fromTop || edge.from !== row.lane || edge.to === row.lane) continue;
      if (laneColors[edge.to] === undefined) laneColors[edge.to] = dot;
    }

    return {
      ...row,
      color: dot,
      incomingColor: incoming ?? null,
      edges,
    };
  });
}
