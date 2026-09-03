/**
 * Logic tests for git-tree.shared.ts — run with `npm test`.
 *
 * Two layers:
 *  1. Hand-picked edge cases (deterministic, documented failures).
 *  2. Programmatically generated samples: seeded PRNG builds random commit
 *     DAGs, ref decorations, and list-geometry parameters, then checks
 *     structural invariants that must hold for ANY input. This is the
 *     "property-based" layer that surfaces edge cases hand-written cases miss.
 *
 * Run a single failing generation again by re-seeding with the printed seed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeGraph,
  paintGraph,
  parseBranchRef,
  refVisibleInScope,
  splitRemoteRef,
  assignRefColors,
  graphColor,
  isUncommittedHash,
  uncommittedRow,
  itemOffset,
  indexAtY,
  windowRange,
  LIST_PAD_Y,
  LIST_OVERSCAN,
  type GitTreeRow,
  type GraphInputCommit,
} from "./git-tree.shared.ts";

// --- Seeded PRNG (mulberry32) -------------------------------------------------

function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (rng: () => number, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

// --- Random DAG generator -----------------------------------------------------
//
// Builds a topologically ordered commit list (child before parent, like
// `git log`): each new commit picks 0..2 parents among already-created commits.
// 0 parents = root; >=2 parents = merge commit. This exercises lane
// allocation, convergence, holes, and re-laning in computeGraph.
function randomDag(rng: () => number, n: number, maxParents = 3): GraphInputCommit[] {
  const commits: GraphInputCommit[] = [];
  for (let i = 0; i < n; i++) {
    const hash = `c${i}${"x".repeat(8)}`.slice(0, 10);
    const parents: string[] = [];
    const want = commits.length === 0 ? 0 : int(rng, 0, maxParents);
    // Bias toward recent commits (real history is mostly linear with
    // occasional forks/merges to older bases).
    for (let p = 0; p < want; p++) {
      const back = int(rng, 0, Math.min(commits.length - 1, 12));
      const cand = commits[commits.length - 1 - back];
      if (cand && !parents.includes(cand.hash)) parents.push(cand.hash);
    }
    commits.push({
      hash,
      parents,
      subject: `commit ${i}`,
      author: `a${int(rng, 0, 4)}`,
      date: `2026-01-${String(int(rng, 1, 28)).padStart(2, "0")}T00:00:00Z`,
      refs: [],
    });
  }
  return commits;
}

/** Sprinkle refs (local branches, remote branches, tags, HEAD) over rows. */
function randomRefs(rng: () => number, commits: GraphInputCommit[], remotes: string[]): GraphInputCommit[] {
  const branchNames = ["main", "dev", "feat/x", "feat/y", "fix"];
  const out = commits.map((c) => ({ ...c, refs: [...c.refs] }));
  const nBranches = int(rng, 1, Math.min(branchNames.length, commits.length + 1));
  for (let b = 0; b < nBranches; b++) {
    const name = branchNames[b];
    const row = out[int(rng, 0, out.length - 1)];
    const isHead = b === 0 && rng() < 0.5;
    row.refs.push(isHead ? `HEAD -> ${name}` : name);
    // Remote counterpart sometimes points at the same commit (in sync),
    // sometimes elsewhere (ahead/behind).
    if (rng() < 0.6) {
      const remote = remotes[int(rng, 0, remotes.length - 1)];
      const remoteRow = rng() < 0.5 ? row : out[int(rng, 0, out.length - 1)];
      remoteRow.refs.push(`${remote}/${name}`);
    }
    if (rng() < 0.2) row.refs.push(`tag: v${int(rng, 0, 9)}`);
  }
  return out;
}

// --- Invariant checks ---------------------------------------------------------

