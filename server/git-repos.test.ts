/**
 * Tests for repository discovery in multi-repo workspaces.
 *
 * `getGitRepos` runs real `git` in temporary directories: the scan is the
 * behavior under test, so faking git would only test the fake. Each test
 * creates its repos, exercises the discovery, and removes the tree.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getGitRepos } from "./git-tree.ts";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const skip = hasGit ? false : "git is not available";

async function initRepo(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: directory });
}

async function withTempTree(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-git-repos-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a repository workspace returns that repository", { skip }, async () => {
  await withTempTree(async (root) => {
    const repo = path.join(root, "only");
    await initRepo(repo);

    const { repos } = await getGitRepos({ directory: repo });

    assert.equal(repos.length, 1);
    assert.equal(repos[0].name, "only");
    assert.equal(repos[0].relative, ".");
    assert.equal(repos[0].path, repo);
  });
});

test("a multi-repo directory discovers nested repositories", { skip }, async () => {
  await withTempTree(async (root) => {
    await initRepo(path.join(root, "repo-a"));
    await initRepo(path.join(root, "repo-b"));
    await initRepo(path.join(root, "group", "repo-c"));

    const { repos } = await getGitRepos({ directory: root });

    assert.deepEqual(
      repos.map((repo) => repo.relative),
      ["group/repo-c", "repo-a", "repo-b"],
    );
    assert.deepEqual(
      repos.map((repo) => repo.name),
      ["repo-c", "repo-a", "repo-b"],
    );
  });
});

test("discovery skips node_modules and hidden directories", { skip }, async () => {
  await withTempTree(async (root) => {
    await initRepo(path.join(root, "real"));
    await initRepo(path.join(root, "node_modules", "fake"));
    await initRepo(path.join(root, ".hidden", "fake"));

    const { repos } = await getGitRepos({ directory: root });

    assert.deepEqual(
      repos.map((repo) => repo.relative),
      ["real"],
    );
  });
});

test("a directory with no repositories returns an empty list", { skip }, async () => {
  await withTempTree(async (root) => {
    await mkdir(path.join(root, "not-a-repo"), { recursive: true });

    const { repos } = await getGitRepos({ directory: root });

    assert.deepEqual(repos, []);
  });
});
