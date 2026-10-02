import type { PassportDocument, Workspace } from "./model";
import { panes } from "./layout";
export function assertTerminalCapacity(document: PassportDocument) {
  if (
    document.workspaces.flatMap((workspace) => panes(workspace.root)).length >=
    32
  )
    throw new Error(
      "전체 터미널은 최대 32개입니다. 사용하지 않는 탭을 닫아 주세요.",
    );
}
export function localWorkspace(
  document: PassportDocument,
  home: string,
  id: string,
  paneId: string,
): Workspace {
  assertTerminalCapacity(document);
  return {
    id,
    name: "로컬 터미널",
    project: { cwd: home },
    root: {
      kind: "pane",
      id: paneId,
      hostId: "00000000-0000-4000-8000-000000000001",
      local: {
        shell: document.settings.terminal.shell,
        cwd: home,
        profiles: { mode: "inherit", ids: [] },
      },
    },
  };
}
