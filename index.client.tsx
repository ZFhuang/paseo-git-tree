import type { PluginClientContext } from "@getpaseo/plugin/client";
import { GitTreePanel } from "./client/git-tree-panel";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "git-tree",
    title: "Git Tree",
    icon: "GitBranch",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: GitTreePanel,
  });
  return () => {};
}
