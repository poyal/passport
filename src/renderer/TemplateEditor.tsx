import { useRef, useState } from "react";
import { panes } from "../shared/layout";
import { cloneWorkspaces } from "../shared/workspace-templates";
import { useApp } from "./context";
import { uuid } from "./api";
import { Modal } from "./components";

export function TemplateEditor({
  workspaceId,
  templateId,
  onClose,
}: {
  workspaceId?: string;
  templateId?: string;
  onClose: () => void;
}) {
  const app = useApp();
  const appRef = useRef(app);
  appRef.current = app;
  const tabs = app.document.workspaces.filter(
    (w) => app.boot.workspaceOwners[w.id] === app.boot.windowId,
  );
  const template = app.document.workspaceTemplates.find(
    (t) => t.id === templateId,
  );
  const [selected, setSelected] = useState(
    () =>
      workspaceId ??
      tabs.find((w) => panes(w.root).some((p) => p.id === app.activePane))
        ?.id ??
      tabs[0]?.id ??
      "",
  );
  const tab = tabs.find((w) => w.id === selected);
  const [name, setName] = useState(template?.name ?? tab?.name ?? "");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy || !tab || !name.trim()) return;
    setBusy(true);
    try {
      const ok = await app.update((d) => {
        const source = d.workspaces.find((w) => w.id === selected);
        if (
          !source ||
          appRef.current.boot.workspaceOwners[source.id] !==
            appRef.current.boot.windowId
        )
          throw new Error("저장할 탭이 닫혔거나 다른 창으로 이동했습니다.");
        if (
          templateId &&
          !d.workspaceTemplates.some((t) => t.id === templateId)
        )
          throw new Error("갱신할 템플릿이 삭제되었습니다.");
        if (!templateId && d.workspaceTemplates.length >= 100)
          throw new Error("템플릿은 최대 100개까지 저장할 수 있습니다.");
        const saved = {
          id: templateId ?? uuid(),
          name: name.trim(),
          ...cloneWorkspaces([source], source.id, app.activePane, uuid),
        };
        return {
          ...d,
          workspaceTemplates: templateId
            ? d.workspaceTemplates.map((t) => (t.id === templateId ? saved : t))
            : [...d.workspaceTemplates, saved],
        };
      });
      if (ok) {
        app.notify(
          templateId ? "템플릿을 갱신했습니다." : "템플릿을 저장했습니다.",
        );
        onClose();
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={templateId ? "템플릿 갱신" : "템플릿 저장"} onClose={onClose}>
      <p>선택한 탭 하나와 그 안의 로컬·SSH 분할 배치를 저장합니다.</p>
      <label>
        저장할 탭
        <select
          value={selected}
          disabled={busy || !!workspaceId}
          onChange={(e) => {
            setSelected(e.target.value);
            if (!templateId)
              setName(tabs.find((w) => w.id === e.target.value)?.name ?? "");
          }}
        >
          {!tab && <option value={selected}>저장할 탭이 없습니다</option>}
          {tabs.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name} · {panes(w.root).length}개 터미널
            </option>
          ))}
        </select>
      </label>
      <label>
        템플릿 이름
        <input
          autoFocus
          maxLength={256}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) void submit();
          }}
        />
      </label>
      {!tab && (
        <p role="alert" className="error-text">
          저장할 탭이 닫혔거나 다른 창으로 이동했습니다.
        </p>
      )}
      {templateId && (
        <p className="hint">
          ‘{template?.name}’의 저장된 배치를 선택한 탭으로 바꿉니다.
        </p>
      )}
      <div className="modal-actions">
        <button disabled={busy} onClick={onClose}>
          취소
        </button>
        <button
          className="primary"
          disabled={busy || !tab || !name.trim() || (!!templateId && !template)}
          onClick={() => void submit()}
        >
          {templateId ? "갱신" : "저장"}
        </button>
      </div>
    </Modal>
  );
}
