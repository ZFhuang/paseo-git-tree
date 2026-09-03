import { execFile } from "node:child_process";
import path from "node:path";
import type { output as ZodOutput } from "zod";
import { commitCompare, commitCompareDiff, commitDetail, commitDiff, computeGraph, gitBranchOp, gitTree, isUncommittedHash, splitRemoteRef, UNCOMMITTED_HASH } from "./git-tree.shared";

type Input = ZodOutput<typeof gitTree.input>;

function runGit(
  directory: string,
  args: string[],
  timeoutMs = 15_000,
  allowExit: number[] = [],
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd: directory, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (!err) {
          resolve(stdout);
          return;
        }
        const code = (err as { code?: unknown }).code;
        if (typeof code === "number" && allowExit.includes(code)) {
          resolve(stdout);
          return;
        }
        reject(new Error(stderr.trim() || err.message));
      },
    );
  });
}

function firstLine(text: string): string {
  const nl = text.indexOf("\n");
  return nl === -1 ? text : text.slice(0, nl);
}


/** The empty-tree hash git uses as diff base for root commits. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** First parent of a commit, or the empty tree for root commits. */
async function diffBase(directory: string, hash: string): Promise<string> {
  try {
    const out = await runGit(directory, ["rev-parse", "--verify", `${hash}^`]);
    const first = firstLine(out).trim();
    if (first) return first;
  } catch {
    // root commit
  }
  return EMPTY_TREE;
}

