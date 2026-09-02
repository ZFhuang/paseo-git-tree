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
  /** `fromTop: true` marks a segment that enters this row's dot from above
   *  (a lane converging into this commit); others leave the dot downwards. */
  edges: z.array(
    z.object({
      from: z.number().int(),
      to: z.number().int(),
      fromTop: z.boolean().default(false),
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
     *  (heads), or everything including remotes and tags. */
    scope: treeScope.default("all"),
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
      }),
    ),
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

const branchOp = z.enum(["checkout", "merge", "delete", "pull", "create"]);

/** Mutating git branch operations for the header dropdown. */
export const gitBranchOp = defineRpc({
  name: "gittree.branch",
  input: z.object({
    directory: z.string().min(1),
    op: branchOp,
    /** Target / new branch name. Required for every op except `pull`. */
    name: z.string().optional(),
  }),
  output: z.object({
    error: z.string().nullable(),
  }),
});

export type GitBranchOp = z.infer<typeof branchOp>;
export type GitBranchOpOutput = z.output<typeof gitBranchOp.output>;

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

export function computeGraph(commits: GraphInputCommit[]): GitTreeRow[] {
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
      edges: [...segs.values()],
    });
  }

  return rows;
}
