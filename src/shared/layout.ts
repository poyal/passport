import type { Layout, Pane, Workspace } from "./model";
export const panes = (node: Layout): Pane[] =>
  node.kind === "pane" ? [node] : node.children.flatMap(panes);
export const replaceNode = (
  node: Layout,
  id: string,
  replacement: Layout,
): Layout =>
  node.id === id
    ? replacement
    : node.kind === "pane"
      ? node
      : {
          ...node,
          children: node.children.map((c) =>
            replaceNode(c, id, replacement),
          ) as [Layout, Layout],
        };
export function removeNode(node: Layout, id: string): Layout | null {
  if (node.id === id) return null;
  if (node.kind === "pane") return node;
  const a = removeNode(node.children[0], id),
    b = removeNode(node.children[1], id);
  return !a ? b : !b ? a : { ...node, children: [a, b] };
}
export function insertSplit(
  root: Layout,
  target: string,
  incoming: Layout,
  edge: "left" | "right" | "top" | "bottom",
  id: string,
): Layout {
  if (panes(root).length + panes(incoming).length > 16)
    throw new Error("작업 탭당 최대 16개 패널입니다.");
  const visit = (n: Layout): Layout => {
    if (n.id !== target)
      return n.kind === "pane"
        ? n
        : { ...n, children: n.children.map(visit) as [Layout, Layout] };
    return {
      kind: "split",
      id,
      direction:
        edge === "left" || edge === "right" ? "horizontal" : "vertical",
      ratio: 0.5,
      children:
        edge === "left" || edge === "top" ? [incoming, n] : [n, incoming],
    };
  };
  return visit(root);
}
export function moveLayout(
  workspaces: Workspace[],
  from: string,
  nodeId: string,
  to: string,
  target: string,
  edge: "left" | "right" | "top" | "bottom",
  splitId: string,
): Workspace[] {
  const source = workspaces.find((w) => w.id === from),
    destination = workspaces.find((w) => w.id === to);
  if (!source || !destination) return workspaces;
  const find = (n: Layout): Layout | undefined =>
    n.id === nodeId
      ? n
      : n.kind === "split"
        ? (find(n.children[0]) ?? find(n.children[1]))
        : undefined;
  const incoming = find(source.root);
  if (incoming?.kind !== "pane" || incoming.id === target) return workspaces;
  const remainder = removeNode(source.root, nodeId);
  const destRoot = from === to ? remainder : destination.root;
  if (!destRoot) return workspaces;
  // A stale drop target must not remove the source panel from its workspace.
  const containsTarget = (node: Layout): boolean =>
    node.id === target ||
    (node.kind === "split" && node.children.some(containsTarget));
  if (!containsTarget(destRoot)) return workspaces;
  const result = insertSplit(destRoot, target, incoming, edge, splitId);
  return workspaces.flatMap((w) =>
    w.id === to
      ? [{ ...w, root: result }]
      : w.id === from
        ? remainder
          ? [{ ...w, root: remainder }]
          : []
        : [w],
  );
}
export function preparePaste(text: string, bracketed: boolean): string {
  const clean = text.replace(/[\r\n]+$/, "");
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(clean))
    throw new Error("붙여넣기에 제어 문자를 사용할 수 없습니다.");
  if (/[\r\n]/.test(clean) && !bracketed)
    throw new Error(
      "대상 셸에서 여러 줄 붙여넣기를 지원하지 않습니다. 한 줄로 편집해 주세요.",
    );
  return clean;
}
