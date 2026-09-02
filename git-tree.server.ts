import { execFile } from "node:child_process";
import path from "node:path";
import type { output as ZodOutput } from "zod";
import { commitCompare, commitCompareDiff, commitDetail, commitDiff, computeGraph, gitBranchOp, gitTree } from "./git-tree.shared";

type Input = ZodOutput<typeof gitTree.input>;

function runGit(directory: string, args: string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd: directory, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message));
        else resolve(stdout);
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
    const refs =
      scope === "current" ? ["HEAD"] : scope === "local" ? ["--branches"] : ["--all"];
    const pathArgs = input.path ? ["--", input.path] : [];
    const out = await runGit(
      directory,
      ["log", "--topo-order", ...refs, `--pretty=format:${fmt}`, `-n${limit}`, ...pathArgs],
      30_000,
    );

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

    const rows = computeGraph(commits);

    let heads: ZodOutput<typeof gitTree.output>["heads"] = [];
    try {
      const branchOut = await runGit(directory, [
        "for-each-ref",
        "--format=%(refname:short)%09%(objectname)%09%(HEAD)",
        "refs/heads",
      ]);
      const currentOut = await runGit(directory, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const current = firstLine(currentOut).trim();
      heads = branchOut
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((line) => {
          const [name = "", hash = "", headFlag = ""] = line.split("\t");
          return { name, hash, isCurrent: headFlag.trim() === "*" || name === current };
        });
    } catch {
      // Branch listing is best-effort; the graph is the main content.
    }

    return { rows, heads, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { rows: [], heads: [], error: message };
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
 *  per-file list (rename-aware). */
async function diffFiles(directory: string, base: string, head: string): Promise<DiffFile[]> {
  const [stats, statuses] = await Promise.all([
    runGit(directory, ["diff", "--numstat", base, head]).catch(() => ""),
    runGit(directory, ["diff", "--name-status", base, head]).catch(() => ""),
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

export async function getCommitDetail(
  input: ZodOutput<typeof commitDetail.input>,
): Promise<ZodOutput<typeof commitDetail.output>> {
  const directory = path.resolve(input.directory);
  const { hash } = input;
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
    const base = await diffBase(directory, input.hash);
    const patch = await runGit(directory, ["diff", base, input.hash, "--", input.path]);
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

export async function runBranchOp(
  input: ZodOutput<typeof gitBranchOp.input>,
): Promise<ZodOutput<typeof gitBranchOp.output>> {
  const directory = path.resolve(input.directory);
  try {
    switch (input.op) {
      case "pull":
        await runGit(directory, ["pull"], 60_000);
        break;
      case "checkout": {
        const name = assertBranchName(input.name ?? "");
        await runGit(directory, ["checkout", name]);
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
        const current = await currentBranchName(directory);
        if (name === current) throw new Error("Cannot delete the current branch");
        await runGit(directory, ["branch", "-d", name]);
        break;
      }
      case "create": {
        const name = assertBranchName(input.name ?? "");
        await runGit(directory, ["checkout", "-b", name]);
        break;
      }
    }
    return { error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: firstLine(message) || message };
  }
}
