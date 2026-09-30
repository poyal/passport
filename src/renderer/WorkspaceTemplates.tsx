import { useState } from "react";
import {
  Layers,
  Save,
  Play,
  FolderOpen,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type { Layout, WorkspaceTemplate } from "../shared/model";
import { panes } from "../shared/layout";
import { cloneWorkspaces } from "../shared/workspace-templates";
import { useApp } from "./context";
import { uuid } from "./api";
import { Empty, IconButton } from "./components";

function LayoutPreview({ node }: { node: Layout }) {
  return node.kind === "pane" ? (
    <span className="template-preview-pane" />
  ) : (
    <span
      className={`template-preview-split ${node.direction}`}
      style={
        node.direction === "horizontal"
          ? { gridTemplateColumns: `${node.ratio}fr ${1 - node.ratio}fr` }
          : { gridTemplateRows: `${node.ratio}fr ${1 - node.ratio}fr` }
      }
    >
      <LayoutPreview node={node.children[0]} />
      <LayoutPreview node={node.children[1]} />
    </span>
  );
}
export function WorkspaceTemplates() {
  const app = useApp(),
    [busy, setBusy] = useState(false);
  const currentTabs = app.document.workspaces.filter(
    (w) => app.boot.workspaceOwners[w.id] === app.boot.windowId,
  );
  const snapshot = (workspaces = currentTabs) => {
    const active =
      workspaces.find((w) =>
        panes(w.root).some((p) => p.id === app.activePane),
      ) ?? workspaces[0];
    return cloneWorkspaces(workspaces, active?.id ?? "", app.activePane, uuid);
  };
  const save = async () => {
    const name = await app.ask(
      "스페이스 저장",
      "현재 창의 모든 터미널 탭과 분할 방향·크기를 저장합니다.",
      "내 작업 공간",
    );
    if (!name?.trim()) return;
    const ok = await app.update((d) => ({
      ...d,
      workspaceTemplates: [
        ...d.workspaceTemplates,
        {
          id: uuid(),
          name: name.trim(),
          ...snapshot(
            d.workspaces.filter(
              (w) => app.boot.workspaceOwners[w.id] === app.boot.windowId,
            ),
          ),
        },
      ],
    }));
    if (ok) app.notify("스페이스를 저장했습니다.");
  };
  const open = async (template: WorkspaceTemplate, connect: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const restored = cloneWorkspaces(
        template.workspaces,
        template.activeWorkspaceId,
        template.activePaneId,
        uuid,
      );
      const ok = await app.update((d) => {
        if (
          d.workspaces.flatMap((w) => panes(w.root)).length +
            restored.workspaces.flatMap((w) => panes(w.root)).length >
          32
        )
          throw new Error(
            "스페이스를 열 공간이 부족합니다. 전체 터미널은 최대 32개이므로 사용하지 않는 탭을 닫아 주세요.",
          );
        return { ...d, workspaces: [...d.workspaces, ...restored.workspaces] };
      });
      if (!ok) return;
      app.setActive(restored.activeWorkspaceId);
      app.setActivePane(restored.activePaneId);
      if (connect)
        for (const pane of restored.workspaces.flatMap((w) => panes(w.root)))
          await app.connectPane(pane.id, pane.hostId);
    } catch (error) {
      app.notify(error);
    } finally {
      setBusy(false);
    }
  };
  const replace = async (template: WorkspaceTemplate) => {
    if (
      !(await app.confirm(
        "스페이스 갱신",
        `‘${template.name}’을 현재 창의 ${currentTabs.length}개 탭과 분할 배치로 바꿀까요?`,
      ))
    )
      return;
    await app.update((d) => ({
      ...d,
      workspaceTemplates: d.workspaceTemplates.map((t) =>
        t.id === template.id
          ? {
              ...t,
              ...snapshot(
                d.workspaces.filter(
                  (w) => app.boot.workspaceOwners[w.id] === app.boot.windowId,
                ),
              ),
            }
          : t,
      ),
    }));
  };
  return (
    <div className="workspace-library">
      <div className="page-heading">
        <div>
          <h1>스페이스</h1>
          <p>자주 사용하는 터미널 탭과 분할 배치를 저장하고 함께 여세요.</p>
        </div>
        <button
          className="primary"
          disabled={
            busy ||
            !currentTabs.length ||
            app.document.workspaceTemplates.length >= 100
          }
          onClick={() => void save().catch(app.notify)}
        >
          <Save size={16} />
          현재 창 저장
        </button>
      </div>
      <p className="hint workspace-library-hint">
        열린 탭은 유지됩니다. 이름을 누르면 저장된 배치를 새 탭으로 열고
        연결합니다. 폴더 버튼으로 배치만 열 수도 있습니다.
      </p>
      <div
        className="workspace-template-list"
        aria-label="저장된 스페이스"
        tabIndex={0}
      >
        {!app.document.workspaceTemplates.length && (
          <Empty
            icon={<Layers size={28} />}
            title="저장된 스페이스가 없습니다"
            description="SSH 탭을 열고 원하는 위치로 분할한 뒤 ‘현재 창 저장’을 누르세요."
          />
        )}
        {app.document.workspaceTemplates.map((template) => {
          const terminals = template.workspaces.flatMap((w) => panes(w.root));
          return (
            <section
              className="workspace-template-row"
              key={template.id}
              aria-label={template.name}
            >
              <button
                className="workspace-template-open"
                disabled={busy}
                aria-label={`${template.name} 스페이스 열고 연결`}
                onClick={() => void open(template, true)}
              >
                <span className="template-preview" aria-hidden="true">
                  <LayoutPreview node={template.workspaces[0].root} />
                </span>
                <span className="workspace-template-name">
                  <strong>{template.name}</strong>
                  <small>
                    {template.workspaces.length}개 탭 ·{" "}
                    {terminals.filter((p) => !p.local).length}개 SSH
                    {terminals.some((p) => p.local)
                      ? ` · ${terminals.filter((p) => p.local).length}개 로컬`
                      : ""}
                  </small>
                </span>
                <Play size={16} />
              </button>
              <div className="workspace-template-actions">
                <IconButton
                  label={`${template.name} 배치만 열기`}
                  disabled={busy}
                  onClick={() => void open(template, false)}
                >
                  <FolderOpen size={16} />
                </IconButton>
                <IconButton
                  label={`${template.name} 현재 창으로 갱신`}
                  disabled={busy || !currentTabs.length}
                  onClick={() => void replace(template).catch(app.notify)}
                >
                  <RefreshCw size={16} />
                </IconButton>
                <IconButton
                  label={`${template.name} 이름 변경`}
                  disabled={busy}
                  onClick={() =>
                    void app
                      .ask(
                        "스페이스 이름",
                        "새 이름을 입력하세요.",
                        template.name,
                      )
                      .then((name) => {
                        if (name?.trim())
                          return app.update((d) => ({
                            ...d,
                            workspaceTemplates: d.workspaceTemplates.map((t) =>
                              t.id === template.id
                                ? { ...t, name: name.trim() }
                                : t,
                            ),
                          }));
                      })
                      .catch(app.notify)
                  }
                >
                  <Pencil size={16} />
                </IconButton>
                <IconButton
                  label={`${template.name} 스페이스 삭제`}
                  disabled={busy}
                  className="danger"
                  onClick={() =>
                    void app
                      .confirm(
                        "스페이스 삭제",
                        `‘${template.name}’의 저장된 배치를 삭제할까요? 열린 터미널은 유지됩니다.`,
                      )
                      .then(
                        (ok) =>
                          ok &&
                          app.update((d) => ({
                            ...d,
                            workspaceTemplates: d.workspaceTemplates.filter(
                              (t) => t.id !== template.id,
                            ),
                          })),
                      )
                      .catch(app.notify)
                  }
                >
                  <Trash2 size={16} />
                </IconButton>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
