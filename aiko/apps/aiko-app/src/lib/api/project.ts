/** API domain: project */

import {
  invoke,
} from "./host";

export async function projectsList() {
  return invoke<
    Array<{
      id: string;
      name: string;
      path: string;
      trusted: boolean;
      pathOk: boolean;
      pinned?: boolean;
      /** Legacy flag; retired system:general is no longer listed. */
      system?: boolean;
    }>
  >("projects_list");
}

/** On-disk default cwd for orphan chats (`{app_data}/workspaces/general`). */
export async function generalWorkspacePath() {
  return invoke<string>("general_workspace_path");
}

export async function projectAdd(path: string, trust: boolean) {
  return invoke("project_add", { path, trust });
}

