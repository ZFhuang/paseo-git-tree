import type { PluginContext } from "@getpaseo/plugin";
import { GitTreePanel } from "./git-tree-panel.client";
import { getCommitDetail, getCommitDiff, getGitTree } from "./git-tree.server";
import { commitDetail, commitDiff, gitTree } from "./git-tree.shared";

export default function contribute(plugin: PluginContext) {
  plugin.handle(gitTree, getGitTree);
  plugin.handle(commitDetail, getCommitDetail);
  plugin.handle(commitDiff, getCommitDiff);
  plugin.addWorkspacePanel({
    id: "git-tree",
    title: "Git Tree",
    icon: "GitBranch",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: GitTreePanel,
  });
  return () => {};
}