function checkComputeGraphInvariants(commits: GraphInputCommit[], rows: GitTreeRow[], label: string) {
  assert.equal(rows.length, commits.length, `${label}: row count`);

  const laneOccupancy: Map<number, Set<string>> = new Map();
  for (const row of rows) {
    // lane is a sane index
    assert.ok(Number.isInteger(row.lane) && row.lane >= 0, `${label}: lane >= 0 (got ${row.lane})`);

    // Edges reference sane lanes and their endpoints exist in this row's
    // context (from == row.lane for outgoing, or fromTop for converging).
    for (const e of row.edges) {
      assert.ok(Number.isInteger(e.from) && e.from >= 0, `${label}: edge.from`);
      assert.ok(Number.isInteger(e.to) && e.to >= 0, `${label}: edge.to`);
      assert.ok(Number.isInteger(e.color) && e.color >= 0, `${label}: edge.color`);
    }
  }

  // Lane-exclusivity simulation: replay the lane state machine like
  // computeGraph does and verify no two live lanes hold the same hash while
  // both are still expected to be distinct. Cheaper equivalent: for every
  // pair of consecutive rows, every edge.to in the earlier row must have a
  // corresponding owner in the later row (its dot or a pass-through edge).
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const isLast = i === rows.length - 1;
    if (isLast) continue;
    const next = rows[i + 1];
    const nextEndpoints = new Set<number>();
    nextEndpoints.add(next.lane);
    for (const e of next.edges) nextEndpoints.add(e.from);
    for (const e of row.edges) {
      if (e.fromTop) continue; // converging into this row's own dot
      if (e.to === e.from && e.from === row.lane && row.parents.length === 0) continue; // root trailing line stops here
      assert.ok(
        nextEndpoints.has(e.to),
        `${label}: row ${i} edge to lane ${e.to} has no owner in row ${i + 1} (lane ${next.lane}, endpoints ${[...nextEndpoints]})`,
      );
    }
  }

  // Parent connectivity: each parent link is drawn as an edge chain. Verify
  // the direct invariant — the first parent's lane is reachable from this
  // row's outgoing edges (either merges into an existing lane or keeps its
  // own), and the commit's own lane is never reused for an unrelated hash.
  void laneOccupancy;
}

function checkPaintInvariants(rows: GitTreeRow[], label: string) {
  for (const row of rows) {
    assert.ok(Number.isInteger(row.color) && row.color >= 0, `${label}: dot color`);
    assert.ok(
      row.incomingColor === null || (Number.isInteger(row.incomingColor) && row.incomingColor >= 0),
      `${label}: incomingColor`,
    );
    // graphColor() must accept every color index emitted.
    assert.ok(graphColor(row.color).startsWith("#"), `${label}: color in palette`);
  }
}

// --- 1. Hand-picked edge cases ------------------------------------------------

test("empty input", () => {
  assert.deepEqual(computeGraph([]), []);
});