export async function getGitTree(input: Input): Promise<ZodOutput<typeof gitTree.output>> {
  const directory = path.resolve(input.directory);
  const limit = input.limit ?? 300;
  const scope = input.scope ?? "all";

  try {
    // %x1e record / %x1f field separators: hash, parents, author, date, refs, subject.
    const fmt = "%x1e%H%x1f%P%x1f%an%x1f%aI%x1f%D%x1f%s%x1e";
    const preview = input.preview?.trim();
    const refs = preview
      ? [assertBranchName(preview)]
      : scope === "current"
        ? ["HEAD"]
        : scope === "local"
          ? ["--branches"]
          : ["--all"];
    const pathArgs = input.path ? ["--", input.path] : [];
    const [out, remoteOut] = await Promise.all([
      runGit(
        directory,
        ["log", "--topo-order", ...refs, `--pretty=format:${fmt}`, `-n${limit}`, ...pathArgs],
        30_000,
      ),
      runGit(directory, ["remote"]).catch(() => ""),
    ]);
    const remotes = remoteOut
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const commits: Parameters<typeof computeGraph>[0] = [];
    for (const rawLine of out.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (line === "" || !line.includes("\x1e")) continue;
      const body = line.slice(line.indexOf("\x1e") + 1, line.lastIndexOf("\x1e"));
      const [hash = "", parentsRaw = "", author = "", date = "", refsRaw = "", subject = ""] =
        body.split("\x1f");
      commits.push({
        hash,
        parents: parentsRaw ? parentsRaw.split(" ").filter(Boolean) : [],
        author,
        date,
        refs: refsRaw
          ? refsRaw
              .split(/,\s*/)
              .map((r) => r.trim())
              .filter(Boolean)
          : [],
        subject,
      });
    }

    const rows = computeGraph(commits, remotes);

    let heads: ZodOutput<typeof gitTree.output>["heads"] = [];
    try {
      const [branchOut, remoteRefOut, currentOut] = await Promise.all([
        runGit(directory, [
          "for-each-ref",
          "--format=%(refname:short)%09%(objectname)%09%(HEAD)",
          "refs/heads",
        ]),
        runGit(directory, [
          "for-each-ref",
          "--format=%(refname:short)%09%(objectname)",
          "refs/remotes",
        ]).catch(() => ""),
        runGit(directory, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ""),
      ]);
      const current = firstLine(currentOut).trim();
      const locals = branchOut
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((line) => {
          const [name = "", hash = "", headFlag = ""] = line.split("\t");
          return {
            name,
            hash,
            isCurrent: headFlag.trim() === "*" || name === current,
            remote: false,
          };
        });
      const remoteHeads = remoteRefOut
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((line) => {
          const [name = "", hash = ""] = line.split("\t");
          return { name, hash };
        })
        .filter((r) => r.name && !r.name.endsWith("/HEAD"))
        .map((r) => ({ name: r.name, hash: r.hash, isCurrent: false, remote: true }));
      heads = [...locals, ...remoteHeads];
    } catch {
      // Branch listing is best-effort; the graph is the main content.
    }

    // Uncommitted changes (index + worktree vs HEAD) plus untracked files.
    // Best-effort: null when clean or the repo has no commits yet.
    let uncommitted: ZodOutput<typeof gitTree.output>["uncommitted"] = null;
    try {
      const [numstat, statusOut] = await Promise.all([
        runGit(directory, ["diff", "HEAD", "--numstat"]).catch(() => ""),
        runGit(directory, ["status", "--porcelain"]).catch(() => ""),
      ]);
      let additions = 0;
      let deletions = 0;
      let tracked = 0;
      for (const line of numstat.split("\n")) {
        if (!line.trim()) continue;
        const [a = "0", d = "0"] = line.split("\t");
        tracked++;
        additions += a === "-" ? 0 : Number.parseInt(a, 10) || 0;
        deletions += d === "-" ? 0 : Number.parseInt(d, 10) || 0;
      }
      let untracked = 0;
      for (const line of statusOut.split("\n")) {
        if (line.startsWith("??")) untracked++;
      }
      if (tracked > 0 || untracked > 0) {
        uncommitted = { count: tracked + untracked, additions, deletions, untracked };
      }
    } catch {
      // Uncommitted summary is best-effort.
    }

    return { rows, heads, remotes, uncommitted, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { rows: [], heads: [], remotes: [], uncommitted: null, error: message };
  }
}

/**
 * `git diff --numstat` reports a rename as `old => new` or the brace form
 * `pre/{old => new}post`. Normalize both to the destination path so the
 * stat key matches the `--name-status` key (which is the new path).
 */
function normalizeNumstatPath(raw: string): string {
  if (raw.includes("=>")) {
    // `pre/{old => new}post` (empty sides allowed: `src/{ => a.ts}`)
    const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(raw);
    if (brace) return `${brace[1]}${brace[3]}${brace[4]}`;
    const arrow = /^(.*) => (.*)$/.exec(raw);
    if (arrow) return arrow[2];
  }
  return raw;
}

type DiffFile = {
  path: string;
  oldPath: string | null;
  status: string;
  additions: number;
  deletions: number;
};

/** Merge `git diff --numstat` and `--name-status` between two revs into one
 *  per-file list (rename-aware). Omit `head` to diff `base` against the worktree. */
async function diffFiles(directory: string, base: string, head?: string): Promise<DiffFile[]> {
  const revs = head ? [base, head] : [base];
  const [stats, statuses] = await Promise.all([
    runGit(directory, ["diff", "--numstat", ...revs], 15_000, [1]).catch(() => ""),
    runGit(directory, ["diff", "--name-status", ...revs], 15_000, [1]).catch(() => ""),
  ]);
  const statByPath = new Map<string, { additions: number; deletions: number }>();
  for (const line of stats.split("\n")) {
    if (!line.trim()) continue;
    const [a = "0", d = "0", ...p] = line.split("\t");
    statByPath.set(normalizeNumstatPath(p.join("\t")), {
      additions: a === "-" ? 0 : Number.parseInt(a, 10) || 0,
      deletions: d === "-" ? 0 : Number.parseInt(d, 10) || 0,
    });
  }
  const statusByPath = new Map<string, string>();
  const oldPathByPath = new Map<string, string>();
  for (const line of statuses.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = (parts[0] ?? "").charAt(0);
    const filePath = parts.length > 2 ? parts[2] : parts[1];
    if (filePath) {
      statusByPath.set(filePath, status);
      if (parts.length > 2) oldPathByPath.set(filePath, parts[1]);
    }
  }
  return [...new Set([...statByPath.keys(), ...statusByPath.keys()])]
    .sort()
    .map((filePath) => ({
      path: filePath,
      oldPath: oldPathByPath.get(filePath) ?? null,
      status: statusByPath.get(filePath) ?? "M",
      additions: statByPath.get(filePath)?.additions ?? 0,
      deletions: statByPath.get(filePath)?.deletions ?? 0,
    }));
}

function unquotePorcelainPath(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) return t.slice(1, -1);
  return t;
}

