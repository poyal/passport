import { useState } from "react";
import { X } from "lucide-react";
import { useApp } from "./context";
import { IconButton, Modal } from "./components";
import {
  defaultShortcuts,
  shortcutActions,
  shortcutActionIds,
  shortcutPlatform,
  normalizeShortcut,
  shortcutFromEvent,
  formatShortcut,
  validateShortcutMap,
  type ShortcutAction,
  type ShortcutMap,
} from "../shared/shortcuts";

export function ShortcutSettings() {
  const app = useApp();
  const platform = shortcutPlatform(app.boot.platform);
  const [draft, setDraft] = useState<ShortcutMap>(() =>
    structuredClone(app.document.settings.shortcuts[platform]),
  );
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState<ShortcutAction | null>(null);
  const [binding, setBinding] = useState("");
  const [recordError, setRecordError] = useState("");
  const change = (next: ShortcutMap) => {
    setDraft(next);
    setSaved(false);
    setError("");
  };
  const start = (action: ShortcutAction) => {
    setRecording(action);
    setBinding("");
    setRecordError("");
  };
  const apply = () => {
    if (!recording || !binding) return;
    const next = { ...draft, [recording]: [binding] };
    try {
      validateShortcutMap(next, platform);
      change(next);
      setRecording(null);
    } catch (error) {
      setRecordError((error as Error).message);
    }
  };
  return (
    <section className="settings-card shortcut-settings">
      <div className="settings-card-header">
        <h3>{platform === "darwin" ? "macOS" : "Windows"} 단축키</h3>
        <button
          disabled={busy}
          onClick={() => change(structuredClone(defaultShortcuts[platform]))}
        >
          전체 초기화
        </button>
      </div>
      <p className="hint">
        현재 운영체제의 키만 표시합니다. 한 기능에 키 하나를 지정할 수 있고, X로
        해제하면 사용하지 않습니다. 초기화는 기본 키를 복원합니다. 변경 후
        저장해 주세요.
      </p>
      <p className="hint">
        복사는 선택한 텍스트가 없으면 아무 동작도 하지 않습니다. 명령 중단은
        별도 키로 지정합니다. 입력칸 편집과 Esc·Tab·방향키 화면 조작은
        유지됩니다.
      </p>
      {(["app", "terminal", "files"] as const).map((scope) => (
        <fieldset className="shortcut-group" key={scope} disabled={busy}>
          <legend>
            {{ app: "앱", terminal: "터미널", files: "파일" }[scope]}
          </legend>
          {shortcutActionIds
            .filter((id) => shortcutActions[id].scope === scope)
            .map((action) => (
              <div
                className="shortcut-row"
                key={action}
                data-shortcut-action={action}
              >
                <div className="shortcut-label">
                  {shortcutActions[action].label}
                </div>
                <div className="shortcut-key">
                  {draft[action][0] ? (
                    <kbd>{formatShortcut(draft[action][0], platform)}</kbd>
                  ) : (
                    <span className="hint">미지정 · 사용 안 함</span>
                  )}
                </div>
                <div className="shortcut-actions">
                  <button
                    aria-label={`${shortcutActions[action].label} 키 변경`}
                    onClick={() => start(action)}
                  >
                    키 변경
                  </button>
                  <IconButton
                    label={`${shortcutActions[action].label} 단축키 해제`}
                    disabled={!draft[action].length}
                    onClick={() => change({ ...draft, [action]: [] })}
                  >
                    <X size={16} />
                  </IconButton>
                  <button
                    aria-label={`${shortcutActions[action].label} 초기화`}
                    onClick={() => {
                      const next = {
                        ...draft,
                        [action]: [...defaultShortcuts[platform][action]],
                      };
                      try {
                        validateShortcutMap(next, platform);
                        change(next);
                      } catch (error) {
                        setError((error as Error).message);
                      }
                    }}
                  >
                    초기화
                  </button>
                </div>
              </div>
            ))}
        </fieldset>
      ))}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {saved && <p role="status">단축키를 저장했습니다.</p>}
      <div className="row">
        <button
          className="primary"
          disabled={busy}
          onClick={async () => {
            try {
              validateShortcutMap(draft, platform);
              setError("");
              setBusy(true);
              const ok = await app.update((document) => ({
                ...document,
                settings: {
                  ...document.settings,
                  shortcuts: {
                    ...document.settings.shortcuts,
                    [platform]: draft,
                  },
                },
              }));
              setSaved(ok);
            } catch (error) {
              setError((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          단축키 저장
        </button>
        <button
          disabled={busy}
          onClick={() =>
            change(structuredClone(app.document.settings.shortcuts[platform]))
          }
        >
          변경 취소
        </button>
      </div>
      {recording && (
        <Modal
          className="shortcut-recorder"
          title={`${shortcutActions[recording].label} 단축키 변경`}
          onClose={() => setRecording(null)}
        >
          <label>
            키 조합
            <input
              aria-label="키 조합"
              readOnly
              value={binding ? formatShortcut(binding, platform) : ""}
              placeholder="사용할 키를 함께 누르세요"
              onKeyDown={(event) => {
                if (
                  ["Escape", "Tab"].includes(event.key) ||
                  (event.key === "Enter" &&
                    !event.ctrlKey &&
                    !event.metaKey &&
                    !event.altKey &&
                    !event.shiftKey)
                )
                  return;
                event.preventDefault();
                event.stopPropagation();
                if (event.repeat) return;
                const value = shortcutFromEvent(event.nativeEvent);
                if (!value) return;
                try {
                  setBinding(normalizeShortcut(value, platform));
                  setRecordError("");
                } catch (error) {
                  setBinding("");
                  setRecordError((error as Error).message);
                }
              }}
            />
          </label>
          <p className="hint">키를 누른 뒤 적용하세요. Esc로 취소합니다.</p>
          {recordError && (
            <p className="error-text" role="alert">
              {recordError}
            </p>
          )}
          <div className="modal-actions">
            <button onClick={() => setRecording(null)}>취소</button>
            <button className="primary" disabled={!binding} onClick={apply}>
              적용
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