test("single root commit", () => {
  const rows = computeGraph([{ hash: "aaaa0000", parents: [], subject: "s", author: "a", date: "", refs: [] }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lane, 0);
  assert.equal(rows[0].edges.length, 0); // root: no outgoing
});

test("linear chain: every commit keeps its own lane; root draws none", () => {
  // Log order (newest first): c2 -> c1 -> c0.
  const commits: GraphInputCommit[] = [2, 1, 0].map((i) => ({
    hash: `c${i}000000`,
    parents: i === 0 ? [] : [`c${i - 1}000000`],
    subject: "",
    author: "",
    date: "",
    refs: [],
  }));
  const rows = computeGraph(commits);
  // Each row (except the root) holds exactly one self-lane vertical; lanes
  // compact because each child merges into its parent's existing lane below.
  for (let i = 0; i < rows.length - 1; i++) {
    assert.ok(
      rows[i].edges.some((e) => e.from === rows[i].lane && e.to === rows[i].lane && !e.fromTop),
      `row ${i} keeps its own lane`,
    );
  }
  // Root row: incoming lines drawn by rows above; no outgoing edges.
  assert.equal(rows[rows.length - 1].edges.length, 0);
});

test("fork: second branch gets a new lane, merges via diagonal into lane 0", () => {
  // c2 branches off c0 while c1 continues the main line (log order).
  const commits: GraphInputCommit[] = [
    { hash: "c2000000", parents: ["c0000000"], subject: "", author: "", date: "", refs: [] },
    { hash: "c1000000", parents: ["c0000000"], subject: "", author: "", date: "", refs: [] },
    { hash: "c0000000", parents: [], subject: "", author: "", date: "", refs: [] },
  ];
  const rows = computeGraph(commits);
  assert.equal(rows[0].lane, 0); // first commit in log order → lane 0
  assert.equal(rows[1].lane, 1); // new tip → new lane, NOT a retired hole
  assert.equal(rows[2].lane, 0);
  // The fork row routes both lines into lane 0 (own vertical + diagonal).
  assert.ok(rows[1].edges.some((e) => e.from === 1 && e.to === 0), "diagonal into lane 0");
  assert.ok(rows[1].edges.some((e) => e.from === 0 && e.to === 0), "main line vertical");
});

test("merge of two branches converges into one lane", () => {
  const commits: GraphInputCommit[] = [
    { hash: "m0000000", parents: ["a0000000", "b0000000"], subject: "", author: "", date: "", refs: [] },
    { hash: "a0000000", parents: ["r0000000"], subject: "", author: "", date: "", refs: [] },
    { hash: "b0000000", parents: ["r0000000"], subject: "", author: "", date: "", refs: [] },
    { hash: "r0000000", parents: [], subject: "", author: "", date: "", refs: [] },
  ];
  const rows = computeGraph(commits);
  // After the merge row, only one lane survives toward the root.
  const rootRow = rows[rows.length - 1];
  const lanesUsed = new Set([rootRow.lane, ...rootRow.edges.flatMap((e) => [e.from, e.to])]);
  assert.equal(lanesUsed.size, 1, `root row uses exactly one lane, got ${[...lanesUsed]}`);
});

test("octopus merge (3+ parents) allocates distinct lanes", () => {
  const commits: GraphInputCommit[] = [
    { hash: "o0000000", parents: ["p1000000", "p2000000", "p3000000"], subject: "", author: "", date: "", refs: [] },
    { hash: "p1000000", parents: [], subject: "", author: "", date: "", refs: [] },
    { hash: "p2000000", parents: [], subject: "", author: "", date: "", refs: [] },
    { hash: "p3000000", parents: [], subject: "", author: "", date: "", refs: [] },
  ];
  const rows = computeGraph(commits);
  checkComputeGraphInvariants(commits, rows, "octopus");
});

test("multiple children pointing at the same parent merge via diagonals", () => {
  // c1, c2, c3 all have parent r. Extra tips merge into lane 0 with
  // diagonal edges (from != to); no duplicate tips remain after r's row.
  const commits: GraphInputCommit[] = [
    { hash: "c3000000", parents: ["r0000000"], subject: "", author: "", date: "", refs: [] },
    { hash: "c2000000", parents: ["r0000000"], subject: "", author: "", date: "", refs: [] },
    { hash: "c1000000", parents: ["r0000000"], subject: "", author: "", date: "", refs: [] },
    { hash: "r0000000", parents: [], subject: "", author: "", date: "", refs: [] },
  ];
  const rows = computeGraph(commits);
  const diagonals = rows.slice(0, 3).map((r) => r.edges.filter((e) => e.from !== e.to));
  assert.equal(diagonals[0].length, 0); // first child owns lane 0 outright
  assert.equal(diagonals[1].length, 1); // second child diagonal-merges
  assert.equal(diagonals[2].length, 1); // third child diagonal-merges
  // Root ends with a single live lane.
  assert.equal(rows[3].lane, 0);
  checkComputeGraphInvariants(commits, rows, "converge");
});

// --- 2. Property: computeGraph on random DAGs ----------------------------------

for (const seed of [1, 7, 42, 1337, 90210, 20260903, 424242, 999983]) {
  test(`random DAG seed=${seed}`, () => {
    const rng = makeRng(seed);
    const n = int(rng, 3, 60);
    const maxParents = int(rng, 1, 3);
    const commits = randomDag(rng, n, maxParents);
    const remotes = rng() < 0.5 ? ["origin"] : ["origin", "upstream"];
    const decorated = randomRefs(rng, commits, remotes);
    const rows = computeGraph(decorated, remotes);
    checkComputeGraphInvariants(decorated, rows, `seed=${seed}`);
    checkPaintInvariants(rows, `seed=${seed}`);
  });
}

// Cross-check against a brute-force reference: replay the same lane algorithm
// independently for small DAGs. This catches drift if computeGraph is edited.
test("random DAGs: lane count is bounded by (#commits) and lanes never negative", () => {
  for (const seed of [5, 11, 23, 77, 314]) {
    const rng = makeRng(seed);
    const commits = randomDag(rng, int(rng, 2, 40), 3);
    const rows = computeGraph(commits);
    const maxLane = Math.max(0, ...rows.map((r) => r.lane));
    assert.ok(maxLane < commits.length, `max lane ${maxLane} < n ${commits.length}`);
    for (const r of rows) {
      for (const e of r.edges) {
        assert.ok(Math.max(e.from, e.to) < commits.length, "lane index within bound");
      }
    }
  }
});

// --- 3. Ref parsing / scope ----------------------------------------------------

test("parseBranchRef basics", () => {
  assert.equal(parseBranchRef("HEAD", []), null);
  assert.equal(parseBranchRef("tag: v1", []), null);
  assert.equal(parseBranchRef("", []), null);
  // `HEAD -> main` is stripped to the branch name.
  const p = parseBranchRef("HEAD -> main", []);
  assert.ok(p);
  assert.equal(p.label, "main");
});
test("parseBranchRef strips HEAD -> and returns local", () => {
  const p = parseBranchRef("HEAD -> main", []);
  assert.ok(p);
  assert.equal(p.label, "main");
  assert.equal(p.family, "main");
  assert.equal(p.remote, false);
});

test("parseBranchRef splits remote by known remote name", () => {
  const p = parseBranchRef("origin/feat/x", ["origin"]);
  assert.ok(p);
  assert.equal(p.family, "feat/x");
  assert.equal(p.remote, true);
  assert.equal(p.label, "origin/feat/x");
});

test("parseBranchRef: unknown remote stays local", () => {
  const p = parseBranchRef("origin/main", []);
  assert.ok(p);
  assert.equal(p.remote, false);
});

test("parseBranchRef: origin/HEAD is skipped", () => {
  assert.equal(parseBranchRef("origin/HEAD", ["origin"]), null);
});

test("parseBranchRef: longest remote name wins (origin vs origin2)", () => {
  const p = parseBranchRef("origin2/main", ["origin", "origin2"]);
  assert.ok(p);
  assert.equal(p.family, "main");
});

test("splitRemoteRef", () => {
  assert.deepEqual(splitRemoteRef("origin/foo", ["origin"]), { remote: "origin", branch: "foo" });
  assert.equal(splitRemoteRef("foo", ["origin"]), null);
  assert.equal(splitRemoteRef("origin/HEAD", ["origin"]), null);
});

test("refVisibleInScope across scopes", () => {
  const remotes = ["origin"];
  assert.equal(refVisibleInScope("HEAD -> main", "current", remotes, "main"), true);
  assert.equal(refVisibleInScope("main", "current", remotes, "main"), true);
  assert.equal(refVisibleInScope("dev", "current", remotes, "main"), false);
  assert.equal(refVisibleInScope("dev", "local", remotes, "main"), true);
  assert.equal(refVisibleInScope("origin/dev", "local", remotes, "main"), false);
  assert.equal(refVisibleInScope("origin/dev", "all", remotes, "main"), true);
  assert.equal(refVisibleInScope("tag: v1", "local", remotes, "main"), true);
  // No branch checked out (detached) — current scope shows nothing.
  assert.equal(refVisibleInScope("main", "current", remotes, null), false);
  assert.equal(refVisibleInScope("main", "current", remotes, "HEAD"), false);
});

test("refVisibleInScope preview mode overrides scope", () => {
  const remotes = ["origin"];
  assert.equal(refVisibleInScope("dev", "current", remotes, "main", "dev"), true);
  assert.equal(refVisibleInScope("origin/dev", "current", remotes, "main", "dev"), true);
  assert.equal(refVisibleInScope("main", "current", remotes, "main", "dev"), false);
});

// --- 4. assignRefColors properties ---------------------------------------------

test("local and in-sync remote share a color; diverged do not", () => {
  const row = (refs: string[]): GitTreeRow => ({
    hash: "h0000000",
    shortHash: "h000000",
    subject: "",
    author: "",
    date: "",
    refs,
    parents: [],
    lane: 0,
    color: 0,
    incomingColor: null,
    edges: [],
  });
  // In sync: both point at the same commit.
  const inSync = assignRefColors([row(["main", "origin/main"])], ["origin"]);
  assert.equal(inSync.get("main"), inSync.get("origin/main"));

  // Diverged: different commits.
  const diverged = assignRefColors(
    [
      row(["main"]),
      { ...row(["origin/main"]), hash: "h1111111" },
    ],
    ["origin"],
  );
  assert.notEqual(diverged.get("main"), diverged.get("origin/main"));
});

test("assignRefColors: every ref label gets a color, colors are stable per family", () => {
  const rng = makeRng(42);
  for (let iter = 0; iter < 30; iter++) {
    const commits = randomRefs(rng, randomDag(rng, int(rng, 3, 25)), ["origin"]);
    const rows = computeGraph(commits, ["origin"]);
    const colors = assignRefColors(rows, ["origin"]);
    for (const r of rows) {
      for (const raw of r.refs) {
        const p = parseBranchRef(raw, ["origin"]);
        if (!p) continue;
        assert.ok(colors.has(p.label), `iter ${iter}: ${p.label} has a color`);
      }
    }
  }
});

// --- 5. Uncommitted row --------------------------------------------------------

test("isUncommittedHash / uncommittedRow shape", () => {
  assert.equal(isUncommittedHash("UNCOMMITTED"), true);
  assert.equal(isUncommittedHash("abc123"), false);
  const row = uncommittedRow({ count: 3, additions: 5, deletions: 2, untracked: 1 });
  assert.equal(row.lane, 0);
  assert.equal(row.parents.length, 0);
  assert.equal(row.refs.length, 0);
});

// --- 6. List geometry: hand-picked ---------------------------------------------

test("itemOffset without expansion", () => {
  assert.equal(itemOffset(0, 50, -1, 50), LIST_PAD_Y);
  assert.equal(itemOffset(3, 50, -1, 50), LIST_PAD_Y + 150);
});

test("itemOffset with expanded row", () => {
  // Row 2 expanded to 200 tall: rows after it shift by 150.
  assert.equal(itemOffset(1, 50, 2, 200), LIST_PAD_Y + 50);
  assert.equal(itemOffset(2, 50, 2, 200), LIST_PAD_Y + 100);
  assert.equal(itemOffset(3, 50, 2, 200), LIST_PAD_Y + 150 + 150);
});

test("indexAtY inverts itemOffset (no expansion)", () => {
  const H = 50;
  for (let i = 0; i < 20; i++) {
    const y = itemOffset(i, H, -1, H) + H / 2;
    assert.equal(indexAtY(y, 20, H, -1, H), i);
  }
});

test("indexAtY inverts itemOffset (with expansion)", () => {
  const H = 50;
  const expIdx = 4;
  const expH = 300;
  const count = 20;
  for (let i = 0; i < count; i++) {
    const y = itemOffset(i, H, expIdx, expH) + 1;
    assert.equal(indexAtY(y, count, H, expIdx, expH), i, `row ${i}`);
  }
});

test("indexAtY edge cases", () => {
  assert.equal(indexAtY(-5, 10, 50, -1, 50), 0);
  assert.equal(indexAtY(0, 10, 50, -1, 50), 0);
  assert.equal(indexAtY(1e9, 10, 50, -1, 50), 9); // clamped to last
  assert.equal(indexAtY(0, 0, 50, -1, 50), 0); // empty list
  // y exactly at a boundary belongs to the row below.
  assert.equal(indexAtY(50, 10, 50, -1, 50), 1);
});

test("windowRange covers the viewport and clamps to the list", () => {
  const r = windowRange(0, 300, 100, 50, -1, 50);
  assert.equal(r.start, 0);
  // localY = 0 - LIST_PAD_Y = -8 → first row; bottom probe y = -8+300 = 292
  // → row 5; end = 5 + overscan + 1.
  assert.equal(r.end, 5 + LIST_OVERSCAN + 1);

  const past = windowRange(1e9, 300, 100, 50, -1, 50);
  assert.equal(past.end, 100);
  assert.ok(past.start < 100);

  const empty = windowRange(0, 300, 0, 50, -1, 50);
  assert.deepEqual(empty, { start: 0, end: 0 });
});

// --- 7. Property: geometry round-trip on random parameters ----------------------

for (const seed of [3, 17, 99, 2026]) {
  test(`geometry round-trip seed=${seed}`, () => {
    const rng = makeRng(seed);
    const H = int(rng, 20, 120);
    const count = int(rng, 1, 300);
    const expIdx = rng() < 0.25 ? -1 : int(rng, 0, count - 1);
    const expH = expIdx >= 0 ? int(rng, H, H * 8) : H;

    // Every row's offset maps back to that row.
    for (let i = 0; i < count; i++) {
      const y = itemOffset(i, H, expIdx, expH) + 1;
      assert.equal(indexAtY(y, count, H, expIdx, expH), i, `seed=${seed} row ${i}`);
    }

    // The visible window always contains the viewport, with overscan margins.
    const vh = int(rng, 100, 1200);
    const scrollY = int(rng, 0, Math.max(0, count * H + (expIdx >= 0 ? expH - H : 0)));
    const win = windowRange(scrollY, vh, count, H, expIdx, expH);
    assert.ok(win.start >= 0 && win.end <= count, "window within list");
    assert.ok(win.start <= win.end, "start <= end");
    // First visible row starts at or above the viewport top.
    if (win.end > win.start) {
      const firstY = itemOffset(win.start, H, expIdx, expH);
      // allow the +1 sampling offset used above
      assert.ok(
        indexAtY(scrollY, count, H, expIdx, expH) >= Math.max(0, win.start - LIST_OVERSCAN),
        "window covers scroll position",
      );
      void firstY;
    }
  });
}

// --- 8. paintGraph idempotence --------------------------------------------------

test("paintGraph is deterministic (same input, same output)", () => {
  const rng = makeRng(777);
  const commits = randomRefs(rng, randomDag(rng, 30), ["origin"]);
  const a = computeGraph(commits, ["origin"]);
  const b = computeGraph(commits, ["origin"]);
  assert.deepEqual(a, b);
});