/** Index + worktree + untracked files vs HEAD (or the empty tree). */
async function worktreeFiles(directory: string): Promise<DiffFile[]> {
  let base = "HEAD";
  try {
    await runGit(directory, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    base = EMPTY_TREE;
  }
  const files = await diffFiles(directory, base);
  const seen = new Set(files.map((f) => f.path));
  const porcelain = await runGit(directory, ["status", "--porcelain", "--untracked-files=all"]).catch(() => "");
  for (const line of porcelain.split("\n")) {
    if (!line.startsWith("??")) continue;
    const filePath = unquotePorcelainPath(line.slice(3));
    if (!filePath || seen.has(filePath)) continue;
    files.push({ path: filePath, oldPath: null, status: "?", additions: 0, deletions: 0 });
    seen.add(filePath);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

async function worktreePatch(directory: string, filePath: string): Promise<string> {
  const vsHead = await runGit(directory, ["diff", "HEAD", "--", filePath], 15_000, [1]).catch(() => "");
  if (vsHead.trim()) return vsHead;
  const emptyBlob = process.platform === "win32" ? "NUL" : "/dev/null";
  return runGit(directory, ["diff", "--no-index", "--", emptyBlob, filePath], 15_000, [1]).catch(() => "");
}

export async function getCommitDetail(
  input: ZodOutput<typeof commitDetail.input>,
): Promise<ZodOutput<typeof commitDetail.output>> {
  const directory = path.resolve(input.directory);
  const { hash } = input;
  if (isUncommittedHash(hash)) {
    try {
      let parent = "";
      try {
        parent = firstLine(await runGit(directory, ["rev-parse", "HEAD"])).trim();
      } catch {
        // no commits yet
      }
      const files = await worktreeFiles(directory);
      return {
        hash: UNCOMMITTED_HASH,
        author: "Working tree",
        email: "",
        date: new Date().toISOString(),
        subject: "Uncommitted changes",
        body: "",
        parents: parent ? [parent] : [],
        files,
        error: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        hash: UNCOMMITTED_HASH,
        author: "",
        email: "",
        date: "",
        subject: "",
        body: "",
        parents: [],
        files: [],
        error: message,
      };
    }
  }
  try {
    const fmt = "%H%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%s%x1f%b";
    const meta = await runGit(directory, ["show", "-s", `--pretty=format:${fmt}`, hash]);
    const [fullHash = "", author = "", email = "", date = "", parentsRaw = "", subject = "", ...rest] =
      meta.split("\x1f");
    const bodyText = rest.join("\x1f").trim();

    const base = await diffBase(directory, hash);
    const files = await diffFiles(directory, base, hash);

    return {
      hash: fullHash || hash,
      author,
      email,
      date,
      subject,
      body: bodyText,
      parents: parentsRaw ? parentsRaw.split(" ").filter(Boolean) : [],
      files,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      hash,
      author: "",
      email: "",
      date: "",
      subject: "",
      body: "",
      parents: [],
      files: [],
      error: message,
    };
  }
}

export async function getCommitDiff(
  input: ZodOutput<typeof commitDiff.input>,
): Promise<ZodOutput<typeof commitDiff.output>> {
  const directory = path.resolve(input.directory);
  try {
    if (isUncommittedHash(input.hash)) {
      return { patch: await worktreePatch(directory, input.path), error: null };
    }
    const base = await diffBase(directory, input.hash);
    const patch = await runGit(directory, ["diff", base, input.hash, "--", input.path], 15_000, [1]);
    return { patch, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { patch: "", error: message };
  }
}

/**
 * Git refname rules are extensive; this rejects the cases that are either
 * invalid or would be parsed as flags / path tricks when passed as an argv item.
 */
function assertBranchName(name: string): string {
  const n = name.trim();
  if (!n) throw new Error("Branch name is empty");
  if (n === "HEAD" || n === "@") throw new Error("Invalid branch name");
  if (n.startsWith("-") || n.startsWith("/") || n.endsWith("/") || n.endsWith(".") || n.endsWith(".lock")) {
    throw new Error("Invalid branch name");
  }
  if (n.includes("..") || n.includes("//") || n.includes("@{") || n.includes("\\")) {
    throw new Error("Invalid branch name");
  }
  if (/[\s~^:?*\[\x00-\x1f]/.test(n)) throw new Error("Invalid branch name");
  return n;
}

async function currentBranchName(directory: string): Promise<string> {
  const out = await runGit(directory, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return firstLine(out).trim();
}

export async function getCommitCompare(
  input: ZodOutput<typeof commitCompare.input>,
): Promise<ZodOutput<typeof commitCompare.output>> {
  const directory = path.resolve(input.directory);
  try {
    const files = await diffFiles(directory, input.base, input.head);
    return { files, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { files: [], error: firstLine(message) || message };
  }
}

export async function getCommitCompareDiff(
  input: ZodOutput<typeof commitCompareDiff.input>,
): Promise<ZodOutput<typeof commitCompareDiff.output>> {
  const directory = path.resolve(input.directory);
  try {
    const patch = await runGit(
      directory,
      ["diff", input.base, input.head, "--", input.path],
    );
    return { patch, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { patch: "", error: firstLine(message) || message };
  }
}

async function listRemotes(directory: string): Promise<string[]> {
  const out = await runGit(directory, ["remote"]).catch(() => "");
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function defaultRemote(remotes: string[]): string {
  if (remotes.includes("origin")) return "origin";
  if (remotes[0]) return remotes[0];
  throw new Error("No remotes configured");
}

async function localBranchExists(directory: string, name: string): Promise<boolean> {
  try {
    await runGit(directory, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

export async function runBranchOp(
  input: ZodOutput<typeof gitBranchOp.input>,
): Promise<ZodOutput<typeof gitBranchOp.output>> {
  const directory = path.resolve(input.directory);
  try {
    const remotes = await listRemotes(directory);
    switch (input.op) {
      case "pull": {
        if (!input.name) {
          await runGit(directory, ["pull"], 60_000);
          break;
        }
        const split = splitRemoteRef(input.name, remotes);
        if (split) {
          await runGit(directory, ["pull", split.remote, split.branch], 60_000);
        } else {
          await runGit(directory, ["pull"], 60_000);
        }
        break;
      }
      case "checkout": {
        const name = assertBranchName(input.name ?? "");
        const split = splitRemoteRef(name, remotes);
        if (split) {
          if (await localBranchExists(directory, split.branch)) {
            await runGit(directory, ["checkout", split.branch]);
          } else {
            await runGit(directory, ["checkout", "--track", `${split.remote}/${split.branch}`]);
          }
        } else {
          await runGit(directory, ["checkout", name]);
        }
        break;
      }
      case "merge": {
        const name = assertBranchName(input.name ?? "");
        const current = await currentBranchName(directory);
        if (name === current) throw new Error("Already on this branch");
        await runGit(directory, ["merge", "--no-edit", name], 60_000);
        break;
      }
      case "delete": {
        const name = assertBranchName(input.name ?? "");
        const split = splitRemoteRef(name, remotes);
        if (split) {
          await runGit(directory, ["push", split.remote, "--delete", split.branch], 60_000);
          break;
        }
        const current = await currentBranchName(directory);
        if (name === current) throw new Error("Cannot delete the current branch");
        await runGit(directory, ["branch", input.force ? "-D" : "-d", name]);
        break;
      }
      case "create": {
        const name = assertBranchName(input.name ?? "");
        if (input.checkOut === false) await runGit(directory, ["branch", name]);
        else await runGit(directory, ["checkout", "-b", name]);
        break;
      }
      case "rename": {
        const name = assertBranchName(input.name ?? "");
        const newName = assertBranchName(input.newName ?? "");
        if (name === newName) throw new Error("Name is unchanged");
        await runGit(directory, ["branch", "-m", name, newName]);
        break;
      }
      case "rebase": {
        const name = assertBranchName(input.name ?? "");
        const current = await currentBranchName(directory);
        if (name === current) throw new Error("Already on this branch");
        await runGit(directory, ["rebase", name], 60_000);
        break;
      }
      case "push": {
        const name = assertBranchName(input.name ?? (await currentBranchName(directory)));
        const split = splitRemoteRef(name, remotes);
        if (split) throw new Error("Push a local branch, not a remote ref");
        const remote = defaultRemote(remotes);
        const args = ["push"];
        if (input.force) args.push("--force-with-lease");
        args.push("-u", remote, name);
        await runGit(directory, args, 60_000);
        break;
      }
      case "fetch": {
        const name = assertBranchName(input.name ?? "");
        const split = splitRemoteRef(name, remotes);
        if (!split) throw new Error("Fetch into local needs a remote branch");
        const current = await currentBranchName(directory).catch(() => "");
        if (split.branch === current) throw new Error("Cannot fetch into the checked-out branch");
        await runGit(directory, ["fetch", split.remote, `${split.branch}:${split.branch}`], 60_000);
        break;
      }
    }
    return { error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: firstLine(message) || message };
  }
}
