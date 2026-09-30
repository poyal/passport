import type { Layout, Workspace, WorkspaceTemplate } from "./model";
import { panes, removeNode } from "./layout";

// Saved layouts never share IDs with running sessions, including when reopened twice.
export function cloneWorkspaces(
  workspaces: Workspace[],
  activeWorkspaceId: string,
  activePaneId: string,
  id: () => string,
): Pick<
  WorkspaceTemplate,
  "workspaces" | "activeWorkspaceId" | "activePaneId"
> {
  if (!workspaces.length) throw new Error("저장할 터미널 탭이 없습니다.");
  const ids = new Map<string, string>();
  const fresh = (old: string) => {
    const next = id();
    ids.set(old, next);
    return next;
  };
  const clone = (node: Layout): Layout =>
    node.kind === "pane"
      ? {
          ...node,
          id: fresh(node.id),
          ...(node.local ? { local: { ...node.local } } : {}),
        }
      : {
          ...node,
          id: fresh(node.id),
          children: [clone(node.children[0]), clone(node.children[1])],
        };
  const copies = workspaces.map((w) => ({
    ...w,
    id: fresh(w.id),
    root: clone(w.root),
  }));
  const active =
    copies.find((w) => w.id === ids.get(activeWorkspaceId)) ?? copies[0];
  const paneId = ids.get(activePaneId);
  return {
    workspaces: copies,
    activeWorkspaceId: active.id,
    activePaneId:
      panes(active.root).find((p) => p.id === paneId)?.id ??
      panes(active.root)[0].id,
  };
}

export function withoutHost(
  workspaces: Workspace[],
  hostId: string,
): Workspace[] {
  return workspaces.flatMap((w) => {
    let root: Layout | null = w.root;
    for (const pane of panes(w.root))
      if (!pane.local && pane.hostId === hostId && root)
        root = removeNode(root, pane.id);
    return root ? [{ ...w, root }] : [];
  });
}

export function templatesWithoutHost(
  templates: WorkspaceTemplate[],
  hostId: string,
): WorkspaceTemplate[] {
  return templates.flatMap((template) => {
    const workspaces = withoutHost(template.workspaces, hostId);
    if (!workspaces.length) return [];
    const active =
      workspaces.find((w) => w.id === template.activeWorkspaceId) ??
      workspaces[0];
    return [
      {
        ...template,
        workspaces,
        activeWorkspaceId: active.id,
        activePaneId:
          panes(active.root).find((p) => p.id === template.activePaneId)?.id ??
          panes(active.root)[0].id,
      },
    ];
  });
}
